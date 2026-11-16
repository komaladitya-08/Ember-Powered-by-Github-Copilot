/** Official Windows Node directly inside cap0 LPAC. Useful in-process checks and child startup are distinct proofs. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
import { compileWindowsNodeBootstrap, prepareWindowsNodeProof, windowsNodeProofPin, WindowsNodeProofCleanupError, type WindowsNodeProofMode } from "../fixtures/windows-node-lpac-proof";
import { observeWindowsNodeApplicationError } from "../fixtures/windows-node-lpac-events";
import { parseWindowsNodeFatalOutput } from "../fixtures/windows-node-lpac-fatal";
import { windowsNodeIoSetupReceipt } from "../fixtures/windows-node-lpac-io";

const denial = z.object({ denied: z.boolean(), code: z.string().max(32).nullable() }).strict();
const direct = z.object({ version: z.string().max(32), pid: z.number().int().positive(), environmentAbsent: z.boolean(), copiedEdit: z.boolean(),
  read: denial, write: denial, network: denial, localAppData: z.string().max(4096), temp: z.string().max(4096), tmp: z.string().max(4096) }).strict();
const inprocess = z.object({ version: z.string().max(32), pid: z.number().int().positive(), inProcessCheck: z.literal(true) }).strict();
const child = z.object({ version: z.string().max(32), attempted: z.literal(true), errorCode: z.string().max(32).nullable(), status: z.number().int().nullable(), signal: z.string().max(32).nullable(), markerPresent: z.boolean() }).strict();

describe.skipIf(process.platform !== "win32" || process.env.EMBER_LPAC_NODE_PROOF !== "1")("official pinned Windows Node in zero-capability LPAC (diagnostic only)", () => {
  let parent = "", bootstrap: Buffer, asset: string, version: string, retained = false;
  beforeAll(() => {
    if (process.arch !== "x64") throw new Error("This configured native Node proof requires Windows x64.");
    version = process.env.EMBER_LPAC_NODE_VERSION ?? ""; windowsNodeProofPin(version);
    const root = process.env.EMBER_LPAC_NODE_ASSET_ROOT;
    if (!root || !path.win32.isAbsolute(root)) throw new Error("Provide only the workflow's independently pinned official Windows Node asset directory.");
    asset = path.join(root, "node.exe");
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "ember-node-lpac-")); bootstrap = compileWindowsNodeBootstrap(parent);
  }, 90_000);
  afterAll(() => { if (parent && !retained) fs.rmSync(parent, { recursive: true, force: true }); });

  type StartupOutcomes = { host: { exitCode: number; jobStopped: true }; lpacExit: number; output?: ReturnType<typeof parseWindowsNodeFatalOutput> };
  let startupRun: Promise<StartupOutcomes> | undefined, ioStartupRun: Promise<StartupOutcomes> | undefined;
  async function run(mode: WindowsNodeProofMode): Promise<StartupOutcomes | undefined> {
    if (retained) throw new Error("An earlier Node proof cleanup is unverified; no later process may start in this job.");
    const api = loadExperimentalWindowsLpacApi(), work = fs.mkdtempSync(path.join(parent, `${mode}-`));
    const canary = path.join(work, "host-only-canary.txt"), value = "synthetic host-only Node LPAC canary";
    api.writeNewFile(canary, Buffer.from(value), `D:P(A;;FA;;;${api.ownerSid()})(A;;FA;;;SY)S:(ML;;NW;;;ME)`);
    let connections = 0;
    const listener = net.createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>(resolve => { listener.listen(0, "127.0.0.1", resolve); });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("The synthetic loopback endpoint did not bind.");
    const beforeGitHub = process.env.GH_TOKEN, beforeSecret = process.env.EMBER_HOST_NODE_SECRET;
    let proof: Awaited<ReturnType<typeof prepareWindowsNodeProof>> | undefined;
    let failure: { error: unknown } | null = null;
    let control: StartupOutcomes["host"] | undefined, startup: StartupOutcomes | undefined;
    try {
      proof = await prepareWindowsNodeProof({ parent: work, bootstrap, version, asset, mode, canary, port: address.port }, api);
      process.env.GH_TOKEN = "synthetic-host-GitHub-canary"; process.env.EMBER_HOST_NODE_SECRET = "synthetic-host-secret-canary";
      if (mode === "startup" || mode === "startup-io") {
        control = await proof.hostStartup();
        if (mode === "startup-io") {
          console.info("Separate private-stdio Node host control", JSON.stringify({ version, appContainer: false, fixedEval: true, inheritedHandles: 2,
            privateOutputBytes: 0, headless: true, explicitEnvironment: true, exitCode: `0x${control.exitCode.toString(16)}`, jobStopped: control.jobStopped }));
        } else {
          console.info("Separate trusted-host Node startup control", JSON.stringify({ version, appContainer: false, fixedEval: true, inheritedHandles: false,
            headless: true, explicitEnvironment: true, exitCode: `0x${control.exitCode.toString(16)}`, jobStopped: control.jobStopped }));
        }
      }
      const pid = await proof.launch();
      expect(proof.observations).toEqual({ assigned: true, token: true, image: true, resumed: true });
      try { await proof.fixture.waitRootExited(20_000); }
      catch {
        // A timeout is not a stop proof and cannot authorize any report read.
        const stopped = await proof.fixture.stop(15_000); stopped.requireStopped();
        throw new Error(`Pinned Node ${version} ${mode} did not exit. No ACL, capability or AppContainer fallback is allowed.`);
      }
      const lease = await proof.fixture.waitStopped(15_000); lease.requireStopped();
      const exit = proof.fixture.exitCode();
      if (mode === "startup" && exit !== 0) {
        // Event1000 publication may follow root exit. This short diagnostic grace is bounded and proves nothing
        // about compatibility; identity is reissued only after another stopped-job observation below.
        await new Promise<void>(resolve => setTimeout(resolve, 750));
        const diagnostic = observeWindowsNodeApplicationError(proof.eventIdentity(), api.windowsDirectory(), proof.fixture.paths.state);
        console.info("Node LPAC application-error diagnostic", JSON.stringify(diagnostic));
      }
      if (mode !== "startup" && mode !== "startup-io") {
        const failure = proof.report("failure.json");
        if (failure !== null) throw new Error(`Pinned Node ${version} ${mode} reported a bounded probe failure: ${failure}`);
        if (exit !== 0) throw new Error(`Pinned Node ${version} ${mode} exited with code 0x${exit.toString(16)}. No compatibility grants are permitted.`);
      }
      expect(fs.readFileSync(canary, "utf8")).toBe(value); expect(connections).toBe(0);
      if (mode === "startup-io") {
        // No Buffer or raw diagnostic is asserted/logged. The host closes parent writers and rechecks native stop
        // before reading the pinned artifact; the parser returns only public catalog locations or fixed statuses.
        const bytes = proof.readIoOutput();
        let output: ReturnType<typeof parseWindowsNodeFatalOutput>;
        try { output = parseWindowsNodeFatalOutput(bytes, version); } finally { bytes.fill(0); }
        startup = { host: control!, lpacExit: exit, output };
        console.info("Private-stdio Node LPAC", JSON.stringify({ version, fixedEval: true, inheritedHandles: 2, exitCode: `0x${exit.toString(16)}`, jobStopped: true, output }));
      } else if (mode === "startup") {
        startup = { host: control!, lpacExit: exit };
        console.info("Startup-only Node LPAC", JSON.stringify({ version, fixedEval: true, inheritedHandles: false, exitCode: `0x${exit.toString(16)}`, jobStopped: true }));
      } else if (mode === "direct") {
        const report = direct.parse(JSON.parse(proof.report("direct.json") ?? "null"));
        expect(report.version).toBe(`v${version}`); expect(report.pid).toBe(pid);
        expect(report.environmentAbsent).toBe(true); expect(report.copiedEdit).toBe(true);
        for (const result of [report.read, report.write, report.network]) { expect(result.denied).toBe(true); expect(["EACCES", "EPERM"]).toContain(result.code); }
        // Check the OS-observed environment after the stopped lease; no profile/ancestor ACL was changed.
        expect(report.localAppData.toLowerCase() === proof.profile.localAppData.toLowerCase()).toBe(true);
        expect(report.temp.toLowerCase() === proof.profile.temp.toLowerCase()).toBe(true);
        expect(report.tmp.toLowerCase() === proof.profile.temp.toLowerCase()).toBe(true);
        expect(fs.readFileSync(path.join(proof.fixture.paths.work, "copied.cjs"), "utf8")).toBe("module.exports = 42;\n");
        console.info("Direct Node LPAC", JSON.stringify({ version, copiedEdit: true, cleanEnvironment: true, profileRedirection: true, hostRead: report.read.code, hostWrite: report.write.code, loopback: report.network.code, jobStopped: true }));
      } else if (mode === "inprocess") {
        const report = inprocess.parse(JSON.parse(proof.report("inprocess.json") ?? "null"));
        expect(report.version).toBe(`v${version}`); expect(report.pid).toBe(pid);
        const tap = proof.report("test.tap"); expect(tap).not.toBeNull();
        expect(tap).toMatch(/# pass 1\b/); expect(tap).toMatch(/# fail 0\b/);
        console.info("In-process Node test LPAC", JSON.stringify({ version, testIsolation: "none", passed: 1, failed: 0, jobStopped: true }));
      } else {
        const report = child.parse(JSON.parse(proof.report("child.json") ?? "null"));
        expect(report.version).toBe(`v${version}`);
        // This separate diagnostic expects unsupported ordinary child creation. Success needs its own token/image/job
        // proof and must never be silently promoted to general toolchain compatibility by this fixture.
        console.info("Ordinary Node child startup diagnostic", JSON.stringify({ version, errorCode: report.errorCode, status: report.status, markerPresent: report.markerPresent, childCompatibilityEstablished: false, jobStopped: true }));
        expect(report.markerPresent).toBe(false);
        expect(fs.existsSync(path.join(proof.fixture.paths.state, "ordinary-child.json"))).toBe(false);
        const creationDenied = ["EACCES", "EPERM"].includes(report.errorCode ?? "");
        const startupFailed = report.errorCode === null && report.status !== null && report.status !== 0;
        expect(creationDenied || startupFailed).toBe(true);
      }
    } catch (error) {
      const setupReceipt = windowsNodeIoSetupReceipt(error);
      if (setupReceipt) console.info("Node LPAC stdio setup failure", JSON.stringify(setupReceipt));
      if (error instanceof WindowsNodeProofCleanupError) retained = true;
      failure = { error };
    } finally {
      if (beforeGitHub === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = beforeGitHub;
      if (beforeSecret === undefined) delete process.env.EMBER_HOST_NODE_SECRET; else process.env.EMBER_HOST_NODE_SECRET = beforeSecret;
      let cleanupError: { error: unknown } | null = null;
      if (proof) try { await proof.close(); } catch (error) { retained = true; cleanupError = { error }; }
      try { await new Promise<void>((resolve, reject) => { listener.close(error => error ? reject(error) : resolve()); }); }
      catch (error) { cleanupError ??= { error }; }
      if (cleanupError) failure = cleanupError;
    }
    if (failure) throw failure.error;
    return startup;
  }
  function startupOutcomes(): Promise<StartupOutcomes> {
    // Both assertions share one staged image, cwd, arguments and exact input environment; neither result substitutes
    // for the other. Cache only stopped-and-cleaned numeric facts, not a live fixture or native handle.
    return startupRun ??= run("startup").then(result => { if (!result) throw new Error("The paired startup diagnostic returned no outcomes."); return result; });
  }
  function ioStartupOutcomes(): Promise<StartupOutcomes> {
    return ioStartupRun ??= run("startup-io").then(result => { if (!result) throw new Error("The separate private-stdio diagnostic returned no outcomes."); return result; });
  }
  it("runs the same pinned startup-only eval as a separate trusted-host native control", async () => {
    expect((await startupOutcomes()).host).toEqual({ exitCode: 0, jobStopped: true });
  }, 90_000);
  it("runs only a fixed startup eval inside unchanged zero-capability LPAC", async () => {
    expect((await startupOutcomes()).lpacExit).toBe(0);
  }, 90_000);
  it("executes the direct official Node image with a copied edit, clean profile and explicit host/network access denials", () => run("direct"), 90_000);
  it("runs a useful Node check in-process with a file reporter and no inherited stdout handles", () => run("inprocess"), 90_000);
  it("reports ordinary child startup separately without claiming child/toolchain support", () => run("child"), 90_000);
  it("runs the fixed eval with only two private stdio handles as a separate trusted-host control", async () => {
    expect((await ioStartupOutcomes()).host).toEqual({ exitCode: 0, jobStopped: true });
  }, 90_000);
  it("runs only the fixed eval in LPAC with an explicit two-handle stdio list and parsed private output", async () => {
    expect((await ioStartupOutcomes()).lpacExit).toBe(0);
  }, 90_000);
});
