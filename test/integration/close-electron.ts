/** Bounded cleanup for a test-owned Electron process; its hook must outlive the graceful-close deadline. */
import type { ChildProcess } from "node:child_process";

/** Grace already used by the native app suite before force-closing its own test process. */
export const ELECTRON_CLOSE_GRACE_MS = 10_000;
/** Leave time after the grace for native input/window handles and temporary-profile cleanup. */
export const ELECTRON_CLEANUP_TIMEOUT_MS = 20_000;

/** Only the process object captured from this test's app may be terminated, never a process found by name or PID. */
interface TestElectronApp {
  close(): Promise<void>;
  process(): Pick<ChildProcess, "exitCode" | "signalCode" | "kill">;
}

/** Close a test app within its grace, clearing the timer on every path. True means a live process needed SIGKILL. */
export async function closeTestElectron(app: TestElectronApp): Promise<boolean> {
  const proc = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close().catch(() => { /* A closed transport may reject; the captured process state decides cleanup. */ }),
      new Promise<void>(resolve => { timer = setTimeout(resolve, ELECTRON_CLOSE_GRACE_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return false;
  proc.kill("SIGKILL");
  return true;
}
