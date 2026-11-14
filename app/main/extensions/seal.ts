/**
 * The keyring's seal of the extensions list as Ember itself wrote it (safety-privacy-r12-2). extensions.json is a file
 * any program can write, a file manager a worker drives included, and an item in it names a program Ember's launcher
 * starts, outside run_command, its classifier and Stop. So an item is taken from the file only as Ember wrote it: each
 * time Ember saves the list it seals a digest of every item it trusts (extensions-seal.bin, 0600, through safeStorage),
 * and at start an item whose digest isn't in the seal is neither started nor probed, and its agreement is withdrawn
 * until the user agrees again in Home. Without a keyring (`basic_text`) nothing is sealed: an agreement then lasts
 * until Ember quits, as the provider's does (provider-record.ts). Plain Node: the keyring is passed in.
 */

import crypto from "node:crypto";
import fs from "node:fs";
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
