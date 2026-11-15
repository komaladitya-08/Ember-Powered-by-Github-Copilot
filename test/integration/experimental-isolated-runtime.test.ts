// Offline Linux experiment: not a production isolation, authentication or copy-back test.
import { expect, it, vi } from "vitest";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ExperimentalIsolatedRuntime } from "../../app/main/agent/experimental-isolated-runtime";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
// @ts-expect-error -- offline model helper is plain JavaScript
import { startMockLlm } from "../mock-llm/server.mjs";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

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

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses an unsafe result and preserves proposed bytes when the current source cannot be captured", async ctx => {
  const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error || probe.status !== 0) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-review-unsafe-"));
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), exports = path.join(root, "exports");
  for (const dir of [source, baseDir, privateDir, exports]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "a"), "original");
  const privateFile = path.join(privateDir, "never-read"); fs.writeFileSync(privateFile, "PRIVATE_EXPORT_CANARY");
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath });
    const copy = instance.copyPath;
    // An untrusted result may contain a link even in an otherwise unchanged path. No entry may be skipped.
    fs.symlinkSync(privateFile, path.join(copy, "alias"));
    await expect(instance.exportReview(exports)).rejects.toThrow("symbolic link");
    expect(fs.existsSync(copy)).toBe(true); expect(fs.readdirSync(exports)).toEqual([]);
    fs.unlinkSync(path.join(copy, "alias")); fs.writeFileSync(path.join(copy, "a"), "proposal");
    fs.symlinkSync(privateFile, path.join(source, "unverifiable"));
    const remove = fsAsync.rm.bind(fsAsync);
    let failedCleanup = false;
    const cleanupFault = vi.spyOn(fsAsync, "rm").mockImplementation(async (file, options) => {
      if (!failedCleanup && typeof file === "string" && file !== copy && path.basename(file).startsWith("ember-coding-snapshot-") && fs.readdirSync(exports).length > 0) {
        failedCleanup = true; throw new Error("Snapshot cleanup failed after the export committed");
      }
      return remove(file, options);
    });
    let exported: Awaited<ReturnType<ExperimentalIsolatedRuntime["exportReview"]>>;
    try { exported = await instance.exportReview(exports); } finally { cleanupFault.mockRestore(); }
    expect(failedCleanup).toBe(true);
    expect(exported.cleanup).toBe("retained");
    const document = fs.readFileSync(path.join(exported.directory, "review.json"), "utf8"), review = JSON.parse(document);
    expect(review.current).toBeNull(); expect(review.patchComplete).toBe(false);
    expect(review.changes[0].conflicts.join(" ")).toContain("not captured");
    expect(review.proposed.find((e: { path: string }) => e.path === "a").base64).toBe(Buffer.from("proposal").toString("base64"));
    expect(document).not.toContain("PRIVATE_EXPORT_CANARY");
    expect(fs.readFileSync(path.join(source, "a"), "utf8")).toBe("original");
    expect(fs.readlinkSync(path.join(source, "unverifiable"))).toBe(privateFile);
  } finally { await instance?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);

for (const phase of ["capture", "commit-cleanup", "capture-failure"] as const) {
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(`serialises concurrent close with an export paused during ${phase}`, async ctx => {
    const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
    if (probe.error || probe.status !== 0) { ctx.skip(); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-review-close-race-"));
    const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), exports = path.join(root, "exports");
    for (const dir of [source, baseDir, privateDir, exports]) fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(source, "a"), "original");
    const { id, exe } = runtimeFor("linux", process.arch);
    const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
    let instance: ExperimentalIsolatedRuntime | undefined;
    const paused = deferred<void>(), release = deferred<void>();
    const restore: (() => void)[] = [];
    try {
      instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath });
      const copy = instance.copyPath;
      fs.writeFileSync(path.join(copy, "a"), "proposal");
      let held = false;
      if (phase === "commit-cleanup") {
        const remove = fsAsync.rm.bind(fsAsync);
        const spy = vi.spyOn(fsAsync, "rm").mockImplementation(async (file, options) => {
          if (!held && typeof file === "string" && path.basename(file).startsWith("ember-isolation-state-")) {
            held = true; paused.resolve(); await release.promise;
          }
          return remove(file, options);
        });
        restore.push(() => spy.mockRestore());
      } else {
        const open = fsAsync.open.bind(fsAsync);
        const spy = vi.spyOn(fsAsync, "open").mockImplementation(async (file, flags, mode) => {
          if (!held && file === copy) {
            held = true; paused.resolve(); await release.promise;
            if (phase === "capture-failure") throw new Error("Paused result capture failed");
          }
          return open(file, flags, mode);
        });
        restore.push(() => spy.mockRestore());
      }
      const exporting = instance.exportReview(exports);
      const observed = exporting.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await paused.promise;
      const closing = instance.close();
      expect(instance.close()).toBe(closing);
      let closed = false; void closing.then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(fs.existsSync(copy)).toBe(true);
      await expect(instance.exportReview(exports)).rejects.toThrow("busy or closed");
      await expect(instance.request("late work")).rejects.toThrow("busy or closed");
      release.resolve();
      const result = await observed;
      await closing;
      expect(closed).toBe(true); expect(fs.existsSync(copy)).toBe(false);
      expect(fs.readFileSync(path.join(source, "a"), "utf8")).toBe("original");
      if (phase === "capture-failure") {
        expect(result.error).toBeInstanceOf(Error);
        expect(fs.readdirSync(exports)).toEqual([]);
      } else {
        expect(result.error).toBeNull(); expect(result.value?.cleanup).toBe("complete");
        const document = JSON.parse(fs.readFileSync(path.join(result.value!.directory, "review.json"), "utf8"));
        expect(document.proposed.find((e: { path: string }) => e.path === "a").base64).toBe(Buffer.from("proposal").toString("base64"));
      }
    } finally {
      release.resolve(); for (const undo of restore) undo();
      await instance?.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}

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

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("exports only after namespace descendants stop, keeps conflicts and closes host-only file descriptors", async ctx => {
  const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
  if (probe.error || probe.status !== 0) { ctx.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-isolated-review-"));
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), exports = path.join(root, "exports");
  for (const dir of [source, baseDir, privateDir, exports]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "project.txt"), "original\n");
  fs.mkdirSync(path.join(source, "empty"));
  const { id, exe } = runtimeFor("linux", process.arch);
  const runtimePath = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe }).path;
  const mock = await startMockLlm({ delayMs: 0 });
  let instance: ExperimentalIsolatedRuntime | undefined;
  try {
    instance = await ExperimentalIsolatedRuntime.start({ source, baseDir, protectedPaths: [privateDir], runtimePath,
      sharedNetworkForTest: { mockModelUrl: mock.baseUrl } });
    const copy = instance.copyPath;
    const command = "if (: <&3) 2>/dev/null || (: >&3) 2>/dev/null || (: <&4) 2>/dev/null || (: >&4) 2>/dev/null; then printf inherited > /work/host-fds; else printf closed > /work/host-fds; fi; " +
      "printf 'proposed\\n' > /work/project.txt; (printf '%s' \"$BASHPID\" > /work/writer.pid; n=0; while :; do n=$((n+1)); printf '%s' \"$n\" > /work/heartbeat; sleep 0.02; done) >/dev/null 2>&1 &";
    await instance.request(`CALLTOOL:bash${JSON.stringify({ command })}`);
    expect(fs.readFileSync(path.join(copy, "host-fds"), "utf8")).toBe("closed");
    const heartbeat = fs.readFileSync(path.join(copy, "heartbeat"), "utf8");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(fs.readFileSync(path.join(copy, "heartbeat"), "utf8")).not.toBe(heartbeat);
    const receiptDir = fs.readdirSync(baseDir).find(name => name.startsWith("ember-isolation-state-"))!;
    const receipt = JSON.parse(fs.readFileSync(path.join(baseDir, receiptDir, "namespace-receipt.json"), "utf8"));
    const writerPid = fs.readFileSync(path.join(copy, "writer.pid"), "utf8");
    const writer = fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).find(name => {
      try {
        return fs.readlinkSync(`/proc/${name}/ns/pid`) === `pid:[${receipt["pid-namespace"]}]` &&
          new RegExp(`^NSpid:.*\\s${writerPid}\\s*$`, "m").test(fs.readFileSync(`/proc/${name}/status`, "utf8"));
      } catch { return false; }
    });
    expect(writer, "The background writer must really be alive inside this namespace before export").toBeDefined();
    // The user edits the original while the isolated writer still runs. Export must retain all three versions.
    fs.writeFileSync(path.join(source, "project.txt"), "user edit\n");
    const exported = await instance.exportReview(exports);
    expect(exported.cleanup).toBe("complete");
    try { fs.readlinkSync(`/proc/${receipt["child-pid"]}/ns/mnt`); throw new Error("The original namespace init is still active"); }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); }
    // A briefly unreaped zombie cannot write. Any still-running original descendant would violate the receipt.
    let writerState = "gone";
    try { writerState = fs.readFileSync(`/proc/${writer}/stat`, "utf8").split(") ").at(-1)!.split(" ")[0]; }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOENT"); }
    expect(["gone", "Z"]).toContain(writerState);
    expect(fs.readFileSync(path.join(source, "project.txt"), "utf8")).toBe("user edit\n");
    expect(fs.existsSync(copy)).toBe(false);
    const review = JSON.parse(fs.readFileSync(path.join(exported.directory, "review.json"), "utf8"));
    expect(review.purpose).toBe("review-only");
    expect(review.changes.find((c: { path: string }) => c.path === "project.txt").conflicts.length).toBeGreaterThan(0);
    for (const [key, expected] of [["baseline", "original\n"], ["proposed", "proposed\n"], ["current", "user edit\n"]]) {
      const entry = review[key].find((e: { path: string }) => e.path === "project.txt");
      expect(Buffer.from(entry.base64, "base64").toString()).toBe(expected);
    }
    expect(review.baseline.find((e: { path: string }) => e.path === "empty").kind).toBe("directory");
    expect(fs.readFileSync(path.join(exported.directory, "changes.patch"), "utf8")).not.toContain("user edit");
    await expect(instance.request("more work")).rejects.toThrow("closed");
  } finally { await instance?.close(); await mock.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);
