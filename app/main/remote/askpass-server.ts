/**
 * Ember's own prompt for SSH (§5.1.6): when an interactive connect needs a password, a key's passphrase, a code or a
 * new host key's acceptance, ssh runs Ember's askpass helper, which asks this server, which asks the prompt window.
 * The answer goes only from the prompt window to ssh: it is never logged, stored, audited or sent to a model, and it is
 * not kept after the write. The channel is local IPC, not a network listener: on Linux and macOS a Unix socket made
 * for one ssh run in a fresh 0700 mkdtemp folder (short enough for macOS's 104-byte sun_path, critique remote-24),
 * with a per-run nonce and one prompt at a time; Windows uses a named pipe (askpass-pipe.ts) with the same messages.
 * The prompt is ssh's text, partly the server's (keyboard-interactive): untrusted, bounded, and shown as text only.
 */

import { randomBytes } from "node:crypto";
import net from "node:net";
import posix from "node:path/posix";
import type { OS } from "../../shared/shortcuts";
import type { PromptCard } from "../../shared/remote-ui";
import type { Logger } from "../logger";
import { ASKPASS_SWITCH } from "../../askpass/in-ember";
import { shQuote } from "./ssh-argv";
import { versionAtLeast, type SshVersion } from "./ssh-config";

/** The longest prompt kept (ssh's text, cut): §5.1.6's 2 KiB. */
export const PROMPT_MAX = 2048;
/** The longest request line read from a helper. */
export const REQUEST_MAX = 16 * 1024;
/** The longest socket path used (sun_path is 104 bytes on macOS, 108 on Linux; with room for the NUL). */
export const SOCKET_PATH_MAX = 100;

/** What the helper asks: ssh's prompt and how ssh means it (SSH_ASKPASS_PROMPT: confirm, or none for a notice). */
export interface AskpassRequest { prompt: string; mode: "secret" | "confirm" | "notify" }

/** Answers one request: the text for ssh, or null to cancel; `signal` fires when the helper goes away (ssh killed it). */
export type AskpassHandler = (req: AskpassRequest, signal: AbortSignal) => Promise<string | null>;

/** One run's askpass channel. */
export interface AskpassChannel {
  /** The socket path (EMBER_ASKPASS_SOCK) or pipe name (EMBER_ASKPASS_PIPE). */
  readonly address: string;
  /** EMBER_ASKPASS_NONCE: 32 random hex digits. */
  readonly nonce: string;
  /** Stops listening, ends any open prompt and removes the socket and its folder. */
  close(): Promise<void>;
}

/** A fresh nonce. */
export function askpassNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The helper's request line: `{ v: 1, nonce, mode, prompt }` (JSON, one line). */
export function requestLine(nonce: string, req: AskpassRequest): string {
  return `${JSON.stringify({ v: 1, nonce, mode: req.mode, prompt: req.prompt.slice(0, PROMPT_MAX) })}\n`;
}

/** The server's answer line: `{"ok":true,"value64":"…"}` (base64, so the Windows helper needs no JSON parser) or `{"ok":false}`. */
export function answerLine(value: string | null): string {
  return value === null ? "{\"ok\":false}\n" : `${JSON.stringify({ ok: true, value64: Buffer.from(value, "utf8").toString("base64") })}\n`;
}

/** A request line checked against this run's nonce: the request, or null (wrong nonce, malformed, oversized). */
export function parseRequest(line: string, nonce: string): AskpassRequest | null {
  if (line.length > REQUEST_MAX) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.nonce !== "string" || r.nonce !== nonce || typeof r.prompt !== "string") return null;
  const mode = r.mode === "confirm" || r.mode === "notify" ? r.mode : r.mode === "secret" ? "secret" : null;
  if (!mode) return null;
  return { prompt: r.prompt.slice(0, PROMPT_MAX), mode };
}

/**
 * The names that mean the target host itself (its label, alias, resolved host name, HostKeyAlias), compared in lower
 * case, and the version of the ssh client that asks (unknown counts as one that doesn't mark a server's prompts).
 */
export interface PromptContext { id: string; host: string; names: readonly string[]; client?: Pick<SshVersion, "major" | "minor"> }

/**
 * Does this client mark a server's keyboard-interactive prompts as the server's? OpenSSH puts "(user@host) " before
 * them from 8.5 on; older clients hand the server's text to askpass as it came, so it can't be told from ssh's own.
 */
export function serverPromptsMarked(client: Pick<SshVersion, "major" | "minor"> | undefined): boolean {
  return !!client && versionAtLeast(client, 8, 5);
}

const named = (ctx: PromptContext, h: string) => ctx.names.some(n => n.toLowerCase() === h.toLowerCase()) || ctx.host.toLowerCase() === h.toLowerCase();

/**
 * The prompt window's card for one of ssh's prompts (§5.1.6, §8.6), by pattern: a host key (`SHA256:`), a key's
 * passphrase, a password (`user@host's password:` or `(user@host) Password:`), a code (keyboard-interactive), a
 * security key's touch, or anything else. A prompt that names another host than the target (a jump hop's) gets `via`.
 * On a client that doesn't mark a server's prompts (before 8.5), every secret is the host's question, quoted.
 */
export function promptCard(req: AskpassRequest, ctx: PromptContext): PromptCard {
  const p = req.prompt;
  const fp = /SHA256:[A-Za-z0-9+/]{20,86}=?/.exec(p);
  if (fp && /authenticity of host|fingerprint|continue connecting/i.test(p)) {
    const who = /host '([^']{1,300})'/.exec(p)?.[1] ?? "";
    const address = /\(([^()]{1,200})\)/.exec(who)?.[1] ?? who;
    return { id: ctx.id, kind: "host-key", host: ctx.host, address: address.slice(0, 200), fingerprint: fp[0] };
  }
  if (req.mode === "notify" || /Confirm user presence|touch your (security )?key|Touch (the )?(security )?key/i.test(p)) {
    return { id: ctx.id, kind: "touch", host: ctx.host };
  }
  // Before 8.5 a hostile server (the target or a hop) can ask in ssh's own words: "Enter passphrase for key …" would
  // be "Unlock your SSH key", and another host's "user@host's password:" a sign-in to that host, each answer going to
  // the server. So no secret there is worded as ssh's or a hop's: the host asks, its text quoted. A host key's card
  // stays (its answer is only "yes", nothing a server could use), and so does a touch (it answers nothing).
  if (!serverPromptsMarked(ctx.client)) return { id: ctx.id, kind: "secret", secret: "other", host: ctx.host, prompt: p };
  // ssh's own prompt for a key starts the text; a server's keyboard-interactive prompt that only says the same words
  // (ssh 8.5+ puts "(user@host) " before it) is the server asking, never "Unlock your SSH key".
  if (/^Enter passphrase for key '/.test(p)) {
    return { id: ctx.id, kind: "secret", secret: "passphrase", host: ctx.host, prompt: p };
  }
  const who = /^\s*\(?([A-Za-z0-9._-]{1,64})@([A-Za-z0-9._:[\]-]{1,255})(?:'s|\))\s/.exec(p);
  const login = who?.[1];
  const promptHost = who?.[2].replace(/^\[|\]$/g, "");
  const via = promptHost && !named(ctx, promptHost) ? promptHost : undefined;
  const base = { id: ctx.id, kind: "secret" as const, host: ctx.host, ...(via ? { via } : {}), ...(login ? { login } : {}), prompt: p };
  if (/verification|one[- ]time|\botp\b|\b2fa\b|two[- ]factor|\bduo\b|\btoken\b|passcode|\bpin\b|\bcode\b/i.test(p)) return { ...base, secret: "code" };
  if (/password/i.test(p)) return { ...base, secret: "password" };
  return { ...base, secret: "other" };
}

/** What the user's answer to a card means for ssh: "yes" for a trusted host key, the typed text, or null (cancel). */
export function answerFor(card: PromptCard, answer: { ok: boolean; value?: string }): string | null {
  if (!answer.ok) return null;
  if (card.kind === "host-key") return "yes";
  if (card.kind !== "secret") return null;
  const v = answer.value ?? "";
  // ssh reads one line: a line break would end the answer early or smuggle a second one.
  return /[\r\n\0]/.test(v) || v.length > 4096 ? null : v;
}

/**
 * Serves one connection at a time: reads one request line, checks the nonce (a wrong one closes the connection without
 * an answer), asks the handler, writes the answer line. A second helper waits its turn.
 */
export function serveConnections(nonce: string, handler: AskpassHandler, log?: Logger) {
  let queue = Promise.resolve();
  return (conn: { on(ev: string, fn: (...a: never[]) => void): unknown; write(s: string): unknown; end(): unknown; destroy(): unknown; setEncoding?(e: "utf8"): unknown }) => {
    const ac = new AbortController();
    let settled = false;
    let closed = false;
    let release: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      closed = true;
      ac.abort();
      release?.();
      release = undefined;
    };
    // Attached now, not when this connection reaches the front: a helper may exit while it is still queued.
    conn.on("close", finish);
    conn.on("error", finish);
    queue = queue.then(() => new Promise<void>(resolve => {
      if (closed) { resolve(); return; }
      release = resolve;
      let buf = "";
      let asked = false;
      conn.on("data", ((chunk: Buffer | string) => {
        if (settled || asked) return;
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) {
          if (buf.length > REQUEST_MAX) { log?.warn("remote.askpass_refused", { why: "size" }); conn.destroy(); }
          return;
        }
        asked = true;
        const req = parseRequest(buf.slice(0, nl), nonce);
        buf = "";
        if (!req) {
          log?.warn("remote.askpass_refused", { why: "request" });
          conn.destroy();
          return;
        }
        handler(req, ac.signal).then(value => {
          if (settled) return;
          conn.write(answerLine(value));
          conn.end();
        }, () => {
          if (!settled) { conn.write(answerLine(null)); conn.end(); }
        });
      }) as (...a: never[]) => void);
    }));
  };
}

/**
 * Where a run's socket folder may go, in order (§5.1.6): Linux $XDG_RUNTIME_DIR, else <userData>/ssh; macOS the
 * per-user temporary folder (DARWIN_USER_TEMP_DIR, which a GUI app gets as TMPDIR); /tmp last, for paths too long.
 */
export function socketBases(o: { os: OS; userData: string; xdgRuntimeDir?: string; darwinTemp?: string }): string[] {
  const out: string[] = [];
  if (o.os === "linux" && o.xdgRuntimeDir && posix.isAbsolute(o.xdgRuntimeDir)) out.push(o.xdgRuntimeDir);
  if (o.os === "darwin" && o.darwinTemp && posix.isAbsolute(o.darwinTemp)) out.push(o.darwinTemp);
  out.push(posix.join(o.userData, "ssh"));
  out.push("/tmp");
  return out;
}

/** The first base whose `<base>/ea-XXXXXX/a.sock` stays within SOCKET_PATH_MAX bytes. */
export function pickSocketBase(bases: readonly string[]): string {
  for (const b of bases) {
    if (Buffer.byteLength(posix.join(b, "ea-XXXXXX", "a.sock")) <= SOCKET_PATH_MAX) return b;
  }
  return "/tmp";
}

/** The file system calls the server and the wrapper use (injected in tests). */
export interface AskpassFs {
  mkdir(p: string, o: { recursive: true; mode: number }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  rm(p: string, o: { recursive: true; force: true }): Promise<void>;
  readFile(p: string, enc: "utf8"): Promise<string>;
  writeFile(p: string, data: string, o: { mode: number }): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * Starts the per-run socket server (Linux and macOS PCs). `listen` makes the server (net.createServer in Ember; a fake
 * in tests). The folder is made with mkdtemp (0700) under the first base short enough.
 */
export async function createAskpassServer(o: {
  bases: readonly string[];
  fs: AskpassFs;
  handler: AskpassHandler;
  log?: Logger;
  listen?: (path: string, onConn: (c: net.Socket) => void) => Promise<{ close(): void }>;
}): Promise<AskpassChannel> {
  const base = pickSocketBase(o.bases);
  await o.fs.mkdir(base, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const dir = await o.fs.mkdtemp(posix.join(base, "ea-"));
  const sock = posix.join(dir, "a.sock");
  const nonce = askpassNonce();
  const onConn = serveConnections(nonce, o.handler, o.log);
  const open = new Set<{ destroy(): unknown }>();
  const listen = o.listen ?? ((path, fn) => new Promise((resolve, reject) => {
    const server = net.createServer(c => fn(c));
    server.once("error", reject);
    server.listen(path, () => resolve({ close: () => server.close() }));
  }));
  let server: { close(): void };
  try {
    server = await listen(sock, c => { open.add(c); c.on("close", () => open.delete(c)); onConn(c); });
  } catch (err) {
    await o.fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  let closed = false;
  return {
    address: sock,
    nonce,
    async close() {
      if (closed) return;
      closed = true;
      server.close();
      for (const c of open) c.destroy();
      await o.fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * The app folder Ember's binary must be told on its command line: none when it is the bundle's own (a packaged Ember.app
 * loads Contents/Resources/app by itself), else the development tree's (Electron's default app takes it first).
 */
function appFolderArgs(execPath: string, appDir: string): string[] {
  const root = posix.dirname(posix.dirname(appDir));
  return root === posix.join(posix.dirname(posix.dirname(execPath)), "Resources", "app") ? [] : [root];
}

/**
 * The askpass wrapper ssh runs on Linux and macOS PCs (§5.1.6), written to <userData>/ssh/askpass (folder and file
 * 0700) when its text differs; returns its path.
 * - Linux: two lines that start Ember's own binary as plain Node on askpass.cjs, the prompt **after** the script path so
 *   Node never reads it as an option.
 * - macOS, whose build refuses node mode (review #177): Ember itself in its askpass mode (--ember-askpass: main.ts runs
 *   askpass.cjs as a worker and exits, starting nothing else), the prompt handed over in EMBER_ASKPASS_PROMPT, never
 *   on the command line, where Chromium or AppKit could take a server's text for a switch of theirs.
 */
export async function writeAskpassWrapper(o: { fs: AskpassFs; os: OS; userData: string; execPath: string; appDir: string }): Promise<string> {
  const dir = posix.join(o.userData, "ssh");
  const file = posix.join(dir, "askpass");
  const text = o.os === "darwin"
    ? `#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nEMBER_ASKPASS_PROMPT="$*"\nexport EMBER_ASKPASS_PROMPT\nexec ${[o.execPath, ...appFolderArgs(o.execPath, o.appDir)].map(shQuote).join(" ")} ${ASKPASS_SWITCH}\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(o.execPath)} ${shQuote(posix.join(o.appDir, "askpass.cjs"))} "$@"\n`;
  await o.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await o.fs.chmod(dir, 0o700).catch(() => undefined);
  const now = await o.fs.readFile(file, "utf8").catch(() => null);
  if (now !== text) {
    const tmp = `${file}.${process.pid}.tmp`;
    await o.fs.writeFile(tmp, text, { mode: 0o700 });
    await o.fs.chmod(tmp, 0o700);
    await o.fs.rename(tmp, file);
  } else {
    await o.fs.chmod(file, 0o700);
  }
  return file;
}
