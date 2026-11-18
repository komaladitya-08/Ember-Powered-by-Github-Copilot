/** Owned synthetic Electron Commands renderer only; fixed lifecycle, bounded numeric stdout, no production authority. */
/* eslint-disable @typescript-eslint/no-require-imports -- A directly launched test-only CommonJS Electron bench. */
const { app, BrowserWindow, ipcMain, Menu, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { types } = require("node:util");
const net = require("node:net");
const prefix = "commands-renderer:", readyPrefix = "EMBER_COMMANDS_RENDERER_READY_V1:", samplePrefix = "EMBER_COMMANDS_RENDERER_SAMPLE_V1:", loadPrefix = "EMBER_COMMANDS_RENDERER_LOAD_V1:";
let window, leaving = false, readyWritten = false, loaded = false, rendererReady = false, assetsVerified = false, lifecycle = 0, sequence = 0, pendingSample = 0;
let loadRecorded = false, loadCode = 0, firstQuit = 0;
let control, controlAuthenticated = false, controlBroken = false, controlQuitting = false;
// Shared focus diagnostic enum: 0 unobserved; 1 aborted; 2 missing; 3 denied; 4 invalid URL; 5 failed; 6 other negative; 7 unknown/conflict.
// Net error categories only. Never inspect a message, URL, description or stack.
function classifyLoadCode(value) {
  const numeric = value => {
    if (!Number.isSafeInteger(value) || value >= 0) return 7;
    return value === -3 ? 1 : value === -6 ? 2 : value === -10 ? 3 : value === -300 ? 4 : value === -2 ? 5 : 6;
  };
  if (typeof value === "number") return numeric(value);
  try {
    if (!value || typeof value !== "object" || types.isProxy(value) || !types.isNativeError(value)) return 7;
    const errno = Object.getOwnPropertyDescriptor(value, "errno"), code = Object.getOwnPropertyDescriptor(value, "code");
    if (errno && !Object.hasOwn(errno, "value") || code && !Object.hasOwn(code, "value")) return 7;
    const fromNumber = errno?.value === undefined ? 0 : numeric(errno.value);
    const fromName = code?.value === undefined ? 0 : typeof code.value !== "string" ? 7 : code.value === "ERR_ABORTED" ? 1 :
      code.value === "ERR_FILE_NOT_FOUND" ? 2 : code.value === "ERR_ACCESS_DENIED" ? 3 : code.value === "ERR_INVALID_URL" ? 4 : code.value === "ERR_FAILED" ? 5 : 0;
    return fromNumber === 7 || fromName === 7 || fromNumber && fromName && fromNumber !== fromName ? 7 : fromNumber || fromName || 7;
  } catch { return 7; }
}
function noteLoad(value) { try { if (!loadRecorded) { loadRecorded = true; loadCode = classifyLoadCode(value); } } catch { /* Passive only. */ } }
/** First observed existing quit caller: 1 stdin end; 2 typed quit; 3 all windows closed; 4 an existing catch. */
function noteQuit(value) { if (!firstQuit) firstQuit = value; }
const timers = new Set();
// Fixed boundary only; a later marker is neither a causal diagnosis nor a successful earlier condition.
const mark = stage => { try { process.stderr.write("EMBER_COMMANDS_RENDERER_STARTUP_V1:" + stage + "\n"); } catch { /* Passive only. */ } };
function refuse(error, fromCatch = false) {
  controlBroken = true; control?.destroy();
  if (fromCatch === true) { if (!loadRecorded) noteLoad(error); noteQuit(4); }
  if (!readyWritten) { readyWritten = true; process.stdout.write(loadPrefix + loadCode + ":" + firstQuit + "\n" + readyPrefix + "0\n"); }
  process.exitCode = 1; leaving = true; for (const timer of timers) clearTimeout(timer); app.quit();
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const ordinary = file => { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(); return stat; };
/** Validate every staged file before loading any renderer or preload. No manifest path can leave this owned package. */
function fixture() {
  const dataPath = path.join(__dirname, "fixture-data.json"); if (ordinary(dataPath).size > 256 * 1024) throw new Error();
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  if (!exact(data, ["schema", "rendererSources", "files", "tap"]) || data.schema !== 1 || ![8, 9].includes(data.rendererSources) || !Array.isArray(data.files) || data.files.length < 9 || data.files.length > 128 || !exact(data.tap, ["bytes", "sha256", "base64"])) throw new Error();
  const expected = new Map(); let total = 0;
  for (const entry of data.files) {
    if (!exact(entry, ["path", "bytes", "sha256"]) || typeof entry.path !== "string" || entry.path.length > 200 ||
      !/^(?:package\.json|main\.cjs|preload\.cjs|renderer\/(?:command|shared|fonts)\/[A-Za-z0-9_./-]+)$/.test(entry.path) || entry.path.split("/").some(part => part === "." || part === ".." || !part) || expected.has(entry.path) ||
      !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 4 * 1024 * 1024 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error();
    total += entry.bytes; expected.set(entry.path, entry);
  }
  if (total > 8 * 1024 * 1024) throw new Error();
  const actual = [];
  function visit(folder, relative = "") {
    const stat = fs.lstatSync(folder); if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(folder) !== folder) throw new Error();
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name), rel = relative ? relative + "/" + name : name, info = fs.lstatSync(file);
      if (info.isDirectory() && !info.isSymbolicLink()) visit(file, rel);
      else {
        ordinary(file); if (rel === "fixture-data.json") continue;
        const entry = expected.get(rel); if (!entry || info.size !== entry.bytes || hash(fs.readFileSync(file)) !== entry.sha256) throw new Error();
        actual.push(rel); if (actual.length > 128) throw new Error();
      }
    }
  }
  visit(__dirname);
  for (const required of ["package.json", "main.cjs", "preload.cjs", "renderer/command/index.html", "renderer/command/main.js", "renderer/command/main.js.map", "renderer/command/styles.css", "renderer/command/xterm.css", "renderer/shared/ember.css", "renderer/fonts/InterVariable.woff2"]) if (!expected.has(required)) throw new Error();
  if (actual.length !== expected.size || !Number.isInteger(data.tap.bytes) || data.tap.bytes < 1 || data.tap.bytes > 65536 || typeof data.tap.base64 !== "string" || data.tap.base64.length > 90000) throw new Error();
  const tap = Buffer.from(data.tap.base64, "base64");
  if (tap.toString("base64") !== data.tap.base64 || tap.length !== data.tap.bytes || hash(tap) !== data.tap.sha256 || Buffer.from(tap.toString("utf8")).compare(tap) !== 0 || !tap.includes(Buffer.from("ERR_ASSERTION"))) throw new Error();
  assetsVerified = true; return tap;
}
const argv = ["--preserve-symlinks", "--preserve-symlinks-main", "--experimental-test-isolation=none", "--test", "test.cjs"];
const card = Object.freeze({ n: 1, runId: "0123456789abcdef", target: "local", targetLabel: "This computer", kind: "node", argv, cwd: "\\work", command: "Node arguments: " + JSON.stringify(argv), sha256: "a".repeat(64),
  taskId: "fixed-task", taskTitle: "Repair the copied sum assertion and rerun its identical bundled Node check", mode: "ask", says: ["Ember is running as an administrator here, so each command asks first.", "You asked Ember to check every command with you.", "Why: Verify the explicitly requested copied Windows Node fixture"], unasked: false, classes: ["system"], armMs: 1500 });
let state = { rev: 1, tabs: [], pending: [], card, announce: null, keyHint: "Win+Alt+Y allow · Win+Alt+N not now", os: "win32" };
const pageUrl = pathToFileURL(path.join(__dirname, "renderer/command/index.html")).href;
function owns(event) { return !leaving && !!window && !window.isDestroyed() && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === pageUrl; }
function send(name, value) { if (leaving || !window || window.isDestroyed()) return; window.webContents.send(prefix + name, value); }
function push(update) { state = { ...state, ...update, rev: state.rev + 1 }; send("state", state); }
function after(ms, action) { const timer = setTimeout(() => { timers.delete(timer); if (!leaving) { try { action(); } catch (error) { refuse(error, true); } } }, ms); timers.add(timer); }
function ready() {
  if (leaving || readyWritten || !loaded || !rendererReady || !(lifecycle & 1) || !controlAuthenticated || controlBroken) return;
  mark(8);
  const sandboxed = app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true;
  if (!assetsVerified || !sandboxed) { refuse(); return; }
  readyWritten = true; mark(9); process.stdout.write(readyPrefix + "1\n");
}
const loadOrder = process.env.EMBER_COMMANDS_RENDERER_LOAD_ORDER;
let tap;
try {
  mark(1);
  const profile = process.env.EMBER_COMMANDS_RENDERER_PROFILE;
  if (process.env.EMBER_COMMANDS_RENDERER_NATIVE_TEST !== "1" || process.platform !== "win32" || !profile || !path.isAbsolute(profile) || fs.realpathSync.native(profile) !== profile || !fs.lstatSync(profile).isDirectory() || fs.lstatSync(profile).isSymbolicLink() || fs.readdirSync(profile).length) throw new Error();
  if (loadOrder !== "after" && loadOrder !== "before") throw new Error();
  app.setPath("userData", profile); mark(2); tap = fixture(); mark(3);
} catch (error) { refuse(error, true); }

ipcMain.handle(prefix + "pull", event => { if (!owns(event)) { refuse(); return null; } return { state, replay: [] }; });
ipcMain.on(prefix + "fault", event => { if (owns(event)) refuse(); });
ipcMain.on(prefix + "ready", (event, value) => { if (!owns(event) || value !== 1 || rendererReady) { refuse(); return; } mark(7); rendererReady = true; ready(); });
ipcMain.on(prefix + "seen", (event, value) => {
  if (!owns(event) || !exact(value, ["n", "seen", "inView"]) || ![1, 2].includes(value.n) || typeof value.seen !== "boolean" || typeof value.inView !== "boolean" || (value.inView && !value.seen)) { refuse(); return; }
  if (state.card?.n === value.n) lifecycle |= value.n === 1 ? 1 : 64;
  ready();
});
ipcMain.on(prefix + "answer", (event, value) => {
  if (!owns(event) || !exact(value, ["n", "answer", "sha256"]) || value.n !== 1 || state.card?.n !== 1 || value.answer !== "once" || value.sha256 !== card.sha256 || (lifecycle & 2)) { refuse(); return; }
  lifecycle |= 2;
  const tab = { runId: card.runId, seq: 1, title: card.taskTitle, command: card.command, header: "On this computer · Node · in \\work", status: "Running…", interactive: false, ended: false, outcome: "running", typing: "", cols: 90, rows: 12 };
  const split = Math.floor(tap.length / 3);
  // Actual hideCard -> settle hides the empty command window before the first run attaches.
  after(0, () => { push({ card: null, keyHint: null }); window.setAlwaysOnTop(false); window.hide(); });
  after(10, () => { lifecycle |= 4; window.showInactive(); window.moveTop(); push({ tabs: [tab] }); });
  for (const [index, start, end] of [[0, 0, split], [1, split, split * 2], [2, split * 2, tap.length]]) after([20, 35, 40][index], () => {
    send("output", { runId: card.runId, seq: 1, at: start, bytes: Uint8Array.from(tap.subarray(start, end)) }); if (index === 2) lifecycle |= 8;
  });
  after(50, () => { lifecycle |= 16; push({ tabs: [{ ...tab, status: "Ended with exit code 1 after 0.1\u00a0s.", ended: true, outcome: "failed" }] }); });
  // The actual isolated Node runner has no onStatus callback; it supplies no pending text.
  after(70, () => { lifecycle |= 32; push({ pending: [] }); });
  after(110, () => { window.setAlwaysOnTop(true, "floating"); window.moveTop(); push({ card: { ...card, n: 2, runId: "fedcba9876543210" }, keyHint: "Win+Alt+Y allow · Win+Alt+N not now" }); });
});
ipcMain.on(prefix + "sampled", (event, value) => {
  const keys = ["schema", "sequence", "card", "dom", "geometry", "reported", "arm", "assets", "lifecycle"];
  const max = { schema: 1, sequence: 16, card: 2, dom: 31, geometry: 255, reported: 7, arm: 2, assets: 4, lifecycle: 128 };
  if (!owns(event) || !exact(value, keys) || value.schema !== 1 || value.sequence !== pendingSample || !pendingSample || keys.some(key => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > max[key]) || (value.assets !== 0 && value.assets !== 4) || (value.lifecycle !== 0 && value.lifecycle !== 128)) { refuse(); return; }
  pendingSample = 0;
  if (((value.dom & 4) && (!(value.dom & 2) || (value.dom & 16))) || ((value.dom & 16) && !(value.dom & 2)) || ((value.reported & 6) && !(value.reported & 1)) || ((value.reported & 4) && !(value.reported & 2))) { refuse(); return; }
  process.stdout.write(samplePrefix + JSON.stringify({ ...value, assets: value.assets | 3, lifecycle: value.lifecycle | lifecycle }) + "\n");
  control.write("SAMPLED " + nonce + " " + process.pid + " " + value.sequence + "\n", error => { if (error) refuse(); });
});
const address = process.env.EMBER_COMMANDS_RENDERER_CONTROL, nonce = process.env.EMBER_COMMANDS_RENDERER_NONCE;
if (typeof address !== "string" || !/^\\\\\.\\pipe\\ember-native-commands-[a-f0-9]{32}$/.test(address) || typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) refuse();
let input = "", inputBytes = 0, controlResolve, controlReject;
const controlled = new Promise((resolve, reject) => { controlResolve = resolve; controlReject = reject; });
void controlled.catch(() => undefined);
function controlRefuse() { if (controlBroken) return; noteQuit(1); controlReject(new Error("Synthetic control refused.")); refuse(); }
if (!leaving) {
control = net.connect(address);
control.on("error", controlRefuse);
control.on("end", () => { if (input || !controlQuitting) controlRefuse(); });
control.on("close", hadError => { if (hadError || !controlQuitting) controlRefuse(); });
control.once("connect", () => control.write("HELLO " + nonce + " " + process.pid + "\n", error => { if (error) controlRefuse(); }));
control.on("data", chunk => {
  if (controlBroken) return;
  inputBytes += chunk.length;
  if (inputBytes > 2048 || !Buffer.isBuffer(chunk) || [...chunk].some(byte => byte !== 10 && (byte < 32 || byte > 126))) { controlRefuse(); return; }
  input += chunk.toString("ascii");
  let end;
  while ((end = input.indexOf("\n")) >= 0) {
    const command = input.slice(0, end); input = input.slice(end + 1);
    if (command.length > 128) { controlRefuse(); return; }
    if (!controlAuthenticated && command === "OK " + nonce) { controlAuthenticated = true; controlResolve(); }
    else if (controlAuthenticated && command === "QUIT " + nonce && !pendingSample && !controlQuitting) {
      controlQuitting = true; noteQuit(2); leaving = true; for (const timer of timers) clearTimeout(timer);
      control.end("BYE " + nonce + " " + process.pid + "\n", () => app.quit());
    } else {
      const match = new RegExp("^SAMPLE " + nonce + " ([1-9]|1[0-6])$").exec(command);
      if (!controlAuthenticated || !match || Number(match[1]) !== sequence + 1 || !readyWritten || leaving || pendingSample || sequence >= 16) { controlRefuse(); return; }
      pendingSample = ++sequence; send("sample", pendingSample);
    }
  }
  if (input.length > 128 || controlQuitting && input) controlRefuse();
});
}
app.on("window-all-closed", () => { noteQuit(3); app.quit(); });
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", event => { event.preventDefault(); refuse(); });
  contents.on("will-redirect", event => { event.preventDefault(); refuse(); });
});
if (!leaving) void app.whenReady().then(async () => {
  await controlled;
  mark(4);
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({ title: "Ember commands renderer bench", width: 760, height: 480, show: false, backgroundColor: "#121011", darkTheme: nativeTheme.shouldUseDarkColors, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false } });
  mark(5);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(pathToFileURL(__dirname + path.sep).href) }));
  window.webContents.on("render-process-gone", refuse); window.webContents.on("unresponsive", refuse); window.webContents.on("preload-error", refuse);
  window.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame === true) noteLoad(code); });
  window.webContents.setZoomFactor(1); window.setContentProtection(true);
  const reveal = () => { window.setAlwaysOnTop(true, "floating"); window.showInactive(); window.moveTop(); };
  mark(6); const loading = window.loadFile(path.join(__dirname, "renderer/command/index.html"));
  if (loadOrder === "before") reveal();
  await loading; loaded = true;
  window.setTitle("Ember commands renderer bench"); // Navigation may have replaced the constructor title.
  if (loadOrder === "after") reveal();
  ready();
}).catch(error => refuse(error, true));
