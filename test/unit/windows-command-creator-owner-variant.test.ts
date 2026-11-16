/** Public run-source receipts only. Synthetic descriptors exercise refusal and one-attempt close without native calls. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fault: "", calls: [] as string[], next: 10,
  files: new Map<string, { bytes: Buffer; id: bigint }>(), descriptors: new Map<number, { file: string; bytes: Buffer }>(),
  lstats: new Map<string, number>(), fstats: new Map<number, number>(), readActual: undefined as ((file: string) => Buffer) | undefined,
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>(); state.readActual = file => actual.readFileSync(file);
  const get = (file: string) => {
    let value = state.files.get(file);
    if (!value) { value = { bytes: actual.readFileSync(file), id: BigInt(state.files.size + 1) }; state.files.set(file, value); }
    return value;
  };
  const stat = (file: string, held: boolean, count: number) => {
    const value = get(file), fault = state.fault, kind = held ? "fd" : "path";
    const clockChanged = count > 1 && fault.startsWith(kind);
    return { isFile: () => fault !== "kind" || !held, isSymbolicLink: () => fault === "symlink" && held,
      nlink: fault === "links" && held ? 2n : 1n, dev: fault === "device" && held ? 2n : 1n,
      ino: value.id + (fault === "inode" && held ? 1n : 0n), size: BigInt(value.bytes.length + (fault === "size" && held ? 1 : 0)),
      // Deliberately different cross-API clocks, stable within each API unless the selected mutation is injected.
      mtimeNs: (held ? 200n : 100n) + (clockChanged && fault.endsWith("mtime") ? 1n : 0n),
      ctimeNs: (held ? 400n : 300n) + (clockChanged && fault.endsWith("ctime") ? 1n : 0n),
    };
  };
  return { default: {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
    realpathSync: { native(file: string) { state.calls.push("realpath"); return state.fault === "root alias" ? file + "-alias" : file; } },
    lstatSync(file: string) {
      state.calls.push("lstat"); if (state.fault === "missing") throw new Error("PRIVATE source path");
      const count = (state.lstats.get(file) ?? 0) + 1; state.lstats.set(file, count); return stat(file, false, count);
    },
    openSync(file: string) {
      state.calls.push("open"); const fd = state.next++, original = get(file).bytes;
      const bytes = state.fault === "grow" ? Buffer.concat([original, Buffer.from([1])]) : Buffer.from(original);
      if (state.fault === "hash") bytes[0] ^= 1;
      state.descriptors.set(fd, { file, bytes }); return fd;
    },
    fstatSync(fd: number) {
      state.calls.push("fstat"); const count = (state.fstats.get(fd) ?? 0) + 1; state.fstats.set(fd, count);
      return stat(state.descriptors.get(fd)!.file, true, count);
    },
    readSync(fd: number, bytes: Buffer, offset: number, length: number, position: number) {
      state.calls.push("read"); if (state.fault === "read throw") throw new Error("PRIVATE read failure");
      if (state.fault === "short") return 0;
      if (state.fault === "fractional") return 0.5;
      if (state.fault === "oversized") return length + 1;
      return state.descriptors.get(fd)!.bytes.copy(bytes, offset, position, position + length);
    },
    closeSync(fd: number) { state.calls.push("close"); if (state.fault === "close") throw new Error("PRIVATE close failure"); state.descriptors.delete(fd); },
  } };
});

const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const input = { image: "windows-2022", commit: "a".repeat(40) };
beforeEach(() => {
  vi.resetModules(); state.fault = ""; state.calls.length = 0; state.next = 10;
  state.files.clear(); state.descriptors.clear(); state.lstats.clear(); state.fstats.clear();
});
const load = () => import("../fixtures/windows-command-creator-owner-variant");

it.each(["windows-2022", "windows-2025"])("binds fixed public baseline/run bytes and observed compile identity for %s", async image => {
  const { verifyWindowsCommandCreatorOwnerRun: verify, WINDOWS_COMMAND_CREATOR_OWNER_RUN: run } = await load();
  const result = verify(repository, { ...input, image });
  expect(result).toMatchObject({ ...run, compileCommit: input.commit, image: image === "windows-2022" ? 2022 : 2025 });
  expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(run)).toBe(true);
  expect(run.sourceBaseline).toBe("3afc9828168031bff6aaee46402397cecafea9f3"); expect(run.compiledIssuer).toBe("ember-root-only-creator-owner-observed-build-v1");
  expect(state.descriptors.size).toBe(0); expect(state.files.size).toBe(28);
  expect(state.calls.filter(call => call === "close")).toHaveLength(28);
});
it.each(["device", "inode", "size", "links", "kind", "symlink", "path mtime", "path ctime", "fd mtime", "fd ctime", "missing", "root alias",
  "hash", "grow", "short", "fractional", "oversized", "read throw"])("refuses changed or uncertain source boundary %s without a run receipt", async fault => {
  const { verifyWindowsCommandCreatorOwnerRun: verify } = await load(); state.fault = fault;
  let caught: unknown; try { verify(repository, input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error); expect((caught as Error).stack).not.toContain("PRIVATE"); expect(state.descriptors.size).toBe(0);
  expect(state.calls.filter(call => call === "open").length).toBeLessThanOrEqual(1);
});
it("retains the first uncertain source descriptor and blocks every future verify before any filesystem operation or close retry", async () => {
  const { verifyWindowsCommandCreatorOwnerRun: verify } = await load(); state.fault = "close";
  expect(() => verify(repository, input)).toThrow("fixed public run identity"); expect(state.descriptors.size).toBe(1);
  const before = [...state.calls]; state.fault = "";
  expect(() => verify(repository, input)).toThrow("fixed public run identity"); expect(state.calls).toEqual(before);
  expect(state.calls.filter(call => call === "close")).toHaveLength(1);
});
it.each([{ commit: undefined, image: "windows-2022" }, { commit: "private", image: "windows-2022" }, { commit: "b".repeat(40), image: "windows-latest" },
  { commit: "b".repeat(40), image: undefined }])("refuses unsupported observed run inputs before source acquisition %#", async value => {
  const { verifyWindowsCommandCreatorOwnerRun: verify } = await load(); expect(() => verify(repository, value)).toThrow(); expect(state.calls).toEqual([]);
});

it("allows only explicit dispatch or the exact dedicated PR head, while the original native job remains dispatch-only", async () => {
  await load();
  const workflow = state.readActual!(path.join(repository, ".github/workflows/experimental-windows-command-creator-owner.yml")).toString("utf8");
  const original = state.readActual!(path.join(repository, ".github/workflows/experimental-windows-command-copy.yml")).toString("utf8");
  const expression = workflow.split("    if: ")[1]?.split("\n")[0];
  const parsed = /^github\.event_name == 'workflow_dispatch' \|\| github\.head_ref == '([^']+)'$/.exec(expression ?? "");
  expect(parsed?.[1]).toBe("ember-improve/20261116-command-creator-owner");
  const runs = (event: string, head: string) => event === "workflow_dispatch" || head === parsed![1];
  expect(runs("pull_request", parsed![1])).toBe(true); expect(runs("pull_request", "other-head")).toBe(false);
  for (const head of [parsed![1], "other-head", ""]) expect(runs("workflow_dispatch", head)).toBe(true);
  expect(original.split("  native-copy:\n")[1]?.split("    if: ")[1]?.split("\n")[0]).toBe("github.event_name == 'workflow_dispatch'");
});
