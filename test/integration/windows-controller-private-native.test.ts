/** Real Windows NTFS and pinned SDK proof for protected trusted-controller storage; no coding command backend is enabled. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { CopilotClient } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import { allocateWindowsControllerStorage } from "../../app/main/agent/windows-controller-storage";
import { loadWindowsControllerNative } from "../../app/main/agent/windows-controller-native";
import { loadWindowsCodingNative } from "../../app/main/agent/windows-coding-native";
import { WindowsCodingCopy } from "../../app/main/agent/windows-coding-copy";
import { WindowsScopedCodingFiles } from "../../app/main/agent/windows-scoped-coding-files";
import { PrivateControllerRuntime, PrivateControllerCleanupError, type PrivateControllerRuntimeInput } from "../../app/main/agent/private-controller-runtime";
import type { PrivateControllerStorage } from "../../app/main/agent/private-controller-storage";
import { CustomCodingController, type FileOnlyCodingControllerOptions } from "../../app/main/agent/custom-coding-controller";
import { hardenedSessionConfig } from "../../app/main/agent/session-config";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { loadWin32System } from "../../app/main/platform/win32/system/ffi";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** Scan only this fixture's fresh controller tree; never follow links or inspect an ambient credential file. */
function excludesSyntheticState(directory: string, values: readonly string[]): boolean {
  let count = 0, bytes = 0;
  let stage: "list" | "metadata" | "read" = "list", currentDepth = 0;
  const refuse = (reason: string, facts: Record<string, number | boolean | string> = {}): false => {
    // Report only fixed reasons and synthetic indices/metadata; never paths, file bodies or credential values.
    console.info("Windows synthetic state scan refusal:", { reason, stage, depth: currentDepth, ...facts });
    return false;
  };
  const visit = (folder: string, depth: number): boolean => {
    currentDepth = depth; stage = "list";
    if (depth > 64) return refuse("depth-limit");
    for (const name of fs.readdirSync(folder)) {
      currentDepth = depth; stage = "metadata";
      if (++count > 10_000) return refuse("entry-limit");
      const filename = path.join(folder, name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) return refuse("link");
      if (stat.isDirectory()) { if (!visit(filename, depth + 1)) return false; }
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) {
          return refuse("file-metadata", { file: stat.isFile(), links: stat.nlink, size: stat.size, bytes });
        }
        stage = "read";
        const data = fs.readFileSync(filename);
        try {
          const syntheticIndex = values.findIndex(value => data.includes(Buffer.from(value)));
          if (syntheticIndex >= 0) return refuse("synthetic-value", { syntheticIndex });
        }
        finally { data.fill(0); }
      }
    }
    return true;
  };
  try { return visit(directory, 0); }
  catch (error) {
    const code = (error as { code?: unknown })?.code;
    return refuse("io", { code: typeof code === "string" && /^E[A-Z0-9]{1,24}$/.test(code) ? code : "unknown" });
  }
}

/** Fixture-only observation: the real SDK stops before its retained files are scanned, then normal native disposal resumes. */
function scanStateAfterSdkStop(runtime: PrivateControllerRuntime, child: ChildProcess, values: readonly string[]): () => void {
  const stop = runtime.client.stop.bind(runtime.client), root = path.dirname(runtime.workingDirectory);
  let scans = 0, safe = false;
  runtime.client.stop = async () => {
    const errors = await stop();
    if (errors.length) return errors;
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
    safe = excludesSyntheticState(root, values); scans++;
    return errors;
  };
  return () => { expect(scans).toBe(1); expect(safe).toBe(true); };
}
const runtimePath = () => {
  const runtime = runtimeFor("win32", "x64"), located = locateRuntime({ appPath: process.cwd(), runtimeId: runtime.id, exe: runtime.exe });
  expect(located.exists).toBe(true); return located.path;
};

function scratch() {
  // Keep quarantined native ownership outside vitest's unconditional recursive run-temp teardown.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), "ember-controller-native-"))), userData = path.join(root, "host");
  fs.mkdirSync(userData); fs.writeFileSync(path.join(root, "parent-canary.txt"), "parent remains unchanged");
  const runtimes: PrivateControllerRuntime[] = [], controllers: CustomCodingController[] = [], copies: WindowsCodingCopy[] = [], storages: PrivateControllerStorage[] = [];
  let uncertain = false;
  return { root, userData,
    storage: async () => {
      try { const value = await allocateWindowsControllerStorage(userData); storages.push(value); return value; }
      catch (error) { uncertain = true; throw error; }
    },
    start: async (input: PrivateControllerRuntimeInput, factory?: Parameters<typeof PrivateControllerRuntime.start>[2]) => {
      try { const value = await PrivateControllerRuntime.start(input, undefined, factory); runtimes.push(value); return value; }
      catch (error) { uncertain = true; throw error; }
    },
    controller: async (options: FileOnlyCodingControllerOptions) => {
      try { const value = await CustomCodingController.start(options); controllers.push(value); return value; }
      catch (error) { uncertain = true; throw error; }
    },
    copy: async (source: string, privateBase: string) => {
      try {
        const value = await WindowsCodingCopy.create({ source, privateBase, protectedPaths: [userData], signal: new AbortController().signal, current: () => true });
        copies.push(value); return value;
      } catch (error) { uncertain = true; throw error; }
    },
    cleanup: async () => {
      const errors: unknown[] = [];
      for (const controller of controllers.slice().reverse()) { try { await controller.close(); } catch (error) { errors.push(error); } }
      for (const runtime of runtimes.slice().reverse()) { try { await runtime.close(); } catch (error) { errors.push(error); } }
      for (const copy of copies.slice().reverse()) { try { await copy.close(); } catch (error) { errors.push(error); } }
      for (const storage of storages.slice().reverse()) { try { await storage.close(); } catch (error) { errors.push(error); } }
      // An unsuccessful admission or close may still own native handles/state. Never erase it as a test fallback.
      if (!uncertain && !errors.length) fs.rmSync(root, { recursive: true, force: true });
      if (errors.length) throw new AggregateError(errors, "Controller fixture cleanup was not verified; its synthetic scratch was retained.");
    },
  };
}

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")("native Windows private SDK controller", () => {
  it("keeps the root and four roles explicitly protected while retiring SDK-style inherited descendants after closure", async () => {
    const f = scratch();
    try {
      const storage = await f.storage(), api = loadWindowsCodingNative(), security = loadWindowsControllerNative();
      expect(api.ownerSid === security.ownerSid).toBe(true);
      expect(/^S-\d+(?:-\d+)+$/.test(security.tokenOwnerSid)).toBe(true);
      const elevated = loadWin32System()?.elevated(); expect(typeof elevated).toBe("boolean");
      console.info(`Windows controller facts: elevated=${elevated} distinct-default-owner=${security.tokenOwnerSid !== security.ownerSid} os=${os.release()}`);
      for (const location of [storage.paths.root, storage.paths.cwd, storage.paths.home, storage.paths.state, storage.paths.temporary]) {
        const pin = api.pin(location, "read");
        try { security.assertFixed(api.info(pin.handle)); }
        finally { for (const handle of pin.handles.slice().reverse()) api.close(handle); }
      }
      fs.mkdirSync(path.join(storage.paths.state, "sdk-session"));
      fs.writeFileSync(path.join(storage.paths.state, "sdk-session", "session.json"), "{\"fixture\":true}");
      fs.mkdirSync(path.join(storage.paths.home, "sdk-cache"));
      fs.writeFileSync(path.join(storage.paths.home, "sdk-cache", "state.bin"), Buffer.from([0, 1, 2, 255]));
      await storage.verify(); await storage.close();
      expect(fs.existsSync(storage.paths.root)).toBe(false);
      expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
      expect(fs.readFileSync(path.join(f.root, "parent-canary.txt"), "utf8")).toBe("parent remains unchanged");
    } finally { await f.cleanup(); }
  }, 30_000);

  it("blocks a new controller while SDK stop is pending and audits/removes its state only after that stop settles", async () => {
    const f = scratch(), entered = deferred(), release = deferred(); let stops = 0;
    try {
      const input = { userData: f.userData, runtimePath: runtimePath(), env: process.env };
      const runtime = await f.start(input, () => ({ start: async () => undefined, stop: async () => { stops++; entered.resolve(); await release.promise; return []; } }) as unknown as CopilotClient);
      const root = path.dirname(runtime.workingDirectory), state = path.join(root, "state", "sdk-writing.json");
      fs.writeFileSync(state, "trusted SDK state before stop");
      const closing = runtime.close(); await entered.promise;
      expect(fs.existsSync(state)).toBe(true);
      let unexpectedStart = false;
      await expect(PrivateControllerRuntime.start(input, undefined, () => { unexpectedStart = true; throw new Error("No second SDK may start while retirement is pending"); })).rejects.toBeInstanceOf(PrivateControllerCleanupError);
      expect(unexpectedStart).toBe(false); expect(fs.existsSync(state)).toBe(true);
      release.resolve(); await closing;
      expect(stops).toBe(1); expect(fs.existsSync(root)).toBe(false);
      expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
    } finally { release.resolve(); await f.cleanup(); }
  }, 30_000);

  it("rejects native execution and ambient project/home configuration on the actual SDK, with functioning native and plugin-hook controls", async () => {
    const bundledRuntime = runtimePath(), f = scratch(), project = path.join(f.root, "project"), ambientHome = path.join(f.root, "ambient-home"), plugin = path.join(project, "fixture-plugin"), copies = path.join(f.root, "copies");
    fs.mkdirSync(copies);
    const marker = (name: string) => path.join(f.root, `${name}.marker`), instruction = "AMBIENT_CONTROLLER_INSTRUCTION_MUST_NOT_LOAD";
    const providerKey = `synthetic_provider_${randomUUID()}`, ambientToken = `synthetic_ambient_token_${randomUUID()}`, ambientProvider = `synthetic_ambient_provider_${randomUUID()}`;
    const synthetic = [providerKey, ambientToken, ambientProvider];
    const writer = path.join(f.root, "write-fixture.cjs"), loader = path.join(f.root, "loader-fixture.cjs");
    fs.writeFileSync(writer, `const f=require('node:fs');const values=${JSON.stringify(synthetic)};f.writeFileSync(process.argv[2],JSON.stringify({cwd:process.cwd(),hasSyntheticCredential:Object.values(process.env).some(v=>values.some(s=>v?.includes(s))),env:Object.fromEntries(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','NODE_OPTIONS','NODE_PATH','COPILOT_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY'].map(k=>[k,process.env[k]??null]))}));\n`);
    fs.writeFileSync(loader, `require('node:fs').writeFileSync(${JSON.stringify(marker("loader"))},'ambient loader executed');\n`);
    const quote = (value: string) => { if (value.includes('"')) throw new Error("The fixed Windows fixture path cannot be quoted"); return `"${value}"`; };
    const nodeCommand = (output: string) => `${quote(process.execPath)} ${quote(writer)} ${quote(output)}`;
    const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
    for (const base of [project, ambientHome]) {
      for (const directory of [base, path.join(base, ".github", "hooks"), path.join(base, ".copilot", "extensions"), path.join(base, ".github", "skills", "fixture")]) fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(base, "AGENTS.md"), instruction);
      fs.writeFileSync(path.join(base, ".github", "copilot-instructions.md"), instruction);
      fs.writeFileSync(path.join(base, ".github", "skills", "fixture", "SKILL.md"), `---\nname: fixture\ndescription: ${instruction}\n---\n${instruction}\n`);
      fs.writeFileSync(path.join(base, ".github", "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: {
        sessionStart: [{ type: "command", bash: nodeCommand(marker("ambient-hook")), powershell: `& ${ps(process.execPath)} ${ps(writer)} ${ps(marker("ambient-hook"))}` }],
        userPromptSubmitted: [{ type: "command", bash: nodeCommand(marker("ambient-hook")), powershell: `& ${ps(process.execPath)} ${ps(writer)} ${ps(marker("ambient-hook"))}` }],
      } }));
      const mcp = { mcpServers: { fixture: { type: "stdio", command: process.execPath, args: [writer, marker("mcp")], tools: ["*"] } } };
      fs.writeFileSync(path.join(base, ".copilot", "config.json"), JSON.stringify({ ...mcp, pluginDirectories: [plugin] }));
      fs.writeFileSync(path.join(base, ".copilot", "mcp-config.json"), JSON.stringify(mcp));
      fs.writeFileSync(path.join(base, ".copilot", "extensions", "fixture.mjs"), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker("extension"))},'fixture');export default()=>{};`);
    }
    // Match the pinned runtime's bundled plugin format, including its explicit Windows shell variant.
    for (const directory of [path.join(plugin, ".plugin"), path.join(plugin, "hooks")]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(plugin, ".plugin", "plugin.json"), JSON.stringify({ name: "windows-controller-fixture", version: "1.0.0" }));
    const pluginHook = { type: "command", bash: nodeCommand(marker("plugin-control")),
      powershell: `$ErrorActionPreference = 'Stop'; & ${ps(process.execPath)} ${ps(writer)} ${ps(marker("plugin-control"))}; exit $LASTEXITCODE` };
    fs.writeFileSync(path.join(plugin, "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: {
      sessionStart: [pluginHook], userPromptSubmitted: [pluginHook],
    } }));
    const original = "export const answer = 41;\n", edited = "export const answer = 42;\n";
    fs.writeFileSync(path.join(project, "app.ts"), original);
    let requests = 0;
    const canary = http.createServer((_request, response) => { requests++; response.end("disposable fixture"); });
    await new Promise<void>(resolve => canary.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(canary.address() as { port: number }).port}/fixture`;
    let attempt: { name: string; args: object } | null = null, issued = false, finishIssued = false, positive = false, step = 0;
    const model = await startMockLlm({ delayMs: 0, respond: (_messages: unknown[], tools: string[]) => {
      if (positive && tools.includes("finish_coding")) {
        if (++step === 1) return { tool: { name: "coding_read", args: { path: "app.ts" } } };
        if (step === 2) return { tool: { name: "coding_write", args: { path: "app.ts", text: edited } } };
        if (step === 3) return { tool: { name: "finish_coding", args: { success: true, summary: "Updated the copied answer for review." } } };
        return { text: "The private file edit is ready for review." };
      }
      if (attempt && !issued) { issued = true; return { tool: attempt }; }
      if (tools.includes("finish_coding") && !finishIssued) { finishIssued = true; return { tool: { name: "finish_coding", args: { success: false, summary: "The requested execution is unavailable." } } }; }
      return { text: "Fixture complete." };
    } });
    const provider = { type: "openai" as const, wireApi: "completions" as const, baseUrl: model.baseUrl, apiKey: providerKey };
    const input = { userData: f.userData, runtimePath: bundledRuntime, env: { ...process.env, HOME: ambientHome, USERPROFILE: ambientHome, APPDATA: ambientHome, LOCALAPPDATA: ambientHome,
      TMP: ambientHome, TEMP: ambientHome, NODE_OPTIONS: `--require=${quote(loader.replace(/\\/g, "/"))}`, NODE_PATH: ambientHome, COPILOT_CONFIG_DIR: ambientHome,
      GH_TOKEN: ambientToken, GITHUB_TOKEN: ambientToken, OPENAI_API_KEY: ambientProvider } };
    const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding"];
    const openController = async (onEvent?: FileOnlyCodingControllerOptions["onEvent"]) => {
      const copy = await f.copy(project, copies);
      const controller = await f.controller({ mode: "files-only", runtime: input, model: "mock-model", provider, current: () => true,
        files: signal => WindowsScopedCodingFiles.create({ copy, signal }), finishCheck: () => copy.files(async () => true), ...(onEvent ? { onEvent } : {}) });
      return { copy, controller };
    };
    const expectedTools = allowed.slice().sort().join("\0");
    const exactTools = (sent: { tools: string[] }[]) => sent.length > 0 && sent.every(entry => entry.tools.slice().sort().join("\0") === expectedTools);
    try {
      positive = true;
      const { copy, controller } = await openController();
      const runtime = (controller as unknown as { runtime: PrivateControllerRuntime }).runtime;
      const child = (runtime.client as unknown as { cliProcess: ChildProcess }).cliProcess;
      expect(Number.isInteger(child.pid)).toBe(true);
      const assertStoppedState = scanStateAfterSdkStop(runtime, child, synthetic);
      let before = model.requests.length;
      expect(await controller.run("Update only app.ts in the private copy and prepare the edit for review without running code.")).toEqual({ success: true,
        summary: "Updated the copied answer for review. No commands or tests were run." });
      expect(exactTools(model.requests.slice(before))).toBe(true);
      expect(fs.readFileSync(path.join(copy.directory, "app.ts"), "utf8")).toBe(edited);
      expect(fs.readFileSync(path.join(project, "app.ts"), "utf8")).toBe(original);
      const privateRoot = path.dirname(runtime.workingDirectory);
      await controller.close(); assertStoppedState(); await copy.close();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true); expect(fs.existsSync(privateRoot)).toBe(false);
      positive = false;
      const attacks = [
        { name: "run_command", args: { target: "This computer", command: nodeCommand(marker("run-command")), why: "Fixture execution must be unavailable" } },
        { name: "powershell", args: { command: `& ${ps(process.execPath)} ${ps(writer)} ${ps(marker("powershell"))}` } },
        { name: "cmd", args: { command: nodeCommand(marker("cmd")) } }, { name: "bash", args: { command: nodeCommand(marker("bash")) } },
        { name: "create", args: { path: marker("create"), file_text: "fixture" } }, { name: "edit", args: { path: marker("edit"), old_str: "old", new_str: "new" } },
        { name: "web_fetch", args: { url } }, { name: "fetch", args: { url } },
        { name: "builtin:powershell", args: { command: nodeCommand(marker("qualified")) } },
        { name: "task", args: { agent_type: "general-purpose", description: "fixture", prompt: nodeCommand(marker("task")) } },
      ];
      for (const attack of attacks) {
        attempt = attack; issued = false; finishIssued = false;
        const agents: string[] = [], opened = await openController(event => { if (event.agentId || event.type.startsWith("subagent.")) agents.push(event.type); });
        before = model.requests.length;
        expect((await opened.controller.run(`Handle the unavailable ${attack.name} execution fixture and report incomplete work.`)).success).toBe(false);
        const sent = model.requests.slice(before);
        expect(exactTools(sent)).toBe(true);
        expect(JSON.stringify(sent.map((entry: { messages: unknown }) => entry.messages)).includes(instruction)).toBe(false);
        expect(synthetic.some(value => JSON.stringify(sent.map((entry: { messages: unknown }) => entry.messages)).includes(value))).toBe(false);
        expect(agents).toEqual([]); expect(requests).toBe(0); expect(fs.readdirSync(f.root).some(name => name.endsWith(".marker"))).toBe(false);
        expect(fs.readFileSync(path.join(project, "app.ts"), "utf8")).toBe(original);
        expect(fs.readFileSync(path.join(opened.copy.directory, "app.ts"), "utf8")).toBe(original);
        const ownedRuntime = (opened.controller as unknown as { runtime: PrivateControllerRuntime }).runtime;
        const ownedRoot = path.dirname(ownedRuntime.workingDirectory), ownedChild = (ownedRuntime.client as unknown as { cliProcess: ChildProcess }).cliProcess;
        const assertOwnedStoppedState = scanStateAfterSdkStop(ownedRuntime, ownedChild, synthetic);
        await opened.controller.close(); assertOwnedStoppedState(); await opened.copy.close();
        expect(ownedChild.exitCode !== null || ownedChild.signalCode !== null).toBe(true); expect(fs.existsSync(ownedRoot)).toBe(false);
      }

      // Explicitly unsafe disposable controls prove the denied native tool and plugin hook really can execute.
      const native = await f.start(input), name = "relative-control.marker";
      attempt = { name: "create", args: { path: name, file_text: "fixture-only" } }; issued = false;
      const nativeSession = await native.client.createSession({ model: "mock-model", provider, enableConfigDiscovery: false,
        availableTools: ["builtin:create"], onPermissionRequest: () => ({ kind: "approve-once" } as never) });
      try {
        await nativeSession.sendAndWait({ prompt: "Create the relative disposable native-control marker." }, 15_000);
        expect(fs.readFileSync(path.join(native.workingDirectory, name), "utf8")).toBe("fixture-only");
        expect(fs.existsSync(path.join(project, name))).toBe(false); expect(fs.existsSync(path.join(ambientHome, name))).toBe(false);
      } finally { await nativeSession.disconnect(); await native.client.deleteSession(nativeSession.sessionId); }
      await native.close();

      const hooks = await f.start(input); attempt = null; issued = false;
      const hookSession = await hooks.client.createSession({ ...hardenedSessionConfig({ model: "mock-model", provider, tools: [], workingDirectory: hooks.workingDirectory,
        systemMessage: { mode: "customize", sections: {}, content: "Say hello." }, onPermissionRequest: () => ({ kind: "reject" }) }), pluginDirectories: [plugin] });
      try { await hookSession.sendAndWait({ prompt: "Hello from the explicit plugin positive control." }, 20_000); }
      finally { await hookSession.disconnect(); await hooks.client.deleteSession(hookSession.sessionId); }
      const observed = JSON.parse(fs.readFileSync(marker("plugin-control"), "utf8")) as { cwd: string; hasSyntheticCredential: boolean; env: Record<string, string | null> };
      const hookRoot = path.dirname(hooks.workingDirectory);
      // Native plugin hooks run from their explicitly opted-in plugin root; the native-create control proves process cwd.
      expect(samePath(observed.cwd, plugin)).toBe(true);
      expect(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].every(key => typeof observed.env[key] === "string" && samePath(observed.env[key]!, path.join(hookRoot, "home")))).toBe(true);
      expect(["TMP", "TEMP"].every(key => typeof observed.env[key] === "string" && samePath(observed.env[key]!, path.join(hookRoot, "tmp")))).toBe(true);
      expect(["NODE_OPTIONS", "NODE_PATH", "COPILOT_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"].every(key => observed.env[key] === null)).toBe(true);
      expect(observed.hasSyntheticCredential).toBe(false);
      expect(fs.existsSync(marker("loader"))).toBe(false); expect(fs.existsSync(marker("ambient-hook"))).toBe(false); expect(fs.existsSync(marker("mcp"))).toBe(false); expect(fs.existsSync(marker("extension"))).toBe(false);
      await hooks.close(); expect(fs.existsSync(hookRoot)).toBe(false); expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
    } finally {
      try { await f.cleanup(); }
      finally { await model.close(); await new Promise<void>(resolve => canary.close(() => resolve())); }
    }
  }, 120_000);
});
