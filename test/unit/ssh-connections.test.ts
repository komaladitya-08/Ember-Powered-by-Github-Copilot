import { createHash } from "node:crypto";
import type net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAskpass } from "../../app/askpass/main";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { BOOTSTRAP_SCRIPT } from "../../app/main/remote/bootstrap";
import { createConnections, type ConnectionsInternals, type ExecResult } from "../../app/main/remote/connections";
import { HELD_CHANNEL_BYTES, HELD_TOTAL_BYTES, helloTimeoutMs, RemoteError, WorkerLink, type FromWorker, type LinkPort, type ToWorker } from "../../app/main/remote/link";
import { acquireLock, type LockIo } from "../../app/remote/lock";
import { checkIncoming, Deadline, escalationMs, runLinkCore, type ChildLike, type CoreDeps, type WorkerPort } from "../../app/main/remote/link-worker";
import type { Msg } from "../../app/main/remote/protocol";
import { ConnectError, type ConnectProgress, type HostRecord, type Mux, type PromptUi } from "../../app/main/remote/types";
import type { PromptAnswer, PromptCard } from "../../app/shared/remote-ui";
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from "../../app/main/settings";

const PC_ID = "0123456789abcdef0123456789abcdef";
const PARTS_ID = "0.1.0-0123456789ab";
const H = (c: string) => c.repeat(64);
const tick = () => new Promise<void>(r => setImmediate(r));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick(); };

// ---------------------------------------------------------------------------------------------------------------------
// The fakes: a mux standing in for MX's, an agent behind it, an ssh child speaking the bootstrap as the real script
// does, and an in-process worker core.

type AgentFn = (msg: Msg, mux: FakeMux) => void;

/** A stand-in for MX's mux: messages go to an agent function, which answers through emit(). */
class FakeMux implements Mux {
  silent = 0;
  rttMs = 12;
  flight = { bytes: 0, throughput: 0 };
  sent: Msg[] = [];
  resets: string[] = [];
  private readonly msgFns = new Set<(m: Msg) => void>();
  private readonly byteFns = new Set<(c: number, b: Uint8Array) => void>();
  private readonly closeFns = new Set<(why: string) => void>();
  constructor(private readonly agent: AgentFn) {}
  send(msg: Msg): void { this.sent.push(msg); setImmediate(() => this.agent(msg, this)); }
  emit(msg: unknown): void { for (const f of this.msgFns) f(msg as Msg); }
  emitBytes(ch: number, b: Uint8Array): void { for (const f of this.byteFns) f(ch, b); }
  onMessage(fn: (m: Msg) => void) { this.msgFns.add(fn); return () => { this.msgFns.delete(fn); }; }
  sendBytes(): void { /* nothing goes the other way in these tests */ }
  onBytes(fn: (c: number, b: Uint8Array) => void) { this.byteFns.add(fn); return () => { this.byteFns.delete(fn); }; }
  ping(): void { /* the agent answers pings in MX; silence is set by the test */ }
  silentMs(): number { return this.silent; }
  inFlight() { return this.flight; }
  reset(_code: number, reason: string): void { this.resets.push(reason); }
  onClose(fn: (why: string) => void) { this.closeFns.add(fn); return () => { this.closeFns.delete(fn); }; }
  close(why: string): void { for (const f of this.closeFns) f(why); }
}

const welcome = (over: Record<string, unknown> = {}) => ({
  proto: 1, partsId: PARTS_ID, os: "linux", arch: "x64", machineIdHash: H("a"), isWsl: false, uid: 1000, user: "deploy", home: "/home/deploy",
  facts: {
    os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/usr/bin/bash", sh: "/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
    home: "/home/deploy", user: "deploy", privileged: false, pty: true, extraPath: [], ember: { paths: [], pids: [], names: { names: ["ember-remote"] } },
  },
  desktop: { access: "none", why: "build-01 has no desktop.", notice: "off" },
  remoteAdmin: { source: null, features: {}, neverLook: [], confirmEveryAction: false, allowGrants: true, commands: { local: "on", wsl: "on", ssh: "on" }, ssh: {}, models: {}, provider: false },
  pid: 31337, graceSeconds: 20, ...over,
});

/** The default agent: hello → welcome; stop → { ms, late }; bye → {}; cmd.facts → its facts. */
const agent = (over: { hello?: (a: unknown) => unknown; stop?: "answer" | "silent" } = {}): AgentFn => (msg, mux) => {
  if (msg.t !== "req") return;
  const ok = (v: unknown) => mux.emit({ t: "res", id: msg.id, ok: true, v });
  if (msg.op === "hello") {
    const r = over.hello ? over.hello(msg.a) : welcome();
    if (r instanceof RemoteError) mux.emit({ t: "res", id: msg.id, ok: false, e: { code: r.code, m: r.message } });
    else ok(r);
  } else if (msg.op === "stop") {
    if (over.stop !== "silent") ok({ ms: 3, late: [] });
  } else if (msg.op === "bye") ok({});
  else if (msg.op === "cmd.facts") ok((welcome() as { facts: unknown }).facts);
};

/** How the fake remote behaves for one ssh run. */
interface RemoteScript {
  /** Before the probe: fail like ssh does (stderr, exit code). */
  fail?: (run: FakeChild) => { stderr: string; code: number } | null | Promise<{ stderr: string; code: number } | null>;
  probe?: Record<string, string>;
  /** After INSTALL's archives or SERVE: an EMBER-ERROR line instead of the agent. */
  error?: string;
}

const PROBE = (over: Record<string, string> = {}) => ({
  os: "Linux", arch: "x86_64", kernel: "6.8.0-45-generic", libc: "glibc 2.39", home: "/home/deploy", free_kb: "9000000", noexec: "0",
  uid: "1000", user: "deploy", machine: H("a"), host: H("b"), wsl: "0", boot: H("c"), tools: "tar gzip xz head sha256sum",
  rt: "v24.11.1-linux-x64", parts: PARTS_ID, policy: "none", ...over,
});

/** ssh as the fake remote runs it: the bootstrap's protocol on stdin and stdout, exactly as the real script orders it. */
class FakeChild implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4000 + Math.floor(Math.random() * 1000);
  decision: string | null = null;
  received: Record<string, Buffer> = {};
  killed = false;
  ended = false;
  private exitFns: ((c: number | null, s: NodeJS.Signals | null) => void)[] = [];
  private done = false;
  private buf = Buffer.alloc(0);
  private phase: "script" | "probe" | "decision" | "archive" | "serving" = "script";
  private asks: { name: string; bytes: number }[] = [];
  private want = 0;
  private name = "";

  constructor(readonly argv: readonly string[], readonly env: Record<string, string>, private readonly script: RemoteScript) {
    this.stdin.on("data", (c: Buffer) => this.take(c));
    this.stdin.on("finish", () => { this.ended = true; if (this.phase === "serving") this.exit(0, null); });
  }

  on(ev: "exit" | "error", fn: (...a: never[]) => void): this {
    if (ev === "exit") this.exitFns.push(fn as (c: number | null, s: NodeJS.Signals | null) => void);
    return this;
  }

  kill(): boolean { this.killed = true; this.exit(null, "SIGKILL"); return true; }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => { for (const f of this.exitFns) f(code, signal); });
  }

  private take(c: Buffer): void {
    this.buf = Buffer.concat([this.buf, c]);
    if (this.phase === "script" && this.buf.length >= Buffer.byteLength(BOOTSTRAP_SCRIPT)) {
      if (this.buf.length > Buffer.byteLength(BOOTSTRAP_SCRIPT)) throw new Error("the PC pipelined after the script");
      this.buf = Buffer.alloc(0);
      this.phase = "probe";
      void this.start();
    } else if (this.phase === "decision") {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      this.decision = this.buf.subarray(0, nl).toString();
      this.buf = this.buf.subarray(nl + 1);
      void this.decide();
    } else if (this.phase === "archive" && this.buf.length >= this.want) {
      this.received[this.name] = this.buf.subarray(0, this.want);
      this.buf = this.buf.subarray(this.want);
      void this.nextAsk();
    }
  }

  private async start(): Promise<void> {
    await tick();
    const f = await this.script.fail?.(this);
    if (f) {
      this.stderr.write(f.stderr);
      this.exit(f.code, null);
      return;
    }
    this.stdout.write("\0EMBER-PROBE-BEGIN\n");
    for (const [k, v] of Object.entries(PROBE(this.script.probe))) this.stdout.write(`${k}=${v}\n`);
    this.stdout.write("EMBER-PROBE-END\n");
    this.phase = "decision";
  }

  private async decide(): Promise<void> {
    await tick();
    const w = (this.decision ?? "").split(" ");
    if (w[0] === "QUIT") return this.exit(0, null);
    if (w[0] === "UNINSTALL") { this.stdout.write("EMBER-DONE uninstall\n"); return this.exit(0, null); }
    if (w[0] === "INSTALL") this.asks = [{ name: "runtime", bytes: Number(w[3]) }, { name: "parts", bytes: Number(w[7]) }].filter(a => a.bytes > 0);
    await this.nextAsk();
  }

  private async nextAsk(): Promise<void> {
    await tick();
    const a = this.asks.shift();
    if (a) {
      this.name = a.name;
      this.want = a.bytes;
      this.phase = "archive";
      this.stdout.write(`EMBER-READY ${a.name}\n`);
      return;
    }
    if (this.script.error) {
      this.stdout.write(`EMBER-ERROR ${this.script.error} -\n`);
      return this.exit(4, null);
    }
    this.phase = "serving";
    this.stdout.write(`\0EMBER-REMOTE/1 ${PARTS_ID}\n`);
  }
}

/** The worker core in this thread, with fake ssh children and a fake mux per serving run. */
function inProcess(spawned: FakeChild[], remotes: RemoteScript[], agentFn: () => AgentFn, muxes: FakeMux[], archive: (path: string) => Buffer): () => LinkPort {
  return () => {
    const toMain = new Set<(m: FromWorker) => void>();
    const toWorker: ((m: ToWorker) => void)[] = [];
    const port: WorkerPort = { post: m => setImmediate(() => { for (const f of toMain) f(m); }), on: fn => { toWorker.push(fn); } };
    const deps: CoreDeps = {
      spawn: (program, args, o) => {
        const c = new FakeChild([program, ...args], o.env, remotes.shift() ?? {});
        spawned.push(c);
        return c;
      },
      createMux: () => { const m = new FakeMux(agentFn()); muxes.push(m); return m; },
      openArchive: path => (async function* () { yield archive(path); })(),
      kill: child => { child.kill("SIGKILL"); },
    };
    runLinkCore(port, deps);
    return {
      post: m => setImmediate(() => { for (const f of toWorker) f(m); }),
      onMessage: fn => { toMain.add(fn); return () => { toMain.delete(fn); }; },
      onExit: () => () => undefined,
      terminate: async () => undefined,
    };
  };
}

/** `ssh -G` output for a destination. */
const gOut = (o: { user?: string; hostname?: string; port?: number; extra?: string[] } = {}) =>
  [`user ${o.user ?? "deploy"}`, `hostname ${o.hostname ?? "build-01.example.com"}`, `port ${o.port ?? 22}`, "userknownhostsfile ~/.ssh/known_hosts", ...(o.extra ?? [])].join("\n");

const record = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: "build-01", dest: "deploy@build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: [] },
  consent: { version: 1, at: "2026-10-22T12:00:00.000Z" }, ...over,
});

/** A whole Connections with fakes everywhere, and what it did. */
function rig(o: {
  os?: "linux" | "darwin" | "win32";
  g?: (argv: readonly string[]) => string;
  remotes?: RemoteScript[];
  agent?: () => AgentFn;
  admin?: LoadedAdminPolicy;
  answer?: (card: PromptCard) => PromptAnswer;
  hosts?: HostRecord[];
  internals?: Partial<ConnectionsInternals>;
  allowLoopback?: boolean;
  archive?: (path: string) => Buffer;
} = {}) {
  const spawned: FakeChild[] = [];
  const muxes: FakeMux[] = [];
  const execs: (readonly string[])[] = [];
  const cards: PromptCard[] = [];
  const audits: Record<string, unknown>[] = [];
  const progress: [string, ConnectProgress][] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS, targets: { ...DEFAULT_SETTINGS.targets, hosts: o.hosts ?? [record()], pcId: PC_ID } };
  const store = { get: () => settings, own: () => settings, update: (p: Partial<Settings>) => { settings = { ...settings, ...p }; return settings; } } as unknown as SettingsStore;
  const listeners = new Map<string, (c: net.Socket) => void>();
  const exec = async (argv: readonly string[]): Promise<ExecResult> => {
    execs.push(argv);
    if (argv.includes("-V")) return { code: 0, stdout: "", stderr: o.os === "win32" ? "OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\r\n" : "OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13\n" };
    if (argv.includes("-G")) return { code: 0, stdout: o.g ? o.g(argv) : gOut(), stderr: "" };
    if (argv.includes("-O")) return { code: 255, stdout: "", stderr: "Control socket connect(/x): No such file or directory\n" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const prompts: PromptUi = { ask: async card => { cards.push(card); return o.answer ? o.answer(card) : { id: card.id, ok: false }; }, dismiss: () => undefined };
  const files = new Map<string, string>();
  const internals: ConnectionsInternals = {
    env: { HOME: "/home/ana", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/user/1000/agent", GH_TOKEN: "ghp_secret", DISPLAY: ":1", XDG_RUNTIME_DIR: "/run/user/1000" },
    exec,
    newPort: inProcess(spawned, [...(o.remotes ?? [])], o.agent ?? (() => agent()), muxes, o.archive ?? (() => Buffer.alloc(0))),
    askpassFs: {
      mkdir: async () => undefined, mkdtemp: async p => `${p}TeSt01`, rm: async () => undefined,
      readFile: async p => { const f = files.get(p); if (f === undefined) throw new Error("ENOENT"); return f; },
      writeFile: async (p, d) => { files.set(p, d); }, chmod: async () => undefined, rename: async (a, b) => { files.set(b, files.get(a) as string); },
    },
    askpassListen: async (path, onConn) => { listeners.set(path, onConn); return { close: () => listeners.delete(path) }; },
    readText: async p => {
      if (/remote-parts[\\/]remote-parts\.json$/.test(p)) return JSON.stringify({ partsId: PARTS_ID, targets: { "linux-x64": { file: "parts-linux-x64.tar.gz", sha256: H("d"), bytes: 10 } } });
      if (p.endsWith("remote-runtime.json")) return JSON.stringify({ minimum: "24.8.0", pinned: "24.11.1", targets: { "linux-x64": { xz: { file: "node-v24.11.1-linux-x64.tar.xz", sha256: H("e"), bytes: 20 } } } });
      throw new Error("ENOENT");
    },
    readFileSync: p => (p === "/etc/machine-id" ? Buffer.from("pc-machine\n") : p.endsWith("boot_id") ? Buffer.from("pc-boot\n") : null),
    networkAddresses: () => ["127.0.0.1", "192.168.1.20"],
    lookup: async () => ["203.0.113.7"],
    hostname: () => "ana-laptop",
    ...o.internals,
  };
  const conns = createConnections({
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, file: "" },
    os: o.os ?? "linux", userData: "/home/ana/.config/ember", appDir: "/opt/Ember/resources/app/dist/app", execPath: "/opt/Ember/ember",
    resourcesPath: "/opt/Ember/resources", settings: store,
    admin: () => o.admin ?? { policy: AdminPolicySchema.parse({}), source: null },
    prompts, fetch: async () => ({ ok: false, status: 404, body: null }), allowLoopback: o.allowLoopback ?? false,
    audit: () => ({ write: (e: Record<string, unknown>) => audits.push(e) }) as never,
    pcId: () => PC_ID, wsl: () => null, jobHost: o.os === "win32" ? { execPath: "C:\\Ember\\Ember.exe", script: "C:\\Ember\\resources\\app\\dist\\app\\job-host.cjs" } : null,
  }, internals);
  conns.onProgress((id, p) => progress.push([id, p]));
  /** What an askpass helper ssh started would do: ask over the run's channel and return the answer printed. */
  const askpass = async (child: FakeChild, prompt: string, hint?: string) => {
    const onConn = listeners.get(child.env.EMBER_ASKPASS_SOCK);
    if (!onConn) return null;
    const [a, b] = pair();
    onConn(b as unknown as net.Socket);
    let out = "";
    const code = await runAskpass({
      argv: ["node", "askpass.cjs", prompt], env: { EMBER_ASKPASS_SOCK: child.env.EMBER_ASKPASS_SOCK, EMBER_ASKPASS_NONCE: child.env.EMBER_ASKPASS_NONCE, ...(hint ? { SSH_ASKPASS_PROMPT: hint } : {}) },
      write: t => { out += t; }, connect: () => { setImmediate(() => a.emit("connect")); return a as unknown as net.Socket; },
    });
    return code === 0 ? out.replace(/\n$/, "") : null;
  };
  return { conns, spawned, muxes, execs, cards, audits, progress, askpass, settings: () => settings };
}

/** Two in-memory sockets wired to each other. */
function pair(): [Duplex, Duplex] {
  const ab = new PassThrough(), ba = new PassThrough();
  const make = (r: PassThrough, w: PassThrough) => {
    const d = new Duplex({ read() { /* pushed below */ }, write(c, _e, cb) { w.write(c); cb(); }, final(cb) { w.end(); cb(); } });
    r.on("data", c => d.push(c));
    r.on("end", () => { d.push(null); setImmediate(() => d.destroy()); });
    d.on("close", () => { if (!w.writableEnded) w.end(); });
    return d;
  };
  return [make(ba, ab), make(ab, ba)];
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; vi.useRealTimers(); });
const track = <T extends { conns: { dispose(): Promise<void> } }>(r: T) => { cleanup.push(() => r.conns.dispose()); return r; };

// ---------------------------------------------------------------------------------------------------------------------

describe("connecting (§5.1.3-§5.1.5)", () => {
  it("connects in batch mode with the hardened argv and environment, says hello and serves", async () => {
    const r = track(rig());
    const link = await r.conns.connect(record(), { interactive: true });
    expect(r.spawned).toHaveLength(1);
    const c = r.spawned[0];
    expect(c.argv[0]).toBe("/usr/bin/ssh");
    expect(c.argv).toEqual(expect.arrayContaining(["BatchMode=yes", "ControlMaster=no", "ControlPath=none", "StrictHostKeyChecking=yes"]));
    expect(c.argv.slice(-4)).toEqual(["--", "deploy@build-01", "sh", "-s"]);
    expect(c.env).toMatchObject({ SSH_ASKPASS_REQUIRE: "never", SSH_AUTH_SOCK: "/run/user/1000/agent" });
    expect(c.env).not.toHaveProperty("GH_TOKEN");
    expect(c.env).not.toHaveProperty("DISPLAY");
    expect(c.decision).toBe(`SERVE ${PC_ID} v24.11.1-linux-x64 ${PARTS_ID}`);
    const hello = r.muxes[0].sent.find(m => m.t === "req" && m.op === "hello") as Extract<Msg, { t: "req" }>;
    expect(hello.a).toMatchObject({ proto: 1, partsId: PARTS_ID, pcId: PC_ID, local: { name: "ana-laptop", os: "linux" }, consent: { version: 1, at: "2026-10-22T12:00:00.000Z" }, epoch: 0 });
    expect(link.state).toBe("ready");
    expect(link.welcome.user).toBe("deploy");
    expect(r.conns.link("build-01")).toBe(link);
    expect(r.progress.map(([, p]) => p.step)).toEqual(["resolving", "connecting", "checking", "starting", "ready"]);
    expect(r.audits.map(a => a.step)).toEqual(["connect", "connected"]);
    expect(r.settings().targets.hosts[0].machineIdHash).toBe(H("a"));
    await expect(link.request("cmd.facts", {})).resolves.toMatchObject({ os: "linux" });
  });

  it("installs the runtime and parts after their READY lines, each checked before it is sent", async () => {
    const runtimeBytes = Buffer.from("node runtime archive");
    const partsBytes = Buffer.from("parts arch");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const r = track(rig({
      remotes: [{ probe: { rt: "", parts: "" } }],
      archive: p => (p.endsWith(".tar.xz") ? runtimeBytes : partsBytes),
      internals: {
        readText: async p => {
          if (p.endsWith("remote-parts/remote-parts.json")) return JSON.stringify({ partsId: PARTS_ID, targets: { "linux-x64": { file: "parts-linux-x64.tar.gz", sha256: sha(partsBytes), bytes: partsBytes.length } } });
          if (p.endsWith("remote-runtime.json")) return JSON.stringify({ minimum: "24.8.0", pinned: "24.11.1", targets: { "linux-x64": { xz: { file: "node-v24.11.1-linux-x64.tar.xz", sha256: sha(runtimeBytes), bytes: runtimeBytes.length } } } });
          throw new Error("ENOENT");
        },
        runtimeFs: {
          stat: async p => ({ size: p.endsWith(".tar.xz") ? runtimeBytes.length : partsBytes.length }),
          createReadStream: p => (async function* () { yield p.endsWith(".tar.xz") ? runtimeBytes : partsBytes; })(),
          open: async () => ({ write: async () => undefined, close: async () => undefined }), rename: async () => undefined, rm: async () => undefined, mkdir: async () => undefined,
        },
      },
    }));
    await r.conns.connect(record(), { interactive: false });
    const c = r.spawned[0];
    expect(c.decision).toBe(`INSTALL ${PC_ID} v24.11.1-linux-x64 ${runtimeBytes.length} ${sha(runtimeBytes)} xz ${PARTS_ID} ${partsBytes.length} ${sha(partsBytes)}`);
    expect(Object.keys(c.received)).toEqual(["runtime", "parts"]);
    expect(r.progress.map(([, p]) => p.step)).toContain("copying");
  });

  it("asks through Ember's prompt when the key is new, and connects once the user trusts it", async () => {
    type Rig = ReturnType<typeof rig>;
    const ref: { r?: Rig } = {};
    const r = ref.r = track(rig({
      remotes: [
        { fail: () => ({ stderr: "No ED25519 host key is known for build-01.example.com and you have requested strict checking.\r\nHost key verification failed.\r\n", code: 255 }) },
        { fail: async (run): Promise<{ stderr: string; code: number } | null> => {
          const yes: string | null = await (ref.r as Rig).askpass(run, "The authenticity of host 'build-01.example.com (203.0.113.7)' can't be established.\nED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ", "confirm");
          return yes === "yes" ? null : { stderr: "Host key verification failed.\n", code: 255 };
        } },
      ],
      answer: card => ({ id: card.id, ok: true }),
    }));
    await r.conns.connect(record(), { interactive: true });
    expect(r.spawned).toHaveLength(2);
    const second = r.spawned[1];
    expect(second.argv).not.toContain("BatchMode=yes");
    expect(second.argv).toContain("StrictHostKeyChecking=ask");
    expect(second.env).toMatchObject({ SSH_ASKPASS: "/home/ana/.config/ember/ssh/askpass", SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":1", EMBER_ASKPASS_SOCK: "/run/user/1000/ea-TeSt01/a.sock" });
    expect(second.env.EMBER_ASKPASS_NONCE).toMatch(/^[0-9a-f]{32}$/);
    expect(r.cards).toEqual([expect.objectContaining({ kind: "host-key", host: "build-01", address: "203.0.113.7", fingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" })]);
    expect(r.audits.filter(a => a.step === "prompt")).toEqual([{ event: "remote", step: "prompt", host: "build-01", kind: "host-key" }]);
  });

  it("hands a password only to ssh, and says \"Connection cancelled\" when the user cancels", async () => {
    let seen: string | null = null;
    const auth = { stderr: "deploy@build-01.example.com: Permission denied (publickey,password).\n", code: 255 };
    type Rig = ReturnType<typeof rig>;
    const ref: { r?: Rig; c?: Rig } = {};
    const r = ref.r = track(rig({
      remotes: [{ fail: () => auth }, { fail: async (run): Promise<typeof auth | null> => { seen = await (ref.r as Rig).askpass(run, "deploy@build-01.example.com's password: "); return seen === "hunter2" ? null : auth; } }],
      answer: card => ({ id: card.id, ok: true, value: "hunter2" }),
    }));
    await r.conns.connect(record(), { interactive: true });
    expect(seen).toBe("hunter2");
    expect(JSON.stringify(r.audits)).not.toContain("hunter2");
    expect(r.cards[0]).toMatchObject({ kind: "secret", secret: "password", login: "deploy" });
    const c = ref.c = track(rig({ remotes: [{ fail: () => auth }, { fail: async (run): Promise<typeof auth | null> => ((await (ref.c as Rig).askpass(run, "Password: ")) ? null : auth) }] }));
    await expect(c.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "cancelled", message: "Connection cancelled" });
  });

  it("never offers to accept a changed host key", async () => {
    const r = track(rig({ remotes: [{ fail: () => ({ stderr: "@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@\nHost key verification failed.\n", code: 255 }) }] }));
    const err = await r.conns.connect(record(), { interactive: true }).catch(e => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err).toMatchObject({ kind: "host-key-changed" });
    expect(r.spawned).toHaveLength(1);
    expect(r.cards).toEqual([]);
  });

  it("never prompts on a reconnect or a batch-only connect: the failure says what to do", async () => {
    const r = track(rig({ remotes: [{ fail: () => ({ stderr: "Permission denied (publickey).\n", code: 255 }) }] }));
    await expect(r.conns.connect(record(), { interactive: false })).rejects.toMatchObject({ kind: "auth", message: "build-01 didn't accept your key. Add it to the ssh-agent (`ssh-add`), then connect again." });
    expect(r.spawned).toHaveLength(1);
  });

  it("refuses before running anything: no consent, SSH off, a host the admin didn't allow, keys thrown away, this computer", async () => {
    const off = track(rig({ admin: { policy: AdminPolicySchema.parse({ features: { ssh: false } }), source: "/etc/ember/policy.json" } }));
    await expect(off.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "not-allowed" });
    const noConsent = track(rig());
    await expect(noConsent.conns.connect(record({ consent: { version: 0, at: null } }), { interactive: true })).rejects.toMatchObject({ kind: "consent" });
    const allowed = track(rig({ admin: { policy: AdminPolicySchema.parse({ ssh: { allowedHosts: ["*.build.example.com"] } }), source: "/etc/ember/policy.json" } }));
    await expect(allowed.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "not-allowed", message: "Your organisation doesn't allow Ember to connect to build-01." });
    const nul = track(rig({ g: () => gOut().replace("~/.ssh/known_hosts", "NUL") }));
    await expect(nul.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "known-hosts" });
    const self = track(rig({ g: () => gOut({ hostname: "192.168.1.20" }) }));
    await expect(self.conns.connect(record({ resolved: { user: "deploy", hostname: "192.168.1.20", port: 22, jump: [] } }), { interactive: true })).rejects.toMatchObject({ kind: "same-machine" });
    for (const x of [off, noConsent, allowed, nul, self]) expect(x.spawned).toEqual([]);
  });

  it("asks consent again when ssh -G now resolves elsewhere, or the remote is another machine", async () => {
    const moved = track(rig({ g: () => gOut({ hostname: "10.9.9.9" }) }));
    await expect(moved.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "resolution-changed" });
    const swapped = track(rig({ remotes: [{ probe: { machine: H("f") } }] }));
    await expect(swapped.conns.connect(record({ machineIdHash: H("a") }), { interactive: true })).rejects.toMatchObject({ kind: "machine-changed" });
    expect(swapped.spawned[0].decision).toBe("QUIT");
  });

  it("refuses after the probe without uploading: the plan's own refusal, with QUIT", async () => {
    const r = track(rig({ remotes: [{ probe: { kernel: "4.14.0" } }] }));
    await expect(r.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "unsupported", message: "build-01's system is too old for Ember (it needs Linux 4.18 or newer)." });
    expect(r.spawned[0].decision).toBe("QUIT");
  });

  it("rewrites a two-hop ProxyJump into the hardened chain and checks every hop first", async () => {
    const r = track(rig({
      g: argv => {
        const dest = argv.at(-1) as string;
        if (dest === "deploy@build-01") return gOut({ extra: ["proxyjump jump1,deploy@jump2:2200"] });
        return gOut({ hostname: dest.replace(/^.*@/, ""), user: "deploy" });
      },
    }));
    const host = record({ resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["jump1", "deploy@jump2:2200"] } });
    await r.conns.connect(host, { interactive: true });
    const gCalls = r.execs.filter(a => a.includes("-G")).map(a => a.at(-1));
    expect(gCalls).toEqual(["deploy@build-01", "jump1", "deploy@jump2"]);
    const argv = r.spawned[0].argv;
    const proxy = argv[argv.findIndex(a => a.startsWith("ProxyCommand="))];
    expect(proxy).toMatch(/^ProxyCommand='\/usr\/bin\/ssh' -T -o BatchMode=yes .* -p 2200 -o 'ProxyCommand=.*%%h.*' -W '\[%h\]:%p' -- deploy@jump2$/);
    expect(argv.indexOf(proxy)).toBeLessThan(argv.indexOf("ProxyJump=none"));
  });

  it("refuses a jump host the admin didn't allow, and one whose own config jumps again", async () => {
    const admin = { policy: AdminPolicySchema.parse({ ssh: { allowedHosts: ["build-01.example.com"] } }), source: "/etc/ember/policy.json" };
    const r = track(rig({ admin, g: argv => (argv.at(-1) === "deploy@build-01" ? gOut({ extra: ["proxyjump bastion"] }) : gOut({ hostname: "bastion.example.com" })) }));
    await expect(r.conns.connect(record({ resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["bastion"] } }), { interactive: true })).rejects.toMatchObject({ kind: "not-allowed", message: "Your organisation doesn't allow Ember to connect to bastion." });
    const nested = track(rig({ g: argv => (argv.at(-1) === "deploy@build-01" ? gOut({ extra: ["proxyjump bastion"] }) : gOut({ hostname: "bastion", extra: ["proxyjump outer"] })) }));
    await expect(nested.conns.connect(record({ resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["bastion"] } }), { interactive: true })).rejects.toMatchObject({ kind: "config" });
  });

  it("on Windows takes one jump host, runs ssh under the job host, and hides it", async () => {
    const r = track(rig({ os: "win32", g: argv => (argv.at(-1) === "deploy@build-01" ? gOut({ extra: ["proxyjump bastion"] }) : gOut({ hostname: "bastion" })) }));
    await r.conns.connect(record({ resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["bastion"] } }), { interactive: false });
    const argv = r.spawned[0].argv;
    expect(argv.slice(0, 5)).toEqual(["C:\\Ember\\Ember.exe", "C:\\Ember\\resources\\app\\dist\\app\\job-host.cjs", "--interactive", "--", "C:\\Windows\\System32\\OpenSSH\\ssh.exe"]);
    expect(argv.find(a => a.startsWith("ProxyCommand="))).toMatch(/^ProxyCommand="C:\\Windows\\System32\\OpenSSH\\ssh\.exe" -T .* -W \[%h\]:%p -- bastion$/);
    expect(r.spawned[0].env.ELECTRON_RUN_AS_NODE).toBe("1");
    const two = track(rig({ os: "win32", g: argv => (argv.at(-1) === "deploy@build-01" ? gOut({ extra: ["proxyjump a,b"] }) : gOut({ hostname: "j" })) }));
    await expect(two.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ message: "Ember can't connect through a jump host from Windows yet." });
  });

  it("reports the agent's busy lock as another computer's, worth retrying", async () => {
    const r = track(rig({ agent: () => agent({ hello: () => new RemoteError("busy", "held by another PC") }) }));
    await expect(r.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "busy", retry: true, message: "Ember from another computer is already working on build-01." });
  });

  it("refuses an agent whose welcome doesn't match what the probe found (§7.2.6)", async () => {
    const r = track(rig({ agent: () => agent({ hello: () => welcome({ arch: "arm64" }) }) }));
    await expect(r.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "protocol", message: "build-01 answered in a way Ember can't check." });
  });

  it("judges the welcome's machine id by the probe's rule: this PC refused, a clone with its own boot id let through", async () => {
    const pcMachine = createHash("sha256").update("pc-machine\n").digest("hex");
    const pcBoot = createHash("sha256").update("pc-boot\n").digest("hex");
    const clone = track(rig({ agent: () => agent({ hello: () => welcome({ machineIdHash: pcMachine }) }) }));
    await expect(clone.conns.connect(record(), { interactive: true })).resolves.toBeTruthy();
    const same = track(rig({ remotes: [{ probe: { boot: pcBoot } }], agent: () => agent({ hello: () => welcome({ machineIdHash: pcMachine }) }) }));
    await expect(same.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "protocol" });
  });

  it("classifies a bootstrap error and a login that never ran the set-up", async () => {
    const r = track(rig({ remotes: [{ error: "busy-install" }] }));
    await expect(r.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "busy-install" });
    const fixed = track(rig({ remotes: [{ fail: () => ({ stderr: "This account is currently not available.\n", code: 1 }) }] }));
    await expect(fixed.conns.connect(record(), { interactive: true })).rejects.toMatchObject({ kind: "no-setup" });
  });

  it("removes Ember from a host through the same bootstrap", async () => {
    const r = track(rig());
    await r.conns.uninstall(record());
    expect(r.spawned[0].decision).toBe("UNINSTALL");
    expect(r.audits.at(-1)).toMatchObject({ step: "uninstalled", host: "build-01" });
    // Only to the computer the user allowed: a host that now resolves elsewhere gets nothing run on it.
    const moved = track(rig({ g: () => gOut({ hostname: "203.0.113.99" }) }));
    await expect(moved.conns.uninstall(record())).rejects.toMatchObject({ kind: "resolution-changed" });
    expect(moved.spawned).toEqual([]);
  });

  it("resolves a typed destination for the consent card, with its jump hops", async () => {
    const r = track(rig({ g: argv => (argv.at(-1) === "build-01" ? gOut({ extra: ["proxyjump deploy@[10.0.0.5]:2200", "controlpath /home/ana/.ssh/cm-1"] }) : gOut({ hostname: "10.0.0.5" })) }));
    expect(await r.conns.resolve("build-01")).toEqual({ user: "deploy", hostname: "build-01.example.com", port: 22, jump: ["deploy@10.0.0.5:2200"], controlPath: null });
  });
});

describe("a live link (§5.1.10-§5.1.13)", () => {
  it("stops with the epoch at once and answers within the escalation deadline", async () => {
    const r = track(rig());
    const link = await r.conns.connect(record(), { interactive: true });
    const before = link.epoch;
    const stopped = link.stop();
    expect(link.epoch).toBe(before + 1);
    // Nothing from before the Stop is sent after it.
    await expect(link.request("cmd.run", { epoch: before, spec: {} as never })).rejects.toMatchObject({ code: "stopped" });
    expect(await stopped).toMatchObject({ escalated: false });
    const stopMsg = r.muxes[0].sent.find(m => m.t === "req" && m.op === "stop") as Extract<Msg, { t: "req" }>;
    expect(stopMsg.a).toEqual({ epoch: before + 1 });
  });

  it("kills ssh when a Stop goes unanswered, and the link is lost", async () => {
    const r = track(rig({ agent: () => agent({ stop: "silent" }) }));
    const link = await r.conns.connect(record(), { interactive: true });
    r.muxes[0].rttMs = 0;
    const states: string[] = [];
    link.onState(s => states.push(s));
    const t0 = Date.now();
    expect(await link.stop()).toMatchObject({ escalated: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    await settle();
    expect(r.spawned[0].killed).toBe(true);
    expect(states).toContain("lost");
  });

  it("goes stalled at 5 s of silence and lost at the grace, then reconnects in batch mode", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const r = track(rig({ internals: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => undefined } }));
    const link = await r.conns.connect(record(), { interactive: true });
    const states: string[] = [];
    link.onState(s => states.push(s));
    r.muxes[0].silent = 6_000;
    await new Promise(res => setTimeout(res, 1_100));
    expect(link.state).toBe("stalled");
    await expect(link.request("act", { opId: "o", epoch: link.epoch, stamp: {} as never, op: "do_action", id: 1, action: "click" })).rejects.toMatchObject({ code: "stale" });
    r.muxes[0].silent = 21_000;
    await new Promise(res => setTimeout(res, 1_100));
    expect(states).toEqual(["stalled", "lost"]);
    expect(r.spawned[0].killed).toBe(true);
    expect(r.audits.map(a => a.step)).toContain("lost");
    // The reconnect waits 1 s first, then runs batch only.
    expect(timers[0].ms).toBe(1000);
    timers[0].fn();
    await settle(60);
    expect(r.spawned).toHaveLength(2);
    expect(r.spawned[1].argv).toContain("BatchMode=yes");
    expect(r.conns.link("build-01")?.id).not.toBe(link.id);
  });

  it("calls the link lost at this PC's own grace when the agent claims a longer one (L10)", async () => {
    const r = track(rig({
      admin: { policy: AdminPolicySchema.parse({ ssh: { commandGraceSeconds: 5 } }), source: "/etc/ember/policy.json" },
      agent: () => agent({ hello: () => welcome({ graceSeconds: 120 }) }),
      internals: { setTimeout: () => 0, clearTimeout: () => undefined },
    }));
    const link = await r.conns.connect(record(), { interactive: true });
    r.muxes[0].silent = 6_000;
    await new Promise(res => setTimeout(res, 1_100));
    expect(link.state).toBe("lost");
  });

  it("gives up reconnecting at a failure that needs the user", async () => {
    const timers: (() => void)[] = [];
    const r = track(rig({
      remotes: [{}, { fail: () => ({ stderr: "Permission denied (publickey).\n", code: 255 }) }],
      internals: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => undefined },
    }));
    const link = await r.conns.connect(record(), { interactive: true });
    r.muxes[0].close("ssh exited");
    await settle();
    expect(link.state).toBe("lost");
    timers.shift()?.();
    await new Promise(res => setTimeout(res, 150));
    expect(timers).toHaveLength(0);
    expect(r.progress.at(-1)?.[1]).toMatchObject({ step: "failed", kind: "auth" });
    expect(r.cards).toEqual([]);
  });

  it("disconnects with bye and EOF, and doesn't reconnect", async () => {
    const timers: (() => void)[] = [];
    const r = track(rig({ internals: { setTimeout: fn => { timers.push(fn); return 1; }, clearTimeout: () => undefined } }));
    const link = await r.conns.connect(record(), { interactive: true });
    await r.conns.disconnect("build-01");
    expect(r.muxes[0].sent.some(m => m.t === "req" && m.op === "bye")).toBe(true);
    expect(r.spawned[0].ended).toBe(true);
    expect(link.state).toBe("closed");
    expect(r.conns.link("build-01")).toBeNull();
    expect(timers).toEqual([]);
    expect(r.audits.at(-1)).toMatchObject({ step: "disconnected" });
  });

  it("drops a remote that sends a request, an unknown event or a result that breaks its schema (§7.2)", async () => {
    for (const bad of [{ t: "req", id: 1, op: "hello", a: {} }, { t: "ev", ev: "evil", d: {} }, { t: "ev", ev: "notice", d: { state: "shown", extra: 1 } }]) {
      const r = track(rig());
      const link = await r.conns.connect(record(), { interactive: true });
      r.muxes[0].emit(bad);
      await settle();
      expect(link.state).toBe("lost");
      expect(r.muxes[0].resets).toEqual(["protocol"]);
    }
  });

  it("stopAll stops every link at once and never throws", async () => {
    const r = track(rig());
    await r.conns.connect(record(), { interactive: true });
    await expect(r.conns.stopAll()).resolves.toBeUndefined();
    expect(r.muxes[0].sent.filter(m => m.t === "req" && m.op === "stop")).toHaveLength(1);
  });
});

describe("the link's pieces", () => {
  it("pauses the 45 s deadline while a prompt is open (§5.1.5)", () => {
    vi.useFakeTimers();
    let fired = false;
    let t = 0;
    const d = new Deadline(45_000, () => { fired = true; }, () => t);
    t = 30_000; vi.advanceTimersByTime(30_000);
    d.pause();
    t = 100_000; vi.advanceTimersByTime(70_000);
    expect(fired).toBe(false);
    d.resume();
    t = 114_000; vi.advanceTimersByTime(14_000);
    expect(fired).toBe(false);
    t = 115_001; vi.advanceTimersByTime(1_001);
    expect(fired).toBe(true);
  });

  it("escalates after min(10 s, max(1 s, 3 × RTT + in flight ÷ throughput)) (critique remote-23)", () => {
    expect(escalationMs(10, { bytes: 0, throughput: 0 })).toBe(1000);
    expect(escalationMs(500, { bytes: 1_000_000, throughput: 500_000 })).toBe(3500);
    expect(escalationMs(5000, { bytes: 0, throughput: 1 })).toBe(10_000);
    expect(escalationMs(10, { bytes: 1000, throughput: 0 })).toBe(10_000);
  });

  it("checks results by the op that asked, and refuses requests from the remote", () => {
    const pending = new Map([[7, "cmd.git" as const]]);
    expect(checkIncoming({ t: "res", id: 7, ok: true, v: { git: null } }, pending)).toEqual({ t: "res", id: 7, ok: true, v: { git: null } });
    expect(checkIncoming({ t: "res", id: 7, ok: true, v: { git: null, x: 1 } }, pending)).toBeNull();
    expect(checkIncoming({ t: "res", id: 8, ok: true, v: { git: null } }, pending)).toBeNull();
    expect(checkIncoming({ t: "res", id: 7, ok: false, e: { code: "denied", m: "no" } }, pending)).toMatchObject({ ok: false });
    expect(checkIncoming({ t: "res", id: 7, ok: false, e: { code: "made-up" as never, m: "no" } }, pending)).toBeNull();
    expect(checkIncoming({ t: "req", id: 1, op: "hello", a: {} }, pending)).toBeNull();
    expect(checkIncoming({ t: "ev", ev: "console.stop", d: { at: "now" } }, pending)).toMatchObject({ ev: "console.stop" });
  });

  it("lets the worker kill ssh's group before it ends the thread (a thread ended first drops the message)", async () => {
    const seen: string[] = [];
    let toMain: ((m: FromWorker) => void) | null = null;
    let terminated = false;
    const port: LinkPort = {
      post: m => setImmediate(() => {
        if (terminated) return;
        seen.push(m.t);
        if (m.t === "kill") setImmediate(() => toMain?.({ t: "exit", code: null, signal: "SIGKILL", stderr: "", killed: "test" }));
      }),
      onMessage: fn => { toMain = fn; return () => { toMain = null; }; },
      onExit: () => () => undefined,
      terminate: async () => { terminated = true; seen.push("terminate"); },
    };
    const link = new WorkerLink(port, { id: "l", hostId: "h" });
    await link.kill("test");
    expect(seen).toEqual(["kill", "terminate"]);
    expect(link.state).toBe("lost");
  });

  it("times a request out and refuses one that breaks its own schema before it leaves", async () => {
    const posted: ToWorker[] = [];
    const port: LinkPort = { post: m => posted.push(m), onMessage: () => () => undefined, onExit: () => () => undefined, terminate: async () => undefined };
    const link = new WorkerLink(port, { id: "l", hostId: "h" });
    await expect(link.request("cmd.facts", {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    await expect(link.request("cmd.git", { cwd: "x".repeat(10_000) })).rejects.toMatchObject({ code: "bad_request" });
    expect(posted.filter(m => m.t === "req")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The seams with the link's users (INT): SC reads a channel's bytes after the answer that names it, and SB's agent may
// wait for this PC's previous agent before it answers hello.

describe("the link as its users rely on it (INT)", () => {
  /** A link over a port the test feeds as the worker would. */
  const fedLink = () => {
    let toMain: ((m: FromWorker) => void) | null = null;
    const port: LinkPort = { post: () => undefined, onMessage: fn => { toMain = fn; return () => { toMain = null; }; }, onExit: () => () => undefined, terminate: async () => undefined };
    const link = new WorkerLink(port, { id: "l", hostId: "h" });
    const bytes = (channel: number, data: number[] | Uint8Array) => {
      const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
      toMain?.({ t: "bytes", channel, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });
    };
    const state = (s: "ready" | "stalled" | "lost" | "closed") => toMain?.({ t: "state", state: s });
    return { link, bytes, state };
  };

  it("hands a channel's bytes that came first to its first listener, in order, before onBytes returns", () => {
    const { link, bytes } = fedLink();
    bytes(3, [1, 2]);
    bytes(3, [3]);
    bytes(4, [9]);
    const got: number[] = [];
    const off = link.onBytes(3, b => got.push(...b));
    expect(got).toEqual([1, 2, 3]);
    bytes(3, [4]);
    expect(got).toEqual([1, 2, 3, 4]);
    off();
    // Channel 4's bytes stay held for its own listener.
    const four: number[] = [];
    link.onBytes(4, b => four.push(...b));
    expect(four).toEqual([9]);
  });

  it("drops the bytes of a channel whose listeners all left, and never holds them again", () => {
    const { link, bytes } = fedLink();
    bytes(5, [1]);
    // dropChannel's way: subscribe and leave at once.
    link.onBytes(5, () => undefined)();
    bytes(5, [2, 3]);
    const late: number[] = [];
    link.onBytes(5, b => late.push(...b));
    expect(late).toEqual([]);
  });

  it("drops a channel past its bound, so its reader gets nothing and times out (fail closed)", () => {
    const { link, bytes } = fedLink();
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < HELD_CHANNEL_BYTES / chunk.length; i++) bytes(6, chunk);
    bytes(6, [1]);
    let got = 0;
    link.onBytes(6, b => { got += b.length; });
    expect(got).toBe(0);
    // Every channel's held bytes count towards one total too: past it, the channel held longest goes (a reader that gave
    // up on it, e.g. a picture whose answer came after its request timed out), never the fresh one.
    const full = HELD_TOTAL_BYTES / HELD_CHANNEL_BYTES;
    for (let ch = 10; ch < 10 + full; ch++) for (let i = 0; i < HELD_CHANNEL_BYTES / chunk.length; i++) bytes(ch, chunk);
    bytes(20, [7]);
    let twenty = 0;
    link.onBytes(20, b => { twenty += b.length; });
    expect(twenty).toBe(1);
    // The dropped channel's later bytes go nowhere either.
    bytes(10, [1]);
    const sizes = Array.from({ length: full }, (_, i) => { let n = 0; link.onBytes(10 + i, b => { n += b.length; }); return n; });
    expect(sizes).toEqual([0, ...Array.from({ length: full - 1 }, () => HELD_CHANNEL_BYTES)]);
  });

  it("never lets stale held channels starve every later picture", () => {
    const { link, bytes } = fedLink();
    const picture = new Uint8Array(3 * 1024 * 1024);
    // Many pictures whose readers never came (their requests timed out), then one whose reader comes now.
    for (let ch = 100; ch < 140; ch++) bytes(ch, picture);
    bytes(140, picture);
    let got = 0;
    link.onBytes(140, b => { got += b.length; });
    expect(got).toBe(picture.length);
  });

  it("lets held bytes go when the link is lost", () => {
    const { link, bytes, state } = fedLink();
    bytes(7, [1, 2, 3]);
    state("lost");
    let got = 0;
    link.onBytes(7, b => { got += b.length; });
    expect(got).toBe(0);
  });

  it("waits for hello longer than the agent may wait for this PC's previous agent (a reconnect can't time out by design)", async () => {
    // The agent's own lock (SB): this PC's previous agent never lets go; the new one waits, SIGTERMs, waits, SIGKILLs.
    for (const grace of [3, 20, 120]) {
      let clock = 0;
      const io: LockIo = {
        create: () => false, read: () => `4242 77 ${PC_ID}\n`, remove: () => undefined, startOf: () => "77",
        kill: () => undefined, sleep: async ms => { clock += ms; }, now: () => clock,
      };
      await expect(acquireLock({ file: "/s/lock", me: { pid: 1, start: "1", pcId: PC_ID }, graceMs: grace * 1000, io, log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, file: "" } })).rejects.toThrow();
      // 50 rounds of the full wait is the lock giving up altogether; one round is what a hello can meet.
      const oneRound = clock / 50;
      expect(helloTimeoutMs(grace)).toBeGreaterThanOrEqual(oneRound + 10_000);
    }
    expect(helloTimeoutMs(20)).toBeGreaterThan(25_000);
  });

  it("asks hello with that timeout (this PC's grace), not §5.4's plain 20 s", async () => {
    const spy = vi.spyOn(WorkerLink.prototype, "request");
    try {
      const r = track(rig({ admin: { policy: AdminPolicySchema.parse({ ssh: { commandGraceSeconds: 60 } }), source: "/etc/ember/policy.json" } }));
      await r.conns.connect(record(), { interactive: true });
      const call = spy.mock.calls.find(c => c[0] === "hello");
      expect(call?.[2]).toMatchObject({ timeoutMs: helloTimeoutMs(60) });
      expect(helloTimeoutMs(60)).toBe(75_000);
    } finally {
      spy.mockRestore();
    }
  });
});
