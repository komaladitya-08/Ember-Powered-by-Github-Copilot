/**
 * A crash of Ember's main process is noticed at the next start (rp-5), in the built app (dist/app; `npm run build`
 * first) on a real X server (Xvfb): main crashes (process.crash), and the next start logs app.previous_run_ended and
 * Home says Ember closed unexpectedly; a normal quit leaves no marker, and the start after it says nothing. Skipped
 * without Xvfb, off Linux, or without a build, except with EMBER_ATSPI_TEST=1 (RHEL 8 CI, which builds first): there a
 * missing one fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSENT_VERSION } from "../../app/shared/consent";
import { RUN_FILE } from "../../app/main/run-marker";

const requireCjs = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const built = fs.existsSync(path.join(root, "dist", "app", "main.cjs"));
const xvfb = process.platform === "linux" && spawnSync("sh", ["-c", "command -v Xvfb"], { stdio: "ignore" }).status === 0;
/** CI's RHEL 8 job: Xvfb and the build must be there (a skip would hide that this was never checked). */
const required = process.env.EMBER_ATSPI_TEST === "1" && process.platform === "linux";

type Page = { url(): string; locator(s: string): { isVisible(): Promise<boolean>; innerText(): Promise<string>; waitFor(o: object): Promise<void> } };
type ElectronApp = {
  evaluate<T>(fn: (electron: typeof Electron) => T): Promise<T>;
  windows(): Page[];
  process(): ChildProcess;
  close(): Promise<void>;
};

describe.skipIf(!required && (!xvfb || !built))("a crash of Ember's main process, at the next start (rp-5)", () => {
  let server: ChildProcess;
  let display = "";
  let userData = "";
  let app: ElectronApp | undefined;
  const log = () => { try { return fs.readFileSync(path.join(userData, "logs", "ember.log"), "utf8"); } catch { return ""; } };
  const marker = () => path.join(userData, RUN_FILE);

  async function launch(): Promise<Page> {
    const { _electron } = requireCjs("playwright-core") as { _electron: { launch(o: object): Promise<ElectronApp> } };
    app = await _electron.launch({
      executablePath: requireCjs("electron") as unknown as string,
      args: [root, "--show-settings", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
      env: { ...process.env, DISPLAY: display, EMBER_USER_DATA: userData },
      timeout: 60_000,
    });
    let home: Page | undefined;
    for (let t = 0; t < 300 && !home; t++) {
      home = app.windows().find(w => w.url().includes("/renderer/home/index.html"));
      if (!home) await new Promise(r => setTimeout(r, 100));
    }
    if (!home) throw new Error("Home didn't open");
    await home.locator("#about-note").waitFor({ state: "attached", timeout: 30_000 });
    // Home has had its status (the version is written from it).
    for (let t = 0; t < 100 && !(await home.locator("#about-note").innerText().catch(() => "")); t++) await new Promise(r => setTimeout(r, 100));
    return home;
  }
  const exited = () => new Promise<void>(done => { const p = app!.process(); if (p.exitCode !== null || p.signalCode !== null) done(); else p.once("exit", () => done()); });

  beforeAll(async () => {
    if (!xvfb || !built) throw new Error(`can't be checked here: ${!xvfb ? "no Xvfb" : "no build (npm run build first)"}`);
    server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    display = ":" + await new Promise<string>((resolve, reject) => {
      server.stdio[3]!.on("data", (d: Buffer) => resolve(d.toString().trim()));
      server.on("exit", () => reject(new Error("Xvfb didn't start")));
    });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "ember-run-marker-"));
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, onboarded: true, consent: { version: CONSENT_VERSION, at: new Date().toISOString() }, wakeWord: false }));
  }, 30_000);
  afterAll(async () => {
    await app?.close().catch(() => { /* already gone */ });
    server?.kill();
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
  });

  it("logs that the last run ended unexpectedly and says so in Home, and says nothing after a quit", async () => {
    // A first run, then main crashes: the marker stays.
    let home = await launch();
    expect(fs.existsSync(marker())).toBe(true);
    expect(await home.locator("#run-notice").isVisible()).toBe(false);
    const gone = exited();
    await app!.evaluate(() => { process.crash(); }).catch(() => { /* the process went with the call */ });
    await gone;
    expect(log()).not.toContain("app.previous_run_ended");
    expect(fs.existsSync(marker())).toBe(true);

    // The next start finds it.
    home = await launch();
    expect(log()).toContain("app.previous_run_ended");
    expect(await home.locator("#run-notice").isVisible()).toBe(true);
    expect(await home.locator("#run-notice").innerText()).toMatch(/^Ember closed unexpectedly last time\. Its log shows what it was doing until then: .*ember\.log$/);

    // A normal quit removes this run's marker and says so in the log.
    const quit = exited();
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
    await quit;
    expect(fs.existsSync(marker())).toBe(false);
    expect(log()).toMatch(/app\.quit/);

    // And the start after it says nothing.
    const before = log().split("app.previous_run_ended").length;
    home = await launch();
    expect(await home.locator("#run-notice").isVisible()).toBe(false);
    expect(log().split("app.previous_run_ended").length).toBe(before);
  }, 180_000);
});
