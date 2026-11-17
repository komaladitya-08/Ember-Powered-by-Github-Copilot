/** Real temporary files exercise the packaged fixture's evidence checks only; no Windows process or authority is issued. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Confirmer } from "../../app/main/agent/confirm";
import type { RawNode } from "../integration/uia-client";
import { PublicNpmPlan } from "../../app/main/agent/public-npm-lock";
import { WslPackagedJourney, type WslPackagedModel } from "../fixtures/wsl-coding-packaged-product";
import { wslProductProject } from "../fixtures/wsl-coding-product-model";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: false }); });
interface EvidencePort {
  assertUnchanged(): void;
  assertExport(folder: string, publicDependencies: boolean, cumulative: boolean): void;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-packaged-evidence-")); roots.push(root);
  const journey = new WslPackagedJourney(root, {} as WslPackagedModel, "Ubuntu-22.04", "Ubuntu-22.04 (WSL)");
  const evidence = journey as unknown as EvidencePort;
  const files = (values: Readonly<Record<string, string>>) => Object.entries(values).map(([name, text]) => ({ path: name, base64: Buffer.from(text).toString("base64") }));
  function exported(publicDependencies: boolean) {
    const original = wslProductProject(publicDependencies), changed = wslProductProject(publicDependencies, publicDependencies);
    const proposed = { ...changed, "src/result.ts": changed["src/result.ts"].replace("'wrong'", "'ready'") };
    const plan = PublicNpmPlan.create({ packageJson: Buffer.from(changed["package.json"]), packageLock: Buffer.from(changed["package-lock.json"]) }).summary;
    const scope = { executionProfile: publicDependencies ? "wsl-public-lock" : "wsl-offline", dependencies: null,
      ...(publicDependencies ? { publicDependencies: { access: "verified-offline-cache-input", registry: plan.registry, packages: plan.packageCount,
        packageJsonSha256: plan.packageJsonSha256, lockSha256: plan.lockSha256, setSha256: plan.setSha256, compressedBytes: 1 } } : {}) };
    const data = { purpose: "review-only", baseline: files(original), current: files(original), proposed: files(proposed), scope };
    const folder = fs.mkdtempSync(path.join(journey.exported, "review-"));
    const write = () => fs.writeFileSync(path.join(folder, "review.json"), JSON.stringify(data)); write(); fs.writeFileSync(path.join(folder, "changes.patch"), "+'ready'\n");
    return { data, folder, write };
  }
  return { journey, evidence, exported };
}
it.each([false, true])("checks the exact original, excluded trees and fresh %s public-dependency export receipt", publicDependencies => {
  const f = fixture(), out = f.exported(publicDependencies);
  expect(() => f.evidence.assertUnchanged()).not.toThrow(); expect(() => f.evidence.assertExport(out.folder, publicDependencies, false)).not.toThrow();
});
it("refuses a changed Windows original instead of treating the private proposal as source writeback", () => {
  const f = fixture(); fs.appendFileSync(path.join(f.journey.source, "src/result.ts"), "changed");
  expect(() => f.evidence.assertUnchanged()).toThrow();
});
it("checks only the supplied fresh export even when an older complete export still exists", () => {
  const f = fixture(), old = f.exported(true), fresh = fs.mkdtempSync(path.join(f.journey.exported, "review-"));
  expect(() => f.evidence.assertExport(old.folder, true, false)).not.toThrow(); expect(() => f.evidence.assertExport(fresh, true, true)).toThrow();
});
it.each(["original", "excluded", "receipt", "private"])("refuses %s corruption in a real exported evidence file", kind => {
  const f = fixture(), out = f.exported(true);
  if (kind === "original") out.data.baseline[0].base64 = Buffer.from("changed").toString("base64");
  if (kind === "excluded") out.data.current.push({ path: "node_modules/hidden.js", base64: "" });
  if (kind === "receipt") out.data.scope.publicDependencies!.setSha256 = "0".repeat(64);
  if (kind === "private") out.data.proposed.push({ path: "leak.txt", base64: Buffer.from(f.journey.key).toString("base64") });
  out.write(); expect(() => f.evidence.assertExport(out.folder, true, false)).toThrow();
});
it.each([false, true])("waits for fresh actual Confirmer arming after the full detail is read (initially visible: %s)", async initiallySeen => {
  vi.useFakeTimers();
  const f = fixture(), files = wslProductProject(true), expected = PublicNpmPlan.create({ packageJson: Buffer.from(files["package.json"]), packageLock: Buffer.from(files["package-lock.json"]) }).summary;
  const body = ["Ubuntu-22.04 (WSL)", expected.packageJsonSha256, expected.lockSha256, expected.setSha256, ...expected.packages.map(pkg => pkg.name + "@" + pkg.version)].join("\n");
  const confirmer = new Confirmer(() => {}, { armMs: 1500, now: () => Date.now(), gapMs: 0 });
  const question = confirmer.ask({ title: "May I prepare public dependencies?", context: "Exact copied lock set", prompt: "Download only this set?", detail: body,
    armMs: 1500, options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] });
  let seen = initiallySeen; const accepted: boolean[] = [];
  if (seen) confirmer.wholeSeen(1);
  Reflect.set(f.journey, "home", 123);
  // Only the UIA reader/input port is modeled. The production Confirmer and the actual fixture method remain real.
  Reflect.set(f.journey, "ui", {
    click: async (_hwnd: number, select: (node: RawNode) => boolean) => { if (select({ name: "Allow" } as RawNode)) accepted.push(confirmer.answer("q1:once")); },
    windows: async () => [{ hwnd: 321, name: "Ember needs you" }],
    text: async (_hwnd: number, select: (node: RawNode) => boolean) => select({ automationId: "title" } as RawNode) ? "May I prepare public dependencies?" : body,
    nodes: async () => [{ name: "Allow", isEnabled: seen }],
    node: async (_hwnd: number, select: (node: RawNode) => boolean) => {
      const node = [{ automationId: "body", isEnabled: true }, { name: "Allow", isEnabled: seen }].find(value => select(value as RawNode));
      expect(node).toBeDefined(); return node;
    }, focus: async () => {},
    key: () => { seen = true; confirmer.wholeSeen(1); },
    until: async <T>(read: () => Promise<T>, accepts: (value: T) => boolean) => { const value = await read(); expect(accepts(value)).toBe(true); return value; },
  });
  try {
    const answer = f.journey.publicDecision(false); await vi.advanceTimersByTimeAsync(1600); await answer;
    expect(accepted).toEqual([true]); await expect(question).resolves.toBe("once");
  } finally { confirmer.cancelAll(); await question; vi.useRealTimers(); }
});
