import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { CodingRuntime, CodingRuntimeCleanupError, codingRuntimeOptions } from "../../app/main/agent/coding-runtime";

const dirs: string[] = [];
function folder(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-coding-runtime-")); dirs.push(d); return d; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("the coding runtime", () => {
  it("never passes a client-level token or inherited GitHub credentials to its child", () => {
    const options = codingRuntimeOptions({ userData: folder(), runtimePath: "/runtime", env: {
      PATH: "/bin", GH_TOKEN: "secret", GITHUB_ENTERPRISE_TOKEN: "other", COPILOT_SDK_AUTH_TOKEN: "third",
    } }, "/private/runtime");
    expect(options.gitHubToken).toBeUndefined();
    expect(options.useLoggedInUser).toBe(false);
    expect(options.baseDirectory).toBe("/private/runtime");
    expect(options.env).toEqual({ PATH: "/bin" });
  });

  it("gives each task its own runtime directory and removes it only after the process stops", async () => {
    const userData = folder(), options: CopilotClientOptions[] = [], stop = vi.fn(async () => []);
    const create = (config: CopilotClientOptions) => { options.push(config); return { start: vi.fn(async () => undefined), stop } as unknown as CopilotClient; };
    const [a, b] = await Promise.all([
      CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, create),
      CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, create),
    ]);
    const [first, second] = options.map(o => o.baseDirectory!);
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    await a.close();
    expect([first, second].filter(d => fs.existsSync(d))).toHaveLength(1);
    await Promise.all([b.close(), b.close()]);
    expect(stop).toHaveBeenCalledTimes(2);
    expect([first, second].filter(d => fs.existsSync(d))).toHaveLength(0);
  });

  it("does not report an aborted startup as disposed until the process has actually been stopped", async () => {
    const userData = folder(), start = deferred<void>(), stopping = deferred<Error[]>(), abort = new AbortController();
    const client = { start: () => start.promise, stop: vi.fn(() => stopping.promise) } as unknown as CopilotClient;
    const opening = CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, abort.signal, () => client);
    // Wait until the asynchronous directory setup reaches client.start().
    await vi.waitFor(() => expect(fs.readdirSync(path.join(userData, "coding-runtimes")).length).toBe(1));
    abort.abort();
    let settled = false;
    void opening.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    start.resolve();
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    stopping.resolve([]);
    await expect(opening).rejects.toThrow();
    expect(fs.readdirSync(path.join(userData, "coding-runtimes"))).toEqual([]);
  });

  it("fails closed and keeps its private directory if the runtime cannot be stopped", async () => {
    const userData = folder(), client = { start: async () => undefined, stop: async () => [new Error("stop failed")] } as unknown as CopilotClient;
    const abort = new AbortController();
    const opening = CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, abort.signal, () => { abort.abort(); return client; });
    await expect(opening).rejects.toBeInstanceOf(CodingRuntimeCleanupError);
    expect(fs.readdirSync(path.join(userData, "coding-runtimes"))).toHaveLength(1);
    const factory = vi.fn(() => client);
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, factory)).rejects.toThrow("could not be verified as stopped");
    expect(factory).not.toHaveBeenCalled();
  });

  it("leaves unverified orphan data untouched and does not start another runtime", async () => {
    const userData = folder(), stale = path.join(userData, "coding-runtimes", "task-stale");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "data"), "keep");
    const factory = vi.fn(() => ({ start: async () => undefined, stop: async () => [] }) as unknown as CopilotClient);
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, factory)).rejects.toThrow("could not be verified as stopped");
    expect(factory).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(stale, "data"), "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic-link runtime root", async () => {
    const userData = folder(), elsewhere = folder();
    fs.writeFileSync(path.join(elsewhere, "keep"), "untouched");
    fs.symlinkSync(elsewhere, path.join(userData, "coding-runtimes"), "dir");
    const factory = vi.fn(() => ({ start: async () => undefined, stop: async () => [] }) as unknown as CopilotClient);
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, factory)).rejects.toThrow("folder is unavailable");
    expect(factory).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(elsewhere, "keep"), "utf8")).toBe("untouched");
  });

  it("does not allocate another runtime while a prior process is stopping", async () => {
    const userData = folder(), stopping = deferred<Error[]>();
    let runtimeDir = "";
    const client = { start: async () => undefined, stop: () => stopping.promise } as unknown as CopilotClient;
    const runtime = await CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, options => { runtimeDir = options.baseDirectory!; return client; });
    const closing = runtime.close();
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, () => client)).rejects.toThrow("could not be verified as stopped");
    // Removing the directory is not evidence that the process stopped.
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, () => client)).rejects.toThrow("could not be verified as stopped");
    stopping.resolve([]);
    await closing;
  });

  it("does not treat a missing active runtime directory as proof that its process exited", async () => {
    const userData = folder();
    let runtimeDir = "";
    const client = { start: async () => undefined, stop: async () => [] } as unknown as CopilotClient;
    const runtime = await CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, options => { runtimeDir = options.baseDirectory!; return client; });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, () => client)).rejects.toThrow("could not be verified as stopped");
    await runtime.close();
  });

  it("does not remove a replacement directory when a runtime is stopped", async () => {
    const userData = folder();
    let runtimeDir = "";
    const client = { start: async () => undefined, stop: async () => [] } as unknown as CopilotClient;
    const runtime = await CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, options => { runtimeDir = options.baseDirectory!; return client; });
    fs.renameSync(runtimeDir, `${runtimeDir}-original`);
    fs.mkdirSync(runtimeDir);
    fs.writeFileSync(path.join(runtimeDir, "keep"), "replacement");
    await expect(CodingRuntime.start({ userData, runtimePath: "/runtime", env: {} }, undefined, () => client)).rejects.toThrow("could not be verified as stopped");
    await expect(runtime.close()).rejects.toThrow("directory changed");
    expect(fs.readFileSync(path.join(runtimeDir, "keep"), "utf8")).toBe("replacement");
  });
});
