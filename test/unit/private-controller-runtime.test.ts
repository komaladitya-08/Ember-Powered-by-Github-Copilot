import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CopilotClient, CopilotClientOptions } from "@github/copilot-sdk";
import { PrivateControllerRuntime, privateControllerClientOptions } from "../../app/main/agent/private-controller-runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const input = ({ retain = false }: { retain?: boolean } = {}) => {
  // Failed stop deliberately retains native pins; keep that synthetic state outside unconditional run-temp teardown.
  const userData = fs.mkdtempSync(path.join(retain ? path.dirname(os.tmpdir()) : os.tmpdir(), "ember-controller-runtime-"));
  if (!retain) roots.push(userData);
  return { userData, runtimePath: "/fixed/copilot-runtime", env: { PATH: "/system/bin", HOME: "/ambient/home", NODE_OPTIONS: "--require=evil", LD_PRELOAD: "evil.so", GH_TOKEN: "ambient-secret", COPILOT_CONFIG_DIR: "/project", HTTPS_PROXY: "http://approved-proxy" }, gitHubToken: "synthetic-host-token" };
};

it("pins private process/session paths and drops ambient loaders, config roots and credentials", () => {
  const i = input(), root = path.join(i.userData, "private");
  const options = privateControllerClientOptions(i, { root, cwd: path.join(root, "cwd"), home: path.join(root, "home"), state: path.join(root, "state"), temporary: path.join(root, "tmp") });
  expect(options).toMatchObject({ mode: "empty", workingDirectory: path.join(root, "cwd"), baseDirectory: path.join(root, "state"), useLoggedInUser: false, gitHubToken: "synthetic-host-token" });
  expect(options.env).toMatchObject({ PATH: "/system/bin", HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), HTTPS_PROXY: "http://approved-proxy", TMPDIR: path.join(root, "tmp") });
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "GH_TOKEN", "COPILOT_CONFIG_DIR"]) expect(options.env).not.toHaveProperty(name);
});

it("allocates a fresh empty private cwd and removes it only after SDK stop confirms", async () => {
  const i = input();
  let captured: CopilotClientOptions | undefined;
  let stopped!: () => void;
  const waiting = new Promise<void>(resolve => { stopped = resolve; });
  const client = { start: vi.fn(async () => undefined), stop: vi.fn(async () => { await waiting; return []; }) };
  const runtime = await PrivateControllerRuntime.start(i, undefined, options => { captured = options; return client as unknown as CopilotClient; });
  expect(captured?.workingDirectory).toBe(runtime.workingDirectory);
  expect(fs.readdirSync(runtime.workingDirectory)).toEqual([]);
  const closing = runtime.close();
  expect(runtime.close()).toBe(closing);
  await expect(PrivateControllerRuntime.start(i, undefined, () => client as unknown as CopilotClient)).rejects.toThrow("not been verified");
  expect(fs.existsSync(runtime.workingDirectory)).toBe(true);
  stopped(); await closing;
  expect(fs.existsSync(runtime.workingDirectory)).toBe(false);
  expect(client.stop).toHaveBeenCalledTimes(1);
});

it("refuses unknown controller state rather than deleting a possible previous runtime", async () => {
  const i = input(), previous = path.join(i.userData, "coding-controllers", "leftover");
  fs.mkdirSync(previous, { recursive: true }); fs.writeFileSync(path.join(previous, "keep"), "unknown runtime state");
  const create = vi.fn();
  await expect(PrivateControllerRuntime.start(i, undefined, create)).rejects.toThrow("not been verified");
  expect(create).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(previous, "keep"), "utf8")).toBe("unknown runtime state");
});

it("holds failed cleanup unavailable and retains the private state", async () => {
  const i = input({ retain: true });
  const client = { start: async () => undefined, stop: async () => [new Error("synthetic stop failure")] } as unknown as CopilotClient;
  const runtime = await PrivateControllerRuntime.start(i, undefined, () => client);
  const first = runtime.close(); await expect(first).rejects.toThrow("could not be stopped");
  expect(runtime.close()).toBe(first); expect(fs.existsSync(runtime.workingDirectory)).toBe(true);
  await expect(PrivateControllerRuntime.start(i, undefined, () => client)).rejects.toThrow("not been verified");
});
