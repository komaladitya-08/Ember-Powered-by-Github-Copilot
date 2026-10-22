/**
 * The askpass channel on a Windows PC (§5.1.6, L15): a named pipe `\\.\pipe\ember-askpass-<16 hex>` created through
 * koffi's CreateNamedPipeW with a protected DACL that admits only the user's own SID, PIPE_REJECT_REMOTE_CLIENTS (no
 * SMB client can reach it) and FILE_FLAG_FIRST_PIPE_INSTANCE (Ember made it, nobody squatted the name first), one
 * instance, one client at a time. Node's own pipe server can't set a DACL, so the calls are Win32's, made on koffi's
 * worker threads (ConnectNamedPipe and ReadFile block) so Electron's main thread never waits. The handle is
 * synchronous, so Windows runs one call on it at a time: a DisconnectNamedPipe or CloseHandle made while a
 * ConnectNamedPipe or ReadFile still waits would wait behind it. So the main thread disconnects only between calls,
 * wakes a waiting ConnectNamedPipe by opening the pipe as a client before it closes, and closes on a worker thread.
 * Local IPC, not a network listener. koffi loads lazily, only when a Windows PC makes a pipe; the messages are
 * askpass-server.ts's.
 */

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import type { Logger } from "../logger";
import { answerLine, askpassNonce, parseRequest, REQUEST_MAX, type AskpassChannel, type AskpassHandler } from "./askpass-server";

const PIPE_ACCESS_DUPLEX = 0x3, FILE_FLAG_FIRST_PIPE_INSTANCE = 0x0008_0000;
const PIPE_TYPE_BYTE = 0x0, PIPE_READMODE_BYTE = 0x0, PIPE_WAIT = 0x0, PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const GENERIC_READ = 0x8000_0000, GENERIC_WRITE = 0x4000_0000, OPEN_EXISTING = 3;
const TOKEN_QUERY = 0x0008, TOKEN_USER = 1, SDDL_REVISION_1 = 1;
/** INVALID_HANDLE_VALUE as an intptr_t. */
const INVALID = -1;

/** The flags CreateNamedPipeW gets (exported so tests pin them). */
export const PIPE_OPEN_MODE = PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE;
export const PIPE_MODE = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;

/** A protected DACL granting the user (and no one else, not even Administrators) full access. */
export function pipeSddl(sid: string): string {
  if (!/^S-1-\d{1,3}(-\d{1,10}){1,15}$/.test(sid)) throw new Error("not a SID");
  return `D:P(A;;GA;;;${sid})`;
}

/** A fresh pipe name. */
export function pipeName(): string {
  return `\\\\.\\pipe\\ember-askpass-${randomBytes(8).toString("hex")}`;
}

/** The Win32 calls the pipe needs, with plain values (a fake in tests). */
export interface PipeApi {
  /** The SID of this process's user ("S-1-5-21-…"), or null. */
  userSid(): string | null;
  /** CreateNamedPipeW with that DACL; a handle, or null when it fails (the name exists: refused, never shared). */
  create(name: string, openMode: number, pipeMode: number, sddl: string): number | null;
  /** ConnectNamedPipe on a worker thread: true when a client is connected. */
  connect(h: number, done: (ok: boolean) => void): void;
  /** ReadFile on a worker thread: the bytes read, or null at the end or on failure. */
  read(h: number, max: number, done: (data: Buffer | null) => void): void;
  /** WriteFile and FlushFileBuffers on a worker thread. */
  write(h: number, data: Buffer, done: (ok: boolean) => void): void;
  /** DisconnectNamedPipe: only between calls (nothing waiting on the handle), so it never waits itself. */
  disconnect(h: number): void;
  /** Opens and closes the pipe as a client: wakes a ConnectNamedPipe still waiting, so the pipe can close. */
  poke(name: string): void;
  /** CloseHandle on a worker thread (a read still waiting would hold it up; the main thread never waits for that). */
  close(h: number): void;
}

type Koffi = typeof import("koffi");
type Fn = ((...args: unknown[]) => unknown) & { async: (...args: unknown[]) => void };

/** Every function bound, in koffi's prototype syntax (handles as intptr_t; out-parameters Buffers or arrays). */
export const PIPE_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  "kernel32.dll": [
    "intptr_t __stdcall CreateNamedPipeW(const char16_t *name, uint32_t openMode, uint32_t pipeMode, uint32_t maxInstances, uint32_t outBuffer, uint32_t inBuffer, uint32_t timeout, void *sa)",
    "int __stdcall ConnectNamedPipe(intptr_t h, void *overlapped)",
    "int __stdcall ReadFile(intptr_t h, void *buf, uint32_t n, void *read, void *overlapped)",
    "int __stdcall WriteFile(intptr_t h, void *buf, uint32_t n, void *written, void *overlapped)",
    "int __stdcall FlushFileBuffers(intptr_t h)",
    "int __stdcall DisconnectNamedPipe(intptr_t h)",
    "int __stdcall CloseHandle(intptr_t h)",
    "intptr_t __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *sa, uint32_t disposition, uint32_t flags, void *template)",
    "intptr_t __stdcall GetCurrentProcess()",
    "void * __stdcall LocalFree(void *mem)",
  ],
  "advapi32.dll": [
    "int __stdcall OpenProcessToken(intptr_t process, uint32_t access, _Out_ intptr_t *token)",
    "int __stdcall GetTokenInformation(intptr_t token, int kind, void *buf, uint32_t size, _Out_ uint32_t *returned)",
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **str)",
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *sddl, uint32_t revision, _Out_ void **sd, void *size)",
  ],
};

/**
 * Binds the API with `koffi` from the libraries `load` opens (tests pass fakes). Throws when a function is missing:
 * the caller then has no askpass on this PC (batch mode only, with §8.7's advice).
 */
export function bindPipeApi(koffi: Koffi, load: (name: string) => Pick<import("koffi").LibraryHandle, "func">): PipeApi {
  if (koffi.sizeof("void *") !== 8) throw new Error("Ember's askpass pipe needs a 64-bit process");
  const fn: Record<string, Fn> = {};
  for (const [lib, decls] of Object.entries(PIPE_FUNCTIONS)) {
    const l = load(lib);
    for (const d of decls) fn[/(\w+)\s*\(/.exec(d)?.[1] ?? ""] = l.func(d) as unknown as Fn;
  }
  const wide = (s: string) => Buffer.from(`${s}\0`, "utf16le");
  return {
    userSid() {
      const token = [0];
      if (!fn.OpenProcessToken(fn.GetCurrentProcess(), TOKEN_QUERY, token) || !token[0]) return null;
      try {
        const buf = Buffer.alloc(256), returned = [0];
        if (!fn.GetTokenInformation(token[0], TOKEN_USER, buf, buf.length, returned)) return null;
        // TOKEN_USER starts with the SID's pointer, which points inside `buf` (kept alive for the call).
        const psid = koffi.decode(buf, "void *");
        const out: unknown[] = [null];
        if (!fn.ConvertSidToStringSidW(psid, out) || !out[0]) return null;
        try {
          return koffi.decode.string16(out[0]);
        } finally {
          fn.LocalFree(out[0]);
        }
      } finally {
        fn.CloseHandle(token[0]);
      }
    },
    create(name, openMode, pipeMode, sddl) {
      const sd: unknown[] = [null];
      if (!fn.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), SDDL_REVISION_1, sd, null) || !sd[0]) return null;
      try {
        // SECURITY_ATTRIBUTES on x64: DWORD nLength (+4 padding), LPVOID lpSecurityDescriptor, BOOL bInheritHandle.
        const sa = Buffer.alloc(24);
        sa.writeUInt32LE(24, 0);
        koffi.encode(sa, 8, "void *", sd[0]);
        sa.writeInt32LE(0, 16);
        const h = Number(fn.CreateNamedPipeW(wide(name), openMode, pipeMode, 1, 4096, 4096, 0, sa));
        return h === INVALID || h === 0 ? null : h;
      } finally {
        fn.LocalFree(sd[0]);
      }
    },
    connect(h, done) {
      // FALSE with ERROR_PIPE_CONNECTED means a client came first: the read that follows tells.
      fn.ConnectNamedPipe.async(h, null, (err: unknown) => done(!err));
    },
    read(h, max, done) {
      const buf = Buffer.alloc(max), n = Buffer.alloc(4);
      fn.ReadFile.async(h, buf, max, n, null, (err: unknown, ok: unknown) => {
        const got = n.readUInt32LE(0);
        done(!err && ok && got > 0 ? Buffer.from(buf.subarray(0, got)) : null);
      });
    },
    write(h, data, done) {
      const n = Buffer.alloc(4);
      fn.WriteFile.async(h, data, data.length, n, null, (err: unknown, ok: unknown) => {
        if (err || !ok) return done(false);
        fn.FlushFileBuffers.async(h, () => done(true));
      });
    },
    disconnect: h => { fn.DisconnectNamedPipe(h); },
    poke(name) {
      const h = Number(fn.CreateFileW(wide(name), GENERIC_READ | GENERIC_WRITE, 0, null, OPEN_EXISTING, 0, null));
      if (h !== INVALID && h !== 0) fn.CloseHandle(h);
    },
    close: h => { fn.CloseHandle.async(h, () => undefined); },
  };
}

const requireCjs = createRequire(__filename);
let bound: PipeApi | null | undefined;

/** The API on a Windows PC (bound once, lazily), or null when koffi or a function can't be loaded. Call only on Windows. */
export function loadPipeApi(log?: Logger): PipeApi | null {
  if (bound !== undefined) return bound;
  try {
    const koffi = requireCjs("koffi") as Koffi;
    bound = bindPipeApi(koffi, name => koffi.load(name));
  } catch (err) {
    log?.warn("remote.askpass_pipe_unavailable", { err });
    bound = null;
  }
  return bound;
}

/**
 * Starts one ssh run's pipe: one client at a time; each reads one request line, checked against the run's nonce (a
 * wrong one is disconnected without an answer), answered by `handler`, then the pipe waits for the next prompt.
 */
export async function createAskpassPipe(o: { api: PipeApi; handler: AskpassHandler; log?: Logger; name?: string }): Promise<AskpassChannel> {
  const sid = o.api.userSid();
  if (!sid) throw new Error("the user's SID couldn't be read");
  const name = o.name ?? pipeName();
  const h = o.api.create(name, PIPE_OPEN_MODE, PIPE_MODE, pipeSddl(sid));
  if (h === null) throw new Error("the askpass pipe couldn't be made");
  const nonce = askpassNonce();
  let closed = false;
  let current: AbortController | null = null;
  let idle: () => void = () => undefined;
  const stopped = new Promise<void>(resolve => { idle = resolve; });

  const next = () => {
    if (closed) return idle();
    o.api.connect(h, () => {
      if (closed) return idle();
      const ac = new AbortController();
      current = ac;
      let buf = Buffer.alloc(0);
      const end = () => {
        current = null;
        ac.abort();
        // Closing: the handle is close()'s now (it may be closed already), so it isn't touched here.
        if (closed) return idle();
        o.api.disconnect(h);
        next();
      };
      const readMore = () => o.api.read(h, 4096, data => {
        if (!data || closed) return end();
        buf = Buffer.concat([buf, data]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return buf.length > REQUEST_MAX ? end() : readMore();
        const req = parseRequest(buf.subarray(0, nl).toString("utf8"), nonce);
        if (!req) {
          o.log?.warn("remote.askpass_refused", { why: "request" });
          return end();
        }
        // A notice (touch your key) has no answer: the card stays until ssh kills the helper, which ends this read.
        // Nothing is written meanwhile (a synchronous pipe handle would hold the write behind the pending read).
        if (req.mode === "notify") {
          o.api.read(h, 1, () => end());
          void o.handler(req, ac.signal).catch(() => null);
          return;
        }
        o.handler(req, ac.signal).catch(() => null).then(value => {
          if (ac.signal.aborted || closed) return end();
          o.api.write(h, Buffer.from(answerLine(value)), () => end());
        });
      });
      readMore();
    });
  };
  next();
  return {
    address: name,
    nonce,
    async close() {
      if (closed) return;
      closed = true;
      current?.abort();
      // Wake a ConnectNamedPipe still waiting first: a DisconnectNamedPipe made now would wait behind it.
      o.api.poke(name);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([stopped, new Promise<void>(r => { timer = setTimeout(r, 2000); })]);
      if (timer) clearTimeout(timer);
      o.api.close(h);
    },
  };
}
