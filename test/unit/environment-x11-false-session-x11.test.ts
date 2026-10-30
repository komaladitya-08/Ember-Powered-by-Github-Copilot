/**
 * Regression for #70: inspectEnvironment trusts XDG_SESSION_TYPE=x11 over the
 * measured fact that Ember could not open the X display. With DISPLAY set but
 * x11 === false, the setup check (and so `ember doctor` and the greeting)
 * reported the desktop session as OK, so the user was never told Ember can't
 * reach the display.
 */

import { describe, expect, it } from "vitest";
import { inspectEnvironment, type EnvInputs } from "../../app/main/environment";

const base: EnvInputs = {
  env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":9" },
  osRelease: 'ID="rhel"\nVERSION_ID="8.4"\nPRETTY_NAME="RHEL 8.4"\n',
  glibc: "2.28",
  versions: { electron: "44.5.0", chrome: "152", node: "24.21.0" },
  platform: "linux",
  arch: "x64",
  x11: false,
};

describe("the Linux setup check with an X session it could not open", () => {
  it("does not call the desktop session OK when DISPLAY could not be opened", () => {
    const session = inspectEnvironment(base).checks.find(c => c.id === "session")!;
    expect(session.status).toBe("fail");
    expect(session.detail).not.toBe("X11 on :9");
  });

  it("still reports an X11 session OK when the display opened", () => {
    const session = inspectEnvironment({ ...base, x11: true }).checks.find(c => c.id === "session")!;
    expect(session.status).toBe("ok");
    expect(session.detail).toBe("X11 on :9");
  });

  it("keeps the fallback for sessions without a measured x11 fact", () => {
    const session = inspectEnvironment({ ...base, x11: undefined }).checks.find(c => c.id === "session")!;
    expect(session.status).toBe("ok");
    expect(session.detail).toBe("X11 on :9");
  });
});
