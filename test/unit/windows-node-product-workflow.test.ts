/** Execute the workflow's actual fail-closed scripts without downloading or running a Windows binary. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { runInNewContext, Script } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS } from "../fixtures/windows-node-asset-enforcement-run";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const product = read(".github/workflows/windows-node-product.yml"), ci = read(".github/workflows/ci.yml");
const diagnostic = read(".github/workflows/coding-boundary.yml");
function script(name: string, workflow = product): string {
  const marker = "      - name: " + name + "\n", start = workflow.indexOf(marker);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const after = workflow.slice(start + marker.length), end = after.search(/\n(?: {6}-| {2}[a-z][\w-]*:)/);
  const step = end < 0 ? after : after.slice(0, end), run = step.indexOf("        run: |\n");
  expect(run, name).toBeGreaterThanOrEqual(0);
  return step.slice(run + "        run: |\n".length).split("\n").filter(line => line.length > 0).map(line => {
    expect(line.startsWith("          "), name).toBe(true); return line.slice(10);
  }).join("\n");
}
const aggregate = script("Require all configured Windows product matrix leaves");
const proof = script("Require the actual native, source Home or packaged Home proof without skipped cases");
const producer = script("Require the reviewed POSIX producer and authenticate its exact archive");
const binding = script("Bind all product journeys to the reviewed native source catalog");
const extraction = script("Extract only the authenticated producer members");
const staging = script("Stage the exact development Electron resources and build the actual app");
const cases = {
  native: "test/integration/windows-node-product-native.test.ts",
  source: "test/integration/project-coding-windows-node-electron.test.ts",
  packaged: "test/integration/windows-node-packaged-product.test.ts",
} as const;

it("executes the extraction step's actual inline Node command with an absolute controlled producer directory", () => {
  const matched = extraction.match(/node --input-type=module -e '([^']+)'/); expect(matched).not.toBeNull();
  const verify = vi.fn((directory: string, kind: string) => {
    if (!path.isAbsolute(directory)) throw new Error("The strict producer verifier requires an absolute directory.");
    expect(directory).toBe(path.resolve(".cache/windows-node-toolchain")); expect(kind).toBe("producer");
  });
  expect(() => verify(".cache/windows-node-toolchain", "producer")).toThrow("requires an absolute directory"); verify.mockClear();
  const compiled = transformSync(matched![1], { loader: "js", format: "cjs", target: "node22" }).code;
  runInNewContext(compiled, { require: (name: string) => {
    if (name === "node:path") return path;
    if (name === "./scripts/package/windows-node-toolchain.mjs") return { verifyWindowsNodeToolchain: verify };
    throw new Error("The extraction command requested an unsupported import.");
  } });
  expect(verify).toHaveBeenCalledExactlyOnceWith(path.resolve(".cache/windows-node-toolchain"), "producer");
});

// Model only this fixed PowerShell command/check sequence; execute no actual installer, download or build.
function stagingCommands(invoke: (program: string, args: string[]) => number) {
  const lines = staging.split("\n"); expect(lines.shift()).toBe('$ErrorActionPreference = "Stop"');
  for (let index = 0; index < lines.length; index += 2) {
    const command = /^(node|npm) ([A-Za-z0-9_./ -]+)$/.exec(lines[index]);
    const check = /^if \(\$LASTEXITCODE -ne 0\) \{ throw "([A-Za-z .]+)" \}$/.exec(lines[index + 1]);
    expect(command).not.toBeNull(); expect(check).not.toBeNull();
    if (invoke(command![1], command![2].split(" ")) !== 0) throw new Error(check![1]);
  }
}
it("installs the pinned Electron package explicitly before strict staging and build for every journey", () => {
  expect(staging.split("\n")).toEqual([
    '$ErrorActionPreference = "Stop"', "node node_modules/electron/install.js",
    'if ($LASTEXITCODE -ne 0) { throw "The pinned development Electron installation failed." }',
    "node scripts/package/windows-node-toolchain-dev.mjs",
    'if ($LASTEXITCODE -ne 0) { throw "The development Electron toolchain could not be verified." }',
    "npm run build", 'if ($LASTEXITCODE -ne 0) { throw "The product build failed." }',
  ]);
  const invoke = vi.fn(() => 0); expect(() => stagingCommands(invoke)).not.toThrow();
  expect(invoke.mock.calls).toEqual([["node", ["node_modules/electron/install.js"]], ["node", ["scripts/package/windows-node-toolchain-dev.mjs"]], ["npm", ["run", "build"]]]);
  const marker = "      - name: Stage the exact development Electron resources and build the actual app\n", after = product.slice(product.indexOf(marker) + marker.length);
  expect(after.slice(0, after.indexOf("\n      - name:"))).not.toMatch(/\n {8}if:/);
  expect(JSON.parse(read("package.json")).devDependencies.electron).toBe("44.9.3");
  expect(product).toContain("journey: [native, source, packaged]");
});
it.each(["missing", "failed"] as const)("a genuinely %s model installer stops the actual checked sequence before stager or build", selected => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ember-installer-contract-")), calls: string[] = [];
  try {
    if (selected === "failed") {
      const directory = path.join(temporary, "node_modules", "electron"); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "install.js"), "process.exitCode = 7;\n", { flag: "wx" });
    }
    let status: number | null = null;
    expect(() => stagingCommands((program, args) => {
      calls.push(program + " " + args.join(" ")); expect(program).toBe("node"); expect(args).toEqual(["node_modules/electron/install.js"]);
      const result = spawnSync(process.execPath, args, { cwd: temporary, timeout: 1000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); status = result.status; return result.status!;
    })).toThrow("The pinned development Electron installation failed.");
    expect(status).toBe(selected === "missing" ? 1 : 7); expect(calls).toEqual(["node node_modules/electron/install.js"]);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
it.each([1, 2])("the checked sequence also stops at downstream command %i without bypassing its guard", failed => {
  const calls: string[] = [];
  expect(() => stagingCommands((program, args) => { calls.push(program + " " + args.join(" ")); return calls.length - 1 === failed ? 1 : 0; }))
    .toThrow(failed === 1 ? "The development Electron toolchain could not be verified." : "The product build failed.");
  expect(calls).toHaveLength(failed + 1);
});

it("requires the bounded C model once before all remaining units in each ordinary platform job", () => {
  const model = "test/unit/windows-node-asset-enforcement-c.test.ts";
  const steps = "      - name: Fixed C witness model and bounded compiler outcome\n" +
    `        run: npm test -- ${model} --maxWorkers=1\n` +
    "      - name: Remaining unit tests\n" + `        run: npm test -- --exclude ${model}\n`;
  for (const name of ["checks", "windows", "macos"]) {
    const start = ci.indexOf(`\n  ${name}:\n`); expect(start).toBeGreaterThan(0);
    const after = ci.slice(start + 1), end = after.search(/\n {2}[a-z][\w-]*:/);
    const job = end < 0 ? after : after.slice(0, end);
    expect(job).toContain(steps);
    expect(job.match(/run: npm test(?:\s|$)/g)).toHaveLength(2);
  }
});
type Journey = keyof typeof cases;
const caseCounts = { native: 2, source: 7, packaged: 1 } as const;
function passing(journey: Journey) {
  return { success: true, numTotalTests: Number(caseCounts[journey]), numPassedTests: Number(caseCounts[journey]), numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{ name: path.resolve(cases[journey]), status: "passed", assertionResults: Array.from({ length: caseCounts[journey] }, () => ({ status: "passed" })) }] };
}
function proofFixture(journey: Journey = "native", report: unknown = passing(journey), options: {
  missing?: boolean; status?: number | null; signal?: string | null; readFailure?: boolean; malformed?: boolean;
  attempt?: unknown; utilFailure?: boolean; globals?: Record<string, unknown>;
} = {}) {
  const outputs: string[] = [], queries: string[] = [], printed = vi.fn(), invoked = vi.fn(() => "attempt" in options ? options.attempt :
    { status: options.status === undefined ? 0 : options.status, signal: options.signal ?? null,
      stdout: Buffer.from("PRIVATE synthetic child output"), stderr: Buffer.from("PRIVATE synthetic child failure") });
  const info = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 };
  const io = { existsSync: (file: string) => { queries.push("exists"); return Object.values(cases).includes(file as typeof cases[Journey]) && !options.missing; },
    readFileSync: (file: string) => {
      queries.push("read");
      if (options.readFailure) throw new Error("PRIVATE synthetic file path");
      return file === "package.json" ? '{"version":"0.1.1"}' : options.malformed ? "{PRIVATE invalid report" : JSON.stringify(report);
    },
    lstatSync: () => { queries.push("lstat"); return info; }, appendFileSync: (_file: string, output: string) => { queries.push("append"); outputs.push(output); } };
  const env = { EMBER_WINDOWS_NODE_PRODUCT_IMAGE: "windows-2022", EMBER_WINDOWS_NODE_PRODUCT_JOURNEY: journey,
    EMBER_WINDOWS_NODE_PRODUCT_TEST: "1", EMBER_ELECTRON_WINDOWS_NODE_TEST: "1", EMBER_PACKAGED_WINDOWS_NODE_TEST: "1",
    RUNNER_TEMP: path.join(root, "synthetic-ci-temp"), GITHUB_OUTPUT: "synthetic-output", GITHUB_SHA: "1".repeat(40) };
  return { invoked, outputs, printed, queries, run: () => runInNewContext(proof, { Buffer, process: { env, execPath: "/host/node" }, console: { info: printed },
    require: (name: string) => {
      if (name === "node:fs") return io;
      if (name === "node:path") return path;
      if (name === "node:child_process") return { spawnSync: invoked };
      if (name === "node:util") { if (options.utilFailure) throw new Error("PRIVATE diagnostic import"); return { types }; }
      throw new Error("Unexpected workflow import");
    }, ...options.globals }) };
}

const sourceFrame = (sourceCase: number, phase: number) => `Error: Windows Node source journey refused (case ${sourceCase}, phase ${phase}).`;
const sourceAttempt = (stdout = "", stderr = "") => ({ status: 1, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
const sourceDiagnostic = (fixture: ReturnType<typeof proofFixture>) => {
  const rows = fixture.printed.mock.calls.filter(call => call[0] === "Windows Node source proof failure facts"); expect(rows).toHaveLength(1);
  return JSON.parse(rows[0][1] as string) as { child: number; timeout: number; phases: number[] };
};
it("observes only closed source phases while preserving the fatal child guard, invocation and absent report reads", () => {
  const attempt = sourceAttempt("PRIVATE prefix\n\x1b[31m" + sourceFrame(1, 4) + "\x1b[0m\r\n" + sourceFrame(2, 1), sourceFrame(1, 4) + "\n" + sourceFrame(7, 9));
  const f = proofFixture("source", passing("source"), { attempt });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified.");
  expect(sourceDiagnostic(f)).toEqual({ child: 2, timeout: 0, phases: [4, 1, 0, 0, 0, 0, 9] });
  expect(f.queries).toEqual(["exists", "exists"]); expect(f.invoked).toHaveBeenCalledTimes(1); expect(f.outputs).toEqual([]);
  const invocation = f.invoked.mock.calls[0] as unknown as [string, string[], object];
  expect(invocation[2]).toMatchObject({ timeout: 20 * 60_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
});
it("conflicting phases remain unknown even when a later duplicate agrees with an earlier frame", () => {
  const f = proofFixture("source", passing("source"), { attempt: sourceAttempt([sourceFrame(1, 4), sourceFrame(1, 5), sourceFrame(1, 4), sourceFrame(2, 1)].join("\n")) });
  expect(f.run).toThrow("could not be verified"); expect(sourceDiagnostic(f).phases).toEqual([0, 1, 0, 0, 0, 0, 0]);
});
it.each([11, 12, 13, 14, 15, 16, 17])("observes the approved existing-check source subphase %i without changing failure authority", phase => {
  const f = proofFixture("source", passing("source"), { attempt: sourceAttempt(sourceFrame(2, phase)) });
  expect(f.run).toThrow("could not be verified"); expect(sourceDiagnostic(f)).toEqual({ child: 2, timeout: 0, phases: [0, phase, 0, 0, 0, 0, 0] });
  expect(f.queries).toEqual(["exists", "exists"]);
});
it.each([sourceFrame(8, 1), sourceFrame(1, 0), sourceFrame(1, 18), "PRIVATE " + sourceFrame(1, 4), sourceFrame(1, 4) + " PRIVATE",
  "Windows Node source journey refused (case 1, phase 4).", "Error: another journey refused (case 1, phase 4)."])("ignores a foreign or malformed source frame %#", text => {
  const f = proofFixture("source", passing("source"), { attempt: sourceAttempt(text) });
  expect(f.run).toThrow("could not be verified"); expect(sourceDiagnostic(f).phases).toEqual([0, 0, 0, 0, 0, 0, 0]);
});
it.each(["string", "oversized", "invalid-utf8", "proxy", "length-getter", "byte-length-getter", "slice-getter", "output-getter"] as const)("refuses %s output without invoking hostile accessors or projecting raw bytes", selected => {
  let calls = 0; const bytes = Buffer.from(sourceFrame(1, 4)), attempt: Record<string, unknown> = sourceAttempt();
  if (selected === "string") attempt.stdout = sourceFrame(1, 4);
  if (selected === "oversized") attempt.stdout = Buffer.alloc(2 * 1024 * 1024 + 1);
  if (selected === "invalid-utf8") attempt.stdout = Buffer.concat([Buffer.from([255, 10]), bytes]);
  if (selected === "proxy") attempt.stdout = new Proxy(bytes, { get() { calls++; throw new Error("PRIVATE buffer getter"); }, getOwnPropertyDescriptor() { calls++; throw new Error("PRIVATE descriptor"); } });
  if (selected === "length-getter" || selected === "byte-length-getter" || selected === "slice-getter") {
    Object.defineProperty(bytes, selected === "length-getter" ? "length" : selected === "byte-length-getter" ? "byteLength" : "utf8Slice", { get() { calls++; throw new Error("PRIVATE buffer accessor"); } }); attempt.stdout = bytes;
  }
  if (selected === "output-getter") Object.defineProperty(attempt, "stdout", { get() { calls++; throw new Error("PRIVATE output accessor"); } });
  const f = proofFixture("source", passing("source"), { attempt }); expect(f.run).toThrow("could not be verified");
  expect(sourceDiagnostic(f)).toEqual({ child: 2, timeout: 0, phases: [0, 0, 0, 0, 0, 0, 0] }); expect(calls).toBe(0);
});
it.each(["native", "cross-realm", "getter", "impostor", "proxy"] as const)("only a genuine %s timeout with own data is observed without reading message or accessors", selected => {
  let calls = 0; let error: object = selected === "cross-realm" ? runInNewContext('Object.assign(new Error("PRIVATE"), { code: "ETIMEDOUT" })') : Object.assign(new Error("PRIVATE"), { code: "ETIMEDOUT" });
  if (selected === "getter") Object.defineProperty(error, "code", { get() { calls++; throw new Error("PRIVATE code getter"); } });
  if (selected === "impostor") error = Object.create(Error.prototype, { code: { value: "ETIMEDOUT" } }) as object;
  if (selected === "proxy") error = new Proxy(error, { get() { calls++; throw new Error("PRIVATE error proxy"); }, getOwnPropertyDescriptor() { calls++; throw new Error("PRIVATE descriptor"); } });
  else Object.defineProperty(error, "message", { get() { calls++; throw new Error("PRIVATE message getter"); } });
  const f = proofFixture("source", passing("source"), { attempt: { ...sourceAttempt(), status: null, error } });
  expect(f.run).toThrow("could not be verified"); expect(sourceDiagnostic(f)).toEqual({ child: 3, timeout: selected === "native" || selected === "cross-realm" ? 1 : 0, phases: [0, 0, 0, 0, 0, 0, 0] }); expect(calls).toBe(0);
});
it("does not add getter or proxy traps to the original child guard", () => {
  let reads = 0, descriptors = 0;
  const attempt = new Proxy({}, { get() { reads++; throw new Error("PRIVATE original guard"); }, getOwnPropertyDescriptor() { descriptors++; throw new Error("PRIVATE diagnostic trap"); } });
  const f = proofFixture("source", passing("source"), { attempt }); expect(f.run).toThrow("could not be verified");
  expect(reads).toBe(1); expect(descriptors).toBe(0); expect(sourceDiagnostic(f)).toEqual({ child: 0, timeout: 0, phases: [0, 0, 0, 0, 0, 0, 0] });
});
it.each(["import", "print", "stringify"] as const)("a diagnostic %s fault leaves the same fixed fatal refusal and filesystem sequence", selected => {
  const f = proofFixture("source", passing("source"), { attempt: sourceAttempt(sourceFrame(1, 4)), utilFailure: selected === "import",
    globals: selected === "stringify" ? { JSON: { stringify() { throw new Error("PRIVATE diagnostic serialization"); } } } : undefined });
  if (selected === "print") f.printed.mockImplementation(() => { throw new Error("PRIVATE diagnostic output"); });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified."); expect(f.invoked).toHaveBeenCalledTimes(1); expect(f.queries).toEqual(["exists", "exists"]);
  if (selected === "import") expect(sourceDiagnostic(f)).toEqual({ child: 0, timeout: 0, phases: [0, 0, 0, 0, 0, 0, 0] });
});
it("unchanged successful source reporting accepts only its complete seven-case inventory and emits no failure observation", () => {
  const f = proofFixture("source", passing("source"), { attempt: { ...sourceAttempt(sourceFrame(1, 4)), status: 0, error: false } });
  expect(f.run).not.toThrow(); expect(f.printed).toHaveBeenCalledTimes(1); expect(f.printed.mock.calls[0][0]).toBe("Required Windows Node product proof passed");
});

const packagedFrame = (phase: number) => `Error: Windows Node packaged journey refused (phase ${phase}).`;
const packagedDiagnostic = (fixture: ReturnType<typeof proofFixture>) => {
  const rows = fixture.printed.mock.calls.filter(call => call[0] === "Windows Node packaged proof failure facts"); expect(rows).toHaveLength(1);
  return JSON.parse(rows[0][1] as string) as { child: number; timeout: number; phase: number };
};
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("observes only the bounded packaged phase %i in the unchanged fatal child path", phase => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt("PRIVATE prefix\n\x1b[31m" + packagedFrame(phase) + "\x1b[0m\r\n", packagedFrame(phase)) });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified.");
  expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase });
  expect(f.queries).toEqual(["exists", "read", "lstat", "exists"]); expect(f.invoked).toHaveBeenCalledTimes(1); expect(f.outputs).toEqual([]);
  expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
});
it("a conflicting packaged phase remains unknown after repeated earlier frames", () => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt([packagedFrame(4), packagedFrame(5), packagedFrame(4)].join("\n")) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 0 });
});
it.each([packagedFrame(0), packagedFrame(13), "PRIVATE " + packagedFrame(4), packagedFrame(4) + " PRIVATE", sourceFrame(1, 4),
  "Windows Node packaged journey refused (phase 4)."])("ignores foreign or malformed packaged frames %#", text => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(text) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 0 });
});
it.each(["getter", "proxy", "invalid-utf8", "oversized"] as const)("packaged observation reuses safe byte refusal for %s without extra reads", selected => {
  let calls = 0; const attempt: Record<string, unknown> = sourceAttempt(packagedFrame(4)), secret = () => { calls++; throw new Error("PRIVATE output"); };
  if (selected === "getter") Object.defineProperty(attempt, "stdout", { get: secret });
  if (selected === "proxy") attempt.stdout = new Proxy(Buffer.from(packagedFrame(4)), { get: secret, getOwnPropertyDescriptor: secret });
  if (selected === "invalid-utf8") attempt.stdout = Buffer.concat([Buffer.from([255, 10]), Buffer.from(packagedFrame(4))]);
  if (selected === "oversized") attempt.stdout = Buffer.alloc(2 * 1024 * 1024 + 1);
  const f = proofFixture("packaged", passing("packaged"), { attempt }); expect(f.run).toThrow("could not be verified");
  expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 0 }); expect(calls).toBe(0); expect(f.queries).toEqual(["exists", "read", "lstat", "exists"]);
});
it("packaged timeout facts and diagnostic output faults leave the original fatal guard and ZIP handoff intact", () => {
  const error = Object.assign(new Error("PRIVATE"), { code: "ETIMEDOUT" });
  const f = proofFixture("packaged", passing("packaged"), { attempt: { ...sourceAttempt(packagedFrame(6)), status: null, error } });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 3, timeout: 1, phase: 6 }); expect(f.outputs).toEqual([]);
  const failedProjection = proofFixture("packaged", passing("packaged"), { status: 1 });
  failedProjection.printed.mockImplementation(() => { throw new Error("PRIVATE projection"); });
  expect(failedProjection.run).toThrow("The required Windows Node product proof could not be verified."); expect(failedProjection.outputs).toEqual([]);
});
it("unchanged successful packaged inventory emits only its passing marker and one exact ZIP handoff", () => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: { ...sourceAttempt(packagedFrame(4)), status: 0 } });
  expect(f.run).not.toThrow(); expect(f.printed).toHaveBeenCalledTimes(1); expect(f.printed.mock.calls[0][0]).toBe("Required Windows Node product proof passed"); expect(f.outputs).toHaveLength(1);
});

// Exact public source bytes, copied into an ordinary private test tree. This checks source binding only, never a
// successful Windows proof, process, DLL, model, issuer or cleanup receipt.
function sourceFixture(selectedScript = Script) {
  const repository = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "product-source-binding-")));
  for (const pin of WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS) {
    const destination = path.join(repository, pin.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, pin.path), destination);
  }
  const relative = "test/fixtures/windows-node-asset-enforcement-run.ts", verifier = path.join(repository, relative);
  fs.copyFileSync(path.join(root, relative), verifier);
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const env: Record<string, string> = { REVIEWED_ASSET_PROOF_COMMIT: "1".repeat(40), EMBER_WINDOWS_NODE_PRODUCT_IMAGE: "windows-2022",
    REVIEWED_ASSET_PROOF_MANIFEST: digest(JSON.stringify(WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS)), REVIEWED_ASSET_PROOF_VERIFIER: digest(fs.readFileSync(verifier)) };
  const transformed = vi.fn(transformSync);
  const requested = vi.fn((name: string) => { expect(name).toBe("esbuild"); return { transformSync: transformed }; });
  const anchored = vi.fn((file: string) => { expect(file).toBe(path.join(repository, "package.json")); return requested; });
  const readFs: typeof fs = Object.create(fs);
  return { repository, verifier, env, transformed, anchored, requested, readFs,
    run: () => runInNewContext(binding, { Buffer, process: { env, cwd: () => repository }, require: (name: string) => {
      if (name === "node:fs") return readFs;
      if (name === "node:path") return path;
      if (name === "node:crypto") return { createHash };
      if (name === "node:vm") return { Script: selectedScript };
      if (name === "node:module") return { createRequire: anchored };
      throw new Error("PRIVATE unsupported module");
    } }), close: () => fs.rmSync(repository, { recursive: true, force: false }) };
}

it("pins the first reviewed producer and successful two-image asset-proof tuple exactly", () => {
  const reviewed = runInNewContext("(" + producer.match(/const reviewed = Object\.freeze\(([\s\S]*?)\);/)![1] + ")");
  expect(reviewed).toEqual({ ready: true, run: 43991252195, commit: "b75c944dec58973d157542e2d4d2db3720667982", artifact: 14289217635, archiveBytes: 38425334,
    archiveSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
    manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f",
    assetProofCommit: "546793a3f94d89ae2ed2593727d9c35aa5571831",
    assetProofManifestSha256: "bcf191c0fba3518f5c67d043da1b2a3abf2fbbaec0c750a21940326e611abf43",
    verifierFileSha256: "a581968c3d8a354ccdabfb764d4dc89ac4e261e24e4bbf8c1ad70da4413f1c66" });
  expect(product).toContain("id: reviewed_input");
  expect(product).toContain("REVIEWED_ASSET_PROOF_COMMIT: ${{ steps.reviewed_input.outputs.proofCommit }}");
  expect(product).toContain("REVIEWED_ASSET_PROOF_MANIFEST: ${{ steps.reviewed_input.outputs.proofManifest }}");
  expect(product).toContain("REVIEWED_ASSET_PROOF_VERIFIER: ${{ steps.reviewed_input.outputs.proofVerifier }}");
  expect(product.indexOf("- run: npm ci")).toBeLessThan(product.indexOf("- name: Bind all product journeys"));
  expect(product.indexOf("- name: Bind all product journeys")).toBeLessThan(product.indexOf("- name: Stage the exact development"));
});

it.each(["windows-2022", "windows-2025"])("uses the genuine current source reader against every copied pin for %s", image => {
  const f = sourceFixture();
  try {
    f.env.EMBER_WINDOWS_NODE_PRODUCT_IMAGE = image;
    expect(WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS).toHaveLength(125);
    expect(f.run).not.toThrow(); expect(f.transformed).toHaveBeenCalledTimes(1);
    expect(f.anchored).toHaveBeenCalledExactlyOnceWith(path.join(f.repository, "package.json")); expect(f.requested).toHaveBeenCalledExactlyOnceWith("esbuild");
  } finally { f.close(); }
});

it("loads the repository transformer when the actual binding script lives outside the checkout", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "product-external-binding-")), external = path.join(temporary, "workflow.cjs");
  try {
    const relative = path.relative(root, temporary); expect(relative.startsWith(".." + path.sep) || path.isAbsolute(relative)).toBe(true);
    fs.writeFileSync(external, binding + '\nprocess.stdout.write("EXTERNAL_BINDING_OK");\n');
    const result = spawnSync(process.execPath, [external], { cwd: root, env: { ...process.env,
      REVIEWED_ASSET_PROOF_COMMIT: "1".repeat(40), EMBER_WINDOWS_NODE_PRODUCT_IMAGE: "windows-2022",
      REVIEWED_ASSET_PROOF_MANIFEST: createHash("sha256").update(JSON.stringify(WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS)).digest("hex"),
      REVIEWED_ASSET_PROOF_VERIFIER: createHash("sha256").update(fs.readFileSync(path.join(root, "test/fixtures/windows-node-asset-enforcement-run.ts"))).digest("hex"),
    }, encoding: "utf8", timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true });
    expect(result.status).toBe(0); expect(result.signal).toBeNull(); expect(result.stdout).toBe("EXTERNAL_BINDING_OK");
  } finally { fs.rmSync(temporary, { recursive: true, force: false }); }
});

it.each(["REVIEWED_ASSET_PROOF_COMMIT", "REVIEWED_ASSET_PROOF_MANIFEST", "REVIEWED_ASSET_PROOF_VERIFIER", "EMBER_WINDOWS_NODE_PRODUCT_IMAGE"])("rejects an absent trusted step output or unsupported image at %s before transformation", field => {
  const f = sourceFixture();
  try {
    f.env[field] = "";
    expect(f.run).toThrow("The Windows Node product checkout does not match the reviewed native source catalog.");
    expect(f.transformed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it.each([
  "app/main/agent/windows-node-toolchain-native.ts",
  "test/fixtures/windows-node-asset-enforcement-program.cjs",
  "app/main/agent/windows-command-creator-token.ts",
])("refuses changed pinned runtime, fixed CJS or helper bytes at %s", relative => {
  const f = sourceFixture();
  try {
    expect(WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS.some(pin => pin.path === relative)).toBe(true);
    fs.appendFileSync(path.join(f.repository, relative), "\n// PRIVATE changed bytes\n");
    expect(f.run).toThrow("The Windows Node product checkout does not match the reviewed native source catalog.");
    expect(f.transformed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it.each(["missing-pin", "truncated-pin", "foreign-catalog", "foreign-verifier", "tampered-verifier", "missing-verifier", "hardlink-verifier", "oversized-verifier"])("refuses %s without accepting a partial source match", mode => {
  const f = sourceFixture();
  try {
    const pin = path.join(f.repository, "app/main/agent/windows-command-copy.ts");
    if (mode === "missing-pin") fs.unlinkSync(pin);
    if (mode === "truncated-pin") fs.truncateSync(pin, 1);
    if (mode === "foreign-catalog") f.env.REVIEWED_ASSET_PROOF_MANIFEST = "f".repeat(64);
    if (mode === "foreign-verifier") f.env.REVIEWED_ASSET_PROOF_VERIFIER = "f".repeat(64);
    if (mode === "tampered-verifier") fs.appendFileSync(f.verifier, "\nthrow Error('PRIVATE unreviewed code');\n");
    if (mode === "missing-verifier") fs.unlinkSync(f.verifier);
    if (mode === "hardlink-verifier") fs.linkSync(f.verifier, path.join(f.repository, "verifier-alias"));
    if (mode === "oversized-verifier") fs.writeFileSync(f.verifier, Buffer.alloc(1024 * 1024 + 1));
    let failure: unknown; try { f.run(); } catch (error) { failure = error; }
    expect(String(failure)).toBe("Error: The Windows Node product checkout does not match the reviewed native source catalog.");
    expect(String((failure as Error).stack)).not.toContain("PRIVATE");
    if (mode.includes("verifier")) expect(f.transformed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it("checks verifier clock stability before compilation and gives the evaluated reader no child-process import", () => {
  const f = sourceFixture();
  try {
    let stats = 0;
    f.readFs.fstatSync = new Proxy(fs.fstatSync, { apply: (target, receiver, args) => {
      const result = Reflect.apply(target, receiver, args) as fs.BigIntStats;
      return ++stats === 2 ? new Proxy(result, { get: (value, key, owner) => key === "mtimeNs" ? value.mtimeNs + 1n : Reflect.get(value, key, owner) }) : result;
    } });
    expect(f.run).toThrow("The Windows Node product checkout does not match the reviewed native source catalog.");
    expect(f.transformed).not.toHaveBeenCalled();
    f.readFs.fstatSync = fs.fstatSync;
    fs.writeFileSync(f.verifier, 'import cp from "node:child_process"; cp.execFileSync("PRIVATE");');
    f.env.REVIEWED_ASSET_PROOF_VERIFIER = createHash("sha256").update(fs.readFileSync(f.verifier)).digest("hex");
    expect(f.run).toThrow("The Windows Node product checkout does not match the reviewed native source catalog.");
    expect(f.transformed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it("executes the exported source reader inside the same timed VM, not after initialization returns", () => {
  class ShortScript extends Script {
    override runInNewContext(context: Parameters<Script["runInNewContext"]>[0], options?: Parameters<Script["runInNewContext"]>[1]) {
      return super.runInNewContext(context, { ...options, timeout: 10 });
    }
  }
  const f = sourceFixture(ShortScript);
  try {
    // A bounded synthetic 100 ms workload makes the real VM's shorter test limit observable; it never loops forever.
    fs.writeFileSync(f.verifier, `export function verifyWindowsNodeAssetEnforcementRun(_root, input) {
      const until = Date.now() + 100; while (Date.now() < until) {}
      return { compileCommit: input.commit, sourceManifestSha256: ${JSON.stringify(f.env.REVIEWED_ASSET_PROOF_MANIFEST)} };
    }`);
    f.env.REVIEWED_ASSET_PROOF_VERIFIER = createHash("sha256").update(fs.readFileSync(f.verifier)).digest("hex");
    expect(f.run).toThrow("The Windows Node product checkout does not match the reviewed native source catalog.");
    expect(f.transformed).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it("requires the same-commit reusable product gate and releases only its tested Windows 2022 ZIP", () => {
  expect(ci).toMatch(/windows-node-product:\n[\s\S]*?uses: \.\/\.github\/workflows\/windows-node-product\.yml/);
  expect(product).toContain("  workflow_call:\n"); expect(product).toContain("  workflow_dispatch:\n");
  expect(product).toContain("image: [windows-2022, windows-2025]"); expect(product).toContain("journey: [native, source, packaged]");
  expect(product).toContain("fail-fast: false"); expect(product).not.toMatch(/github\.(?:head_ref|ref_name)|continue-on-error|passWithNoTests/);
  const release = ci.slice(ci.indexOf("\n  release:\n"));
  expect(release).toMatch(/needs: \[[^\n]*windows-node-product[^\n]*\]/);
  expect(release).toContain("name: ember-windows-node-product-windows-2022"); expect(release).not.toMatch(/name: ember-windows\s*\n/);
  expect(product).toContain("path: ${{ steps.proof.outputs.zip }}"); expect(product).toContain("if-no-files-found: error");
  expect(product).toContain("stage.mjs --with-models --with-runtimes --with-windows-node-toolchain");
});

it.each(["success", "failure", "cancelled", "skipped", "unknown"])("the actual aggregate accepts only a complete successful matrix, not %s", result => {
  const run = () => runInNewContext(aggregate, { process: { env: { REQUIRED_RESULTS: JSON.stringify({ product: { result } }) } } });
  if (result === "success") expect(run).not.toThrow(); else expect(run).toThrow("blocks the gate");
  expect(product).toMatch(/required:\n[\s\S]*?if: always\(\)\n\s+needs: \[product\]/);
});

it("does not accept an absent or unexpected required matrix result", () => {
  for (const results of [{}, { other: { result: "success" } }, { product: { result: "success" }, unexpected: { result: "success" } }]) {
    expect(() => runInNewContext(aggregate, { process: { env: { REQUIRED_RESULTS: JSON.stringify(results) } } })).toThrow("blocks the gate");
  }
});

it.each(Object.keys(cases) as Journey[])("runs the required actual %s entry point and accepts its complete passing report", journey => {
  const f = proofFixture(journey); expect(f.run).not.toThrow(); expect(f.invoked).toHaveBeenCalledTimes(1);
  const args = f.invoked.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
  expect(args[1]).toContain(cases[journey]); expect(args[1]).toContain("--reporter=json");
  expect(args[2].env.EMBER_WINDOWS_NODE_PRODUCT_TEST).toBe("1"); expect(args[2].env.EMBER_ELECTRON_WINDOWS_NODE_TEST).toBe("1");
  expect(args[2].env.EMBER_PACKAGED_WINDOWS_NODE_TEST).toBe("1");
  if (journey === "packaged") {
    expect(path.isAbsolute(args[2].env.EMBER_WINDOWS_NODE_PACKAGE)).toBe(true);
    expect(f.outputs).toEqual(["zip=" + args[2].env.EMBER_WINDOWS_NODE_PACKAGE + "\n"]);
  } else expect(f.outputs).toEqual([]);
});

it.each([
  { success: false }, { numTotalTests: 0, numPassedTests: 0, testResults: [] }, { numFailedTests: 1 },
  { numPendingTests: 1 }, { numTodoTests: 1 }, { numFailedTestSuites: 1 }, { numPendingTestSuites: 1 },
  { numTotalTests: 3, numPassedTests: 3 }, { testResults: [] },
  { testResults: [{ name: path.resolve(cases.native), status: "passed", assertionResults: [{ status: "skipped" }] }] },
  { testResults: [{ name: path.resolve(cases.native), status: "passed", assertionResults: [] }] },
  { testResults: [{ name: path.resolve("test/integration/windows-node-scoped-coding-worker.test.ts"), status: "passed", assertionResults: [{ status: "passed" }] }] },
])("refuses an incomplete, skipped, substituted or failing product report %j", change => {
  const f = proofFixture("native", { ...passing("native"), ...change });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified."); expect(f.outputs).toEqual([]);
});

it.each(Object.keys(cases) as Journey[])("rejects a passing subset or extra assertion in the fixed %s inventory", journey => {
  for (const count of [caseCounts[journey] - 1, caseCounts[journey] + 1]) {
    const report = passing(journey); report.numTotalTests = count; report.numPassedTests = count;
    report.testResults[0].assertionResults = Array.from({ length: count }, () => ({ status: "passed" }));
    const f = proofFixture(journey, report);
    expect(f.run).toThrow("The required Windows Node product proof could not be verified.");
    expect(f.outputs).toEqual([]);
  }
});

it("rejects a missing entry point, a failed runner and a cancelled runner before publishing any ZIP output", () => {
  for (const options of [{ missing: true }, { status: 1 }, { status: null, signal: "SIGTERM" }]) {
    const f = proofFixture("packaged", passing("packaged"), options);
    expect(f.run).toThrow("required Windows Node product proof"); expect(f.outputs).toEqual([]);
    if (options.missing) expect(f.invoked).not.toHaveBeenCalled();
  }
});

it("keeps pending producer review fail-closed and never accepts environment-selected old assets", () => {
  const spawn = vi.fn(() => ({ status: 1 })), manifest = read("app/shared/windows-node-toolchain.json");
  const reviewed = runInNewContext("(" + producer.match(/const reviewed = Object\.freeze\(([\s\S]*?)\);/)![1] + ")") as { ready: boolean; artifact: number };
  const run = () => runInNewContext(producer, { Buffer, console: { info: vi.fn() }, process: { env: {
    GITHUB_SHA: "1".repeat(40), RUNNER_TEMP: "synthetic-ci-temp", REVIEWED_WINDOWS_NODE_PRODUCER_READY: "1",
    EMBER_WINDOWS_NODE_ASSET_SOURCE: "old-producer", EMBER_WINDOWS_NODE_PRODUCER_ARTIFACT: "14224884648",
  } }, require: (name: string) => {
    if (name === "node:fs") return { readFileSync: () => Buffer.from(manifest) };
    if (name === "node:path") return path;
    if (name === "node:crypto") return { createHash: () => ({ update: () => ({ digest: () => "unreviewed" }) }) };
    if (name === "node:child_process") return { spawnSync: spawn, execFileSync: () => "1".repeat(40) };
    throw new Error("Unexpected workflow import");
  } });
  expect(run).toThrow(reviewed.ready ? "Windows Node product input could not be verified." : "blocked pending literal reviewed POSIX producer metadata");
  expect(spawn).not.toHaveBeenCalled(); expect(product).not.toContain("artifacts/14224884648/");
});

it("emits only the fixed reviewed proof outputs after exact checkout, manifest and archive authentication", () => {
  const archive = Buffer.from("Synthetic authenticated archive bytes; never a Windows image.");
  const manifest = Buffer.from(JSON.stringify({ producerRun: 1, producerCommit: "1".repeat(40), producerArtifact: 1,
    platform: "win32", arch: "x64", scope: "offline-root-only-node" }));
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const reviewed = { ready: true, run: 1, commit: "1".repeat(40), artifact: 1, archiveBytes: archive.length,
    archiveSha256: digest(archive), manifestSha256: digest(manifest), assetProofCommit: "3".repeat(40),
    assetProofManifestSha256: "4".repeat(64), verifierFileSha256: "5".repeat(64) };
  for (const mode of ["good", "archive", "manifest", "checkout"]) {
    const events: string[] = [], output = vi.fn((_name: string, data: string) => { events.push("proof"); return data; });
    const run = () => runInNewContext(producer, { Buffer, Object: { freeze: () => reviewed }, console: { info: vi.fn() },
      process: { env: { GITHUB_SHA: "2".repeat(40), RUNNER_TEMP: "synthetic-temp", GITHUB_OUTPUT: "synthetic-output",
        REVIEWED_ASSET_PROOF_COMMIT: "f".repeat(40), EMBER_WINDOWS_NODE_PRODUCER_ARTIFACT: "14224884648" } },
      require: (name: string) => {
        if (name === "node:fs") return { readFileSync: () => mode === "manifest" ? Buffer.from("foreign") : manifest,
          writeFileSync: (_file: string, bytes: Buffer, options: { flag: string }) => {
            expect(bytes.equals(archive)).toBe(true); expect(options.flag).toBe("wx"); events.push("archive");
          }, appendFileSync: output };
        if (name === "node:path") return path;
        if (name === "node:crypto") return { createHash };
        if (name === "node:child_process") return { execFileSync: () => (mode === "checkout" ? "f" : "2").repeat(40),
          spawnSync: () => ({ status: 0, signal: null, stdout: mode === "archive" ? Buffer.from("foreign") : archive }) };
        throw new Error("Unexpected workflow import");
      } });
    if (mode === "good") {
      expect(run).not.toThrow(); expect(events).toEqual(["archive", "proof"]);
      expect(output).toHaveBeenCalledWith("synthetic-output", `proofCommit=${reviewed.assetProofCommit}\nproofManifest=${reviewed.assetProofManifestSha256}\nproofVerifier=${reviewed.verifierFileSha256}\n`);
    } else { expect(run).toThrow("Windows Node product input could not be verified."); expect(events).toEqual([]); expect(output).not.toHaveBeenCalled(); }
  }
});

it.each(["child", "filesystem", "report-json"])("never forwards private %s diagnostics or raw parsing failures", kind => {
  const f = proofFixture("native", passing("native"), { status: kind === "child" ? 1 : 0, readFailure: kind === "filesystem", malformed: kind === "report-json" });
  let failure: unknown;
  try { f.run(); } catch (error) { failure = error; }
  expect(String(failure)).toBe("Error: The required Windows Node product proof could not be verified.");
  expect(String((failure as Error).stack)).not.toContain("PRIVATE"); expect(f.printed).not.toHaveBeenCalled(); expect(f.outputs).toEqual([]);
  const options = (f.invoked.mock.calls[0] as unknown as [string, string[], { stdio: string[]; maxBuffer: number }])[2];
  expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]); expect(options.maxBuffer).toBeGreaterThan(0); expect(options.maxBuffer).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it("sanitizes acquisition parsing failures with synthetic metadata separate from the reviewed literal", () => {
  const spawn = vi.fn();
  // Exercise the parsing body with synthetic metadata without acquiring an artifact or changing the reviewed tuple.
  const context = { Buffer, Object: { freeze: () => ({ ready: true, run: 1, commit: "1".repeat(40), artifact: 1,
    archiveBytes: 1, archiveSha256: "1".repeat(64), manifestSha256: "1".repeat(64), assetProofCommit: "1".repeat(40),
    assetProofManifestSha256: "1".repeat(64), verifierFileSha256: "1".repeat(64) }) },
    process: { env: { GITHUB_SHA: "1".repeat(40) } }, require: (name: string) => {
      if (name === "node:fs") return { readFileSync: () => { throw new Error("PRIVATE synthetic manifest path"); } };
      if (name === "node:path") return path;
      if (name === "node:crypto") return {};
      if (name === "node:child_process") return { spawnSync: spawn, execFileSync: () => "1".repeat(40) };
      throw new Error("Unexpected workflow import");
    } };
  let failure: unknown; try { runInNewContext(producer, context); } catch (error) { failure = error; }
  expect(String(failure)).toBe("Error: Windows Node product input could not be verified."); expect(String((failure as Error).stack)).not.toContain("PRIVATE");
  expect(spawn).not.toHaveBeenCalled();
});

it("retains the exact unsupported child and PowerShell invocations and assertions in their explicit diagnostic workflow", () => {
  for (const file of ["experimental-windows-lpac-native", "isolated-windows-command-powershell-native"]) {
    expect(ci).not.toContain("test/integration/" + file + ".test.ts");
    expect(diagnostic).toContain("run: node scripts/run-integration.mjs test/integration/" + file + ".test.ts");
  }
  expect(diagnostic).toContain("os: [windows-2022, windows-2025]"); expect(diagnostic).not.toContain("continue-on-error");
  expect(diagnostic).toContain("!cancelled()");
  const child = read("test/integration/experimental-windows-lpac-native.test.ts");
  expect(child).toContain("expect(observed[9]).toBeGreaterThan(0)");
  expect(child).toContain("await expect(fixture.waitStopped(100)).rejects.toThrow(/descendants|root process/)");
  expect(child).toContain("const lease = await fixture.stop()");
  expect(read("test/integration/isolated-windows-command-powershell-native.test.ts")).toContain("No ACL/capability/AppContainer fallback is permitted");
});

it("keeps the old files-only ZIP proof independent of Node acquisition without weakening the strict Node package or release gate", () => {
  const workflow = read(".github/workflows/experimental-windows-controller.yml"), legacy = workflow.slice(workflow.indexOf("\n  packaged-controller:\n"));
  expect(legacy).toContain("name: Windows files-only ZIP and packaged controller dependencies");
  const recipe = script("Build the explicit files-only regression ZIP with normal fuses", workflow);
  expect(recipe.split("\n")).toEqual(["set -euo pipefail", "npm run build", "node scripts/package/remote-parts.mjs",
    "node scripts/package/stage.mjs", "node scripts/package/archive.mjs"]);
  expect(legacy).not.toMatch(/run: npm run package:win|--with-windows-node-toolchain|continue-on-error|--allow-missing/);
  expect(legacy).toContain("test/integration/windows-packaged-coding-native.test.ts --maxWorkers=1");
  expect(legacy).toContain('EMBER_PACKAGED_WINDOWS_CODING_TEST: "1"'); expect(legacy).toContain("name: windows-file-only-zip-${{ matrix.image }}");
  const probe = read("test/integration/windows-packaged-coding-native.test.ts");
  expect(probe).toContain('const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding"]');
  expect(probe).toContain('checks: { ran: 0, passed: 0, failed: 0 }');
  expect(JSON.parse(read("package.json")).scripts["package:win"]).toContain("stage.mjs --with-windows-node-toolchain");
  expect(product).toContain("stage.mjs --with-models --with-runtimes --with-windows-node-toolchain");
  const release = ci.slice(ci.indexOf("\n  release:\n"));
  expect(release).toContain("name: ember-windows-node-product-windows-2022"); expect(release).not.toContain("name: windows-file-only-zip-");
});
