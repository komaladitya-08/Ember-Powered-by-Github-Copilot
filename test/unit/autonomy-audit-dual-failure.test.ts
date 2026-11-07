/* eslint-disable @typescript-eslint/no-explicit-any -- fs spies and a namespace looked up by name need loose types */
/**
 * "Work without asking" found on, or turned on, when the audit write fails AND turning it off on disk fails too (disk
 * full, folder unwritable after a good load): it must not be in force (review of PR #193). Both catches in main.ts are
 * run from their source text, as the neighbouring main.ts tests do.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore, DEFAULT_SETTINGS } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";
import * as autonomy from "../../app/main/policy/autonomy";
import { autonomyInForce, ALL_SCOPES } from "../../app/main/policy/autonomy";
// Looked up by name so the file still loads (and fails on its assertions) against a version without the hold.
const holdAutonomyOff = (): void => (autonomy as any).holdAutonomyOff?.();
const releaseAutonomyHold = (): void => (autonomy as any).releaseAutonomyHold?.();
const autonomyHeld = (): boolean => (autonomy as any).autonomyHeld?.() ?? false;
import { PolicyEngine } from "../../app/main/policy/policy";

const source = fs.readFileSync("app/main/main.ts", "utf8");
const slice = (from: string, to: string): string => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
  return transformSync(source.slice(a, b), { loader: "ts", target: "es2022" }).code;
};
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); releaseAutonomyHold(); for (const d of dirs.splice(0)) { try { fs.chmodSync(d, 0o700); fs.chmodSync(path.join(d, "audit"), 0o700); } catch { /* gone */ } } });

const ON = { on: true, scopes: ALL_SCOPES, consent: { version: 99, at: "test" } };
function setup(on: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-dual-")); dirs.push(dir);
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true, autonomy: on ? ON : { ...ON, on: false } }));
  const settings = new SettingsStore(file); settings.load();
  const audit = new AuditLog(path.join(dir, "audit"));
  return { dir, file, settings, audit };
}
/** Makes the audit file and settings.json unwritable. */
function breakStorage(fault: "ENOSPC" | "permissions", ctx: { dir: string; file: string; audit: AuditLog }) {
  if (fault === "permissions") { fs.chmodSync(ctx.dir, 0o500); fs.chmodSync(path.join(ctx.dir, "audit"), 0o500); return; }
  const append = fs.appendFileSync, open = fs.openSync;
  const full = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });
  vi.spyOn(fs, "appendFileSync").mockImplementation(((f: any, ...a: any[]) => { if (String(f) === ctx.audit.file) throw full(); return (append as any)(f, ...a); }) as any);
  vi.spyOn(fs, "openSync").mockImplementation(((f: any, ...a: any[]) => { if (String(f).startsWith(`${ctx.file}.tmp-`)) throw full(); return (open as any)(f, ...a); }) as any);
}
const engineFor = (settings: SettingsStore) => new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => autonomyInForce(settings.get().autonomy) });
const click = { taskId: "t", kind: "click" as const, app: "mousepad", window: "notes", element: { role: "push button", name: "Bold" } };

describe.each(["ENOSPC", "permissions"] as const)("autonomy when the audit and the save both fail (%s)", fault => {
  it("found on at start: nothing is done without asking (PR #193 review, startup catch)", () => {
    const c = setup(true);
    const block = slice("    if (autonomyWasOn) {", "    // Nothing is pruned while the policy");
    breakStorage(fault, c);
    const ctx = vm.createContext({ autonomyWasOn: true, audit: c.audit, settings: c.settings, log: { warn: () => {} }, holdAutonomyOff });
    let thrown: unknown = null;
    try { vm.runInContext(block, ctx); } catch (e) { thrown = e; }
    const continued = thrown === null;
    // Either startup aborted (as before the PR), or autonomy is not in force for any consumer.
    expect(continued ? autonomyInForce(c.settings.get().autonomy) : null).toBeNull();
    if (continued) {
      expect(autonomyHeld()).toBe(true);
      expect(engineFor(c.settings).decide(click).autonomy).not.toBe(true);
    }
  });

  it("turned on: it isn't in force when it can't be recorded or switched off (PR #193 review, onChange catch)", () => {
    const c = setup(false);
    const block = slice("  settings.onChange(s => {\n    " + (source.includes("// Seen off") ? "// Seen off" : "const on"), "  /** When the request being heard began");
    const ctx = vm.createContext({
      settings: c.settings, audit: c.audit, policy: null, autonomyInForce, autonomyChangedBy: null, autonomyWasOn: false,
      autonomyBeforeAudit: [], log: { warn: () => {}, info: () => {} }, holdAutonomyOff, releaseAutonomyHold,
    });
    vm.runInContext(block, ctx);
    breakStorage(fault, c);
    // The turn on itself can't be saved either under these faults; the in-memory ON arrives as a hand edit would.
    if (fault === "permissions") { fs.chmodSync(c.dir, 0o700); fs.chmodSync(path.join(c.dir, "audit"), 0o500); fs.writeFileSync(c.file, JSON.stringify({ ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true, autonomy: ON })); fs.chmodSync(c.dir, 0o500); }
    else fs.writeFileSync(c.file, JSON.stringify({ ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true, autonomy: ON }));
    try { c.settings.reloadIfChanged(); } catch { /* the listener's failure is the caller's */ }
    expect(c.settings.get().autonomy.on).toBe(true); // memory says on (the file was edited) ...
    expect(autonomyInForce(c.settings.get().autonomy)).toBeNull(); // ... and it is not in force
    expect(engineFor(c.settings).decide(click).autonomy).not.toBe(true);
  });
});

describe("the hold", () => {
  it("is released when the setting is seen off, so a later turn on is audited afresh", () => {
    holdAutonomyOff();
    expect(autonomyInForce(ON)).toBeNull();
    releaseAutonomyHold();
    expect(autonomyInForce(ON)).not.toBeNull();
  });
});
