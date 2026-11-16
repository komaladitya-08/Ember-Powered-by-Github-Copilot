/**
 * Real Windows ZIP extraction, unchanged packaged fuses/debug guards, normal launch/window/handover smoke, then
 * a fixed production-controller source fixture against the shipped SDK/Koffi/runtime and Electron Node ABI.
 * The controller fixture is NOT packaged Home->Host proof. Packaged main must ignore its development endpoint canary.
 * CI: npm run package:win; PowerShell: $env:EMBER_PACKAGED_WINDOWS_CODING_TEST="1"
 * Run: node scripts/run-integration.mjs test/integration/windows-packaged-coding-native.test.ts --maxWorkers=1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { readFuses, emberFuses, fuseMismatches } from "../../scripts/package/fuses.mjs";
import { SHORTCUTS, FALLBACK_SHORTCUTS } from "../../app/shared/shortcuts";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

const checkout = process.cwd(), pkg = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8"));
const archive = path.join(checkout, "dist/package", `Ember-${pkg.version}-win-x64.zip`);
const required = process.env.EMBER_PACKAGED_WINDOWS_CODING_TEST === "1";
const available = process.platform === "win32" && process.arch === "x64" && fs.existsSync(archive);
const hash = (filename: string) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
interface ProcessObservation { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Emit only fixed smoke classifications and allowlisted shortcut/jump-list metadata, never captured app bodies. */
function smokeFacts(smoke: ProcessObservation) {
  const failure = smoke.stderr.split(/\r?\n/).find(line => line.startsWith("FAIL ")) ?? "";
  const accelerators = new Set([...Object.values(SHORTCUTS.win32), ...Object.values(FALLBACK_SHORTCUTS.win32)].map(shortcut => shortcut.accel));
  const ids = new Set(Object.keys(SHORTCUTS.win32)), taken = new Set<string>(), fallback = new Set<string>(), missing = new Set<string>(), jumpList = new Set<boolean>();
  const collect = (value: unknown, allow: Set<string>, output: Set<string>) => {
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && allow.has(item)) output.add(item);
  };
  for (const line of [...smoke.stdout.split(/\r?\n/), ...smoke.stderr.split(/\r?\n/)]) {
    try {
      const at = line.indexOf("{"); if (at < 0) continue;
      const entry = JSON.parse(line.slice(at)) as { msg?: unknown; taken?: unknown; fallback?: unknown; missing?: unknown; ok?: unknown };
      if (entry.msg === "shortcut.unavailable") { collect(entry.taken, accelerators, taken); collect(entry.fallback, ids, fallback); collect(entry.missing, ids, missing); }
      if (entry.msg === "launcher.tasks" && typeof entry.ok === "boolean") jumpList.add(entry.ok);
    } catch { /* Unrelated app/log output is neither forwarded nor interpreted. */ }
  }
  if (smoke.stdout.includes("the first instance put Ask Ember in its jump list")) jumpList.add(true);
  if (failure.includes("Windows refused the jump list (launcher.tasks ok: false)")) jumpList.add(false);
  return { code: smoke.code, signal: smoke.signal,
    authSourceMismatch: failure.includes("used an unexpected auth source"), authSourceMissing: failure.includes("report its auth source"),
    shortcutUnavailable: failure.includes("shortcut.unavailable"), takenAccelerators: [...taken].sort(), fallbackIds: [...fallback].sort(), missingIds: [...missing].sort(), jumpList: [...jumpList],
    appStartFailed: failure.includes('"msg":"app.start_failed"'), runtimeMissing: smoke.stderr.includes('"msg":"agent.runtime_missing"'),
    firstInstanceExited: /first instance (?:exited with|was killed)/.test(failure), homeWindowMissing: failure.includes("waiting for home window"),
    handoverFailed: /(?:second instance|second launch|receive second-instance)/.test(failure),
    askFailed: /(?:third instance|third launch|open the ask box|ask box for a start)/.test(failure),
    jumpListFailed: /(?:Windows refused the jump list|put Ask Ember in its jump list)/.test(failure),
    homeShown: smoke.stdout.includes("first instance showed its window"), handoverReceived: smoke.stdout.includes("second launch handed over"),
    authSourceNone: smoke.stdout.includes("the first instance used auth source none"), askShown: smoke.stdout.includes("a start with --ask handed over"),
  };
}

/** Bounds only the process this test spawned. Any forced stop/missing exit leaves quarantine intact. */
function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<ProcessObservation> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd: checkout, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", late = false, overflow = false;
    const timer = setTimeout(() => { late = true; child.kill(); reject(new Error("A fixed packaged fixture process exceeded its deadline; quarantine must be retained.")); }, timeout);
    child.stdout.on("data", bytes => { if (stdout.length + bytes.length > 16 * 1024 * 1024) { overflow = true; child.kill(); } else stdout += bytes; });
    child.stderr.on("data", bytes => { if (stderr.length + bytes.length > 1024 * 1024) { overflow = true; child.kill(); } else stderr += bytes; });
    child.once("error", () => { clearTimeout(timer); reject(new Error("A fixed packaged fixture process could not start; quarantine must be retained.")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (late) reject(new Error("A fixed packaged fixture process exceeded its deadline; quarantine must be retained."));
      else if (overflow) reject(new Error("A fixed packaged fixture process exceeded the bounded output limit; quarantine must be retained."));
      else resolve({ code, signal, stdout, stderr });
    });
  });
}

it.skipIf(!available && !required)("verifies the extracted Windows ZIP launch and shipped SDK/native controller dependencies without opening packaged debugging", async () => {
  expect(process.platform, "The explicitly required packaged Windows proof needs Windows").toBe("win32"); expect(process.arch).toBe("x64");
  expect(fs.existsSync(archive), "Run npm run package:win before the packaged coding proof").toBe(true);
  // No unknown SDK/native ownership is underneath Vitest's unconditional run-temp cleanup.
  const runTemporary = fs.realpathSync.native(os.tmpdir()), base = path.basename(runTemporary).startsWith("ember-run-") ? path.dirname(runTemporary) : runTemporary;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "ember-packaged-coding-")));
  const extracted = path.join(root, "extracted"), profile = path.join(root, "profile"), source = path.join(root, "source"), copies = path.join(root, "copies"), temporary = path.join(root, "temporary"), home = path.join(root, "home");
  for (const directory of [extracted, profile, source, copies, temporary, home, path.join(home, "gh")]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(source, "app.ts"), "export const answer = 41;\n");
  const receipt = path.join(root, "cleanup-receipt.json"), loaderMarker = path.join(root, "loader.marker"), loader = path.join(root, "loader.cjs");
  fs.writeFileSync(loader, `require('node:fs').writeFileSync(${JSON.stringify(loaderMarker)},'fixture-only');\n`);
  // A small allowlist excludes ambient credentials and injected loaders, including case variants on Windows.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE)$/i.test(key)) env[key] = value;
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, GH_CONFIG_DIR: path.join(home, "gh"), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  let devRequests = 0, step = 0, clean = false;
  const forbiddenProvider = http.createServer((_request, response) => { devRequests++; response.writeHead(500); response.end("Packaged development endpoint must be ignored."); });
  await new Promise<void>(resolve => forbiddenProvider.listen(0, "127.0.0.1", resolve));
  const forbiddenUrl = `http://127.0.0.1:${(forbiddenProvider.address() as { port: number }).port}/v1`;
  const model = await startMockLlm({ delayMs: 0, respond: (_messages: unknown[], tools: string[]) => {
    if (!tools.includes("finish_coding") || step >= 3) return { text: "The copied edit is ready for review." };
    if (++step === 1) return { tool: { name: "coding_read", args: { path: "app.ts" } } };
    if (step === 2) return { tool: { name: "coding_replace", args: { path: "app.ts", oldText: "answer = 41", newText: "answer = 42" } } };
    return { tool: { name: "finish_coding", args: { success: true, summary: "Prepared the copied answer for review." } } };
  } });
  try {
    const tar = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe");
    const listing = await run(tar, ["-t", "-f", archive], env, 15_000); expect(listing.code).toBe(0); expect(listing.signal).toBeNull();
    const names = listing.stdout.split(/\r?\n/).filter(Boolean);
    expect(names).toContain("Ember/Ember.exe");
    expect(names.every(name => name.startsWith("Ember/") && !name.includes("\\") && !name.includes(":") && !name.split("/").includes(".."))).toBe(true);
    const extraction = await run(tar, ["-x", "-f", archive, "-C", extracted], env, 30_000); expect(extraction.code).toBe(0); expect(extraction.signal).toBeNull();
    const exe = path.join(extracted, "Ember", "Ember.exe"), app = path.join(extracted, "Ember", "resources", "app"), digest = hash(exe);
    expect(fuseMismatches(readFuses(fs.readFileSync(exe)), emberFuses("win32"))).toEqual([]);
    for (const argument of ["--remote-debugging-port=0", "--remote-debugging-pipe", "--inspect=127.0.0.1:0"]) {
      const refused = await run(exe, [argument], { ...env, EMBER_USER_DATA: profile }, 15_000);
      expect(refused.code).toBe(2); expect(refused.signal).toBeNull();
      expect(refused.stderr).toContain("doesn't start with debugging switches"); expect(refused.stderr).not.toMatch(/(?:Debugger|DevTools) listening/);
    }
    // Existing smoke proves ordinary launch/window/handover only; its force-stop is never a native cleanup receipt.
    const smokeArguments = [path.join(checkout, "test/smoke/launch.mjs"), "--exe", exe, "--forbid", "shortcut.unavailable", "--expect-auth-source", "none"];
    const smoke = await run(process.execPath, smokeArguments,
      { ...env, EMBER_TEST_PROVIDER_URL: forbiddenUrl }, 90_000);
    console.info("Packaged launch smoke diagnostics (redirected profile):", smokeFacts(smoke));
    // Control only: preserve Windows' own profile locations while GitHub config, credential environment variables
    // and Ember's own profile stay isolated. Every packaged smoke assertion remains in force.
    const normalProfileEnv = { ...env };
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      const actual = Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1];
      if (actual === undefined) delete normalProfileEnv[name]; else normalProfileEnv[name] = actual;
    }
    const control = await run(process.execPath, smokeArguments, { ...normalProfileEnv, EMBER_TEST_PROVIDER_URL: forbiddenUrl }, 90_000);
    console.info("Packaged launch smoke diagnostics (normal OS profile control):", smokeFacts(control));
    expect(smoke.code, "The extracted packaged app must pass its normal launch/window/handover smoke").toBe(0); expect(smoke.signal).toBeNull();
    expect(smoke.stdout).toContain("the first instance used auth source none");
    expect(control.code, "The normal OS profile control must preserve every packaged smoke assertion").toBe(0); expect(control.signal).toBeNull();
    expect(control.stdout).toContain("the first instance used auth source none");
    expect(devRequests, "Packaged main must ignore the development model endpoint").toBe(0);
    const probeDirectory = path.join(app, "test-only-packaged-probe"); fs.mkdirSync(probeDirectory);
    const probe = path.join(probeDirectory, "controller.cjs"), input = path.join(root, "probe-input.json");
    const workerSource = (await build({ entryPoints: [path.join(checkout, "app/main/agent/coding-privacy-worker.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent" })).outputFiles[0].text;
    await build({ entryPoints: [path.join(checkout, "test/fixtures/windows-packaged-coding-probe.ts")], outfile: probe, bundle: true, platform: "node", format: "cjs", target: "node22", packages: "external",
      define: { __EMBER_CODING_PRIVACY_WORKER_SOURCE__: JSON.stringify(workerSource) }, logLevel: "silent" });
    const providerKey = `synthetic_packaged_provider_${randomUUID()}`;
    fs.writeFileSync(input, JSON.stringify({ app, exe, profile, source, copies, receipt, loaderMarker, providerUrl: model.baseUrl, providerKey,
      versions: { app: pkg.version, electron: pkg.devDependencies.electron, sdk: pkg.dependencies["@github/copilot-sdk"], koffi: pkg.dependencies.koffi } }));
    const observed = await run(exe, [probe, input], { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: `--require=${JSON.stringify(loader)}` }, 60_000);
    expect(observed.code, "The fixed packaged dependency/controller probe must finish with a verified cleanup receipt").toBe(0); expect(observed.signal).toBeNull();
    expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual({ version: 1, proof: "packaged-dependencies-native-controller", cleanup: "complete", childExited: true, checks: { ran: 0, passed: 0, failed: 0 } });
    expect(step).toBe(3); expect(model.requests.length).toBeGreaterThanOrEqual(3);
    const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding"].sort().join("\0");
    expect(model.requests.every((request: { tools: string[] }) => request.tools.slice().sort().join("\0") === allowed)).toBe(true);
    expect(JSON.stringify(model.requests.map((request: { messages: unknown }) => request.messages))).not.toContain(providerKey);
    expect(fs.existsSync(loaderMarker)).toBe(false); expect(hash(exe)).toBe(digest);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe("export const answer = 41;\n");
    expect(fs.readdirSync(copies)).toEqual([]); expect(fs.readdirSync(path.join(profile, "coding-controllers"))).toEqual([]);
    clean = true;
  } finally {
    await model.close(); await new Promise<void>(resolve => forbiddenProvider.close(() => resolve()));
    if (clean) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.error("Packaged Windows ownership was not verified; synthetic quarantine was retained outside Vitest cleanup.");
  }
}, 180_000);
