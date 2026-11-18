/** Portable tests of the actual synthetic CJS/CI-builder boundaries. No Electron, esbuild build, compiler or native work. */
/* eslint-disable @typescript-eslint/no-explicit-any -- The VM executes actual untyped CJS; these stand-ins model its dynamic IPC and DOM boundary only. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { types } from "node:util";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { judgeMetrics } from "../../app/renderer/command/model";
import { COMMANDS_RENDERER_LOAD_PREFIX, COMMANDS_RENDERER_MASKS, COMMANDS_RENDERER_READY_PREFIX, COMMANDS_RENDERER_SAMPLE_PREFIX, parseCommandsRendererSample } from "../fixtures/commands-renderer-native-contract";

const appRoot = "test/fixtures/commands-renderer-native-app";
const main = fs.readFileSync(appRoot + "/main.cjs", "utf8"), preload = fs.readFileSync(appRoot + "/preload.cjs", "utf8"), builder = fs.readFileSync("test/fixtures/commands-renderer-native-build.mjs", "utf8");
const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sample = { schema: 1, sequence: 1, card: 2, dom: 15, geometry: 255, reported: 7, arm: 2, assets: 7, lifecycle: 255 };
it("preserves the complete original trusted-first-answer and fresh second-card lifecycle byte-for-byte", () => {
  const begin = main.indexOf('ipcMain.on(prefix + "answer"'), end = main.indexOf('ipcMain.on(prefix + "sampled"', begin);
  expect(begin > 0 && end > begin).toBe(true);
  expect(createHash("sha256").update(main.slice(begin, end)).digest("hex")).toBe("5d83b5d24ec65ad2268611c25a8d2d9ca5fb5441218cc3d482c7dda552c06d38");
});

it("admits only closed numeric samples without proxy, getter, symbol or extra-data access", () => {
  expect(parseCommandsRendererSample(sample)).toEqual(sample);
  for (const value of [{ ...sample, private: "PRIVATE" }, { ...sample, [Symbol("PRIVATE")]: 1 }, { ...sample, schema: 2 }, { ...sample, sequence: 0 }, { ...sample, sequence: 17 }, { ...sample, card: 3 }, { ...sample, dom: 32 }, { ...sample, reported: 4 }, { ...sample, dom: 31 }, { ...sample, arm: 3 }, { ...sample, geometry: Infinity }, { ...sample, lifecycle: 0.5 }]) expect(parseCommandsRendererSample(value)).toBeNull();
  let traps = 0; const trap = () => { traps++; throw new Error("PRIVATE"); };
  expect(parseCommandsRendererSample(new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }))).toBeNull();
  expect(parseCommandsRendererSample({ ...sample, get assets() { return trap(); } })).toBeNull(); expect(traps).toBe(0);
  expect(JSON.stringify(COMMANDS_RENDERER_MASKS)).not.toContain("PRIVATE");
});

type Build = (input: { repository: string; stage: string; tap: Buffer }) => Promise<{ app: string; assetsVerified: true; rendererSources: 8 | 9 }>;
function stageHarness(change: "none" | "map" | "mutated" | "uri" | "observed" | "observed-map" | "missing-observer" | "unexpected-observer" | "shared-map" | "unexpected-source" | "duplicate-source" = "none", native = true, required = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-command-fixture-unit-")); temporary.push(root);
  const repository = path.join(root, "repo"), stage = path.join(root, "stage"); fs.mkdirSync(repository); fs.mkdirSync(stage);
  const put = (name: string, text: string | Buffer) => { const file = path.join(repository, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put("package.json", JSON.stringify({ devDependencies: { esbuild: "0.28.2" }, dependencies: { "@xterm/xterm": "5.5.0" } }));
  put("node_modules/esbuild/package.json", '{"version":"0.28.2"}'); put("node_modules/@xterm/xterm/package.json", '{"version":"5.5.0"}');
  put("node_modules/@xterm/xterm/css/xterm.css", "fixed CSS");
  const sources = [
    ...["visible", "copy", "keys", "model", "terminal", "terminal-options", "terminal-size", "main"].map(name => "app/renderer/command/" + name + ".ts"),
    ...["shortcuts", "targets", "visible-text"].map(name => "app/shared/" + name + ".ts"),
  ];
  const contents = sources.map(source => "// fixed " + path.basename(source, ".ts"));
  for (const [index, source] of sources.entries()) put(source, contents[index]);
  if (["observed", "observed-map", "missing-observer"].includes(change)) {
    put("app/renderer/command/main.ts", 'import "../../shared/command-card-observation"; // fixed main');
    if (change !== "missing-observer") put("app/shared/command-card-observation.ts", "// fixed observer");
  }
  if (change === "unexpected-observer") put("app/shared/command-card-observation.ts", "// fixed observer");
  for (const name of ["index.html", "styles.css"]) put("app/renderer/command/" + name, fs.readFileSync("app/renderer/command/" + name));
  put("app/renderer/shared/ember.css", "fixed CSS"); put("assets/fonts/InterVariable.woff2", "fixed font");
  for (const name of ["main.cjs", "preload.cjs", "package.json"]) put(appRoot + "/" + name, fs.readFileSync(appRoot + "/" + name));
  const calls: Record<string, unknown>[] = []; let imports = 0;
  const source = builder.replace(/^import .+;\n/gm, "").replace("export async function stageCommandsRenderer", "async function stageCommandsRenderer").replace('await import("esbuild")', "await loadEsbuild()") + "\nmodule.exports = stageCommandsRenderer;";
  const module = { exports: undefined as unknown as Build };
  runInNewContext(source, { module, fs: fsp, path, createHash, Buffer, fileURLToPath, process: { platform: native ? "win32" : "linux", env: required ? { EMBER_COMMANDS_RENDERER_NATIVE_TEST: "1" } : {} },
    createRequire: () => ({ resolve: (name: string) => path.join(repository, "node_modules", name) }), loadEsbuild: async () => { imports++; return { build: async (options: Record<string, unknown>) => {
      calls.push(options); const outfile = options.outfile as string;
      const map = { sources: sources.map(source => path.relative(path.dirname(outfile), path.join(repository, source))), sourcesContent: [...contents] };
      if (["observed", "observed-map", "unexpected-observer"].includes(change)) {
        if (change !== "unexpected-observer") map.sourcesContent[7] = 'import "../../shared/command-card-observation"; // fixed main';
        map.sources.push(path.relative(path.dirname(outfile), path.join(repository, "app/shared/command-card-observation.ts")));
        map.sourcesContent.push(change === "observed-map" ? "PRIVATE stale observer" : "// fixed observer");
      }
      if (change === "uri") map.sources = sources.map(source => pathToFileURL(path.join(repository, source)).href);
      if (change === "shared-map") map.sourcesContent[8] = "PRIVATE stale shared source";
      if (change === "unexpected-source" || change === "duplicate-source") {
        map.sources.push(change === "unexpected-source" ? path.relative(path.dirname(outfile), path.join(repository, "app/shared/extra.ts")) : map.sources[8]);
        map.sourcesContent.push(contents[8]);
      }
      map.sources.push("webpack://@xterm/xterm/src/browser/Terminal.ts");
      map.sourcesContent.push("// fixed xterm source");
      if (change === "map") map.sourcesContent[0] = "PRIVATE stale source";
      if (change === "mutated") put("app/renderer/command/model.ts", "changed during build");
      return { outputFiles: [{ path: outfile, contents: Buffer.from("fixed output") }, { path: outfile + ".map", contents: Buffer.from(JSON.stringify(map)) }] };
    } }; } });
  return { root, repository, stage, put, calls, imports: () => imports, invoke: module.exports, build: () => module.exports({ repository, stage, tap: Buffer.from("TAP version 13\nERR_ASSERTION\n") }) };
}
it("stages the unchanged renderer with a mocked build boundary and checks its manifest/copies/source map", async () => {
  const h = stageHarness(), result = await h.build(); expect(result).toEqual({ app: path.join(h.stage, "app"), assetsVerified: true, rendererSources: 8 });
  expect(h.imports()).toBe(1); expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({ absWorkingDir: h.repository, entryPoints: ["app/renderer/command/main.ts"], bundle: true, sourcemap: true, platform: "browser", format: "iife", target: "chrome140", write: false, logLevel: "silent" });
  expect(h.calls[0]).not.toHaveProperty("plugins"); expect(h.calls[0]).not.toHaveProperty("alias");
  const manifest = JSON.parse(fs.readFileSync(path.join(result.app, "fixture-data.json"), "utf8")); expect(manifest.schema).toBe(1);
  for (const file of manifest.files as { path: string; bytes: number; sha256: string }[]) { const bytes = fs.readFileSync(path.join(result.app, file.path)); expect(bytes.length).toBe(file.bytes); expect(digest(bytes)).toBe(file.sha256); }
  expect(Buffer.from(manifest.tap.base64, "base64").length).toBe(manifest.tap.bytes);
});
it.each(["wrong-os", "default"])("refuses %s invocation before importing a builder or staging assets", async condition => {
  const h = stageHarness("none", condition !== "wrong-os", condition !== "default"); await expect(h.build()).rejects.toThrow("The synthetic Commands renderer could not be staged."); expect(h.imports()).toBe(0); expect(fs.readdirSync(h.stage)).toEqual([]);
});
it.each([Buffer.alloc(0), Buffer.alloc(65537, 65), Buffer.from([0xff]), Buffer.from("an unrelated log")])("refuses an invalid/oversized public TAP payload before loading esbuild", async tap => {
  const h = stageHarness(); await expect(h.invoke({ repository: h.repository, stage: h.stage, tap })).rejects.toThrow("The synthetic Commands renderer could not be staged."); expect(h.imports()).toBe(0);
});
it.each(["map", "mutated", "shared-map", "unexpected-source", "duplicate-source"] as const)("refuses %s source mismatches instead of launching a plausible stale bundle", async change => {
  const h = stageHarness(change); await expect(h.build()).rejects.toThrow("The synthetic Commands renderer could not be staged."); expect(fs.existsSync(path.join(h.stage, "app/fixture-data.json"))).toBe(false);
});
it("accepts exact canonical file-URI source-map entries while preserving the same fresh eight-source equality", async () => {
  const h = stageHarness("uri"); await expect(h.build()).resolves.toMatchObject({ assetsVerified: true }); expect(h.calls).toHaveLength(1);
});
it("authenticates the current observed renderer's ninth shared module without borrowing arbitrary Main sources", async () => {
  const h = stageHarness("observed"); await expect(h.build()).resolves.toMatchObject({ assetsVerified: true, rendererSources: 9 });
  expect(JSON.parse(fs.readFileSync(path.join(h.stage, "app/fixture-data.json"), "utf8")).rendererSources).toBe(9);
});
it.each(["observed-map", "missing-observer", "unexpected-observer"] as const)("refuses %s instead of claiming a different renderer source scope", async mode => {
  const h = stageHarness(mode); await expect(h.build()).rejects.toThrow("The synthetic Commands renderer could not be staged.");
});
it.each(["occupied", "version", "link"])("refuses %s input before loading esbuild", async problem => {
  const h = stageHarness();
  if (problem === "occupied") fs.writeFileSync(path.join(h.stage, "existing"), "unrelated");
  if (problem === "version") h.put("node_modules/esbuild/package.json", '{"version":"9.9.9"}');
  if (problem === "link") { fs.unlinkSync(path.join(h.repository, "assets/fonts/InterVariable.woff2")); fs.symlinkSync(path.join(h.repository, "package.json"), path.join(h.repository, "assets/fonts/InterVariable.woff2")); }
  await expect(h.build()).rejects.toThrow("The synthetic Commands renderer could not be staged."); expect(h.imports()).toBe(0);
});

function preloadHarness() {
  const ipc = new EventEmitter(), sent: { channel: string; value: any }[] = []; let api: any, clock = 1000;
  const domEvents = new Map<string, () => void>(), html = { dataset: {} }, rect = { top: 80, bottom: 180, left: 30, right: 700 };
  const ancestor = { parentElement: html, style: { overflowX: "auto", overflowY: "auto" }, getBoundingClientRect: () => ({ top: 12, left: 12 }), clientTop: 0, clientLeft: 0, clientWidth: 736, clientHeight: 400 };
  const allow = { disabled: false }, deny = { disabled: false }, actions = { getBoundingClientRect: () => ({ top: 280 }) };
  const card = { querySelector: (s: string) => s === "button" ? allow : actions, querySelectorAll: () => [allow, deny] };
  const block = { parentElement: ancestor, getBoundingClientRect: () => rect, closest: () => card, scrollHeight: 100, clientHeight: 100, scrollWidth: 670, clientWidth: 670, scrollTop: 0 };
  const document = { documentElement: html, visibilityState: "visible", getElementById: () => block, addEventListener: (event: string, fn: () => void) => domEvents.set(event, fn), fonts: { status: "loaded", ready: Promise.resolve(), load: async () => [], check: () => true } };
  const initial = { state: { card: { n: 1, armMs: 1500 } }, replay: [] };
  const module = { exports: undefined as unknown as { sample(n: number): any } };
  runInNewContext(preload + "\nmodule.exports={sample};", { module, require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { api = value; } }, ipcRenderer: Object.assign(ipc, { invoke: async () => initial, send: (channel: string, value: unknown) => sent.push({ channel, value }) }) }),
    document, Date: { now: () => clock }, innerHeight: 480, innerWidth: 760, getComputedStyle: (element: { style: unknown }) => element.style });
  return { api, ipc, sent, block, rect, ancestor, allow, deny, document, domEvents, sample: module.exports.sample, time: (n: number) => { clock = n; } };
}
it("exposes the authentic Commands API only and samples actual cardSeen/arm bounds without inventing private model state", async () => {
  const h = preloadHarness(); expect(Object.keys(h.api).sort()).toEqual(["pull", "onState", "onOutput", "answer", "stop", "input", "cardSeen", "close", "size", "closeWindow"].sort());
  await h.api.pull(); expect(h.sample(1).arm).toBe(1); h.time(1200); h.api.cardSeen({ n: 1, seen: true, inView: true });
  h.time(2600); expect(h.sample(2)).toMatchObject({ card: 1, reported: 7, arm: 0 });
  h.time(2700); expect(h.sample(3)).toMatchObject({ dom: 15, geometry: 255, reported: 7, arm: 2 });
  h.api.onState(() => {}); h.ipc.emit("commands-renderer:state", {}, { card: { n: 2, armMs: 1500 } });
  expect(h.sample(4)).toMatchObject({ card: 2, reported: 0, arm: 1 });
  h.api.cardSeen({ n: 1, seen: true, inView: false }); expect(h.sample(5).reported).toBe(0);
  h.time(100); expect(h.sample(6)).toMatchObject({ arm: 0, lifecycle: 0 });
});
it("ignores standalone observation messages for approval while preserving the original valid legacy seen report even with extra diagnostics", async () => {
  const h = preloadHarness(); await h.api.pull();
  h.api.cardSeen({ n: 1, diagnostic: { schema: 1, source: 1, model: 31, ui: 11, geometry: 511, arm: 2, capped: 0 } });
  expect(h.sample(1).reported).toBe(0); expect(h.sent).toEqual([]);
  h.api.cardSeen({ n: 1, seen: true, inView: true, diagnostic: "PRIVATE unused" });
  expect(h.sample(2).reported).toBe(7); expect(h.sent).toEqual([{ channel: "commands-renderer:seen", value: { n: 1, seen: true, inView: true } }]);
});
it.each([0, 1, 2, 3, 4, 5])("independent geometry uses the actual production slack, viewport/visibility and clipping predicate (%i)", async variant => {
  const h = preloadHarness(); await h.api.pull();
  if (variant === 1) h.rect.bottom = 282;
  if (variant === 2) h.document.visibilityState = "hidden";
  if (variant === 3) h.block.clientHeight = 0;
  if (variant === 4) h.block.scrollWidth = 672;
  if (variant === 5) h.rect.left = 10;
  const actual = judgeMetrics({ ...h.rect, scrollTop: h.block.scrollTop, scrollHeight: h.block.scrollHeight, clientHeight: h.block.clientHeight, scrollWidth: h.block.scrollWidth, clientWidth: h.block.clientWidth,
    viewWidth: 760, viewHeight: 480, visible: h.document.visibilityState === "visible", clip: { top: 12, bottom: 280, left: 12, right: 748 } });
  const flags = h.sample(1).geometry; expect(!!(flags & 1)).toBe(actual.fits); expect(!!(flags & 2)).toBe(actual.atEnd); expect(!!(flags & 4)).toBe(actual.onScreen);
});

async function mainHarness(change: "none" | "asset" | "manifest" | "sandbox" | "load-event" | "load-error" = "none", loadOrder = "after") {
  const staged = stageHarness(), result = await staged.build(), profile = path.join(staged.root, "profile"); fs.mkdirSync(profile);
  if (change === "asset") fs.appendFileSync(path.join(result.app, "renderer/shared/ember.css"), "PRIVATE");
  if (change === "manifest") { const file = path.join(result.app, "fixture-data.json"), value = JSON.parse(fs.readFileSync(file, "utf8")); value.files[0].path = "../PRIVATE"; fs.writeFileSync(file, JSON.stringify(value)); }
  const handlers = new Map<string, (...args: any[]) => unknown>(), ipc = Object.assign(new EventEmitter(), { handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) });
  let completion = Promise.resolve();
  const app = Object.assign(new EventEmitter(), { setPath() {}, whenReady: () => ({ then(fn: () => Promise<void>) { completion = Promise.resolve().then(fn); return completion; } }), getAppMetrics: () => [{ pid: 41, sandboxed: change !== "sandbox" }], quit: () => { calls.push(["quit"]); } });
  const calls: any[][] = [], timers: { ms: number; run(): void }[] = [], output: string[] = [], stages: string[] = [];
  const nonce = "b".repeat(64), control = Object.assign(new EventEmitter(), { write(value: string, done?: () => void) { calls.push(["control-write", value]); done?.(); }, end(value: string, done?: () => void) { calls.push(["control-end", value]); done?.(); }, destroy() {} });
  const pageUrl = pathToFileURL(path.join(result.app, "renderer/command/index.html")).href;
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: pageUrl }, getOSProcessId: () => 41,
    send: (channel: string, value: unknown) => calls.push(["send", channel, structuredClone(value)]), setWindowOpenHandler() {}, setZoomFactor() {},
    session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } } });
  let options: any;
  class Window {
    webContents = contents;
    constructor(value: unknown) { options = value; app.emit("web-contents-created", {}, contents); }
    isDestroyed() { return false; } async loadFile() {
      calls.push(["load-start"]); await Promise.resolve();
      if (change === "load-event") { contents.emit("did-fail-load", {}, -3, "PRIVATE description", "file:///PRIVATE", false); contents.emit("did-fail-load", {}, -6, "PRIVATE description", "file:///PRIVATE", true); contents.emit("did-fail-load", {}, -10, "PRIVATE", "PRIVATE", true); }
      if (change === "load-event" || change === "load-error") throw Object.assign(new Error("PRIVATE URL message"), { errno: -10, code: "ERR_ACCESS_DENIED" });
      calls.push(["load-settled"]);
    } setTitle() { calls.push(["title"]); } setContentProtection() {}
    setAlwaysOnTop(...args: unknown[]) { calls.push(["top", ...args]); } showInactive() { calls.push(["showInactive"]); } moveTop() { calls.push(["moveTop"]); } hide() { calls.push(["hide"]); }
  }
  const process = { pid: 41, env: { EMBER_COMMANDS_RENDERER_PROFILE: profile, EMBER_COMMANDS_RENDERER_NATIVE_TEST: "1", EMBER_COMMANDS_RENDERER_LOAD_ORDER: loadOrder, EMBER_COMMANDS_RENDERER_CONTROL: "\\\\.\\pipe\\ember-native-commands-" + "a".repeat(32), EMBER_COMMANDS_RENDERER_NONCE: nonce }, platform: "win32", stdout: { write: (value: string) => { output.push(value); calls.push(["stdout", value]); } }, stderr: { write: (value: string) => stages.push(value) }, exitCode: 0 };
  runInNewContext(main, { require: (name: string) => name === "electron" ? { app, BrowserWindow: Window, ipcMain: ipc, Menu: { setApplicationMenu() {} }, nativeTheme: { shouldUseDarkColors: false } }
    : name === "node:fs" ? fs : name === "node:path" ? path : name === "node:url" ? { pathToFileURL } : name === "node:util" ? { types } : name === "node:net" ? { connect() { queueMicrotask(() => { control.emit("connect"); control.emit("data", Buffer.from("OK " + nonce + "\n")); }); return control; } } : { createHash }, __dirname: result.app, process, Buffer, Uint8Array,
    setTimeout: (run: () => void, ms: number) => { const timer = { run, ms }; timers.push(timer); return timer; }, clearTimeout() {} });
  await completion.catch(() => undefined);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { ipc, handlers, event, calls, timers, output, stages, process, options, control, nonce, request: (n: number) => control.emit("data", Buffer.from("SAMPLE " + nonce + " " + n + "\n")), ready: () => { ipc.emit("commands-renderer:ready", event, 1); ipc.emit("commands-renderer:seen", event, { n: 1, seen: true, inView: true }); } };
}
it.each(["after", "before"] as const)("shows the same sandboxed first window once, %s load settles", async order => {
  const h = await mainHarness("none", order);
  expect(h.output).toEqual([]);
  expect(h.calls.filter(call => ["load-start", "load-settled", "title", "top", "showInactive", "moveTop"].includes(call[0]))).toEqual([
    ["load-start"],
    ...(order === "before" ? [["top", true, "floating"], ["showInactive"], ["moveTop"]] : []),
    ["load-settled"], ["title"],
    ...(order === "after" ? [["top", true, "floating"], ["showInactive"], ["moveTop"]] : []),
  ]);
  h.ready();
  expect(h.output).toEqual([COMMANDS_RENDERER_READY_PREFIX + "1\n"]);
});
it("refuses unknown load order before navigation or display", async () => {
  const h = await mainHarness("none", "PRIVATE");
  expect(h.output).toEqual([COMMANDS_RENDERER_LOAD_PREFIX + "7:4\n" + COMMANDS_RENDERER_READY_PREFIX + "0\n"]);
  expect(h.calls.some(call => call[0] === "showInactive" || call[0] === "load-start")).toBe(false);
  expect(h.output.join("")).not.toContain("PRIVATE");
});
it("the actual main fixture preserves hide/show, flush-before-ended, retained tab and fresh-card ordering without activation", async () => {
  const h = await mainHarness(); h.ready(); expect(h.output).toEqual([COMMANDS_RENDERER_READY_PREFIX + "1\n"]);
  expect(h.stages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(stage => "EMBER_COMMANDS_RENDERER_STARTUP_V1:" + stage + "\n"));
  expect(h.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false });
  expect(h.options.darkTheme).toBe(false); expect(main).not.toContain("nativeTheme.themeSource =");
  h.ipc.emit("commands-renderer:answer", h.event, { n: 1, answer: "once", sha256: "a".repeat(64) });
  for (const timer of [...h.timers].sort((a, b) => a.ms - b.ms)) timer.run();
  const sent = h.calls.filter(call => call[0] === "send"), output = sent.filter(call => call[1] === "commands-renderer:output"); expect(output).toHaveLength(3);
  expect(output.map(call => call[2].at)).toEqual([0, 9, 18]);
  const states = sent.filter(call => call[1] === "commands-renderer:state").map(call => call[2]);
  expect(states.map(state => state.card?.n ?? 0)).toEqual([0, 0, 0, 0, 2]); expect(states.at(-1).tabs[0].ended).toBe(true); expect(states.every(state => state.pending.length === 0)).toBe(true);
  expect(h.calls.findIndex(call => call[0] === "hide")).toBeGreaterThan(h.calls.findIndex(call => call[0] === "top" && call[1] === false));
  expect(h.calls.findIndex(call => call[0] === "hide")).toBeLessThan(h.calls.findIndex(call => call[1] === "commands-renderer:output"));
  const ended = h.calls.findIndex(call => call[1] === "commands-renderer:state" && call[2].tabs[0]?.ended); expect(h.calls.lastIndexOf(output[2])).toBeLessThan(ended);
  expect(main).not.toMatch(/\.focus\(|\.activate\(|executeJavaScript|openDevTools|--no-sandbox/);
  h.ipc.emit("commands-renderer:seen", h.event, { n: 2, seen: true, inView: true }); h.request(1);
  h.ipc.emit("commands-renderer:sampled", h.event, { ...sample, assets: 4, lifecycle: 128 });
  const value = JSON.parse(h.output[1].slice(COMMANDS_RENDERER_SAMPLE_PREFIX.length)); expect(parseCommandsRendererSample(value)).toEqual(sample);
  expect(h.calls.findIndex(call => call[0] === "control-write" && call[1] === "SAMPLED " + h.nonce + " 41 1\n")).toBeGreaterThan(h.calls.findIndex(call => call[0] === "stdout" && call[1].startsWith(COMMANDS_RENDERER_SAMPLE_PREFIX)));
});
it.each(["disconnect", "duplicate-auth", "wrong-nonce"])("the actual CJS refuses %s control without altering approval state or issuing a sample", async kind => {
  const h = await mainHarness(); h.ready();
  if (kind === "disconnect") h.control.emit("end");
  else h.control.emit("data", Buffer.from(kind === "duplicate-auth" ? "OK " + h.nonce + "\n" : "SAMPLE " + "0".repeat(64) + " 1\n"));
  expect(h.process.exitCode).toBe(1); expect(h.calls.some(call => call[1] === "commands-renderer:sample")).toBe(false);
});
it("the actual CJS acknowledges one authenticated quit and stops its lifecycle timers without using GUI stdin", async () => {
  const h = await mainHarness(); h.ready(); h.control.emit("data", Buffer.from("QUIT " + h.nonce + "\n"));
  expect(h.calls).toContainEqual(["control-end", "BYE " + h.nonce + " 41\n"]); expect(h.calls.filter(call => call[0] === "quit")).toHaveLength(1);
  expect(h.process.exitCode).toBe(0); expect(main).not.toContain("process.stdin");
});
it.each(["unknown", "pending", "wrong-sender", "extra-field"])("the actual fixture refuses %s authority instead of emitting a plausible sample", async condition => {
  const h = await mainHarness(); h.ready();
  if (condition === "unknown") h.control.emit("data", Buffer.from("execute\n"));
  if (condition === "pending") { h.request(1); h.request(1); }
  if (condition === "wrong-sender") h.ipc.emit("commands-renderer:answer", { ...h.event, sender: {} }, { n: 1, answer: "once", sha256: "a".repeat(64) });
  if (condition === "extra-field") { h.request(1); h.ipc.emit("commands-renderer:sampled", h.event, { ...sample, assets: 4, lifecycle: 128, private: "PRIVATE" }); }
  expect(h.process.exitCode).toBe(1); expect(h.output).toHaveLength(1); expect(h.output.join("")).not.toContain("PRIVATE");
});
it.each(["asset", "manifest", "sandbox"] as const)("the actual fixture refuses %s uncertainty before reporting ready", async change => {
  const h = await mainHarness(change); if (change === "sandbox") h.ready();
  expect(h.output).toEqual([COMMANDS_RENDERER_LOAD_PREFIX + (change === "sandbox" ? "0:0" : "7:4") + "\n" + COMMANDS_RENDERER_READY_PREFIX + "0\n"]); expect(h.process.exitCode).toBe(1); expect(h.output.join("")).not.toContain("PRIVATE");
});
it("allows at most sixteen serialized samples and rejects a seventeenth without output", async () => {
  const h = await mainHarness(); h.ready();
  for (let sequence = 1; sequence <= 16; sequence++) { h.request(sequence); h.ipc.emit("commands-renderer:sampled", h.event, { ...sample, sequence, assets: 4, lifecycle: 128 }); }
  expect(h.output).toHaveLength(17); h.request(17); expect(h.output).toHaveLength(17); expect(h.process.exitCode).toBe(1);
});
it.each(["load-event", "load-error"] as const)("the actual %s observation is first-only, main-frame-only, private and before READY0 in the same write", async change => {
  const h = await mainHarness(change); expect(h.output).toEqual([COMMANDS_RENDERER_LOAD_PREFIX + (change === "load-event" ? "2" : "3") + ":4\n" + COMMANDS_RENDERER_READY_PREFIX + "0\n"]);
  expect(h.output.join("") + h.stages.join("")).not.toContain("PRIVATE"); expect(h.process.exitCode).toBe(1);
});
it("classifies only genuine native Error own-data or finite negative numeric facts without reading private fields/traps", () => {
  const start = main.indexOf("function classifyLoadCode("), end = main.indexOf("\nfunction noteLoad", start), module = { exports: undefined as unknown as (value: unknown) => number };
  runInNewContext(main.slice(start, end) + "\nmodule.exports=classifyLoadCode;", { module, types });
  for (const [value, expected] of [[-3, 1], [-6, 2], [-10, 3], [-300, 4], [-2, 5], [-999, 6], [0, 7], [Infinity, 7], [1.5, 7]] as const) expect(module.exports(value)).toBe(expected);
  expect(module.exports(Object.assign(new Error(), { errno: -6, code: "ERR_FILE_NOT_FOUND" }))).toBe(2);
  expect(module.exports(Object.assign(new Error(), { errno: -6, code: "ERR_ACCESS_DENIED" }))).toBe(7);
  expect(module.exports({ errno: -6, code: "ERR_FILE_NOT_FOUND" })).toBe(7);
  let traps = 0; const trap = () => { traps++; throw new Error("PRIVATE"); }, error = new Error();
  Object.defineProperties(error, { errno: { get: trap }, message: { get: trap }, url: { get: trap }, stack: { get: trap } });
  expect(module.exports(error)).toBe(7); expect(module.exports(new Proxy(error, { get: trap, getOwnPropertyDescriptor: trap }))).toBe(7); expect(traps).toBe(0);
});
