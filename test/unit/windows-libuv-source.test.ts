import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error -- standalone host-only JavaScript asset preparer, outside the application's TypeScript build
import { sourcePin, applyOfflineCorePatch, prepareWindowsLibuvSource, validateSourceTree } from "../../scripts/experimental/windows-libuv-source.mjs";

const temporary: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-libuv-source-unit-")); temporary.push(root); return root; };
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const python = process.platform === "win32" ? "python" : "python3";
const pythonAvailable = spawnSync(python, ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
const extractor = fileURLToPath(new URL("../../scripts/experimental/extract-node-libuv-source.py", import.meta.url));

// Import the pure helper only inside this unit-test process. The production Python CLI has no test mode or pin override.
const pythonFixture = String.raw`
import hashlib,importlib.util,io,json,pathlib,sys,tarfile
spec=importlib.util.spec_from_file_location("libuv_source",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(sys.argv[2]);root=pathlib.Path(sys.argv[3]);dest=root/"result";prefix="node-v22.23.5/deps/uv/"
entries=c["entries"]
manifest=c.get("manifest",[{"path":e["name"],"bytes":len(e.get("text","").encode()),"sha256":hashlib.sha256(e.get("text","").encode()).hexdigest()} for e in entries if e.get("kind","file")=="file" and not e.get("outside")])
directories=c.get("directories",[e["name"] for e in entries if e.get("kind")=="directory" and not e.get("outside")])
limits={"fileBytes":4194304,"selectedBytes":33554432,"files":1000,"archiveEntries":100000};limits.update(c.get("limits",{}))
if c.get("existing"):dest.mkdir();(dest/"owner.txt").write_text("existing owner")
if c.get("symlinkParent"):
 (root/"outside").mkdir();(root/"alias").symlink_to(root/"outside",target_is_directory=True);dest=root/"alias"/"result"
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode="w") as archive:
 for e in entries:
  item=tarfile.TarInfo(("elsewhere/" if e.get("outside") else prefix)+e["name"]);kind=e.get("kind","file");data=e.get("text","").encode();item.mode=e.get("mode",0o644)
  if kind=="directory":item.type=tarfile.DIRTYPE
  elif kind=="symlink":item.type=tarfile.SYMTYPE;item.linkname="outside.txt"
  elif kind=="hardlink":item.type=tarfile.LNKTYPE;item.linkname=prefix+"first.c"
  elif kind=="fifo":item.type=tarfile.FIFOTYPE
  elif kind=="character":item.type=tarfile.CHRTYPE
  elif kind=="contiguous":item.type=tarfile.CONTTYPE
  else:item.size=len(data)
  archive.addfile(item,io.BytesIO(data) if kind=="file" else None)
buffer.seek(0)
try:
 with tarfile.open(fileobj=buffer,mode="r:") as archive:records=m._extract_members(archive,str(dest),manifest,directories,limits,prefix)
 print(json.dumps({"ok":True,"records":records,"written":sorted(str(p.relative_to(dest)).replace("\\","/") for p in dest.rglob("*") if p.is_file())}))
except m.SourceError as error:print(json.dumps({"ok":False,"stage":str(error),"destinationExists":dest.exists(),"existingRetained":(dest/"owner.txt").is_file()}))
`;
function extract(config: object) {
  const result = spawnSync(python, ["-B", "-c", pythonFixture, extractor, JSON.stringify(config), temp()], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; stage?: string; destinationExists?: boolean; existingRetained?: boolean; records?: { path: string; bytes: number; sha256: string }[]; written?: string[] };
}

it("pins the independently signed Node source, exact release identity and bounded one-call offline patch", () => {
  expect(sourcePin).toMatchObject({ issuer: "ember-experimental-libuv-fixed-probe", version: "22.23.5",
    sourceArchive: { url: "https://nodejs.org/dist/v22.23.5/node-v22.23.5.tar.xz", bytes: 50_529_596, sha256: "6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a", extractPrefix: "node-v22.23.5/deps/uv/" },
    provenance: { signingFingerprint: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356", keyRepositoryCommit: "481637f813e912c4aa3622d7964ab426c97b8e8d", commit: "60553651579ec33ca1aef9e1eedab2c3855f1f7e" },
    limits: { selectedBytes: 32 * 1024 * 1024, files: 1000, fileBytes: 4 * 1024 * 1024 },
    patch: { beforeSha256: "3026f2888b3360e65a2e2662508eef6ba9b1af17735391ca6f79dc06887b8b23", afterSha256: "143dffcfb49431866d97017d71d108aeffac7c35ca1de1f82b9106f554aa6c52", macro: "EMBER_UV_FIXED_PROBE_OFFLINE", value: 1 } });
  expect(Object.isFrozen(sourcePin)).toBe(true); expect(Object.isFrozen(sourcePin.sourceArchive)).toBe(true);
  expect(Object.isFrozen(sourcePin.files)).toBe(true); expect(sourcePin.files.every(Object.isFrozen)).toBe(true);
  expect(sourcePin.patch.replacement).toContain("#if !defined(EMBER_UV_FIXED_PROBE_OFFLINE) || EMBER_UV_FIXED_PROBE_OFFLINE != 1");
  expect(sourcePin.patch.replacement).not.toMatch(/GetSystemMetrics|SM_CLEANBOOT|WSAStartup|catch|registry|capability/);
});

it("does not patch merely similar, truncated or caller-invented source", () => {
  for (const value of [Buffer.from(sourcePin.patch.needle), Buffer.alloc(sourcePin.patch.beforeBytes), Buffer.from("private source path")]) {
    expect(() => applyOfflineCorePatch(value)).toThrow("could not be verified");
  }
});

it("refuses an incorrect archive size before creating a destination or invoking an extractor", async () => {
  const root = temp(), archivePath = path.join(root, "source.tar.xz"), destination = path.join(root, "prepared");
  fs.writeFileSync(archivePath, "not the signed archive");
  await expect(prepareWindowsLibuvSource({ archivePath, destination, pythonPath: "never-execute-this" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
});

it("requires the complete source hash even when the archive has exactly the pinned byte count", async () => {
  const root = temp(), archivePath = path.join(root, "source.tar.xz"), destination = path.join(root, "prepared");
  const fd = fs.openSync(archivePath, "wx"); fs.ftruncateSync(fd, sourcePin.sourceArchive.bytes); fs.closeSync(fd);
  await expect(prepareWindowsLibuvSource({ archivePath, destination, pythonPath: "never-execute-this" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
});

it("requires the entire fixed source tree rather than trusting a partial directory or forged receipt", async () => {
  const root = temp(); fs.writeFileSync(path.join(root, "source-receipt.json"), JSON.stringify({ manifestSha256: sourcePin.stockManifestSha256 }));
  await expect(validateSourceTree(root)).rejects.toThrow("could not be verified");
  await expect(validateSourceTree(root, "caller-selected")).rejects.toThrow("could not be verified");
});

it("rejects a directory alias instead of following it as a source root", async () => {
  const root = temp(), ordinary = path.join(root, "ordinary"), alias = path.join(root, "alias");
  fs.mkdirSync(ordinary); fs.writeFileSync(path.join(ordinary, "owner.txt"), "existing owner");
  fs.symlinkSync(ordinary, alias, "junction");
  await expect(validateSourceTree(alias)).rejects.toThrow("could not be verified");
  expect(fs.readFileSync(path.join(ordinary, "owner.txt"), "utf8")).toBe("existing owner");
});

it.skipIf(!pythonAvailable)("extracts only declared ordinary libuv members, preserving hidden metadata files and exact bytes", () => {
  const result = extract({ entries: [{ name: "src", kind: "directory" }, { name: "src/first.c", text: "int main(void) { return 0; }\n" },
    { name: ".gitattributes", text: "metadata\n" }, { name: "ignored", kind: "symlink", outside: true }] });
  expect(result.ok).toBe(true); expect(result.written).toEqual([".gitattributes", "src/first.c"]);
  expect(result.records).toEqual([expect.objectContaining({ path: ".gitattributes", bytes: 9 }), expect.objectContaining({ path: "src/first.c", bytes: 29 })]);
});

it.skipIf(!pythonAvailable).each(["../outside.c", "src/../outside.c", "src/./first.c", "/absolute.c", "C:/drive.c", "src\\outside.c", "src//first.c", "first.c:stream", "first.c.", "first.c ", "bad\nname.c", "bad\0name.c", "NUL", "con.txt", "LPT9.log"])("rejects unsafe archive-relative names before writing: %s", name => {
  expect(extract({ entries: [{ name, text: "bad" }] })).toMatchObject({ ok: false, stage: "path", destinationExists: false });
});

it.skipIf(!pythonAvailable).each(["symlink", "hardlink", "fifo", "character", "contiguous"])("refuses selected %s entries before creating a destination", kind => {
  expect(extract({ entries: [{ name: "first.c", kind }] })).toMatchObject({ ok: false, stage: "entry", destinationExists: false });
});

it.skipIf(!pythonAvailable)("refuses duplicate and Windows case-alias members", () => {
  for (const entries of [[{ name: "first.c", text: "one" }, { name: "first.c", text: "two" }], [{ name: "first.c", text: "one" }, { name: "FIRST.C", text: "two" }]]) {
    expect(extract({ entries })).toMatchObject({ ok: false, destinationExists: false });
  }
});

it.skipIf(!pythonAvailable).each([
  { fileBytes: 2 }, { selectedBytes: 2 }, { files: 0 }, { archiveEntries: 0 },
])("enforces a bounded extraction before writing: %j", limits => {
  expect(extract({ entries: [{ name: "first.c", text: "three" }], limits })).toMatchObject({ ok: false, stage: "limits", destinationExists: false });
});

it.skipIf(!pythonAvailable)("leaves an existing destination and its contents untouched", () => {
  expect(extract({ entries: [{ name: "first.c", text: "content" }], existing: true })).toMatchObject({ ok: false, stage: "destination", existingRetained: true });
});

it.skipIf(!pythonAvailable || process.platform === "win32")("refuses an existing symbolic-link ancestor before creating output", () => {
  expect(extract({ entries: [{ name: "first.c", text: "content" }], symlinkParent: true })).toMatchObject({ ok: false, stage: "destination", destinationExists: false });
});

it.skipIf(!pythonAvailable)("refuses privilege-bearing file modes and mismatched directory inventories before writing", () => {
  expect(extract({ entries: [{ name: "first.c", text: "content", mode: 0o4755 }] })).toMatchObject({ ok: false, stage: "entry", destinationExists: false });
  expect(extract({ entries: [{ name: "first.c", text: "content" }], directories: ["missing"] })).toMatchObject({ ok: false, stage: "manifest", destinationExists: false });
});

it.skipIf(!pythonAvailable)("rejects a selected file whose bytes differ from its expected manifest", () => {
  const result = extract({ entries: [{ name: "first.c", text: "altered" }], manifest: [{ path: "first.c", bytes: 7, sha256: "0".repeat(64) }] });
  expect(result).toMatchObject({ ok: false, stage: "manifest" });
});
