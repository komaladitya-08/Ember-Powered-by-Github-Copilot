/**
 * The keyring's seal of the extensions list as Ember itself wrote it (safety-privacy-r12-2). extensions.json is a file
 * any program can write, a file manager a worker drives included, and an item in it names a program Ember's launcher
 * starts, outside run_command, its classifier and Stop. So an item is taken from the file only as Ember wrote it: each
 * time Ember saves the list it seals a digest of every item it trusts (extensions-seal.bin, 0600, through safeStorage),
 * and at start an item whose digest isn't in the seal is neither started nor probed, and its agreement is withdrawn
 * until the user agrees again in Home. Without a keyring (`basic_text`) nothing is sealed: an agreement then lasts
 * until Ember quits, as the provider's does (provider-record.ts). Plain Node: the keyring is passed in.
 *
 * A plugin's server runs from its own copy in `extensions/plugins/<id>/`, which any program can write as well: a
 * server.js pasted there starts with the item's next launch (r12-safety-x12-4). So what is sealed for an item is its
 * digest together with its folder's (`pluginDigest`: every file's path, content and whether it may run), and the
 * service checks the folder against it before each launch or probe (`pluginStamp` first, a cheap look at what each
 * file's stat says, and the content only where that changed). What a plugin's own runtime writes beside its files
 * (Python's `__pycache__`, uv's `.venv`, a `.cache`) is left out, or every such plugin would need agreeing to again.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SecretBox } from "../agent/auth";
import { canonical } from "./pin";

/** The file in Ember's data folder that holds the seal. */
export const EXTENSIONS_SEAL_FILE = "extensions-seal.bin";

/** What the service reads and writes: the digests of the items Ember wrote and trusts. */
export interface ExtensionSealStore {
  /** The sealed digests; null when there is none, or it can't be opened or read (then no item in the file is trusted). */
  read(): Promise<string[] | null>;
  /** Seals `digests`; false when they can't be kept (no keyring, a write that failed). */
  write(digests: string[]): Promise<boolean>;
}

const Sealed = z.object({ version: z.literal(1), items: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(10_000) }).strict();

/** An item's digest: every field of it as written, in a fixed order (what runs, its tools, the user's agreement). */
export function itemDigest(item: unknown): string {
  return crypto.createHash("sha256").update(canonical(item)).digest("hex");
}

/** Folders a plugin's own runtime writes into its folder (bytecode, an environment, caches): not sealed. */
const RUNTIME_DIR = /^(?:__pycache__|\.venv|\.cache|\.pytest_cache|\.mypy_cache)$/;
/** More entries than a plugin may be copied with (store.ts's COPY_LIMITS) and then some: never trusted. */
const MAX_ENTRIES = 50_000;

interface Entry { rel: string; st: fs.Stats }

/** What `dir` holds, sorted by path (its runtime's own folders left out); null where it is too big to look at. */
function entries(dir: string): Entry[] | null {
  const out: Entry[] = [];
  const walk = (rel: string): boolean => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory() && RUNTIME_DIR.test(name)) continue;
      out.push({ rel: r, st });
      if (out.length > MAX_ENTRIES) return false;
      if (st.isDirectory() && !walk(r)) return false;
    }
    return true;
  };
  return walk("") ? out : null;
}

const kindOf = (st: fs.Stats): string => (st.isFile() ? "f" : st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "o");

/**
 * A cheap print of a plugin's folder: each entry's path, kind and what its stat says (size, times, inode, whether it
 * may run). Any write, rename or replacement changes it (a file's change time can't be set back). "none" where there
 * is no folder; a value that never matches where it can't be read. Synchronous: reads no file's content.
 */
export function pluginStamp(dir: string): string {
  try {
    if (!fs.existsSync(dir)) return "none";
    const all = entries(dir);
    if (!all) return `unreadable:${crypto.randomUUID()}`;
    const h = crypto.createHash("sha256");
    for (const { rel, st } of all) h.update(`${rel}\0${kindOf(st)}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}\0${st.mode & 0o100}\n`);
    return h.digest("hex");
  } catch {
    return `unreadable:${crypto.randomUUID()}`; // can't be looked at: never matches
  }
}

/**
 * The digest of a plugin's folder as it is: every entry's path and kind, and each file's content and whether it may
 * run (a link, which copyPlugin never makes, by kind alone). "none" where there is no folder; a value that never
 * matches where it can't be read.
 */
export async function pluginDigest(dir: string): Promise<string> {
  try {
    if (!fs.existsSync(dir)) return "none";
    const all = entries(dir);
    if (!all) return `unreadable:${crypto.randomUUID()}`;
    const h = crypto.createHash("sha256");
    for (const { rel, st } of all) {
      const kind = kindOf(st);
      const content = kind === "f" ? crypto.createHash("sha256").update(await fs.promises.readFile(path.join(dir, rel))).digest("hex") : "";
      h.update(`${rel}\0${kind}\0${kind === "f" ? st.mode & 0o100 : 0}\0${content}\n`);
    }
    return h.digest("hex");
  } catch {
    return `unreadable:${crypto.randomUUID()}`;
  }
}

/** What is sealed for an item: its own digest (itemDigest) with its folder's (pluginDigest). */
export function sealDigest(item: string, folder: string): string {
  return crypto.createHash("sha256").update(`${item}\n${folder}`).digest("hex");
}

/** The keyring's seal (provider-record.ts's ProviderSeal, for the extensions list). */
export class ExtensionSeal implements ExtensionSealStore {
  private saving: Promise<unknown> = Promise.resolve();

  /** `asyncKeyring` (macOS): the keyring is asked off the main process's thread. */
  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean } = {}) {}

  private async usable(): Promise<boolean> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text") return false;
    return this.opts.asyncKeyring ? ((await this.box.isAsyncEncryptionAvailable?.()) ?? true) : this.box.isEncryptionAvailable();
  }

  async read(): Promise<string[] | null> {
    try {
      if (!(await this.usable())) return null;
      const sealed = fs.readFileSync(this.file);
      const text = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(sealed)).result : this.box.decryptString(sealed);
      const parsed = Sealed.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.items : null;
    } catch {
      return null; // none, or one the keyring won't open: no item in the file is trusted
    }
  }

  write(digests: string[]): Promise<boolean> {
    const run = this.saving.then(async () => {
      if (!(await this.usable())) return false;
      const text = JSON.stringify(Sealed.parse({ version: 1, items: digests }));
      const sealed = this.opts.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(text) : this.box.encryptString(text);
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, sealed, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        return true;
      } catch {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
        return false;
      }
    }).catch(() => false);
    this.saving = run;
    return run;
  }
}
