/**
 * Only Ember's own bundled pages may use the settings IPC (isTrustedSender, windows.ts). File URLs use "/" on every
 * OS, so a Windows install's pages are recognised too (the "\" separator test refused every one of them there).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {} }));

const { isTrustedSender } = await import("../../app/main/windows");

describe("isTrustedSender", () => {
  it("trusts Ember's own pages on Linux, as before", () => {
    expect(isTrustedSender("file:///opt/ember/resources/app.asar/dist/app/renderer/home/index.html")).toBe(true);
    expect(isTrustedSender("file:///home/dev/ember/dist/app/renderer/home/index.html")).toBe(true);
  });

  it("trusts them on Windows, where the install path has spaces and a drive letter", () => {
    expect(isTrustedSender("file:///C:/Program%20Files/Ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
    expect(isTrustedSender("file:///C:/Users/Ana%20Lopez/AppData/Local/Programs/Ember/resources/app/dist/app/renderer/home/index.html")).toBe(true);
  });

  it("trusts them on macOS, inside the app bundle", () => {
    expect(isTrustedSender("file:///Applications/Ember.app/Contents/Resources/app/dist/app/renderer/home/index.html")).toBe(true);
  });

  it("refuses a page outside Ember's renderer folder, and anything that isn't a local file", () => {
    expect(isTrustedSender("file:///tmp/evil/index.html")).toBe(false);
    expect(isTrustedSender("file:///tmp/renderer-ish/index.html")).toBe(false);
    expect(isTrustedSender("https://example.com/renderer/home/index.html")).toBe(false);
    expect(isTrustedSender("devtools://devtools/renderer/index.html")).toBe(false);
    expect(isTrustedSender("")).toBe(false);
  });

  it("doesn't take a Windows backslash as a folder separator in a URL", () => {
    expect(isTrustedSender("file:///C:/evil/%5Crenderer%5C/index.html")).toBe(false);
  });
});
