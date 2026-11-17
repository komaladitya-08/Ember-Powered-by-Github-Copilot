/** Real stdio helper, authenticated tools and isolated npm/TypeScript/child execution; Windows transport is separate. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import { WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";
import { requireWslStoppedReceipt } from "../../app/main/agent/wsl-coding-connection";
import { WslCodingWorkspace, wslCodingPlatform } from "../../app/main/agent/wsl-coding-workspace";
import { resolveTargetPath } from "../../app/main/commands/paths";
import type { RunnerFacts } from "../../app/main/commands/types";
import { LinuxCodingArtifactStore } from "../../app/main/agent/linux-coding-artifact-store";
import { createCodingReviewExport, decodeCodingReviewExport } from "../../app/main/agent/coding-result-export";
import { trustedCodingTestNodeOrSkip, codingTestIsolationSupported } from "../fixtures/coding/trusted-node";

const required = process.env.EMBER_WSL_CODING_GUEST_TEST === "1";
it.skipIf(!required)("builds and tests TypeScript through the real offline helper, returns copied results and proves Stop before cleanup", async ctx => {
  expect(process.platform).toBe("linux"); if (!codingTestIsolationSupported()) throw new Error("Required guest isolation is unavailable.");
  const node = await trustedCodingTestNodeOrSkip(ctx), selected = process.env.EMBER_WSL_TYPESCRIPT_ARCHIVE;
  if (!selected || !path.isAbsolute(selected)) throw new Error("The exact authenticated TypeScript archive is required.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-guest-test-")), script = path.join(root, "guest.cjs");
  const privacy = buildSync({ entryPoints: ["app/main/agent/coding-privacy-worker.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", write: false }).outputFiles[0].text;
  const bundled = buildSync({ entryPoints: ["app/wsl-coding/main.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", write: false,
    define: { __EMBER_CODING_PRIVACY_WORKER_SOURCE__: JSON.stringify(privacy) } }).outputFiles[0].contents;
  fs.writeFileSync(script, bundled, { mode: 0o600 });
  const probe = path.join(root, "socket-probe");
  const compiled = spawnSync("/usr/bin/cc", ["-O2", "test/fixtures/coding/wsl-socket-probe.c", "-o", probe], { timeout: 10_000, encoding: "utf8" });
  expect(compiled.status).toBe(0); const originalProbe = fs.readFileSync(probe); fs.unlinkSync(probe);
  const child = spawn(node.nodePath, [script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
  const connection = new WslCodingConnection(child); let closed = false, workspace: WslCodingWorkspace | undefined;
  const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() };
  const originals = new Map([
    ["package.json", JSON.stringify({ name: "offline-typescript-proof", private: true, scripts: { build: "tsc -p tsconfig.json", test: "node --test test.cjs" } })],
    ["tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", outDir: "dist", strict: true }, include: ["src/*.ts"] })],
    ["src/sum.ts", "export function sum(a: number, b: number): number { return a - b; }\n"],
    ["test.cjs", "const {test}=require('node:test');const assert=require('node:assert/strict');test('compiled value',()=>assert.equal(require('./dist/sum.js').sum(20,22),42));\n"],
  ]);
  const source = { binding, entries: [{ path: "src", kind: "directory" as const }, ...[...originals].map(([file, text]) => ({ path: file, kind: "file" as const, bytes: Buffer.from(text), executable: false })),
    { path: "socket-probe", kind: "file" as const, bytes: Buffer.from(originalProbe), executable: true }] };
  const sourceDir = path.join(root, "host-source"), reviews = path.join(root, "host-reviews"); fs.mkdirSync(sourceDir, { mode: 0o700 }); fs.mkdirSync(reviews, { mode: 0o700 }); fs.mkdirSync(path.join(sourceDir, "src"));
  for (const [file, text] of originals) fs.writeFileSync(path.join(sourceDir, file), text);
  fs.writeFileSync(path.join(sourceDir, "socket-probe"), originalProbe, { mode: 0o700 });
  const store = await LinuxCodingArtifactStore.create(reviews), sourceBoundary = await store.sourceBoundary(sourceDir, () => undefined);
  if (!sourceBoundary) throw new Error("The real host source boundary was not captured.");
  const task = new AbortController();
  try {
    expect(await connection.call("hello")).toMatchObject({ protocol: 1, kind: "linux-helper", noNetwork: true, uid: process.getuid!() });
    workspace = await WslCodingWorkspace.create({ connection, source, typescriptArchive: fs.readFileSync(selected), signal: task.signal, current: () => true,
      review: { base: reviews, sourceBoundary, current: () => true, captureCurrent: async () => ({ binding: { ...binding },
        entries: source.entries.map(entry => entry.kind === "file" ? { ...entry, bytes: Buffer.from(entry.bytes) } : { ...entry }) }),
        async write(input) {
          expect(fs.readdirSync(root).filter(name => name.startsWith("ember-wsl-coding-"))).toEqual([]);
          const rendered = createCodingReviewExport(input), artifact = await store.write({ "review.json": Buffer.from(rendered.json), "changes.patch": Buffer.from(rendered.review.textPatch) }, () => undefined);
          return { ...artifact, review: rendered.review, cleanup: "complete" };
        }, discard: output => store.discard(output) } });
    const files = await workspace.filesBroker(task.signal); expect((await files.list()).entries.map(e => e.path)).toContain("/work/src");
    expect(await workspace.quiescent()).toBe(true);
    let output = ""; const run = (command: string) => workspace!.run(command, "/work", bytes => { output += Buffer.from(bytes).toString(); }, task.signal, "bash");
    const hostFacts: RunnerFacts = { os: "win32", shells: [], shellPaths: {}, script: null, home: "C:\\host", user: "host", privileged: false,
      pty: false, ember: { paths: [], pids: [], names: /ember/i }, extraPath: [] };
    const facts = wslCodingPlatform.facts(workspace, hostFacts);
    expect(resolveTargetPath("~/home-check", { ...facts, cwd: "/work" })).toBe("/tmp/home-check");
    expect(await run("test \"$HOME\" = /tmp && test ~ = /tmp && node -e 'require(\"node:assert/strict\").equal(process.env.HOME,\"/tmp\")' && printf scratch > ~/home-check && test -f /tmp/home-check && test ! -e /work/home-check")).toMatchObject({ observed: true, exitCode: 0 });
    expect(await run("npm run build")).toMatchObject({ observed: true, exitCode: 0 });
    expect(await run("npm test")).toMatchObject({ observed: true, exitCode: 1 });
    await files.replaceText("src/sum.ts", "a - b", "a + b");
    expect(await run("npm run build")).toMatchObject({ observed: true, exitCode: 0 });
    expect(await run("npm test")).toMatchObject({ observed: true, exitCode: 0 }); expect(output).toContain("compiled value");
    expect(await run("./socket-probe")).toMatchObject({ observed: true, exitCode: 0 });
    await files.writeText("writer.cjs", `const f=require("node:fs"),{spawn}=require("node:child_process");
if(process.argv[2]==="child"){f.appendFileSync("child-counter","x");process.stdout.write("child-ready\\n");setInterval(()=>f.appendFileSync("child-counter","x"),10)}
else{const c=spawn(process.execPath,[__filename,"child"],{detached:true,stdio:["ignore","pipe","ignore"]});c.stdout.once("data",()=>{f.appendFileSync("parent-counter","x");process.stdout.write("writers-ready\\n");setInterval(()=>f.appendFileSync("parent-counter","x"),10)})}\n`);
    let sawReady!: () => void; const ready = new Promise<void>(resolve => { sawReady = resolve; }); let writerOutput = "";
    const running = workspace.run("node writer.cjs", "/work", bytes => { writerOutput += Buffer.from(bytes).toString(); if (writerOutput.includes("writers-ready\n")) sawReady(); }, task.signal, "bash");
    void running.catch(() => undefined); let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_resolve, reject) => { readyTimer = setTimeout(() => reject(new Error("Writer control did not start.")), 5000); })]); }
    finally { clearTimeout(readyTimer); }
    await workspace.stop(); expect(await running).toMatchObject({ observed: true, stopped: true });
    await workspace.sealForReview(); const exported = await workspace.exportReview(reviews); workspace.transferReview(exported);
    const claimed = await store.claim(exported, () => undefined), artifactBytes = await store.read(claimed, "review.json", 64 * 1024 * 1024, () => undefined);
    const proposed = decodeCodingReviewExport(artifactBytes, binding).proposed;
    expect(proposed.entries.filter(e => e.kind === "file").find(e => e.path === "src/sum.ts")?.bytes.toString()).toContain("a + b");
    expect(proposed.entries.some(e => e.path === "dist/sum.js")).toBe(true);
    for (const file of ["parent-counter", "child-counter"]) expect(proposed.entries.filter(e => e.kind === "file").find(e => e.path === file)?.bytes.length).toBeGreaterThan(0);
    expect(source.entries.filter(e => e.kind === "file").find(e => e.path === "src/sum.ts")?.bytes.toString()).toContain("a - b");
    for (const [file, text] of originals) expect(fs.readFileSync(path.join(sourceDir, file), "utf8")).toBe(text);
    expect(fs.readFileSync(path.join(sourceDir, "socket-probe"))).toEqual(originalProbe);
    await workspace.close(); closed = true; await store.discard(exported);
    expect(fs.readdirSync(root).sort()).toEqual(["guest.cjs", "host-reviews", "host-source"]);
  } finally {
    if (!closed) { try { if (workspace) await workspace.close(); else await connection.close(); } catch { child.kill("SIGKILL"); } }
    await store.close();
    if (closed) fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(!required)("retires and drains provisioning before a zero-launch Stop receipt and private cleanup", async ctx => {
  expect(process.platform).toBe("linux");
  const node = await trustedCodingTestNodeOrSkip(ctx), selected = process.env.EMBER_WSL_TYPESCRIPT_ARCHIVE;
  if (!selected || !path.isAbsolute(selected)) throw new Error("The exact authenticated TypeScript archive is required.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-early-stop-test-")), script = path.join(root, "guest.cjs");
  const privacy = buildSync({ entryPoints: ["app/main/agent/coding-privacy-worker.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", write: false }).outputFiles[0].text;
  fs.writeFileSync(script, buildSync({ entryPoints: ["app/wsl-coding/main.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", write: false,
    define: { __EMBER_CODING_PRIVACY_WORKER_SOURCE__: JSON.stringify(privacy) } }).outputFiles[0].contents);
  const child = spawn(node.nodePath, [script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } });
  const connection = new WslCodingConnection(child); let closed = false;
  try {
    expect(await connection.call("hello")).toMatchObject({ provisioned: false, retired: false });
    const provisioning = connection.call("provision", { typescript: fs.readFileSync(selected).toString("base64") });
    void provisioning.catch(() => undefined);
    const stopping = connection.stop();
    await expect(provisioning).rejects.toThrow("could not be verified");
    const receipt = await stopping; requireWslStoppedReceipt(receipt, connection);
    await expect(connection.call("runNode", { argv: ["-p", "42"], cwd: "/work" })).rejects.toThrow();
    await connection.close(); closed = true;
    expect(fs.readdirSync(root)).toEqual(["guest.cjs"]);
  } finally {
    if (!closed) { try { await connection.close(); closed = true; } catch { child.kill("SIGKILL"); } }
    if (closed) fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
