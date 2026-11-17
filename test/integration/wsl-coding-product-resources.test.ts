/** Real Windows custody -> real WSL helper -> host-issued review artifacts. No issuer, DLL, runner or receipt mocks. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createProjectCodingBackend } from "../../app/main/agent/project-coding-backend";
import { WindowsProjectCodingResources } from "../../app/main/agent/windows-coding-resources";
import { createWsl } from "../../app/main/wsl/service";
import { createLogger } from "../../app/main/logger";
import { connectWslCodingHelper, resolveWslCodingHelperPath } from "../../app/main/agent/wsl-coding-transport";
import { readWslCodingTypeScriptArchive } from "../../app/main/agent/wsl-coding-archive";
import { decodeCodingReviewExport } from "../../app/main/agent/coding-result-export";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { CodingCommandWorkspace, CodingFileBroker } from "../../app/main/agent/coding-platform";
import type { ObservedCodingCommand } from "../../app/main/agent/isolated-coding-command-runner";
import { wslProductPreflight, wslProductRefusal, wslProductScratchParent } from "../fixtures/wsl-coding-product-preflight";
import { WSL_PRODUCT_CASES, wslProductTitle } from "../fixtures/wsl-coding-product-contract";
import { wslProductProject, WSL_PRODUCT_CHECK, WSL_PRODUCT_WRITER, WSL_PRODUCT_WRITER_READY } from "../fixtures/wsl-coding-product-model";

const required = process.env.EMBER_WSL_CODING_RESOURCES_TEST === "1";
const OWNER = "b".repeat(64), PROJECT = "22222222-2222-4222-8222-222222222222";
let quarantined = false;
const retained = new Set<object>();
const failures = new WeakMap<Error, number>();
function failure(phase: number): Error { const error = wslProductRefusal(phase); failures.set(error, phase); return error; }


async function runCase(mode: typeof WSL_PRODUCT_CASES.resources[number]): Promise<void> {
  if (quarantined) throw failure(1);
  const input = wslProductPreflight(required); quarantined = true;
  let phase = 1, resource: WindowsProjectCodingResources | undefined, workspace: CodingCommandWorkspace | undefined, broker: CodingFileBroker | undefined;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(wslProductScratchParent(), "ember-wsl-resource-product-")));
  const graph: { root: string; resource?: WindowsProjectCodingResources; workspace?: CodingCommandWorkspace; broker?: CodingFileBroker; pending: Set<Promise<unknown>> } = { root, pending: new Set() }; retained.add(graph);
  const source = path.join(root, "source"), userData = path.join(root, "profile"), destination = path.join(root, "export"), common = path.join(root, "native-owned"), protectedFile = path.join(root, "application.bin");
  for (const directory of [source, userData, destination, path.join(root, "logs")]) fs.mkdirSync(directory);
  const originals = wslProductProject(false); let userChangedSource = false;
  const userSource = "export const result: string = 'user-original-change';\n";
  for (const [name, text] of Object.entries(originals)) { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { flag: "wx" }); }
  for (const name of [".git", "node_modules"]) { fs.mkdirSync(path.join(source, name)); fs.writeFileSync(path.join(source, name, "canary.txt"), "EXCLUDED_WSL_NATIVE_PRODUCT", { flag: "wx" }); }
  fs.writeFileSync(path.join(userData, "credential-canary.txt"), "gho_" + "Q".repeat(36), { flag: "wx" }); fs.writeFileSync(protectedFile, "fixed protected application", { flag: "wx" });
  const task = new AbortController(), jobHost = { execPath: process.execPath, script: path.join(input.repository, "dist/app/job-host.cjs") };
  const service = createWsl({ env: process.env, jobHost, os: "win32", log: createLogger({ dir: path.join(root, "logs") }), ember: { winPaths: [] } });
  let completed = false, expired = false, failed: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined, body: Promise<void> | undefined;
  const known = async <T>(work: Promise<T>): Promise<T> => { graph.pending.add(work); const value = await work; graph.pending.delete(work); if (expired) throw failure(phase); return value; };
  const unchanged = () => {
    for (const [name, text] of Object.entries(originals)) expect(fs.readFileSync(path.join(source, name), "utf8")).toBe(userChangedSource && name === "src/result.ts" ? userSource : text);
    for (const name of ["parent-counter", "child-counter", "hook-ran"]) expect(fs.existsSync(path.join(source, name))).toBe(false);
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("fixed protected application"); expect(fs.readFileSync(path.join(userData, "credential-canary.txt"), "utf8")).toBe("gho_" + "Q".repeat(36));
  };
  try {
    body = (async () => {
      phase = 2; if (!service) throw failure(phase);
      const facts = await known(service.facts({ refresh: true })), selected = facts.distros.find(value => value.name === input.distro);
      expect(facts.wslExe).toBeTruthy(); expect(selected).toMatchObject({ version: 2, needsSetup: false });
      expect(selected?.tool).toBeUndefined();
      const uid = await known(service.defaultUid(input.distro));
      expect(Number.isSafeInteger(uid) && uid !== null && uid > 0).toBe(true);
      const distro = Object.freeze({ ...selected!, defaultUid: uid }), current = () => !task.signal.aborted;
      const transport = { wslExe: facts.wslExe!, distro, jobHost, env: process.env, current };
      const scriptLinuxPath = await known(resolveWslCodingHelperPath({ ...transport, scriptWindowsPath: path.join(input.repository, "dist/app/wsl-coding.cjs") }));
      phase = 3;
      const selectedResource = await known(createProjectCodingBackend({ userData, protectedPaths: [protectedFile], resourcesPath: input.resourcesPath,
        currentOwner: () => OWNER, projectExists: id => id === PROJECT, env: {}, execPath: process.execPath, isElectron: false,
        storage: Object.freeze({ common, protectedPaths: Object.freeze([common]) }) }).ready);
      expect(selectedResource).toBeInstanceOf(WindowsProjectCodingResources); resource = selectedResource as WindowsProjectCodingResources; graph.resource = resource;
      expect(resource.availability().available).toBe(true);
      phase = 4; const folder = await known(resource.validateSource({ path: source, current })); resource.folders.bind(PROJECT, folder, resource.folders.ownerCurrent(PROJECT));
      const grant = resource.workspace(PROJECT); expect(grant).not.toBeNull();
      const spec: TaskSpec = { id: randomUUID(), goal: "Run the copied WSL fixture and return only a source-bound host review", target: {}, codingWorkspace: grant! };
      phase = 5; workspace = await known(resource.createWslWorkspace(spec, task.signal, current, { current, async open() {
        const connection = await connectWslCodingHelper({ ...transport, scriptLinuxPath });
        try { return { connection, typescriptArchive: readWslCodingTypeScriptArchive(path.join(input.repository, "dist/wsl-coding-tools/typescript-5.9.3.tgz")) }; }
        catch (error) { await connection.close(); throw error; }
      } })); graph.workspace = workspace;
      expect(workspace.executionRoot).toBe("/work"); expect(workspace.nodeAvailable).toBe(true);
      const observations: ObservedCodingCommand[] = []; let bytes = 0;
      const output = (chunk: Uint8Array) => { bytes += chunk.length; if (bytes > 256 * 1024) task.abort(); };
      if (mode === "repair-and-custody") {
        phase = 6; broker = await known(resource.wslPlatform.files(workspace, task.signal)); graph.broker = broker;
        const first = await known(workspace.run(WSL_PRODUCT_CHECK, "/work", output, task.signal, "bash")); observations.push(first);
        expect(first).toMatchObject({ observed: true, exitCode: 1, stopped: false, timedOut: false, outputLimited: false });
        phase = 7; const broken = await known(broker.readText("src/result.ts")); expect(broken.text).toContain("'wrong'");
        await known(broker.replaceText("src/result.ts", "'wrong'", "'ready'", { expectedSha256: broken.sha256 }));
        const next = await known(workspace.run(WSL_PRODUCT_CHECK, "/work", output, task.signal, "bash")); observations.push(next);
        expect(next).toMatchObject({ observed: true, exitCode: 0, stopped: false, timedOut: false, outputLimited: false });
        expect((await known(broker.readText("src/result.ts"))).text).toContain("'ready'"); await known(broker.close()); broker = undefined; graph.broker = undefined;
        // A deliberate test-owner edit proves that Windows recaptures current source instead of replaying the old seed.
        // The guest never receives a Windows path or authority to make this edit.
        fs.writeFileSync(path.join(source, "src/result.ts"), userSource); userChangedSource = true;
        phase = 8; await known(workspace.stop());
      } else {
        phase = 9; let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); let text = "";
        const running = workspace.run(WSL_PRODUCT_WRITER, "/work", chunk => { output(chunk); text += Buffer.from(chunk).toString(); if (text.includes(WSL_PRODUCT_WRITER_READY)) ready(); }, task.signal, "bash");
        void running.catch(() => undefined); let startTimer: ReturnType<typeof setTimeout> | undefined;
        try { await known(Promise.race([started, running.then(() => { throw failure(phase); }), new Promise<never>((_resolve, reject) => { startTimer = setTimeout(() => reject(failure(phase)), 30_000); })])); }
        finally { clearTimeout(startTimer); }
        phase = 10; await known(workspace.stop()); const stopped = await known(running); observations.push(stopped);
        expect(stopped).toMatchObject({ observed: true, stopped: true, timedOut: false, outputLimited: false });
      }
      phase = 11; expect(workspace.nodeAvailable).toBe(false); await expect(workspace.run("node --version", "/work", () => undefined, task.signal, "bash")).rejects.toThrow();
      expect(typeof workspace.sealForReview).toBe("function"); await known(workspace.sealForReview!());
      phase = 12; const outputReview = await known(workspace.exportReview(resource.reviewBase)); expect(outputReview.cleanup).toBe("complete");
      for (const role of ["copies", "assets"]) expect(fs.readdirSync(path.join(path.dirname(resource.reviewBase), role))).toEqual([]);
      const checks = { ran: mode === "repair-and-custody" ? 2 : 0, passed: mode === "repair-and-custody" ? 1 : 0, failed: mode === "repair-and-custody" ? 1 : 0 };
      phase = 13; const published = await known(resource.publish(spec, outputReview, mode === "repair-and-custody" ? "done" : "stopped", checks));
      const results = await known(resource.results()), review = await known(results.review(published.id)); expect(review?.checks).toEqual(checks); expect(results.state(PROJECT)).toHaveLength(1);
      if (mode === "repair-and-custody") expect(review?.conflicts).toBeGreaterThan(0);
      phase = 14; const exported = await known(results.export(published.id, destination, () => true)); expect(exported.ok).toBe(true); expect(path.dirname(exported.directory!)).toBe(destination);
      const json = fs.readFileSync(path.join(exported.directory!, "review.json")), decoded = decodeCodingReviewExport(json, outputReview.review.binding);
      expect(decoded.scope).toMatchObject({ executionProfile: "wsl-offline", dependencies: null });
      for (const tree of [decoded.baseline, decoded.current, decoded.proposed]) {
        expect(tree).toBeDefined(); for (const entry of tree!.entries) expect(entry.path.startsWith("node_modules") || entry.path.startsWith(".git")).toBe(false);
      }
      const file = (name: string) => decoded.proposed.entries.filter(entry => entry.kind === "file").find(entry => entry.path === name);
      if (mode === "repair-and-custody") {
        expect(file("src/result.ts")?.bytes.toString()).toContain("'ready'"); expect(file("hook-ran")?.bytes.toString()).toBe("inside");
        const current = decoded.current!.entries.filter(entry => entry.kind === "file").find(entry => entry.path === "src/result.ts");
        const baseline = decoded.baseline.entries.filter(entry => entry.kind === "file").find(entry => entry.path === "src/result.ts");
        expect(current?.bytes.toString()).toBe(userSource); expect(baseline?.bytes.toString()).toBe(originals["src/result.ts"]);
      }
      else for (const name of ["parent-counter", "child-counter"]) expect(file(name)?.bytes.length).toBeGreaterThan(0);
      phase = 15; await known(results.forgetResult(published.id)); expect(results.state(PROJECT)).toEqual([]); expect(await known(results.review(published.id))).toBeNull();
      await known(workspace.close()); await known(resource.close()); unchanged(); expect(graph.pending.size).toBe(0); expect(fs.existsSync(common)).toBe(false);
      completed = true;
    })();
    await Promise.race([body, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; task.abort(); reject(failure(phase)); }, 180_000); })]);
  } catch { task.abort(); try { await resource?.invalidate(); } catch { /* Retain the native owner on uncertainty. */ } try { await body; } catch { /* Keep the original bounded failure. */ } failed = failure(phase); }
  finally {
    clearTimeout(timer);
    try { service?.dispose(); } catch { failed ??= failure(16); }
    if (completed && !expired && !failed) {
      try { fs.rmSync(root, { recursive: true, force: false }); retained.delete(graph); quarantined = false; }
      catch { failed = failure(16); }
    }
  }
  if (failed || !completed || expired) throw failed ?? failure(phase);
}
for (const mode of WSL_PRODUCT_CASES.resources) it.skipIf(!required)(wslProductTitle("resources", mode), async () => {
  try { await runCase(mode); } catch (error) {
    quarantined = true; throw failure(error && typeof error === "object" ? failures.get(error as Error) ?? 1 : 1);
  }
}, 240_000);
