import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error -- host-only JavaScript source utility, outside the application's TypeScript build
import { sourcePin, prepareNodePosixSource, prepareNodePosixNasmTool, validateNodePosixSourceInputs } from "../../scripts/experimental/windows-node-posix-source.mjs";

const roots: string[] = [];
// macOS's os.tmpdir() can use /var's system alias. Exercise the helpers against its canonical host directory.
const temporary = () => { const value = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ember-node-source-unit-")); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });
const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
const extractor = fileURLToPath(new URL("../../scripts/experimental/extract-node-posix-source.py", import.meta.url));

// The synthetic pin exists only in this fixed unit process. Neither production entry point accepts replacement pins.
const fixture = String.raw`
import hashlib,importlib.util,io,json,os,pathlib,shutil,sys,tarfile
spec=importlib.util.spec_from_file_location("node_source",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=json.loads(sys.argv[2]);root=pathlib.Path(sys.argv[3]);dest=root/"prepared";dest.mkdir();pin=m._pin();prefix=pin["sourceArchive"]["extractPrefix"]
core="  /* Initialize winsock */\n  uv__winsock_init();\n".replace("\\n","\n")
texts=dict((patch["file"],patch["needle"]+"\n") for patch in pin["patches"]);texts[pin["patch"]["file"]]=core
entries=c.get("entries",[{"path":name,"text":text} for name,text in texts.items()]+[{"path":"README.md","text":"safe"}])
directories=set(["empty-dir"])
for e in entries:
 if e.get("kind")=="directory":directories.add(e["path"])
 for end in range(1,len(e["path"].split("/"))):
  parts=e["path"].split("/")[:end]
  if all(parts):directories.add("/".join(parts))
files=sorted([{"path":e["path"],"bytes":len(e.get("text","").encode()),"sha256":hashlib.sha256(e.get("text","").encode()).hexdigest()} for e in entries if e.get("kind","file")=="file"],key=lambda e:e["path"])
directories=sorted(directories)
pin["inventory"]={"entries":len(entries)+len(directories)+1,"files":len(files),"directories":len(directories),"stockBytes":sum(e["bytes"] for e in files),"stockManifestSha256":m._file_manifest(files),"directoryManifestSha256":m._directory_manifest(directories)}
changed={}
for patch in pin["patches"]:
 data=texts[patch["file"]].encode();patch["beforeBytes"]=len(data);patch["beforeSha256"]=hashlib.sha256(data).hexdigest()
 body=data.replace(patch["needle"].encode(),patch["replacement"].encode());patch["afterBytes"]=len(body);patch["afterSha256"]=hashlib.sha256(body).hexdigest();changed[patch["file"]]=patch
pin["patch"]=pin["patches"][0]
offline=[dict(e,bytes=changed[e["path"]]["afterBytes"],sha256=changed[e["path"]]["afterSha256"]) if e["path"] in changed else e for e in files]
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
if c.get("scenario")=="patch-list-count":pin["patches"].pop()
if c.get("scenario")=="patch-list-foreign":pin["patches"][1]["file"]="README.md"
if c.get("scenario")=="patch-list-order":pin["patches"][1:]=list(reversed(pin["patches"][1:]))
try:
 if c.get("existing"):(dest/"baseline").mkdir();(dest/"baseline"/"owner.txt").write_text("owner")
 with tarfile.open(fileobj=buffer,mode="r:") as archive:m._extract_members(archive,str(dest),pin)
 scenario=c.get("scenario","");baseline=dest/"baseline";working=dest/"working"
 if scenario in ("baseline-extra","working-generated","working-generated-exact","working-generated-alias"):
  target=baseline if scenario=="baseline-extra" else working
  (target/"out").mkdir();(target/"out"/"generated.txt").write_text("generated")
  if scenario=="working-generated-alias":(root/"outside").mkdir();(target/"Release").symlink_to(root/"outside",target_is_directory=True)
 if scenario=="alter-input":(working/"README.md").write_text("evil")
 if scenario=="alter-cng":working.joinpath(*pin["patches"][1]["file"].split("/")).write_text("evil")
 if scenario=="alter-local":working.joinpath(*pin["patches"][2]["file"].split("/")).write_text("evil")
 if scenario=="alter-rename":working.joinpath(*pin["patches"][3]["file"].split("/")).write_text("evil")
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
  elif scenario=="catalog-patch":
   for entry in catalog["files"]:
    if entry["path"]==pin["patches"][1]["file"]:entry["sha256"]=pin["patches"][1]["afterSha256"]
  q.write_text(json.dumps(catalog))
 a=m.validate_source_inputs(str(baseline),"stock",scenario=="baseline-generated")
 b=m.validate_source_inputs(str(working),"offline",scenario in ("working-generated","working-generated-alias","alter-input","alter-cng","alter-local","alter-rename","hardlink-input","directory-alias"))
 print(json.dumps({"ok":True,"baseline":a,"working":b,"catalogOutsideTrees":(dest/"source-inputs.json").is_file()}))
except m.SourceError as error:print(json.dumps({"ok":False,"stage":str(error),"baselineExists":(dest/"baseline").exists(),"ownerRetained":(dest/"baseline"/"owner.txt").is_file()}))
`;
function exercise(config: object) {
  const result = spawnSync(python, ["-B", "-c", fixture, extractor, JSON.stringify(config), temporary()], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  expect(result.status, "The fixed source fixture must complete without forwarding private interpreter errors.").toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; stage?: string; baselineExists?: boolean; ownerRetained?: boolean; baseline?: { allowGenerated: boolean }; working?: { allowGenerated: boolean }; catalogOutsideTrees?: boolean };
}

it("pins the signed full source and exact three Unicode exceptions without a checked-in 29K-file catalog", () => {
  expect(sourcePin.sourceArchive).toMatchObject({ bytes: 50_529_596, sha256: "6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a", extractPrefix: "node-v22.23.5/" });
  expect(sourcePin.inventory).toMatchObject({ entries: 32612, files: 29212, directories: 3399, stockBytes: 554315497,
    stockManifestSha256: "018a89c7504cb7bda4ccf6493f219d2da9344bb2c3f191d5ab7b6216c9049b7f",
    offlineManifestSha256: "57f2e7be04d3f238af4bc97b660d68f42638db81ed3265e86a4f2c3a115de4d8" });
  expect(sourcePin.unicodePaths).toEqual(["test/fixtures/copy/utf/新建文件夹", "test/fixtures/copy/utf/新建文件夹/experimental.json", "test/fixtures/copy/utf/新建文件夹/index.js"]);
  expect(Object.isFrozen(sourcePin)).toBe(true); expect(Object.isFrozen(sourcePin.inventory)).toBe(true); expect(Object.isFrozen(sourcePin.unicodePaths)).toBe(true);
  expect(sourcePin).not.toHaveProperty("files");
});

it("checks archive length and full SHA before creating source roots or invoking Python", async () => {
  const root = temporary(), archivePath = path.join(root, "archive.xz"), destination = path.join(root, "result");
  fs.writeFileSync(archivePath, "not the release");
  await expect(prepareNodePosixSource({ archivePath, destination, pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
  const fd = fs.openSync(archivePath, "r+"); fs.ftruncateSync(fd, sourcePin.sourceArchive.bytes); fs.closeSync(fd);
  await expect(prepareNodePosixSource({ archivePath, destination, pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
});

it("refuses an aliased input root without following its contents", async () => {
  const root = temporary(), target = path.join(root, "real"), alias = path.join(root, "baseline"); fs.mkdirSync(target); fs.symlinkSync(target, alias, "junction");
  await expect(validateNodePosixSourceInputs(alias, "stock", { pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
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

it.skipIf(!available).each(["catalog-omit", "catalog-hash", "catalog-path", "catalog-directory", "catalog-patch"])("authenticates the entire mutable catalog before trusting it: %s", scenario => {
  expect(exercise({ scenario }).ok).toBe(false);
});

it.skipIf(!available).each(["baseline-extra", "working-generated-exact", "baseline-generated", "alter-input", "alter-cng", "alter-local", "alter-rename", "hardlink-input"])("retains original-input checks despite generated-output support: %s", scenario => {
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
  expect(result.status, "The fixed source fixture must complete without forwarding private interpreter errors.").toBe(0);
  return JSON.parse(result.stdout) as { ok: boolean; stage?: string; destinationExists?: boolean; files?: string[]; verifiedArchiveFiles?: number; signatureVerified?: boolean };
}

it("pins NASM through official HTTPS and a historical independent SHA without claiming a signature", async () => {
  expect(sourcePin.nasmTool).toMatchObject({ version: "2.16.03", bytes: 513543, sha256: "3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6",
    provenance: { kind: "official-https-and-independent-historical-sha256", independentCommit: "362b99166f2c5e327aa3439dadbc79f639f96bf3" } });
  const root = temporary(), archivePath = path.join(root, "nasm.zip"), destination = path.join(root, "tool");
  fs.writeFileSync(archivePath, "not the pinned tool");
  await expect(prepareNodePosixNasmTool({ archivePath, destination, pythonPath: "never-execute" })).rejects.toThrow("could not be verified");
  expect(fs.existsSync(destination)).toBe(false);
});

it.skipIf(!available)("verifies the complete NASM ZIP while staging only the compiler and licence", () => {
  expect(nasm({})).toEqual({ ok: true, files: ["LICENSE", "nasm.exe"], verifiedArchiveFiles: 3, signatureVerified: false });
});

it.skipIf(!available).each(["path", "symlink", "privileged", "encrypted", "unstaged-tamper", "extra"])("rejects unsafe NASM metadata or bytes before staging: %s", scenario => {
  expect(nasm({ scenario })).toMatchObject({ ok: false, destinationExists: false });
});

it("allows exactly the reviewed four source changes and scopes CNG before internal headers", () => {
  expect(sourcePin.patches.map((entry: { file: string }) => entry.file)).toEqual([
    "deps/uv/src/win/core.c", "deps/openssl/openssl/providers/implementations/rands/seeding/rand_win.c", "deps/uv/src/win/pipe.c", "deps/uv/src/win/fs.c",
  ]);
  expect(sourcePin.patch).toEqual(sourcePin.patches[0]);
  expect(sourcePin.patches[1]).toMatchObject({ beforeSha256: "3735ea8b46a826522e9a99d9977a5d86f6f1ae61d90d091b297d403b60de4e6a", afterSha256: "e31f888dfcce8674011c49d95b433b04533110844e4b696dd621e654512e1dda" });
  expect(sourcePin.patches[1].replacement).toContain("#  define _WIN32_WINNT 0x0600");
  expect(sourcePin.patches[1].replacement.indexOf("#  define _WIN32_WINNT")).toBeLessThan(sourcePin.patches[1].replacement.indexOf('#include "internal/cryptlib.h"'));
  expect(sourcePin.patches[2]).toMatchObject({ upstreamCommit: "2cadaa40167050baf7c6905ac897e6fb57afb2c6", beforeSha256: "4d370ce0bc10f8ae429f8acb2c7688d74b753e0177f347f5f3d337647e77ca38", afterSha256: "0739cb731a3e21eb23a7ee69ba2f1251542f34a06838cd115aa69e4a4bcc7b54" });
  expect(sourcePin.inventory.offlineBytes).toBe(554320064);
});

it.skipIf(!available).each(["patch-list-count", "patch-list-foreign", "patch-list-order"])("refuses any alternative source patch allowlist: %s", scenario => {
  expect(exercise({ scenario }).ok).toBe(false);
});
