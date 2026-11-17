/** Fixed synthetic Electron controls only; no inspector, preload, agent, credentials, network or production app. */
/* eslint-disable @typescript-eslint/no-require-imports -- Fixed CommonJS Electron bench entry runs directly without an application build. */
const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("node:path");
const readline = require("node:readline");

const profile = process.env.EMBER_UIA_FOCUS_PROFILE;
if (!profile || !path.isAbsolute(profile)) process.exit(1);
app.setPath("userData", profile);
let windows = [];
readline.createInterface({ input: process.stdin }).on("line", line => { if (line === "quit") app.quit(); }).on("close", () => app.quit());
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const area = screen.getPrimaryDisplay().workArea;
  windows = [0, 1].map(index => new BrowserWindow({ title: "Ember native focus " + (index ? "B" : "A"),
    x: area.x + (index ? Math.max(20, area.width - 780) : 20), y: area.y + 20, width: 760, height: 480, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false } }));
  await Promise.all(windows.map(window => window.loadFile(path.join(__dirname, "index.html"))));
  for (const [index, window] of windows.entries()) { window.setTitle("Ember native focus " + (index ? "B" : "A")); window.show(); }
  const metrics = app.getAppMetrics();
  const sandboxed = windows.every(window => metrics.find(metric => metric.pid === window.webContents.getOSProcessId())?.sandboxed === true);
  process.stdout.write("EMBER_UIA_FOCUS_READY_V1:" + (sandboxed ? "1" : "0") + "\n");
}).catch(() => { process.stdout.write("EMBER_UIA_FOCUS_READY_V1:0\n"); app.quit(); });
