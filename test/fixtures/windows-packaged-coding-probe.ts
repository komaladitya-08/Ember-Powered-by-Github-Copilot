/**
 * Fixed test-only controller source bundle, run by an extracted Windows Ember.exe in its supported Node mode.
 * SDK/Koffi stay external and resolve from the extracted package. This does not execute packaged main or its IPC.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CustomCodingController } from "../../app/main/agent/custom-coding-controller";
import { PrivateControllerRuntime } from "../../app/main/agent/private-controller-runtime";
import { WindowsCodingCopy } from "../../app/main/agent/windows-coding-copy";
import { WindowsScopedCodingFiles } from "../../app/main/agent/windows-scoped-coding-files";
import { loadWindowsCodingNative } from "../../app/main/agent/windows-coding-native";
import { loadWindowsControllerNative } from "../../app/main/agent/windows-controller-native";
import { locateRuntime, runtimeFor, runtimeRelative } from "../../app/main/agent/runtime";

interface ProbeInput {
  app: string; exe: string; profile: string; source: string; copies: string; receipt: string;
  providerUrl: string; providerKey: string; loaderMarker: string;
  versions: { app: string; electron: string; sdk: string; koffi: string };
}
const real = (value: string) => fs.realpathSync.native(value).toLowerCase();
const within = (base: string, filename: string) => {
  const relative = path.relative(real(base), real(filename));
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

/** Read only fresh, own controller state after its SDK child has exited. Never inspect ambient account files. */
function excludesSyntheticKey(root: string, key: string): void {
  let entries = 0, total = 0;
  const scan = (directory: string, depth: number) => {
    assert(depth <= 64);
    for (const name of fs.readdirSync(directory)) {
      assert(++entries <= 10_000);
      const filename = path.join(directory, name), metadata = fs.lstatSync(filename);
      assert(!metadata.isSymbolicLink());
      if (metadata.isDirectory()) scan(filename, depth + 1);
      else {
        assert(metadata.isFile() && metadata.nlink === 1 && metadata.size <= 16 * 1024 * 1024);
        assert((total += metadata.size) <= 64 * 1024 * 1024);
        const bytes = fs.readFileSync(filename);
        try { assert(!bytes.includes(Buffer.from(key))); } finally { bytes.fill(0); }
      }
    }
  };
  scan(root, 0);
}

async function main(): Promise<void> {
  assert.equal(process.platform, "win32"); assert.equal(process.arch, "x64");
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as ProbeInput;
  assert.equal(real(process.execPath), real(input.exe)); assert.equal(process.versions.electron, input.versions.electron);
  const modules = path.join(input.app, "node_modules"), requireOwn = createRequire(__filename);
  assert(within(modules, requireOwn.resolve("@github/copilot-sdk")));
  assert(within(modules, requireOwn.resolve("koffi")));
  for (const [relative, version] of [["package.json", input.versions.app], ["node_modules/@github/copilot-sdk/package.json", input.versions.sdk],
    ["node_modules/koffi/package.json", input.versions.koffi]]) assert.equal(JSON.parse(fs.readFileSync(path.join(input.app, relative), "utf8")).version, version);
  const selected = runtimeFor("win32", "x64"), runtime = locateRuntime({ appPath: input.app, resourcesPath: path.dirname(input.app), env: {}, runtimeId: selected.id, exe: selected.exe });
  assert(runtime.exists); assert.equal(real(runtime.path), real(path.join(input.app, runtimeRelative(selected.id, selected.exe))));
  const nativeRuntime = fs.statSync(path.join(path.dirname(runtime.path), "runtime.node")); assert(nativeRuntime.isFile() && nativeRuntime.size > 0);
  const original = "export const answer = 41;\n", edited = "export const answer = 42;\n";
  assert.equal(fs.readFileSync(path.join(input.source, "app.ts"), "utf8"), original);
  let copy: WindowsCodingCopy | undefined, controller: CustomCodingController | undefined, child: ChildProcess | undefined, privateRoot = "", scanned = false;
  const cleanupErrors: unknown[] = [];
  try {
    copy = await WindowsCodingCopy.create({ source: input.source, privateBase: input.copies, protectedPaths: [input.profile], current: () => true, signal: new AbortController().signal });
    controller = await CustomCodingController.start({ mode: "files-only", runtime: { userData: input.profile, runtimePath: runtime.path, env: process.env },
      model: "mock-model", provider: { type: "openai", baseUrl: input.providerUrl, apiKey: input.providerKey, wireApi: "completions" }, current: () => true,
      files: signal => WindowsScopedCodingFiles.create({ copy: copy!, signal }), finishCheck: () => copy!.files(async () => true) });
    const owned = (controller as unknown as { runtime: PrivateControllerRuntime }).runtime;
    child = (owned.client as unknown as { cliProcess: ChildProcess }).cliProcess;
    assert(Number.isInteger(child.pid)); assert.equal(real(child.spawnfile), real(runtime.path));
    privateRoot = path.dirname(owned.workingDirectory);
    const api = loadWindowsCodingNative(), security = loadWindowsControllerNative();
    assert.equal(api.ownerSid, security.ownerSid);
    for (const directory of [privateRoot, owned.workingDirectory, ...["home", "state", "tmp"].map(name => path.join(privateRoot, name))]) {
      const pin = api.pin(directory, "read");
      try { security.assertFixed(api.info(pin.handle)); } finally { for (const handle of pin.handles.slice().reverse()) api.close(handle); }
    }
    const stop = owned.client.stop.bind(owned.client), observedChild = child;
    owned.client.stop = async () => {
      const errors = await stop();
      if (errors.length) return errors;
      if (observedChild.exitCode === null && observedChild.signalCode === null) await once(observedChild, "exit", { signal: AbortSignal.timeout(5_000) });
      assert(observedChild.exitCode !== null || observedChild.signalCode !== null);
      excludesSyntheticKey(privateRoot, input.providerKey); scanned = true;
      return errors;
    };
    const result = await controller.run("Read app.ts, change only the copied answer from 41 to 42 and finish for review. Commands and tests are unavailable.");
    assert.equal(result.success, true); assert.match(result.summary, /No commands or tests were run\./);
    const checks = (controller as unknown as { checks: Map<string, boolean> }).checks;
    assert(checks instanceof Map); assert.equal(checks.size, 0);
    assert.equal(fs.readFileSync(path.join(input.source, "app.ts"), "utf8"), original);
    assert.equal(fs.readFileSync(path.join(copy.directory, "app.ts"), "utf8"), edited);
  } finally {
    // No receipt is minted after uncertain startup, SDK termination, privacy-worker retirement or native cleanup.
    if (controller) try { await controller.close(); } catch (error) { cleanupErrors.push(error); }
    if (copy) try { await copy.close(); } catch (error) { cleanupErrors.push(error); }
  }
  assert.equal(cleanupErrors.length, 0);
  assert(child && (child.exitCode !== null || child.signalCode !== null)); assert(scanned);
  assert(!fs.existsSync(privateRoot)); assert.deepEqual(fs.readdirSync(path.join(input.profile, "coding-controllers")), []);
  assert.deepEqual(fs.readdirSync(input.copies), []); assert(!fs.existsSync(input.loaderMarker));
  assert.equal(fs.readFileSync(path.join(input.source, "app.ts"), "utf8"), original);
  fs.writeFileSync(input.receipt, JSON.stringify({ version: 1, proof: "packaged-dependencies-native-controller", cleanup: "complete", childExited: true, checks: { ran: 0, passed: 0, failed: 0 } }), { flag: "wx" });
}

void main().catch(() => { console.error("Packaged Windows controller fixture failed; synthetic quarantine must be retained."); process.exitCode = 1; });
