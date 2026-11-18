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
  // Reverse the check that an answered card left the command window.
  const answered = "      return true;\n    });\n    // The click is input, not proof it was taken: an answered card leaves the window. Still commandStage 13 until it does.\n    try { await this.until(async () => { const after = await this.nodes(hwnd); return after.length > 0 && !hasDisplay(after); }, answered => answered, 10_000); }\n    catch (error) {\n      // Failure only: one hit test at the click point says what took the press. No name, bounds or identity is kept.\n      try {\n        const at = this.lastClick, chain = at && await this.bridge!.call<RawNode[]>(\"elementsAt\", { x: at.x, y: at.y, values: false, deadlineMs: 2500 }, 5000);\n        const leaf = chain?.at(-1), root = chain?.[0];\n        // 1 the button or something inside it, 2 something else in the command window; another window of Ember's by its\n        // own fixed title: 6 the overlay, 7 the prompt, 8 the Ask box, 9 Home, the handle or the vault's form, 5 any other.\n        const title = root?.name ?? \"\";\n        // 10: the click point lies outside the command window's own frame, so the button's rectangle reaches past it.\n        const frame = at && (await this.nodes(hwnd)).find(node => node.hwnd === hwnd)?.bounds;\n        const outside = !!at && !!frame && (at.x < frame.x || at.y < frame.y || at.x >= frame.x + frame.width || at.y >= frame.y + frame.height);\n        const unit = (value: number | undefined) => Math.max(0, Math.min(1023, Math.round((value ?? 0) / 4)));\n        if (at && leaf && root && leaf.pid === at.node.pid) this.clickGeometry = { px: unit(at.x), py: unit(at.y), fx: unit(frame?.x), fy: unit(frame?.y), fw: unit(frame?.width), fh: unit(frame?.height),\n          ox: unit(root.bounds?.x), oy: unit(root.bounds?.y), ow: unit(root.bounds?.width), oh: unit(root.bounds?.height) };\n        this.clickUnder = !at || !Array.isArray(chain) ? 0 : !leaf || !root ? 4 : chain.some(node => sameNode(node, at.node)) ? 1\n          : leaf.pid !== at.node.pid ? 3 : root.hwnd === hwnd ? 2 : outside ? 10\n          : title === \"Ember overlay\" ? 6 : title === \"Ember needs you\" ? 7 : title === \"Ask Ember\" ? 8 : title !== \"Ember\" ? 5\n          // \"Ember\" is Home, the handle and the vault's form: told apart by size class only. 11 the handle's pill or tab\n          // (at most 80 high), 12 a narrow card (at most 400 wide), 9 anything larger.\n          : !root.bounds ? 9 : root.bounds.height <= 80 ? 11 : root.bounds.width <= 400 ? 12 : 9;\n      } catch { this.clickUnder = 0; /* The original refusal stands. */ }\n      // Failure only: how the command window and Home are stacked. 32 both listed, 1 the command window is always on top,\n      // 2 Home is, 4 the command window is the higher of the two, 8 it is the foreground window, 16 Home is.\n      try {\n        const listed = (await this.bridge!.call<{ windows: UiaWindow[] }>(\"topWindows\", { pid: this.app!.pid, deadlineMs: 2500 }, 5000)).windows;\n        const command = listed.find(window => window.hwnd === hwnd), home = listed.find(window => window.hwnd === this.home);\n        if (command && home) this.clickGeometry = { ...this.clickGeometry, stack: 32 + (command.isTopmost ? 1 : 0) + (home.isTopmost ? 2 : 0) + (command.z < home.z ? 4 : 0) + (command.focused ? 8 : 0) + (home.focused ? 16 : 0) };\n      } catch { /* The original refusal stands. */ }\n      throw error;\n    }\n    this.observe({ commandStage: 14 });\n";
  expect(source.split(answered)).toHaveLength(2); source = source.replace(answered, "      return true;\n    });\n    this.observe({ commandStage: 14 });\n");
  for (const [added, original] of [["    const node = await this.focus(hwnd, await this.node(hwnd, select, true, guard), guard), box = node.bounds!;\n    this.lastClick = { x: box.x + Math.floor(box.width / 2), y: box.y + Math.floor(box.height / 2), node };\n    this.observe({ operation: 13, inputResult: 0 });", "    const node = await this.focus(hwnd, await this.node(hwnd, select, true, guard), guard), box = node.bounds!;\n    this.observe({ operation: 13, inputResult: 0 });"], ["  private lastClick?: { x: number; y: number; node: RawNode };\n  private clickUnder = 0;\n  private clickGeometry: Partial<PackagedCommandCardObservation> = {};\n  commandFailureObservation(): Readonly<PackagedCommandCardObservation> | undefined { return this.commandObservation && { ...this.commandObservation, ...(this.commandObservation.known ? { under: this.clickUnder, ...this.clickGeometry } : {}) }; }\n", "  commandFailureObservation(): Readonly<PackagedCommandCardObservation> | undefined { return this.commandObservation; }\n"]]) { expect(source.split(added)).toHaveLength(2); source = source.replace(added, original); }
  // Reverse the review step's wait for its result to be listed (a result exists only once its session has ended).
  const reviewWait = "    // Phase 7 ends at the Projects pane; 11 is the reveal, the click and the read. A snapshot leaves out whatever is\n    // scrolled out of view, with everything under it, so a result's button is never listed until it shows: waiting for\n    // it to be listed or scrolling it by its handle cannot work. Ordinary Tab navigation brings it into view instead,\n    // from the request box above the Coding group: found within twelve Tabs of the pane's link, focused, and the\n    // result's button within twelve more. Within phase 11 the welcome's unused `target` fact counts the steps:\n    // 1 finding the request box, 2 focusing it, 3 the Tab search for the result's button, 4 the click, 5 the read.\n    this.phase = 7; await this.idle(); await this.pane(\"Projects\");\n    const result = named(\"Review result: \" + titleOf(goal));\n    this.phase = 11; this.observe({ target: 1 }); const request = await this.revealHomeControl(id(\"project-sessions-request\"));\n    this.observe({ target: 2 }); await this.focus(this.home, request);\n    this.observe({ target: 3 }); await this.revealHomeControl(result);\n    this.observe({ target: 4 }); await this.click(this.home, result);\n    this.observe({ target: 5 });\n    const region: Selector = node => node.automationId === \"project-coding-review\" || ([\"Group\", \"Pane\"].includes(node.controlType ?? \"\") && node.name === titleOf(goal));\n    return this.until(() => this.homeText(region), text => text.includes(counts), 45_000);\n";
  expect(source.split(reviewWait)).toHaveLength(2); source = source.replace(reviewWait, "    this.phase = 7; await this.pane(\"Projects\");\n    await this.revealHomeControl(id(\"project-coding\"), false); await this.revealHomeControl(named(\"Review result: \" + titleOf(goal)));\n    await this.click(this.home, named(\"Review result: \" + titleOf(goal)));\n    const region: Selector = node => node.automationId === \"project-coding-review\" || ([\"Group\", \"Pane\"].includes(node.controlType ?? \"\") && node.name === titleOf(goal));\n    return this.until(() => this.homeText(region), text => text.includes(counts), 45_000);\n");
  // Reverse the cached command focus diagnostics before reconstructing earlier layers.
  const commandFocusAdditions = [
    "  commandWindows: number; targetType: number; focusedType: number; targetState: number; focusTrajectory: number;\n",
    " * Stage8 focus: control types0missing/1Edit/2Document/3Pane/4Window/5TabItem/6Button/7Group/8other.\n",
    " * Target state uses base-3 digits0unknown/1false/2true, low to high: focusable, offscreen, enabled, positive area.\n",
    " * Focus trajectory0no comparable readout/1first/2repeated first/3different runtime seen. Window candidates0unknown or none/1one/2multiple.\n",
    "  let firstFocusedRuntime: string | undefined;\n",
    "    if (current.commandStage !== 8) firstFocusedRuntime = undefined;\n",
    "    try { this.observation.commandWindowCandidates(windows); } catch { /* Cached filtered candidates only. */ }\n",
    "    try { this.observation.commandFocusTarget(node); } catch { /* Cached stage8 target only. */ }\n",
    "    try { this.observation.resetCommandFocus(); } catch { /* Cached decision diagnostics only. */ }\n",
    ", commandWindows: 2, targetType: 8, focusedType: 8, targetState: 80, focusTrajectory: 3",
    ", commandWindows: 0, targetType: 0, focusedType: 0, targetState: 0, focusTrajectory: 0",
  ];
  for (const addition of commandFocusAdditions) { expect(source.split(addition)).toHaveLength(2); source = source.replace(addition, ""); }
  const releaseOnCapture = "captured = true; firstFocusedRuntime = undefined; try { first";
  expect(source.split(releaseOnCapture)).toHaveLength(2);
  source = source.replace(releaseOnCapture, "captured = true; try { first");
  const commandFocusBlocks = [
    ["  const focusType =", "  const update =", "ec1add0fed41c7a49bdbb83d5caab9a715c42531a1443df6ef8d67498e4a61d4"],
    ["    resetCommandFocus() {", "    card(value:", "10b5c6e18ecd3b5f1b3cfb224377cb3e3abc4d2ffab2377e17c8e015d9446034"],
    ["      if (!captured && current.commandStage === 8) {", "      const same =", "1a84fb360ae505b5ecf4190f357591586806ffe65435aac62401907820f33538"],
  ];
  for (const [start, end, hash] of commandFocusBlocks) {
    const begin = source.indexOf(start), stop = source.indexOf(end, begin);
    expect(begin >= 0 && stop > begin).toBe(true);
    expect(digest(source.slice(begin, stop))).toBe(hash);
    source = source.slice(0, begin) + source.slice(stop);
  }
  expect(digest(source)).toBe("d1c5c6a987d184cce862187a354c8812e70c8091ee6fa26cd48dae0cb343d6cb");
  // Reverse only the foreground-before-focus ordering change before reviewing historical observation bytes.
  const focusStart = source.indexOf("    // Activation may return before Windows raises the HWND.");
  const focusEnd = source.indexOf("    const nodes = await this.nodes(hwnd);", focusStart);
  expect(focusStart > 0 && focusEnd > focusStart).toBe(true);
  expect(digest(source.slice(focusStart, focusEnd))).toBe("1a195a81c686270105cb2c589838dc336dc7ba416cabf4d3f420052cb77a1a6b");
  source = source.slice(0, focusStart) + [
    "    await this.bridge!.call(\"perform\", { handle: node.h, op: \"focus\", deadlineMs: 2500 }, 5000);",
    "    this.observe({ operation: 11, focusFlags: 0 });",
    "    await this.until(() => this.bridge!.call<{ element: RawNode | null; hwnd: number | null }>(\"focused\", { values: false, deadlineMs: 2500 }, 5000),",
    "      result => { try { this.observation.focused(result, node, hwnd); } catch { /* Preserve the original predicate. */ }",
    "        return result.hwnd === hwnd && !!result.element && sameNode(result.element, node) && result.element.hasKeyboardFocus === true; }, 10_000);",
    "",
  ].join("\n") + source.slice(focusEnd);
  const activation = "    this.current();\n    this.observeInput(this.input.activate(hwnd));";
  expect(source.split(activation)).toHaveLength(2);
  source = source.replace(activation, "    this.observeInput(this.input.activate(hwnd));");
  const freshFocus = "    const nodes = await this.nodes(hwnd);\n    this.current();\n    const fresh = !guard || guard(nodes)";
  expect(source.split(freshFocus)).toHaveLength(2);
  source = source.replace(freshFocus, "    const nodes = await this.nodes(hwnd);\n    const fresh = !guard || guard(nodes)");
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
  let source = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8");
  for (const addition of [
    ", host: 7, visibility: 7, under: 12, px: 1023, py: 1023, fx: 1023, fy: 1023, fw: 1023, fh: 1023, ox: 1023, oy: 1023, ow: 1023, oh: 1023, stack: 63 };", ", host: 0, visibility: 0, under: 0, px: 0, py: 0, fx: 0, fy: 0, fw: 0, fh: 0, ox: 0, oy: 0, ow: 0, oh: 0, stack: 0 };",
  ]) { expect(source.split(addition)).toHaveLength(2); source = source.replace(addition, addition.replace(/, visibility: [07], under: (?:0|12)(?:, [pfo][xywh]: (?:0|1023))+, stack: (?:0|63)/, "")); }
  for (const addition of [
    ", commandWindows: 2, targetType: 8, focusedType: 8, targetState: 80, focusTrajectory: 3",
    ", commandWindows: 0, targetType: 0, focusedType: 0, targetState: 0, focusTrajectory: 0",
  ]) { expect(source.split(addition)).toHaveLength(2); source = source.replace(addition, ""); }
  expect(digest(source)).toBe("f2a0f1217295a6c1f060c0f1a43ddab9f6aa75954b293c8069d619828a097fe1");
  source = source.replace(", projectStage: 16", "").replace(", projectStage: 0", "");
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
        // An answered card leaves the window: the read after the click no longer shows it.
        if (clicked) return [heading];
        return [fresh, heading, allow];
      },
      async until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, deadline = 30_000) {
        expect(deadline).toBe(stage === 7 ? 45_000 : clicked ? 10_000 : 30_000);
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
    phase: 6, current() {}, input: { activate: vi.fn(), activeWindow: () => 1 },
    bridge: { call: vi.fn(async (method: string) => method === "focused" ? { hwnd: 1, element: { ...allow, hasKeyboardFocus: true } } : { ok: true }) },
    observe: vi.fn(), observation: { node: vi.fn(), focused: vi.fn(), fresh: vi.fn() }, observeInput: (value: unknown) => value,
    async until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, deadline: number) {
      expect(deadline).toBeGreaterThan(0);
      expect(deadline).toBeLessThanOrEqual(10_000);
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

type FocusProbe = (hwnd: number, target: CardNode) => Promise<unknown>;

function focusProbe(journey: "node" | "wsl", ports: Record<string, unknown>, clock: { now: number }): FocusProbe {
  const module = { exports: {} as { WslPackagedUi: new (ports: object) => { focus: FocusProbe }; Journey: new () => { focus: FocusProbe } } };
  const refusal = () => new Error("Bounded focus refusal.");
  let code: string;
  if (journey === "wsl") {
    code = fs.readFileSync("test/fixtures/wsl-coding-packaged-uia.ts", "utf8").replace(/^import type .*\n/gm, "").replace(/^const pause = .*;$/m, "");
  } else {
    const source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
    const extract = (begin: string, end: string) => {
      const first = source.indexOf(begin), last = source.indexOf(end, first + begin.length);
      expect(first >= 0 && last > first).toBe(true);
      return source.slice(first, last);
    };
    code = extract("function sameNode(", "function subtree(") + "\nexport class Journey {\n"
      + extract("  private current()", "  private async windows(")
      + extract("  private async focus(", "  private pressKey(") + "\n}";
  }
  runInNewContext(transformSync(code, { loader: "ts", format: "cjs", target: "node22" }).code, {
    module, refusal, Date: { now: () => clock.now }, pause: async (ms: number) => { clock.now += ms; },
  });
  if (journey === "wsl") {
    const driver = new module.exports.WslPackagedUi({ ...ports, refuse: refusal });
    return driver.focus.bind(driver);
  }
  const { current: _current, ...driverPorts } = ports;
  const driver = Object.assign(new module.exports.Journey(), {
    ...driverPorts, phase: 4, observation: { node() {}, focused() {}, fresh() {} }, observe() {}, observeInput: (value: unknown) => value,
  });
  return driver.focus.bind(driver);
}

const orderingCases = [
  { name: "immediate", foregroundAt: 0, unavailable: 0, targetFocus: true, performMs: 0, readMs: 0, performed: 0, reads: 1, passes: true },
  { name: "delayed", foregroundAt: 450, unavailable: 2, targetFocus: true, performMs: 0, readMs: 0, performed: 450, reads: 1, passes: true },
  { name: "never", foregroundAt: Infinity, unavailable: 0, targetFocus: true, performMs: 0, readMs: 0, performed: null, reads: 0, passes: false },
  { name: "wrong foreground", foregroundAt: Infinity, unavailable: 2, targetFocus: true, performMs: 0, readMs: 0, performed: null, reads: 0, passes: false },
  { name: "misdirected focus", foregroundAt: 450, unavailable: 2, targetFocus: false, performMs: 0, readMs: 0, performed: 450, reads: 64, passes: false },
  { name: "late foreground", foregroundAt: 10_000, unavailable: 2, targetFocus: true, performMs: 0, readMs: 0, performed: null, reads: 0, passes: false },
  { name: "perform drains budget", foregroundAt: 9_900, unavailable: 2, targetFocus: true, performMs: 100, readMs: 0, performed: 9_900, reads: 0, passes: false },
  { name: "late correct focus", foregroundAt: 9_900, unavailable: 2, targetFocus: true, performMs: 0, readMs: 100, performed: 9_900, reads: 1, passes: false },
];
it.each((["node", "wsl"] as const).flatMap(journey => orderingCases.map(condition => ({ journey, ...condition }))))(
  "keeps the $journey fixture's single bounded focus attempt with $name", async condition => {
    const clock = { now: 0 }, attempts: number[] = [];
    const target = { h: 17, pid: 7, runtimeId: "target", controlType: "Button", hasKeyboardFocus: true, isEnabled: true, isOffscreen: false,
      bounds: { width: 30, height: 40 } };
    const input = {
      activate: vi.fn(), activeWindow: () => clock.now >= condition.foregroundAt ? 1 : condition.unavailable,
    };
    let reads = 0;
    const bridge = {
      async call(method: string, args: { handle?: number; op?: string; deadlineMs: number }, timeout: number) {
        expect(args.deadlineMs).toBe(2500);
        expect(timeout).toBe(5000);
        if (method === "perform") {
          expect(args).toMatchObject({ handle: target.h, op: "focus" });
          expect(input.activeWindow()).toBe(1);
          attempts.push(clock.now);
          clock.now += condition.performMs;
          return { ok: true };
        }
        expect(method).toBe("focused");
        reads++;
        clock.now += condition.readMs;
        return { hwnd: 1, element: condition.targetFocus ? target : { ...target, runtimeId: "prior" } };
      },
      async request() { return { result: { nodes: [target], cut: [] } }; },
    };
    const snapshots = vi.fn(async () => [target]);
    const run = focusProbe(condition.journey, { input, bridge, async nodes() { return snapshots(); }, deadline: 30_000, current() {} }, clock);
    if (condition.passes) await expect(run(1, target)).resolves.toBe(target);
    else {
      await expect(run(1, target)).rejects.toThrow("Bounded focus refusal.");
      expect(snapshots).not.toHaveBeenCalled();
    }
    expect(input.activate).toHaveBeenCalledExactlyOnceWith(1);
    expect(attempts).toEqual(condition.performed === null ? [] : [condition.performed]);
    expect(reads).toBe(condition.reads);
    expect(clock.now).toBeLessThanOrEqual(10_050);
  },
);

it.each(["still current", "already stopped", "deadline during snapshot", "stop during snapshot", "forced during snapshot"] as const)(
  "keeps the Node fixture's current ownership with %s", async scenario => {
    const clock = { now: 0 }, target = {
      h: 17, pid: 7, runtimeId: "target", controlType: "Button", hasKeyboardFocus: true, isEnabled: true, isOffscreen: false, bounds: { width: 30, height: 40 },
    };
    const activate = vi.fn(), call = vi.fn(async (method: string) => method === "focused" ? { hwnd: 1, element: target } : { ok: true });
    const nodes = vi.fn(async function (this: { stopped: boolean; forced: boolean }) {
      if (scenario === "stop during snapshot") this.stopped = true;
      if (scenario === "forced during snapshot") this.forced = true;
      if (scenario === "deadline during snapshot") clock.now = 500;
      return [target];
    });
    const run = focusProbe("node", {
      stopped: scenario === "already stopped", forced: false, deadline: 500, input: { activate, activeWindow: () => 1 }, bridge: { call }, nodes,
    }, clock);
    if (scenario === "still current") await expect(run(1, target)).resolves.toBe(target);
    else await expect(run(1, target)).rejects.toThrow("Bounded focus refusal.");
    expect(activate).toHaveBeenCalledTimes(scenario === "already stopped" ? 0 : 1);
    expect(call.mock.calls.map(([method]) => method)).toEqual(scenario === "already stopped" ? [] : ["perform", "focused"]);
    expect(nodes).toHaveBeenCalledTimes(scenario === "already stopped" ? 0 : 1);
  },
);
