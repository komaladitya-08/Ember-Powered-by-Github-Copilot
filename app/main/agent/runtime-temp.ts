/**
 * The Copilot runtime's own temporary folder. The runtime writes large tool output (about 2.5 MB and more, a result or
 * a failure) to `$TMPDIR/<time>-copilot-tool-output-<hex>.txt`, mode 0644, and never removes it; with the system's
 * TMPDIR that is /tmp, which every user on the computer can read (security audit of the extensions runtime). So the
 * runtime gets a folder of its own in Ember's data folder, 0700, emptied when Ember connects and when it signs out.
 * Plain Node.
 */

import fs from "node:fs";
import path from "node:path";

/** Where the runtime's temporary files go: `<userData>/copilot-tmp`. */
export function runtimeTempDir(userData: string): string {
  return path.join(userData, "copilot-tmp");
}

/** Empties (or makes) the folder, 0700. Returns it. Throws when it can't be made: the runtime then isn't started. */
export function clearRuntimeTemp(dir: string): string {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows keeps its own ACLs (the folder is in the user's profile) */ }
  return dir;
}

/** The runtime's temporary-folder variables, every spelling the runtime's platforms read. */
export function runtimeTempEnv(dir: string): Record<"TMPDIR" | "TMP" | "TEMP", string> {
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

/** The runtime's pointer to output it saved to a file instead of passing on whole. */
export const SAVED_OUTPUT = /copilot-tool-output-[0-9a-f]+\.txt|\bSaved to:/i;
