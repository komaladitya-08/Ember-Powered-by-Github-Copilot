import { expect, it } from "vitest";
import { abiUnitCommit, abiUnitHash, abiUnitReceipts } from "../fixtures/windows-uv-observer-abi-unit";
// @ts-expect-error -- portable trusted-build schema/readback; no build or execution invoked
import { parseWindowsUvObserverAbiBuildReceipt as parse, windowsUvObserverAbiRecipe, windowsUvObserverAbiBaseRecipeSha256, windowsUvObserverAbiProjectWitness as project, buildWindowsUvObserverAbi, classifyWindowsUvObserverAbiBuildFailure, abiPin } from "../../scripts/experimental/build-windows-uv-observer-abi.mjs";

it("binds a separate issuer to the unchanged producer recipe and identical observer-object identity", () => {
  const data = abiUnitReceipts(), value = parse(data.receiptBytes, data.sourceBytes, abiUnitCommit);
  expect(value.issuer).toBe("ember-experimental-windows-uv-observer-abi-control"); expect(value.observerObject).toEqual(data.source.build.observerObject);
  expect(windowsUvObserverAbiBaseRecipeSha256()).toBe(abiPin.baseRecipeSha256); expect(value.baseRecipeSha256).toBe(abiPin.baseRecipeSha256);
  const files = windowsUvObserverAbiRecipe().map((item: { file: string }) => item.file);
  expect(files).toContain("test/fixtures/windows-uv-observer-abi-control.c"); expect(files).toContain("test/fixtures/windows-uv-observer-abi-build/CMakeLists.txt");
  expect(files.join(" ")).not.toMatch(/shim|\.test\.ts|run-windows|abi-report\.mjs/);
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.observerObject)).toBe(true);
});

it.each(["issuer", "commit", "baseRecipeSha256", "observerObject", "recipe", "tools", "project", "sourceReceipt", "assets"])("refuses altered control authority or provenance field %s", key => {
  const data = abiUnitReceipts(), changed = { ...data.receipt, [key]: "foreign" };
  expect(() => parse(Buffer.from(JSON.stringify(changed)), data.sourceBytes, abiUnitCommit)).toThrow("fixed observer ABI build contract was refused");
});

it("rejects a rebound source receipt with changed recipe/source or contradictory outer tool witnesses", () => {
  for (const mutate of [
    (data: ReturnType<typeof abiUnitReceipts>) => { data.source.recipe[0].sha256 = "f".repeat(64); },
    (data: ReturnType<typeof abiUnitReceipts>) => { data.source.tools.compiler.sha256 = "f".repeat(64); },
    (data: ReturnType<typeof abiUnitReceipts>) => { data.source.source.workingManifestSha256 = "f".repeat(64); },
    (data: ReturnType<typeof abiUnitReceipts>) => { data.source.commit = "f".repeat(40); },
  ]) {
    const data = abiUnitReceipts(); data.receipt.tools = JSON.parse(JSON.stringify(data.source.tools)); mutate(data); const source = Buffer.from(JSON.stringify(data.source));
    data.receipt.sourceReceipt.bytes = source.length; data.receipt.sourceReceipt.sha256 = abiUnitHash(source);
    expect(() => parse(Buffer.from(JSON.stringify(data.receipt)), source, abiUnitCommit)).toThrow("fixed observer ABI build contract was refused");
  }
});

it("requires exact source receipt bytes and observer hash, positive import proof and bounded assets", () => {
  for (const mutate of [
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.observerObject.sha256 = "f".repeat(64); },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.assets.control.forbiddenImports = 1; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.assets.control.ordinalImports = 1; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.assets.control.delayImports = 1; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.assets.control.namedImports = 0; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.assets.control.name = "foreign.exe"; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.sourceReceipt.name = "foreign.json"; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.project.externalObjects = 2; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.project.runtimeLibrary = "MultiThreadedDLL"; },
    (d: ReturnType<typeof abiUnitReceipts>) => { d.receipt.project.targetMacro = "0x0A00"; },
  ]) { const data = abiUnitReceipts(); mutate(data); expect(() => parse(Buffer.from(JSON.stringify(data.receipt)), data.sourceBytes, abiUnitCommit)).toThrow(); }
  const data = abiUnitReceipts(); expect(() => parse(data.receiptBytes, Buffer.concat([data.sourceBytes, Buffer.from(" ")]), abiUnitCommit)).toThrow();
  expect(() => parse(data.receiptBytes, data.sourceBytes, "foreign")).toThrow();
  for (const value of [Buffer.alloc(0), Buffer.alloc(abiPin.maximumReceiptBytes + 1), Buffer.from([0xff]), Buffer.from("private")]) expect(() => parse(value, data.sourceBytes, abiUnitCommit)).toThrow();
});

const control = "D:\\repo\\windows-uv-observer-abi-control.c", observer = "D:\\build\\windows-uv-spawn-observe.obj";
function xml() {
  const definitions = "WIN32;_WIN32_WINNT=0x0602;EMBER_UV_FIXED_PROBE_OFFLINE=1;%(PreprocessorDefinitions)";
  return `<Project><PropertyGroup><PlatformToolset>v143</PlatformToolset><WindowsTargetPlatformVersion>10.0.26100.0</WindowsTargetPlatformVersion></PropertyGroup><ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'"><ClCompile><PreprocessorDefinitions>${definitions}</PreprocessorDefinitions><RuntimeLibrary>MultiThreaded</RuntimeLibrary></ClCompile><ResourceCompile><PreprocessorDefinitions>${definitions}</PreprocessorDefinitions></ResourceCompile><Midl><HeaderFileName>fixed.h</HeaderFileName></Midl></ItemDefinitionGroup><ItemGroup><ClCompile Include="${control}"/><Object Include="${observer}"/></ItemGroup></Project>`;
}
it("requires only the control source and exactly the external original object with fixed compiler scopes", () => {
  expect(project(Buffer.from(xml()), control, observer)).toMatchObject({ targetMacro: "0x0602", runtimeLibrary: "MultiThreaded", externalObjects: 1 });
  for (const value of [
    xml().replace("_WIN32_WINNT=0x0602", "_WIN32_WINNT=0x0A00"), xml().replace("MultiThreaded", "MultiThreadedDLL"),
    xml().replace("<ResourceCompile>", "<ResourceCompile><Wrapper>"), xml().replace("<RuntimeLibrary>", "<RuntimeLibrary Condition=\"private\">"),
    xml().replace("<RuntimeLibrary>", "<AdditionalOptions>/U_WIN32_WINNT</AdditionalOptions><RuntimeLibrary>"),
    xml().replace("<Midl>", "<Midl><PreprocessorDefinitions>EMBER_UV_FIXED_PROBE_OFFLINE=0</PreprocessorDefinitions>"),
    xml().replace(`<Object Include="${observer}"/>`, `<ClCompile Include="D:\\source\\windows-uv-spawn-observe.c"/>`),
    xml().replace(`<Object Include="${observer}"/>`, `<Object Include="D:\\foreign.obj"/>`),
    xml().replace(`<ClCompile Include="${control}"/>`, `<ClCompile Include="${control}"><AdditionalOptions>/GS-</AdditionalOptions></ClCompile>`),
    xml().replace("<Project>", "<!DOCTYPE Project><Project>"),
  ]) expect(() => project(Buffer.from(value), control, observer)).toThrow("fixed observer ABI build contract was refused");
});

it("refuses unsupported hosts before executing build tools and keeps foreign errors opaque", async () => {
  if (process.platform === "win32") return;
  let error: unknown;
  try { await buildWindowsUvObserverAbi({ archivePath: "C:\\source.xz", destination: "D:\\fresh", pythonPath: "C:\\python.exe" }); } catch (caught) { error = caught; }
  expect(classifyWindowsUvObserverAbiBuildFailure(error)).toEqual({ schema: 1, status: "failed", stage: 1 });
  let reads = 0; const foreign = new Proxy({}, { get() { reads++; throw new Error("private"); } });
  expect(classifyWindowsUvObserverAbiBuildFailure(foreign)).toEqual({ schema: 1, status: "failed", stage: 0 }); expect(reads).toBe(0);
});
