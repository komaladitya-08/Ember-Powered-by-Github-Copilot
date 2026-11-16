import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// @ts-expect-error -- portable privately branded host-build diagnostics, outside the application TypeScript build
import { uvSpawnBuildCheckpoints as checkpoints, uvSpawnVersionSubcheckpoints as versionSteps, createUvSpawnBuildDiagnostic, classifyUvSpawnBuildFailure } from "../../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs";
// @ts-expect-error -- read-only compile recipe for a trusted Windows-only producer; no build is invoked
import { windowsUvSpawnRecipe } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";

type Tool = { toolId: number; state: number; components: number[] };
type Failure = { schema: number; status: string; checkpoint: number; versionDiagnostic?: { schema: number; subcheckpoint: number; tools: Tool[] } };
type Diagnostic = { checkpoint: (code: unknown) => void; subcheckpoint: (code: unknown) => void; observeVersion: (toolId: unknown, value: unknown) => void;
  failure: (error?: unknown) => Error; classify: (error: unknown) => Failure };
const create = (): Diagnostic => createUvSpawnBuildDiagnostic();
const emptyTools = () => Array.from({ length: 6 }, (_, index) => ({ toolId: index + 1, state: 0, components: [] }));
const closed = (checkpoint: number) => ({ schema: 1, status: "failed", checkpoint,
  ...(checkpoint === checkpoints.versions ? { versionDiagnostic: { schema: 1, subcheckpoint: 0, tools: emptyTools() } } : {}) });

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

it("defines only fixed Phase7 subcheckpoints and exposes no version facts in other phases", () => {
  expect(Object.values(versionSteps)).toEqual(Array.from({ length: 20 }, (_, index) => index)); expect(Object.isFrozen(versionSteps)).toBe(true);
  const diagnostic = create();
  expect(() => diagnostic.subcheckpoint(versionSteps.powershellCall)).toThrow("fixed version checkpoint was refused");
  expect(() => diagnostic.observeVersion(1, "17.14.1")).toThrow("fixed version observation was refused");
  diagnostic.checkpoint(checkpoints.versions); diagnostic.subcheckpoint(versionSteps.visualStudioCall); diagnostic.observeVersion(1, "17.14.1");
  diagnostic.checkpoint(checkpoints.configure);
  expect(diagnostic.classify(diagnostic.failure())).toEqual(closed(checkpoints.configure));
});

it.each([1, 2, 3, 4, 5, 6])("projects only anchored 2–4 component successful version text for fixed tool ID%s", toolId => {
  for (const [text, components] of [["0.999999", [0, 999999]], ["17.14.35207", [17, 14, 35207]], ["19.44.35211.0", [19, 44, 35211, 0]]] as const) {
    const diagnostic = create(); diagnostic.checkpoint(checkpoints.versions); diagnostic.observeVersion(toolId, toolId === 6 ? `cmake version ${text}` : text);
    const projected = diagnostic.classify(diagnostic.failure()).versionDiagnostic!.tools;
    expect(projected[toolId - 1]).toEqual({ toolId, state: 1, components: [...components] });
    expect(projected.filter(item => item.toolId !== toolId)).toEqual(emptyTools().filter(item => item.toolId !== toolId));
  }
});

it("turns malformed, suffixed, too-long or foreign version outputs into fixed unknown state without partial extraction", () => {
  for (const toolId of [1, 6]) for (const output of ["1", "1.2.3.4.5", "1.1000000.3", "-1.2.3", "1.2.3-private", "1.2.3\n", " 1.2.3", "1.2.3 ",
    "private ".repeat(20), null, 123, Symbol("private")]) {
    const diagnostic = create(); diagnostic.checkpoint(checkpoints.versions);
    diagnostic.observeVersion(toolId, toolId === 6 && typeof output === "string" ? `cmake version ${output}` : output);
    expect(diagnostic.classify(diagnostic.failure()).versionDiagnostic!.tools[toolId - 1]).toEqual({ toolId, state: 2, components: [] });
  }
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.versions); diagnostic.observeVersion(6, "3.31.6");
  expect(diagnostic.classify(diagnostic.failure()).versionDiagnostic!.tools[5]).toEqual({ toolId: 6, state: 2, components: [] });
});

it("deep-freezes the first version snapshot against later observations, subphases and reentrant invocations", () => {
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.versions); diagnostic.subcheckpoint(versionSteps.msbuildCall);
  diagnostic.observeVersion(2, "19.44.35211.0"); diagnostic.observeVersion(5, "3.12.10"); const first = diagnostic.failure("private");
  const snapshot = diagnostic.classify(first), encoded = JSON.stringify(snapshot);
  expect(snapshot.versionDiagnostic!.subcheckpoint).toBe(versionSteps.msbuildCall);
  expect(Object.isFrozen(snapshot.versionDiagnostic)).toBe(true); expect(Object.isFrozen(snapshot.versionDiagnostic!.tools)).toBe(true);
  expect(Object.isFrozen(snapshot.versionDiagnostic!.tools[1].components)).toBe(true);
  diagnostic.observeVersion(2, "999999.1"); diagnostic.observeVersion(1, "17.14.1"); diagnostic.subcheckpoint(versionSteps.cmakePin);
  expect(JSON.stringify(diagnostic.classify(first))).toBe(encoded); expect(diagnostic.failure()).toBe(first);
  const next = create(); next.checkpoint(checkpoints.versions); const second = next.failure(first);
  expect(next.classify(second)).toEqual(closed(checkpoints.versions)); expect(diagnostic.classify(second)).toEqual(closed(0));
  expect(() => snapshot.versionDiagnostic!.tools[1].components.push(5)).toThrow();
});

it("never reads foreign output or selector getters, including revoked proxies and boxed strings", () => {
  let touched = 0; const trap = () => { touched++; throw new Error("private"); };
  const hostile = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, has: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const boxed = Object.defineProperties(Object("1.2.3"), { toString: { get: trap }, valueOf: { get: trap }, toJSON: { get: trap } });
  const diagnostic = create(); diagnostic.checkpoint(checkpoints.versions);
  for (const value of [hostile, revoked.proxy, boxed]) {
    diagnostic.observeVersion(1, value);
    expect(() => diagnostic.observeVersion(value, "1.2.3")).toThrow("fixed version observation was refused");
    expect(() => diagnostic.subcheckpoint(value)).toThrow("fixed version checkpoint was refused");
  }
  for (const value of [-1, 20, 1.5, "1", null, undefined]) expect(() => diagnostic.subcheckpoint(value)).toThrow();
  for (const value of [0, 7, 1.5, "1", null, undefined]) expect(() => diagnostic.observeVersion(value, "1.2.3")).toThrow();
  const output = diagnostic.classify(diagnostic.failure(hostile));
  expect(output.versionDiagnostic!.tools[0]).toEqual({ toolId: 1, state: 2, components: [] }); expect(touched).toBe(0);
  expect(JSON.stringify(output)).not.toMatch(/private|message|stack|stderr|stdout|signal|path|native/i);
});

it("records distinct Phase7 call, JSON, shape and banner checkpoints before the unchanged fallible blocks", () => {
  const text = fs.readFileSync(new URL("../../scripts/experimental/build-windows-uv-spawn-probe.mjs", import.meta.url), "utf8");
  const body = text.slice(text.indexOf("diagnostic.checkpoint(checkpoints.versions);"), text.indexOf("diagnostic.checkpoint(checkpoints.sourceBefore);"));
  const markers = [...body.matchAll(/diagnostic\.subcheckpoint\(versionSteps\.([A-Za-z]+)\);/g)];
  expect(markers.map(item => item[1])).toEqual(Object.keys(versionSteps).slice(1, 8));
  const anchors = ["const metadataOutput = captured(", "const metadata = JSON.parse(metadataOutput)", "if (!strict(metadata,", "const cmakeOutput = captured(",
    "const cmakeVersion = cmakeOutput.split(", "const visualStudioVersion = captured(", "const msbuildVersion = captured("];
  markers.forEach((marker, index) => expect(body.slice(marker.index, markers[index + 1]?.index).includes(anchors[index])).toBe(true));
  expect(body).toContain("diagnostic.observeVersion(5, python.version)"); expect(body).toContain("diagnostic.observeVersion(6, cmakeVersion)");
  expect(body).not.toContain("diagnostic.observeVersion(5, buildPin"); expect(body).not.toContain("diagnostic.observeVersion(6, buildPin");
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
