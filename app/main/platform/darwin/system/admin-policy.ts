/**
 * The administrator's policy on a Mac: /Library/Application Support/Ember/policy.json (decision D7). It can only make
 * Ember stricter, so anything but "it isn't there" that keeps Ember from trusting it locks Ember down (admin.ts's
 * LOCKDOWN): the folder must be a real folder (not a link) that belongs to root and that only root can write, and the
 * file must not be a link and passes admin.ts's own root-owner check. `/Library/Application Support` is root:admin
 * 0755, so creating the Ember folder already takes an administrator. In development main passes EMBER_ADMIN_POLICY,
 * read without the owner check, as on Linux.
 */

import fs from "node:fs";
import type { AdminPolicySource } from "../../types";
import { AdminPolicySchema, loadAdminPolicy, lockedDown, providerApiKey, type LoadedAdminPolicy } from "../../../admin";

/** Where the policy folder is. */
export const POLICY_FOLDER = "/Library/Application Support/Ember";
/** Where the doctor and settings window say the policy lives. */
export const POLICY_FILE = `${POLICY_FOLDER}/policy.json`;

/** What lstat answers, as far as the checks read it. */
export interface PolicyStat { uid: number; mode: number; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }

/** Seams for the tests: lstat (throws like fs.lstatSync) and the file loader (admin.ts's). */
export interface DarwinPolicyDeps {
  lstat?: (p: string) => PolicyStat;
  load?: (file: string, o: { requireRootOwned: boolean }) => LoadedAdminPolicy;
}

const absent = (): LoadedAdminPolicy => ({ policy: AdminPolicySchema.parse({}), source: null });
const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

/** The macOS policy source (design §9.4). */
export function darwinAdminPolicy(d: DarwinPolicyDeps = {}): AdminPolicySource {
  const lstat = d.lstat ?? ((p: string) => fs.lstatSync(p));
  const load = d.load ?? ((file: string, o: { requireRootOwned: boolean }) => loadAdminPolicy(file, o));
  return {
    location: POLICY_FILE,

    load(devOverride?: string): LoadedAdminPolicy {
      if (devOverride !== undefined) return load(devOverride, { requireRootOwned: false });
      let folder: PolicyStat;
      try {
        folder = lstat(POLICY_FOLDER);
      } catch (err) {
        if (code(err) === "ENOENT") return absent();
        return lockedDown(POLICY_FOLDER, `can't check ${POLICY_FOLDER}: ${(err as Error).message}`);
      }
      // lstat: a link to a folder someone else controls is not the folder an administrator made.
      if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== 0 || (folder.mode & 0o022) !== 0) {
        return lockedDown(POLICY_FOLDER, `${POLICY_FOLDER} must belong to root and be writable only by root`);
      }
      let file: PolicyStat;
      try {
        file = lstat(POLICY_FILE);
      } catch (err) {
        if (code(err) === "ENOENT") return absent();
        return lockedDown(POLICY_FILE, `can't check ${POLICY_FILE}: ${(err as Error).message}`);
      }
      if (file.isSymbolicLink() || !file.isFile()) return lockedDown(POLICY_FILE, `${POLICY_FILE} must be a file, not a link or a folder`);
      return load(POLICY_FILE, { requireRootOwned: true });
    },

    providerApiKey: p => providerApiKey(p),
  };
}
