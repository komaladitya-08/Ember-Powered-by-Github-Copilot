import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- fixed trusted-host JavaScript artifact authority
import { artifactPin, validateSourceArtifactOrigin, sourceArtifactBlobUrl, downloadSourceArtifact, validateSourceArtifactFiles } from "../../scripts/experimental/stage-windows-node-source-artifact.mjs";
// @ts-expect-error -- unchanged trusted compile-recipe authority
import { buildPin, windowsNodeSourceBuildRecipe } from "../../scripts/experimental/build-windows-node-source.mjs";
import sourcePin from "../../scripts/experimental/windows-node-source-pin.json";

const directories: string[] = [];
const python = process.platform === "win32" ? "python" : "python3";
const temporary = () => { const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-artifact-unit-")); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const origin = () => [
  { id: artifactPin.repositoryId, full_name: artifactPin.repository },
  { id: artifactPin.runId, run_attempt: 1, workflow_id: artifactPin.workflowId, path: artifactPin.workflowPath, event: "pull_request", status: "completed", conclusion: "failure",
    head_branch: artifactPin.headBranch, head_sha: artifactPin.headCommit, repository: { id: artifactPin.repositoryId }, head_repository: { id: artifactPin.repositoryId } },
  { id: artifactPin.workflowId, path: artifactPin.workflowPath },
  { id: artifactPin.artifactId, name: artifactPin.artifactName, expired: false, size_in_bytes: artifactPin.zipBytes, digest: `sha256:${artifactPin.zipSha256}`,
    workflow_run: { id: artifactPin.runId, repository_id: artifactPin.repositoryId, head_repository_id: artifactPin.repositoryId, head_branch: artifactPin.headBranch, head_sha: artifactPin.headCommit } },
];
describe("fixed authenticated source artifact authority", () => {
  it("binds exact repository, failed native run, attempt, workflow, head and immutable ZIP digest", () => expect(validateSourceArtifactOrigin(...origin())).toBe(true));
  it.each([[0, "id", 1], [0, "full_name", "foreign/repository"], [1, "id", 1], [1, "run_attempt", 2], [1, "workflow_id", 1], [1, "path", "foreign.yml"], [1, "head_sha", "0".repeat(40)], [1, "head_branch", "main"], [1, "status", "in_progress"], [1, "conclusion", "success"], [2, "id", 1], [2, "path", "foreign.yml"], [3, "id", 1], [3, "name", "foreign"], [3, "expired", true], [3, "size_in_bytes", 1], [3, "digest", "sha256:" + "0".repeat(64)]])("rejects foreign origin field %i.%s", (index, key, value) => {
    const input = origin(); Object.assign(input[index as number], { [key]: value }); expect(() => validateSourceArtifactOrigin(...input)).toThrow("authenticated origin");
  });
  it.each(["http://productionresultssa11.blob.core.windows.net/a?sig=x&se=x&spr=https", "https://api.github.com/a?sig=x&se=x&spr=https", "https://productionresultssa11.blob.core.windows.net.evil/a?sig=x&se=x&spr=https", "https://user:secret@productionresultssa11.blob.core.windows.net/a?sig=x&se=x&spr=https", "https://productionresultssa11.blob.core.windows.net:123/a?sig=x&se=x&spr=https", "https://productionresultssa11.blob.core.windows.net/a?sig=x&se=x&spr=http"])("rejects unsafe signed redirect %s", url => expect(() => sourceArtifactBlobUrl(url)).toThrow());
  it("never forwards the API credential to the signed blob request", async () => {
    const facts = origin(), calls: { url: string; options: { headers?: { Authorization?: string }; redirect?: string; credentials?: string } }[] = [];
    const request = async (url: string, options: { headers?: { Authorization?: string }; redirect?: string; credentials?: string }) => {
      calls.push({ url, options });
      if (calls.length <= 4) return new Response(JSON.stringify(facts[calls.length - 1]), { status: 200 });
      if (calls.length === 5) return new Response(null, { status: 302, headers: { location: "https://productionresultssa11.blob.core.windows.net/a?sig=public-fixture&se=public-fixture&spr=https" } });
      return new Response(Buffer.from("wrong-public-archive"), { status: 200 });
    };
    await expect(downloadSourceArtifact({ archivePath: path.join(temporary(), "archive.zip"), token: "ghs_" + "a".repeat(36), request })).rejects.toThrow("authenticated origin");
    expect(calls).toHaveLength(6);
    for (const call of calls.slice(0, 5)) { expect(call.url.startsWith("https://api.github.com/repos/" + artifactPin.repository)).toBe(true); expect(call.options.headers?.Authorization).toMatch(/^Bearer ghs_/); expect(call.options.redirect).toBe("manual"); }
    expect(calls[5].options.headers).toBeUndefined(); expect(calls[5].options.credentials).toBe("omit"); expect(calls[5].options.redirect).toBe("manual");
  });
  it("rejects metadata before issuing a blob request and sanitizes network details", async () => {
    let called = 0;
    const request = async () => { called++; throw new Error("private token, signed URL and host detail"); };
    await expect(downloadSourceArtifact({ archivePath: path.join(temporary(), "archive.zip"), token: "ghs_" + "a".repeat(36), request })).rejects.toThrow("The fixed source artifact failed authenticated origin, ZIP or compiled-receipt verification.");
    expect(called).toBe(1);
  });
  it("bounds metadata before JSON parsing or issuing any blob request", async () => {
    let called = 0;
    const request = async () => { called++; return new Response(Buffer.alloc(256 * 1024 + 1, 32), { status: 200 }); };
    await expect(downloadSourceArtifact({ archivePath: path.join(temporary(), "archive.zip"), token: "ghs_" + "a".repeat(36), request })).rejects.toThrow("authenticated origin");
    expect(called).toBe(1);
  });
  it.each(["", "ghs_good\r\nAuthorization: injected"])("refuses malformed credentials without a request", async token => {
    let called = 0;
    await expect(downloadSourceArtifact({ archivePath: path.join(temporary(), "archive.zip"), token, request: async () => { called++; throw new Error(); } })).rejects.toThrow();
    expect(called).toBe(0);
  });
});

describe("post-ZIP four-file receipt and PE verification", () => {
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const fixture = () => {
    const directory = temporary(), pe = Buffer.alloc(1024);
    pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128); pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(1, 134);
    pe.writeUInt16LE(240, 148); pe.writeUInt16LE(0x22, 150); pe.writeUInt16LE(0x20b, 152); pe.writeUInt16LE(3, 220);
    pe.writeUInt32LE(0x1000, 168); pe.writeUInt32LE(0x2000, 208); pe.writeUInt32LE(512, 212); pe.writeUInt32LE(256, 400);
    pe.writeUInt32LE(0x1000, 404); pe.writeUInt32LE(512, 408); pe.writeUInt32LE(512, 412); pe.writeUInt32LE(0x60000020, 428);
    for (const name of ["source-node.exe", "bootstrap.exe"]) fs.writeFileSync(path.join(directory, name), pe);
    fs.writeFileSync(path.join(directory, "LICENSE"), "public synthetic license");
    const tool = () => ({ bytes: 2048, sha256: "b".repeat(64) }), nasm = sourcePin.nasmTool.files.find(value => value.path === "nasm.exe")!;
    const receipt = { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256, sourceCommit: sourcePin.provenance.commit,
      source: { stockManifestSha256: sourcePin.inventory.stockManifestSha256, offlineManifestSha256: sourcePin.inventory.offlineManifestSha256, directoryManifestSha256: sourcePin.inventory.directoryManifestSha256,
        files: sourcePin.inventory.files, directories: sourcePin.inventory.directories, directoriesExcludeArchiveRoot: true, stockBytes: sourcePin.inventory.stockBytes, offlineBytes: sourcePin.inventory.offlineBytes,
        patchBeforeSha256: sourcePin.patch.beforeSha256, patchAfterSha256: sourcePin.patch.afterSha256 },
      build: { ...buildPin, visualStudioVersion: "17.14.37906.3", compilerVersion: "19.44.35211.0", linkerVersion: "14.44.35211.0", msbuildVersion: "17.14.23.30406", pythonVersion: "3.12.10", nasmVersion: "2.16.03" },
      tools: { compiler: tool(), linker: tool(), msbuild: tool(), vcvars: tool(), vswhere: tool(), python: tool(), nasm: { bytes: nasm.bytes, sha256: nasm.sha256 } },
      recipe: windowsNodeSourceBuildRecipe(), commit: artifactPin.compileCommit,
      assets: { node: { name: "source-node.exe", bytes: pe.length, sha256: digest(pe) }, bootstrap: { name: "bootstrap.exe", bytes: pe.length, sha256: digest(pe) } } };
    const writeReceipt = () => fs.writeFileSync(path.join(directory, "build-receipt.json"), JSON.stringify(receipt)); writeReceipt();
    const extraction = () => {
      const files = ["LICENSE", "bootstrap.exe", "build-receipt.json", "source-node.exe"].map(name => { const bytes = fs.readFileSync(path.join(directory, name)); return { name, bytes: bytes.length, sha256: digest(bytes) }; });
      return { schema: 1, issuer: artifactPin.issuer, zipSha256: artifactPin.zipSha256, files, manifestSha256: digest(files.map(value => `${value.sha256} ${value.bytes} ${value.name}\n`).join("")) };
    };
    return { directory, receipt, writeReceipt, extraction };
  };
  it("independently revalidates the original full receipt, current compile recipe, both PE assets and all four derived hashes", () => {
    const value = fixture(), result = validateSourceArtifactFiles(value.directory, value.extraction());
    expect(result.compileCommit).toBe(artifactPin.compileCommit); expect(result.files).toHaveLength(4); expect(Object.isFrozen(result.files[0])).toBe(true);
  });
  it.each(["foreign-source", "foreign-commit", "recipe", "asset", "pe", "extra-file", "derived-hash"])("refuses coherent but foreign staged data: %s", change => {
    const value = fixture();
    if (change === "foreign-source") value.receipt.sourceCommit = "0".repeat(40);
    if (change === "foreign-commit") value.receipt.commit = "0".repeat(40);
    if (change === "recipe") value.receipt.recipe[0].sha256 = "0".repeat(64);
    if (change === "asset") value.receipt.assets.node.sha256 = "0".repeat(64);
    if (change === "pe") { const bad = Buffer.alloc(1024); fs.writeFileSync(path.join(value.directory, "source-node.exe"), bad); value.receipt.assets.node.sha256 = digest(bad); }
    if (change === "extra-file") fs.writeFileSync(path.join(value.directory, "private-extra"), "synthetic");
    value.writeReceipt(); const extraction = value.extraction(); if (change === "derived-hash") extraction.files[0].sha256 = "0".repeat(64);
    expect(() => validateSourceArtifactFiles(value.directory, extraction)).toThrow();
  });
});

const fixture = String.raw`
import hashlib, importlib.util, json, os, stat, sys, warnings, zipfile
warnings.simplefilter('ignore', UserWarning)
spec = importlib.util.spec_from_file_location('fixed_artifact', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root, mode = sys.argv[2], sys.argv[3]
archive, destination = os.path.join(root, 'fixture.zip'), os.path.join(root, 'output')
names = ['source-node.exe', 'bootstrap.exe', 'build-receipt.json', 'LICENSE']
if mode == 'traversal': names[0] = '../source-node.exe'
if mode == 'case': names[0] = 'SOURCE-NODE.exe'
if mode == 'directory': names[3] = 'LICENSE/'
if mode == 'control': names[3] = 'LICENSE00'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as bundle:
    for index, name in enumerate(names):
        item = zipfile.ZipInfo(name); item.create_system = 3; item.external_attr = (stat.S_IFREG | 0o600) << 16
        if index == 0 and mode == 'symlink': item.external_attr = (stat.S_IFLNK | 0o777) << 16
        if index == 0 and mode == 'special': item.external_attr = (stat.S_IFIFO | 0o600) << 16
        if index == 0 and mode == 'privileged': item.external_attr = (stat.S_IFREG | 0o4755) << 16
        bundle.writestr(item, b'public-fixture' if mode != 'oversize' else b'x' * 128)
    if mode == 'duplicate': bundle.writestr('LICENSE', b'duplicate')
with open(archive, 'rb') as source: data = source.read()
if mode == 'control':
    data = data.replace(b'LICENSE00', b'LICENSE\x00x')
if mode == 'crc':
    with zipfile.ZipFile(archive) as bundle: first = bundle.infolist()[0]
    offset = first.header_offset + 30 + len(first.filename.encode()) + len(first.extra)
    data = data[:offset] + bytes([data[offset] ^ 1]) + data[offset + 1:]
if mode == 'encryption':
    data = bytearray(data)
    for marker, offset in [(b'PK\x03\x04', 6), (b'PK\x01\x02', 8)]:
        position = data.find(marker); data[position + offset] |= 1
    data = bytes(data)
with open(archive, 'wb') as output: output.write(data)
module.PIN = dict(module.PIN)
module.PIN.update(zipBytes=len(data), zipSha256=hashlib.sha256(data).hexdigest(), members=dict((name, 64) for name in ['source-node.exe','bootstrap.exe','build-receipt.json','LICENSE']), maximumExpandedBytes=256)
if mode == 'outerhash': module.PIN['zipSha256'] = '0' * 64
if mode == 'existing': os.mkdir(destination)
if mode == 'alias':
    actual = os.path.join(root, 'actual'); os.mkdir(actual); os.symlink(actual, destination, target_is_directory=True)
reads = []
if mode == 'growing':
    original_fdopen = module.os.fdopen
    class GrowingReader:
        def __init__(self, source): self.source = source
        def __enter__(self): return self
        def __exit__(self, *args): return self.source.__exit__(*args)
        def fileno(self): return self.source.fileno()
        def read(self, count):
            reads.append(count)
            if len(reads) == 1:
                with open(archive, 'ab') as appended: appended.write(b'x' * 2048)
            return self.source.read(count)
    module.os.fdopen = lambda *args: GrowingReader(original_fdopen(*args))
try:
    result = module.extract(archive, destination)
    print(json.dumps(dict(status='accepted', files=result['files'])))
except Exception:
    print(json.dumps(dict(status='refused', boundedGrowth=len(reads) == 1 and reads[0] <= module.PIN['zipBytes'] + 1 and not os.path.exists(destination))))
`;
describe("same-fd authenticated four-member ZIP boundary", () => {
  const run = (mode: string) => {
    const result = spawnSync(python, ["-I", "-B", "-c", fixture, path.resolve("scripts/experimental/extract-node-source-artifact.py"), temporary(), mode], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
    expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
  };
  it("extracts exactly four public regular files only after the synthetic fixed ZIP authenticates", () => {
    const result = run("plain"); expect(result.status).toBe("accepted"); expect(result.files.map((value: { name: string }) => value.name)).toEqual(["LICENSE", "bootstrap.exe", "build-receipt.json", "source-node.exe"]);
  });
  it.each(["traversal", "case", "directory", "control", "duplicate", "symlink", "special", "privileged", "oversize", "crc", "encryption", "outerhash", "existing", "alias"])("refuses %s without weakening the production pin or CLI", mode => expect(run(mode).status).toBe("refused"));
  it("stops a growing archive after at most pinned bytes plus one, before any output directory", () => expect(run("growing")).toEqual({ status: "refused", boundedGrowth: true }));
});
