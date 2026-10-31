import { describe, expect, it, vi } from "vitest";
import { bindPipeApi, createAskpassPipe, PIPE_MODE, PIPE_OPEN_MODE, pipeName, pipeSddl, type PipeApi } from "../../app/main/remote/askpass-pipe";
import { ASKPASS_EXE, COMPILE_SCRIPT, ensureAskpassHelper, powershellPath, type AskpassWinDeps } from "../../app/main/remote/askpass-win";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SID = "S-1-5-21-1004336348-1177238915-682003330-1001";

/** A fake pipe: clients are queued; each connect takes the next, each read gives its bytes, writes are recorded. */
function fakeApi() {
  const clients: { data: Buffer[]; written: Buffer[]; gone: boolean }[] = [];
  let waiting: ((ok: boolean) => void) | null = null;
  let cur: (typeof clients)[number] | null = null;
  const log: string[] = [];
  const api: PipeApi = {
    userSid: () => SID,
    create: (name, openMode, pipeMode, sddl) => { log.push(`create ${name} ${openMode} ${pipeMode} ${sddl}`); return 7; },
    connect: (_h, done) => {
      const c = clients.shift();
      if (c) { cur = c; setImmediate(() => done(true)); } else waiting = done;
    },
    read: (_h, _max, done) => {
      const c = cur;
      setImmediate(() => {
        if (!c || c.gone) return done(null);
        const d = c.data.shift();
        if (d) done(d); else { c.gone = true; done(null); }
      });
    },
    write: (_h, data, done) => { cur?.written.push(data); setImmediate(() => done(true)); },
    // A synchronous handle runs one call at a time: a disconnect while a connect waits would hang the caller.
    disconnect: () => { log.push(waiting ? "disconnect behind a waiting connect" : "disconnect"); if (cur) cur.gone = true; },
    poke: name => { log.push(`poke ${name}`); const w = waiting; waiting = null; cur = null; w?.(true); },
    close: () => { log.push("close"); },
  };
  const client = (...lines: string[]) => {
    const c = { data: lines.map(l => Buffer.from(l)), written: [] as Buffer[], gone: false };
    clients.push(c);
    const w = waiting;
    waiting = null;
    if (w) { clients.pop(); cur = c; w(true); }
    return c;
  };
  return { api, log, client };
}

const settle = () => new Promise(r => setTimeout(r, 20));

describe("the Windows askpass pipe (§5.1.6, L15)", () => {
  it("admits only the user's SID, refuses remote clients and refuses a name someone made first", async () => {
    const { api, log } = fakeApi();
    const ch = await createAskpassPipe({ api, handler: async () => null, name: "\\\\.\\pipe\\ember-askpass-0011223344556677" });
    expect(log[0]).toBe(`create \\\\.\\pipe\\ember-askpass-0011223344556677 ${PIPE_OPEN_MODE} ${PIPE_MODE} D:P(A;;GA;;;${SID})`);
    expect(PIPE_OPEN_MODE & 0x0008_0000).toBeTruthy(); // FILE_FLAG_FIRST_PIPE_INSTANCE
    expect(PIPE_MODE & 0x8).toBeTruthy(); // PIPE_REJECT_REMOTE_CLIENTS
    expect(pipeName()).toMatch(/^\\\\\.\\pipe\\ember-askpass-[0-9a-f]{16}$/);
    expect(() => pipeSddl("S-1-5;(A;;GA;;;WD)")).toThrow();
    await ch.close();
    expect(log).toContain("poke \\\\.\\pipe\\ember-askpass-0011223344556677");
    expect(log.at(-1)).toBe("close");
  });

  it("answers a helper with the right nonce, and the next one after it", async () => {
    const { api, client } = fakeApi();
    const ch = await createAskpassPipe({ api, handler: async r => `answer to ${r.prompt}` });
    const req = (p: string) => `${JSON.stringify({ v: 1, nonce: ch.nonce, mode: "secret", prompt: p })}\n`;
    const a = client(req("one").slice(0, 10), req("one").slice(10));
    await settle();
    const b = client(req("two"));
    await settle();
    expect(a.written.map(String)).toEqual([`{"ok":true,"value64":"${Buffer.from("answer to one").toString("base64")}"}\n`]);
    expect(b.written.map(String)).toEqual([`{"ok":true,"value64":"${Buffer.from("answer to two").toString("base64")}"}\n`]);
    await ch.close();
  });

  it("disconnects a wrong nonce without asking anyone", async () => {
    const { api, client } = fakeApi();
    const handler = vi.fn(async () => "x");
    const ch = await createAskpassPipe({ api, handler });
    const c = client(`${JSON.stringify({ v: 1, nonce: "0".repeat(32), mode: "secret", prompt: "p" })}\n`);
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(c.written).toEqual([]);
    await ch.close();
  });

  it("writes nothing for a touch notice and ends it when ssh kills the helper", async () => {
    const { api, client } = fakeApi();
    let aborted = false;
    const ch = await createAskpassPipe({ api, handler: (_r, signal) => new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(null); })) });
    const c = client(`${JSON.stringify({ v: 1, nonce: ch.nonce, mode: "notify", prompt: "Confirm user presence" })}\n`);
    await settle();
    expect(aborted).toBe(true);
    expect(c.written).toEqual([]);
    await ch.close();
  });

  it("wakes a waiting connect before it lets go of the pipe, so no call waits behind it (synchronous handle)", async () => {
    const { api, log, client } = fakeApi();
    const ch = await createAskpassPipe({ api, handler: async () => "pw" });
    client(`${JSON.stringify({ v: 1, nonce: ch.nonce, mode: "secret", prompt: "p" })}\n`);
    await settle();
    // Answered, disconnected between calls, and waiting for the next helper again.
    expect(log.filter(l => l.startsWith("disconnect"))).toEqual(["disconnect"]);
    log.length = 0;
    await ch.close();
    expect(log).toEqual([expect.stringMatching(/^poke /), "close"]);
  });

  it("leaves a read that ends after close alone: the handle is no longer its to disconnect", async () => {
    const { api, log } = fakeApi();
    let finishRead: ((d: Buffer | null) => void) | null = null;
    let connected: ((ok: boolean) => void) | null = null;
    const slow: PipeApi = { ...api, connect: (_h, done) => { connected = done; }, read: (_h, _m, done) => { finishRead = done; } };
    const ch = await createAskpassPipe({ api: slow, handler: async () => null });
    (connected as unknown as (ok: boolean) => void)(true);
    await settle();
    const closing = ch.close();
    await settle();
    (finishRead as unknown as (d: Buffer | null) => void)(null);
    await closing;
    expect(log.filter(l => l.startsWith("disconnect"))).toEqual([]);
    expect(log.at(-1)).toBe("close");
  });

  it("fails closed without the user's SID", async () => {
    const { api } = fakeApi();
    await expect(createAskpassPipe({ api: { ...api, userSid: () => null }, handler: async () => null })).rejects.toThrow();
    await expect(createAskpassPipe({ api: { ...api, create: () => null }, handler: async () => null })).rejects.toThrow();
  });

  it("binds CreateNamedPipeW with one instance and a SECURITY_ATTRIBUTES holding the DACL", () => {
    const calls: Record<string, unknown[][]> = {};
    const fn = (name: string, ret: (...a: unknown[]) => unknown) => Object.assign((...a: unknown[]) => { (calls[name] ??= []).push(a); return ret(...a); }, { async: () => undefined });
    const sd = { pointer: "sd" };
    const impl: Record<string, (...a: unknown[]) => unknown> = {
      ConvertStringSecurityDescriptorToSecurityDescriptorW: (_s, _r, out) => { (out as unknown[])[0] = sd; return 1; },
      CreateNamedPipeW: () => 42,
      LocalFree: () => null,
    };
    const koffi = {
      sizeof: () => 8,
      encode: (buf: Buffer, off: number, _t: string, v: unknown) => { buf.writeUInt32LE(v === sd ? 0xabcd : 0, off); },
      decode: Object.assign(() => null, { string16: () => SID }),
    };
    const api = bindPipeApi(koffi as never, () => ({ func: (decl: string) => { const n = /(\w+)\s*\(/.exec(decl)?.[1] ?? ""; return fn(n, impl[n] ?? (() => 0)); } }) as never);
    expect(api.create("\\\\.\\pipe\\ember-askpass-1", PIPE_OPEN_MODE, PIPE_MODE, pipeSddl(SID))).toBe(42);
    const [name, open, mode, instances, , , , sa] = calls.CreateNamedPipeW[0] as [Buffer, number, number, number, number, number, number, Buffer];
    expect(name.toString("utf16le")).toBe("\\\\.\\pipe\\ember-askpass-1\0");
    expect([open, mode, instances]).toEqual([PIPE_OPEN_MODE, PIPE_MODE, 1]);
    expect(sa.readUInt32LE(0)).toBe(24);
    expect(sa.readUInt32LE(8)).toBe(0xabcd);
    expect((calls.ConvertStringSecurityDescriptorToSecurityDescriptorW[0][0] as Buffer).toString("utf16le")).toBe(`D:P(A;;GA;;;${SID})\0`);
    expect(calls.LocalFree).toHaveLength(1);
  });
});

describe("the compiled Windows helper (§5.1.6)", () => {
  const SRC = Buffer.from("public static class EmberAskpass { }");
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

  function deps(o: { languageMode?: string; compileOk?: boolean; files?: Map<string, Buffer> } = {}) {
    const files = o.files ?? new Map<string, Buffer>([["C:\\Program Files\\Ember\\resources\\ssh\\ember_askpass.cs", SRC]]);
    const runs: { argv: string[]; stdin: string; env: Record<string, string> }[] = [];
    const d: AskpassWinDeps = {
      userData: "C:\\Users\\ana\\AppData\\Roaming\\Ember",
      source: "C:\\Program Files\\Ember\\resources\\ssh\\ember_askpass.cs",
      powershell: powershellPath("C:\\Windows"),
      env: { SystemRoot: "C:\\Windows" },
      // A fake Windows PowerShell 5.1: compiles (writes the exe) only in FullLanguage, as Add-Type does.
      run: async (argv, ro) => {
        runs.push({ argv, stdin: ro.stdin, env: ro.env });
        if ((o.languageMode ?? "FullLanguage") !== "FullLanguage") return { code: 3, stdout: "EMBER-CLM\r\n" };
        if (o.compileOk === false) return { code: 1, stdout: "" };
        files.set(ro.env.EMBER_ASKPASS_OUT, Buffer.from(`MZ compiled from ${sha(files.get(ro.env.EMBER_ASKPASS_SRC) ?? "")}`));
        return { code: 0, stdout: "EMBER-OK\r\n" };
      },
      fs: {
        readFile: async p => { const b = files.get(p); if (!b) throw new Error("ENOENT"); return b; },
        writeFile: async (p, data) => { files.set(p, Buffer.from(data)); },
        rename: async (a, b) => { files.set(b, files.get(a) as Buffer); files.delete(a); },
        rm: async p => { files.delete(p); },
        mkdir: async () => undefined,
      },
    };
    return { d, runs, files };
  }

  it("compiles in FullLanguage with Add-Type into <userData>\\ssh, the paths passed through the environment", async () => {
    const { d, runs, files } = deps();
    expect(await ensureAskpassHelper(d)).toEqual({ exe: `C:\\Users\\ana\\AppData\\Roaming\\Ember\\ssh\\${ASKPASS_EXE}` });
    expect(runs).toHaveLength(1);
    expect(runs[0].argv).toEqual(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
    expect(runs[0].stdin).toBe(COMPILE_SCRIPT);
    expect(COMPILE_SCRIPT).toContain("-OutputType ConsoleApplication");
    expect(COMPILE_SCRIPT).toContain("-ne 'FullLanguage'");
    expect(COMPILE_SCRIPT).not.toContain("C:\\");
    expect(runs[0].env.EMBER_ASKPASS_SRC).toBe(d.source);
    expect(files.get(`C:\\Users\\ana\\AppData\\Roaming\\Ember\\ssh\\${ASKPASS_EXE}`)).toBeTruthy();
  });

  it("never compiles in Constrained Language Mode", async () => {
    const { d, files } = deps({ languageMode: "ConstrainedLanguage" });
    expect(await ensureAskpassHelper(d)).toEqual({ error: "clm" });
    expect([...files.keys()].some(k => k.endsWith(".exe"))).toBe(false);
  });

  it("reuses a build whose hash still matches, and rebuilds a changed build or a changed source", async () => {
    const { d, runs, files } = deps();
    await ensureAskpassHelper(d);
    await ensureAskpassHelper(d);
    expect(runs).toHaveLength(1);
    files.set(`C:\\Users\\ana\\AppData\\Roaming\\Ember\\ssh\\${ASKPASS_EXE}`, Buffer.from("MZ tampered"));
    await ensureAskpassHelper(d);
    expect(runs).toHaveLength(2);
    files.set(d.source, Buffer.from("// an Ember update"));
    await ensureAskpassHelper(d);
    expect(runs).toHaveLength(3);
  });

  it("reports a blocked compile or a missing source", async () => {
    expect(await ensureAskpassHelper(deps({ compileOk: false }).d)).toMatchObject({ error: "compile" });
    expect(await ensureAskpassHelper(deps({ files: new Map() }).d)).toEqual({ error: "source" });
  });

  it("ships a source the C# compiler can read: ASCII only, every line break in a literal escaped", () => {
    const src = readFileSync(join(__dirname, "..", "..", "resources", "ssh", "ember_askpass.cs"), "utf8");
    // U+2028 and U+2029 are line breaks to C#: inside a character literal they end it ("newline in constant").
    expect([...src].filter(c => c.charCodeAt(0) > 0x7f)).toEqual([]);
    expect(src).toContain("'\\u2028'");
    expect(src).toMatch(/public static int Main\(string\[\] args\)/);
    expect(src).toContain("EMBER_ASKPASS_PIPE");
    // The prompt is data: nothing in the helper starts a process or reads its argument as anything else.
    expect(src).not.toMatch(/Process\.Start|Assembly\.Load|Invoke\(/);
  });

  it("finds Windows PowerShell by absolute path", () => {
    expect(powershellPath(undefined)).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath("D:\\WIN\\")).toBe("D:\\WIN\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});
