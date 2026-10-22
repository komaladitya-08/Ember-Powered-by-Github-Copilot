import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_LIMITS, BOOTSTRAP_SCRIPT, BOOTSTRAP_SH, runBootstrap, StreamReader, UNINSTALL_SH, writeAll, type Decision } from "../../app/main/remote/bootstrap";

const PC = "0123456789abcdef0123456789abcdef";
const tick = () => new Promise<void>(r => setImmediate(r));

/**
 * A fake ssh running the bootstrap the way dash does: it takes the script, prints the probe, and only then reads
 * one decision line; it asks for each archive with EMBER-READY and reads exactly its bytes. Any byte the PC writes
 * before the remote asked for it is recorded as a violation: dash (or macOS's head) would have swallowed it.
 */
class FakeSsh {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly violations: string[] = [];
  readonly received: Record<string, Buffer> = {};
  decision: string | null = null;
  private phase: "script" | "probing" | "decision" | "idle" | "archive" | "done" = "script";
  private buf = Buffer.alloc(0);
  private want = 0;
  private name = "";
  private asks: { name: string; bytes: number }[] = [];

  constructor(private readonly o: { script: string; noise?: string; probe?: string[]; after?: (d: string) => string[] | "install" } ) {
    this.stdin.on("data", (c: Buffer) => this.take(c));
  }

  private take(c: Buffer): void {
    this.buf = Buffer.concat([this.buf, c]);
    if (this.phase === "script") {
      const len = Buffer.byteLength(this.o.script);
      if (this.buf.length > len) this.violations.push("bytes after the script before EMBER-PROBE-END");
      if (this.buf.length >= len) {
        if (this.buf.subarray(0, len).toString() !== this.o.script) this.violations.push("script differs");
        this.buf = this.buf.subarray(len);
        this.phase = "probing";
        void this.printProbe();
      }
      return;
    }
    if (this.phase === "probing" || this.phase === "idle" || this.phase === "done") {
      this.violations.push(`bytes written while the remote wasn't reading (${this.phase})`);
      return;
    }
    if (this.phase === "decision") {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      this.decision = this.buf.subarray(0, nl).toString();
      if (this.buf.length > nl + 1) this.violations.push("bytes after the decision before EMBER-READY");
      this.buf = Buffer.alloc(0);
      this.phase = "idle";
      void this.afterDecision();
      return;
    }
    if (this.phase === "archive") {
      if (this.buf.length > this.want) this.violations.push(`more than ${this.name}'s bytes before the next EMBER-READY`);
      if (this.buf.length >= this.want) {
        this.received[this.name] = this.buf.subarray(0, this.want);
        this.buf = Buffer.alloc(0);
        this.phase = "idle";
        void this.nextAsk();
      }
    }
  }

  private async printProbe(): Promise<void> {
    await tick();
    if (this.o.noise) this.stdout.write(this.o.noise);
    this.stdout.write("\0EMBER-PROBE-BEGIN\n");
    for (const l of this.o.probe ?? ["os=Linux", "arch=x86_64"]) { this.stdout.write(`${l}\n`); await tick(); }
    // Pause before the end marker: a PC that writes now is pipelining.
    await tick();
    await tick();
    this.stdout.write("EMBER-PROBE-END\n");
    this.phase = "decision";
  }

  private async afterDecision(): Promise<void> {
    await tick();
    const next = this.o.after?.(this.decision as string) ?? [];
    if (next === "install") {
      const w = (this.decision as string).split(" ");
      this.asks = [{ name: "runtime", bytes: Number(w[3]) }, { name: "parts", bytes: Number(w[7]) }].filter(a => a.bytes > 0);
      await this.nextAsk();
      return;
    }
    for (const l of next) this.stdout.write(l);
    this.phase = "done";
  }

  private async nextAsk(): Promise<void> {
    await tick();
    await tick();
    const a = this.asks.shift();
    if (!a) {
      this.phase = "done";
      this.stdout.write("\0EMBER-REMOTE/1 0.1.0-abc\n");
      this.stdout.write(Buffer.from([0, 0, 0, 2, 0, 4]));
      return;
    }
    this.name = a.name;
    this.want = a.bytes;
    this.stdout.write(`EMBER-READY ${a.name}\n`);
    this.phase = "archive";
  }
}

async function* chunks(b: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < b.length; i += size) { yield b.subarray(i, i + size); await tick(); }
}

const RT = Buffer.alloc(200_000, 7);
const PARTS = Buffer.alloc(70_000, 9);
const install = (): Decision => ({
  kind: "install",
  line: `INSTALL ${PC} v24.11.1-linux-x64 ${RT.length} ${"a".repeat(64)} xz 0.1.0-abc ${PARTS.length} ${"b".repeat(64)}`,
  archives: [{ name: "runtime", bytes: RT.length, open: () => chunks(RT, 16_384) }, { name: "parts", bytes: PARTS.length, open: () => chunks(PARTS, 10_000) }],
});

describe("the bootstrap's I/O order (§5.1.9; critique remote-1, remote-17)", () => {
  it("writes nothing after the script before EMBER-PROBE-END and no archive before its EMBER-READY", async () => {
    const ssh = new FakeSsh({ script: BOOTSTRAP_SCRIPT, noise: "Welcome to build-01\nlast login: never\n", after: () => "install" });
    const progress: number[] = [];
    let begun = false;
    const out = await runBootstrap(ssh, { onProbeBegin: () => { begun = true; }, decide: async () => { await tick(); return install(); }, progress: d => progress.push(d) });
    expect(ssh.violations).toEqual([]);
    expect(begun).toBe(true);
    expect(out.kind).toBe("serving");
    if (out.kind !== "serving") return;
    expect(out.rest.subarray(0, 14).toString()).toBe("\0EMBER-REMOTE/");
    expect(out.probe).toEqual({ os: "Linux", arch: "x86_64" });
    expect(ssh.received.runtime.equals(RT)).toBe(true);
    expect(ssh.received.parts.equals(PARTS)).toBe(true);
    expect(progress.at(-1)).toBe(RT.length + PARTS.length);
    expect(ssh.decision).toMatch(/^INSTALL /);
  });

  it("has teeth: the fake catches a PC that pipelines its decision or an archive", async () => {
    const early = new FakeSsh({ script: BOOTSTRAP_SCRIPT });
    await writeAll(early.stdin, `${BOOTSTRAP_SCRIPT}SERVE ${PC} v24 p\n`);
    expect(early.violations).toContain("bytes after the script before EMBER-PROBE-END");
    const eager = new FakeSsh({ script: "s" });
    await writeAll(eager.stdin, "s");
    await new Promise(r => setTimeout(r, 30));
    await writeAll(eager.stdin, "INSTALL x\nRUNTIME BYTES");
    expect(eager.violations).toContain("bytes after the decision before EMBER-READY");
  });

  it("serves without uploading when the plan says SERVE", async () => {
    const ssh = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => ["\0EMBER-REMOTE/1 0.1.0-abc\n"] });
    const out = await runBootstrap(ssh, { decide: async () => ({ kind: "serve", line: `SERVE ${PC} v24.11.1-linux-x64 0.1.0-abc` }) });
    expect(out.kind).toBe("serving");
    expect(ssh.decision).toBe(`SERVE ${PC} v24.11.1-linux-x64 0.1.0-abc`);
    expect(ssh.violations).toEqual([]);
  });

  it("ends a refusal with QUIT, and an uninstall when the script says it is done", async () => {
    const quit = new FakeSsh({ script: BOOTSTRAP_SCRIPT });
    expect(await runBootstrap(quit, { decide: async () => ({ kind: "quit" }) })).toMatchObject({ kind: "done", uninstalled: false });
    expect(quit.decision).toBe("QUIT");
    const un = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => ["EMBER-DONE uninstall\n"] });
    expect(await runBootstrap(un, { decide: async () => ({ kind: "uninstall" }) })).toMatchObject({ kind: "done", uninstalled: true });
    expect(un.decision).toBe("UNINSTALL");
  });

  it("reports the script's own error lines", async () => {
    const ssh = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => ["EMBER-ERROR busy-install -\n"] });
    expect(await runBootstrap(ssh, { decide: async () => install() })).toMatchObject({ kind: "error", code: "busy-install", probeBegan: true });
    const exec = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => ["EMBER-ERROR integrity parts\n"] });
    expect(await runBootstrap(exec, { decide: async () => install() })).toMatchObject({ kind: "error", code: "integrity", detail: "parts" });
  });

  it("refuses a READY it didn't plan for, and an archive source that runs short or long", async () => {
    const odd = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => ["EMBER-READY parts\n"] });
    expect(await runBootstrap(odd, { decide: async () => install() })).toMatchObject({ kind: "error", code: "ready" });
    const short = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => "install" });
    const d = install();
    if (d.kind === "install") d.archives[0].open = () => chunks(RT.subarray(0, 100), 50);
    expect(await runBootstrap(short, { decide: async () => d })).toMatchObject({ kind: "error", code: "integrity", detail: "runtime" });
    const long = new FakeSsh({ script: BOOTSTRAP_SCRIPT, after: () => "install" });
    const e = install();
    if (e.kind === "install") e.archives[0].open = () => chunks(Buffer.concat([RT, Buffer.alloc(5)]), 100_000);
    expect(await runBootstrap(long, { decide: async () => e })).toMatchObject({ kind: "error", code: "integrity" });
  });

  it("never writes a decision line that isn't plain words", async () => {
    const ssh = new FakeSsh({ script: BOOTSTRAP_SCRIPT });
    const out = await runBootstrap(ssh, { decide: async () => ({ kind: "serve", line: `SERVE ${PC} x\nUNINSTALL` }) });
    expect(out).toMatchObject({ kind: "error", code: "decision" });
    expect(ssh.decision).toBeNull();
  });

  it("allows 64 KiB of login noise before the probe, and no more", async () => {
    const ok = new FakeSsh({ script: BOOTSTRAP_SCRIPT, noise: "x".repeat(60 * 1024) });
    expect((await runBootstrap(ok, { decide: async () => ({ kind: "quit" }) })).kind).toBe("done");
    const loud = new FakeSsh({ script: BOOTSTRAP_SCRIPT, noise: "y".repeat(70 * 1024) });
    expect(await runBootstrap(loud, { decide: async () => ({ kind: "quit" }) })).toMatchObject({ kind: "error", code: "noise", probeBegan: false });
  });

  it("reads the probe as bounded key=value lines by name, first value kept, noise ignored", async () => {
    const lines = ["os=Linux", "os=Darwin", "not a pair", "__proto__=x", "constructor=y", "session.Type=x11", "policy_b64.0=e30=", "bad key=1", `long=${"z".repeat(3000)}`];
    const ssh = new FakeSsh({ script: BOOTSTRAP_SCRIPT, probe: lines });
    let seen: Record<string, string> = {};
    await runBootstrap(ssh, { decide: async p => { seen = p; return { kind: "quit" }; } });
    expect(seen.os).toBe("Linux");
    expect(seen["session.Type"]).toBe("x11");
    expect(seen["policy_b64.0"]).toBe("e30=");
    expect(seen.long.length).toBe(1024);
    expect(Object.prototype.hasOwnProperty.call(seen, "__proto__")).toBe(false);
    expect(seen.constructor).toBe("y");
    expect(Object.keys(seen)).not.toContain("bad key");
  });

  it("refuses an oversized probe line", async () => {
    const ssh = new FakeSsh({ script: BOOTSTRAP_SCRIPT, probe: [`x=${"q".repeat(5000)}`] });
    expect(await runBootstrap(ssh, { decide: async () => ({ kind: "quit" }) })).toMatchObject({ kind: "error", code: "probe" });
  });

  it("reports an ssh that ended before the probe, so its stderr and exit code are classified", async () => {
    const ssh = { stdin: new PassThrough(), stdout: new PassThrough() };
    ssh.stdin.resume();
    setTimeout(() => ssh.stdout.end("Permission denied (publickey).\n"), 10);
    expect(await runBootstrap(ssh, { decide: async () => ({ kind: "quit" }) })).toEqual({ kind: "eof", probe: null, probeBegan: false });
  });
});

/**
 * A hostile remote (design T9): it takes the script and prints a probe, then floods its output with bytes and no line
 * end, either at once (while Ember decides) or after asking for the runtime, when it also stops reading its stdin.
 */
class Hostile {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  private got = 0;
  private line = "";
  private phase: "script" | "decision" | "stuck" = "script";
  flooded = 0;

  constructor(private readonly when: "decide" | "upload") {
    this.stdin.on("data", this.take);
  }

  private readonly take = (c: Buffer) => {
    if (this.phase === "script") {
      this.got += c.length;
      if (this.got < Buffer.byteLength(BOOTSTRAP_SCRIPT)) return;
      this.phase = "decision";
      this.stdout.write("\0EMBER-PROBE-BEGIN\nos=Linux\narch=x86_64\nEMBER-PROBE-END\n");
      if (this.when === "decide") void this.flood();
      return;
    }
    if (this.phase === "decision") {
      this.line += c.toString();
      if (!this.line.includes("\n")) return;
      this.phase = "stuck";
      // Stops reading its stdin (the PC's writes then wait for a drain that never comes) and floods instead.
      this.stdin.off("data", this.take);
      this.stdin.pause();
      this.stdout.write("EMBER-READY runtime\n");
      void this.flood();
    }
  };

  private async flood(): Promise<void> {
    for (let i = 0; i < 64; i++) {
      this.stdout.write(Buffer.alloc(64 * 1024, 0x41));
      this.flooded += 64 * 1024;
      await tick();
    }
  }
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"hung">(r => setTimeout(() => r("hung"), ms))]);

describe("a remote that floods what nobody reads (design T9: bounded bootstrap text)", () => {
  it("fails as noise when it floods while Ember decides, without waiting for the decision, and stops reading", async () => {
    const ssh = new Hostile("decide");
    let asked = false;
    const out = await within(runBootstrap(ssh, { decide: () => new Promise<Decision>(() => { asked = true; }) }), 3000);
    expect(asked).toBe(true);
    expect(out).toMatchObject({ kind: "error", code: "noise", probeBegan: true });
    // Nothing reads ssh's output any more: ssh waits on its pipe until it is ended.
    expect(ssh.stdout.listenerCount("data")).toBe(0);
  });

  it("fails as noise when it asks for an archive, stops reading and floods instead", async () => {
    const ssh = new Hostile("upload");
    const out = await within(runBootstrap(ssh, { decide: async () => install() }), 3000);
    expect(out).toMatchObject({ kind: "error", code: "noise", probeBegan: true });
    expect(ssh.stdout.listenerCount("data")).toBe(0);
  });

  it("holds at most its cap unread, and joins nothing while nobody reads", async () => {
    expect(BOOTSTRAP_LIMITS.bufferBytes).toBeGreaterThanOrEqual(BOOTSTRAP_LIMITS.probeBytes + BOOTSTRAP_LIMITS.lineBytes);
    const s = new PassThrough();
    const r = new StreamReader(s, 1000);
    const concat = vi.spyOn(Buffer, "concat");
    try {
      for (let i = 0; i < 200; i++) s.write(Buffer.from("abcd"));
      await tick();
      expect(concat).not.toHaveBeenCalled();
      expect(r.overflowed).toBe(false);
      for (let i = 0; i < 60; i++) s.write(Buffer.from("abcd"));
      await tick();
      expect(r.overflowed).toBe(true);
      expect(s.listenerCount("data")).toBe(0);
      expect(await r.line(100)).toBeNull();
    } finally {
      concat.mockRestore();
    }
  });
});

describe("the bootstrap script", () => {
  it("is byte for byte the shipped scripts/*.sh, removal function first", () => {
    const sh = (n: string) => readFileSync(new URL(`../../app/main/remote/scripts/${n}`, import.meta.url), "utf8");
    expect(BOOTSTRAP_SH).toBe(sh("bootstrap.sh"));
    expect(UNINSTALL_SH).toBe(sh("uninstall-request.sh"));
    expect(BOOTSTRAP_SCRIPT).toBe(`${UNINSTALL_SH}\n${BOOTSTRAP_SH}`);
  });

  it("is one function call on its last line, so sh parses it all before reading Ember's decision", () => {
    expect(BOOTSTRAP_SCRIPT.trimEnd().split("\n").at(-1)).toBe('ember_main "$@"; exit');
    expect(BOOTSTRAP_SCRIPT.match(/^ember_main "\$@"; exit$/gm)).toHaveLength(1);
    // Every other top-level line is a comment, a blank line, or part of a function definition.
    let depth = 0;
    for (const line of BOOTSTRAP_SCRIPT.split("\n").slice(0, -2)) {
      if (depth === 0 && line && !line.startsWith("#") && !/^ember_[a-z_]+\(\) \{$/.test(line)) throw new Error(`top-level command: ${line}`);
      if (/^ember_[a-z_]+\(\) \{$/.test(line)) depth++;
      if (line === "}") depth--;
    }
    expect(depth).toBe(0);
  });

  it("leaves nothing behind to run later and passes no secret on any argv (R2, §5.2.8)", () => {
    expect(BOOTSTRAP_SCRIPT).not.toMatch(/nohup|setsid|disown|crontab|systemctl (enable|start)|launchctl|schtasks|\.bashrc|\.profile|authorized_keys/);
    expect(BOOTSTRAP_SCRIPT).toContain("exec \"$ember_rt/bin/node\" --disable-sigusr1 \"$ember_parts/ember-remote.cjs\" serve --proto 1 --pc \"$1\"");
    expect(BOOTSTRAP_SCRIPT).toContain("unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH");
    expect(BOOTSTRAP_SCRIPT).toContain("printf '\\000EMBER-PROBE-BEGIN\\n'");
    // Ember's decision words are checked again on the remote before use.
    expect(BOOTSTRAP_SCRIPT).toContain("ember_hex \"$1\" 32");
  });
});
