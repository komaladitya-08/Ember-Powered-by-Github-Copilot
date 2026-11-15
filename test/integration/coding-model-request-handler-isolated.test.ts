// Offline experiment only. Whole-runtime Bubblewrap + host model bridge + stopped review export. Synthetic secrets
// and a local model establish this particular flow, not a production syscall/credential boundary or useful toolchain.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { CodingModelBroker } from "../../app/main/agent/coding-model-broker";
import { CodingModelRequestHandler } from "../../app/main/agent/coding-model-request-handler";
import { ExperimentalIsolatedRuntime } from "../../app/main/agent/experimental-isolated-runtime";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
// @ts-expect-error -- plain JavaScript offline fixture
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("uses a host-only credential with no sandbox network, revokes requests, and exports after descendant writers stop", async ctx => {
  const probe = spawnSync("/usr/bin/bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error || probe.status !== 0) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-isolated-model-bridge-"));
  const source = path.join(root, "project"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), exportBase = path.join(root, "exports");
  for (const directory of [source, baseDir, privateDir, exportBase]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "project.txt"), "original\n");
  const privateFile = path.join(privateDir, "private.txt");
  fs.writeFileSync(privateFile, "PRIVATE_BRIDGE_CANARY");
  const credential = `host_only_model_${crypto.randomUUID()}`;
  const previousCanary = process.env.EMBER_BROKER_ENV_CANARY;
  process.env.EMBER_BROKER_ENV_CANARY = credential;
  const mock = await startMockLlm({ delayMs: 0 });
  const lifetime = new AbortController();
  const limits = { requests: 20, concurrent: 1, requestBytes: 1024 * 1024, responseBytes: 4 * 1024 * 1024,
    totalBytes: 16 * 1024 * 1024, requestMs: 15_000, lifetimeMs: 90_000 };
  const broker = new CodingModelBroker({ baseUrl: mock.baseUrl, model: "mock-model", apiKey: credential, limits, signal: lifetime.signal });
  const sessionId = `ember-isolated-broker-${crypto.randomUUID()}`;
  const handler = new CodingModelRequestHandler({ sessionId, broker, maxBodyBytes: limits.requestBytes });
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath,
      requestHandler: handler, sessionForTest: { sessionId, model: "mock-model" }, privateProcForTest: true });
    const copy = instance.copyPath;
    const command = "printf 'proposed\\n' > /work/project.txt; " +
      "cat /proc/1/environ > /work/runtime.env; cat /proc/self/environ > /work/child.env; " +
      `if test -e '${privateFile}' || test -n "$EMBER_BROKER_ENV_CANARY"; then printf leaked > /work/private-probe; else printf absent > /work/private-probe; fi; ` +
      `if (: > /dev/tcp/127.0.0.1/${mock.port}) 2>/dev/null; then printf reachable > /work/network-probe; else printf denied > /work/network-probe; fi; ` +
      "(printf '%s' \"$BASHPID\" > /work/writer.pid; n=0; while :; do n=$((n+1)); printf '%s' \"$n\" > /work/heartbeat; sleep 0.02; done) >/dev/null 2>&1 &";
    await instance.request(`CALLTOOL:bash${JSON.stringify({ command })}`);
    expect(fs.readFileSync(path.join(copy, "project.txt"), "utf8")).toBe("proposed\n");
    expect(fs.readFileSync(path.join(source, "project.txt"), "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(copy, "private-probe"), "utf8")).toBe("absent");
    expect(fs.readFileSync(path.join(copy, "network-probe"), "utf8")).toBe("denied");
    for (const file of ["runtime.env", "child.env"]) expect(fs.readFileSync(path.join(copy, file)).includes(credential)).toBe(false);
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(mock.requests.every((request: { authorization: string | null }) => request.authorization === `Bearer ${credential}`)).toBe(true);

    const scratchName = fs.readdirSync(baseDir).find(name => name.startsWith("ember-isolation-state-"))!;
    const scratch = path.join(baseDir, scratchName);
    const receipt = JSON.parse(fs.readFileSync(path.join(scratch, "namespace-receipt.json"), "utf8"));
    const net = fs.readlinkSync(`/proc/${receipt["child-pid"]}/ns/net`);
    expect(net).toBe(`net:[${receipt["net-namespace"]}]`);
    expect(net).not.toBe(fs.readlinkSync("/proc/self/ns/net"));
    expect(fs.readFileSync(`/proc/${receipt["child-pid"]}/environ`).includes(credential)).toBe(false);
    const hasCredential = (directory: string): boolean => fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? hasCredential(target) : entry.isFile() && fs.readFileSync(target).includes(credential);
    });
    expect(hasCredential(path.join(scratch, "state"))).toBe(false);
    const writerPid = fs.readFileSync(path.join(copy, "writer.pid"), "utf8");
    const writer = fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).find(name => {
      try {
        return fs.readlinkSync(`/proc/${name}/ns/pid`) === `pid:[${receipt["pid-namespace"]}]` &&
          new RegExp(`^NSpid:.*\\s${writerPid}\\s*$`, "m").test(fs.readFileSync(`/proc/${name}/status`, "utf8"));
      } catch { return false; }
    });
    expect(writer, "A real background writer must exist before Stop/export").toBeDefined();
    const heartbeat = fs.readFileSync(path.join(copy, "heartbeat"), "utf8");
    await expect.poll(() => fs.readFileSync(path.join(copy, "heartbeat"), "utf8")).not.toBe(heartbeat);

    handler.retire();
    const admitted = mock.requests.length;
    await expect(instance.request(`CALLTOOL:bash${JSON.stringify({ command: "printf forbidden > /work/after-retirement" })}`)).rejects.toThrow();
    expect(mock.requests).toHaveLength(admitted);
    expect(fs.existsSync(path.join(copy, "after-retirement"))).toBe(false);
    fs.writeFileSync(path.join(source, "project.txt"), "user edit\n");
    const exported = await instance.exportReview(exportBase);
    expect(exported.cleanup).toBe("complete");
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(source, "project.txt"), "utf8")).toBe("user edit\n");
    let writerState = "gone";
    try { writerState = fs.readFileSync(`/proc/${writer}/stat`, "utf8").split(") ").at(-1)!.split(" ")[0]; }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); }
    expect(["gone", "Z"]).toContain(writerState);
    expect(() => fs.readlinkSync(`/proc/${receipt["child-pid"]}/ns/mnt`)).toThrow();
    const review = exported.review;
    expect(review.purpose).toBe("review-only");
    expect(review.changes.find(change => change.path === "project.txt")?.conflicts.length).toBeGreaterThan(0);
    for (const [tree, expected] of [[review.baseline, "original\n"], [review.proposed, "proposed\n"], [review.current!, "user edit\n"]] as const) {
      const file = tree.find(entry => entry.path === "project.txt");
      expect(file?.kind).toBe("file");
      expect(file?.kind === "file" && Buffer.from(file.base64, "base64").toString()).toBe(expected);
    }
    // Conflicted edits stay in the full JSON review and are omitted from the applicable text patch.
    expect(fs.readFileSync(path.join(exported.directory, "changes.patch"), "utf8")).not.toContain("a/project.txt");
    expect(review.patchComplete).toBe(false);
    expect(fs.readFileSync(path.join(exported.directory, "review.json"), "utf8")).not.toContain(credential);
  } finally {
    handler.retire();
    await instance?.close();
    if (previousCanary === undefined) delete process.env.EMBER_BROKER_ENV_CANARY; else process.env.EMBER_BROKER_ENV_CANARY = previousCanary;
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
