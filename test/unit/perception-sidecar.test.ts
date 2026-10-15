import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtspiSidecar, ID_BLOCK } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";

/**
 * A stand-in sidecar (run by node instead of Python): one request at a time,
 * like the real one, so a stuck call holds up everything behind it.
 */
const FAKE = `
const readline = require("node:readline");
let stuck = false;
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  const ok = result => send({ jsonrpc: "2.0", id: req.id, result });
  if (stuck) return;
  switch (req.method) {
    case "whoami": return ok({ pid: process.pid, base: process.env.EMBER_ATSPI_ID_BASE, enc: process.env.PYTHONIOENCODING });
    case "hang": stuck = true; return;
    case "slow": return setTimeout(() => ok("slow"), req.params.ms);
    case "die": return process.kill(process.pid, "SIGTERM");
    case "noise":
      process.stdout.write("Gtk-Message: a library printing to stdout\\n");
      process.stdout.write('{"jsonrpc": "2.0", "id": 999999, "result": NaN}\\n');
      return ok("after noise");
    case "fail": return send({ jsonrpc: "2.0", id: req.id, error: { message: "no such element" } });
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sidecar-test-"));
const fake = path.join(dir, "fake_sidecar.cjs");
fs.writeFileSync(fake, FAKE);
const dead = path.join(dir, "dead_sidecar.cjs");
fs.writeFileSync(dead, "process.exit(3);\n");

function logger() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => { lines.push({ level, msg, fields }); };
  const log = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log } as unknown as Logger;
  return { log, lines };
}

const running: AtspiSidecar[] = [];
function sidecar(script = fake, python = process.execPath) {
  const { log, lines } = logger();
  const s = new AtspiSidecar(script, log, python);
  running.push(s);
  return { s, lines };
}
afterEach(() => { for (const s of running.splice(0)) s.stop(); });

type Who = { pid: number; base: string; enc: string };
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e.message);

describe("AtspiSidecar", () => {
  it("starts a new helper after one is killed by a signal", async () => {
    const { s } = sidecar();
    const first = await s.request<Who>("whoami");
    expect(await failure(s.request("die"))).toMatch(/stopped/);
    const second = await s.request<Who>("whoami");
    expect(second.pid).not.toBe(first.pid);
  });

  it("restarts a helper that doesn't answer in time, failing what was queued behind it at once", async () => {
    const { s, lines } = sidecar();
    const first = await s.request<Who>("whoami");
    const t0 = Date.now();
    const stuck = failure(s.request("hang", {}, 200));
    const queued = failure(s.request("whoami", {}, 5000));
    expect(await stuck).toMatch(/did not answer hang in 200 ms/);
    expect(await queued).toMatch(/restarted/);
    expect(Date.now() - t0).toBeLessThan(2000);
    const next = await s.request<Who>("whoami");
    expect(next.pid).not.toBe(first.pid);
    expect(lines.some(l => l.msg === "sidecar.timeout")).toBe(true);
  });

  it("doesn't fail a new helper's requests when the old one's exit arrives late", async () => {
    const { s } = sidecar();
    expect(await failure(s.request("hang", {}, 100))).toMatch(/did not answer/);
    // The old helper is being killed; its exit lands while this request waits on the new one.
    await expect(s.request("slow", { ms: 300 })).resolves.toBe("slow");
  });

  it("fails at once, not after a timeout, when the helper can't start", async () => {
    const { s, lines } = sidecar(fake, "/nonexistent/ember-python");
    const t0 = Date.now();
    expect(await failure(s.request("whoami", {}, 5000))).toMatch(/could not run|stopped/);
    expect(await failure(s.request("whoami", {}, 5000))).toMatch(/could not run|stopped/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(lines.some(l => l.msg === "sidecar.error")).toBe(true);
  });

  it("survives writing to a helper that died at once (EPIPE)", async () => {
    const { s } = sidecar(dead);
    const a = failure(s.request("whoami", {}, 5000));
    const until = Date.now() + 300;
    while (Date.now() < until) { /* busy, like a capture on the main thread: the helper is gone by the next write */ }
    const b = failure(s.request("whoami", {}, 5000));
    expect(await a).toMatch(/stopped/);
    expect(await b).toMatch(/stopped/);
  });

  it("logs lines that aren't protocol, and keeps going", async () => {
    const { s, lines } = sidecar();
    await expect(s.request("noise")).resolves.toBe("after noise");
    const bad = lines.filter(l => l.msg === "sidecar.bad_line");
    expect(bad).toHaveLength(2);
    expect(bad[0].fields?.start).toContain("Gtk-Message");
    // An answer that isn't JSON may carry screen text: only its size is logged.
    expect(bad[1].fields?.start).toBeUndefined();
    await expect(s.request("fail")).rejects.toThrow("no such element");
  });

  it("runs Python with UTF-8 stdio and gives every helper its own id range", async () => {
    const a = sidecar().s, b = sidecar().s;
    const [wa, wb] = [await a.request<Who>("whoami"), await b.request<Who>("whoami")];
    expect(wa.enc).toBe("utf-8");
    const bases = [Number(wa.base), Number(wb.base)];
    expect(bases[0]).not.toBe(bases[1]);
    for (const base of bases) {
      expect(base % ID_BLOCK).toBe(0);
      expect(base).toBeGreaterThan(0);
    }
    // A restarted helper gets a new range too.
    await failure(a.request("die"));
    expect(Number((await a.request<Who>("whoami")).base)).not.toBe(bases[0]);
  });
});
