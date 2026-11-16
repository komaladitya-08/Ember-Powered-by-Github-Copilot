/** Public run-source receipts only. Synthetic descriptors exercise refusal and one-attempt close without native calls. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { beforeEach, expect, it, vi } from "vitest";

// These independent literals identify only the three public sources changed by the later creator-owner experiment.
const baselineCommit = "3afc9828168031bff6aaee46402397cecafea9f3";
const baselinePins = [
  { path: "app/main/agent/windows-command-copy.ts", bytes: 12632, sha256: "33dac7049b83aa8f28fffdd24b26b4baef153fc1b15447b3e7dfaf46d3e2548f" },
  { path: "app/main/agent/windows-command-stop.ts", bytes: 23106, sha256: "87a0ed54fa4d38c1ec33846d6fe61f349ddfa04b2e8dbf5124edb458d2be3d21" },
  { path: "app/main/agent/windows-command-copy-native.ts", bytes: 46924, sha256: "9232f063867ad98185ac1fb056b6eca8c9740638cc83fe13ceff0e96773662f1" },
] as const;
const fixtureFile = fileURLToPath(new URL("../fixtures/windows-command-copy-detached-baseline.json", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fixtureFailure = () => new Error("The public detached-copy baseline fixture was refused.");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Decode data only: no baseline source is imported, evaluated, written or used by a runtime verifier. */
function decodeBaseline(bytes: Buffer): Map<string, Buffer> {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024) throw fixtureFailure();
    const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) throw fixtureFailure();
    const value: unknown = JSON.parse(text);
    if (!exact(value, ["schema", "commit", "encoding", "files"]) || value.schema !== 1 || value.commit !== baselineCommit ||
        value.encoding !== "gzip-base64" || !Array.isArray(value.files) || value.files.length !== baselinePins.length) throw fixtureFailure();
    const decoded = new Map<string, Buffer>();
    for (const [index, pin] of baselinePins.entries()) {
      const entry: unknown = value.files[index];
      if (!exact(entry, ["path", "bytes", "sha256", "gzipBase64"]) || entry.path !== pin.path || entry.bytes !== pin.bytes || entry.sha256 !== pin.sha256 ||
          typeof entry.gzipBase64 !== "string" || entry.gzipBase64.length < 4 || entry.gzipBase64.length > pin.bytes * 2 || entry.gzipBase64.length % 4 !== 0) throw fixtureFailure();
      const compressed = Buffer.from(entry.gzipBase64, "base64");
      if (compressed.length < 1 || compressed.length > pin.bytes || compressed.toString("base64") !== entry.gzipBase64) throw fixtureFailure();
      const source = gunzipSync(compressed, { maxOutputLength: pin.bytes });
      if (source.length !== pin.bytes || hash(source) !== pin.sha256) throw fixtureFailure();
      decoded.set(pin.path, source);
    }
    return decoded;
  } catch { throw fixtureFailure(); }
}

const state = vi.hoisted(() => ({ fault: "", baseline: true, calls: [] as string[], next: 10,
  files: new Map<string, { bytes: Buffer; id: bigint }>(), descriptors: new Map<number, { file: string; bytes: Buffer }>(),
  lstats: new Map<string, number>(), fstats: new Map<number, number>(), readActual: undefined as ((file: string) => Buffer) | undefined,
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>(); state.readActual = file => actual.readFileSync(file);
  const baseline = decodeBaseline(actual.readFileSync(fixtureFile));
  const get = (file: string) => {
    let value = state.files.get(file);
    if (!value) {
      const relative = path.relative(repository, file).split(path.sep).join("/"), source = state.baseline ? baseline.get(relative) : undefined;
      value = { bytes: source ? Buffer.from(source) : actual.readFileSync(file), id: BigInt(state.files.size + 1) }; state.files.set(file, value);
    }
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
  vi.resetModules(); state.fault = ""; state.baseline = true; state.calls.length = 0; state.next = 10;
  state.files.clear(); state.descriptors.clear(); state.lstats.clear(); state.fstats.clear();
});
const load = () => import("../fixtures/windows-command-copy-detached-variant");

it("uses only independently pinned public baseline bytes while the actual changed checkout remains refused", async () => {
  const { verifyWindowsRootCopyDetachedRun: verify } = await load(); state.baseline = false;
  expect(baselinePins.some(pin => hash(state.readActual!(path.join(repository, pin.path))) !== pin.sha256)).toBe(true);
  expect(() => verify(repository, input)).toThrow("fixed public run identity");
  expect(state.descriptors.size).toBe(0);
  expect(state.calls.filter(call => call === "open").length).toBe(state.calls.filter(call => call === "close").length);
});

it.each(["malformed", "oversized", "utf8", "schema", "commit", "encoding", "missing", "extra", "path", "size", "hash", "base64", "gzip", "truncated", "expanded", "content"])(
  "refuses corrupted or misattributed baseline fixture %s", async fault => {
    await load(); const original = state.readActual!(fixtureFile);
    if (fault === "malformed") { expect(() => decodeBaseline(Buffer.from("{"))).toThrow("baseline fixture"); return; }
    if (fault === "oversized") { expect(() => decodeBaseline(Buffer.alloc(64 * 1024 + 1))).toThrow("baseline fixture"); return; }
    if (fault === "utf8") { expect(() => decodeBaseline(Buffer.from([255]))).toThrow("baseline fixture"); return; }
    const value = JSON.parse(original.toString("utf8")) as { schema: number; commit: string; encoding: string;
      files: { path: string; bytes: number; sha256: string; gzipBase64: string }[] };
    if (fault === "schema") value.schema = 2;
    if (fault === "commit") value.commit = "b".repeat(40);
    if (fault === "encoding") value.encoding = "base64";
    if (fault === "missing") value.files.pop();
    if (fault === "extra") value.files.push({ ...value.files[0] });
    if (fault === "path") value.files[0].path = baselinePins[1].path;
    if (fault === "size") value.files[0].bytes++;
    if (fault === "hash") value.files[0].sha256 = "0".repeat(64);
    if (fault === "base64") value.files[0].gzipBase64 = "\n" + value.files[0].gzipBase64;
    if (fault === "gzip") value.files[0].gzipBase64 = Buffer.from("invalid gzip").toString("base64");
    if (fault === "truncated") value.files[0].gzipBase64 = Buffer.from(value.files[0].gzipBase64, "base64").subarray(0, 20).toString("base64");
    if (fault === "expanded") value.files[0].gzipBase64 = gzipSync(Buffer.alloc(baselinePins[0].bytes + 1)).toString("base64");
    if (fault === "content") {
      const source = gunzipSync(Buffer.from(value.files[0].gzipBase64, "base64"), { maxOutputLength: baselinePins[0].bytes }); source[0] ^= 1;
      value.files[0].gzipBase64 = gzipSync(source).toString("base64");
    }
    expect(() => decodeBaseline(Buffer.from(JSON.stringify(value)))).toThrow("baseline fixture");
  },
);

it.each(["windows-2022", "windows-2025"])("binds fixed public baseline/run bytes and observed compile identity for %s", async image => {
  const { verifyWindowsRootCopyDetachedRun: verify, WINDOWS_ROOT_COPY_DETACHED_RUN: run } = await load();
  const result = verify(repository, { ...input, image });
  expect(result).toMatchObject({ ...run, compileCommit: input.commit, image: image === "windows-2022" ? 2022 : 2025 });
  expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(run)).toBe(true);
  expect(run.sourceBaseline).toBe("8b57398c1671505271d1158df249b13f5524b317"); expect(run.compiledIssuer).toBe("ember-root-only-host-observed-build-v1");
  expect(state.descriptors.size).toBe(0); expect(state.files.size).toBe(18);
  expect(state.calls.filter(call => call === "close")).toHaveLength(18);
});
it.each(["device", "inode", "size", "links", "kind", "symlink", "path mtime", "path ctime", "fd mtime", "fd ctime", "missing", "root alias",
  "hash", "grow", "short", "fractional", "oversized", "read throw"])("refuses changed or uncertain source boundary %s without a run receipt", async fault => {
  const { verifyWindowsRootCopyDetachedRun: verify } = await load(); state.fault = fault;
  let caught: unknown; try { verify(repository, input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error); expect((caught as Error).stack).not.toContain("PRIVATE"); expect(state.descriptors.size).toBe(0);
  expect(state.calls.filter(call => call === "open").length).toBeLessThanOrEqual(1);
});
it("retains the first uncertain source descriptor and blocks every future verify before any filesystem operation or close retry", async () => {
  const { verifyWindowsRootCopyDetachedRun: verify } = await load(); state.fault = "close";
  expect(() => verify(repository, input)).toThrow("fixed public run identity"); expect(state.descriptors.size).toBe(1);
  const before = [...state.calls]; state.fault = "";
  expect(() => verify(repository, input)).toThrow("fixed public run identity"); expect(state.calls).toEqual(before);
  expect(state.calls.filter(call => call === "close")).toHaveLength(1);
});
it.each([{ commit: undefined, image: "windows-2022" }, { commit: "private", image: "windows-2022" }, { commit: "b".repeat(40), image: "windows-latest" },
  { commit: "b".repeat(40), image: undefined }])("refuses unsupported observed run inputs before source acquisition %#", async value => {
  const { verifyWindowsRootCopyDetachedRun: verify } = await load(); expect(() => verify(repository, value)).toThrow(); expect(state.calls).toEqual([]);
});
it("keeps the actual copied proof byte-identical after only its reviewed loader import and public export substitutions", async () => {
  await load();
  const read = (file: string) => state.readActual!(path.join(repository, file)).toString("utf8");
  const original = read("test/fixtures/windows-command-copy-proof.ts");
  const expected = original.replace('import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";',
    'import { loadWindowsRootCopyDetachedApi as loadExperimentalWindowsLpacApi } from "./windows-command-copy-detached-loader";')
    .replace("export async function observeWindowsCommandCopy(", "export async function observeWindowsCommandCopyDetached(");
  expect(read("test/fixtures/windows-command-copy-detached-proof.ts")).toBe(expected);
});
it("allows only explicit dispatch or the exact dedicated PR head, while the original native job remains dispatch-only", async () => {
  await load();
  const workflow = state.readActual!(path.join(repository, ".github/workflows/experimental-windows-command-copy-detached.yml")).toString("utf8");
  const original = state.readActual!(path.join(repository, ".github/workflows/experimental-windows-command-copy.yml")).toString("utf8");
  const expression = workflow.split("    if: ")[1]?.split("\n")[0];
  const parsed = /^github\.event_name == 'workflow_dispatch' \|\| github\.head_ref == '([^']+)'$/.exec(expression ?? "");
  expect(parsed?.[1]).toBe("ember-improve/20261116-root-copy-detached");
  const runs = (event: string, head: string) => event === "workflow_dispatch" || head === parsed![1];
  expect(runs("pull_request", parsed![1])).toBe(true); expect(runs("pull_request", "other-head")).toBe(false);
  for (const head of [parsed![1], "other-head", ""]) expect(runs("workflow_dispatch", head)).toBe(true);
  expect(original.split("  native-copy:\n")[1]?.split("    if: ")[1]?.split("\n")[0]).toBe("github.event_name == 'workflow_dispatch'");
});
