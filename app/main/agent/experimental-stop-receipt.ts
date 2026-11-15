/** Linux PID-namespace identity receipt for the disposable, tokenless Bubblewrap experiment only. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { HOST_PLATFORM } from "../platform/os";

const receiptSchema = z.object({
  "child-pid": z.number().int().positive().max(0x7fffffff),
  "pid-namespace": z.number().int().positive().safe(),
  "mnt-namespace": z.number().int().positive().safe(),
  "ipc-namespace": z.number().int().positive().safe().optional(),
  "net-namespace": z.number().int().positive().safe().optional(),
  "uts-namespace": z.number().int().positive().safe().optional(),
}).strict();

function startTime(stat: string, pid: number): string {
  const end = stat.lastIndexOf(")");
  if (!stat.startsWith(`${pid} (`) || end < 0) throw new Error("The namespace process identity cannot be verified.");
  const value = stat.slice(end + 1).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(value ?? "")) throw new Error("The namespace process identity cannot be verified.");
  return value;
}

/** No public constructor: an SDK success/idle event or caller-supplied boolean cannot mint this receipt. */
export class ExperimentalNamespaceReceipt {
  private constructor(private readonly pid: number, private readonly started: string, private readonly namespace: string) {}

  static async capture(file: string): Promise<ExperimentalNamespaceReceipt> {
    if (HOST_PLATFORM !== "linux") throw new Error("Namespace stop receipts require Linux.");
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Invalid namespace receipt file.");
      text = await handle.readFile("utf8");
      const after = await handle.stat();
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("The namespace receipt changed.");
    } finally { await handle.close(); }
    const receipt = receiptSchema.parse(JSON.parse(text));
    const pid = receipt["child-pid"], expected = `pid:[${receipt["pid-namespace"]}]`;
    const before = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const [status, namespace, mountNamespace] = await Promise.all([
      fs.readFile(`/proc/${pid}/status`, "utf8"), fs.readlink(`/proc/${pid}/ns/pid`), fs.readlink(`/proc/${pid}/ns/mnt`),
    ]);
    const after = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    for (const kind of ["ipc", "net", "uts"] as const) {
      const identity = receipt[`${kind}-namespace`];
      if (identity !== undefined && await fs.readlink(`/proc/${pid}/ns/${kind}`) !== `${kind}:[${identity}]`) throw new Error("The namespace receipt does not match its process.");
    }
    const pids = /^NSpid:\s*(.*?)\s*$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
    if (!pids || pids.length < 2 || pids[0] !== pid || pids.at(-1) !== 1 || namespace !== expected ||
        mountNamespace !== `mnt:[${receipt["mnt-namespace"]}]` || startTime(before, pid) !== startTime(after, pid)) {
      throw new Error("The runtime is not the verified PID-namespace init process.");
    }
    return new ExperimentalNamespaceReceipt(pid, startTime(after, pid), namespace);
  }

  /** Once this namespace's original PID 1 exits, the Linux kernel kills its remaining namespace descendants. */
  async requireExited(timeoutMs = 3000): Promise<void> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      let stat: string;
      try { stat = await fs.readFile(`/proc/${this.pid}/stat`, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("The namespace shutdown could not be verified.", { cause: error });
      }
      if (startTime(stat, this.pid) !== this.started) throw new Error("The namespace PID was reused; shutdown is unverified.");
      const namespace = await fs.readlink(`/proc/${this.pid}/ns/pid`).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (namespace !== null && namespace !== this.namespace) throw new Error("The namespace process identity changed.");
      // Some container PID1s never reap orphaned children. Linux kills the PID-namespace descendants before its init
      // becomes a zombie. Its PID namespace link can persist until reaping, but its live mount association is gone.
      if (stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0] === "Z") {
        const mount = await fs.readlink(`/proc/${this.pid}/ns/mnt`).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (mount === null) return;
      }
      if (performance.now() >= end) throw new Error("The runtime's namespace init has not exited.");
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  }
}
