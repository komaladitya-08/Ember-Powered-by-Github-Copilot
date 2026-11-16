import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { emberPathReach } from "../../app/main/policy/ember-paths";
import { afterEach, expect, it, vi } from "vitest";
import { selectCodingStorageBase } from "../../app/main/agent/coding-storage";
import { classifyCommand } from "../../app/main/commands/classify";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("selects frozen logical and canonical roots before allocation, without creating either", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-storage-selection-")); dirs.push(dir);
  const real = path.join(dir, "real temp"), alias = path.join(dir, "logical temp");
  fs.mkdirSync(real); fs.symlinkSync(real, alias, "junction");
  vi.spyOn(os, "tmpdir").mockReturnValue(alias);
  const storage = selectCodingStorageBase(), name = `ember-coding-${process.getuid?.() ?? "unsupported"}`;
  expect(storage.common).toBe(path.join(fs.realpathSync.native(real), name));
  expect(storage.protectedPaths).toEqual([path.join(alias, name), storage.common]);
  expect(Object.isFrozen(storage)).toBe(true); expect(Object.isFrozen(storage.protectedPaths)).toBe(true);
  expect(fs.readdirSync(real)).toEqual([]);
  for (const root of storage.protectedPaths) {
    const uri = pathToFileURL(path.join(root, "process-1-ABCdef", "copies", "private", "src", "app.ts")).href;
    expect(uri).toContain("%20");
    expect(emberPathReach(uri, { os: process.platform === "win32" ? "win32" : "linux", ember: storage.protectedPaths })).toBe("names");
  }
});

it("retains the logical protection but disables allocation when canonical temp resolution fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-storage-selection-")); dirs.push(dir);
  const missing = path.join(dir, "missing"); vi.spyOn(os, "tmpdir").mockReturnValue(missing);
  const storage = selectCodingStorageBase();
  expect(storage.common).toBeNull(); expect(storage.protectedPaths).toHaveLength(1);
  expect(storage.protectedPaths[0].startsWith(missing + path.sep)).toBe(true); expect(fs.existsSync(missing)).toBe(false);
});

it("does not fall back to the JavaScript resolver when native canonicalisation of an existing temp directory fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-storage-selection-")); dirs.push(dir);
  vi.spyOn(os, "tmpdir").mockReturnValue(dir);
  vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw new Error("synthetic native resolution refusal"); });
  const storage = selectCodingStorageBase();
  expect(storage.common).toBeNull(); expect(storage.protectedPaths).toHaveLength(1);
  expect(storage.protectedPaths[0].startsWith(dir + path.sep)).toBe(true);
  expect(fs.readdirSync(dir)).toEqual([]);
});

const roots = Object.freeze(["/tmp/ember-coding-123", "/private/tmp/ember-coding-123"]);
const ctx = (paths: readonly string[]) => ({ os: "linux" as const, home: "/home/u", cwd: "/home/u/project", ember: { paths: [...paths], pids: [], names: /(?!)/ }, downloaded: new Set<string>() });
const request = (more: Partial<ActionRequest>): ActionRequest => ({ taskId: "t", kind: "text", app: "Mousepad", window: "notes.txt", element: { role: "text", name: "Location" }, ...more });
const policy = (autopilot: boolean, paths: readonly string[] = roots) => new PolicyEngine({ neverLook: () => [], grants: () => ({ mousepad: "act", files: "act" }), os: "linux", emberPaths: paths, autopilot: () => autopilot, now: () => 0, rateLimit: 1000 });

it("reproduces the old temp-path classification and applies the existing hard command refusal with the selected roots", () => {
  const copy = "/tmp/ember-coding-123/process-1-ABCdef/copies/private/src/app.ts";
  expect(classifyCommand(`cat ${copy}`, "bash", ctx([])).refuse).toBeNull();
  expect(policy(false, []).decide(request({ value: copy })).verdict).toBe("allow");
  for (const root of roots) {
    for (const command of [
      `cat ${root}/process-1-ABCdef/copies/private/src/app.ts`,
      `printf '{}' > ${root}/process-1-ABCdef/cleanup-complete.json`,
      `cat ${root}/process-1-ABCdef/reviews/result/review.json`,
      `rm -rf ${root}`, `cat ${root}/process-*/copies/*`,
    ]) expect(classifyCommand(command, "bash", ctx(roots)).refuse, command).toMatchObject({ rule: "ember.path" });
  }
  expect(classifyCommand("rm -rf /tmp", "bash", ctx(roots)).refuse).toMatchObject({ rule: "ember.path" });
  expect(classifyCommand("cat /tmp/ordinary.txt", "bash", ctx(roots)).refuse).toBeNull();
  expect(classifyCommand("cat /tmp/ember-coding-123-other/app.ts", "bash", ctx(roots)).refuse).toBeNull();
});

it.each([false, true])("refuses GUI paths, split fields, chooser commits and globs without a card (autopilot=%s)", autopilot => {
  for (const root of roots) {
    const file = `${root}/process-1-ABCdef/copies/private/src/app.ts`;
    const requests = [
      request({ value: file }), request({ value: `file://${file}` }),
      request({ value: `file://localhost${file.replaceAll("ember-coding-123", "ember%2Dcoding%2D123")}` }),
      request({ mode: "append", currentText: root + "/process-1-ABCdef/", value: "cleanup-complete.json" }),
      request({ kind: "keys", value: "Return", typed: file }),
      request({ value: root + "/process-*/copies/*" }),
      request({ kind: "click", app: "Files", window: "Open File", element: { role: "push button", name: "Open" }, dialog: { name: "Open File", text: "", fields: [file], items: [], selected: [], controls: [], fileChooser: true } }),
      request({ kind: "click", window: file, element: { role: "push button", name: "Save" } }),
    ];
    for (const r of requests) expect(policy(autopilot).decide(r), JSON.stringify(r)).toMatchObject({ tier: "never", verdict: "deny" });
  }
  expect(policy(autopilot).decide(request({ value: "/tmp/ordinary.txt" })).verdict).toBe("allow");
  expect(policy(autopilot).decide(request({ value: "https://example.com/tmp/ember-coding-123/app.ts" })).verdict).toBe("allow");
  const ancestor = policy(autopilot).decide(request({ value: "/tmp" }));
  expect(ancestor.verdict).toBe(autopilot ? "deny" : "confirm");
});

it("decodes only local file URI paths, preserving Windows drive paths and literal percent filenames", () => {
  const place = { os: "linux" as const, ember: roots };
  expect(emberPathReach("file:///tmp/ember%2Dcoding%2D123/process-1-ABCdef/copies/app.ts", place)).toBe("names");
  expect(emberPathReach("file://localhost/private/tmp/ember%2dcoding%2d123/process-1-ABCdef/reviews/review.json", place)).toBe("names");
  expect(emberPathReach("/tmp/ember%2Dcoding%2D123/process-1-ABCdef/copies/app.ts", place)).toBeNull();
  expect(emberPathReach("https://example.com/tmp/ember%2Dcoding%2D123/app.ts", place)).toBeNull();
  expect(emberPathReach("file://remote.invalid/tmp/ember-coding-123/app.ts", place)).toBeNull();
  expect(emberPathReach(" \tfile:///tmp/ember-coding-123/app.ts\t", place)).toBe("names");
  for (const uri of ["file:///tmp/ember-coding-123/%", "file:///tmp/ember-coding-123/%00", "file:///tmp/ember-coding-123%2Fapp.ts", "file:///tmp/ember-coding-123%5Capp.ts", "file:///tmp/ember-coding-123/app.ts\0", "file:///tmp/ember-coding-123/app.ts?" + "x".repeat(4096)])
    expect(emberPathReach(uri, place), uri).toBe("names");
  expect(emberPathReach("file:///C:/Temp/ember%2Dcoding%2Dunsupported/process-1-ABCdef/copies/app.ts", { os: "win32", ember: ["C:\\Temp\\ember-coding-unsupported"] })).toBe("names");
  expect(emberPathReach("file:///C:/Temp/ordinary.txt", { os: "win32", ember: ["C:\\Temp\\ember-coding-unsupported"] })).toBeNull();
  const percentRoot = { os: "linux" as const, ember: ["/tmp/literal%65/ember-coding-123"] };
  expect(emberPathReach("file:///tmp/literal%2565/ember-coding-123/copies/app.ts", percentRoot)).toBe("names");
  expect(emberPathReach("/tmp/literal%65/ember-coding-123/copies/app.ts", percentRoot)).toBe("names");
  expect(emberPathReach("file:///tmp/literal%65/ember-coding-123/copies/app.ts", percentRoot)).toBe("names");
  expect(emberPathReach("file:///tmp/other%2565/app.ts", percentRoot)).toBeNull();
});
