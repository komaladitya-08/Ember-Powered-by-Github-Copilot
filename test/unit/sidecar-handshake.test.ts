import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SIDECAR_PROTOCOL_VERSION } from "../../app/shared/sidecar-protocol";
import { AtspiSidecar, SidecarVersionError, type SidecarLaunch } from "../../app/main/perception/sidecar";
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
