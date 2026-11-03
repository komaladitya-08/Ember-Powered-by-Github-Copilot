/**
 * win32-system.test.ts proves autostart through a real Electron child, which must leave Electron from the main message
 * loop. "ready" is emitted before that loop runs, and an app.exit() there goes through the C runtime's exit(): its
 * static destructors free Chromium's sandbox broker while a thread-pool worker is still launching the GPU process, so
 * about one start in eight crashed with 0xC0000005 after the dark-mode test's theme change (CI's Windows job, PRs #133,
 * #134, #142 and #143; the dumps' stacks end in sandbox::TopLevelDispatcher and GpuSandboxedProcessLauncherDelegate::
 * InitializeConfig under Browser::ExitWithCode; electron/electron#55011). The child is inline source in that test, so
 * its exit is read from the source, as main-doctor-exit.test.ts reads main.ts.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(path.resolve("test/integration/win32-system.test.ts"), "utf8");

/** The login-item child's main script: the template literal written to autostart-main.cjs. */
function childScript(): string {
  const start = SOURCE.indexOf("fs.writeFileSync(main, `");
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("`);", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("the Windows login-item test's Electron child", () => {
  it("leaves Electron from the message loop, never from inside ready, so it doesn't crash on exit (electron/electron#55011)", () => {
    const code = childScript().replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("app.whenReady().then(");
    expect(code).toContain("setImmediate(() => app.exit(0));");
    // The only app.exit is the deferred one.
    expect(code.match(/app\.exit\(/g)).toHaveLength(1);
  });
});
