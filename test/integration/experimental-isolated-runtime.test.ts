// Offline Linux experiment: not a production isolation, authentication or copy-back test.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ExperimentalIsolatedRuntime } from "../../app/main/agent/experimental-isolated-runtime";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
// @ts-expect-error -- offline model helper is plain JavaScript
import { startMockLlm } from "../mock-llm/server.mjs";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("defaults to a separate network namespace and refuses non-local model endpoints", async ctx => {
  const probe = spawnSync("/usr/bin/bwrap", ["--unshare-net", "--ro-bind", "/", "/", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error || probe.status !== 0) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-isolated-offline-"));
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private");
  for (const dir of [source, baseDir, privateDir]) fs.mkdirSync(dir, { mode: 0o700 });
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    for (const mockModelUrl of ["https://example.com/v1", "http://localhost:1234", "http://127.0.0.1:1234/?token=x"]) {
      await expect(ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath,
        sharedNetworkForTest: { mockModelUrl } })).rejects.toThrow(/local test model/);
    }
    instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath });
    await expect(instance.request("hello")).rejects.toThrow(/no model network/);
  } finally { await instance?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("runs the whole tokenless runtime over fresh project and toolchain copies", async ctx => {
  const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error || probe.status !== 0) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-isolated-runner-"));
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private");
  for (const dir of [source, baseDir, privateDir]) fs.mkdirSync(dir, { mode: 0o700 });
  const privateFile = path.join(privateDir, "private.txt");
  fs.writeFileSync(privateFile, "PRIVATE_EXPERIMENT_CANARY");
  fs.writeFileSync(path.join(source, "project.txt"), "PROJECT_EXPERIMENT_CANARY");
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  const mock = await startMockLlm({ delayMs: 0 });
  const original = process.env.EMBER_EXPERIMENT_FAKE_SECRET;
  process.env.EMBER_EXPERIMENT_FAKE_SECRET = "sentinel-not-a-real-credential";
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath,
      sharedNetworkForTest: { mockModelUrl: mock.baseUrl } });
    await instance.request(`CALLTOOL:view${JSON.stringify({ path: "/work/project.txt" })}`);
    expect(JSON.stringify(mock.requests)).toContain("PROJECT_EXPERIMENT_CANARY");
    await instance.request(`CALLTOOL:view${JSON.stringify({ path: privateFile })}`);
    expect(JSON.stringify(mock.requests)).not.toContain("PRIVATE_EXPERIMENT_CANARY");
    const command = `if test -e '${privateFile}' || test -e /proc/1/environ || test -n "$EMBER_EXPERIMENT_FAKE_SECRET"; then printf bad > /work/result; else printf ok > /work/result; fi`;
    await instance.request(`CALLTOOL:bash${JSON.stringify({ command })}`);
    expect(fs.readFileSync(path.join(instance.copyPath, "result"), "utf8")).toBe("ok");
    expect(fs.existsSync(path.join(source, "result"))).toBe(false);
  } finally {
    await instance?.close();
    if (original === undefined) delete process.env.EMBER_EXPERIMENT_FAKE_SECRET; else process.env.EMBER_EXPERIMENT_FAKE_SECRET = original;
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("denies selected process inspection syscalls in an actual native shell", async ctx => {
  const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error || probe.status !== 0) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-isolated-seccomp-"));
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private");
  for (const dir of [source, baseDir, privateDir]) fs.mkdirSync(dir, { mode: 0o700 });
  const c = `#include <unistd.h>\n#include <sys/syscall.h>\n#include <errno.h>\n` +
    `int main(void){long n[]={101,310,311,312,304,298,321,323,425,434,438};` +
    `for(unsigned i=0;i<sizeof(n)/sizeof(n[0]);i++){errno=0;if(syscall(n[i],999999999,0,0,0,0,0)!=-1||errno!=EPERM)return 2;}return 0;}`;
  const compiler = spawnSync("cc", ["-x", "c", "-o", path.join(source, "probe"), "-"], { input: c, encoding: "utf8", timeout: 10_000 });
  if (compiler.error?.message.includes("ENOENT")) { fs.rmSync(root, { recursive: true, force: true }); ctx.skip(); return; }
  expect(compiler.status, compiler.stderr).toBe(0);
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  const mock = await startMockLlm({ delayMs: 0 });
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath,
      sharedNetworkForTest: { mockModelUrl: mock.baseUrl } });
    await instance.request(`CALLTOOL:bash${JSON.stringify({ command: "/work/probe && printf denied > /work/verdict || printf unexpected > /work/verdict" })}`);
    expect(fs.readFileSync(path.join(instance.copyPath, "verdict"), "utf8")).toBe("denied");
  } finally {
    await instance?.close(); await mock.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
