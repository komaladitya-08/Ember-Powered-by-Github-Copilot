// Records M9: the installed Ember (from the RPM, /opt/ember) on first run: consent, pick a
// character, start; then "Start Ember when I log in" from the settings window, and the
// autostart entry it writes.
// usage (after installing the RPM): DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m9-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "dist/demo");
mkdirSync(out, { recursive: true });
const display = process.env.DISPLAY ?? ":55";
const env = { ...process.env, DISPLAY: display };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => execFileSync("xdotool", a, { env }).toString();
const shot = name => execFileSync("import", ["-window", "root", path.join(out, `${name}.png`)], { env });
const installed = process.env.EMBER_INSTALLED ?? "/opt/ember/ember";
if (!existsSync(installed)) throw new Error(`install the RPM first (${installed} is missing)`);

const userData = mkdtempSync(path.join(tmpdir(), "ember-m9-"));
const xdgConfig = mkdtempSync(path.join(tmpdir(), "ember-m9-xdg-"));
const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m9-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
xdo("mousemove", "640", "700");

const app = await electron.launch({
  executablePath: installed,
  args: ["--ozone-platform=x11", "--show-settings"],
  env: { ...env, EMBER_USER_DATA: userData, XDG_CONFIG_HOME: xdgConfig, EMBER_TEST_HOOKS: "1" },
});
const page = name => app.windows().find(w => w.url().includes(`/renderer/${name}/`));
const bounds = name => app.evaluate(({ BrowserWindow }, n) => BrowserWindow.getAllWindows().find(b => b.webContents.getURL().includes(`/renderer/${n}/`))?.getContentBounds() ?? null, name);
const clickIn = async (name, selector) => {
  for (let i = 0; i < 60; i++) {
    const b = await bounds(name);
    const r = await page(name)?.evaluate(sel => {
      const el = document.querySelector(sel);
      el?.scrollIntoView({ block: "center" });
      const rect = el?.getBoundingClientRect();
      return rect && rect.width ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
    }, selector).catch(() => null);
    if (b && r) {
      xdo("mousemove", String(Math.round(b.x + r.x)), String(Math.round(b.y + r.y)));
      await sleep(700);
      xdo("click", "1");
      return true;
    }
    await sleep(150);
  }
  throw new Error(`no ${selector} in ${name}`);
};
try {
  await sleep(4000);
  shot("03-installed-first-run");
  await clickIn("home", ".card[data-id=\"wisp\"]");
  await sleep(800);
  await clickIn("home", "#agree");
  await sleep(500);
  await clickIn("home", "#start");
  await sleep(3500);
  shot("04-hello");
  xdo("key", "ctrl+alt+e");
  await sleep(2000);
  await clickIn("home", "#login");
  await sleep(1500);
  shot("05-start-at-login");
  await sleep(1000);
} finally {
  await app.close();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
const entry = path.join(xdgConfig, "autostart", "ember.desktop");
console.log(existsSync(entry) ? `autostart entry:\n${readFileSync(entry, "utf8")}` : "no autostart entry written");
console.log(`wrote ${out}`);
