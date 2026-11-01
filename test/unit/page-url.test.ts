/**
 * Ember's windows load their bundled pages by a file URL that pathToFileURL wrote (page-url.ts), not with loadFile.
 * loadFile leaves a literal % in the install folder's name as it is, and Chromium then decodes it: in a folder named
 * "50%AB" every window stayed blank (ERR_FILE_NOT_FOUND, checked with Electron 44). Review #200.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pageUrl } from "../../app/main/page-url";

vi.mock("electron", () => ({ BrowserWindow: class {} }));
const { isTrustedSender } = await import("../../app/main/windows");

const page = (folder: string) => path.join(path.resolve("/"), "opt", folder, "ember", "resources", "app", "dist", "app", "renderer", "home", "index.html");

describe("pageUrl", () => {
  it("writes a literal % as %25, so Chromium finds the file in a folder named 50%AB or 100% Free", () => {
    expect(pageUrl(page("50%AB"))).toMatch(/^file:\/\/.*\/opt\/50%25AB\/ember\/.*\/renderer\/home\/index\.html$/);
    expect(pageUrl(page("100% Free"))).toContain("/opt/100%25%20Free/ember/");
    expect(pageUrl(page("Tools C# 100% (x86) & Zoë's [x]"))).toContain("/opt/Tools%20C%23%20100%25%20(x86)%20&%20Zo%C3%AB's%20%5Bx%5D/ember/");
  });

  it("adds the query a window asks for (the ask window's opaque=1)", () => {
    expect(pageUrl(page("plain"), { opaque: "1" })).toMatch(/\/renderer\/home\/index\.html\?opaque=1$/);
    expect(pageUrl(page("plain"))).toMatch(/\/renderer\/home\/index\.html$/);
  });

  it("gives URLs isTrustedSender trusts, whatever the folder is called", () => {
    for (const folder of ["50%AB", "100% Free", "Tools C# 100% (x86) & Zoë's [x]", "plain"]) expect(isTrustedSender(pageUrl(page(folder))), folder).toBe(true);
  });

  it("is how every window in the main process loads its page: nothing calls loadFile", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && /\.loadFile\(/.test(fs.readFileSync(p, "utf8"))) users.push(path.relative(process.cwd(), p));
      }
    };
    walk(path.resolve("app/main"));
    expect(users).toEqual([]);
  });

  it("is checked in CI by starting Ember from a folder named with a % on Linux, Windows and macOS (test/smoke/launch.mjs --folder)", () => {
    const ci = fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
    expect(ci.match(/node test\/smoke\/launch\.mjs --folder "[^"]*100% Free 50%AB[^"]*"/g)).toHaveLength(3);
    expect(fs.readFileSync(path.resolve("test/smoke/launch.mjs"), "utf8")).toMatch(/--remote-debugging-port=0/);
  });
});
