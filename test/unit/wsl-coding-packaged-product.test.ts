/** Real temporary files exercise the packaged fixture's evidence checks only; no Windows process or authority is issued. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Confirmer } from "../../app/main/agent/confirm";
import { consentPanel } from "../../app/main/remote/prompt-window";
import { PROMPT_ARM_MS, judgeRead, moreBelow, promptHint, type ReadGate } from "../../app/renderer/prompt/copy";
import type { RawNode } from "../integration/uia-client";
import { PublicNpmPlan } from "../../app/main/agent/public-npm-lock";
import { WslPackagedJourney, type WslPackagedModel } from "../fixtures/wsl-coding-packaged-product";
import { WslPackagedUi, type WslUiPorts } from "../fixtures/wsl-coding-packaged-uia";
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

it.each(["fits", "scrolls", "fits after focus", "nonfocusable", "wrong title", "replaced during readiness", "replaced before End", "replaced before click",
  "has an exact heading child", "has extra heading text", "has duplicate headings"] as const)("scopes consent input when the card %s", async layout => {
  vi.useFakeTimers();
  try {
    const started = Date.now();
    const { journey } = fixture();
    const target = "wsl:Ubuntu-22.04";
    const panel = consentPanel({ feature: "wsl", os: "win32", target, targetLabel: "WSL", byok: true });
    const replacement = consentPanel({ feature: "commands", os: "win32", target, targetLabel: "Ubuntu-22.04 (WSL)", commands: { wsl: true, byok: true } });
    const overflows = ["scrolls", "fits after focus", "nonfocusable", "replaced before End"].includes(layout);
    const metrics = { clientHeight: 400, scrollHeight: overflows ? 500 : 400, scrollTop: 0 };
    let gate: ReadGate = { seen: false, layout: "default" };
    let shown = panel;
    let open = true;
    let focused = 0;
    const raw = (node: Partial<RawNode>): RawNode => ({ h: 1, pid: 7, patterns: {}, isOffscreen: false, isEnabled: true, bounds: { x: 10, y: 20, width: 30, height: 40 }, ...node });
    const nodes = () => {
      gate = judgeRead(gate, metrics, true, "default");
      const hint = promptHint({ consent: true, seen: gate.seen, more: moreBelow(metrics), field: false, focused: true, sinceShownMs: Date.now() - started });
      const fallback = layout === "has an exact heading child" || layout === "has extra heading text";
      const title = raw({ automationId: "title", name: fallback ? "" : shown.title });
      const heading = [title];
      if (fallback) heading.push(raw({ controlType: "Text", name: shown.title, parent: 0 }));
      if (layout === "has extra heading text") heading.push(raw({ controlType: "Text", name: replacement.title, parent: 0 }));
      if (layout === "has duplicate headings") heading.push({ ...title });
      const button = raw({ h: 2, runtimeId: "button", controlType: "Button", name: shown.yes,
        isEnabled: gate.seen && Date.now() - started >= PROMPT_ARM_MS, hasKeyboardFocus: focused === 2 });
      const body = raw({ h: 3, automationId: "body", controlType: "Group", runtimeId: "body", hasKeyboardFocus: focused === 3,
        isKeyboardFocusable: layout !== "nonfocusable" });
      // An enabled text descendant with the same name must not stand in for an armed button.
      return [...heading, raw({ controlType: "Text", name: shown.yes }), button, ...(moreBelow(metrics) ? [body] : []), ...(hint ? [raw({ controlType: "Text", name: hint })] : [])];
    };
    const bridge = { call: vi.fn(async (method: string, values: { handle?: number }) => {
      if (method === "perform") {
        focused = values.handle!;
        return {};
      }
      expect(method).toBe("focused");
      const element = nodes().find(node => node.h === focused);
      if ((focused === 3 && layout === "replaced before End") || (focused === 2 && layout === "replaced before click")) shown = replacement;
      return { hwnd: 321, element };
    }) };
    const input = {
      blockedReason: () => null, activeWindow: () => 321, activate: () => {}, move: vi.fn(), releaseAll: () => {},
      keysymOf: vi.fn((name: string) => { expect(name).toBe("End"); return 1; }),
      keysym: vi.fn((_symbol: number, down: boolean) => {
        if (down) { expect(moreBelow(metrics)).toBe(true); metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight; }
        return true;
      }),
      button: vi.fn((_button: number, down: boolean) => { if (down) open = false; }),
    };
    const ui = new WslPackagedUi({ bridge, input, current: () => {}, deadline: started + 30_000, refuse: () => new Error("Fixed consent refusal.") } as unknown as WslUiPorts);
    vi.spyOn(ui, "windows").mockImplementation(async () => open ? [{ hwnd: 321, pid: 7, processName: "Ember", name: "Ember needs you", isTopmost: true, focused: true, z: 0 }] : []);
    vi.spyOn(ui, "nodes").mockImplementation(async () => nodes());
    vi.spyOn(ui, "text").mockImplementation(async (_hwnd, select) => {
      expect(select(raw({ automationId: "title" }))).toBe(true);
      if (layout === "replaced during readiness") shown = replacement;
      return layout === "wrong title" ? replacement.title : panel.title;
    });
    if (layout === "fits after focus") {
      const focus = ui.focus.bind(ui);
      vi.spyOn(ui, "focus").mockImplementation(async (...args) => {
        const node = await focus(...args);
        if (node.h === 3) metrics.scrollHeight = metrics.clientHeight;
        return node;
      });
    }
    Reflect.set(journey, "ui", ui);
    const prompt = (journey as unknown as { prompt(title: string): Promise<void> }).prompt(panel.title);
    const accepts = layout === "fits" || layout === "scrolls" || layout === "fits after focus" || layout === "has an exact heading child";
    const completion = accepts ? expect(prompt).resolves.toBeUndefined() : expect(prompt).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(layout === "nonfocusable" ? 30_000 : PROMPT_ARM_MS + 150);
    await completion;
    expect(input.keysym.mock.calls).toEqual(layout === "scrolls" ? [[1, true], [1, false]] : []);
    expect(input.button.mock.calls).toEqual(accepts ? [[1, true], [1, false]] : []);
    expect(input.move).toHaveBeenCalledTimes(accepts ? 1 : 0);
    if (layout.startsWith("replaced")) expect(shown).toBe(replacement);
  } finally { vi.useRealTimers(); }
});

it.each(["selected", "wrong first", "wrong throughout", "outside combo", "duplicate", "unknown", "none", "disabled", "omitted", "focus drift"] as const)("establishes exact selected WSL option evidence: %s", async scenario => {
  const { journey } = fixture();
  const combo: RawNode = { h: 1, automationId: "project-coding-execution-select", controlType: "ComboBox", pid: 7, runtimeId: "combo",
    isEnabled: true, isOffscreen: false, hasKeyboardFocus: true, patterns: {} };
  const label = "Ubuntu-22.04 (WSL2)";
  let down = 0;
  const option = (name: string, selected: boolean | undefined, parent = 1, isEnabled = true): RawNode => ({
    h: 3, parent, name, pid: 7, runtimeId: name, controlType: "ListItem", isEnabled, isOffscreen: true, patterns: { selectionItem: { selected } },
  });
  const nodes = vi.fn(async () => {
    const desired = scenario === "selected" || scenario === "duplicate" || scenario === "disabled" || scenario === "omitted" || (scenario === "wrong first" && down > 0);
    const group = { h: 2, parent: 0, patterns: {}, omitted: scenario === "omitted" };
    const local = option("This computer", scenario === "duplicate" || (!desired && scenario !== "none"));
    const wsl = option(label, scenario === "unknown" ? undefined : desired, 1, scenario !== "disabled");
    return [{ ...combo, hasKeyboardFocus: scenario !== "focus drift" }, group, local, wsl, ...(scenario === "outside combo" ? [option(label, true, -1)] : [])];
  });
  const input = { activeWindow: () => 123, blockedReason: () => null, releaseAll: () => {},
    keysymOf: vi.fn((name: string) => { expect(name).toBe("Down"); return 1; }),
    keysym: vi.fn((_symbol: number, pressed: boolean) => { if (pressed) down++; return true; }) };
  const ui = new WslPackagedUi({ input, current: () => {}, deadline: Date.now() + 30_000, refuse: () => new Error("Fixed UI refusal.") } as unknown as WslUiPorts);
  vi.spyOn(ui, "nodes").mockImplementation(nodes);
  Reflect.set(journey, "home", 123); Reflect.set(journey, "ui", ui);
  const chosen = (journey as unknown as { chooseWslOption(node: RawNode): Promise<RawNode> }).chooseWslOption(combo);
  if (scenario === "selected" || scenario === "wrong first") await expect(chosen).resolves.toMatchObject({ name: label });
  else await expect(chosen).rejects.toThrow();
  const expectedDown = scenario === "wrong first" ? 1 : scenario === "wrong throughout" || scenario === "outside combo" ? 12 : 0;
  expect(input.keysymOf).toHaveBeenCalledTimes(expectedDown);
  expect(input.keysym).toHaveBeenCalledTimes(2 * expectedDown);
  expect(nodes).toHaveBeenCalledTimes(expectedDown === 12 ? 12 : expectedDown + 1);
  // Failure-only numeric evidence: the refusing guard times 16 plus the Down count; exhaustion and success record none.
  const guard = { duplicate: 8, unknown: 6, none: 7, disabled: 10, omitted: 5, "focus drift": 12 }[scenario as string] ?? 0;
  expect(Reflect.get(journey, "selection")).toBe(guard * 16);
});

it.each(["stable", "selection changes", "selected option replaced", "combo replaced", "commit loses focus"] as const)("checks selection during the final commit focus snapshot: %s", async scenario => {
  const { journey } = fixture();
  const raw = (node: Partial<RawNode>): RawNode => ({ h: 1, pid: 7, isEnabled: true, isOffscreen: false,
    bounds: { x: 10, y: 20, width: 30, height: 40 }, patterns: {}, ...node });
  const combo = raw({ controlType: "ComboBox", automationId: "project-coding-execution-select", runtimeId: "combo", hasKeyboardFocus: true });
  const desired = raw({ h: 2, parent: 0, controlType: "ListItem", runtimeId: "wsl", name: "Ubuntu-22.04 (WSL2)", patterns: { selectionItem: { selected: true } } });
  const button = raw({ h: 4, controlType: "Button", automationId: "project-coding-execution-choose", runtimeId: "confirm" });
  let focused = false, change = false;
  const nodes = () => {
    const changed = change && scenario === "selection changes";
    return [{ ...combo, hasKeyboardFocus: !focused, runtimeId: change && scenario === "combo replaced" ? "new combo" : combo.runtimeId },
      { ...desired, runtimeId: change && scenario === "selected option replaced" ? "new wsl" : desired.runtimeId, patterns: { selectionItem: { selected: !changed } } },
      raw({ h: 3, parent: 0, controlType: "ListItem", runtimeId: "local", name: "This computer", patterns: { selectionItem: { selected: changed } } }),
      { ...button, hasKeyboardFocus: focused && !(change && scenario === "commit loses focus") }];
  };
  const bridge = { call: vi.fn(async (method: string, values: { handle?: number }) => {
    if (method === "perform") { expect(values.handle).toBe(button.h); focused = true; return {}; }
    expect(method).toBe("focused");
    change = true;
    return { hwnd: 123, element: { ...button, hasKeyboardFocus: true } };
  }) };
  const input = { activeWindow: () => 123, blockedReason: () => null, activate: () => {}, releaseAll: () => {},
    keysymOf: vi.fn((name: string) => { expect(name).toBe("Return"); return 1; }), keysym: vi.fn(() => true) };
  const ui = new WslPackagedUi({ bridge, input, current: () => {}, deadline: Date.now() + 30_000, refuse: () => new Error("Fixed UI refusal.") } as unknown as WslUiPorts);
  const snapshot = vi.spyOn(ui, "nodes").mockImplementation(async () => nodes());
  Reflect.set(journey, "home", 123); Reflect.set(journey, "ui", ui);
  const steps = journey as unknown as { chooseWslOption(control: RawNode): Promise<RawNode>; commitWslOption(control: RawNode, expected: RawNode): Promise<void> };
  const expected = await steps.chooseWslOption(combo);
  const committed = steps.commitWslOption(combo, expected);
  if (scenario === "stable") await expect(committed).resolves.toBeUndefined();
  else await expect(committed).rejects.toThrow();
  expect(focused).toBe(true); expect(change).toBe(true);
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(input.keysymOf).toHaveBeenCalledTimes(scenario === "stable" ? 1 : 0);
  expect(input.keysym).toHaveBeenCalledTimes(scenario === "stable" ? 2 : 0);
});
