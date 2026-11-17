/** Fixed synthetic Electron controls only; no inspector, preload, agent, credentials, network or production app. */
/* eslint-disable @typescript-eslint/no-require-imports -- Fixed CommonJS Electron bench entry runs directly without an application build. */
const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("node:path");
const readline = require("node:readline");

// Fixed bench boundaries only; stderr is already privately consumed by the owning test.
function startup(stage) { try { process.stderr.write("EMBER_UIA_FOCUS_STARTUP_V1:" + stage + "\n"); } catch { /* Observation cannot change startup. */ } }
startup(1);

const profile = process.env.EMBER_UIA_FOCUS_PROFILE;
if (!profile || !path.isAbsolute(profile)) process.exit(1);
app.setPath("userData", profile);
startup(2);
let windows = [];
readline.createInterface({ input: process.stdin }).on("line", line => { if (line === "quit") app.quit(); }).on("close", () => app.quit());
app.on("window-all-closed", () => app.quit());
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
  await Promise.all(windows.map(window => window.loadFile(path.join(__dirname, "index.html"))));
  startup(7);
  for (const [index, window] of windows.entries()) { window.setTitle("Ember native focus " + (index ? "B" : "A")); window.show(); }
  startup(8);
  const metrics = app.getAppMetrics();
  const sandboxed = windows.every(window => metrics.find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true);
  startup(9);
  process.stdout.write("EMBER_UIA_FOCUS_READY_V1:" + (sandboxed ? "1" : "0") + "\n");
}).catch(() => { process.stdout.write("EMBER_UIA_FOCUS_READY_V1:0\n"); app.quit(); });
