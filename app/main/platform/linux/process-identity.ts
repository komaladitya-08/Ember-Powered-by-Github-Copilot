/** Linux process identities: a cached pid alone may name an unrelated process after the original exits. */
import fs from "node:fs";

export interface ProcessIdentity { pid: number; start: number; group: number }
export type ReadProcess = (file: string) => string;
const readProc: ReadProcess = file => fs.readFileSync(file, "utf8");

/** /proc/<pid>/stat's comm may contain spaces and parentheses; starttime is field 22 after the final ')'. */
export function processIdentity(stat: string): ProcessIdentity | null {
  const head = /^(\d+) \(/.exec(stat);
  const end = stat.lastIndexOf(") ");
  if (!head || end < head[0].length) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[2] ?? "") || !/^\d+$/.test(fields[19] ?? "")) return null;
  const pid = Number(head[1]), group = Number(fields[2]), start = Number(fields[19]);
  return Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(group) && group > 0 && Number.isSafeInteger(start)
    ? { pid, group, start } : null;
}

export function readProcessIdentity(pid: number, read: ReadProcess = readProc): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const identity = processIdentity(read(`/proc/${pid}/stat`));
    return identity?.pid === pid ? identity : null;
  } catch { return null; }
}

/** Check immediately before each signal. Unreadable or reused ids are left alone; no await separates check and kill. */
export function signalProcess(identity: ProcessIdentity, signal: NodeJS.Signals, o: {
  group?: boolean; read?: ReadProcess; kill?: (pid: number, signal: NodeJS.Signals) => void;
} = {}): boolean {
  const current = readProcessIdentity(identity.pid, o.read);
  if (!current || current.start !== identity.start || current.group !== identity.group) return false;
  if (o.group && current.group !== current.pid) return false;
  try { (o.kill ?? process.kill)(o.group ? -identity.pid : identity.pid, signal); return true; } catch { return false; }
}
