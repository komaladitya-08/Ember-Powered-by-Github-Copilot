/** Process-free checks of actual new fixture boundaries; no positive Windows/WSL proof is modeled. */
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";
import { requireWslProductAdmission } from "../fixtures/wsl-coding-product-contract";
import { wslProductChildEnvironment } from "../fixtures/wsl-coding-product-preflight";
import { createHash } from "node:crypto";
import { wslProductProject } from "../fixtures/wsl-coding-product-model";
import path from "node:path";

const source = fs.readFileSync("test/integration/wsl-coding-product-electron.test.ts", "utf8");
it.each([
  { changed: false, packageCount: 1, packageJsonSha256: "40c34f712312b598e36db3a67e92c92f48f51edfd9e8620d71ba35e7a89cb449", lockSha256: "addb87c0a4ba03bfbff1bc2e4e9dcb7f0872163908df08f4654adb33d9987b58", setSha256: "d7bee5924e7377f2c647ac55a0e224bd624888aa0f94509334ffdd35e9f8912d" },
  { changed: true, packageCount: 2, packageJsonSha256: "837f519e65fb96ef15d113ffbd0c96e36046f5c9abb8abba1587a34c3fd5e127", lockSha256: "56485037d77999afce9edcbacb39856015986ac86c1b7160a6172d7e372e8f02", setSha256: "0dacecc5453123f48e28f8ed69049d5e1aeb2a728f081d00ac43f4779060a4e0" },
])("checks the fixed public fixture hashes against the separately captured production-parser oracle changed=$changed", expected => {
  const begin = source.indexOf("function expectedPublicSummary("), end = source.indexOf("class Journey {", begin);
  const code = transformSync(source.slice(begin, end) + "\nmodule.exports = expectedPublicSummary;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (changed: boolean) => object };
  runInNewContext(code, { module, wslProductProject, createHash });
  const { changed, ...hashes } = expected; expect(module.exports(changed)).toMatchObject(hashes);
});
it("the actual preflight refuses the actual closed literal before any filesystem, Git, VM or native operation", () => {
  const text = fs.readFileSync("test/fixtures/wsl-coding-product-preflight.ts", "utf8"), begin = text.indexOf("export function wslProductPreflight("), end = text.indexOf("/** Keep uncertain", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const code = transformSync(text.slice(begin, end) + "\nmodule.exports = wslProductPreflight;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (required: boolean) => unknown }; let operations = 0;
  const forbidden = () => { operations++; throw new Error("PRIVATE forbidden operation"); };
  runInNewContext(code, { module, requireWslProductAdmission, WSL_CODING_READINESS: { ready: false, proofCommit: null, proofRun: null },
    process: { platform: "win32", arch: "x64", env: { GITHUB_SHA: "a".repeat(40), EMBER_WSL_CODING_PRODUCT_IMAGE: "windows-2022" } },
    fs: new Proxy({}, { get: forbidden }), execFileSync: forbidden, fixedWslProductRuntime: forbidden });
  expect(() => module.exports(true)).toThrow("The required Windows WSL product proof could not be verified."); expect(operations).toBe(0);
});
it("the actual source launch cannot pass an inherited SDK executable or credential override to Electron", async () => {
  const begin = source.indexOf("  async start("), end = source.indexOf("  async send(", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const code = transformSync(`module.exports = class {
    constructor() { this.userData = "public-profile"; this.temporary = "public-temporary"; this.model = { baseUrl: "http://127.0.0.1:1/v1" }; }
    ${source.slice(begin, end)}
  };`, { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as new () => { start(input: object): Promise<void> } }, failure = new Error("Fixed launch control");
  let env: Record<string, string> | undefined;
  runInNewContext(code, { module, wslProductChildEnvironment, environmentCanary: "fixed public marker",
    process: { env: { EMBER_COPILOT_RUNTIME: "external-one", Ember_Copilot_Runtime: "external-two", GITHUB_TOKEN: "PRIVATE credential", Gh_ToKeN: "PRIVATE case credential", NODE_OPTIONS: "PRIVATE loader", Node_Options: "PRIVATE case loader", Ember_User_Data: "PRIVATE old profile", Ember_Test_Provider_Url: "PRIVATE old provider", TmP: "PRIVATE old temporary", PATH: "fixed" } },
    _electron: { launch(input: { env: Record<string, string> }) { env = input.env; throw failure; } } });
  await expect(new module.exports().start({ repository: "public-app", executable: "fixed-electron.exe" })).rejects.toBe(failure);
  expect(env).toMatchObject({ PATH: "fixed", EMBER_USER_DATA: "public-profile", EMBER_TEST_PROVIDER_URL: "http://127.0.0.1:1/v1" });
  expect(Object.keys(env!).some(key => /^EMBER_COPILOT_RUNTIME$/i.test(key))).toBe(false); expect(JSON.stringify(env)).not.toContain("PRIVATE");
});
it("the real resource test masks arbitrary setup errors and preserves only its own minted numeric failure", async () => {
  const text = fs.readFileSync("test/integration/wsl-coding-product-resources.test.ts", "utf8"), begin = text.indexOf("for (const mode of WSL_PRODUCT_CASES.resources)");
  expect(begin > 0).toBe(true);
  const code = transformSync(text.slice(begin), { loader: "ts", format: "cjs", target: "node22" }).code;
  for (const minted of [false, true]) {
    let run: (() => Promise<void>) | undefined, quarantined = false;
    const original = new Error("PRIVATE setup path"), failures = new WeakMap<Error, number>(); if (minted) failures.set(original, 7);
    const it = { skipIf: () => (_title: string, fn: () => Promise<void>) => { run = fn; } };
    const context = { WSL_PRODUCT_CASES: { resources: ["repair-and-custody"] }, wslProductTitle: () => "fixed", required: true, it,
      get quarantined() { return quarantined; }, set quarantined(value: boolean) { quarantined = value; }, failures,
      failure: (phase: number) => new Error("Closed phase " + phase), runCase: async () => { throw original; } };
    runInNewContext(code, context); await expect(run!()).rejects.toThrow("Closed phase " + (minted ? 7 : 1)); expect(quarantined).toBe(true);
  }
});
it.each(["known", "forced", "close-error", "body-error", "model-error", "delete-error"] as const)("the actual Source wrapper releases only known cleanup and retains the whole %s owner", async mode => {
  const begin = source.indexOf("async function journey("), end = source.indexOf("async function openReview(", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const code = transformSync(source.slice(begin, end) + "\nmodule.exports = journey;", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (kind: string, body: (fixture: object) => Promise<void>) => Promise<void> };
  const retained = new Set<object>(), removals: string[] = [], model = { async close() { if (mode === "model-error") throw new Error("PRIVATE model close"); } };
  let quarantined = false; const fixtures: object[] = [];
  class Fixture {
    phase = 2; erased = true; app = {}; process = { exitCode: 0, signalCode: null };
    constructor() { fixtures.push(this); }
    async start() {}
  }
  const context = { module, path, expect, retainedOwners: retained, Journey: Fixture, setTimeout, clearTimeout,
    get quarantined() { return quarantined; }, set quarantined(value: boolean) { quarantined = value; },
    required: true, WSL_PRODUCT_CASES: { source: ["repair"] }, console: { info() {} },
    refusal: () => new Error("Closed source failure"), wslProductPreflight: () => ({ targetLabel: "public target" }), wslProductScratchParent: () => "public-parent",
    createWslProductModel: async () => model, wslProductScenarios: () => [],
    fs: { realpathSync: { native: (value: string) => value }, mkdtempSync: () => "public-root", rmSync(value: string) { if (mode === "delete-error") throw new Error("PRIVATE deletion"); removals.push(value); } },
    closeTestElectron: async () => { if (mode === "close-error") throw new Error("PRIVATE native close"); return mode === "forced"; },
  };
  runInNewContext(code, context);
  const work = module.exports("repair", async () => { if (mode === "body-error") throw new Error("PRIVATE body"); });
  if (mode === "known") {
    await expect(work).resolves.toBeUndefined(); expect(retained.size).toBe(0); expect(removals).toEqual(["public-root"]); expect(quarantined).toBe(false);
  } else {
    await expect(work).rejects.toThrow("Closed source failure"); expect(retained.size).toBe(1); expect(removals).toEqual([]); expect(quarantined).toBe(true);
    const owner = [...retained][0] as { root: string; model: object; fixture: object; owned: Promise<void> };
    expect(owner.root).toBe("public-root"); expect(owner.model).toBe(model); expect(owner.fixture).toBe(fixtures[0]); expect(typeof owner.owned.then).toBe("function"); await owner.owned.catch(() => undefined);
  }
});
