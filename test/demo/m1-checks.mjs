// Checks two M1 behaviours on a running X display and saves screenshots:
//  - without a compositor, Ember shows the opaque handle card instead of an overlay
//  - with a compositor, bubble buttons are clickable while the rest stays click-through
// usage: DISPLAY=:N node test/demo/m1-checks.mjs <out-dir> fallback|interactive
import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const [out, mode] = [path.resolve(process.argv[2] ?? "dist/demo"), process.argv[3] ?? "interactive"];
mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => execFileSync("xdotool", a, { env: process.env }).toString();
const userData = mkdtempSync(path.join(tmpdir(), "ember-check-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "cinder", size: 60, speak: false, wakeWord: true, onboarded: true }));

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [root, "--no-sandbox"],
  env: { ...process.env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_LOG_STDOUT: "1" },
});
const logs = { some: pred => readFileSync(path.join(userData, "logs", "ember.log"), "utf8").split("\n").some(pred) };
let ok = true;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); ok &&= cond; };
try {
  await sleep(3500);
  const urls = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getURL().split("/").slice(-2)[0]));
  if (mode === "fallback") {
    check(!urls.includes("overlay"), "no overlay window without a compositor");
    check(urls.includes("handle"), "handle card is shown");
    check(logs.some(l => l.includes("overlay.fallback")), "fallback is logged");
    execFileSync("import", ["-window", "root", path.join(out, "fallback-handle-card.png")], { env: process.env });
    // M4: questions can be answered on the card too.
    await app.evaluate(() => {
      globalThis.__answer = globalThis.__ember.confirmer().ask({ title: "May I?", prompt: "Click “Save” push button in Text Editor?", options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] });
    });
    await sleep(800);
    const btn = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(b => b.webContents.getURL().includes("/renderer/handle/"));
      const r = await w.webContents.executeJavaScript(`(() => { const b = document.querySelector("#actions button.primary"); const r = b && b.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      const c = w.getContentBounds();
      return r ? { x: Math.round(c.x + r.x), y: Math.round(c.y + r.y) } : null;
    });
    check(!!btn, "the card shows the question's buttons");
    execFileSync("import", ["-window", "root", path.join(out, "fallback-question.png")], { env: process.env });
    if (btn) {
      xdo("mousemove", String(btn.x), String(btn.y));
      await sleep(300);
      xdo("click", "1");
      await sleep(500);
      check(await app.evaluate(() => globalThis.__answer) === "once", "clicking Allow on the card answers the question");
    }
  } else {
    xdo("mousemove", "500", "400");
    await sleep(800);
    await app.evaluate((_e) => globalThis.__ember.setState({
      emotion: "worried", talking: false, status: null,
      bubble: { visible: true, mood: "attention", title: "Delete 3 duplicates?", thought: "They're identical copies; deleting moves them to Trash.", step: null, streaming: false,
        actions: [{ id: "approve", label: "Delete", primary: true }, { id: "deny", label: "Not now" }] },
    }));
    await sleep(1200);
    const overlay = app.windows().find(w => w.url().includes("/overlay/"));
    const box = await overlay.locator(".eb-actions button").first().boundingBox();
    // Overlay windows sit at the display origin, so page coordinates are screen coordinates.
    xdo("mousemove", String(Math.round(box.x + box.width / 2)), String(Math.round(box.y + box.height / 2)));
    await sleep(300);
    if (process.env.EMBER_CHECK_DEBUG) console.log("box", box, "cursor", await app.evaluate(({ screen }) => screen.getCursorScreenPoint()), xdo("getmouselocation"));
    execFileSync("import", ["-window", "root", path.join(out, "bubble-actions.png")], { env: process.env });
    xdo("click", "1");
    await sleep(600);
    check(logs.some(l => l.includes("bubble.action") && l.includes("approve")), "clicking a bubble button reaches Ember");
  }
} finally {
  await app.close();
}
process.exit(ok ? 0 : 1);
