/**
 * Reads the GTK3 test bench through the real AT-SPI sidecar. Needs an X11
 * display with an accessibility bus, and a Python with pyatspi; skipped
 * otherwise (set EMBER_ATSPI_TEST=1 to require it). Run on the demo desktop:
 *   DISPLAY=:55 scripts/demo/as-demo-user.sh env EMBER_ATSPI_TEST=1 EMBER_PYTHON=/usr/bin/python3.12 npm run test:integration -- perception
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { AtspiSidecar, pickPython } from "../../app/main/perception/sidecar";
import { inferLabels, serializeElements } from "../../app/main/perception/elements";
import { openX11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const python = pickPython();
const available = !!process.env.DISPLAY && spawnSync(python, ["-c", "import pyatspi, gi"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe.skipIf(!available && !required)("AT-SPI sidecar on a real GTK window", () => {
  let bench: ChildProcess;
  let sidecar: AtspiSidecar;
  const events: Record<string, unknown>[] = [];

  beforeAll(async () => {
    bench = spawn(python, [path.resolve("test/fixtures/gtk3_bench.py")], { stdio: ["ignore", "pipe", "inherit"] });
    readline.createInterface({ input: bench.stdout! }).on("line", l => { try { events.push(JSON.parse(l)); } catch { /* not json */ } });
    sidecar = new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python);
    // Wait for the window to show up on the accessibility bus.
    for (let i = 0; i < 50; i++) {
      const r = await sidecar.readWindow({ title: "Ember Test Bench" }).catch(() => null);
      if (r?.window && r.nodes.length > 5) return;
      await new Promise(res => setTimeout(res, 200));
    }
    throw new Error("the test bench never appeared on the accessibility bus");
  }, 20_000);

  afterAll(() => {
    sidecar?.stop();
    bench?.kill();
  });

  it("answers status", async () => {
    const s = await sidecar.status();
    expect(s.apps).toBeGreaterThan(0);
  });

  it("reads the window's controls in under 300 ms", async () => {
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    expect(r.window?.name).toBe("Ember Test Bench");
    expect(r.ms).toBeLessThan(300);
    const roles = r.nodes.map(n => `${n.role}:${n.name}`);
    expect(roles).toContain("push button:Save");
    // The hidden button is not on screen, so it is not reported.
    expect(r.nodes.some(n => n.name === "Secret hidden button")).toBe(false);
  });

  it("gives the unnamed switch its label and never reads the password", async () => {
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    const labels = inferLabels(r.nodes);
    const sw = r.nodes.find(n => labels.get(n.id) === "Night Light");
    expect(sw, serializeElements(r.window!, r.nodes)).toBeDefined();
    const pw = r.nodes.find(n => n.role === "password text");
    expect(pw).toBeDefined();
    expect(pw!.text).toBeUndefined();
  });

  it("says which option the combo box shows (review round 7)", async () => {
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    expect(r.nodes.find(n => n.role === "combo box" && n.name === "Theme")?.selected).toBe("Light");
  });

  it("finds the same window through X11 by pid", async () => {
    const x11 = openX11();
    if (!x11) return;
    try {
      const r = await sidecar.readWindow({ pid: bench.pid! });
      expect(r.window?.pid).toBe(bench.pid);
    } finally {
      x11.close();
    }
  });
});
