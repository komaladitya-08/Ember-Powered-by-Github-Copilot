import { expect, it } from "vitest";
// @ts-expect-error -- portable generated-project witness, outside the application's TypeScript build
import { buildPin, windowsUvSpawnProjectWitness } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";
// @ts-expect-error -- private-brand classifier for the actual witness's closed first-constraint errors
import { classifyWindowsUvSpawnProjectFailure, uvSpawnProjectConstraints as constraints } from "../../scripts/experimental/windows-uv-spawn-project-diagnostic.mjs";
// @ts-expect-error -- existing per-invocation build diagnostic only snapshots source-owned project facts at Phase11
import { createUvSpawnBuildDiagnostic } from "../../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs";

const condition = "'$(Configuration)|$(Platform)'=='Release|x64'";
const fixedMessage = "The fixed uv_spawn build failed its exact source, recipe or issuer contract.";
const clValues = '%(PreprocessorDefinitions);WIN32;NDEBUG;_WIN32_WINNT=0x0602;EMBER_UV_FIXED_PROBE_OFFLINE=1;CMAKE_INTDIR=&quot;Release&quot;';
const rcValues = String.raw`%(PreprocessorDefinitions);WIN32;NDEBUG;_WIN32_WINNT=0x0602;EMBER_UV_FIXED_PROBE_OFFLINE=1;CMAKE_INTDIR=\&quot;Release\&quot;`;
const definitions = (value: string) => `<PreprocessorDefinitions>${value}</PreprocessorDefinitions>`;
const cl = (value = clValues) => `<ClCompile>${definitions(value)}<RuntimeLibrary>MultiThreaded</RuntimeLibrary><AdditionalOptions>%(AdditionalOptions)</AdditionalOptions></ClCompile>`;
const rc = (value = rcValues) => `<ResourceCompile>${definitions(value)}<AdditionalIncludeDirectories>D:/public-source/include;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories></ResourceCompile>`;
const midl = "<Midl><AdditionalIncludeDirectories>D:/public-source/include;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories><OutputDirectory>$(ProjectDir)/$(IntDir)</OutputDirectory><HeaderFileName>%(Filename).h</HeaderFileName><TypeLibraryName>%(Filename).tlb</TypeLibraryName><InterfaceIdentifierFileName>%(Filename)_i.c</InterfaceIdentifierFileName><ProxyFileName>%(Filename)_p.c</ProxyFileName></Midl>";
function selectedUnit(kind: "PIPE" | "PROCESS", extra = "") {
  return `<ClCompile Include="D:/public-source/src/win/${kind.toLowerCase()}.c"><PreprocessorDefinitions Condition="${condition}">EMBER_UV_SPAWN_OBSERVE_${kind}=1;%(PreprocessorDefinitions)</PreprocessorDefinitions><ForcedIncludeFiles Condition="${condition}">D:/public-recipe/windows-uv-spawn-observe.h;%(ForcedIncludeFiles)</ForcedIncludeFiles>${extra}</ClCompile>`;
}
const otherUnit = (extra = "") => `<ClCompile Include="D:/public-source/src/win/core.c">${extra}</ClCompile>`;
const probeUnits = '<ClCompile Include="D:/public-recipe/windows-uv-spawn-probe.c"/><ClCompile Include="D:/public-recipe/windows-uv-spawn-observe.c"/>';
type Fixture = { cl?: string; rc?: string; midl?: string; extra?: string; units?: string; release?: string; toolset?: string; sdk?: string };
function project(target = "uv_a", options: Fixture = {}) {
  const group = `${options.cl ?? cl()}${options.rc ?? rc()}${options.midl ?? midl}${options.extra ?? ""}`;
  return `\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<Project DefaultTargets="Build" ToolsVersion="Current" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><PlatformToolset>${options.toolset ?? "v143"}</PlatformToolset><WindowsTargetPlatformVersion>${options.sdk ?? "10.0.26100.0"}</WindowsTargetPlatformVersion></PropertyGroup><ItemDefinitionGroup Condition="${options.release ?? condition}">${group}</ItemDefinitionGroup><ItemGroup>${options.units ?? (target === "uv_a" ? selectedUnit("PIPE") + selectedUnit("PROCESS") + otherUnit() : probeUnits)}</ItemGroup></Project>`;
}
type Facts = { schema: number; target: number; constraint: number; unit: number; count: number };
function refused(value: unknown, target = "uv_a", expected?: Partial<Facts>) {
  let error: unknown;
  try { windowsUvSpawnProjectWitness(typeof value === "string" ? Buffer.from(value) : value, target); } catch (caught) { error = caught; }
  expect(error !== undefined, "The generated-project fault must be refused by the actual witness.").toBe(true);
  const facts = classifyWindowsUvSpawnProjectFailure(error) as Facts | undefined;
  expect(facts !== undefined, "The witness must preserve its owned closed first-constraint brand.").toBe(true);
  expect(Object.keys(facts!).sort()).toEqual(["constraint", "count", "schema", "target", "unit"]);
  expect(facts!.schema).toBe(1); expect([0, 1, 2]).toContain(facts!.target); expect(Number.isInteger(facts!.constraint) && facts!.constraint >= 0 && facts!.constraint <= 17).toBe(true);
  expect(Number.isInteger(facts!.unit) && facts!.unit >= 0 && facts!.unit <= 3).toBe(true); expect(Number.isInteger(facts!.count) && facts!.count >= 0 && facts!.count <= 17).toBe(true);
  expect((error as Error).message).toBe(fixedMessage); expect(Object.isFrozen(facts)).toBe(true);
  if (expected) expect(facts).toMatchObject(expected);
  return { error: error as Error, facts: facts! };
}

it("models pinned CMake's distinct CL, RC and MIDL scopes without equating unrelated quote escapes", () => {
  expect(clValues).not.toBe(rcValues);
  for (const target of ["uv_a", "ember_uv_spawn_probe"]) {
    const bytes = Buffer.from(project(target));
    expect(windowsUvSpawnProjectWitness(bytes, target)).toMatchObject({ target, bytes: bytes.length, targetMacro: "0x0602", releaseDefinitionCount: 1 });
  }
});

it("keeps the diagnostic constraint vocabulary fixed and bounded", () => {
  expect(Object.values(constraints)).toEqual(Array.from({ length: 18 }, (_, index) => index)); expect(Object.isFrozen(constraints)).toBe(true);
});

it("refuses foreign input, invalid encoding and ambiguous Release selection with closed target IDs", () => {
  for (const value of [null, {}, Buffer.alloc(0), Buffer.alloc(buildPin.maximumProjectBytes + 1)]) refused(value, "uv_a", { target: 1, constraint: constraints.input });
  refused(Buffer.from(project()), "private-target", { target: 0, constraint: constraints.input });
  for (const value of [Buffer.from([0xff]), project().replace("<Project ", "<!DOCTYPE private-owner><Project "), project().replace("<Project ", "<!ENTITY private-owner><Project ")]) refused(value, "uv_a", { constraint: constraints.encoding });
  refused(project("uv_a", { release: "'$(Configuration)|$(Platform)'=='Debug|x64'" }), "uv_a", { constraint: constraints.release, count: 0 });
  const duplicate = project().replace("</ItemDefinitionGroup>", `</ItemDefinitionGroup><ItemDefinitionGroup Condition="${condition}">${cl()}${rc()}</ItemDefinitionGroup>`);
  refused(duplicate, "uv_a", { constraint: constraints.release, count: 2 });
});

it.each(["cl", "rc"] as const)("requires one unconditional %s block rather than an absent, duplicate or conditioned scope", scope => {
  const block = scope === "cl" ? cl() : rc(), name = scope === "cl" ? "ClCompile" : "ResourceCompile", constraint = scope === "cl" ? constraints.clBlock : constraints.rcBlock;
  refused(project("uv_a", { [scope]: "" }), "uv_a", { constraint, count: 0 });
  refused(project("uv_a", { [scope]: block + block }), "uv_a", { constraint, count: 2 });
  refused(project("uv_a", { [scope]: block.replace(`<${name}>`, `<${name} Condition="${condition}">`) }), "uv_a", { constraint });
  refused(project("uv_a", { [scope]: `<Unrelated>${block}</Unrelated>` }), "uv_a", { constraint });
  refused(project("uv_a", { [scope]: block.replace(`</${name}>`, "") }));
});

it.each(["cl", "rc"] as const)("requires exactly one direct, unconditioned definition element in %s", scope => {
  const value = scope === "cl" ? clValues : rcValues, block = scope === "cl" ? cl() : rc(), constraint = scope === "cl" ? constraints.clDefinitions : constraints.rcDefinitions;
  for (const replacement of ["", definitions(value) + definitions(value), `<PreprocessorDefinitions Condition="${condition}">${value}</PreprocessorDefinitions>`, `<Unrelated>${definitions(value)}</Unrelated>`]) {
    refused(project("uv_a", { [scope]: block.replace(definitions(value), replacement) }), "uv_a", { constraint });
  }
});

it.each(["cl", "rc"] as const)("validates Windows and offline definitions independently and exactly once in %s", scope => {
  const value = scope === "cl" ? clValues : rcValues, block = scope === "cl" ? cl() : rc(), constraint = scope === "cl" ? constraints.clMacros : constraints.rcMacros;
  for (const altered of [value.replace("_WIN32_WINNT=0x0602", "_WIN32_WINNT=0x0A00"), value.replace("_WIN32_WINNT=0x0602;", ""), value + ";_WIN32_WINNT=0x0602",
    value.replace("EMBER_UV_FIXED_PROBE_OFFLINE=1", "EMBER_UV_FIXED_PROBE_OFFLINE=0"), value.replace("EMBER_UV_FIXED_PROBE_OFFLINE=1;", ""), value + ";EMBER_UV_FIXED_PROBE_OFFLINE=1"]) {
    refused(project("uv_a", { [scope]: block.replace(value, altered) }), "uv_a", { constraint });
  }
});

it("keeps CRT validation inside CL and rejects hidden sensitive tokens outside both canonical definition nodes", () => {
  refused(project("uv_a", { cl: cl().replace("MultiThreaded", "MultiThreadedDLL") }), "uv_a", { constraint: constraints.runtime });
  refused(project("uv_a", { cl: cl().replace("<RuntimeLibrary>MultiThreaded</RuntimeLibrary>", ""), rc: rc() + "<RuntimeLibrary>MultiThreaded</RuntimeLibrary>" }), "uv_a", { constraint: constraints.runtime });
  for (const marker of ["/U_WIN32_WINNT", "/D_WIN32_WINNT=0x0A00", "/UEMBER_UV_FIXED_PROBE_OFFLINE", "/DEMBER_UV_FIXED_PROBE_OFFLINE=0"]) {
    refused(project("uv_a", { extra: `<AdditionalOptions>${marker}</AdditionalOptions>` }), "uv_a", { constraint: constraints.remaining });
    refused(project("uv_a", { midl: midl.replace("</Midl>", `<PreprocessorDefinitions>${marker}</PreprocessorDefinitions></Midl>`) }), "uv_a", { constraint: constraints.remaining });
  }
  refused(project("uv_a", { cl: cl(clValues + ";&#95;WIN32_WINNT=0x0A00") }));
});

it("requires one direct, unconditional scalar MT runtime and refuses hidden or duplicate runtime options", () => {
  const runtime = "<RuntimeLibrary>MultiThreaded</RuntimeLibrary>";
  for (const replacement of [`<Unrelated>${runtime}</Unrelated>`, `${runtime}<RuntimeLibrary>MultiThreadedDLL</RuntimeLibrary>`, runtime + runtime,
    `<RuntimeLibrary Condition="${condition}">MultiThreaded</RuntimeLibrary>`, "<RuntimeLibrary><Unrelated>MultiThreaded</Unrelated></RuntimeLibrary>"]) {
    refused(project("uv_a", { cl: cl().replace(runtime, replacement) }), "uv_a", { constraint: constraints.runtime });
  }
  refused(project("uv_a", { cl: cl().replace(runtime, runtime + `<Unrelated>${runtime}</Unrelated>`) }), "uv_a", { constraint: constraints.runtime });
});

it("keeps SDK and toolset pins unchanged", () => {
  refused(project("uv_a", { toolset: "v145" }), "uv_a", { constraint: constraints.toolsetSdk });
  refused(project("uv_a", { sdk: "10.0.1.0" }), "uv_a", { constraint: constraints.toolsetSdk });
});

it.each(["_WIN32_WINNT=0x0A00", "EMBER_UV_FIXED_PROBE_OFFLINE=0"])("rejects per-unit sensitive overrides on pipe, process and ordinary units: %s", macro => {
  const extra = definitions(macro);
  refused(project("uv_a", { units: selectedUnit("PIPE", extra) + selectedUnit("PROCESS") + otherUnit() }), "uv_a", { constraint: constraints.unitMacro, unit: 1 });
  refused(project("uv_a", { units: selectedUnit("PIPE") + selectedUnit("PROCESS", extra) + otherUnit() }), "uv_a", { constraint: constraints.unitMacro, unit: 2 });
  refused(project("uv_a", { units: selectedUnit("PIPE") + selectedUnit("PROCESS") + otherUnit(extra) }), "uv_a", { constraint: constraints.unitMacro, unit: 3 });
});

it("preserves exact selected-unit flags and Release forced includes", () => {
  for (const kind of ["PIPE", "PROCESS"] as const) {
    const original = selectedUnit(kind), unit = kind === "PIPE" ? 1 : 2;
    for (const changed of [original.replace(`EMBER_UV_SPAWN_OBSERVE_${kind}=1`, "MISSING=1"), original.replace("windows-uv-spawn-observe.h", "foreign.h"),
      original.replace(`EMBER_UV_SPAWN_OBSERVE_${kind}=1`, `EMBER_UV_SPAWN_OBSERVE_${kind === "PIPE" ? "PROCESS" : "PIPE"}=1`),
      original.replaceAll(condition, "'$(Configuration)|$(Platform)'=='Debug|x64'")]) {
      refused(project().replace(original, changed), "uv_a", { constraint: constraints.selectedUnit, unit });
    }
  }
});

it("refuses observation flags or includes on other units and the root probe", () => {
  for (const extra of [definitions("EMBER_UV_SPAWN_OBSERVE_PIPE=1"), "<ForcedIncludeFiles>D:/public-recipe/windows-uv-spawn-observe.h</ForcedIncludeFiles>"]) {
    refused(project("uv_a", { units: selectedUnit("PIPE") + selectedUnit("PROCESS") + otherUnit(extra) }), "uv_a", { constraint: constraints.unexpectedUnit, unit: 3 });
    refused(project("ember_uv_spawn_probe", { units: probeUnits.replace('/>', `>${extra}</ClCompile>`) }), "ember_uv_spawn_probe", { target: 2, constraint: constraints.unexpectedUnit, unit: 3 });
  }
});

it("requires both distinct selected units, refuses extras, and saturates diagnostic counts", () => {
  for (const units of [selectedUnit("PIPE") + otherUnit(), selectedUnit("PIPE") + selectedUnit("PIPE"), selectedUnit("PIPE") + selectedUnit("PROCESS") + selectedUnit("PIPE")]) {
    refused(project("uv_a", { units }), "uv_a", { constraint: constraints.unitCounts });
  }
  refused(project("ember_uv_spawn_probe", { units: '<ClCompile Include="D:/public-recipe/windows-uv-spawn-probe.c"/>' }), "ember_uv_spawn_probe", { constraint: constraints.unitCounts });
  refused(project("uv_a", { cl: cl().repeat(20) }), "uv_a", { constraint: constraints.clBlock, count: 17 });
});

it("records the actual first constraint and only closed numeric facts", () => {
  refused(project("uv_a", { cl: cl(clValues.replace("0x0602", "0x0A00")), rc: "" }), "uv_a", { constraint: constraints.rcBlock });
  refused(project("uv_a", { cl: cl(clValues.replace("0x0602", "0x0A00")), rc: rc().replace(definitions(rcValues), "") }), "uv_a", { constraint: constraints.rcDefinitions });
  const value = refused(project().replace("<Project ", "<!DOCTYPE private-owner-secret><Project "));
  expect(JSON.stringify(value.facts)).not.toMatch(/private|xml|path|message|stack|WIN32|compile|source/i);
});

it("does not accept structural forgeries, foreign proxies or error getters as diagnostic authority", () => {
  const owned = refused(project("uv_a", { cl: "" })), before = JSON.stringify(owned.facts);
  let reads = 0; const trap = () => { reads++; throw new Error("private getter"); };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap });
  const forged = Object.assign(new Error(fixedMessage), { projectDiagnostic: { ...owned.facts }, schema: 1, target: 1, constraint: 5, unit: 0, count: 0 });
  for (const value of [undefined, null, 7, "private", Symbol("private"), proxy, revoked.proxy, forged, { ...owned.facts }, JSON.parse(before)]) {
    expect(classifyWindowsUvSpawnProjectFailure(value)).toBeUndefined();
  }
  Object.defineProperties(owned.error, { message: { get: trap }, stack: { get: trap }, projectDiagnostic: { get: trap }, toJSON: { get: trap } });
  expect(classifyWindowsUvSpawnProjectFailure(owned.error)).toBe(owned.facts); expect(JSON.stringify(classifyWindowsUvSpawnProjectFailure(owned.error))).toBe(before); expect(reads).toBe(0);
});

it("snapshots the actual first owned project refusal only at Phase11 and keeps other phases unchanged", () => {
  const first = refused(project("uv_a", { cl: "" })), later = refused(project("ember_uv_spawn_probe", { rc: "" }), "ember_uv_spawn_probe");
  const diagnostic = createUvSpawnBuildDiagnostic(); diagnostic.checkpoint(11); const error = diagnostic.failure(first.error);
  const snapshot = diagnostic.classify(error), encoded = JSON.stringify(snapshot);
  expect(snapshot).toEqual({ schema: 1, status: "failed", checkpoint: 11, projectDiagnostic: first.facts }); expect(Object.isFrozen(snapshot.projectDiagnostic)).toBe(true);
  diagnostic.checkpoint(12); expect(diagnostic.failure(later.error)).toBe(error); expect(JSON.stringify(diagnostic.classify(error))).toBe(encoded);
  for (const checkpoint of [0, 9, 10, 12, 14, 20]) {
    const other = createUvSpawnBuildDiagnostic(); other.checkpoint(checkpoint);
    expect(other.classify(other.failure(first.error))).toEqual({ schema: 1, status: "failed", checkpoint });
  }
  let reads = 0; const trap = () => { reads++; throw new Error("private getter"); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  for (const foreign of [first.facts, { projectDiagnostic: first.facts }, Object.assign(new Error(fixedMessage), { projectDiagnostic: first.facts }), proxy]) {
    const other = createUvSpawnBuildDiagnostic(); other.checkpoint(11);
    expect(other.classify(other.failure(foreign))).toEqual({ schema: 1, status: "failed", checkpoint: 11 });
  }
  expect(reads).toBe(0);
});
