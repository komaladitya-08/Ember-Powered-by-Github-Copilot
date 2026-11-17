/** Fixed synthetic Electron controls only; no inspector, preload, agent, credentials, network or production app. */
/* eslint-disable @typescript-eslint/no-require-imports -- Fixed CommonJS Electron bench entry runs directly without an application build. */
const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("node:path");
const readline = require("node:readline");
const { types } = require("node:util");

let loadRecorded = false, loadCode = 0, firstQuit = 0;
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
function noteQuit(value) { if (!firstQuit) firstQuit = value; }

// Fixed bench boundaries only; stderr is already privately consumed by the owning test.
function startup(stage) { try { process.stderr.write("EMBER_UIA_FOCUS_STARTUP_V1:" + stage + "\n"); } catch { /* Observation cannot change startup. */ } }
startup(1);

const profile = process.env.EMBER_UIA_FOCUS_PROFILE;
if (!profile || !path.isAbsolute(profile)) process.exit(1);
app.setPath("userData", profile);
startup(2);
let windows = [];
readline.createInterface({ input: process.stdin }).on("line", line => { if (line === "quit") { noteQuit(2); app.quit(); } }).on("close", () => { noteQuit(1); app.quit(); });
app.on("window-all-closed", () => { noteQuit(3); app.quit(); });
app.whenReady().then(async () => {
  startup(3);
  Menu.setApplicationMenu(null);
  startup(4);
  const area = screen.getPrimaryDisplay().workArea;
  startup(5);
  windows = [0, 1].map(index => new BrowserWindow({ title: "Ember native focus " + (index ? "B" : "A"),
    x: area.x + (index ? Math.max(20, area.width - 780) : 20), y: area.y + 20, width: 760, height: 480, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false } }));
  startup(6);
  for (const window of windows) window.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame === true) noteLoad(code); });
  await Promise.all(windows.map(window => window.loadFile(path.join(__dirname, "index.html"))));
  startup(7);
  for (const [index, window] of windows.entries()) { window.setTitle("Ember native focus " + (index ? "B" : "A")); window.show(); }
  startup(8);
  const metrics = app.getAppMetrics();
  const sandboxed = windows.every(window => metrics.find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true);
  startup(9);
  process.stdout.write("EMBER_UIA_FOCUS_READY_V1:" + (sandboxed ? "1" : "0") + "\n");
}).catch(error => { if (!loadRecorded) noteLoad(error); noteQuit(4); process.stdout.write("EMBER_UIA_FOCUS_LOAD_V1:" + loadCode + ":" + firstQuit + "\nEMBER_UIA_FOCUS_READY_V1:0\n"); app.quit(); });
