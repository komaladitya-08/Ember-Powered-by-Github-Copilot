/**
 * The remote's own consent record (§5.3.9, R11): state/<machine>/consent.json, `{ version, from, pcId, at, user }`,
 * written at the first serve after the user's per-host consent on the PC (and again when another PC or a newer
 * consent version comes), so the remote keeps its own note of who let Ember in and when. The PC's consent is the one
 * that counts; this is the remote's record of it. Plain Node.
 */

import fs from "node:fs";
import { z } from "zod";
import { FEATURE_CONSENT_VERSION } from "../shared/consent";

/** consent.json. */
export interface ConsentRecord {
  version: number;
  /** The PC's name as it reported it (unverified). */
  from: string;
  pcId: string;
  /** When the user consented on the PC (its own clock: a record, never compared). */
  at: string;
  /** This machine's login Ember serves. */
  user: string;
}

const RecordSchema = z.object({ version: z.number().int(), from: z.string(), pcId: z.string(), at: z.string(), user: z.string() }).strict();

/** Is the PC's per-host consent one this agent may serve under? */
export function consentAccepted(consent: { version: number }): boolean {
  return Number.isInteger(consent.version) && consent.version >= FEATURE_CONSENT_VERSION.ssh;
}

/** Writes `rec` unless consent.json already records the same PC at this version; returns whether it wrote. */
export function recordConsent(file: string, rec: ConsentRecord, io: { read(file: string): string | null; write(file: string, text: string): void } = {
  read: f => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } },
  write: (f, text) => { fs.writeFileSync(f, text, { mode: 0o600 }); },
}): boolean {
  const old = io.read(file);
  if (old !== null) {
    try {
      const prev = RecordSchema.parse(JSON.parse(old));
      if (prev.pcId === rec.pcId && prev.version === rec.version && prev.user === rec.user) return false;
    } catch { /* unreadable: written again */ }
  }
  io.write(file, `${JSON.stringify(rec)}\n`);
  return true;
}
