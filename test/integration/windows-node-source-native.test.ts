/** Fixed-literal source-built Node feasibility only; this never opens a coding backend or accepts project code. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { prepareWindowsNodeProof, WindowsNodeProofCleanupError } from "../fixtures/windows-node-lpac-proof";
import { inspectWindowsNodeFatalOutput } from "../fixtures/windows-node-lpac-fatal";
import { WindowsNodeSourceOwnership, WindowsNodeSourceOwnershipError } from "../fixtures/windows-node-source-ownership";
import { runWindowsSourceNodeProbe, readWindowsNodeSourceBootstrap, windowsSourceNodeFailureReceipt,
  WindowsNodeSourceProbeCleanupError } from "../fixtures/windows-node-source-proof";

const required = process.env.EMBER_NODE_SOURCE_PROBE === "1";
const available = required && process.platform === "win32" && process.arch === "x64";
describe.skipIf(!available && !required)("separate verified-source Node fixed useful work in zero-capability LPAC", () => {
  let parent = "", buildRoot = "", buildCommit = "", runCommit = "", officialAsset = "", retained = false;
  let bootstrap: Buffer;
  beforeAll(() => {
    try {
      if (!available) throw new Error("The explicitly required source-Node feasibility probe requires Windows x64.");
      buildRoot = process.env.EMBER_NODE_SOURCE_BUILD_ROOT ?? "";
      buildCommit = process.env.EMBER_NODE_SOURCE_BUILD_COMMIT ?? ""; runCommit = process.env.GITHUB_SHA ?? "";
      const officialRoot = process.env.EMBER_LPAC_NODE_ASSET_ROOT ?? "";
      if (!/^[A-Za-z]:\\/.test(buildRoot) || !/^[A-Za-z]:\\/.test(officialRoot) ||
          !/^[0-9a-f]{40}$/.test(buildCommit) || !/^[0-9a-f]{40}$/.test(runCommit)) throw new Error("Use only exact workflow source/build identities.");
      officialAsset = path.join(officialRoot, "node.exe");
      const temporary = fs.realpathSync.native(os.tmpdir());
      const base = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
      parent = fs.mkdtempSync(path.join(base, "ember-source-node-native-"));
      bootstrap = readWindowsNodeSourceBootstrap(buildRoot, buildCommit);
    } catch (error) { if (error instanceof WindowsNodeSourceProbeCleanupError) retained = true; throw error; }
  });
  afterAll(() => { bootstrap?.fill(0); if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });

  let source: ReturnType<typeof runWindowsSourceNodeProbe> | undefined;
  const sourceOutcome = () => {
    if (retained) return Promise.reject(new WindowsNodeSourceProbeCleanupError());
    return source ??= runWindowsSourceNodeProbe({ parent: fs.mkdtempSync(path.join(parent, "source-")), buildRoot, buildCommit, runCommit }, loadExperimentalWindowsLpacApi())
      .then(result => { console.info("Fixed source-Node stopped result", JSON.stringify(result)); return result; })
      .catch(error => {
        if (error instanceof WindowsNodeSourceProbeCleanupError) retained = true;
        const receipt = windowsSourceNodeFailureReceipt(error);
        if (receipt) console.info("Fixed source-Node stopped failure", JSON.stringify(receipt));
        throw error;
      });
  };
  type StockResult = { host: { exitCode: number; jobStopped: true }; lpacExit: number; jobStopped: true;
    output: ReturnType<typeof inspectWindowsNodeFatalOutput> };
  let stock: Promise<StockResult> | undefined;
  const stockOutcome = () => stock ??= (async () => {
    if (retained) throw new WindowsNodeSourceProbeCleanupError();
    const api = loadExperimentalWindowsLpacApi(), fresh = fs.mkdtempSync(path.join(parent, "official-"));
    const canary = path.join(fresh, "host-only-canary.txt"), value = "synthetic source-node control canary";
    const setup = new WindowsNodeSourceOwnership();
    let proof: Awaited<ReturnType<typeof prepareWindowsNodeProof>> | undefined;
    let result: StockResult | undefined, failure: Error | undefined;
    try {
      setup.guard(() => api.writeNewFile(canary, Buffer.from(value), `D:P(A;;FA;;;${api.ownerSid()})(A;;FA;;;SY)S:(ML;;NW;;;ME)`));
      // This existing API still verifies the official byte pin and OpenJS chain before any launch.
      proof = await prepareWindowsNodeProof({ parent: fresh, bootstrap, version: "22.23.5", asset: officialAsset,
        mode: "startup-io", canary, port: 1 }, api);
      const host = await proof.hostStartup();
      await proof.launch();
      await proof.fixture.waitRootExited(20_000); const stopped = await proof.fixture.waitStopped(15_000); stopped.requireStopped();
      const lpacExit = proof.fixture.exitCode(), bytes = proof.readIoOutput();
      let output: ReturnType<typeof inspectWindowsNodeFatalOutput>;
      try { output = inspectWindowsNodeFatalOutput(bytes, "22.23.5"); } finally { bytes.fill(0); }
      if (fs.readFileSync(canary, "utf8") !== value) throw new Error("The fixed official control altered its canary.");
      result = { host, lpacExit, jobStopped: true, output };
    } catch (error) {
      if (error instanceof WindowsNodeProofCleanupError || error instanceof WindowsNodeSourceOwnershipError) retained = true;
      failure = new Error("The separate official stock control failed its fixed native contract.");
    } finally {
      if (proof) try { await proof.close(); } catch { retained = true; failure = new WindowsNodeSourceProbeCleanupError(); }
    }
    if (failure) throw failure;
    if (!result) throw new Error("No stopped official control result is available.");
    console.info("Unchanged official Node stopped control", JSON.stringify(result)); return result;
  })();

  it("preserves the official signed-stock ordinary-host startup control", async () => {
    expect((await stockOutcome()).host).toEqual({ exitCode: 0, jobStopped: true });
  }, 90_000);
  it("preserves the official stock LPAC Winsock refusal as a separate negative control", async () => {
    const result = await stockOutcome();
    expect(result.lpacExit).toBe(0x80000003); expect(result.jobStopped).toBe(true);
    expect(result.output.nativeFailure).toEqual({ family: "libuv-win32", operation: "WSAStartup", code: 10107 });
  }, 90_000);
  it("runs the fixed source-built program in the parent's observed ordinary context", async () => {
    const result = await sourceOutcome();
    expect(result.host.exitCode).toBe(0); expect(result.host.jobStopped).toBe(true);
    expect(result.host.identity.sameUser).toBe(true);
    expect(result.host.identity.host).toEqual(result.host.identity.parent);
    expect(result.host.report).toMatchObject({ role: 0, status: 1, stage: 7, features: 31, fileRemoved: 1 });
  }, 90_000);
  it("runs only fixed local FS, async read and timer operations in the separate source-built LPAC", async () => {
    const result = await sourceOutcome();
    expect(result.lpac.exitCode).toBe(0); expect(result.lpac.jobStopped).toBe(true);
    expect(result.lpac.report).toMatchObject({ role: 1, status: 1, stage: 7, features: 31, fileRemoved: 1 });
    expect(result.lpac.output).toEqual({ output: { status: "no-location", bytes: 0 } });
  }, 90_000);
});
