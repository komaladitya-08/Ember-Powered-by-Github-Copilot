/**
 * App names in Settings › Apps & privacy: a grant for an app on another computer reads as that app there (review #194),
 * and the Linux table names the apps people run most (review #164).
 */
import { afterEach, describe, expect, it } from "vitest";
import { friendlyApp, useAppNames } from "../../app/shared/apps";

afterEach(() => useAppNames("linux"));

describe("a grant for an app on a computer reached over SSH (review #194)", () => {
  it("reads as the app on that computer, on every OS", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      useAppNames(os);
      expect(friendlyApp("ssh:build-01:gedit"), os).toBe("gedit on build-01");
      expect(friendlyApp("ssh:build-01:org.gnome.nautilus"), os).toBe("Files on build-01");
      expect(friendlyApp("ssh:mac-mini:com.apple.textedit"), os).toBe("TextEdit on mac-mini");
      expect(friendlyApp("ssh:build-01:mousepad"), os).toBe("Mousepad on build-01");
    }
  });

  it("leaves names that only look like one alone", () => {
    expect(friendlyApp("ssh")).toBe("Ssh");
    expect(friendlyApp("ssh:")).toBe("ssh:");
  });
});

describe("the Linux table names the apps people run most (review #164)", () => {
  it("names Chrome, Visual Studio Code and Slack as people say them", () => {
    expect(friendlyApp("google-chrome")).toBe("Google Chrome");
    expect(friendlyApp("google-chrome-stable")).toBe("Google Chrome");
    expect(friendlyApp("code")).toBe("Visual Studio Code");
    expect(friendlyApp("slack")).toBe("Slack");
    expect(friendlyApp("com.slack.Slack")).toBe("Slack");
  });
});
