/**
 * One composition root (D1): outside app/main/platform/, the main process never tests the OS itself or reads a native
 * window handle; it asks the Platform object (platform.os, the window system's windowId, the system's members). A
 * new `process.platform` or `.getNativeWindowHandle(` elsewhere in app/main fails here; an exception must be listed
 * below with its reason. Comments may name them (they explain the rule).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MAIN = path.resolve("app/main");
const PLATFORM = path.join(MAIN, "platform");

/** Files allowed to use a forbidden name, and why. Empty: none needs to. */
const ALLOWED: Record<string, { pattern: string; reason: string }[]> = {};

/** Every .ts file under app/main outside app/main/platform/. */
function mainFiles(dir = MAIN): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p === PLATFORM ? [] : mainFiles(p);
    return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
  });
}

/** The source without its comments (a doc comment may name what the code must not use). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const rel = (p: string) => path.relative(path.resolve("."), p).split(path.sep).join("/");

describe("the platform boundary", () => {
  const files = mainFiles();

  it("covers the main process's modules (and leaves app/main/platform out)", () => {
    expect(files.map(rel)).toContain("app/main/main.ts");
    expect(files.map(rel)).toContain("app/main/overlay.ts");
    expect(files.some(f => f.startsWith(PLATFORM))).toBe(false);
  });

  for (const [name, pattern] of [["process.platform", /\bprocess\.platform\b/], [".getNativeWindowHandle(", /\.getNativeWindowHandle\(/]] as const) {
    it(`has no ${name} outside app/main/platform/ (D1)`, () => {
      const offenders = files.filter(f => pattern.test(code(fs.readFileSync(f, "utf8"))))
        .map(rel).filter(f => !(ALLOWED[f] ?? []).some(a => a.pattern === name));
      expect(offenders).toEqual([]);
    });
  }

  it("leaves $DISPLAY to the Linux platform: main.ts never reads it", () => {
    expect(code(fs.readFileSync(path.join(MAIN, "main.ts"), "utf8"))).not.toMatch(/process\.env\.DISPLAY\b|env\[["']DISPLAY["']\]/);
  });

  it("strips comments without touching code (a URL's // stays code)", () => {
    expect(code("const a = process.platform; // process.platform")).toBe("const a = process.platform; ");
    expect(code("/** process.platform */ const b = 1;")).toBe(" const b = 1;");
    expect(code('const u = "https://x/y"; win.getNativeWindowHandle()')).toContain("getNativeWindowHandle(");
  });
});
