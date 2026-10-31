import { Duplex, PassThrough } from "node:stream";
import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { runAskpass } from "../../app/askpass/main";
import { answerFor, answerLine, createAskpassServer, parseRequest, pickSocketBase, promptCard, requestLine, serveConnections, socketBases, writeAskpassWrapper, type AskpassFs, type AskpassHandler } from "../../app/main/remote/askpass-server";

const NONCE = "0123456789abcdef0123456789abcdef";
const ctx = { id: "p1", host: "build-01", names: ["build-01", "build-01.example.com", "203.0.113.7"], client: { major: 9, minor: 6 } };
/** RHEL 8's client (8.0p1): it hands a server's keyboard-interactive prompts to askpass unmarked. */
const old = { ...ctx, client: { major: 8, minor: 0 } };

/** Two in-memory sockets wired to each other (a helper's end and the server's end). */
function socketPair(): [Duplex, Duplex] {
  const aToB = new PassThrough(), bToA = new PassThrough();
  const make = (read: PassThrough, write: PassThrough) => {
    const d = new Duplex({
      read() { /* pushed from `read` below */ },
      write(chunk, _enc, cb) { write.write(chunk); cb(); },
      final(cb) { write.end(); cb(); },
    });
    read.on("data", c => d.push(c));
    read.on("end", () => { d.push(null); setImmediate(() => d.destroy()); });
    d.on("close", () => { if (!write.writableEnded) write.end(); });
    return d;
  };
  return [make(bToA, aToB), make(aToB, bToA)];
}

/** A connection the test drives by hand: a helper that exits emits `close` while it waits its turn. */
class FakeConn {
  private fns = new Map<string, ((...a: never[]) => void)[]>();
  written: string[] = [];
  on(ev: string, fn: (...a: never[]) => void): this {
    const list = this.fns.get(ev) ?? [];
    list.push(fn);
    this.fns.set(ev, list);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const fn of this.fns.get(ev) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  write(s: string): boolean { this.written.push(s); return true; }
  end(): void { this.emit("close"); }
  destroy(): void { this.emit("close"); }
}

const flush = () => new Promise<void>(r => setImmediate(r));

/** Runs the real helper against serveConnections over an in-memory pair. */
async function ask(prompt: string, handler: AskpassHandler, o: { nonce?: string; hint?: string; serverNonce?: string } = {}) {
  const [client, server] = socketPair();
  serveConnections(o.serverNonce ?? NONCE, handler)(server as unknown as net.Socket);
  const out: string[] = [];
  const code = await runAskpass({
    argv: ["/opt/Ember/ember", "/opt/Ember/resources/app/dist/app/askpass.cjs", prompt],
    env: { EMBER_ASKPASS_SOCK: "/run/user/1000/ea-abc123/a.sock", EMBER_ASKPASS_NONCE: o.nonce ?? NONCE, ...(o.hint ? { SSH_ASKPASS_PROMPT: o.hint } : {}) },
    write: t => out.push(t),
    connect: () => { setImmediate(() => client.emit("connect")); return client as unknown as net.Socket; },
  });
  return { code, out: out.join("") };
}

describe("the prompt cards for ssh's prompts (§5.1.6, §8.6)", () => {
  it("shows a new host key with its address and fingerprint", () => {
    const prompt = "The authenticity of host 'build-01.example.com (203.0.113.7)' can't be established.\nED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
    expect(promptCard({ prompt, mode: "confirm" }, ctx)).toEqual({ id: "p1", kind: "host-key", host: "build-01", address: "203.0.113.7", fingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" });
  });

  it("tells a passphrase, the target's password, a jump host's password and a code apart", () => {
    expect(promptCard({ prompt: "Enter passphrase for key '/home/ana/.ssh/id_ed25519': ", mode: "secret" }, ctx)).toMatchObject({ kind: "secret", secret: "passphrase", host: "build-01" });
    expect(promptCard({ prompt: "deploy@build-01.example.com's password: ", mode: "secret" }, ctx)).toEqual({ id: "p1", kind: "secret", secret: "password", host: "build-01", login: "deploy", prompt: "deploy@build-01.example.com's password: " });
    // A jump hop's prompt names its own host: the card says "on the way to build-01" (critique remote-4).
    expect(promptCard({ prompt: "deploy@bastion's password: ", mode: "secret" }, ctx)).toMatchObject({ secret: "password", host: "build-01", via: "bastion", login: "deploy" });
    expect(promptCard({ prompt: "(deploy@bastion) Password: ", mode: "secret" }, ctx)).toMatchObject({ secret: "password", via: "bastion" });
    expect(promptCard({ prompt: "(deploy@build-01) Verification code: ", mode: "secret" }, ctx)).toMatchObject({ secret: "code" });
    expect(promptCard({ prompt: "Enter your one-time password", mode: "secret" }, ctx)).toMatchObject({ secret: "code" });
    expect(promptCard({ prompt: "Favourite colour? ", mode: "secret" }, ctx)).toMatchObject({ secret: "other" });
    // A server asking in the words of ssh's own passphrase prompt is still the server asking, under its own name.
    expect(promptCard({ prompt: "(deploy@build-01) Enter passphrase for key '/home/ana/.ssh/id_ed25519': ", mode: "secret" }, ctx)).toMatchObject({ secret: "other", login: "deploy" });
  });

  it("quotes every secret as the host's question on a client before 8.5, where a server can ask in ssh's own words", () => {
    const passphrase = "Enter passphrase for key '/home/alice/.ssh/id_ed25519': ";
    const other = "alice@corp-sso.example.com's password: ";
    for (const c of [old, { ...ctx, client: { major: 8, minor: 4 } }, { id: "p1", host: "build-01", names: ctx.names }]) {
      expect(promptCard({ prompt: passphrase, mode: "secret" }, c)).toEqual({ id: "p1", kind: "secret", secret: "other", host: "build-01", prompt: passphrase });
      // Never "Sign in to corp-sso on the way to build-01": no via, no login.
      expect(promptCard({ prompt: other, mode: "secret" }, c)).toEqual({ id: "p1", kind: "secret", secret: "other", host: "build-01", prompt: other });
      expect(promptCard({ prompt: "deploy@build-01.example.com's password: ", mode: "secret" }, c)).toMatchObject({ secret: "other" });
    }
    // 8.5 marks the server's prompts, so ssh's own unmarked ones are ssh's.
    expect(promptCard({ prompt: passphrase, mode: "secret" }, { ...ctx, client: { major: 8, minor: 5 } })).toMatchObject({ secret: "passphrase" });
    expect(promptCard({ prompt: other, mode: "secret" }, { ...ctx, client: { major: 8, minor: 5 } })).toMatchObject({ secret: "password", via: "corp-sso.example.com" });
    // A host key's card hands ssh only "yes"; a touch answers nothing: both stay.
    const hostKey = "The authenticity of host 'build-01.example.com (203.0.113.7)' can't be established.\nED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
    expect(promptCard({ prompt: hostKey, mode: "secret" }, old)).toMatchObject({ kind: "host-key" });
    expect(promptCard({ prompt: "Confirm user presence for key ED25519-SK SHA256:abc", mode: "secret" }, old)).toMatchObject({ kind: "touch" });
  });

  it("shows a security key's touch as a notice", () => {
    expect(promptCard({ prompt: "Confirm user presence for key ED25519-SK SHA256:abc", mode: "notify" }, ctx)).toEqual({ id: "p1", kind: "touch", host: "build-01" });
  });

  it("hands ssh \"yes\" only for a trusted key, the typed text for a secret, and nothing with a line break", () => {
    const key = { id: "p", kind: "host-key" as const, host: "h", address: "a", fingerprint: "SHA256:x" };
    const pw = { id: "p", kind: "secret" as const, secret: "password" as const, host: "h", prompt: "p" };
    expect(answerFor(key, { ok: true })).toBe("yes");
    expect(answerFor(key, { ok: false })).toBeNull();
    expect(answerFor(pw, { ok: true, value: "hunter2" })).toBe("hunter2");
    expect(answerFor(pw, { ok: true, value: "a\nyes" })).toBeNull();
    expect(answerFor({ id: "p", kind: "touch", host: "h" }, { ok: true })).toBeNull();
  });
});

describe("the askpass channel", () => {
  it("answers the helper, which prints the answer for ssh", async () => {
    const handler = vi.fn(async () => "correct horse battery staple");
    const r = await ask("deploy@build-01's password: ", handler);
    expect(r).toEqual({ code: 0, out: "correct horse battery staple\n" });
    expect(handler).toHaveBeenCalledWith({ prompt: "deploy@build-01's password: ", mode: "secret" }, expect.any(AbortSignal));
  });

  it("passes non-ASCII answers through unchanged", async () => {
    expect(await ask("Password: ", async () => "pässwörd✓")).toEqual({ code: 0, out: "pässwörd✓\n" });
  });

  it("cancels with exit 1", async () => {
    expect((await ask("Password: ", async () => null)).code).toBe(1);
  });

  it("gives a wrong nonce no answer at all and never asks the user", async () => {
    const handler = vi.fn(async () => "secret");
    expect((await ask("Password: ", handler, { serverNonce: "f".repeat(32) })).code).toBe(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("tells ssh's confirm and notice prompts by SSH_ASKPASS_PROMPT", async () => {
    const seen: string[] = [];
    await ask("Are you sure (yes/no)?", async r => { seen.push(r.mode); return "yes"; }, { hint: "confirm" });
    await ask("Confirm user presence", async r => { seen.push(r.mode); return null; }, { hint: "none" });
    expect(seen).toEqual(["confirm", "notify"]);
  });

  it("refuses to run without a well-formed socket and nonce", async () => {
    const io = { argv: ["n", "s", "p"], write: () => undefined, connect: () => { throw new Error("must not connect"); } };
    expect(await runAskpass({ ...io, env: { EMBER_ASKPASS_SOCK: "/s", EMBER_ASKPASS_NONCE: "short" } })).toBe(1);
    expect(await runAskpass({ ...io, env: { EMBER_ASKPASS_SOCK: "relative", EMBER_ASKPASS_NONCE: NONCE } })).toBe(1);
  });

  it("asks one prompt at a time", async () => {
    let open = 0, most = 0;
    const handler: AskpassHandler = async () => { open++; most = Math.max(most, open); await new Promise(r => setTimeout(r, 20)); open--; return "x"; };
    const serve = serveConnections(NONCE, handler);
    const runs = [0, 1, 2].map(() => {
      const [client, server] = socketPair();
      serve(server as unknown as net.Socket);
      return runAskpass({ argv: ["n", "s", "p"], env: { EMBER_ASKPASS_SOCK: "/s/a.sock", EMBER_ASKPASS_NONCE: NONCE }, write: () => undefined, connect: () => { setImmediate(() => client.emit("connect")); return client as unknown as net.Socket; } });
    });
    expect(await Promise.all(runs)).toEqual([0, 0, 0]);
    expect(most).toBe(1);
  });

  it("still asks the next helper after one waiting its turn exits", async () => {
    const asks: string[] = [];
    let answerFirst!: (v: string | null) => void;
    const handler: AskpassHandler = req => {
      asks.push(req.prompt);
      if (asks.length === 1) return new Promise<string | null>(r => { answerFirst = r; });
      return Promise.resolve("x");
    };
    const serve = serveConnections(NONCE, handler);
    const send = async (conn: FakeConn, prompt: string) => {
      serve(conn as unknown as net.Socket);
      await flush();
      conn.emit("data", requestLine(NONCE, { prompt, mode: "secret" }));
      await flush();
    };

    const first = new FakeConn();
    await send(first, "first");
    expect(asks).toEqual(["first"]);

    // A second helper arrives while the first prompt is open, then gives up and exits before its turn.
    const second = new FakeConn();
    serve(second as unknown as net.Socket);
    await flush();
    second.emit("close");
    await flush();

    answerFirst("one");
    await flush();

    const third = new FakeConn();
    await send(third, "third");
    expect(asks).toEqual(["first", "third"]);
    expect(third.written).toEqual([answerLine("x")]);
  });

  it("checks requests strictly", () => {
    const line = (o: object) => JSON.stringify(o);
    expect(parseRequest(line({ v: 1, nonce: NONCE, mode: "secret", prompt: "p" }), NONCE)).toEqual({ prompt: "p", mode: "secret" });
    expect(parseRequest(line({ v: 1, nonce: NONCE, mode: "secret", prompt: "x".repeat(5000) }), NONCE)?.prompt.length).toBe(2048);
    expect(parseRequest(line({ v: 1, nonce: NONCE, mode: "evil", prompt: "p" }), NONCE)).toBeNull();
    expect(parseRequest(line({ v: 2, nonce: NONCE, mode: "secret", prompt: "p" }), NONCE)).toBeNull();
    expect(parseRequest("not json", NONCE)).toBeNull();
    expect(parseRequest(line({ v: 1, nonce: NONCE, mode: "secret", prompt: "y".repeat(20_000) }), NONCE)).toBeNull();
    expect(answerLine(null)).toBe("{\"ok\":false}\n");
    expect(answerLine("é")).toBe(`{"ok":true,"value64":"${Buffer.from("é").toString("base64")}"}\n`);
  });
});

describe("where the socket goes (critique remote-24)", () => {
  it("prefers XDG_RUNTIME_DIR on Linux and the per-user temporary folder on macOS, /tmp last", () => {
    expect(socketBases({ os: "linux", userData: "/home/ana/.config/ember", xdgRuntimeDir: "/run/user/1000" })).toEqual(["/run/user/1000", "/home/ana/.config/ember/ssh", "/tmp"]);
    expect(socketBases({ os: "darwin", userData: "/Users/ana/Library/Application Support/Ember", darwinTemp: "/var/folders/x1/abc/T/" })[0]).toBe("/var/folders/x1/abc/T/");
    expect(socketBases({ os: "linux", userData: "/u", xdgRuntimeDir: "relative" })).toEqual(["/u/ssh", "/tmp"]);
  });

  it("keeps the socket path within 100 bytes", () => {
    const long = `/Users/${"a".repeat(50)}/Library/Application Support/Ember/ssh`;
    expect(pickSocketBase([long, "/tmp"])).toBe("/tmp");
    expect(pickSocketBase(["/run/user/1000", "/tmp"])).toBe("/run/user/1000");
  });

  it("makes a fresh 0700 folder per run and removes it on close", async () => {
    const calls: string[] = [];
    const fs: AskpassFs = {
      mkdir: async p => { calls.push(`mkdir ${p}`); },
      mkdtemp: async prefix => { calls.push(`mkdtemp ${prefix}`); return `${prefix}Xy12Ab`; },
      rm: async p => { calls.push(`rm ${p}`); },
      readFile: async () => "", writeFile: async () => undefined, chmod: async () => undefined, rename: async () => undefined,
    };
    let listened = "";
    const ch = await createAskpassServer({ bases: ["/run/user/1000", "/tmp"], fs, handler: async () => null, listen: async p => { listened = p; return { close: () => calls.push("close") }; } });
    expect(ch.address).toBe("/run/user/1000/ea-Xy12Ab/a.sock");
    expect(listened).toBe(ch.address);
    expect(ch.nonce).toMatch(/^[0-9a-f]{32}$/);
    await ch.close();
    expect(calls).toEqual(["mkdir /run/user/1000", "mkdtemp /run/user/1000/ea-", "close", "rm /run/user/1000/ea-Xy12Ab"]);
  });
});

describe("the askpass wrapper", () => {
  const memoryFs = () => {
    const files = new Map<string, { text: string; mode: number }>();
    const fs: AskpassFs = {
      mkdir: async () => undefined, mkdtemp: async p => p, rm: async () => undefined,
      readFile: async p => { const f = files.get(p); if (!f) throw new Error("ENOENT"); return f.text; },
      writeFile: async (p, text, o) => { files.set(p, { text, mode: o.mode }); },
      chmod: async (p, mode) => { const f = files.get(p); if (f) f.mode = mode; },
      rename: async (a, b) => { files.set(b, files.get(a) as { text: string; mode: number }); files.delete(a); },
    };
    return { fs, files };
  };

  it("runs Ember as plain Node on askpass.cjs on Linux, with the prompt after the script path, 0700", async () => {
    const { fs, files } = memoryFs();
    const path = await writeAskpassWrapper({ fs, os: "linux", userData: "/home/ana/.config/ember", execPath: "/opt/Ember/ember", appDir: "/opt/Ember/resources/app/dist/app" });
    expect(path).toBe("/home/ana/.config/ember/ssh/askpass");
    expect(files.get(path)).toEqual({ text: "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/Ember/ember' '/opt/Ember/resources/app/dist/app/askpass.cjs' \"$@\"\n", mode: 0o700 });
    const odd = await writeAskpassWrapper({ fs, os: "linux", userData: "/u", execPath: "/opt/it's/ember", appDir: "/a" });
    expect(files.get(odd)?.text).toContain("'/opt/it'\\''s/ember'");
  });

  it("runs Ember itself on macOS, in its askpass mode, with the prompt in its environment, never in node mode (review #177)", async () => {
    const { fs, files } = memoryFs();
    const userData = "/Users/ana/Library/Application Support/ember";
    const path = await writeAskpassWrapper({ fs, os: "darwin", userData, execPath: "/Applications/Ember.app/Contents/MacOS/Ember", appDir: "/Applications/Ember.app/Contents/Resources/app/dist/app" });
    expect(path).toBe(`${userData}/ssh/askpass`);
    // The prompt (a server's text, from 8.5 marked as such) never reaches Ember's command line, where Chromium or AppKit
    // could read it as a switch; a packaged Ember loads its own app folder by itself.
    expect(files.get(path)).toEqual({
      text: "#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nEMBER_ASKPASS_PROMPT=\"$*\"\nexport EMBER_ASKPASS_PROMPT\nexec '/Applications/Ember.app/Contents/MacOS/Ember' --ember-askpass\n",
      mode: 0o700,
    });
    // The development Electron is told which app to run: the tree's.
    const dev = await writeAskpassWrapper({ fs, os: "darwin", userData: "/u", execPath: "/Users/ana/src/ember/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", appDir: "/Users/ana/src/ember/dist/app" });
    expect(files.get(dev)?.text).toMatch(/\nexec '\/Users\/ana\/src\/ember\/node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron' '\/Users\/ana\/src\/ember' --ember-askpass\n$/);
    expect(files.get(dev)?.text).not.toContain("askpass.cjs");
  });
});
