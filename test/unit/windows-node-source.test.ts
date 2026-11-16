import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error -- host-only JavaScript source utility, outside the application's TypeScript build
import { sourcePin, prepareNodeSource, prepareNasmTool, validateSourceInputs } from "../../scripts/experimental/windows-node-source.mjs";

const roots: string[] = [];
// macOS's os.tmpdir() can use /var's system alias. Exercise the helpers against its canonical host directory.
const temporary = () => { const value = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ember-node-source-unit-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
const extractor = fileURLToPath(new URL("../../scripts/experimental/extract-node-source.py", import.meta.url));

// The synthetic pin exists only in this fixed unit process. Neither production entry point accepts replacement pins.
const fixture = String.raw`
import hashlib,importlib.util,io,json,os,pathlib,shutil,sys,tarfile
spec=importlib.util.spec_from_file_location("node_source",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(sys.argv[2]);root=pathlib.Path(sys.argv[3]);dest=root/"prepared";dest.mkdir();pin=m._pin();prefix=pin["sourceArchive"]["extractPrefix"]
core="  /* Initialize winsock */\n  uv__winsock_init();\n".replace("\\n","\n")
entries=c.get("entries",[{"path":"deps/uv/src/win/core.c","text":core},{"path":"README.md","text":"safe"}])
directories=set(["empty-dir"])
for e in entries:
 if e.get("kind")=="directory":directories.add(e["path"])
 for end in range(1,len(e["path"].split("/"))):
  parts=e["path"].split("/")[:end]
  if all(parts):directories.add("/".join(parts))
files=sorted([{"path":e["path"],"bytes":len(e.get("text","").encode()),"sha256":hashlib.sha256(e.get("text","").encode()).hexdigest()} for e in entries if e.get("kind","file")=="file"],key=lambda e:e["path"])
directories=sorted(directories)
pin["inventory"]={"entries":len(entries)+len(directories)+1,"files":len(files),"directories":len(directories),"stockBytes":sum(e["bytes"] for e in files),"stockManifestSha256":m._file_manifest(files),"directoryManifestSha256":m._directory_manifest(directories)}
patch=pin["patch"];patch["beforeBytes"]=len(core.encode());patch["beforeSha256"]=hashlib.sha256(core.encode()).hexdigest()
changed=core.replace(patch["needle"],patch["replacement"]).encode();patch["afterBytes"]=len(changed);patch["afterSha256"]=hashlib.sha256(changed).hexdigest()
offline=[dict(e,bytes=len(changed),sha256=patch["afterSha256"]) if e["path"]==patch["file"] else e for e in files]
pin["inventory"]["offlineBytes"]=sum(e["bytes"] for e in offline);pin["inventory"]["offlineManifestSha256"]=m._file_manifest(offline)
pin["limits"].update(c.get("limits",{}));m._pin=lambda:pin
buffer=io.BytesIO()
with tarfile.open(fileobj=buffer,mode="w") as archive:
 t=tarfile.TarInfo(prefix.rstrip("/"));t.type=tarfile.DIRTYPE;archive.addfile(t)
 for d in directories:
  t=tarfile.TarInfo(prefix+d);t.type=tarfile.DIRTYPE;archive.addfile(t)
 for e in entries:
  t=tarfile.TarInfo(prefix+e["path"]);t.mode=e.get("mode",0o644);kind=e.get("kind","file");data=e.get("text","").encode()
  if kind=="symlink":t.type=tarfile.SYMTYPE;t.linkname="outside"
  elif kind=="hardlink":t.type=tarfile.LNKTYPE;t.linkname=prefix+"README.md"
  elif kind=="fifo":t.type=tarfile.FIFOTYPE
  elif kind=="character":t.type=tarfile.CHRTYPE
  elif kind=="contiguous":t.type=tarfile.CONTTYPE
  else:t.size=len(data)
  archive.addfile(t,io.BytesIO(data) if kind=="file" else None)
buffer.seek(0)
try:
 if c.get("existing"):(dest/"baseline").mkdir();(dest/"baseline"/"owner.txt").write_text("owner")
 with tarfile.open(fileobj=buffer,mode="r:") as archive:m._extract_members(archive,str(dest),pin)
 scenario=c.get("scenario","");baseline=dest/"baseline";working=dest/"working"
 if scenario in ("baseline-extra","working-generated","working-generated-exact","working-generated-alias"):
  target=baseline if scenario=="baseline-extra" else working
  (target/"out").mkdir();(target/"out"/"generated.txt").write_text("generated")
  if scenario=="working-generated-alias":(root/"outside").mkdir();(target/"Release").symlink_to(root/"outside",target_is_directory=True)
 if scenario=="alter-input":(working/"README.md").write_text("evil")
 if scenario=="hardlink-input":
  (root/"outside.txt").write_text("safe");(working/"README.md").unlink();os.link(str(root/"outside.txt"),str(working/"README.md"))
 if scenario=="directory-alias":
  (working/"deps").rename(root/"outside");(working/"deps").symlink_to(root/"outside",target_is_directory=True)
 if scenario.startswith("catalog-"):
  q=dest/"source-inputs.json";catalog=json.loads(q.read_text())
  if scenario=="catalog-omit":catalog["files"].pop()
  elif scenario=="catalog-hash":catalog["files"][0]["sha256"]="0"*64
  elif scenario=="catalog-path":catalog["files"][0]["path"]="../outside"
  elif scenario=="catalog-directory":catalog["directories"][0]="invented"
  q.write_text(json.dumps(catalog))
 a=m.validate_source_inputs(str(baseline),"stock",scenario=="baseline-generated")
 b=m.validate_source_inputs(str(working),"offline",scenario in ("working-generated","working-generated-alias","alter-input","hardlink-input","directory-alias"))
 print(json.dumps({"ok":True,"baseline":a,"working":b,"catalogOutsideTrees":(dest/"source-inputs.json").is_file()}))
except m.SourceError as error:print(json.dumps({"ok":False,"stage":str(error),"baselineExists":(dest/"baseline").exists(),"ownerRetained":(dest/"baseline"/"owner.txt").is_file()}))
`;
function exercise(config: object) {
  const result = spawnSync(python, ["-B", "-c", fixture, extractor, JSON.stringify(config), temporary()], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; stage?: string; baselineExists?: boolean; ownerRetained?: boolean; baseline?: { allowGenerated: boolean }; working?: { allowGenerated: boolean }; catalogOutsideTrees?: boolean };
}

it("pins the signed full source and exact three Unicode exceptions without a checked-in 29K-file catalog", () => {
  expect(sourcePin.sourceArchive).toMatchObject({ bytes: 50_529_596, sha256: "6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a", extractPrefix: "node-v22.23.5/" });
  expect(sourcePin.inventory).toMatchObject({ entries: 32612, files: 29212, directories: 3399, stockBytes: 554315497,
    stockManifestSha256: "018a89c7504cb7bda4ccf6493f219d2da9344bb2c3f191d5ab7b6216c9049b7f",
    offlineManifestSha256: "8c185aeadfb6177c38573a52b22a6f66061b42a06271b05bacbcc58471a1f081" });
  expect(sourcePin.unicodePaths).toEqual(["test/fixtures/copy/utf/新建文件夹", "test/fixtures/copy/utf/新建文件夹/experimental.json", "test/fixtures/copy/utf/新建文件夹/index.js"]);
  expect(Object.isFrozen(sourcePin)).toBe(true); expect(Object.isFrozen(sourcePin.inventory)).toBe(true); expect(Object.isFrozen(sourcePin.unicodePaths)).toBe(true);
  expect(sourcePin).not.toHaveProperty("files");
});

it("checks archive length and full SHA before creating source roots or invoking Python", async () => {
  const root = temporary(), archivePath = path.join(root, "archive.xz"), destination = path.join(root, "result");
  fs.writeFileSync(archivePath, "not the release");
  await expect(prepareNodeSource({ archivePath, destination, pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
  const fd = fs.openSync(archivePath, "r+"); fs.ftruncateSync(fd, sourcePin.sourceArchive.bytes); fs.closeSync(fd);
  await expect(prepareNodeSource({ archivePath, destination, pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
});

it("refuses an aliased input root without following its contents", async () => {
  const root = temporary(), target = path.join(root, "real"), alias = path.join(root, "baseline"); fs.mkdirSync(target); fs.symlinkSync(target, alias, "junction");
  await expect(validateSourceInputs(alias, "stock", { pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
});

it.skipIf(!available)("prepares independent baseline and working trees and authenticates their complete catalogs", () => {
  expect(exercise({})).toMatchObject({ ok: true, baseline: { allowGenerated: false }, working: { allowGenerated: false }, catalogOutsideTrees: true });
});

it.skipIf(!available).each(["../outside", "src/../bad", "src/./bad", "/absolute", "C:/drive", "dir\\bad", "dir//bad", "file:stream", "file.", "file ", "bad\nname", "NUL", "LPT1.txt", "test/fixtures/copy/utf/新建文件夹/invented.js", "unlisted-中文"])("rejects an unsafe or unlisted source name: %s", name => {
  expect(exercise({ entries: [{ path: name, text: "data" }] })).toMatchObject({ ok: false, stage: "path", baselineExists: false });
});

it.skipIf(!available).each(["symlink", "hardlink", "fifo", "character", "contiguous"])("rejects %s archive members before creating either tree", kind => {
  expect(exercise({ entries: [{ path: "README.md", kind }] })).toMatchObject({ ok: false, stage: "entry", baselineExists: false });
});

it.skipIf(!available)("rejects case-alias duplicates, privileged modes and bounded inventory excesses", () => {
  expect(exercise({ entries: [{ path: "first", text: "a" }, { path: "FIRST", text: "b" }] })).toMatchObject({ ok: false, stage: "alias", baselineExists: false });
  expect(exercise({ entries: [{ path: "first", text: "a", mode: 0o4755 }] })).toMatchObject({ ok: false, stage: "entry", baselineExists: false });
  for (const limits of [{ files: 0 }, { directories: 0 }, { fileBytes: 1 }, { selectedBytes: 1 }, { archiveEntries: 0 }]) {
    expect(exercise({ limits })).toMatchObject({ ok: false, stage: "limits", baselineExists: false });
  }
});

it.skipIf(!available)("leaves an existing baseline and owner file intact", () => {
  expect(exercise({ existing: true })).toMatchObject({ ok: false, stage: "destination", ownerRetained: true });
});

it.skipIf(!available).each(["catalog-omit", "catalog-hash", "catalog-path", "catalog-directory"])("authenticates the entire mutable catalog before trusting it: %s", scenario => {
  expect(exercise({ scenario }).ok).toBe(false);
});

it.skipIf(!available).each(["baseline-extra", "working-generated-exact", "baseline-generated", "alter-input", "hardlink-input"])("retains original-input checks despite generated-output support: %s", scenario => {
  expect(exercise({ scenario }).ok).toBe(false);
});

it.skipIf(!available)("allows generated working outputs only when explicitly requested", () => {
  expect(exercise({ scenario: "working-generated" })).toMatchObject({ ok: true, working: { allowGenerated: true }, baseline: { allowGenerated: false } });
});

it.skipIf(!available || process.platform === "win32")("ignores a generated Release alias while refusing aliases in original input ancestors", () => {
  expect(exercise({ scenario: "working-generated-alias" })).toMatchObject({ ok: true, working: { allowGenerated: true } });
  expect(exercise({ scenario: "directory-alias" })).toMatchObject({ ok: false, stage: "alias" });
});

const nasmFixture = String.raw`
import hashlib,importlib.util,io,json,pathlib,stat,sys,zipfile
spec=importlib.util.spec_from_file_location("node_source",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(sys.argv[2]);root=pathlib.Path(sys.argv[3]);pin=m._pin();asset=pin["nasmTool"];data={"LICENSE":b"licence","nasm.exe":b"MZ-fixed-executable","ndisasm.exe":b"not-staged"}
for entry in asset["files"]:entry["bytes"]=len(data[entry["path"]]);entry["sha256"]=hashlib.sha256(data[entry["path"]]).hexdigest()
buffer=io.BytesIO();scenario=c.get("scenario","")
with zipfile.ZipFile(buffer,"w") as archive:
 for name,body in data.items():
  path=asset["extractPrefix"]+name
  if name=="nasm.exe" and scenario=="path":path=asset["extractPrefix"]+"../nasm.exe"
  item=zipfile.ZipInfo(path);item.external_attr=(stat.S_IFREG|0o644)<<16
  if name=="nasm.exe" and scenario=="symlink":item.external_attr=(stat.S_IFLNK|0o777)<<16
  if name=="nasm.exe" and scenario=="privileged":item.external_attr=(stat.S_IFREG|0o4755)<<16
  if name=="ndisasm.exe" and scenario=="unstaged-tamper":body=b"bad-staged"
  archive.writestr(item,body)
 if scenario=="extra":archive.writestr(asset["extractPrefix"]+"extra.dll",b"unexpected")
buffer.seek(0)
try:
 with zipfile.ZipFile(buffer,"r") as archive:
  if scenario=="encrypted":archive.filelist[1].flag_bits|=1
  receipt=m._stage_nasm_members(archive,str(root/"tool"),pin)
 print(json.dumps({"ok":True,"files":sorted(p.name for p in (root/"tool").iterdir()),"verifiedArchiveFiles":receipt["verifiedArchiveFiles"],"signatureVerified":receipt["signatureVerified"]}))
except m.SourceError as error:print(json.dumps({"ok":False,"stage":str(error),"destinationExists":(root/"tool").exists()}))
`;
function nasm(config: object) {
  const result = spawnSync(python, ["-I", "-B", "-c", nasmFixture, extractor, JSON.stringify(config), temporary()], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; stage?: string; destinationExists?: boolean; files?: string[]; verifiedArchiveFiles?: number; signatureVerified?: boolean };
}

it("pins NASM through official HTTPS and a historical independent SHA without claiming a signature", async () => {
  expect(sourcePin.nasmTool).toMatchObject({ version: "2.16.03", bytes: 513543, sha256: "3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6",
    provenance: { kind: "official-https-and-independent-historical-sha256", independentCommit: "362b99166f2c5e327aa3439dadbc79f639f96bf3" } });
  const root = temporary(), archivePath = path.join(root, "nasm.zip"), destination = path.join(root, "tool");
  fs.writeFileSync(archivePath, "not the pinned tool");
  await expect(prepareNasmTool({ archivePath, destination, pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
});

it.skipIf(!available)("verifies the complete NASM ZIP while staging only the compiler and licence", () => {
  expect(nasm({})).toEqual({ ok: true, files: ["LICENSE", "nasm.exe"], verifiedArchiveFiles: 3, signatureVerified: false });
});

it.skipIf(!available).each(["path", "symlink", "privileged", "encrypted", "unstaged-tamper", "extra"])("rejects unsafe NASM metadata or bytes before staging: %s", scenario => {
  expect(nasm({ scenario })).toMatchObject({ ok: false, destinationExists: false });
});
