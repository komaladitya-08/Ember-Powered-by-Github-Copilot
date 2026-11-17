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
  source = source.replaceAll("revealHomeControl", "revealWelcomeRow");
  source = source.replace("reveal Home controls with ordinary forward or reverse Tab navigation.", "follow consent order with ordinary forward or reverse Tab navigation.");
  source = source.replace('await this.revealWelcomeRow(id("project-coding-choose")); ', "");
  source = source.replace("inputResult: number; bridgeStage: number; projectStage: number;", "inputResult: number; bridgeStage: number;");
  source = source.replace(/^ \* Project\/folder stage0.*\n \* 9dialog-block-check.*\n/m, "");
  source = source.replace(", projectStage: 16", "").replace(", projectStage: 0", "");
  source = source.replace(" this.observe({ projectStage: 16 });", "").replace(/this\.observe\(\{ projectStage: (?:[1-9]|1[0-5]) \}\); /g, "");
  expect(digest(source)).toBe("c4d7503b2d57490a95de5e78b2357bd6b8329e15c04b719f193ab7caf2c9c447");
});
it("preserves the whole workflow after reversing only the closed project/folder field", () => {
  const source = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8").replace(", projectStage: 16", "").replace(", projectStage: 0", "");
  expect(digest(source)).toBe("54d77bc05dbb2d2d3a9b684709da9b8f8d4fbd196cee0f1809487afdb3f23271");
});
