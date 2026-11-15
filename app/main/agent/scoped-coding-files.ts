/**
 * Linux-only file tools for a disposable coding copy. Every data operation runs inside a host-owned, exclusive
 * workspace.files lease, serialized with commands and granted only after their namespace descendants have exited.
 * The lease is essential: path checks alone cannot exclude a live command writer. No operation reaches the source.
 *
 * Traversal uses pinned directory descriptors, O_NOFOLLOW and procfs mount identities. The whole copy is audited
 * before each operation; links, aliases, special objects and excessive trees fail closed. This does not isolate
 * privileged or unrelated same-user host processes. The caller must own a fresh private copy and its lifecycle.
 */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { HOST_PLATFORM } from "../platform/os";
import { memoryRefusal } from "../memory/guard";
import { projectFileProblem } from "./project";
import type { PathFact } from "../commands/types";

import { ScopedCodingFileError } from "./coding-platform";
import type { ScopedCodingWorkspace, ScopedCodingFileLimits, ScopedCodingWithheld, ScopedCodingListResult,
  ScopedCodingTextResult, ScopedCodingWriteResult, ScopedCodingSearchResult } from "./coding-platform";
export { ScopedCodingFileError } from "./coding-platform";
export type { ScopedCodingWorkspace, ScopedCodingFileLimits, ScopedCodingWithheld, ScopedCodingEntry,
  ScopedCodingListResult, ScopedCodingTextResult, ScopedCodingWriteResult, ScopedCodingSearchResult } from "./coding-platform";

const CAPS: ScopedCodingFileLimits = {
  entries: 10_000, depth: 64, fileBytes: 8 * 1024 * 1024, workspaceBytes: 100 * 1024 * 1024,
  resultBytes: 256 * 1024, searchMatches: 1000,
};
const DEFAULTS: ScopedCodingFileLimits = { ...CAPS, resultBytes: 64 * 1024, searchMatches: 200 };
interface Entry { path: string; kind: "file" | "directory"; stat: BigIntStats }
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const virtual = (path: string) => path ? `/work/${path}` : "/work";
const fold = (path: string) => path.toUpperCase().toLowerCase().normalize("NFC");
const withheld = (): ScopedCodingWithheld => ({ hidden: 0, sensitive: 0, unsupported: 0, binary: 0, secrets: 0 });
const stable = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function normalized(value: string, rootAllowed = true): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || value !== value.normalize("NFC") ||
      Buffer.from(value).toString("utf8") !== value || /[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(value)) throw new ScopedCodingFileError("path");
  const relative = value === "/work" ? "" : value.startsWith("/work/") ? value.slice(6) : value;
  if (!relative && rootAllowed) return "";
  if (!relative || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || Buffer.byteLength(part) > 255 || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new ScopedCodingFileError("path");
  }
  return relative;
}

function privacy(path: string, directory = false): "hidden" | "sensitive" | "unsupported" | null {
  const parts = path.split("/");
  const namedDotFile = !directory && parts.length === 1 && [".gitignore", ".gitattributes", ".editorconfig"].includes(path);
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index];
    if (!name) continue;
    const why = projectFileProblem(name);
    const projectDotDirectory = index === 0 && (directory || index < parts.length - 1) && (name === ".github" ||
      (name === ".claude" && ((directory && parts.length === 1) || parts[1] === "rules")));
    if (why === "hidden" && !projectDotDirectory && !namedDotFile) return "hidden";
    if (why === "unsafe" || why === "named" || ["unsafe", "named"].includes(projectFileProblem(`${name}.txt`) ?? "")) return "sensitive";
    if (!directory && index === parts.length - 1 && why === "kind" && !namedDotFile) return "unsupported";
  }
  return null;
}

/**
 * Shared command/capture admission check over a complete bounded file. Git and dependency directories are not
 * excluded wholesale. This detects conventional credential stores and recognized secret text, not every possible
 * secret or compressed history; callers still need isolated commands and guarded output.
 */
export function codingWorkspaceFileProblem(relativePath: string, bytes: Uint8Array): "credential-path" | "credential-text" | null {
  const parts = relativePath.split("/").map(part => part.toLowerCase());
  const name = parts.at(-1) ?? "";
  if (parts.some(part => [".ssh", ".aws", ".azure", ".kube", ".gnupg", ".pki", ".password-store", ".credentials", "privatekeys", "private-keys", "private_keys"].includes(part)) ||
      /^\.env(?:\.|$)/.test(name) || /\.(?:pem|key|ppk|p8|p12|pfx|jks|keystore|kdbx?|ovpn|tfstate|tfvars)(?:\.|$)/.test(name) ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/.test(name) ||
      /^(?:credentials?(?:\.json|\.txt|\.ya?ml)?|secrets?\.(?:json|ya?ml|txt)|passwords?\.(?:txt|csv|json|ya?ml|ini|conf)|application_default_credentials\.json|service[-_]account\.json|\.npmrc|\.netrc|\.pgpass|\.htpasswd|\.vault_pass|\.git-credentials|\.boto|\.s3cfg|\.dockercfg|wp-config\.php|rclone\.conf|sitemanager\.xml|logins\.(?:csv|json|txt)|login data|cookies(?:\.sqlite)?|key4\.db)$/.test(name) ||
      (parts.includes(".docker") && name === "config.json") ||
      (parts.includes(".config") && parts.some(part => ["gcloud", "gh", "hub"].includes(part)))) return "credential-path";
  let text: string;
  try { text = new TextDecoder("utf8", { fatal: true }).decode(bytes); } catch { return null; }
  return memoryRefusal(text) ? "credential-text" : null;
}

async function mountId(file: fs.FileHandle): Promise<string> {
  const text = await fs.readFile(`/proc/self/fdinfo/${file.fd}`, "utf8");
  const id = /^mnt_id:\s*(\d+)\s*$/m.exec(text)?.[1];
  if (!id) throw new ScopedCodingFileError("boundary");
  return id;
}

/** Every ancestor is opened without following a symlink; no lexical path normalization precedes an open. */
async function openAbsoluteDirectory(path: string): Promise<fs.FileHandle> {
  if (!path.startsWith("/") || path.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new ScopedCodingFileError("boundary");
  let current = await fs.open("/", DIR);
  try {
    for (const part of path.slice(1).split("/")) {
      const next = await fs.open(`/proc/self/fd/${current.fd}/${part}`, DIR);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) { await current.close(); throw error; }
}

export class ScopedCodingFiles {
  #files: ScopedCodingWorkspace["files"];
  #signal: AbortSignal;
  #limits: Readonly<ScopedCodingFileLimits>;
  #root: fs.FileHandle;
  #rootPath: string;
  #identity: BigIntStats;
  #mount: string;
  #closed = false;
  #active = 0;
  #idle: (() => void)[] = [];
  #closing: Promise<void> | null = null;
  #abort: () => void;
  #excluded: readonly string[];

  private constructor(options: { files: ScopedCodingWorkspace["files"]; signal: AbortSignal }, limits: ScopedCodingFileLimits,
    root: fs.FileHandle, path: string, identity: BigIntStats, mount: string, excluded: readonly string[]) {
    this.#files = options.files; this.#signal = options.signal; this.#limits = Object.freeze(limits);
    this.#root = root; this.#rootPath = path; this.#identity = identity; this.#mount = mount;
    this.#excluded = Object.freeze([...excluded]);
    this.#abort = () => { void this.close().catch(() => undefined); };
    options.signal.addEventListener("abort", this.#abort, { once: true });
    if (options.signal.aborted) this.#abort();
  }

  static async create(options: { workspace: ScopedCodingWorkspace; signal: AbortSignal; limits?: Partial<ScopedCodingFileLimits> }): Promise<ScopedCodingFiles> {
    if (HOST_PLATFORM !== "linux" || !options || typeof options.workspace?.files !== "function" || !(options.signal instanceof AbortSignal)) throw new ScopedCodingFileError("unavailable");
    const limits = { ...DEFAULTS, ...options.limits };
    if (Object.entries(limits).some(([key, value]) => !Object.hasOwn(CAPS, key) || !Number.isSafeInteger(value) || value < 1 || value > CAPS[key as keyof ScopedCodingFileLimits])) throw new ScopedCodingFileError("limit");
    try {
      const excluded = options.workspace.excludedRoots ?? [];
      if (!Array.isArray(excluded) || excluded.length > 2 || new Set(excluded).size !== excluded.length || excluded.some(value => value !== ".git" && value !== "node_modules")) throw new ScopedCodingFileError("unsupported");
      const scope = [...excluded];
      const files: ScopedCodingWorkspace["files"] = options.workspace.files.bind(options.workspace), signal = options.signal;
      const broker = await files(async path => {
        if (options.signal.aborted) throw new ScopedCodingFileError("cancelled");
        const root = await openAbsoluteDirectory(path);
        try {
          const identity = await root.stat({ bigint: true }), mount = await mountId(root);
          if (options.signal.aborted) throw new ScopedCodingFileError("cancelled");
          if (!identity.isDirectory() || identity.uid !== BigInt(process.getuid!()) || (identity.mode & 0o077n) !== 0n) throw new ScopedCodingFileError("boundary");
          return new ScopedCodingFiles({ files, signal }, limits, root, path, identity, mount, scope);
        } catch (error) { await root.close(); throw error; }
      });
      broker.#current();
      return broker;
    } catch (error) { throw sanitize(error); }
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    this.#closing ??= (async () => {
      if (this.#active) await new Promise<void>(resolve => this.#idle.push(resolve));
      try { await this.#root.close(); } catch (error) { throw sanitize(error); }
    })();
    return this.#closing;
  }

  #current(): void { if (this.#closed || this.#signal.aborted) throw new ScopedCodingFileError("cancelled"); }
  async #wait<T>(pending: Promise<T>): Promise<T> { const result = await pending; this.#current(); return result; }
  #result<T>(value: T): T {
    if (Buffer.byteLength(JSON.stringify(value)) > this.#limits.resultBytes) throw new ScopedCodingFileError("limit");
    return value;
  }
  async #checkRoot(path: string): Promise<void> {
    if (path !== this.#rootPath) throw new ScopedCodingFileError("boundary");
    const current = await openAbsoluteDirectory(path);
    try {
      this.#current();
      const stat = await this.#wait(current.stat({ bigint: true }));
      if (stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino || stat.uid !== this.#identity.uid || (stat.mode & 0o7077n) !== 0n ||
          await this.#wait(mountId(current)) !== this.#mount || await this.#wait(fs.realpath(`/proc/self/fd/${this.#root.fd}`)) !== path) throw new ScopedCodingFileError("boundary");
    } finally { await current.close(); }
  }

  async #lease<T>(operation: (entries: Map<string, Entry>) => Promise<T>): Promise<T> {
    this.#current();
    try {
      return await this.#files(async root => {
        this.#current(); this.#active++;
        try {
          await this.#checkRoot(root);
          const entries = await this.#audit();
          const result = await operation(entries);
          await this.#checkRoot(root);
          this.#current();
          return this.#result(result);
        } finally { if (--this.#active === 0) for (const resolve of this.#idle.splice(0)) resolve(); }
      });
    } catch (error) { throw sanitize(error); }
  }

  async #audit(): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>(), aliases = new Set<string>();
    let bytes = 0;
    const walk = async (directory: fs.FileHandle, prefix: string, depth: number): Promise<void> => {
      if (depth > this.#limits.depth) throw new ScopedCodingFileError("limit");
      const before = await this.#wait(directory.stat({ bigint: true }));
      if (!before.isDirectory() || before.dev !== this.#identity.dev || before.uid !== this.#identity.uid ||
          (before.mode & 0o7000n) !== 0n || await this.#wait(mountId(directory)) !== this.#mount) throw new ScopedCodingFileError("unsupported");
      const listing = await fs.opendir(`/proc/self/fd/${directory.fd}`, { encoding: "buffer" as BufferEncoding, bufferSize: 32 });
      try {
        for await (const item of listing) {
          this.#current();
          if (entries.size >= this.#limits.entries) throw new ScopedCodingFileError("limit");
          const raw = item.name as unknown as Buffer, name = raw.toString("utf8");
          if (!Buffer.from(name).equals(raw)) throw new ScopedCodingFileError("unsupported");
          const path = prefix ? `${prefix}/${name}` : name;
          try { normalized(path, false); } catch { throw new ScopedCodingFileError("unsupported"); }
          if (path.split("/").length > this.#limits.depth || aliases.has(fold(path))) throw new ScopedCodingFileError("unsupported");
          aliases.add(fold(path));
          const target = `/proc/self/fd/${directory.fd}/${name}`, listed = await this.#wait(fs.lstat(target, { bigint: true }));
          if (!listed.isDirectory() && !listed.isFile()) throw new ScopedCodingFileError("unsupported");
          const child = await fs.open(target, listed.isDirectory() ? DIR : FILE);
          try {
            this.#current();
            const stat = await this.#wait(child.stat({ bigint: true }));
            if (!stable(listed, stat) || stat.dev !== this.#identity.dev || stat.uid !== this.#identity.uid ||
                (stat.mode & 0o7000n) !== 0n || await this.#wait(mountId(child)) !== this.#mount ||
                (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) throw new ScopedCodingFileError("unsupported");
            if (stat.isFile() && (stat.size > BigInt(this.#limits.fileBytes) || (bytes += Number(stat.size)) > this.#limits.workspaceBytes)) throw new ScopedCodingFileError("limit");
            entries.set(path, { path, kind: stat.isDirectory() ? "directory" : "file", stat });
            if (stat.isDirectory()) await walk(child, path, depth + 1);
          } finally { await child.close(); }
        }
      } finally { await listing.close().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error; }); }
      if (!stable(before, await this.#wait(directory.stat({ bigint: true })))) throw new ScopedCodingFileError("conflict");
    };
    await walk(this.#root, "", 0);
    return entries;
  }

  async #parent(path: string, entries: Map<string, Entry>): Promise<{ directory: fs.FileHandle; name: string }> {
    const parts = path.split("/"), name = parts.pop()!;
    let directory = await fs.open(`/proc/self/fd/${this.#root.fd}/.`, DIR);
    try {
      this.#current();
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const expected = entries.get(prefix);
        if (expected?.kind !== "directory") throw new ScopedCodingFileError("missing");
        const next = await fs.open(`/proc/self/fd/${directory.fd}/${part}`, DIR);
        try {
          this.#current();
          if (!stable(expected.stat, await this.#wait(next.stat({ bigint: true }))) || await this.#wait(mountId(next)) !== this.#mount) throw new ScopedCodingFileError("conflict");
        } catch (error) { await next.close(); throw error; }
        await directory.close(); directory = next;
      }
      return { directory, name };
    } catch (error) { await directory.close(); throw error; }
  }

  #isExcluded(path: string): boolean { return this.#excluded.includes(path.split("/")[0]); }
  #allow(path: string, directory = false): void { if (this.#isExcluded(path) || privacy(path, directory)) throw new ScopedCodingFileError("privacy"); }
  #entry(path: string, entries: Map<string, Entry>): Entry {
    if (this.#isExcluded(path)) throw new ScopedCodingFileError("privacy");
    const entry = entries.get(path);
    if (!entry) throw new ScopedCodingFileError("missing");
    this.#allow(path, entry.kind === "directory");
    return entry;
  }
  #newPath(path: string, entries: Map<string, Entry>): void {
    if (path.split("/").length > this.#limits.depth) throw new ScopedCodingFileError("limit");
    if ([...entries.keys()].some(existing => fold(existing) === fold(path) && existing !== path)) throw new ScopedCodingFileError("unsupported");
    if (!entries.has(path) && entries.size >= this.#limits.entries) throw new ScopedCodingFileError("limit");
  }
  async #text(entry: Entry, entries: Map<string, Entry>): Promise<{ text: string; bytes: Buffer; sha256: string }> {
    this.#allow(entry.path);
    if (entry.kind !== "file") throw new ScopedCodingFileError("unsupported");
    const parent = await this.#parent(entry.path, entries);
    try {
      const file = await fs.open(`/proc/self/fd/${parent.directory.fd}/${parent.name}`, FILE);
      try {
        this.#current();
        const before = await this.#wait(file.stat({ bigint: true }));
        if (!stable(entry.stat, before) || before.nlink !== 1n || await this.#wait(mountId(file)) !== this.#mount) throw new ScopedCodingFileError("conflict");
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await this.#wait(file.read(bytes, length, bytes.length - length, length));
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== Number(before.size) || !stable(before, await this.#wait(file.stat({ bigint: true })))) throw new ScopedCodingFileError("conflict");
        const data = bytes.subarray(0, length);
        let text: string;
        try { text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new ScopedCodingFileError("binary"); }
        if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, ""))) throw new ScopedCodingFileError("binary");
        if (memoryRefusal(text.replace(/^\ufeff/, ""))) throw new ScopedCodingFileError("secret");
        return { text, bytes: data, sha256: digest(data) };
      } finally { await file.close(); }
    } finally { await parent.directory.close(); }
  }

  list(path = "/work"): Promise<ScopedCodingListResult> {
    return this.#lease(async entries => {
      const relative = normalized(path);
      if (relative && this.#entry(relative, entries).kind !== "directory") throw new ScopedCodingFileError("unsupported");
      const result: ScopedCodingListResult = { path: virtual(relative), scope: "direct-children", entries: [], withheld: withheld(), ...(this.#excluded.length ? { excludedRoots: [...this.#excluded] } : {}) };
      for (const entry of [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
        if (entry.path.split("/").slice(0, -1).join("/") !== relative) continue;
        const why = this.#isExcluded(entry.path) ? "unsupported" : privacy(entry.path, entry.kind === "directory");
        if (why) result.withheld[why]++;
        else result.entries.push({ path: virtual(entry.path), kind: entry.kind, ...(entry.kind === "file" ? { bytes: Number(entry.stat.size) } : {}) });
      }
      return result;
    });
  }

  readText(path: string, range: { startLine?: number; endLine?: number } = {}): Promise<ScopedCodingTextResult> {
    range = { ...range };
    return this.#lease(async entries => {
      const relative = normalized(path, false), file = await this.#text(this.#entry(relative, entries), entries);
      const lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const start = range.startLine ?? 1, end = range.endLine ?? lines.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > lines.length ||
          (lines.length ? end < start : start !== 1 || end !== 0)) throw new ScopedCodingFileError("path");
      return { path: virtual(relative), text: lines.slice(start - 1, end).join(""), sha256: file.sha256,
        bytes: file.bytes.length, totalLines: lines.length, startLine: start, endLine: end };
    });
  }

  writeText(path: string, text: string, options: { createOnly?: boolean; expectedSha256?: string } = {}): Promise<ScopedCodingWriteResult> {
    const captured = { ...options };
    return this.#lease(entries => this.#write(normalized(path, false), text, captured, entries));
  }
  replaceText(path: string, oldText: string, newText: string, options: { expectedSha256?: string } = {}): Promise<ScopedCodingWriteResult & { replaced: 1 }> {
    options = { ...options };
    return this.#lease(async entries => {
      const relative = normalized(path, false), before = await this.#text(this.#entry(relative, entries), entries);
      if (typeof oldText !== "string" || typeof newText !== "string" || !oldText || oldText.length > this.#limits.fileBytes ||
          newText.length > this.#limits.fileBytes || before.text.indexOf(oldText) < 0 || before.text.indexOf(oldText) !== before.text.lastIndexOf(oldText)) throw new ScopedCodingFileError("ambiguous");
      const updated = before.text.replace(oldText, () => newText);
      this.#result({ path: virtual(relative), bytes: Buffer.byteLength(updated), sha256: digest(Buffer.from(updated)), created: false, replaced: 1 });
      return { ...await this.#write(relative, updated, options, entries), replaced: 1 };
    });
  }

  async #write(path: string, text: string, options: { createOnly?: boolean; expectedSha256?: string }, entries: Map<string, Entry>): Promise<ScopedCodingWriteResult> {
    this.#allow(path); this.#newPath(path, entries);
    if ((options.createOnly !== undefined && typeof options.createOnly !== "boolean") ||
        (options.expectedSha256 !== undefined && (typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(options.expectedSha256)))) throw new ScopedCodingFileError("path");
    if (typeof text !== "string" || Buffer.byteLength(text) > this.#limits.fileBytes || Buffer.from(text).toString("utf8") !== text) throw new ScopedCodingFileError("limit");
    if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, ""))) throw new ScopedCodingFileError("binary");
    if (memoryRefusal(text.replace(/^\ufeff/, ""))) throw new ScopedCodingFileError("secret");
    const entry = entries.get(path), bytes = Buffer.from(text);
    if (entry) {
      if (options.createOnly) throw new ScopedCodingFileError("exists");
      const before = await this.#text(entry, entries);
      if (options.expectedSha256 !== undefined && options.expectedSha256 !== before.sha256) throw new ScopedCodingFileError("conflict");
    } else if (options.expectedSha256 !== undefined) throw new ScopedCodingFileError("conflict");
    if ([...entries.values()].reduce((sum, e) => sum + (e.kind === "file" ? Number(e.stat.size) : 0), 0) - Number(entry?.stat.size ?? 0n) + bytes.length > this.#limits.workspaceBytes) throw new ScopedCodingFileError("limit");
    const result = this.#result({ path: virtual(path), bytes: bytes.length, sha256: digest(bytes), created: !entry });
    const parent = await this.#parent(path, entries), temporary = `.ember-coding-${randomUUID()}`;
    const tempPath = `/proc/self/fd/${parent.directory.fd}/${temporary}`, target = `/proc/self/fd/${parent.directory.fd}/${parent.name}`;
    let created = false;
    try {
      const file = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry && (entry.stat.mode & 0o111n) ? 0o700 : 0o600);
      created = true;
      try {
        this.#current();
        const stat = await this.#wait(file.stat({ bigint: true }));
        if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== this.#identity.uid || await this.#wait(mountId(file)) !== this.#mount) throw new ScopedCodingFileError("boundary");
        await this.#wait(file.writeFile(bytes)); await this.#wait(file.sync());
      } finally { await file.close(); }
      await this.#checkRoot(this.#rootPath);
      await this.#wait(fs.rename(tempPath, target)); created = false;
      await this.#wait(parent.directory.sync());
      return result;
    } finally { if (created) await fs.unlink(tempPath).catch(() => undefined); await parent.directory.close(); }
  }

  delete(path: string): Promise<{ path: string; kind: "file" | "directory"; deleted: true }> {
    return this.#lease(async entries => {
      const relative = normalized(path, false), entry = this.#entry(relative, entries);
      if (entry.kind === "file") await this.#text(entry, entries);
      else if ([...entries.keys()].some(path => path.startsWith(relative + "/"))) throw new ScopedCodingFileError("not-empty");
      const result = this.#result({ path: virtual(relative), kind: entry.kind, deleted: true as const });
      const parent = await this.#parent(relative, entries);
      try {
        const target = `/proc/self/fd/${parent.directory.fd}/${parent.name}`;
        if (entry.kind === "directory") await this.#wait(fs.rmdir(target)); else await this.#wait(fs.unlink(target));
        await this.#wait(parent.directory.sync());
      } finally { await parent.directory.close(); }
      return result;
    });
  }
  mkdir(path: string): Promise<{ path: string; created: true }> {
    return this.#lease(async entries => {
      const relative = normalized(path, false); this.#allow(relative, true); this.#newPath(relative, entries);
      if (entries.has(relative)) throw new ScopedCodingFileError("exists");
      const result = this.#result({ path: virtual(relative), created: true as const });
      const parent = await this.#parent(relative, entries);
      try { await this.#wait(fs.mkdir(`/proc/self/fd/${parent.directory.fd}/${parent.name}`, { mode: 0o700 })); await this.#wait(parent.directory.sync()); }
      finally { await parent.directory.close(); }
      return result;
    });
  }

  /** Host command-policy probes only: facts refer to virtual /work, never to the host copy or source paths. */
  inspect(paths: readonly string[], cwd = "/work"): Promise<PathFact[]> {
    const captured = Array.isArray(paths) ? [...paths] : [];
    return this.#lease(async entries => {
      if (!Array.isArray(paths) || captured.length > 200) throw new ScopedCodingFileError("limit");
      const folder = normalized(cwd);
      if (folder && entries.get(folder)?.kind !== "directory") throw new ScopedCodingFileError("path");
      return captured.map(value => {
        const unknown: PathFact = { exists: null, real: null };
        try {
          if (typeof value !== "string" || !value) return unknown;
          const relative = normalized(value.startsWith("/") ? value : folder ? `${folder}/${value}` : value);
          if (this.#isExcluded(relative)) return unknown;
          if (!relative) return { exists: true, real: "/work", dir: true };
          const existing = entries.get(relative);
          if (existing) return { exists: true, real: virtual(relative), ...(existing.kind === "directory" ? { dir: true } : {}) };
          const parts = relative.split("/");
          for (let i = 1; i < parts.length; i++) if (entries.get(parts.slice(0, i).join("/"))?.kind === "file") return unknown;
          return { exists: false, real: virtual(relative) };
        } catch { return unknown; }
      });
    });
  }

  searchLiteral(query: string, path = "/work"): Promise<ScopedCodingSearchResult> {
    return this.#lease(async entries => {
      if (typeof query !== "string" || !query || Buffer.byteLength(query) > 1024 || /[\r\n\0]/.test(query)) throw new ScopedCodingFileError("path");
      if (memoryRefusal(query)) throw new ScopedCodingFileError("secret");
      const relative = normalized(path), selected = relative ? this.#entry(relative, entries) : null;
      const result: ScopedCodingSearchResult = { path: virtual(relative), matches: [], files: 0, withheld: withheld(), ...(this.#excluded.length ? { excludedRoots: [...this.#excluded] } : {}) };
      for (const entry of [...entries.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
        if (entry.kind !== "file" || (relative && entry.path !== relative && (selected?.kind !== "directory" || !entry.path.startsWith(relative + "/")))) continue;
        const why = this.#isExcluded(entry.path) ? "unsupported" : privacy(entry.path);
        if (why) { result.withheld[why]++; continue; }
        let file: { text: string; bytes: Buffer; sha256: string };
        try { file = await this.#text(entry, entries); }
        catch (error) {
          if (error instanceof ScopedCodingFileError && (error.code === "secret" || error.code === "binary")) { result.withheld[error.code === "secret" ? "secrets" : "binary"]++; continue; }
          throw error;
        }
        result.files++;
        for (const [index, line] of file.text.split("\n").entries()) if (line.includes(query)) {
          if (result.matches.length >= this.#limits.searchMatches) throw new ScopedCodingFileError("limit");
          result.matches.push({ path: virtual(entry.path), line: index + 1, text: line });
          this.#result(result);
        }
      }
      return result;
    });
  }
}

function sanitize(error: unknown): ScopedCodingFileError {
  if (error instanceof ScopedCodingFileError) return new ScopedCodingFileError(error.code);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new ScopedCodingFileError(code === "ENOENT" ? "missing" : code === "EEXIST" ? "exists" : "io");
}
