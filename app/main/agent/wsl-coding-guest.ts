/** Credential-free Linux helper. Only copied source, authenticated tools and framed host operations enter it. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { IsolatedCommandWorkspace } from "./isolated-command-workspace";
import { ScopedCodingFiles } from "./scoped-coding-files";
import { decodeCodingReviewExport } from "./coding-result-export";
import { WslCodingToolProfile, wslCodingToolReceipt } from "./wsl-coding-tools";
import { decodeWslCodingMessage, decodeWslCodingTree, encodeWslCodingTree, wslCodingFrame, wslCodingFrameSink,
  WSL_CODING_PROTOCOL, WSL_CODING_MAX_PENDING, type WslCodingRequest, type WslCodingResponse, type WslCodingResponsePayload } from "./wsl-coding-protocol";
import { discoverCodingToolchain } from "./coding-toolchain";
import type { CodingExportBinding } from "./coding-result-export";
import { WslPublicDependencyRuntime, WslPublicDependencyCleanupError } from "./wsl-public-dependency-runtime";
import { WslPublicDependencyGuest } from "./wsl-public-dependency-guest";

const plain = z.string().max(4096), literal = z.string().max(4 * 1024 * 1024), digest = z.string().regex(/^[0-9a-f]{64}$/);
const writeOptions = z.object({ createOnly: z.boolean().optional(), expectedSha256: digest.optional() }).strict().optional();
const schemas = {
  hello: z.object({}).strict(), provision: z.object({ typescript: z.string().max(12 * 1024 * 1024), publicDependencies: z.boolean().optional() }).strict(),
  open: z.object({ source: z.unknown() }).strict(), list: z.object({ path: plain.optional() }).strict(),
  readText: z.object({ path: plain, range: z.object({ startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional() }).strict().optional() }).strict(),
  writeText: z.object({ path: plain, text: literal, options: writeOptions }).strict(),
  replaceText: z.object({ path: plain, oldText: literal, newText: literal, options: z.object({ expectedSha256: digest.optional() }).strict().optional() }).strict(),
  delete: z.object({ path: plain }).strict(), mkdir: z.object({ path: plain }).strict(),
  searchLiteral: z.object({ query: z.string().max(4096), path: plain.optional() }).strict(), inspect: z.object({ paths: z.array(plain).max(64), cwd: plain }).strict(),
  run: z.object({ command: z.string().max(48_000), cwd: plain, shell: z.literal("bash") }).strict(),
  runNode: z.object({ argv: z.array(z.string().max(64 * 1024)).max(512), cwd: plain }).strict(),
  publicBegin: z.object({}).strict(), publicChunk: z.object({ lease: z.string().regex(/^[0-9a-f]{32}$/), index: z.number().int().min(0).max(511), offset: z.number().int().min(0).max(16 * 1024 * 1024), base64: z.string().max(1398104) }).strict(),
  publicCommit: z.object({ lease: z.string().regex(/^[0-9a-f]{32}$/) }).strict(), publicCancel: z.object({ lease: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
  stop: z.object({}).strict(), sealFiles: z.object({}).strict(), quiescent: z.object({}).strict(), snapshot: z.object({}).strict(), close: z.object({}).strict(),
};
const failure = () => new Error("The isolated coding helper could not finish safely.");

/** Returns only after physical workspace cleanup, or rejects while retaining an uncertain workspace. */
export async function serveWslCodingGuest(input: { stdin: Readable; stdout: Writable; nodePath: string }): Promise<void> {
  let root: string | undefined, profile: WslCodingToolProfile | undefined, workspace: IsolatedCommandWorkspace | undefined,
    files: ScopedCodingFiles | undefined, binding: CodingExportBinding | undefined, review: object | undefined,
    publicRuntime: WslPublicDependencyRuntime | undefined, publicGuest: WslPublicDependencyGuest | undefined;
  let publicEnabled = false;
  let provisioned = false, opened = false, closing = false, closed = false, responded = false, cleanupFailed = false, retired = false, epoch = 0, episode: string | undefined;
  const life = new AbortController(), transport = new AbortController(), runs = new Set<AbortController>(), pending = new Map<number, Promise<void>>(), work = new Map<number, Promise<void>>(), seen = new Set<number>(), nonces = new Set<string>();
  const envelopes = new Map<number, { episode: string; nonce: string }>();
  let resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
  const ending = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }); void ending.catch(() => undefined);
  const response = (value: WslCodingResponsePayload): WslCodingResponse => {
    const envelope = envelopes.get(value.id); if (!envelope) throw failure(); return { ...value, ...envelope } as WslCodingResponse;
  };
  const send = (value: WslCodingResponsePayload): Promise<void> => new Promise((resolve, reject) => {
    const frame = wslCodingFrame(response(value));
    input.stdout.write(frame, error => error ? reject(failure()) : resolve());
  });
  let retiring: Promise<Readonly<{ kind: "linux-pid-namespaces"; launched: number; exited: number; epoch: number; sealed: true; drained: true }>> | undefined;
  const stop = () => {
    if (!retiring) {
      retired = true; epoch++; life.abort(); publicGuest?.abort(); for (const run of runs) run.abort();
      const accepted = [...work.values()];
      retiring = (async () => {
        await workspace?.stop(); await Promise.allSettled(accepted); await publicGuest?.drain();
        // A provision/open accepted before retirement may have been awaiting filesystem work. Drain it before rechecking.
        await workspace?.stop();
        if (cleanupFailed) throw failure();
        const witness = workspace?.commandWitness() ?? { kind: "linux-pid-namespaces" as const, launched: 0, exited: 0 };
        return Object.freeze({ ...witness, epoch, sealed: true as const, drained: true as const });
      })();
    }
    return retiring;
  };
  let cleanup: Promise<void> | undefined;
  const dispose = (except?: number) => cleanup ??= (async () => {
    closing = true; life.abort(); await stop();
    await Promise.allSettled([...pending].filter(([id]) => id !== except).map(([, task]) => task));
    await files?.close(); files = undefined; await workspace?.close(); await publicRuntime?.close();
    if (root) await fs.rm(root, { recursive: true, force: false }); root = undefined; closed = true;
  })().catch(error => { cleanupFailed = true; throw error; });
  const crash = () => {
    if (responded) return;
    if (closed) { rejectClosed(failure()); return; }
    life.abort(); for (const run of runs) run.abort();
    void dispose().then(() => rejectClosed(failure()), () => rejectClosed(failure()));
  };
  const readyFiles = () => { if (!files || !workspace || closing || life.signal.aborted) throw failure(); return files; };
  const receive = async (request: WslCodingRequest): Promise<void> => {
    const { id, method, params } = request;
    try {
      if (closed || closing && method !== "close" || retired && !["hello", "stop", "sealFiles", "snapshot", "close"].includes(method)) throw failure();
      if (method === "hello") {
        schemas.hello.parse(params); await send({ kind: "result", id, value: { protocol: WSL_CODING_PROTOCOL, kind: "linux-helper", noNetwork: true,
          uid: process.getuid?.() ?? null, provisioned, opened, retired } }); return;
      }
      if (method === "provision") {
        const value = schemas.provision.parse(params); if (provisioned || root || opened) throw failure(); provisioned = true; publicEnabled = value.publicDependencies === true;
        const uid = process.getuid?.(); if (typeof uid !== "number" || !Number.isInteger(uid) || uid <= 0) throw failure();
        const archive = Buffer.from(value.typescript, "base64"); if (archive.toString("base64") !== value.typescript) throw failure();
        root = await fs.mkdtemp(path.join(os.tmpdir(), "ember-wsl-coding-")); await fs.chmod(root, 0o700);
        const protect = path.join(root, "private"); await fs.mkdir(protect, { mode: 0o700 });
        const tool = await discoverCodingToolchain({ env: {}, execPath: input.nodePath, isElectron: false, protectedPaths: [protect], signal: life.signal });
        if (!tool.available || !tool.nodePath || tool.nodePath !== await fs.realpath(input.nodePath)) throw failure();
        profile = await WslCodingToolProfile.create({ nodePath: tool.nodePath, typescriptArchive: archive, protectedPaths: [protect], signal: life.signal });
        archive.fill(0); await send({ kind: "result", id, value: wslCodingToolReceipt(profile) }); return;
      }
      if (method === "open") {
        const value = schemas.open.parse(params); if (!root || !profile || opened) throw failure(); opened = true;
        const tree = decodeWslCodingTree(value.source); binding = tree.binding;
        if (tree.entries.some(e => [".git", "node_modules"].some(n => e.path === n || e.path.startsWith(n + "/")))) throw failure();
        const source = path.join(root, "source"), copies = path.join(root, "copies");
        for (const folder of [source, copies, path.join(root, "reviews")]) await fs.mkdir(folder, { mode: 0o700 });
        try {
          for (const entry of [...tree.entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))) {
            life.signal.throwIfAborted(); const target = path.join(source, entry.path);
            if (entry.kind === "directory") await fs.mkdir(target, { mode: 0o700 });
            else await fs.writeFile(target, entry.bytes, { flag: "wx", mode: entry.executable ? 0o700 : 0o600 });
          }
        } finally { for (const entry of tree.entries) if (entry.kind === "file") entry.bytes.fill(0); }
        if (publicEnabled) publicRuntime = await WslPublicDependencyRuntime.create(root, life.signal);
        workspace = await IsolatedCommandWorkspace.create({ source, baseDir: copies, protectedPaths: [path.join(root, "private")], binding,
          nodePath: await fs.realpath(input.nodePath), wslProfile: profile, ...(publicRuntime ? { publicDependencies: publicRuntime } : {}), signal: life.signal, scope: { excludeRoots: [".git", "node_modules"] } });
        if (publicRuntime) publicGuest = new WslPublicDependencyGuest(publicRuntime, workspace, life.signal);
        files = await ScopedCodingFiles.create({ workspace, signal: life.signal });
        await send({ kind: "result", id, value: { opened: true, toolchain: wslCodingToolReceipt(profile) } }); return;
      }
      if (method === "publicBegin") {
        schemas.publicBegin.parse(params); readyFiles(); if (!publicGuest) throw failure();
        await send({ kind: "result", id, value: await publicGuest.begin() }); return;
      }
      if (method === "publicChunk") {
        const value = schemas.publicChunk.parse(params); readyFiles(); if (!publicGuest) throw failure();
        publicGuest.chunk(value.lease, value.index, value.offset, value.base64); await send({ kind: "result", id, value: { accepted: true } }); return;
      }
      if (method === "publicCommit" || method === "publicCancel") {
        const value = schemas[method].parse(params); readyFiles(); if (!publicGuest) throw failure();
        if (method === "publicCommit") await publicGuest.commit(value.lease); else await publicGuest.cancel(value.lease);
        await send({ kind: "result", id, value: { [method === "publicCommit" ? "prepared" : "cancelled"]: true } }); return;
      }
      if (method === "run" || method === "runNode") {
        readyFiles(); if (runs.size) throw failure(); const run = new AbortController(); runs.add(run);
        const output = (bytes: Uint8Array, stream: "stdout" | "stderr") => {
          if (input.stdout.writableLength > 2 * 1024 * 1024) throw failure();
          input.stdout.write(wslCodingFrame(response({ kind: "output", id, stream, base64: Buffer.from(bytes).toString("base64") })));
        };
        try {
          const result = method === "run"
            ? await (() => { const value = schemas.run.parse(params); return workspace!.run(value.command, value.cwd, output, run.signal, value.shell); })()
            : await (() => { const value = schemas.runNode.parse(params); return workspace!.runNode(value.argv, value.cwd, output, run.signal); })();
          await send({ kind: "result", id, value: { observed: result.observed, exitCode: result.exitCode, signal: result.signal, stopped: result.stopped,
            timedOut: result.timedOut, outputLimited: result.outputLimited, witness: workspace!.commandWitness() } }); return;
        } finally { runs.delete(run); }
      }
      if (method === "stop") { schemas.stop.parse(params); const witness = await stop(); await send({ kind: "result", id, value: { stopped: true, witness } }); return; }
      if (method === "sealFiles") { schemas.sealFiles.parse(params); await files?.close(); files = undefined; await send({ kind: "result", id, value: { sealed: true } }); return; }
      if (method === "quiescent") { schemas.quiescent.parse(params); readyFiles(); await workspace!.files(async () => undefined); await send({ kind: "result", id, value: { quiescent: true } }); return; }
      if (method === "snapshot") {
        schemas.snapshot.parse(params); if (!workspace || !root || !binding || runs.size) throw failure();
        if (!review) {
          await stop(); await files?.close(); files = undefined;
          const captured = await workspace.exportReview(path.join(root, "reviews"));
          if (captured.cleanup !== "complete") throw failure();
          const decoded = decodeCodingReviewExport(Buffer.from(JSON.stringify(captured.review)), binding);
          try { review = encodeWslCodingTree(decoded.proposed); }
          finally { for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const e of tree?.entries ?? []) if (e.kind === "file") e.bytes.fill(0); }
        }
        await send({ kind: "result", id, value: review }); return;
      }
      if (method === "close") { schemas.close.parse(params); await dispose(id); await send({ kind: "result", id, value: { closed: true, cleanup: "complete" } }); responded = true; resolveClosed(); return; }
      const broker = readyFiles(); let value: unknown;
      switch (method) {
        case "list": { const p = schemas.list.parse(params); value = await broker.list(p.path); break; }
        case "readText": { const p = schemas.readText.parse(params); value = await broker.readText(p.path, p.range); break; }
        case "writeText": { const p = schemas.writeText.parse(params); value = await broker.writeText(p.path, p.text, p.options); break; }
        case "replaceText": { const p = schemas.replaceText.parse(params); value = await broker.replaceText(p.path, p.oldText, p.newText, p.options); break; }
        case "delete": { const p = schemas.delete.parse(params); value = await broker.delete(p.path); break; }
        case "mkdir": { const p = schemas.mkdir.parse(params); value = await broker.mkdir(p.path); break; }
        case "searchLiteral": { const p = schemas.searchLiteral.parse(params); value = await broker.searchLiteral(p.query, p.path); break; }
        case "inspect": { const p = schemas.inspect.parse(params); value = await broker.inspect(p.paths, p.cwd); break; }
        default: throw failure();
      }
      await send({ kind: "result", id, value });
    } catch (error) {
      if (error instanceof WslPublicDependencyCleanupError) { cleanupFailed = true; void stop().catch(() => undefined); }
      try { await send({ kind: "failure", id, code: cleanupFailed ? "cleanup" : life.signal.aborted ? "stopped" : "failed" }); } catch { crash(); }
    }
  };
  const { guard, sink } = wslCodingFrameSink(body => {
    const request = decodeWslCodingMessage(body, "request");
    if (!episode) { if (request.method !== "hello") throw failure(); episode = request.episode; }
    if (request.episode !== episode || nonces.has(request.nonce) || seen.has(request.id) || seen.size >= 2000 || pending.size >= WSL_CODING_MAX_PENDING) throw failure();
    seen.add(request.id); nonces.add(request.nonce); envelopes.set(request.id, { episode: request.episode, nonce: request.nonce });
    const task = receive(request); pending.set(request.id, task);
    if (!["hello", "stop", "snapshot", "close"].includes(request.method)) work.set(request.id, task);
    void task.finally(() => { pending.delete(request.id); work.delete(request.id); envelopes.delete(request.id); }).catch(crash);
  }, transport.signal);
  input.stdin.on("end", () => { if (!responded) crash(); }); input.stdin.on("error", crash); input.stdout.on("error", crash);
  void pipeline(input.stdin, guard, sink).catch(() => { if (!closed) crash(); });
  let failed = false;
  try { await ending; } catch { failed = true; }
  finally {
    if (!closed) { try { await dispose(); } catch { cleanupFailed = true; } }
    life.abort(); transport.abort(); guard.destroy(); sink.destroy();
  }
  if (failed || cleanupFailed) throw failure();
}
