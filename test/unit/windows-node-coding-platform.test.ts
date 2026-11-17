/** Adapter routing only: private-branded class model, no Native workspace or Node capability proof. */
import { afterEach, expect, it, vi } from "vitest";
import type { PathFact, RunnerFacts } from "../../app/main/commands/types";
import type { CodingCommandWorkspace, CodingFileBroker } from "../../app/main/agent/coding-platform";

const model = vi.hoisted(() => {
  class Workspace {
    #broker: unknown; #available: boolean;
    readonly signals: AbortSignal[] = [];
    constructor(broker: unknown, available = true) { this.#broker = broker; this.#available = available; }
    get nodeAvailable(): boolean { return this.#available; }
    async filesBroker(signal: AbortSignal): Promise<unknown> { this.signals.push(signal); return this.#broker; }
  }
  const ports = Object.freeze({ available: Object.getOwnPropertyDescriptor(Workspace.prototype, "nodeAvailable")!.get!, filesBroker: Workspace.prototype.filesBroker });
  return { Workspace, ports };
});
vi.mock("../../app/main/agent/windows-node-workspace", () => ({ WindowsNodeWorkspace: model.Workspace, windowsNodeWorkspacePorts: () => model.ports }));
import { windowsNodeCodingPlatform, WINDOWS_NODE_CODING_CONSTRAINTS } from "../../app/main/agent/windows-node-coding-platform";

afterEach(() => { vi.restoreAllMocks(); });
const hostFacts: RunnerFacts = { os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: { path: "/usr/bin/script", kind: "util-linux" },
  home: "/private/home", user: "host-user", privileged: true, pty: true, extraPath: ["/private/bin"],
  ember: { paths: ["C:\\private\\Ember"], pids: [123], names: /ember/i }, wsl: { mountRoot: "/mnt", interop: true, windows: null } };
const asWorkspace = (value: unknown) => value as CodingCommandWorkspace;
function setup(facts: (paths: readonly string[], cwd?: string) => Promise<PathFact[]> = async paths => paths.map(path => ({ exists: true, real: path }))) {
  const inspect = vi.fn(facts), calls: { receiver: unknown; path?: string }[] = [];
  const broker = { inspect,
    readText(this: unknown, path: string) { calls.push({ receiver: this, path }); return Promise.resolve({ path, text: "safe", sha256: "a".repeat(64), bytes: 4, totalLines: 1, startLine: 1, endLine: 1 }); },
    close(this: unknown) { calls.push({ receiver: this }); return Promise.resolve(); },
  } as unknown as CodingFileBroker;
  const owner = new model.Workspace(broker), workspace = asWorkspace(owner);
  return { owner, workspace, broker, inspect, calls };
}

it("advertises genuine Windows Node-only inventory and keeps host protections without host paths or shell capabilities", () => {
  const f = setup(), facts = windowsNodeCodingPlatform.facts(f.workspace, hostFacts);
  expect(facts).toEqual({ os: "win32", shells: [], shellPaths: {}, script: null, home: "/work", user: "", privileged: true,
    pty: false, extraPath: [], ember: hostFacts.ember });
  expect(Object.hasOwn(facts, "wsl")).toBe(false); expect(Object.hasOwn(facts, "codingToolchain")).toBe(false);
  facts.ember.paths.push("another"); facts.ember.pids.push(456);
  expect(hostFacts.ember.paths).toEqual(["C:\\private\\Ember"]); expect(hostFacts.ember.pids).toEqual([123]);
  expect(facts.ember.names).not.toBe(hostFacts.ember.names);
  expect(WINDOWS_NODE_CODING_CONSTRAINTS).toContain("literal argv"); expect(WINDOWS_NODE_CODING_CONSTRAINTS).toContain("/work as cwd");
});
it("refuses structural, serialized, prototype, Proxy and unavailable claims before broker delegation", async () => {
  const f = setup(), forgedBroker = vi.fn();
  const forged = Object.create(model.Workspace.prototype);
  Object.defineProperties(forged, { nodeAvailable: { value: true }, filesBroker: { value: forgedBroker } });
  const shadowed = new model.Workspace(f.broker, false); Object.defineProperty(shadowed, "nodeAvailable", { value: true });
  for (const candidate of [{ nodeAvailable: true, filesBroker: forgedBroker }, { scope: "windows-node-workspace" }, forged, new Proxy(f.owner, {}), shadowed]) {
    expect(() => windowsNodeCodingPlatform.facts(asWorkspace(candidate), hostFacts)).toThrow(expect.objectContaining({ code: "boundary" }));
    await expect(windowsNodeCodingPlatform.files(asWorkspace(candidate), new AbortController().signal)).rejects.toMatchObject({ code: "boundary" });
  }
  expect(forgedBroker).not.toHaveBeenCalled(); expect(f.owner.signals).toEqual([]);
});
it("uses the captured branded getter and broker method despite own-property shadows", async () => {
  const f = setup(), shadow = vi.fn(), signal = new AbortController().signal;
  Object.defineProperty(f.owner, "filesBroker", { value: shadow }); Object.defineProperty(f.owner, "nodeAvailable", { get: shadow });
  const files = await windowsNodeCodingPlatform.files(f.workspace, signal);
  expect(f.owner.signals).toEqual([signal]); expect(shadow).not.toHaveBeenCalled();
  expect(await files.readText("app.ts")).toMatchObject({ path: "app.ts", text: "safe" }); await files.close();
  expect(f.calls).toEqual([{ receiver: f.broker, path: "app.ts" }, { receiver: f.broker }]);
});
it("maps logical Windows policy probes and broker facts without changing caller strings", async () => {
  const f = setup(async () => [{ exists: true, real: "/work", dir: true }, { exists: true, real: "/work/Src/App.ts" }, { exists: false, real: "/work/new.ts" }]);
  const files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal), paths = ["\\work", "\\WORK\\Src\\App.ts", "/work/new.ts"], original = [...paths];
  expect(await files.inspect(paths)).toEqual([{ exists: true, real: "\\work", dir: true }, { exists: true, real: "\\work\\Src\\App.ts" }, { exists: false, real: "\\work\\new.ts" }]);
  expect(f.inspect).toHaveBeenCalledExactlyOnceWith(["/work", "/work/Src/App.ts", "/work/new.ts"], "/work"); expect(paths).toEqual(original);
});
it("maps a nested logical inspect cwd independently of the root-only execution contract", async () => {
  const f = setup(), files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal);
  expect(await files.inspect(["App.ts", "/work/root.ts"], "\\work\\Src")).toEqual([
    { exists: true, real: "\\work\\Src\\App.ts" }, { exists: true, real: "\\work\\root.ts" },
  ]);
  expect(f.inspect).toHaveBeenCalledExactlyOnceWith(["/work/Src/App.ts", "/work/root.ts"], "/work/Src");
});
it("keeps drives, UNC, devices, streams and escaping or ambiguous paths unknown without probing them", async () => {
  const f = setup(), files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal);
  const paths = ["C:\\private\\secret", "C:relative", "\\\\host\\share", "\\\\?\\C:\\private", "\\outside", "\\work\\..\\escape", "/work/file:stream", "/workx/app", "//work/app", "/work/CON", "/work/hidden\0name", "/work/ok.ts"];
  const facts = await files.inspect(paths);
  expect(facts.slice(0, -1)).toEqual(paths.slice(0, -1).map(() => ({ exists: null, real: null })));
  expect(facts.at(-1)).toEqual({ exists: true, real: "\\work\\ok.ts" });
  expect(f.inspect).toHaveBeenCalledExactlyOnceWith(["/work/ok.ts"], "/work");
});
it("invalid inspect cwd never falls back to any host folder", async () => {
  const f = setup(), files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal);
  expect(await files.inspect(["app.ts"], "C:\\private")).toEqual([{ exists: null, real: null }]);
  expect(f.inspect).not.toHaveBeenCalled();
});
it("does not expose host or escaping paths from malformed facts and preserves unknown positions", async () => {
  const f = setup(async () => [{ exists: true, real: "C:\\private" }, { exists: false, real: "/work/../private" }, { exists: null, real: null }]);
  const files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal);
  expect(await files.inspect(["a", "b", "c"])).toEqual([0, 1, 2].map(() => ({ exists: null, real: null })));
});
it("refuses excessive probes and ignores a mismatched broker result without fabricating missing facts", async () => {
  const f = setup(async () => []), files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal);
  await expect(files.inspect(Array.from({ length: 201 }, () => "app.ts"))).rejects.toMatchObject({ code: "limit" });
  expect(f.inspect).not.toHaveBeenCalled();
  expect(await files.inspect(["app.ts"])).toEqual([{ exists: null, real: null }]);
});
it("snapshots logical probe arguments before waiting on the broker", async () => {
  let settle!: (facts: PathFact[]) => void;
  const f = setup(() => new Promise(resolve => { settle = resolve; })), files = await windowsNodeCodingPlatform.files(f.workspace, new AbortController().signal);
  const paths = ["\\work\\app.ts"], pending = files.inspect(paths); paths[0] = "C:\\private";
  settle([{ exists: true, real: "/work/app.ts" }]);
  expect(await pending).toEqual([{ exists: true, real: "\\work\\app.ts" }]);
  expect(f.inspect).toHaveBeenCalledExactlyOnceWith(["/work/app.ts"], "/work");
});
