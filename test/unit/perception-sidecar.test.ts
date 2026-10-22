import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AtspiSidecar, boundedLines, ID_BLOCK, MAX_LINE_BYTES } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";

/**
 * A stand-in sidecar (run by node instead of Python): one request at a time,
 * like the real one, so a stuck call holds up everything behind it.
 */
const FAKE = `
const readline = require("node:readline");
let stuck = false;
let remembered = [];
let withheld = [];
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  const ok = result => send({ jsonrpc: "2.0", id: req.id, result });
  if (stuck) return;
  switch (req.method) {
    case "whoami": return ok({ pid: process.pid, base: process.env.EMBER_ATSPI_ID_BASE, enc: process.env.PYTHONIOENCODING });
    case "status":
      if (process.env.EMBER_FAKE_STATUS_LOG) require("node:fs").appendFileSync(process.env.EMBER_FAKE_STATUS_LOG, process.pid + "\\n");
      return ok({ version: 3, python: "fake", toolkitAccessibility: null, apps: 0 });
    case "hang": stuck = true; return;
    case "flood": process.stdout.write("x".repeat(9 * 1024 * 1024)); return;
    case "slow": return setTimeout(() => ok("slow"), req.params.ms);
    case "die": return process.kill(process.pid, "SIGTERM");
    case "noise":
      process.stdout.write("Gtk-Message: a library printing to stdout\\n");
      process.stdout.write('{"jsonrpc": "2.0", "id": 999999, "result": NaN}\\n');
      return ok("after noise");
    case "fail": return send({ jsonrpc: "2.0", id: req.id, error: { message: "no such element" } });
    case "remember_secrets": remembered = req.params.keys; withheld = req.params.withheld || []; return ok({ count: remembered.length });
    case "remembered": return ok(remembered);
    case "withheld": return ok(withheld);
    case "read_window": return ok({ window: null, nodes: [], ms: 1, secretKeys: [[":1.42", "/org/a11y/atspi/accessible/" + req.params.n]], withheldKeys: [[":1.42", "/row/" + req.params.n]] });
    case "mark_secret": return ok({ keys: req.params.ids.map(id => [":1.7", "/x/" + id]), withheldKeys: req.params.ids.map(id => [":1.7", "/cell/" + id]) });
    case "at_point": return ok({ chain: [], ms: 1, withheldKeys: [[":1.9", "/p"]] });
    case "read_element": return ok({ role: "push button", name: "Save", states: [], bounds: { x: 10, y: 20, width: 30, height: 40 } });
    case "do_action": {
      const info = { role: "push button", name: "Save", states: [], bounds: { x: 10, y: 20, width: 30, height: 40 } };
      return ok({ ok: true, action: "click", before: info, after: info });
    }
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
function sidecar(script = fake, python = process.execPath, env: NodeJS.ProcessEnv = process.env) {
  const { log, lines } = logger();
  const s = new AtspiSidecar(script, log, python, env);
  running.push(s);
  return { s, lines };
}
afterEach(() => { for (const s of running.splice(0)) s.stop(); });

type Who = { pid: number; base: string; enc: string };
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e.message);

describe("boundedLines", () => {
  const lines = (max: number) => {
    const input = new PassThrough();
    const got: string[] = [];
    let tooLong = 0;
    boundedLines(input, max, l => got.push(l), () => { tooLong++; });
    return { input, got, tooLong: () => tooLong };
  };

  it("splits as readline does: LF and CR LF, characters split across chunks, the last line at the end", async () => {
    const r = lines(1024);
    const euro = Buffer.from("€");
    r.input.write(Buffer.concat([Buffer.from("{\"a\":1}\r\nprice "), euro.subarray(0, 1)]));
    r.input.write(Buffer.concat([euro.subarray(1), Buffer.from("\n\nlast")]));
    r.input.end();
    await new Promise(res => r.input.once("end", res));
    expect(r.got).toEqual(["{\"a\":1}", "price €", "", "last"]);
    expect(r.tooLong()).toBe(0);
  });

  it("never holds more than max bytes of a line: one past it is dropped up to its newline, and reading goes on", async () => {
    const r = lines(10);
    r.input.write("0123456789");
    r.input.write("abc");
    r.input.write("def\nok\n");
    r.input.write("x".repeat(11));
    r.input.write("\n");
    r.input.end("tail-too-long");
    await new Promise(res => r.input.once("end", res));
    expect(r.got).toEqual(["ok"]);
    expect(r.tooLong()).toBe(3);
    expect(MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("AtspiSidecar", () => {
  it("ends a helper that sends an endless line and starts a fresh one (a hostile distro's helper can't fill memory)", async () => {
    const { s, lines } = sidecar();
    const first = await s.request<Who>("whoami");
    expect(await failure(s.request("flood", {}, 10_000))).toMatch(/restarted/);
    expect(lines.some(l => l.msg === "sidecar.line_too_long")).toBe(true);
    const next = await s.request<Who>("whoami");
    expect(next.pid).not.toBe(first.pid);
  });

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
    // Nor is it started again on its own, over and over: one try per request.
    await new Promise(r => setTimeout(r, 300));
    expect(lines.filter(l => l.msg === "sidecar.error")).toHaveLength(2);
    expect(lines.some(l => l.msg === "sidecar.revive")).toBe(false);
  });

  it("keeps a helper connected: one that worked is started again at once, not at the next request (review round 7)", async () => {
    // LibreOffice aborts when a client that read it leaves, a document opens with no client connected, and a new one
    // lists the desktop: a helper killed for taking too long, or crashed, is replaced and connects right away.
    const log = path.join(dir, `status-${Date.now()}.log`);
    const { s } = sidecar(fake, process.execPath, { ...process.env, EMBER_FAKE_STATUS_LOG: log });
    const asked = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(Number) : []);
    const waitAsked = async (n: number) => { for (let i = 0; i < 50 && asked().length < n; i++) await new Promise(r => setTimeout(r, 40)); return asked(); };
    const first = await s.request<Who>("whoami");
    expect(await failure(s.request("hang", {}, 100))).toMatch(/did not answer/);
    const [revived] = await waitAsked(1);
    expect(revived).toBeGreaterThan(0);
    expect(revived).not.toBe(first.pid);
    // The next request goes to it.
    expect((await s.request<Who>("whoami")).pid).toBe(revived);
    // After a crash too.
    expect(await failure(s.request("die"))).toMatch(/stopped/);
    expect((await waitAsked(2))[1]).not.toBe(revived);
    // Not after stop().
    s.stop();
    await new Promise(r => setTimeout(r, 200));
    expect(asked()).toHaveLength(2);
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

  it("gives HiDPI elements' bounds in physical pixels, once Perception has said so", async () => {
    const { s } = sidecar();
    s.scaleElements([5], 2);
    expect((await s.readElement(5)).bounds).toEqual({ x: 20, y: 40, width: 60, height: 80 });
    expect((await s.readElement(6)).bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    const r = await s.doAction(5);
    expect([r.before?.bounds, r.after?.bounds]).toEqual([{ x: 20, y: 40, width: 60, height: 80 }, { x: 20, y: 40, width: 60, height: 80 }]);
  });

  it("keeps a read's HiDPI scale however many quick looks come after it, as the helper keeps its ids (HND7-1)", async () => {
    const { s } = sidecar();
    s.scaleElements([5], 2);
    // Quick looks (keep: false, a key's or a wheel notch's): each replaces the one before, in the helper and here.
    for (let i = 0; i < 40; i++) {
      await s.readWindow({ n: 1, keep: false } as never);
      s.scaleElements([100 + i], 2, false);
    }
    expect((await s.readElement(5)).bounds).toEqual({ x: 20, y: 40, width: 60, height: 80 });
    expect(s.scaleOf(5)).toBe(2);
    expect([s.scaleOf(139), s.scaleOf(138)]).toEqual([2, 1]);
    // Kept reads still push out the oldest kept ones.
    for (let i = 0; i < 16; i++) s.scaleElements([200 + i], 2);
    expect(s.scaleOf(5)).toBe(1);
  });

  it("hands the secret fields earlier helpers knew to every new one, before anything else", async () => {
    const { s } = sidecar();
    expect(await s.request("remembered")).toEqual([]);
    const r = await s.readWindow({ n: 5 } as never);
    expect(r).not.toHaveProperty("secretKeys");
    expect(r).not.toHaveProperty("withheldKeys");
    await s.markSecret([9]);
    await s.markSecret([]);
    expect(await s.atPoint({ pid: 1, path: "/w", x: 1, y: 1 })).toEqual({ chain: [], ms: 1 });
    expect(await failure(s.request("die"))).toMatch(/stopped/);
    expect(await s.request("remembered")).toEqual([[":1.42", "/org/a11y/atspi/accessible/5"], [":1.7", "/x/9"]]);
    // And the elements whose names say what a secret field holds (a table's cell named after the card number in it).
    expect(await s.request("withheld")).toEqual([[":1.42", "/row/5"], [":1.7", "/cell/9"], [":1.9", "/p"]]);
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
