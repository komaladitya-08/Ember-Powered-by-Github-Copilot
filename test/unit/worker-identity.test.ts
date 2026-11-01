/** The worker's identity matches its tools (review #146): it may borrow the mouse or keyboard, always asking first. */

import { describe, expect, it } from "vitest";
import { WORKER_IDENTITY, workerIdentity } from "../../app/main/agent/worker-persona";
import { PLATFORM_WORDS } from "../../app/shared/words";

describe("the worker's identity", () => {
  it("doesn't promise never to use the mouse or keyboard that press_keys, scroll and borrowed clicks use", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      const id = workerIdentity(PLATFORM_WORDS[os]);
      expect(id).not.toMatch(/without moving the user's mouse/);
      expect(id).toMatch(/accessibility system first/);
      expect(id).toMatch(/borrow the user's mouse or keyboard/);
      expect(id).toMatch(/always asked first/);
    }
    expect(workerIdentity(PLATFORM_WORDS.linux, { kind: "ssh", label: "build-01", desktop: "screen" })).toMatch(/accessibility system first[\s\S]*You work on build-01/);
    expect(WORKER_IDENTITY).toBe(workerIdentity(PLATFORM_WORDS.linux));
  });
});
