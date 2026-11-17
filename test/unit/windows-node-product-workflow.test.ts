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
const emptyObservation = () => ({ operation: 0, iteration: 0, welcomeStep: 0, nextLabel: 0, target: 0, bridgeError: 0, snapshotFlags: 0, focusFlags: 0, inputResult: 0, bridgeStage: 0, projectStage: 0, providerStage: 0, commandStage: 0, commandDecision: 0, repairStep: 0, repairResults: 0, focusIdentity: 0, cardFlags: 0, allowFlags: 0, denyFlags: 0, hintFlags: 0 });
type Observation = ReturnType<typeof emptyObservation>;
const packagedDiagnostic = (fixture: ReturnType<typeof proofFixture>) => {
  const rows = fixture.printed.mock.calls.filter(call => call[0] === "Windows Node packaged proof failure facts"); expect(rows).toHaveLength(1);
  return JSON.parse(rows[0][1] as string) as { child: number; timeout: number; phase: number; observation: Observation };
};
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("observes only the bounded packaged phase %i in the unchanged fatal child path", phase => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt("PRIVATE prefix\n\x1b[31m" + packagedFrame(phase) + "\x1b[0m\r\n", packagedFrame(phase)) });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified.");
  expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase, observation: emptyObservation() });
  expect(f.queries).toEqual(["exists", "read", "lstat", "exists"]); expect(f.invoked).toHaveBeenCalledTimes(1); expect(f.outputs).toEqual([]);
  expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
});
it.each(Array.from({ length: 16 }, (_, index) => index + 1))("observes existing project/folder stage %i only in the unchanged fatal packaged path", projectStage => {
  const o = observationHelper(); o.update({ projectStage }); o.capture();
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(packagedFrame(5) + "\n" + observationFrame(o.value())) });
  expect(f.run).toThrow("The required Windows Node product proof could not be verified.");
  expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 5, observation: { ...emptyObservation(), projectStage } });
  expect(f.invoked).toHaveBeenCalledTimes(1); expect(f.outputs).toEqual([]); expect(f.queries).toEqual(["exists", "read", "lstat", "exists"]);
});
it("a conflicting packaged phase remains unknown after repeated earlier frames", () => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt([packagedFrame(4), packagedFrame(5), packagedFrame(4)].join("\n")) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 0, observation: emptyObservation() });
});
it.each([packagedFrame(0), packagedFrame(13), "PRIVATE " + packagedFrame(4), packagedFrame(4) + " PRIVATE", sourceFrame(1, 4),
  "Windows Node packaged journey refused (phase 4)."])("ignores foreign or malformed packaged frames %#", text => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(text) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 0, observation: emptyObservation() });
});
it.each(["getter", "proxy", "invalid-utf8", "oversized"] as const)("packaged observation reuses safe byte refusal for %s without extra reads", selected => {
  let calls = 0; const attempt: Record<string, unknown> = sourceAttempt(packagedFrame(4)), secret = () => { calls++; throw new Error("PRIVATE output"); };
  if (selected === "getter") Object.defineProperty(attempt, "stdout", { get: secret });
  if (selected === "proxy") attempt.stdout = new Proxy(Buffer.from(packagedFrame(4)), { get: secret, getOwnPropertyDescriptor: secret });
  if (selected === "invalid-utf8") attempt.stdout = Buffer.concat([Buffer.from([255, 10]), Buffer.from(packagedFrame(4))]);
  if (selected === "oversized") attempt.stdout = Buffer.alloc(2 * 1024 * 1024 + 1);
  const f = proofFixture("packaged", passing("packaged"), { attempt }); expect(f.run).toThrow("could not be verified");
  expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 0, observation: emptyObservation() }); expect(calls).toBe(0); expect(f.queries).toEqual(["exists", "read", "lstat", "exists"]);
});
it("packaged timeout facts and diagnostic output faults leave the original fatal guard and ZIP handoff intact", () => {
  const error = Object.assign(new Error("PRIVATE"), { code: "ETIMEDOUT" });
  const f = proofFixture("packaged", passing("packaged"), { attempt: { ...sourceAttempt(packagedFrame(6)), status: null, error } });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 3, timeout: 1, phase: 6, observation: emptyObservation() }); expect(f.outputs).toEqual([]);
  const failedProjection = proofFixture("packaged", passing("packaged"), { status: 1 });
  failedProjection.printed.mockImplementation(() => { throw new Error("PRIVATE projection"); });
  expect(failedProjection.run).toThrow("The required Windows Node product proof could not be verified."); expect(failedProjection.outputs).toEqual([]);
});
it("unchanged successful packaged inventory emits only its passing marker and one exact ZIP handoff", () => {
  const f = proofFixture("packaged", passing("packaged"), { attempt: { ...sourceAttempt(packagedFrame(4)), status: 0 } });
  expect(f.run).not.toThrow(); expect(f.printed).toHaveBeenCalledTimes(1); expect(f.printed.mock.calls[0][0]).toBe("Required Windows Node product proof passed"); expect(f.outputs).toHaveLength(1);
});

interface ObservationHelper {
  update(value: unknown): void; answer(value: unknown): void; windows(value: unknown): void; node(value: unknown): void; step(value: unknown): void;
  readyError(error: unknown): void;
  focused(value: unknown, target: unknown, hwnd: number): void; fresh(value: unknown): void; input<T>(value: T, rejection?: boolean): T;
  decision(): void; card(value: unknown, previous: unknown): void; controls(value: unknown): void; capture(): void; value(): Readonly<Observation> | undefined;
}
function observationHelper(globals: Record<string, unknown> = {}): ObservationHelper {
  const source = read(cases.packaged), start = source.indexOf("function packagedObservation()"), end = source.indexOf("/** Keep the real OS profile", start);
  expect(start >= 0 && end > start).toBe(true);
  const code = transformSync(source.slice(start, end) + "\nmodule.exports = packagedObservation;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as () => ObservationHelper };
  runInNewContext(code, { module, types, ...globals }); return module.exports();
}
it.each([
  ["Windows Node packaged journey refused (phase 12).", 1],
  ['the bridge did not start: {"fatal":"PRIVATE","languageMode":"FullLanguage"}', 2],
  ['the bridge did not start: {"fatal":"PRIVATE","languageMode":"ConstrainedLanguage"}', 2],
  ['the bridge did not start: {"fatal":"PRIVATE","languageMode":"RestrictedLanguage"}', 2],
  ['the bridge did not start: {"fatal":"PRIVATE","languageMode":"NoLanguage"}', 2],
  ['the bridge did not start: {"fatal":"PRIVATE"}', 3],
  ["the bridge exited (0) before it was ready; stdout: PRIVATE; stderr: PRIVATE", 4],
  ["the bridge exited (1) before it was ready; stdout: PRIVATE; stderr: PRIVATE", 4],
  ["the bridge exited (-1) before it was ready; stdout: PRIVATE; stderr: PRIVATE", 4],
  ["the bridge exited (null) before it was ready; stdout: PRIVATE; stderr: PRIVATE", 4],
  ['the bridge did not start: {"exit":0}', 5],
  ['the bridge did not start: {"fatal":"PRIVATE","languageMode":"unrecognized"}', 5],
  ["the bridge did not start: {PRIVATE}", 0],
  ["PRIVATE unknown error", 0],
] as const)("operation2 classifies only the fixed ready failure boundary %#", (message, expected) => {
  const o = observationHelper(); o.update({ operation: 2 }); o.readyError(new Error(message)); o.capture();
  expect(o.value()).toEqual({ ...emptyObservation(), operation: 2, bridgeError: expected }); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("the first-JSON classifier respects the exact8192-character limit without retaining its text", () => {
  const prefix = "the bridge did not start: ", overhead = JSON.stringify({ fatal: "" }).length;
  for (const size of [8192, 8193]) {
    const body = JSON.stringify({ fatal: "X".repeat(size - overhead) }); expect(body.length).toBe(size);
    const o = observationHelper(); o.update({ operation: 2 }); o.readyError(new Error(prefix + body)); o.capture(); expect(o.value()?.bridgeError).toBe(size === 8192 ? 3 : 0);
  }
});
it.each(["getter", "proxy", "impostor", "string", "cross-realm"] as const)("ready classification handles %s without reading hostile error properties", kind => {
  let reads = 0; const message = "Windows Node packaged journey refused (phase 12).";
  let error: unknown = new Error(message);
  if (kind === "getter") Object.defineProperty(error, "message", { get() { reads++; throw new Error("PRIVATE accessor"); } });
  if (kind === "proxy") error = new Proxy(error as object, { get() { reads++; throw new Error("PRIVATE proxy"); }, getOwnPropertyDescriptor() { reads++; throw new Error("PRIVATE descriptor"); } });
  if (kind === "impostor") error = Object.create(Error.prototype, { message: { get() { reads++; throw new Error("PRIVATE impostor"); } } });
  if (kind === "string") error = message;
  if (kind === "cross-realm") error = runInNewContext('new Error("Windows Node packaged journey refused (phase 12).")');
  const o = observationHelper(); o.update({ operation: 2 }); o.readyError(error); o.capture(); expect(reads).toBe(0); expect(o.value()?.bridgeError).toBe(kind === "cross-realm" ? 1 : 0);
});
it.each(["proxy", "getter", "throws"] as const)("first-line JSON %s faults remain unknown without property effects", kind => {
  let reads = 0; const secret = () => { reads++; throw new Error("PRIVATE JSON getter"); };
  const value = kind === "proxy" ? new Proxy({}, { get: secret, getOwnPropertyDescriptor: secret }) : { get fatal() { return secret(); } };
  const o = observationHelper({ JSON: { parse() { if (kind === "throws") throw new Error("PRIVATE parser"); return value; } } });
  o.update({ operation: 2 }); o.readyError(new Error('the bridge did not start: {"fatal":"PRIVATE"}')); o.capture(); expect(o.value()?.bridgeError).toBe(0); expect(reads).toBe(0);
});
it("operations3/4 retain the original UIA fault codes after a startup classification", () => {
  const o = observationHelper(); o.update({ operation: 2 }); o.readyError(new Error("Windows Node packaged journey refused (phase 12)."));
  o.update({ operation: 4 }); o.answer({ error: { code: "gone" } }); o.capture(); expect(o.value()?.operation).toBe(4); expect(o.value()?.bridgeError).toBe(2);
});
it.each([false, true, "stage"] as const)("the actual ready catch preserves Promise,30000ms and original rejection with observer faults=%s", async faults => {
  const source = read(cases.packaged), start = source.indexOf("    this.observe({ operation: 2, bridgeError: 0 });"), end = source.indexOf("    await this.until(", start);
  const methods = source.slice(source.indexOf("  private observe(values:"), source.indexOf("  constructor(")); expect(start > 0 && end > start).toBe(true);
  const code = transformSync(`module.exports = class {
    constructor(observation, ready) { this.observation = observation; this.bridge = { ready, get startupStage() { return readStage(); } }; }
    ${methods}
    async run() { ${source.slice(start, end)} }
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as new (o: ObservationHelper, ready: Promise<object>) => { run(): Promise<void> } }, calls: unknown[][] = [];
  let stageReads = 0;
  runInNewContext(code, { module, readStage: () => { stageReads++; if (faults === "stage") throw new Error("PRIVATE stage fault"); return 9; },
    bounded: (promise: Promise<object>, ms: number) => { calls.push([promise, ms]); return promise; } });
  const original = new Error("Windows Node packaged journey refused (phase 12)."), o = observationHelper();
  const observer = faults === true ? new Proxy(o, { get() { throw new Error("PRIVATE observation fault"); } }) : o;
  const failed = Promise.reject(original); await expect(new module.exports(observer, failed).run()).rejects.toBe(original);
  expect(calls).toEqual([[failed, 30_000]]); if (faults !== true) expect(o.value()).toEqual({ ...emptyObservation(), operation: 2, bridgeError: 1, bridgeStage: faults === "stage" ? 0 : 9 });
  expect(stageReads).toBe(1);
  const success = observationHelper(), successfulObserver = faults === true ? new Proxy(success, { get() { throw new Error("PRIVATE observation fault"); } }) : success;
  const ready = Promise.resolve({ ready: true }); await expect(new module.exports(successfulObserver, ready).run()).resolves.toBeUndefined(); expect(calls[1]).toEqual([ready, 30_000]); expect(success.value()).toBeUndefined(); expect(stageReads).toBe(1);
});

it("opts in only the external UIA harness while leaving the packaged app environment and readiness limit unchanged", () => {
  const source = read(cases.packaged), environment = source.slice(source.indexOf("function environment("), source.indexOf("class Journey"));
  expect(environment).not.toContain("EMBER_UIA_STARTUP_OBSERVE");
  expect(source).toContain('new UiaBridge(script, bridgeEnv(this.env, { EMBER_UIA_CACHE: path.join(this.root, "bridge-cache"), EMBER_UIA_STARTUP_OBSERVE: "1" }))');
  expect(source).toContain('spawn(this.executable, ["--show-settings"], { cwd: path.dirname(this.executable), env: this.env, stdio: "ignore", windowsHide: false })');
  expect(source).toContain("try { await bounded(this.bridge.ready, 30_000); }");
});
const observationFrame = (value: unknown) => "Windows Node packaged cached observation " + JSON.stringify(value);
it.each([["w-next", 1], ["w-row-commands", 7], ["project-sessions-request", 8], ["project-sessions-send", 9], ["project-sessions-send PRIVATE", 0]] as const)("classifies only the fixed cached control ID %s as target%i", (automationId, expected) => {
  const o = observationHelper(); o.node({ automationId, name: "PRIVATE", value: "PRIVATE request", runtimeId: "PRIVATE identity" }); o.capture();
  expect(o.value()?.target).toBe(expected); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(packagedFrame(5) + "\n" + observationFrame(o.value())) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f).observation.target).toBe(expected); expect(f.outputs).toEqual([]);
});
it.each([
  [{}, 255], [{ runtimeId: "PRIVATE different runtime" }, 251], [{ pid: 43 }, 223],
  [{ automationId: "PRIVATE other control" }, 191], [{ controlType: "PRIVATE other type" }, 127],
  [{ runtimeId: undefined }, 249], [{ pid: 0 }, 207],
] as const)("splits cached focus identity components without weakening the original match or projecting values %#", (change, flags) => {
  const o = observationHelper(), target = { pid: 42, runtimeId: "PRIVATE runtime", automationId: "byok-conductor", controlType: "ComboBox", hasKeyboardFocus: true };
  o.focused({ hwnd: 99, element: { ...target, ...change } }, target, 99); o.capture();
  expect(o.value()?.focusIdentity).toBe(flags); expect(o.value()?.focusFlags).toBe(flags === 255 ? 15 : 11);
  expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("keeps absent metadata distinct from a failed original identity predicate", () => {
  const o = observationHelper(), target = { pid: 42, runtimeId: "PRIVATE runtime", controlType: "Edit", hasKeyboardFocus: true };
  o.focused({ hwnd: 99, element: target }, target, 99); o.capture();
  expect(o.value()?.focusFlags).toBe(15); expect(o.value()?.focusIdentity).toBe(191);
});
it("the passive decision count becomes permanently unknown after the existing eight-call bound", () => {
  const o = observationHelper();
  for (let count = 1; count <= 8; count++) { o.decision(); o.capture(); if (count === 1) expect(o.value()?.commandDecision).toBe(1); }
  // A fresh observer measures each late count: capture is deliberately one-shot.
  for (const count of [8, 9, 10, 20]) {
    const next = observationHelper(); for (let index = 0; index < count; index++) next.decision(); next.capture();
    expect(next.value()?.commandDecision).toBe(count === 8 ? 8 : 0);
  }
});
it.each([
  [[], "", 0], [[], "PRIVATE previous", 8], [[{ automationId: "ask-cmd" }], "", 1],
  [[{ automationId: "ask-cmd", runtimeId: "PRIVATE current" }], "", 7],
  [[{ automationId: "ask-cmd", runtimeId: "PRIVATE previous" }], "PRIVATE previous", 11],
  [[{ automationId: "ask-cmd", runtimeId: "PRIVATE current" }], "PRIVATE previous", 15],
] as const)("observes only existing command display-presence/freshness bits %#", (nodes, previous, expected) => {
  const o = observationHelper(); o.card(nodes, previous); o.capture(); expect(o.value()?.cardFlags).toBe(expected); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("new focus and display projections do not read proxy traps or cached-node accessors", () => {
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); }, o = observationHelper();
  const hostile = new Proxy([], { get: trap, getOwnPropertyDescriptor: trap });
  o.card(hostile, "PRIVATE previous"); o.focused(hostile, hostile, 99);
  const node = { automationId: "ask-cmd", get runtimeId() { return trap(); } };
  o.card([node], "PRIVATE previous"); o.focused({ element: node }, node, 99); o.capture();
  expect(reads).toBe(0); expect(o.value()?.cardFlags).toBe(9); expect(o.value()?.focusIdentity).toBe(64); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it.each([
  [{}, 1], [{ isEnabled: true }, 3], [{ isEnabled: false }, 5], [{ isOffscreen: false }, 9],
  [{ isEnabled: true, isOffscreen: false }, 11], [{ isEnabled: false, isOffscreen: false }, 13],
  [{ isEnabled: true, isOffscreen: true }, 19], [{ isEnabled: false, isOffscreen: true }, 21],
] as const)("projects only cached answer-control presence and known boolean states %#", (fields, expected) => {
  const o = observationHelper(); o.update({ commandStage: 13 });
  o.controls(["Allow", "Not now"].map(name => ({ controlType: "Button", name, ...fields, value: "PRIVATE", runtimeId: "PRIVATE" }))); o.capture();
  expect(o.value()).toMatchObject({ allowFlags: expected, denyFlags: expected, hintFlags: 0 }); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("classifies only the two exact known hint texts and actual Button answer names", () => {
  const o = observationHelper(); o.update({ commandStage: 13 });
  o.controls([{ controlType: "Text", name: "Read the whole command to allow it." }, { controlType: "Text", name: "Ember couldn't take that answer just now. Try again." },
    { controlType: "Edit", name: "Allow", isEnabled: true }, { controlType: "Button", name: "Allow PRIVATE", isEnabled: true }, { controlType: "Text", name: "PRIVATE" }]); o.capture();
  expect(o.value()).toMatchObject({ allowFlags: 0, denyFlags: 0, hintFlags: 3 }); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("stage13 control projection reads neither proxy traps nor accessor properties and ignores other stages", () => {
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); }, hostile = new Proxy([], { get: trap, getOwnPropertyDescriptor: trap });
  const o = observationHelper(); o.controls(hostile); o.update({ commandStage: 13 }); o.controls(hostile);
  o.controls([{ controlType: "Button", name: "Allow", get isEnabled() { return trap(); }, get isOffscreen() { return trap(); } }]);
  o.update({ commandStage: 14 }); o.controls([{ controlType: "Button", name: "Allow", isEnabled: true, isOffscreen: false }]); o.capture();
  expect(reads).toBe(0); expect(o.value()).toMatchObject({ allowFlags: 1, denyFlags: 0, hintFlags: 0 });
});
it("the full maximum numeric frame remains inside the unchanged 512-byte strict parser boundary", () => {
  const o = observationHelper(); o.update({ operation: 18, iteration: 12, welcomeStep: 6, nextLabel: 7, target: 9, bridgeError: 5, snapshotFlags: 15, focusFlags: 31, inputResult: 2, bridgeStage: 30, projectStage: 16,
    providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15, allowFlags: 31, denyFlags: 31, hintFlags: 3 }); o.capture();
  expect(Buffer.byteLength(JSON.stringify(o.value()))).toBeLessThanOrEqual(512);
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(packagedFrame(6) + "\n" + observationFrame(o.value())) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f).observation).toEqual(o.value()); expect(f.outputs).toEqual([]);
});
it.each(Object.entries({ target: 10, providerStage: 13, commandStage: 15, commandDecision: 9, repairStep: 5, repairResults: 5, focusIdentity: 256, cardFlags: 16, allowFlags: 32, denyFlags: 32, hintFlags: 4 }))("the strict workflow refuses an out-of-domain new %s field without accepting any partial frame", (field, invalid) => {
  const tuple = { ...emptyObservation(), [field]: invalid };
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(packagedFrame(6) + "\n" + observationFrame(tuple)) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f).observation).toEqual(emptyObservation()); expect(f.outputs).toEqual([]);
});

function diagnosticOperations(o: ObservationHelper, ports: Record<string, unknown>, readSettings: () => string) {
  const source = read(cases.packaged);
  const method = (begin: string, end: string) => {
    const first = source.indexOf(begin), last = source.indexOf(end, first); expect(first >= 0 && last > first).toBe(true); return source.slice(first, last);
  };
  const code = transformSync(`module.exports = class {
    phase = 0; home = 99; profile = "/PRIVATE/profile"; key = "PRIVATE key"; previousCard = ""; failureCaptured = false;
    constructor(observation, ports) { this.observation = observation; Object.assign(this, ports); }
    ${method("  private observe(values:", "  private observeInput")}
    ${method("  captureFailure():", "  failureObservation():")}
    ${method("  private async nodes(", "  private async node(")}
    ${method("  private async configureProvider():", "  private async folder(")}
    ${method("  async decide(", "  private async review(")}
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  interface Operations { phase: number; configureProvider(): Promise<void>; configureCommands(): Promise<void>; decide(argv: readonly string[]): Promise<void>; captureFailure(): void; nodes(hwnd: number): Promise<unknown[]> }
  const module = { exports: undefined as unknown as new (o: ObservationHelper, ports: Record<string, unknown>) => Operations };
  runInNewContext(code, { module, expect, path, fs: { readFileSync: readSettings }, refusal: (phase: number) => new Error("Existing snapshot refusal (phase " + phase + ")."),
    id: (automationId: string) => Object.assign((node: { automationId?: string }) => node.automationId === automationId, { label: automationId }),
    named: (name: string) => Object.assign((node: { name?: string }) => node.name === name, { label: name }) });
  return new module.exports(o, ports);
}
it.each([false, true])("the actual admitted snapshot is projected without extra requests or changed return values when controls observer faults=%s", async faults => {
  const plain = observationHelper(), o = faults ? new Proxy(plain, { get(target, key, receiver) { if (key === "controls") throw new Error("PRIVATE observer"); return Reflect.get(target, key, receiver); } }) : plain;
  const nodes = [{ controlType: "Button", name: "Allow", isEnabled: false, isOffscreen: false }], calls: unknown[][] = [];
  plain.update({ commandStage: 13 });
  const actual = diagnosticOperations(o, { current() { calls.push(["current"]); }, bridge: { async request(...args: unknown[]) { calls.push(args); return { result: { nodes, busy: false, truncated: false, cut: [] } }; } } }, () => "{}");
  expect(await actual.nodes(99)).toBe(nodes); plain.capture();
  expect(calls).toEqual([["current"], ["snapshot", { hwnd: 99, values: false, maxNodes: 2000, maxChildren: 500, deadlineMs: 3000 }, 5000]]);
  expect(plain.value()?.allowFlags).toBe(faults ? 0 : 13);
});
it.each(["busy", "truncated", "cut", "empty"])("an existing %s snapshot refusal never reaches the new control projector", async selected => {
  const o = observationHelper(), controls = vi.fn(o.controls), rows = [{ controlType: "Button", name: "Allow", isEnabled: true, isOffscreen: false }]; o.update({ commandStage: 13 });
  const result = { nodes: selected === "empty" ? [] : rows, busy: selected === "busy", truncated: selected === "truncated", cut: selected === "cut" ? ["PRIVATE"] : [] };
  const actual = diagnosticOperations({ ...o, controls }, { current() {}, bridge: { async request() { return { result }; } } }, () => "{}"); actual.phase = 6;
  if (selected === "busy") await expect(actual.nodes(99)).resolves.toEqual([]); else await expect(actual.nodes(99)).rejects.toThrow("Existing snapshot refusal (phase 6).");
  expect(controls).not.toHaveBeenCalled();
});
it.each(Array.from({ length: 12 }, (_, index) => index + 1))("marks existing provider operation %i before its unchanged controlled failure", async stage => {
  const o = observationHelper(), trace: string[] = [], failure = new Error("PRIVATE existing operation");
  const hit = (name: string) => { trace.push(name); if (trace.length === stage) throw failure; };
  const ports = { model: { baseUrl: "http://127.0.0.1/fixed" },
    async pane() { hit("pane"); }, async click() { hit("click"); }, async fill() { hit("fill"); }, async node() { hit("node"); }, async armed() { hit("armed"); }, async idle() { hit("idle"); } };
  const actual = diagnosticOperations(o, ports, () => { hit("settings"); return "{}"; });
  await expect(actual.configureProvider()).rejects.toBe(failure); actual.captureFailure();
  expect(actual.phase).toBe(4); expect(o.value()?.providerStage).toBe(stage);
  expect(trace).toEqual(["pane", "click", "fill", "fill", "fill", "fill", "click", "node", "armed", "click", "idle", "settings"].slice(0, stage));
});
it.each([false, true])("the actual provider, Commands setup and decision operations preserve every read/action with observer faults=%s", async faults => {
  const plain = observationHelper(), observedStages: number[] = [], o = faults ? new Proxy(plain, { get() { throw new Error("PRIVATE observer"); } }) : {
    ...plain, update(value: unknown) { const stage = (value as Partial<Observation>).commandStage; if (typeof stage === "number") observedStages.push(stage); plain.update(value); },
  };
  const trace: string[] = [], argv = ["--test", "test.cjs"]; let asked = false, decision = 0;
  const ports = { model: { baseUrl: "http://127.0.0.1/fixed" },
    async pane(value: string) { trace.push("pane:" + value); },
    async click(_window: number, selected: { label?: string }) { if (selected.label === "Ask me before every command on this computer") asked = true; trace.push("click"); },
    async fill() { trace.push("fill"); }, async armed() { trace.push("armed"); }, async idle() { trace.push("idle"); },
    async node(_window: number, selected: { label?: string }) { trace.push("node"); return { patterns: { toggle: selected.label === "Run commands on this computer" || asked ? "On" : "Off" }, isEnabled: true }; },
    async command() { trace.push("command"); decision++; return 99; },
    async nodes() { trace.push("snapshot"); return [{ automationId: "ask-cmd", runtimeId: "PRIVATE runtime " + decision }, { name: "\\work", controlType: "Text" }, { controlType: "TabItem", runtimeId: "PRIVATE tab " + decision }]; },
    async until(read: () => Promise<unknown>, accept: (value: unknown) => boolean, timeout: number) { expect(timeout).toBe(45_000); const value = await read(); expect(accept(value)).toBe(true); return value; },
    async focus() { trace.push("focus"); }, async text() { trace.push("text"); return "Node arguments: " + JSON.stringify(argv); },
  };
  const actual = diagnosticOperations(o, ports, () => { trace.push("settings"); return "{}"; });
  await actual.configureProvider(); await actual.configureCommands();
  for (let index = 0; index < 8; index++) await actual.decide(argv);
  expect(trace).toEqual(["pane:Models & connections", "click", "fill", "fill", "fill", "fill", "click", "node", "armed", "click", "idle", "settings", "pane:Commands", "node", "node", "click", "node",
    ...Array.from({ length: 8 }, () => ["command", "snapshot", "focus", "text", "snapshot", "snapshot", "click"]).flat()]);
  if (!faults) {
    plain.capture(); expect(plain.value()).toMatchObject({ providerStage: 12, commandStage: 14, commandDecision: 8, cardFlags: 15 });
    expect(observedStages).toEqual([1, 2, 3, 4, 5, ...Array.from({ length: 8 }, () => [6, 7, 8, 9, 10, 11, 12, 13, 14]).flat()]);
  }
});
it("the actual first-failure capture freezes only cached repair counts before later local model or cleanup changes", () => {
  const o = observationHelper(), steps = new Map([["repair", 3]]), results = new Map([["repair", ["PRIVATE result", "PRIVATE result", "PRIVATE result"]]]);
  o.update({ commandStage: 7 }); const actual = diagnosticOperations(o, { model: { steps, results } }, () => "{}");
  actual.captureFailure(); steps.set("repair", 4); results.get("repair")!.push("PRIVATE later"); o.update({ commandStage: 14 }); actual.captureFailure();
  expect(o.value()).toMatchObject({ commandStage: 7, repairStep: 3, repairResults: 3 }); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("a local cached-model count fault cannot suppress the first failure snapshot or retry it after cleanup", () => {
  const o = observationHelper(); o.update({ commandStage: 7 });
  const actual = diagnosticOperations(o, {}, () => "{}"); Object.defineProperty(actual, "model", { get() { throw new Error("PRIVATE model observation"); } });
  expect(() => actual.captureFailure()).not.toThrow(); o.update({ commandStage: 14 }); actual.captureFailure();
  expect(o.value()).toMatchObject({ commandStage: 7, repairStep: 0, repairResults: 0 });
});
it("the actual pure fixture helper freezes only bounded cached fields before cleanup, without retaining private node data", () => {
  const o = observationHelper(), node = { pid: 42, runtimeId: "PRIVATE runtime", automationId: "w-next", controlType: "Button", hasKeyboardFocus: true };
  o.update({ operation: 14, iteration: 2 }); o.answer({ error: { code: "busy", message: "PRIVATE error" }, result: { busy: true, truncated: true, cut: ["PRIVATE cut"], nodes: [] } });
  o.node({ ...node, name: "Agree and continue", value: "PRIVATE field" }); o.step("Step 2 of 6");
  o.focused({ hwnd: 99, element: node }, node, 99); o.fresh({ isOffscreen: false, bounds: { x: 100, y: 100, width: 36, height: 21 } });
  expect(o.input(false)).toBe(false); o.capture(); const first = o.value();
  expect(first).toEqual({ operation: 14, iteration: 2, welcomeStep: 2, nextLabel: 2, target: 1, bridgeError: 1, snapshotFlags: 15, focusFlags: 31, inputResult: 2, bridgeStage: 0, projectStage: 0, providerStage: 0, commandStage: 0, commandDecision: 0, repairStep: 0, repairResults: 0, focusIdentity: 255, cardFlags: 0, allowFlags: 0, denyFlags: 0, hintFlags: 0 });
  expect(Object.isFrozen(first)).toBe(true); expect(JSON.stringify(first)).not.toContain("PRIVATE");
  o.update({ operation: 0, iteration: 12 }); o.capture(); expect(o.value()).toBe(first);
});
it("observation helpers never invoke proxy traps, getters, value coercion or expose raw returned identities", () => {
  const o = observationHelper(); let traps = 0; const secret = () => { traps++; throw new Error("PRIVATE getter"); };
  const proxy = new Proxy({}, { get: secret, getOwnPropertyDescriptor: secret, getPrototypeOf: secret });
  o.update(proxy); o.answer(proxy); o.node(proxy); o.step(proxy); o.focused(proxy, proxy, 99); o.fresh(proxy); o.windows(proxy);
  const getter = { get automationId() { return secret(); }, get name() { return secret(); } }; o.node(getter);
  expect(o.input(proxy)).toBe(proxy); o.capture(); expect(traps).toBe(0); expect(JSON.stringify(o.value())).not.toContain("PRIVATE");
});
it("a snapshot storage fault cannot replace the first failure with later cleanup state", () => {
  let freezes = 0;
  const object = new Proxy(Object, { get(target, key, receiver) { if (key === "freeze") return () => { freezes++; throw new Error("PRIVATE snapshot fault"); }; return Reflect.get(target, key, receiver); } });
  const o = observationHelper({ Object: object }); o.update({ operation: 14 }); expect(() => o.capture()).not.toThrow();
  o.update({ operation: 15 }); o.capture(); expect(freezes).toBe(1); expect(o.value()).toBeUndefined();
});
function observedClick(o: ObservationHelper, input: Record<string, unknown>, trace: string[]) {
  const source = read(cases.packaged), methodsStart = source.indexOf("  private observe(values:"), methodsEnd = source.indexOf("  constructor(", methodsStart);
  const clickStart = source.indexOf("  private async click("), clickEnd = source.indexOf("  private async fill(", clickStart);
  expect(methodsStart >= 0 && methodsEnd > methodsStart && clickEnd > clickStart).toBe(true);
  const code = transformSync(`module.exports = class {
    constructor(observation, input, trace) { this.observation = observation; this.input = input; this.trace = trace; }
    async node() { this.trace.push("node"); return { bounds: { x: 10, y: 20, width: 36, height: 21 } }; }
    async focus(_hwnd, node) { this.trace.push("focus"); return node; }
    ${source.slice(methodsStart, methodsEnd)}
    ${source.slice(clickStart, clickEnd)}
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as new (o: ObservationHelper, input: Record<string, unknown>, trace: string[]) => { click(hwnd: number, selector: unknown): Promise<void>; captureFailure(): void } };
  runInNewContext(code, { module }); return new module.exports(o, input, trace);
}
it.each(["down", "up", "both", "observer"] as const)("actual fixture click preserves %s error identity, original action trace and first snapshot before finally", async kind => {
  const trace: string[] = [], first = new Error("PRIVATE first"), last = new Error("PRIVATE last"), actual = observationHelper();
  const observer = kind === "observer" ? new Proxy(actual, { get() { throw new Error("PRIVATE observer storage"); } }) : actual;
  const input = { move() { trace.push("move"); return true; }, button(_button: number, down: boolean) {
    trace.push(down ? "down" : "up"); if (down && kind !== "up") throw first; if (!down && (kind === "up" || kind === "both")) throw last; return true;
  }, releaseAll() { trace.push("release"); } };
  const clicked = observedClick(observer, input, trace).click(99, () => true).catch(error => { try { observer.capture(); } catch { /* The real outer boundary also contains observation faults. */ } throw error; });
  await expect(clicked).rejects.toBe(kind === "up" || kind === "both" ? last : first);
  expect(trace).toEqual(kind === "up" || kind === "both" ? ["node", "focus", "move", "down", "up"] : ["node", "focus", "move", "down", "up", "release"]);
  if (kind !== "observer") expect(actual.value()?.operation).toBe(kind === "up" ? 15 : 14);
});
it("actual fixture click keeps its successful call order and does not turn metadata into a grant", async () => {
  const trace: string[] = [], o = observationHelper(), input = { move() { trace.push("move"); return false; }, button(_which: number, down: boolean) { trace.push(down ? "down" : "up"); return true; }, releaseAll() { trace.push("release"); } };
  await expect(observedClick(o, input, trace).click(99, () => true)).resolves.toBeUndefined();
  expect(trace).toEqual(["node", "focus", "move", "down", "up", "release"]); expect(o.value()).toBeUndefined();
});
function welcomeNavigation(options: { blocked?: boolean; active?: number; loseForeground?: boolean; readError?: Error; keyError?: Error; enabled?: boolean; backwards?: boolean } = {}, snapshots: object[][] = []) {
  const source = read(cases.packaged), begin = source.indexOf("  private async revealHomeControl("), end = source.indexOf("  async start():", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const code = transformSync(`module.exports = class {
    constructor(state) {
      this.state = state; this.home = 99; this.phase = 3;
      this.input = { blockedReason: () => state.blocked, activate: () => state.trace.push("activate"), activeWindow: () => state.active,
        releaseAll: () => state.trace.push("release") };
    }
    current() { if (this.state.stale) throw refusal(3); }
    chord(modifier, key) { this.state.trace.push(modifier + "+" + key); if (this.state.keyError) throw this.state.keyError; }
    pressKey(key) { this.state.trace.push(key); if (this.state.keyError) throw this.state.keyError; }
    async nodes() { const s = this.state; s.trace.push("snapshot"); if (s.readError) throw s.readError; if (s.loseForeground) s.active = 100;
      return s.snapshots[s.reads++] ?? []; }
    async until(read, accepts) { for (let n = 0; n < 14; n++) { const value = await read(); if (accepts(value)) return value; } throw refusal(3); }
    ${source.slice(begin, end)}
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  const failure = new Error("PRIVATE navigation refusal"), state = { trace: [] as string[], active: 99, reads: 0, snapshots, stale: false, ...options };
  const module = { exports: undefined as unknown as new (state: object) => { revealHomeControl(select: (node: { automationId?: string }) => boolean, enabled: boolean, backwards: boolean): Promise<object> } };
  runInNewContext(code, { module, refusal: () => failure });
  return { run: () => new module.exports(state).revealHomeControl(node => node.automationId === "w-row-memory", options.enabled ?? false, options.backwards ?? false), state, failure };
}
it("actual consent navigation reveals only the exact onscreen row through bounded ordinary keys without clicking or toggling", async () => {
  const target = { automationId: "w-row-memory", isOffscreen: false, isEnabled: false };
  const f = welcomeNavigation({}, [[{ ...target, isOffscreen: true }], [{ automationId: "w-row-commands", isOffscreen: false }], [target]]);
  await expect(f.run()).resolves.toBe(target);
  expect(f.state.trace).toEqual(["activate", "snapshot", "Tab", "release", "snapshot", "Tab", "release", "snapshot"]);
});
it("consent command-row navigation retains the original enabled-control admission", async () => {
  const target = { automationId: "w-row-memory", isOffscreen: false, isEnabled: true };
  const f = welcomeNavigation({ enabled: true }, [[{ ...target, isEnabled: false }], [target]]);
  await expect(f.run()).resolves.toBe(target); expect(f.state.trace.filter(value => value === "Tab")).toHaveLength(1);
});
it.each(["blocked", "foreign-window", "lost-window"] as const)("consent scrolling refuses %s before another key can reach an unverified receiver", async kind => {
  const f = welcomeNavigation(kind === "blocked" ? { blocked: true } : kind === "foreign-window" ? { active: 100 } : { loseForeground: true });
  await expect(f.run()).rejects.toBe(f.failure);
  expect(f.state.trace).toEqual(kind === "blocked" ? [] : kind === "foreign-window" ? ["activate"] : ["activate", "snapshot"]);
});
it.each([false, true])("consent navigation stops after twelve keys in the selected direction backwards=%s", async backwards => {
  const f = welcomeNavigation({ backwards }); await expect(f.run()).rejects.toBe(f.failure);
  expect(f.state.reads).toBe(13); expect(f.state.trace.filter(value => value === (backwards ? "Shift_L+Tab" : "Tab"))).toHaveLength(12);
  expect(f.state.trace.at(-1)).toBe("snapshot");
});
it.each(["read", "key", "reverse-key"] as const)("consent navigation preserves the original %s error and releases held input", async kind => {
  const error = new Error("PRIVATE original"), f = welcomeNavigation(kind === "read" ? { readError: error } : { keyError: error, backwards: kind === "reverse-key" });
  await expect(f.run()).rejects.toBe(error);
  expect(f.state.trace).toEqual(kind === "read" ? ["activate", "snapshot"] : ["activate", "snapshot", kind === "reverse-key" ? "Shift_L+Tab" : "Tab", "release"]);
});
it("actual consent navigation reverses ordinary Tabs only for returning to the commands row", async () => {
  const target = { automationId: "w-row-memory", isOffscreen: false, isEnabled: true };
  const f = welcomeNavigation({ backwards: true }, [[], [target]]);
  await expect(f.run()).resolves.toBe(target);
  expect(f.state.trace).toEqual(["activate", "snapshot", "Shift_L+Tab", "release", "snapshot"]);
  expect(read(cases.packaged)).toContain('this.revealHomeControl(id("w-row-commands"), true, true)');
});
it.each([false, true])("actual project setup reveals Choose before its existing fresh click and propagates reveal failure=%s", async fails => {
  const source = read(cases.packaged), begin = source.indexOf("  async project("), end = source.indexOf("  async send(", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const code = transformSync(`module.exports = class {
    constructor(trace, failure) { this.trace = trace; this.failure = failure; this.home = 99; this.source = "PUBLIC source"; }
    observe() {}
    async pane(name) { this.trace.push("pane:" + name); }
    async fill(_hwnd, select) { this.trace.push("fill:" + identify(select)); }
    async click(_hwnd, select) { this.trace.push("click:" + identify(select)); }
    async revealHomeControl(select) { this.trace.push("reveal:" + identify(select)); if (this.failure) throw this.failure; }
    async folder() { this.trace.push("folder"); }
    async accessibleText() { this.trace.push("text"); }
    ${source.slice(begin, end)}
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as new (trace: string[], failure?: Error) => { project(name: string): Promise<void> } };
  const id = (value: string) => (node: { automationId?: string }) => node.automationId === value;
  const identify = (select: (node: { automationId?: string }) => boolean) => ["project-sessions-name", "project-sessions-add", "project-coding-choose"].find(automationId => select({ automationId }));
  runInNewContext(code, { module, id, identify }); const trace: string[] = [], failure = new Error("PRIVATE reveal refusal");
  const work = new module.exports(trace, fails ? failure : undefined).project("public fixture");
  if (fails) await expect(work).rejects.toBe(failure); else await expect(work).resolves.toBeUndefined();
  expect(trace).toEqual(["pane:Projects", "fill:project-sessions-name", "click:project-sessions-add", "reveal:project-coding-choose",
    ...(fails ? [] : ["click:project-coding-choose", "folder", "text", "text"])]);
});
it("a transient capture-accessor fault cannot cause outer cleanup to acquire a later first snapshot", async () => {
  const plain = observationHelper(), trace: string[] = [], failure = new Error("PRIVATE original"); let attempts = 0;
  const o = new Proxy(plain, { get(target, key, receiver) { if (key === "capture" && ++attempts === 1) throw new Error("PRIVATE observer fault"); return Reflect.get(target, key, receiver); } });
  const input = { move() { return true; }, button(_which: number, down: boolean) { if (down) throw failure; return true; }, releaseAll() { trace.push("release"); } };
  const probe = observedClick(o, input, trace);
  await expect(probe.click(99, () => true).catch(error => { probe.captureFailure(); throw error; })).rejects.toBe(failure);
  expect(attempts).toBe(1); expect(plain.value()).toBeUndefined(); expect(trace).toEqual(["node", "focus", "release"]);
});
it.each([false, true])("actual focus keeps its queries and fresh-guard short circuit with observer faults=%s", async faults => {
  const source = read(cases.packaged), begin = source.indexOf("  private async focus("), end = source.indexOf("  private pressKey(", begin);
  const methods = source.slice(source.indexOf("  private observe(values:"), source.indexOf("  constructor("));
  const identity = source.slice(source.indexOf("function sameNode("), source.indexOf("function subtree("));
  const code = transformSync(identity + `\nmodule.exports = class {
    constructor(observation, input, bridge, node, trace) { this.observation = observation; this.input = input; this.bridge = bridge; this.target = node; this.trace = trace; this.phase = 3; }
    async until(read, accepts) { const result = await read(); if (!accepts(result)) throw refusal(3); return result; }
    async nodes() { this.trace.push("snapshot"); return [this.target]; }
    ${methods} ${source.slice(begin, end)}
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  type FocusProbe = new (observation: ObservationHelper, input: object, bridge: object, node: object, trace: string[]) => { focus(hwnd: number, node: object): Promise<object> };
  const module = { exports: undefined as unknown as FocusProbe }, failure = new Error("PRIVATE original guard"); runInNewContext(code, { module, refusal: () => failure });
  for (const width of [36, 0]) {
    const trace: string[] = [], node = { pid: 42, runtimeId: "PRIVATE runtime", automationId: "w-next", controlType: "Button", hasKeyboardFocus: true, isOffscreen: false, bounds: { width, height: 21 } };
    const plain = observationHelper(), o = faults ? new Proxy(plain, { get() { throw new Error("PRIVATE observer"); } }) : plain;
    const input = { blockedReason() { trace.push("blocked"); }, activate() { trace.push("activate"); return false; }, activeWindow() { trace.push("foreground"); return 99; } };
    const bridge = { async call(operation: string) { trace.push(operation); return { hwnd: 99, element: node }; } };
    const result = new module.exports(o, input, bridge, node, trace).focus(99, node);
    if (width) await expect(result).resolves.toBe(node); else await expect(result).rejects.toBe(failure);
    expect(trace).toEqual(width ? ["blocked", "activate", "perform", "focused", "snapshot", "foreground"] : ["blocked", "activate", "perform", "focused", "snapshot"]);
  }
});
it("the actual outer failure catch captures before close and does not replace the snapshot with cleanup state", async () => {
  const source = read(cases.packaged), start = source.lastIndexOf("  } catch { try { fixture?.captureFailure();"), end = source.indexOf("  if (failed)", start);
  expect(start > 0 && end > start).toBe(true);
  const o = observationHelper(), trace: string[] = []; o.update({ operation: 7, welcomeStep: 2 });
  const fixture = { phase: 3, captureFailure() { trace.push("capture"); o.capture(); }, async close() { trace.push("close"); o.update({ operation: 0 }); return false; } };
  const code = transformSync(`module.exports = async function(fixture, model) { let failed = false, phase = 1, root;
    try { throw new Error("PRIVATE original"); ${source.slice(start, end)} return { failed, phase }; };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (fixture: object, model: object) => Promise<{ failed: boolean; phase: number }> }; runInNewContext(code, { module });
  expect(await module.exports(fixture, { async close() { trace.push("model"); } })).toEqual({ failed: true, phase: 3 });
  expect(trace).toEqual(["capture", "close", "model"]); expect(o.value()?.operation).toBe(7);
});
it.each(Object.entries({ operation: 18, iteration: 12, welcomeStep: 6, nextLabel: 7, target: 9, bridgeError: 5, snapshotFlags: 15, focusFlags: 31, inputResult: 2, bridgeStage: 30, projectStage: 16, providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15, allowFlags: 31, denyFlags: 31, hintFlags: 3 }))("the pure helper refuses out-of-domain %s metadata", (field, maximum) => {
  for (const invalid of [-1, maximum + 1, 0.5, Infinity, "PRIVATE"]) {
    const o = observationHelper(); o.update({ [field]: invalid }); o.capture(); expect(o.value()).toEqual(emptyObservation());
  }
});
it("the strict workflow projects one agreeing cached tuple while preserving phase and the original fatal guard", () => {
  const tuple = { operation: 7, iteration: 2, welcomeStep: 2, nextLabel: 2, target: 1, bridgeError: 0, snapshotFlags: 0, focusFlags: 15, inputResult: 1, bridgeStage: 30, projectStage: 16, providerStage: 12, commandStage: 14, commandDecision: 8, repairStep: 4, repairResults: 4, focusIdentity: 255, cardFlags: 15, allowFlags: 31, denyFlags: 31, hintFlags: 3 };
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(packagedFrame(3) + "\n" + observationFrame(tuple), observationFrame(tuple)) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f)).toEqual({ child: 2, timeout: 0, phase: 3, observation: tuple });
  expect(f.queries).toEqual(["exists", "read", "lstat", "exists"]); expect(f.outputs).toEqual([]);
});
it.each(["conflict", "missing", "extra", "array", "range", "fraction", "string", "json", "oversized"] as const)("cached %s output remains unknown without raw projection or success authority", selected => {
  const tuple = { ...emptyObservation(), operation: 7 }; let value: unknown = tuple;
  if (selected === "missing") { const { target: _target, ...rest } = tuple; value = rest; }
  if (selected === "extra") value = { ...tuple, private: "PRIVATE" };
  if (selected === "array") value = Object.values(tuple);
  if (selected === "range") value = { ...tuple, focusFlags: 32 };
  if (selected === "fraction") value = { ...tuple, operation: 0.5 };
  if (selected === "string") value = { ...tuple, target: "PRIVATE" };
  const line = selected === "json" ? "Windows Node packaged cached observation {PRIVATE}" : selected === "oversized" ? observationFrame({ private: "X".repeat(513) }) : observationFrame(value);
  const text = packagedFrame(3) + "\n" + line + (selected === "conflict" ? "\n" + observationFrame({ ...tuple, operation: 8 }) : "");
  const f = proofFixture("packaged", passing("packaged"), { attempt: sourceAttempt(text) });
  expect(f.run).toThrow("could not be verified"); expect(packagedDiagnostic(f).observation).toEqual(emptyObservation()); expect(JSON.stringify(f.printed.mock.calls)).not.toContain("PRIVATE");
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

it("binds the newly qualified expanded source graph before product admission", () => {
  const reviewed = runInNewContext("(" + producer.match(/const reviewed = Object\.freeze\(([\s\S]*?)\);/)![1] + ")");
  expect(reviewed).toEqual({ ready: true, run: 43991252195, commit: "b75c944dec58973d157542e2d4d2db3720667982", artifact: 14289217635, archiveBytes: 38425334,
    archiveSha256: "cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62",
    manifestSha256: "d6137e7afb434adfe04ce9454aa65e1891e6e4fdaffb248e6303a2fe14cfe89f",
    assetProofCommit: "aa5345a934d75d9a7924a4b7984c3b27c9521020",
    assetProofManifestSha256: "91f162e84a22f199606acee94131bcb605761d2796e57d9148c77311e09e8db6",
    verifierFileSha256: "9674e7b019cf736024b00593e0a73cfa4c8a30ed57f8135baf749b15b21e2a97" });
  expect(product).toContain("id: reviewed_input");
  expect(product).toContain("REVIEWED_ASSET_PROOF_COMMIT: ${{ steps.reviewed_input.outputs.proofCommit }}");
  expect(product).toContain("REVIEWED_ASSET_PROOF_MANIFEST: ${{ steps.reviewed_input.outputs.proofManifest }}");
  expect(product).toContain("REVIEWED_ASSET_PROOF_VERIFIER: ${{ steps.reviewed_input.outputs.proofVerifier }}");
  expect(product.indexOf("- run: npm ci")).toBeLessThan(product.indexOf("- name: Bind all product journeys"));
  expect(product.indexOf("- name: Bind all product journeys")).toBeLessThan(product.indexOf("- name: Stage the exact development"));
});

it.each([
  ["closed", "ready: true,", "ready: false,"],
  ["missing proof commit", 'assetProofCommit: "aa5345a934d75d9a7924a4b7984c3b27c9521020",', "assetProofCommit: null,"],
  ["missing source manifest", 'assetProofManifestSha256: "91f162e84a22f199606acee94131bcb605761d2796e57d9148c77311e09e8db6",', "assetProofManifestSha256: null,"],
  ["missing verifier", 'verifierFileSha256: "9674e7b019cf736024b00593e0a73cfa4c8a30ed57f8135baf749b15b21e2a97",', "verifierFileSha256: null,"],
] as const)("refuses %s proof before any producer acquisition or source read", (_kind, before, after) => {
  expect(producer.split(before)).toHaveLength(2);
  const closed = producer.replace(before, after), spawn = vi.fn(), exec = vi.fn(), readSource = vi.fn();
  expect(() => runInNewContext(closed, { process: { env: {} }, console: { info() {} }, require: (name: string) => {
    if (name === "node:fs") return { readFileSync: readSource };
    if (name === "node:path") return path;
    if (name === "node:crypto") return { createHash };
    if (name === "node:child_process") return { spawnSync: spawn, execFileSync: exec };
    throw new Error("Unexpected workflow import");
  } }, { timeout: 1000 })).toThrow("blocked pending literal reviewed POSIX producer metadata");
  expect(spawn).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(readSource).not.toHaveBeenCalled();
});

it.each(["windows-2022", "windows-2025"])("uses the genuine current source reader against every copied pin for %s", image => {
  const f = sourceFixture();
  try {
    f.env.EMBER_WINDOWS_NODE_PRODUCT_IMAGE = image;
    expect(WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS).toHaveLength(146);
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
