/** Process-free observations of existing fixed native qualification operations. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";

const native = fs.readFileSync("test/integration/wsl-coding-native.test.ts", "utf8");
interface Observation {
  update(stage: unknown): void;
  capture(connection: unknown, closed: unknown): void;
  failure(connection: unknown, closed: unknown, write: (facts: object) => void): void;
  value(): Readonly<{ stage: number; connection: number; closed: number }> | undefined;
}
function observer(globals: Record<string, unknown> = {}): Observation {
  const begin = native.indexOf("function wslNativeObservation()"), end = native.indexOf("const required =", begin);
  expect(begin >= 0 && end > begin).toBe(true);
  const code = transformSync(native.slice(begin, end) + "\nmodule.exports = wslNativeObservation;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as () => Observation };
  runInNewContext(code, { module, ...globals }); return module.exports();
}
it.each([0, 1, 30])("retains only a closed numeric existing-operation stage %i", stage => {
  const o = observer(); o.update(stage); o.capture(true, false);
  expect(o.value()).toEqual({ stage, connection: 1, closed: 0 }); expect(Object.isFrozen(o.value())).toBe(true);
});
it.each([-1, 31, 0.5, NaN, Infinity, "PRIVATE", null, undefined])("refuses malformed stage %# without coercion or raw projection", value => {
  const o = observer(); o.update(7); o.update(value); o.capture(false, false);
  expect(o.value()).toEqual({ stage: 7, connection: 0, closed: 0 }); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("never reads object fields or proxy traps while classifying stage or cached booleans", () => {
  let traps = 0; const secret = () => { traps++; throw new Error("PRIVATE"); };
  const hostile = new Proxy({}, { get: secret, getOwnPropertyDescriptor: secret, getPrototypeOf: secret });
  const o = observer(); o.update(hostile); o.capture(hostile, hostile);
  expect(traps).toBe(0); expect(o.value()).toEqual({ stage: 0, connection: 0, closed: 0 });
});
it("freezes the first failure before cleanup and preserves it when cleanup later closes the connection", () => {
  const o = observer(), write = vi.fn(); o.update(10); o.capture(false, false);
  o.update(30); o.failure(true, true, write);
  expect(write).toHaveBeenCalledExactlyOnceWith({ stage: 10, connection: 0, closed: 0 });
});
it("never acquires a later cleanup snapshot after first-snapshot storage fails", () => {
  let freezes = 0;
  const object = new Proxy(Object, { get(target, key, receiver) {
    if (key === "freeze") return () => { freezes++; throw new Error("PRIVATE"); }; return Reflect.get(target, key, receiver);
  } });
  const o = observer({ Object: object }), write = vi.fn(); o.update(10); o.capture(false, false); o.update(30);
  expect(() => o.failure(true, true, write)).not.toThrow(); expect(freezes).toBe(1); expect(write).not.toHaveBeenCalled();
});
it("preserves the original error object even when the failure observer faults", async () => {
  const begin = native.indexOf("  } catch (error) {\n    try { observation.capture"), end = native.indexOf("  } finally {", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const code = transformSync("module.exports = async (original, observation) => { let connection, closed = false; try { throw original; " + native.slice(begin, end) + " } };", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (error: Error, o: unknown) => Promise<never> };
  runInNewContext(code, { module }); const original = new Error("PRIVATE");
  await expect(module.exports(original, { capture() { throw new Error("PRIVATE observer"); } })).rejects.toBe(original);
});
it.each([false, true])("emits closed facts only when the registered failure hook runs, with output faults=%s", faults => {
  const line = native.split("\n").find(value => value.includes("  onTestFailed(() =>")); expect(line).toBeDefined();
  const o = observer(); o.update(10); const write = vi.fn(() => { if (faults) throw new Error("PRIVATE output"); });
  let hook: (() => void) | undefined;
  runInNewContext(line!, { onTestFailed: (fn: () => void) => { hook = fn; }, observation: o, connection: undefined, closed: false, console: { info: write } });
  expect(write).not.toHaveBeenCalled(); expect(() => hook!()).not.toThrow();
  expect(write).toHaveBeenCalledExactlyOnceWith("WSL coding native cached observation", '{"stage":10,"connection":0,"closed":0}');
});

const digest = (source: string) => createHash("sha256").update(source).digest("hex");
it("preserves the entire native WSL test after reversing only the new observation layer", () => {
  let source = native.replace('import { expect, it, onTestFailed } from "vitest";', 'import { expect, it } from "vitest";');
  const begin = source.indexOf("/** Fixed numeric observations"), end = source.indexOf("const required =", begin);
  source = source.slice(0, begin) + source.slice(end);
  source = source.replace('  const observation = wslNativeObservation();\n', "").replace(/^ {2}onTestFailed\(\(\) =>.*\n/m, "");
  source = source.replace('  } catch (error) {\n    try { observation.capture(connection !== undefined, closed); } catch { /* Preserve the exact thrown error. */ }\n    throw error;\n', "");
  source = source.replace('if (closed) { observation.update(30); fs.rmSync(root, { recursive: true, force: true }); }', 'if (closed) fs.rmSync(root, { recursive: true, force: true });');
  source = source.replace(/observation\.update\((?:[1-9]|[12][0-9]|30)\); /g, "");
  expect(digest(source)).toBe("3fe1a40c3aab7640d3f2703273cae7138965d29833fbfaa7a381f3161fd0c07e");
});
it("preserves the entire packaged test after reversing only the new project/folder stage field and markers", () => {
  let source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
  // Reverse the separately covered native card selector correction before checking the historic observer change.
  source = source.replace("type SnapshotGuard = (nodes: readonly RawNode[]) => boolean;\n", "");
  source = source.replace("  private async node(hwnd: number, select: Selector, enabled = true, guard?: SnapshotGuard): Promise<RawNode> {\n    const found = await this.until(async () => {\n      const nodes = await this.nodes(hwnd);\n      return !guard || guard(nodes) ? nodes.find(node => select(node) && (!enabled || node.isEnabled === true)) : undefined;\n    }, value => !!value);\n    return found!;\n  }\n", "  private async node(hwnd: number, select: Selector, enabled = true): Promise<RawNode> {\n    const found = await this.until(async () => (await this.nodes(hwnd)).find(node => select(node) && (!enabled || node.isEnabled === true)), value => !!value);\n    return found!;\n  }\n");
  source = source.replace("hwnd: number, node: RawNode, guard?: SnapshotGuard): Promise<RawNode> {", "hwnd: number, node: RawNode): Promise<RawNode> {");
  source = source.replace("    const nodes = await this.nodes(hwnd);\n    const fresh = !guard || guard(nodes) ? nodes.find(value => sameNode(value, node)) : undefined;", "    const fresh = (await this.nodes(hwnd)).find(value => sameNode(value, node));");
  source = source.replace("  private async click(hwnd: number, select: Selector, guard?: SnapshotGuard): Promise<void> {\n    const node = await this.focus(hwnd, await this.node(hwnd, select, true, guard), guard), box = node.bounds!;\n", "  private async click(hwnd: number, select: Selector): Promise<void> {\n    const node = await this.focus(hwnd, await this.node(hwnd, select)), box = node.bounds!;\n");
  const selectorStart = source.indexOf("    const commandBlock = id(\"ask-cmd\");"), selectorEnd = source.indexOf("\n  }\n  private async review(", selectorStart);
  expect(selectorStart > 0 && selectorEnd > selectorStart).toBe(true);
  expect(digest(source.slice(selectorStart, selectorEnd))).toBe("e87a5717449926b730fb4f9296352422bacb04ca0a75abd333240465301d21ea");
  source = source.slice(0, selectorStart) + [
    "    const display = (await this.until(() => this.nodes(hwnd), nodes => { try { this.observation.card(nodes, this.previousCard); } catch { /* Cached poll only. */ } return nodes.some(node => node.automationId === \"ask-cmd\" && !!node.runtimeId && node.runtimeId !== this.previousCard); }, 45_000)).find(id(\"ask-cmd\"))!;",
    "    this.observe({ commandStage: 8 }); await this.focus(hwnd, display);",
    "    this.observe({ commandStage: 9 }); expect(await this.text(hwnd, id(\"ask-cmd\"))).toBe(\"Node arguments: \" + JSON.stringify(argv));",
    "    this.observe({ commandStage: 10 }); expect((await this.nodes(hwnd)).map(node => node.name ?? \"\").join(\"\\n\")).toContain(\"\\\\work\");",
    "    this.observe({ commandStage: 11 }); this.previousCard = display.runtimeId!;",
    "    this.observe({ commandStage: 12 }); this.previousTabs = new Set((await this.nodes(hwnd)).filter(node => node.controlType === \"TabItem\" && node.runtimeId).map(node => node.runtimeId!));",
    "    this.observe({ commandStage: 13 }); await this.click(hwnd, named(answer)); this.observe({ commandStage: 14 });",
  ].join("\n") + source.slice(selectorEnd);
  const commandAdditions = [
    'import { readCommandCardObservationLog, type PackagedCommandCardObservation } from "../fixtures/command-card-observation-log";\n',
    '  private commandObservation?: Readonly<PackagedCommandCardObservation>;\n',
    '  private cleanupStarted = false;\n',
    '  beginCleanup(): void { this.cleanupStarted = true; }\n',
    '    fixture?.beginCleanup();\n',
    ' if (!this.cleanupStarted) try { this.commandObservation = readCommandCardObservationLog(this.profile); } catch { /* Unknown; never read again during cleanup. */ }',
    '  commandFailureObservation(): Readonly<PackagedCommandCardObservation> | undefined { return this.commandObservation; }\n',
    '    try { const observation = fixture?.commandFailureObservation(); if (observation) console.info("Windows Node packaged command observation", JSON.stringify(observation)); }\n    catch { /* The separate numeric record cannot change the primary failure. */ }\n',
  ];
  for (const addition of commandAdditions) { expect(source.split(addition)).toHaveLength(2); source = source.replace(addition, ""); }
  const fillStart = source.indexOf("  private async fill("), fillEnd = source.indexOf("\n  private async homeText", fillStart);
  expect(fillStart >= 0 && fillEnd > fillStart).toBe(true);
  expect(digest(source.slice(fillStart, fillEnd))).toBe("abd3b6dc6c3466b966b0b9b0086b7d361ebddf59b496b0a49b3ec3462cec3754");
  const previousFill = `  private async fill(hwnd: number, select: Selector, value: string, password = false): Promise<void> {
    const node = await this.focus(hwnd, await this.node(hwnd, select));
    if (!!node.isPassword !== password) throw refusal(this.phase);
    try { this.chord("Control_L", "a"); this.type(value); this.pressKey("Tab"); } finally { this.input!.releaseAll(); }
  }`;
  expect(digest(previousFill)).toBe("f479af685bf882f8c0d6ad684814c3f9346ab35cd0f9d67c68a29fff0639a193");
  source = source.slice(0, fillStart) + previousFill + source.slice(fillEnd);
  source = source.replace(' * Target codes1..7 keep the existing welcome controls;8project-sessions-request/9project-sessions-send.\n', "");
  source = source.replace('welcomeStep: 6, nextLabel: 7, target: 9, bridgeError:', 'welcomeStep: 6, nextLabel: 7, target: 7, bridgeError:');
  source = source.replace('"w-row-commands", "project-sessions-request", "project-sessions-send"].indexOf(selected as string) + 1', '"w-row-commands"].indexOf(selected as string) + 1');
  source = source.replace(' allowFlags: number; denyFlags: number; hintFlags: number;', "");
  source = source.replace(' * Existing stage13 snapshot only: Allow/Not now presence1/enabled2/disabled4/onscreen8/offscreen16; hint bits exact whole-command-read1/answer-retry2.\n', "");
  source = source.replace(', allowFlags: 31, denyFlags: 31, hintFlags: 3', "").replace(', allowFlags: 0, denyFlags: 0, hintFlags: 0', "").replace(', allowFlags: 0, denyFlags: 0, hintFlags: 0', "");
  source = source.replace('    try { this.observation.controls(result.nodes); } catch { /* Cached stage13 controls only. */ }\n', "");
  source = source.replace('  providerStage: number; commandStage: number; commandDecision: number; repairStep: number; repairResults: number; focusIdentity: number; cardFlags: number;\n', "");
  source = source.replace(/ \* Provider stage1pane[^\n]*\n \* Command stage1pane[^\n]*\n \* 11remember-display[^\n]*\n \* Repair step\/results0[^\n]*\n \* Focus identity bits:[^\n]*\n \* Card bits from an existing display poll:[^\n]*\n/, "");
  source = source.replace(', providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15', "");
  source = source.replace(', providerStage: 0, commandStage: 0, commandDecision: 0, repairStep: 0, repairResults: 0, focusIdentity: 0, cardFlags: 0', "").replace('  let decisions = 0;\n', "");
  const counter = source.indexOf("    decision()"), answer = source.indexOf("    answer(value: unknown)", counter);
  expect(counter > 0 && answer > counter).toBe(true); source = source.slice(0, counter) + source.slice(answer);
  const identity = source.indexOf("      const targetRuntime ="), same = source.indexOf("      const same =", identity);
  expect(identity > 0 && same > identity).toBe(true); source = source.slice(0, identity) + source.slice(same);
  source = source.replace(' try { this.observe({ repairStep: this.model.steps.get("repair") ?? 0, repairResults: this.model.results.get("repair")?.length ?? 0 }); } catch { /* Cached local fixture counts only. */ }', "");
  source = source.replace(', focusIdentity: 0 }); try { this.observation.node(node);', ' }); try { this.observation.node(node);');
  source = source.replace(/this\.observe\(\{ providerStage: (?:[1-9]|1[0-2]) \}\); /g, "");
  source = source.replace('    this.observe({ commandStage: 7 });\n', "").replace(' this.observe({ commandStage: 14 });', "");
  source = source.replace(' try { this.observation.decision(); } catch { /* Count only this existing call. */ }', "");
  source = source.replace('this.observe({ commandStage: 6, cardFlags: 0 }); ', "");
  source = source.replace(/this\.observe\(\{ commandStage: (?:[1-9]|1[0-3]) \}\); /g, "");
  source = source.replace('if (node.patterns.toggle === "Off" && node.isEnabled) { await this.click(this.home, ask); }', 'if (node.patterns.toggle === "Off" && node.isEnabled) await this.click(this.home, ask);');
  source = source.replace('nodes => { try { this.observation.card(nodes, this.previousCard); } catch { /* Cached poll only. */ } return nodes.some(node => node.automationId === "ask-cmd" && !!node.runtimeId && node.runtimeId !== this.previousCard); }',
    'nodes => nodes.some(node => node.automationId === "ask-cmd" && !!node.runtimeId && node.runtimeId !== this.previousCard)');
  source = source.replaceAll("revealHomeControl", "revealWelcomeRow");
  source = source.replace("reveal Home controls with ordinary forward or reverse Tab navigation.", "follow consent order with ordinary forward or reverse Tab navigation.");
  source = source.replace('await this.revealWelcomeRow(id("project-coding-choose")); ', "");
  source = source.replace('await this.revealWelcomeRow(id("project-sessions-request"), true, true); ', "");
  source = source.replace('    await this.revealWelcomeRow(id("project-coding"), false); await this.revealWelcomeRow(named("Review result: " + titleOf(goal)));\n', "");
  source = source.replace('    await this.revealWelcomeRow(id("project-coding"), false); await this.revealWelcomeRow(id("project-coding-export"));\n', "");
  source = source.replace('await this.revealWelcomeRow(id("project-coding-continue-request")); ', "");
  source = source.replace("inputResult: number; bridgeStage: number; projectStage: number;", "inputResult: number; bridgeStage: number;");
  source = source.replace(/^ \* Project\/folder stage0.*\n \* 9dialog-block-check.*\n/m, "");
  source = source.replace(", projectStage: 16", "").replace(", projectStage: 0", "");
  source = source.replace(" this.observe({ projectStage: 16 });", "").replace(/this\.observe\(\{ projectStage: (?:[1-9]|1[0-5]) \}\); /g, "");
  expect(digest(source)).toBe("c4d7503b2d57490a95de5e78b2357bd6b8329e15c04b719f193ab7caf2c9c447");
});
it("preserves the whole workflow after reversing only the known diagnostic fields and exact reviewed source-proof promotion", () => {
  let source = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8").replace(", projectStage: 16", "").replace(", projectStage: 0", "");
  const commandStart = source.indexOf("          const commandFailureFacts ="), commandEnd = source.indexOf("          const failureFacts =", commandStart);
  expect(commandStart > 0 && commandEnd > commandStart).toBe(true);
  expect(digest(source.slice(commandStart, commandEnd))).toBe("94e358f8a718555de5b57a702e6d7d61bbbbdf78d92ead7ca4be43a93246b716");
  source = source.slice(0, commandStart) + source.slice(commandEnd);
  const commandPrint = '            try { if (failureJourney === 2) console.info("Windows Node packaged command failure facts", JSON.stringify(commandFailureFacts(failureAttempt))); }\n            catch { /* Never replace the primary failure or print a private log line. */ }\n';
  expect(source.split(commandPrint)).toHaveLength(2); source = source.replace(commandPrint, "");
  source = source.replace('welcomeStep: 6, nextLabel: 7, target: 9, bridgeError:', 'welcomeStep: 6, nextLabel: 7, target: 7, bridgeError:');
  source = source.replace(', allowFlags: 31, denyFlags: 31, hintFlags: 3', "").replace(', allowFlags: 0, denyFlags: 0, hintFlags: 0', "");
  source = source.replace(', providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15', "");
  source = source.replace(', providerStage: 0, commandStage: 0, commandDecision: 0, repairStep: 0, repairResults: 0, focusIdentity: 0, cardFlags: 0', "");
  const reviewed = `          const reviewed = Object.freeze({
            ready: true,
            run: 43991252195,
            commit: "b75c944dec58973d157542e2d4d2db3720667982",
            artifact: 14289217635,
            archiveBytes: 38425334,
            archiveSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
            manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f",
            assetProofCommit: "aa5345a934d75d9a7924a4b7984c3b27c9521020",
            assetProofManifestSha256: "91f162e84a22f199606acee94131bcb605761d2796e57d9148c77311e09e8db6",
            verifierFileSha256: "9674e7b019cf736024b00593e0a73cfa4c8a30ed57f8135baf749b15b21e2a97",
          });`;
  const historical = `          const reviewed = Object.freeze({
            ready: true,
            run: 43991252195,
            commit: "b75c944dec58973d157542e2d4d2db3720667982",
            artifact: 14289217635,
            archiveBytes: 38425334,
            archiveSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
            manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f",
            assetProofCommit: "5b89563840479d27b1ba83251fd74652d219d913",
            assetProofManifestSha256: "3b1f1c4b03aaa44afd617f38a2ea81095ee6e688fa06390daeb6e54529329320",
            verifierFileSha256: "8dff6a53bca9c2dc39a190a9298f743cbbc40c54f7f24ea456af21498e19c302",
          });`;
  expect(source.split(reviewed)).toHaveLength(2);
  source = source.replace(reviewed, historical);
  expect(digest(source)).toBe("54d77bc05dbb2d2d3a9b684709da9b8f8d4fbd196cee0f1809487afdb3f23271");
});

function packagedDecision() {
  const source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
  const slice = (start: string, end: string) => {
    const begin = source.indexOf(start), stop = source.indexOf(end, begin);
    expect(begin >= 0 && stop > begin).toBe(true);
    return source.slice(begin, stop);
  };
  const code = transformSync(slice("type Selector =", "function subtree(") + "\nclass TestJourney {\n"
    + slice("  private async node(", "  private async text(")
    + slice("  async decide(", "  private async review(")
    + "}\nmodule.exports = TestJourney.prototype;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as { decide(this: object, argv: readonly string[]): Promise<void> } };
  runInNewContext(code, { module, expect, refusal: (phase: number) => new Error("Packaged fixture refused phase " + phase) });
  return module.exports;
}

type CardNode = { automationId?: string; controlType?: string; isEnabled?: boolean; name?: string; pid: number; runtimeId: string };
it.each(["old-first", "ambiguous-fresh", "swapped-before-allow", "disabled-allow", "ambiguous-allow"] as const)(
  "keeps the packaged decision bound to the observed fresh native card with %s",
  async condition => {
    const old = { automationId: "ask-cmd", controlType: "Text", pid: 11, runtimeId: "first" };
    const fresh = { ...old, runtimeId: "second" };
    const allow = { controlType: "Button", isEnabled: condition !== "disabled-allow", name: "Allow", pid: 11, runtimeId: "allow" };
    const heading = { name: "On this computer · Node · in \\work", pid: 11, runtimeId: "header" };
    let stage = 0, clicked = 0;
    const focus = vi.fn(), text = vi.fn();
    const driver = Object.assign(Object.create(packagedDecision()) as ReturnType<typeof packagedDecision>, {
      phase: 0, previousCard: old.runtimeId, previousTabs: new Set(), observation: { decision() {}, card() {} },
      command: async () => 1,
      observe: (value: { commandStage?: number }) => { stage = value.commandStage ?? stage; },
      async nodes() {
        if (stage === 7) return condition === "ambiguous-fresh" ? [old, fresh, { ...fresh, runtimeId: "other" }] : [old, fresh];
        if (stage === 13 && condition === "swapped-before-allow") return [old, heading, allow];
        if (stage === 13 && condition === "ambiguous-allow") return [fresh, heading, allow, { ...allow, runtimeId: "other" }];
        return [fresh, heading, allow];
      },
      async until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, deadline = 30_000) {
        expect(deadline).toBe(stage === 7 ? 45_000 : 30_000);
        const value = await read();
        if (!accepts(value)) throw new Error("Original poll would refuse.");
        return value;
      },
      async focus(_hwnd: number, node: CardNode) { focus(node); },
      async text(_hwnd: number, select: (node: CardNode) => boolean) {
        text([select(old), select(fresh), select({ ...fresh, pid: 12 })]);
        return 'Node arguments: ["--test"]';
      },
      async click(_hwnd: number, select: (node: CardNode) => boolean, guard: (nodes: CardNode[]) => boolean) {
        const current = this as unknown as { node(hwnd: number, select: (node: CardNode) => boolean, enabled: boolean, guard: (nodes: CardNode[]) => boolean): Promise<CardNode> };
        expect(await current.node(1, select, true, guard)).toBe(allow);
        clicked++;
      },
    });
    const decision = driver.decide(["--test"]);
    if (condition === "old-first") await expect(decision).resolves.toBeUndefined();
    else await expect(decision).rejects.toThrow(/refuse/i);
    if (condition === "ambiguous-fresh") {
      expect(focus).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    } else {
      expect(focus).toHaveBeenCalledExactlyOnceWith(fresh);
      expect(text).toHaveBeenCalledExactlyOnceWith([false, true, false]);
    }
    expect(clicked).toBe(condition === "old-first" ? 1 : 0);
  },
);

it("refuses an already focused Allow if the fresh snapshot loses the selected card", async () => {
  const source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
  const first = source.indexOf("function sameNode("), firstEnd = source.indexOf("function subtree(", first);
  const begin = source.indexOf("  private async focus("), end = source.indexOf("  private pressKey(", begin);
  expect(first >= 0 && firstEnd > first && begin >= 0 && end > begin).toBe(true);
  const code = transformSync(source.slice(first, firstEnd) + "\nclass TestJourney {\n" + source.slice(begin, end)
    + "}\nmodule.exports = TestJourney.prototype.focus;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (this: object, hwnd: number, node: object, guard: (nodes: readonly object[]) => boolean) => Promise<object> };
  const refusal = new Error("The current native card was replaced.");
  runInNewContext(code, { module, refusal: () => refusal });
  const allow = { name: "Allow", controlType: "Button", isEnabled: true, isOffscreen: false, pid: 11, runtimeId: "allow", h: 21,
    bounds: { x: 1, y: 1, width: 10, height: 10 } };
  const replacement = { automationId: "ask-cmd", runtimeId: "replacement" };
  const receiver = {
    phase: 6, input: { activate: vi.fn(), activeWindow: () => 1 },
    bridge: { call: vi.fn(async (method: string) => method === "focused" ? { hwnd: 1, element: { ...allow, hasKeyboardFocus: true } } : { ok: true }) },
    observe: vi.fn(), observation: { node: vi.fn(), focused: vi.fn(), fresh: vi.fn() }, observeInput: (value: unknown) => value,
    async until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, deadline: number) {
      expect(deadline).toBe(10_000);
      const value = await read();
      expect(accepts(value)).toBe(true);
      return value;
    },
    nodes: vi.fn(async () => [replacement, allow]),
  };
  const guard = vi.fn(() => false);
  await expect(module.exports.call(receiver, 1, allow, guard)).rejects.toBe(refusal);
  expect(guard).toHaveBeenCalledExactlyOnceWith([replacement, allow]);
  expect(receiver.observation.fresh).toHaveBeenCalledExactlyOnceWith(undefined);
});
