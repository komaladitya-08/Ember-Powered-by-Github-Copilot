/**
 * The approval setting as Ember itself last recorded it, sealed with the system's keyring (safeStorage), in
 * approvals-seal.bin (0600) beside settings.json (modes-x9s-2, modes-x9p-5). settings.json is a file any program the
 * user runs can write, a text editor a worker drives included, so a mode that asks less, or the agreement to Assisted's
 * or Autopilot's card, is taken from it at start only where it matches this seal (policy/mode-record.ts). Only Ember
 * writes the seal, after a change it made itself (Home's choice, a voice or typed intent). Where the keyring is
 * `basic_text` or unavailable nothing is sealed: those agreements then last until Ember quits. Plain Node: the keyring
 * is passed in.
 */

import fs from "node:fs";
import { z } from "zod";
import { APPROVAL_MODES } from "../../shared/approvals";
import type { SecretBox } from "../agent/auth";
import type { ApprovalsSetting } from "./autonomy";

const Card = z.object({ version: z.number().int().min(0), at: z.string().nullable() }).strict();
const Sealed = z.object({ mode: z.enum(APPROVAL_MODES), consent: z.object({ interactive: Card, assisted: Card, autopilot: Card }).strict() }).strict();

/** What policy/mode-record.ts reads and writes. */
export interface ModeSealStore {
  /** The sealed setting; null when there is none, or it can't be opened or read (then nothing above Interactive is trusted). */
  read(): Promise<ApprovalsSetting | null>;
  /** Seals `s`; false when it can't be kept (no keyring, a write that failed). */
  write(s: ApprovalsSetting): Promise<boolean>;
}

export class ModeSeal implements ModeSealStore {
  /** Writes one after another, in the order they were asked for, so the last change made is the one kept. */
  private saving: Promise<unknown> = Promise.resolve();

  /** `asyncKeyring` (macOS): the keyring is asked off the main process's thread, as the sign-in's is (auth.ts TokenStore). */
  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean } = {}) {}

  private async usable(): Promise<boolean> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text") return false;
    return this.opts.asyncKeyring ? ((await this.box.isAsyncEncryptionAvailable?.()) ?? true) : this.box.isEncryptionAvailable();
  }

  async read(): Promise<ApprovalsSetting | null> {
    try {
      if (!(await this.usable())) return null;
      const sealed = fs.readFileSync(this.file);
      const text = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(sealed)).result : this.box.decryptString(sealed);
      const parsed = Sealed.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // none, or one the keyring won't open: nothing above Interactive is taken from the file
    }
  }

  write(s: ApprovalsSetting): Promise<boolean> {
    const run = this.saving.then(async () => {
      if (!(await this.usable())) return false;
      const text = JSON.stringify(Sealed.parse(s));
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
