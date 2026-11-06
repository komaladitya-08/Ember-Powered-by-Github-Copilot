import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SIDECAR_PROTOCOL_VERSION } from "../../app/shared/sidecar-protocol";
import { AtspiSidecar, SidecarVersionError, type SidecarLaunch, type UtilityChild } from "../../app/main/perception/sidecar";
import { VERSION as HOST_VERSION } from "../../app/sidecar-host/protocol";
import { helperStatusOfError } from "../../app/main/platform/compose";
import type { Logger } from "../../app/main/logger";

/**
 * A stand-in sidecar run by node. EMBER_FAKE_PING says what its `ping` does ("ok", a version as JSON, "missing", "error",
 * "silent", "exit"); every line it is written is appended to EMBER_FAKE_LOG as "<pid> <method>", so the order of
 * writes (and that nothing else was written) can be read back.
 */
const FAKE = `
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.EMBER_FAKE_PING || "ok";
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  fs.appendFileSync(process.env.EMBER_FAKE_LOG, process.pid + " " + req.method + "\\n");
  const ok = result => send({ jsonrpc: "2.0", id: req.id, result });
  if (req.method === "ping") {
    if (mode === "silent") return;
    if (mode === "exit") return process.exit(0);
    if (mode === "error") return send({ jsonrpc: "2.0", id: req.id, error: { message: "unknown method ping" } });
    if (mode === "missing") return ok({});
    if (mode === "noresult") return send({ jsonrpc: "2.0", id: req.id });
    if (mode === "ok") return ok({ version: ${SIDECAR_PROTOCOL_VERSION} });
    return ok({ version: JSON.parse(mode) });
  }
  switch (req.method) {
    case "whoami": return ok({ pid: process.pid });
    case "read_window": return ok({ window: null, nodes: [], ms: 1, secretKeys: [[":1.42", "/a"]] });
    case "die": return process.kill(process.pid, "SIGTERM");
  }
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-handshake-test-"));
const fake = path.join(dir, "fake_sidecar.cjs");
fs.writeFileSync(fake, FAKE);
let n = 0;

const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => { lines.push({ level, msg, fields }); };
const log = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log } as unknown as Logger;

const running: AtspiSidecar[] = [];
/** A sidecar over the fake whose ping behaves as `ping` says; `written()` is what the fake was sent, in order. */
function sidecar(ping: string, launch?: Partial<SidecarLaunch>) {
  const logFile = path.join(dir, `log-${++n}`);
  fs.writeFileSync(logFile, "");
  const env = { ...process.env, EMBER_FAKE_PING: ping, EMBER_FAKE_LOG: logFile };
  const s = new AtspiSidecar(fake, log, process.execPath, env, launch ? { command: process.execPath, args: [fake], env, ...launch } : undefined);
  running.push(s);
  const written = () => fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(l => l.split(" ")[1]);
  return { s, written, setPing: (p: string) => { env.EMBER_FAKE_PING = p; } };
}
afterEach(() => {
  vi.useRealTimers();
  for (const s of running.splice(0)) s.stop();
  lines.length = 0;
});
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e);
const settle = () => new Promise(r => setTimeout(r, 100));

describe("the protocol version Ember expects of its accessibility helper", () => {
  it("is one number: the Python sidecar's, the host's and the client's agree (BE-3)", () => {
    const py = fs.readFileSync(path.join(__dirname, "../../sidecar/atspi/ember_atspi.py"), "utf8");
    expect(/^VERSION = (\d+)$/m.exec(py)?.[1]).toBe(String(SIDECAR_PROTOCOL_VERSION));
    expect(HOST_VERSION).toBe(SIDECAR_PROTOCOL_VERSION);
  });
});

describe("AtspiSidecar's handshake (BE-3: nothing is processed before the version is validated)", () => {
  it("sends ping first, and only then what was waiting, the remembered secret fields before it", async () => {
    const { s, written } = sidecar("ok");
    await s.readWindow({});
    expect(written()).toEqual(["ping", "read_window"]);
    // A new process is told the secret fields only after its ping passed, and before the request that waited.
    expect(await failure(s.request("die"))).toBeInstanceOf(Error);
    const [a, b] = await Promise.all([s.request<{ pid: number }>("whoami"), s.request<{ pid: number }>("whoami")]);
    expect(a.pid).toBe(b.pid);
    expect(written().slice(2)).toEqual(["die", "ping", "remember_secrets", "whoami", "whoami"]);
  });

  it.each([
    ["an older version", "2"],
    ["version 0", "0"],
    ["a newer version", "4"],
    ["a string", '"3"'],
    ["null", "null"],
    ["a fraction", "3.5"],
    ["no version", "missing"],
    ["no result", "noresult"],
    ["an error answer (a helper that doesn't know ping)", "error"],
  ])("refuses a helper that answers ping with %s: held requests fail at once with the refusal, nothing else is written, it is ended and never started again", async (_name, ping) => {
    const { s, written } = sidecar(ping);
    const [a, b] = await Promise.all([failure(s.request("whoami")), failure(s.readWindow({}))]);
    for (const e of [a, b]) {
      expect(e).toBeInstanceOf(SidecarVersionError);
      expect((e as Error).message).toMatch(/Ember's accessibility helper is out of date or not matching this Ember \(it speaks protocol .+; Ember needs 3\)\. Reinstall or update Ember\.$/);
    }
    expect(a).toBe(b);
    await settle();
    expect(written()).toEqual(["ping"]);
    expect(lines.filter(l => l.msg === "sidecar.version_mismatch")).toHaveLength(1);
    expect(lines.find(l => l.msg === "sidecar.version_mismatch")?.fields).toMatchObject({ expected: 3 });
    // Later requests fail at once with the same refusal, spawning nothing, and no revive starts one.
    expect(await failure(s.request("whoami"))).toBe(a);
    expect(await failure(s.status())).toBe(a);
    expect(s.pid).toBeNull();
    await settle();
    expect(written()).toEqual(["ping"]);
    expect(lines.some(l => l.msg === "sidecar.revive")).toBe(false);
  });

  it("names what it got, never more than 20 characters of it, and nothing of the helper's path", async () => {
    const { s } = sidecar(JSON.stringify("x".repeat(60)));
    const e = await failure(s.request("whoami")) as Error;
    expect(e.message).toContain(`protocol "${"x".repeat(20)}";`);
    expect(e.message).not.toContain(fake);
    expect(e.message).not.toContain(dir);
  });

  it("says, for a helper on another computer, that Ember will need to update it there", async () => {
    const { s } = sidecar("2", { where: "Ubuntu", firstRequestMs: 3000 });
    const e = await failure(s.request("whoami")) as SidecarVersionError;
    expect(e.message).toBe("Ember's accessibility helper in Ubuntu is out of date or not matching this Ember (it speaks protocol 2; Ember needs 3). Ember will need to reinstall or update the helper there: update Ember, then reopen your Linux apps.");
  });

  it("gives the setup check one plain sentence for the refusal, and nothing for another failure", async () => {
    const { s } = sidecar("2");
    const e = await failure(s.status());
    expect(helperStatusOfError(e)).toEqual({ toolkitAccessibility: false, detail: "it is out of date or not matching this Ember (it speaks protocol 2; Ember needs 3). Reinstall or update Ember." });
    expect(helperStatusOfError(new Error("no answer"))).toBeNull();
  });

  it("starts a new client's helper afresh: only a new AtspiSidecar tries again after a refusal", async () => {
    const first = sidecar("2");
    expect(await failure(first.s.request("whoami"))).toBeInstanceOf(SidecarVersionError);
    const second = sidecar("ok");
    expect((await second.s.request<{ pid: number }>("whoami")).pid).toBeGreaterThan(0);
  });

  it("treats a ping that is never answered like a first request that is never answered: the helper is ended, held requests fail, and the next request starts a new one", async () => {
    const { s, written, setPing } = sidecar("silent");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked = failure(s.request("whoami", {}, 60_000));
    vi.advanceTimersByTime(5000);
    expect(((await asked) as Error).message).toBe("accessibility helper did not answer ping in 5000 ms");
    vi.useRealTimers();
    await settle();
    // (Ended at once: it may not have read the ping yet.) Nothing but the ping was ever written.
    expect(written().every(m => m === "ping")).toBe(true);
    expect(lines.some(l => l.msg === "sidecar.version_mismatch" || l.msg === "sidecar.revive")).toBe(false);
    setPing("ok");
    expect((await s.request<{ pid: number }>("whoami")).pid).toBeGreaterThan(0);
  });

  it("gives the ping a cold start's time where the launch allows it", async () => {
    const { s } = sidecar("silent", { firstRequestMs: 12_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked = failure(s.request("whoami", {}, 60_000));
    vi.advanceTimersByTime(11_999);
    expect(lines.some(l => l.msg === "sidecar.timeout")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(((await asked) as Error).message).toBe("accessibility helper did not answer ping in 12000 ms");
  });

  it("fails what waits when the helper exits before answering ping, without a refusal or a restart loop", async () => {
    const { s, written } = sidecar("exit");
    const e = await failure(s.request("whoami")) as Error;
    expect(e).not.toBeInstanceOf(SidecarVersionError);
    expect(e.message).toBe("accessibility helper stopped");
    await settle();
    expect(written()).toEqual(["ping"]);
    expect(lines.some(l => l.msg === "sidecar.revive")).toBe(false);
  });
});

/** A helper Ember hands requests to as messages (a utility process), driven by hand: the test says what it writes and when. */
function manual() {
  const children: FakeChild[] = [];
  class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly pid = 1000 + children.length;
    readonly posted: string[] = [];
    killed = false;
    postMessage(m: string) { this.posted.push(m); }
    kill() { this.killed = true; setImmediate(() => this.emit("exit", 0)); return true; }
    /** What it was sent so far: [method, id]. */
    sent(): [string, number][] { return this.posted.map(l => { const m = JSON.parse(l) as { method: string; id: number }; return [m.method, m.id]; }); }
    methods(): string[] { return this.sent().map(([m]) => m); }
    idOf(method: string): number { return this.sent().find(([m]) => m === method)![1]; }
    /** Writes these lines in one chunk, then lets the client read them. */
    async write(...msgs: unknown[]): Promise<void> {
      this.stdout.write(msgs.map(m => JSON.stringify(m) + "\n").join(""));
      await new Promise(r => setImmediate(r));
    }
    async pong(version: unknown = SIDECAR_PROTOCOL_VERSION) { await this.write({ jsonrpc: "2.0", id: this.idOf("ping"), result: { version } }); }
  }
  const launch: SidecarLaunch = {
    command: "unused", args: ["unused.js"], env: {}, noRevive: true,
    utility: { serviceName: "test", fork: () => { const c = new FakeChild(); children.push(c); return c as unknown as UtilityChild; } },
  };
  const s = new AtspiSidecar("unused", log, "unused", {}, launch);
  running.push(s);
  return { s, children };
}

describe("AtspiSidecar's handshake against a helper that keeps talking (PR #187 review)", () => {
  it("writes nothing more once a helper was refused, even when a valid ping answer is buffered behind the refusal", async () => {
    const { s, children } = manual();
    // A first helper that works teaches the client a secret field and a withheld cell.
    const first = s.readWindow({});
    await children[0].pong();
    await children[0].write({ jsonrpc: "2.0", id: children[0].idOf("read_window"), result: { window: null, nodes: [], ms: 1, secretKeys: [[":1.42", "/a"]], withheldKeys: [[":1.42", "/b"]] } });
    await first;
    children[0].emit("exit", 1);
    // The next one answers version 2 and, in the same chunk, version 3 for the same id.
    const asked = failure(s.request("whoami"));
    const second = children[1];
    const pingId = second.idOf("ping");
    await second.write({ jsonrpc: "2.0", id: pingId, result: { version: 2 } }, { jsonrpc: "2.0", id: pingId, result: { version: SIDECAR_PROTOCOL_VERSION } });
    await second.write({ jsonrpc: "2.0", id: pingId, result: { version: SIDECAR_PROTOCOL_VERSION } });
    expect(await asked).toBeInstanceOf(SidecarVersionError);
    expect(second.methods()).toEqual(["ping"]);
    expect(second.killed).toBe(true);
    expect(await failure(s.request("whoami"))).toBeInstanceOf(SidecarVersionError);
    expect(children).toHaveLength(2);
  });

  it("ignores a replaced helper's late ping answer: it doesn't mark a healthy replacement incompatible", async () => {
    const { s, children } = manual();
    const lost = failure(s.request("whoami"));
    const old = children[0];
    const oldPing = old.idOf("ping");
    old.emit("exit", 1); // it died before answering ping
    expect(((await lost) as Error).message).toBe("accessibility helper stopped");
    const ok = s.request<{ n: number }>("whoami");
    const fresh = children[1];
    await fresh.pong();
    // The old one's buffered output arrives now: an old version, for its own ping.
    await old.write({ jsonrpc: "2.0", id: oldPing, result: { version: 2 } });
    await fresh.write({ jsonrpc: "2.0", id: fresh.idOf("whoami"), result: { n: 7 } });
    expect(await ok).toEqual({ n: 7 });
    expect(fresh.killed).toBe(false);
    expect(lines.some(l => l.msg === "sidecar.version_mismatch")).toBe(false);
    const again = s.request<{ n: number }>("whoami");
    await fresh.write({ jsonrpc: "2.0", id: fresh.sent().filter(([m]) => m === "whoami")[1][1], result: { n: 8 } });
    expect(await again).toEqual({ n: 8 });
    expect(children).toHaveLength(2);
  });

  it("does not let an answer to an id that was never sent resolve a held request before the handshake passes", async () => {
    const { s, children } = manual();
    const c = children[0] ?? undefined;
    let outcome = "pending";
    const asked = s.request<unknown>("whoami").then(v => { outcome = `resolved ${JSON.stringify(v)}`; return v; }, (e: Error) => { outcome = e.constructor.name; });
    const child = children[0] ?? c;
    const heldId = child.idOf("ping") + 1;
    expect(child.methods()).toEqual(["ping"]);
    await child.write({ jsonrpc: "2.0", id: heldId, result: { ok: true } });
    expect(outcome).toBe("pending");
    expect(child.methods()).toEqual(["ping"]);
    await child.pong();
    expect(child.methods()).toEqual(["ping", "whoami"]);
    expect(outcome).toBe("pending"); // the early line was dropped: only the real answer resolves it
    await child.write({ jsonrpc: "2.0", id: heldId, result: { real: 1 } });
    await asked;
    expect(outcome).toBe('resolved {"real":1}');
  });

  it("fails a held request with the refusal, not a success, when the early answer is followed by a version 2 ping answer", async () => {
    const { s, children } = manual();
    const asked = failure(s.request("whoami"));
    const child = children[0];
    await child.write({ jsonrpc: "2.0", id: child.idOf("ping") + 1, result: { ok: true } });
    await child.pong(2);
    expect(await asked).toBeInstanceOf(SidecarVersionError);
  });
});
