import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error -- portable privately branded host-build diagnostics, outside the application TypeScript build
import { uvSpawnBuildCheckpoints as checkpoints, createUvSpawnBuildDiagnostic, classifyUvSpawnBuildFailure } from "../../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs";
// @ts-expect-error -- read-only compile recipe for a trusted Windows-only producer; no build is invoked
import { windowsUvSpawnRecipe } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";

type Diagnostic = { checkpoint: (code: unknown) => void; failure: (error?: unknown) => Error; classify: (error: unknown) => object };
const create = (): Diagnostic => createUvSpawnBuildDiagnostic();
const closed = (checkpoint: number) => ({ schema: 1, status: "failed", checkpoint });

it("defines a fixed closed checkpoint range and emits no process, output or native-admission facts", () => {
  expect(Object.values(checkpoints)).toEqual(Array.from({ length: 21 }, (_, index) => index));
  expect(checkpoints).toMatchObject({ unknown: 0, configure: 9, compilerSelection: 10, generatedProject: 11, msbuild: 12, sourceAfter: 13, receipt: 20 });
  expect(Object.isFrozen(checkpoints)).toBe(true);
  const value = classifyUvSpawnBuildFailure(new Error("private details")); expect(value).toEqual(closed(0)); expect(Object.isFrozen(value)).toBe(true);
});

it.each(Array.from({ length: 21 }, (_, index) => index))("brands an injected first failure at its owned checkpoint %s", checkpoint => {
  const diagnostic = create(); diagnostic.checkpoint(checkpoint);
  const error = diagnostic.failure(new Error("private compiler command, path, stderr and stack"));
  expect(diagnostic.classify(error)).toEqual(closed(checkpoint)); expect(classifyUvSpawnBuildFailure(error)).toEqual(closed(checkpoint));
  const output = JSON.stringify(diagnostic.classify(error)); expect(output).not.toMatch(/compiler|command|path|stderr|stack|signal|native|private/);
});

it("preserves the first owned failure through outer catches and later checkpoint changes", () => {
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.configure); const first = diagnostic.failure("private first");
  diagnostic.checkpoint(checkpoints.msbuild);
  expect(diagnostic.failure(first)).toBe(first); expect(diagnostic.failure(new Error("private later"))).toBe(first); expect(diagnostic.failure()).toBe(first);
  expect(diagnostic.classify(first)).toEqual(closed(checkpoints.configure));
});

it("keeps invocation latches independent and rebrands a different invocation's error at the current checkpoint", () => {
  const first = create(), next = create(); first.checkpoint(checkpoints.configure); next.checkpoint(checkpoints.msbuild);
  const earlier = first.failure("private earlier"); expect(next.classify(earlier)).toEqual(closed(0));
  const later = next.failure(earlier); expect(later).not.toBe(earlier); expect(next.classify(later)).toEqual(closed(checkpoints.msbuild));
  expect(first.classify(later)).toEqual(closed(0)); expect(first.failure(later)).toBe(earlier);
});

it("keeps nested or reentrant invocations from replacing the outer checkpoint or first failure", () => {
  const outer = create(); outer.checkpoint(checkpoints.configure);
  const nested = () => { const inner = create(); inner.checkpoint(checkpoints.emission); return inner.failure("private inner"); };
  const inner = nested(); const outerError = outer.failure(inner);
  expect(outer.classify(outerError)).toEqual(closed(checkpoints.configure));
  expect(classifyUvSpawnBuildFailure(inner)).toEqual(closed(checkpoints.emission));
  outer.checkpoint(checkpoints.receipt); expect(outer.failure(nested())).toBe(outerError);
});

it("never enumerates, reads, stringifies or inspects a foreign Proxy or exception getter", () => {
  let touched = 0;
  const forbidden = () => { touched++; throw new Error("private trap"); };
  const hostile = new Proxy({}, { get: forbidden, getPrototypeOf: forbidden, ownKeys: forbidden, getOwnPropertyDescriptor: forbidden, has: forbidden });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const getters = Object.defineProperties({}, Object.fromEntries(["message", "cause", "stack", "code", "status", "signal", "stdout", "stderr", "toString", "toJSON"].map(key => [key, { get: forbidden }])));
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.tools);
  for (const foreign of [hostile, revoked.proxy, getters, undefined, null, "private", 37, Symbol("private"), 1n]) {
    expect(classifyUvSpawnBuildFailure(foreign)).toEqual(closed(0)); expect(diagnostic.classify(foreign)).toEqual(closed(0));
  }
  const error = diagnostic.failure(hostile); expect(diagnostic.classify(error)).toEqual(closed(checkpoints.tools));
  expect(diagnostic.failure(getters)).toBe(error); expect(touched).toBe(0);
});

it("does not read even overwritten properties of an owned branded Error", () => {
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.generatedProject); const error = diagnostic.failure();
  let touched = 0; const getter = () => { touched++; throw new Error("private getter"); };
  Object.defineProperties(error, { message: { get: getter }, stack: { get: getter }, status: { get: getter }, toJSON: { get: getter } });
  expect(diagnostic.failure(error)).toBe(error); expect(classifyUvSpawnBuildFailure(error)).toEqual(closed(checkpoints.generatedProject));
  expect(JSON.stringify(diagnostic.classify(error))).toBe('{"schema":1,"status":"failed","checkpoint":11}'); expect(touched).toBe(0);
});

it("rejects invalid checkpoint selectors without coercion or replacing the last valid phase", () => {
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.python);
  let touched = 0; const hostile = new Proxy({}, { get() { touched++; throw new Error("private"); } });
  for (const value of [-1, 21, 9.5, NaN, Infinity, "9", null, undefined, hostile]) {
    expect(() => diagnostic.checkpoint(value)).toThrow("fixed build checkpoint was refused");
  }
  expect(diagnostic.classify(diagnostic.failure())).toEqual(closed(checkpoints.python)); expect(touched).toBe(0);
});

it("binds every pre-failure block and its diagnostic module to the existing compile authority", () => {
  const text = fs.readFileSync(new URL("../../scripts/experimental/build-windows-uv-spawn-probe.mjs", import.meta.url), "utf8");
  const body = text.slice(text.indexOf("export async function buildWindowsUvSpawnProbe"), text.indexOf("\nif (process.argv[1]"));
  const markers = [...body.matchAll(/diagnostic\.checkpoint\(checkpoints\.([A-Za-z]+)\);/g)];
  expect(markers.map(item => item[1])).toEqual(Object.keys(checkpoints).slice(1));
  const anchors = ["if (process.platform", "fs.mkdirSync(destination", "attestWindowsUvSpawnPython(", "await prepareWindowsUvSpawnSource(", "const vswhere = ordinary(",
    "const toolDirectory = path.join(", "const metadata = JSON.parse(", "await validateWindowsUvSpawnSource(", 'captured(toolPaths.cmake, ["-S"', "const compilerMetadata = inputBytes(",
    "const generatedProjects = [", 'captured(toolPaths.cmake, ["--build"', "await validateWindowsUvSpawnSource(", "if (!equal(recipe, windowsUvSpawnRecipe())", "const listing = inputBytes(",
    "const emissionBytes = Buffer.from(", "const object = inputBytes(", "const bytes = inputBytes(", "const staged = path.join(", "const receipt = { schema: 1"];
  markers.forEach((marker, index) => expect(body.slice(marker.index, markers[index + 1]?.index).includes(anchors[index])).toBe(true));
  expect(windowsUvSpawnRecipe().map((item: { file: string }) => item.file)).toContain("scripts/experimental/windows-uv-spawn-build-diagnostic.mjs");
  expect(text).toContain('} catch (error) { throw diagnostic.failure(error); }');
  expect(text).toContain('process.stderr.write(JSON.stringify(classifyUvSpawnBuildFailure(error)) + "\\n")');
});

it("prints only unknown checkpoint JSON for invalid CLI arguments without invoking a build", () => {
  const script = fileURLToPath(new URL("../../scripts/experimental/build-windows-uv-spawn-probe.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--private-invalid", "C:\\private-owner\\project"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  expect(result.status).toBe(1); expect(result.stdout.length).toBe(0);
  expect(result.stderr === '{"schema":1,"status":"failed","checkpoint":0}\n', "The refused CLI must emit only its fixed closed projection.").toBe(true);
});
