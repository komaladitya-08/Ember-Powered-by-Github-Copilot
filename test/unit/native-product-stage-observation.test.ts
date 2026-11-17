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
it("preserves the whole workflow after reversing only the closed project/folder field and reviewed source-proof demotion", () => {
  let source = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8").replace(", projectStage: 16", "").replace(", projectStage: 0", "");
  source = source.replace('welcomeStep: 6, nextLabel: 7, target: 9, bridgeError:', 'welcomeStep: 6, nextLabel: 7, target: 7, bridgeError:');
  source = source.replace(', allowFlags: 31, denyFlags: 31, hintFlags: 3', "").replace(', allowFlags: 0, denyFlags: 0, hintFlags: 0', "");
  source = source.replace(', providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15', "");
  source = source.replace(', providerStage: 0, commandStage: 0, commandDecision: 0, repairStep: 0, repairResults: 0, focusIdentity: 0, cardFlags: 0', "");
  const closed = `          const reviewed = Object.freeze({
            ready: false,
            run: 43991252195,
            commit: "b75c944dec58973d157542e2d4d2db3720667982",
            artifact: 14289217635,
            archiveBytes: 38425334,
            archiveSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
            manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f",
            assetProofCommit: null,
            assetProofManifestSha256: null,
            verifierFileSha256: null,
          });`;
  if (source.includes(closed)) {
    expect(source.split(closed)).toHaveLength(2);
    source = source.replace(closed, closed.replace("ready: false", "ready: true")
      .replace("assetProofCommit: null", 'assetProofCommit: "5b89563840479d27b1ba83251fd74652d219d913"')
      .replace("assetProofManifestSha256: null", 'assetProofManifestSha256: "3b1f1c4b03aaa44afd617f38a2ea81095ee6e688fa06390daeb6e54529329320"')
      .replace("verifierFileSha256: null", 'verifierFileSha256: "8dff6a53bca9c2dc39a190a9298f743cbbc40c54f7f24ea456af21498e19c302"'));
    source = source.replace("// The fixed POSIX producer is authenticated; the expanded current-source graph awaits fresh qualification.",
      "// The fixed POSIX producer and expanded current-source graph are independently qualified.");
  }
  expect(digest(source)).toBe("54d77bc05dbb2d2d3a9b684709da9b8f8d4fbd196cee0f1809487afdb3f23271");
});
