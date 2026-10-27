/**
 * No internal terms in what the user reads (review #222): "job host", "worker", "Node download", "Ember v1", "needs
 * vision" and "brain" are replaced by plain words, with a next step where one helps.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { inspectEnvironment } from "../../app/main/environment";
import { MESSAGES } from "../../app/main/remote/ssh-errors";

const versions = { electron: "44.5.0", chrome: "152", node: "24" };
const RHEL84 = 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.4"\nID="rhel"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n';
const env = (more: Record<string, unknown>) => inspectEnvironment({
  env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" }, osRelease: RHEL84, glibc: "2.28", versions, platform: "linux", arch: "x64",
  accessibility: { enabled: true, pyatspi: true }, ...more,
});
const detail = (r: ReturnType<typeof inspectEnvironment>, id: string) => r.checks.find(c => c.id === id)?.detail ?? "";

describe("plain words instead of internal terms", () => {
  it("the setup check doesn't talk about a version 1", () => {
    expect(detail(env({ arch: "arm64" }), "platform")).toBe("linux/arm64 isn't supported");
    const wayland = detail(env({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" } }), "session");
    expect(wayland).toMatch(/^Wayland session\. Ember needs “GNOME on Xorg”/);
    expect(wayland).not.toMatch(/\bv1\b/);
  });

  it("a failed SSH set-up doesn't name Node", () => {
    expect(MESSAGES.downloadMismatch("build-01")).toBe("Ember couldn't check what it downloaded for build-01 (it doesn't match the expected file). Try again later.");
  });

  it("no user-facing string says job host, worker, brain or needs vision", () => {
    const root = path.join(__dirname, "../..");
    const banned = [/job host is missing/, /job host couldn't/, /The worker stopped/, /brain is not connected/, /needs vision/, /Node download for/];
    for (const f of ["app/main/commands/run/local.ts", "app/main/wsl/discover.ts", "app/main/wsl/runner.ts", "app/main/agent/worker.ts", "app/main/agent/conductor.ts", "app/renderer/home/index.html", "app/main/remote/ssh-errors.ts"]) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      for (const b of banned) expect(text, `${f} ${b}`).not.toMatch(b);
    }
  });
});
