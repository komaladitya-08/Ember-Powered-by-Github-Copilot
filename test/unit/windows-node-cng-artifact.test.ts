import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- fixed trusted-host JavaScript artifact authority
import { artifactPin, validateSourceArtifactOrigin, sourceArtifactBlobUrl, downloadSourceArtifact, validateSourceArtifactFiles, parseSourceArtifactExtractionRefusal, sourceArtifactExtractionRefusal, verifyPinnedSourceArtifactMembers } from "../../scripts/experimental/stage-windows-node-cng-artifact.mjs";
// @ts-expect-error -- current trusted compile-recipe authority
import { buildPin, windowsNodeSourceBuildRecipe, windowsNodeSourceEntropyImports } from "../../scripts/experimental/build-windows-node-source.mjs";
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
  { total_count: 1, jobs: [{ id: artifactPin.producer.jobId, run_id: artifactPin.runId, run_attempt: artifactPin.attempt, name: artifactPin.producer.jobName, status: 'completed', conclusion: 'failure',
    steps: [artifactPin.producer.buildStep, artifactPin.producer.uploadStep].map(step => ({ ...step, status: 'completed', conclusion: 'success' })) }] },
];
describe("fixed authenticated source artifact authority", () => {
  it("binds exact repository, failed native run, attempt, workflow, head and immutable ZIP digest", () => expect(validateSourceArtifactOrigin(...origin())).toBe(true));
  it.each([[0, "id", 1], [0, "full_name", "foreign/repository"], [1, "id", 1], [1, "run_attempt", 2], [1, "workflow_id", 1], [1, "path", "foreign.yml"], [1, "head_sha", "0".repeat(40)], [1, "head_branch", "main"], [1, "status", "in_progress"], [1, "conclusion", "success"], [2, "id", 1], [2, "path", "foreign.yml"], [3, "id", 1], [3, "name", "foreign"], [3, "expired", true], [3, "size_in_bytes", 1], [3, "digest", "sha256:" + "0".repeat(64)]])("rejects foreign origin field %i.%s", (index, key, value) => {
    const input = origin(); Object.assign(input[index as number], { [key]: value }); expect(() => validateSourceArtifactOrigin(...input)).toThrow("authenticated origin");
  });
  it.each(["count", "missing-job", "extra-job", "job-id", "job-run", "job-attempt", "job-name", "job-status", "job-conclusion", "missing-build", "duplicate-build", "build-name", "build-status", "build-failure", "upload-name", "upload-failure"])("refuses producer authority before blob access: %s", change => {
    const inputs = origin(), producer = inputs[4] as { total_count: number; jobs: { id: number; run_id: number; run_attempt: number; name: string; status: string; conclusion: string; steps: { number: number; name: string; status: string; conclusion: string }[] }[] };
    const job = producer.jobs[0];
    if (change === "count") producer.total_count = 2;
    if (change === "missing-job") producer.jobs = [];
    if (change === "extra-job") producer.jobs.push(job);
    if (change === "job-id") job.id++;
    if (change === "job-run") job.run_id++;
    if (change === "job-attempt") job.run_attempt++;
    if (change === "job-name") job.name = "foreign";
    if (change === "job-status") job.status = "in_progress";
    if (change === "job-conclusion") job.conclusion = "success";
    if (change === "missing-build") job.steps.splice(0, 1);
    if (change === "duplicate-build") job.steps.push({ ...job.steps[0] });
    if (change === "build-name") job.steps[0].name = "foreign";
    if (change === "build-status") job.steps[0].status = "in_progress";
    if (change === "build-failure") job.steps[0].conclusion = "failure";
    if (change === "upload-name") job.steps[1].name = "foreign";
    if (change === "upload-failure") job.steps[1].conclusion = "failure";
    expect(() => validateSourceArtifactOrigin(...inputs)).toThrow("authenticated origin");
  });
  it.each(["http://productionresultssa11.blob.core.windows.net/a?sig=x&se=x&spr=https", "https://api.github.com/a?sig=x&se=x&spr=https", "https://productionresultssa11.blob.core.windows.net.evil/a?sig=x&se=x&spr=https", "https://user:secret@productionresultssa11.blob.core.windows.net/a?sig=x&se=x&spr=https", "https://productionresultssa11.blob.core.windows.net:123/a?sig=x&se=x&spr=https", "https://productionresultssa11.blob.core.windows.net/a?sig=x&se=x&spr=http"])("rejects unsafe signed redirect %s", url => expect(() => sourceArtifactBlobUrl(url)).toThrow());
  it("never forwards the API credential to the signed blob request", async () => {
    const facts = origin(), calls: { url: string; options: { headers?: { Authorization?: string }; redirect?: string; credentials?: string } }[] = [];
    const request = async (url: string, options: { headers?: { Authorization?: string }; redirect?: string; credentials?: string }) => {
      calls.push({ url, options });
      if (calls.length <= 5) return new Response(JSON.stringify(facts[calls.length - 1]), { status: 200 });
      if (calls.length === 6) return new Response(null, { status: 302, headers: { location: "https://productionresultssa11.blob.core.windows.net/a?sig=public-fixture&se=public-fixture&spr=https" } });
      return new Response(Buffer.from("wrong-public-archive"), { status: 200 });
    };
    await expect(downloadSourceArtifact({ archivePath: path.join(temporary(), "archive.zip"), token: "ghs_" + "a".repeat(36), request })).rejects.toThrow("authenticated origin");
    expect(calls).toHaveLength(7);
    for (const call of calls.slice(0, 6)) { expect(call.url.startsWith("https://api.github.com/repos/" + artifactPin.repository)).toBe(true); expect(call.options.headers?.Authorization).toMatch(/^Bearer ghs_/); expect(call.options.redirect).toBe("manual"); }
    expect(calls[6].options.headers).toBeUndefined(); expect(calls[6].options.credentials).toBe("omit"); expect(calls[6].options.redirect).toBe("manual");
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

describe("closed extraction refusal metadata", () => {
  const diagnostic = () => ({ schema: 1, status: "refused", stage: 9, entryCount: 4, acceptedMask: 15, failure: 1, code: 0, identityMismatch: 0,
    entries: [1, 2, 3, 4].map(member => ({ member, kind: 1, mode: 0o100600, attributes: 0x81800000, compression: 8, flags: 0, bytes: 1024, compressedBytes: 512 })) });
  it("returns only exact bounded public numeric ZIP fields", () => {
    const result = parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(diagnostic())));
    expect(result).toEqual(diagnostic()); expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
  it.each(["extra", "stage", "count", "mask", "failure", "code", "identity", "member", "kind", "mode", "attributes", "compression", "flags", "bytes", "compressedBytes", "entry-extra", "early-stage", "length"])("silently discards malformed or private refusal shape: %s", change => {
    const value = diagnostic();
    if (change === "extra") Object.assign(value, { privatePath: "private path" });
    if (change === "stage") value.stage = 18;
    if (change === "count") value.entryCount = 66;
    if (change === "mask") value.acceptedMask = 14;
    if (change === "failure") value.failure = 0;
    if (change === "code") value.code = 65537;
    if (change === "identity") value.identityMismatch = 64;
    if (change === "member") value.entries[0].member = 5;
    if (change === "kind") value.entries[0].kind = 5;
    if (change === "mode") value.entries[0].mode = 65536;
    if (change === "attributes") value.entries[0].attributes = 0x100000000;
    if (change === "compression") value.entries[0].compression = 65536;
    if (change === "flags") value.entries[0].flags = 65536;
    if (change === "bytes") value.entries[0].bytes = artifactPin.maximumExpandedBytes + 2;
    if (change === "compressedBytes") value.entries[0].compressedBytes = artifactPin.zipBytes + 2;
    if (change === "entry-extra") Object.assign(value.entries[0], { name: "private raw member" });
    if (change === "early-stage") value.stage = 5;
    if (change === "length") value.entries.pop();
    expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(value)))).toBeUndefined();
  });
  it("discards arbitrary stdout and does not brand generic forged errors", () => {
    for (const bytes of [Buffer.from("private stderr"), Buffer.from("null"), Buffer.alloc(4097)]) expect(parseSourceArtifactExtractionRefusal(bytes)).toBeUndefined();
    expect(sourceArtifactExtractionRefusal(Object.assign(new Error("forged"), { extraction: diagnostic() }))).toBeUndefined();
  });
  it("allows only closed mismatch bits at the actual stat comparison stages", () => {
    const value = { ...diagnostic(), stage: 4, entryCount: 0, acceptedMask: 0, entries: [], identityMismatch: 8 };
    expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(value)))).toEqual(value);
    value.identityMismatch = 16; expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(value)))).toBeUndefined();
    value.stage = 16; expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(value)))).toEqual(value);
    value.stage = 5; expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(value)))).toBeUndefined();
  });
});

describe("independently authenticated literal artifact-member pins", () => {
  const receipt = () => ({ manifestSha256: artifactPin.memberManifestSha256,
    files: Object.keys(artifactPin.verifiedFiles).sort().map(name => ({ name, ...artifactPin.verifiedFiles[name] })) });
  it("binds the exact four now-observed public member hashes/bytes and manifest", () => expect(verifyPinnedSourceArtifactMembers(receipt())).toBe(true));
  it.each(["manifest", "bytes", "hash", "name", "extra"])("refuses changed public member evidence: %s", change => {
    const value = receipt();
    if (change === "manifest") value.manifestSha256 = "0".repeat(64);
    if (change === "bytes") value.files[0].bytes++;
    if (change === "hash") value.files[0].sha256 = "0".repeat(64);
    if (change === "name") value.files[0].name = "foreign";
    if (change === "extra") value.files.push(value.files[0]);
    expect(() => verifyPinnedSourceArtifactMembers(value)).toThrow();
  });
});

describe("post-ZIP four-file receipt and PE verification", () => {
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const fixture = () => {
    const directory = temporary(), pe = Buffer.alloc(2048);
    pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128); pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(1, 134);
    pe.writeUInt16LE(240, 148); pe.writeUInt16LE(0x22, 150); pe.writeUInt16LE(0x20b, 152); pe.writeUInt16LE(3, 220);
    pe.writeUInt32LE(0x1000, 168); pe.writeUInt32LE(0x2000, 208); pe.writeUInt32LE(512, 212); pe.writeUInt32LE(1536, 400);
    pe.writeUInt32LE(0x1000, 404); pe.writeUInt32LE(1536, 408); pe.writeUInt32LE(512, 412); pe.writeUInt32LE(0x60000020, 428);
    pe.writeUInt32LE(16, 260); pe.writeUInt32LE(0x1100, 272); pe.writeUInt32LE(40, 276);
    pe.writeUInt32LE(0x1180, 0x300); pe.writeUInt32LE(0x1150, 0x30c); pe.writeUInt32LE(0x1180, 0x310);
    pe.write("bcrypt.dll\0", 0x350, "ascii"); pe.writeBigUInt64LE(0x11c0n, 0x380); pe.write("BCryptGenRandom\0", 0x3c2, "ascii");
    windowsNodeSourceEntropyImports(pe);
    for (const name of ["source-node.exe", "bootstrap.exe"]) fs.writeFileSync(path.join(directory, name), pe);
    fs.writeFileSync(path.join(directory, "LICENSE"), "public synthetic license");
    const tool = () => ({ bytes: 2048, sha256: "b".repeat(64) }), nasm = sourcePin.nasmTool.files.find(value => value.path === "nasm.exe")!;
    const receipt = { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256, sourceCommit: sourcePin.provenance.commit,
      source: { stockManifestSha256: sourcePin.inventory.stockManifestSha256, offlineManifestSha256: sourcePin.inventory.offlineManifestSha256, directoryManifestSha256: sourcePin.inventory.directoryManifestSha256,
        files: sourcePin.inventory.files, directories: sourcePin.inventory.directories, directoriesExcludeArchiveRoot: true, stockBytes: sourcePin.inventory.stockBytes, offlineBytes: sourcePin.inventory.offlineBytes,
        patchBeforeSha256: sourcePin.patch.beforeSha256, patchAfterSha256: sourcePin.patch.afterSha256,
        patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }) => ({ file, beforeSha256, afterSha256, kind })) },
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
  it("validates a synthetic current-recipe receipt, CNG PE assets and derived hashes without reissuing the original artifact", () => {
    const value = fixture(), result = validateSourceArtifactFiles(value.directory, value.extraction());
    expect(result.compileCommit).toBe(artifactPin.compileCommit); expect(result.files).toHaveLength(4); expect(Object.isFrozen(result.files[0])).toBe(true);
  });
  it("refuses the legacy source issuer under the new three-delta candidate even with coherent synthetic current assets", () => {
    const value = fixture(); value.receipt.issuer = "ember-experimental-source-node-feasibility"; value.writeReceipt();
    expect(() => validateSourceArtifactFiles(value.directory, value.extraction())).toThrow("source, recipe or issuer contract");
  });
  it.each(["foreign-source", "foreign-commit", "recipe", "asset", "pe", "extra-file", "derived-hash"])("refuses coherent but foreign staged data: %s", change => {
    const value = fixture();
    if (change === "foreign-source") value.receipt.sourceCommit = "0".repeat(40);
    if (change === "foreign-commit") value.receipt.commit = "0".repeat(40);
    if (change === "recipe") value.receipt.recipe[0].sha256 = "0".repeat(64);
    if (change === "asset") value.receipt.assets.node.sha256 = "0".repeat(64);
    if (change === "pe") { const bad = Buffer.alloc(value.receipt.assets.node.bytes); fs.writeFileSync(path.join(value.directory, "source-node.exe"), bad); value.receipt.assets.node.sha256 = digest(bad); }
    if (change === "extra-file") fs.writeFileSync(path.join(value.directory, "private-extra"), "synthetic");
    value.writeReceipt(); const extraction = value.extraction(); if (change === "derived-hash") extraction.files[0].sha256 = "0".repeat(64);
    expect(() => validateSourceArtifactFiles(value.directory, extraction)).toThrow();
  });
  it.each(["missing", "legacy", "foreign-dll", "delayed", "ordinal"])("independently refuses a coherent receipt whose Node import policy is %s", change => {
    const value = fixture(), file = path.join(value.directory, "source-node.exe"), bytes = fs.readFileSync(file);
    if (change === "missing") { bytes.writeUInt32LE(0, 272); bytes.writeUInt32LE(0, 276); }
    if (change === "legacy") { bytes.fill(0, 0x3c2, 0x3e0); bytes.write("CryptGenRandom\0", 0x3c2, "ascii"); }
    if (change === "foreign-dll") bytes.write("ncrypt.dll\0", 0x350, "ascii");
    if (change === "delayed") bytes.writeUInt32LE(0x1100, 368);
    if (change === "ordinal") bytes.writeBigUInt64LE((1n << 63n) | 1n, 0x380);
    fs.writeFileSync(file, bytes); value.receipt.assets.node.sha256 = digest(bytes); value.writeReceipt();
    expect(() => validateSourceArtifactFiles(value.directory, value.extraction())).toThrow("source, recipe or issuer contract");
  });
  it("keeps the inert bootstrap under generic PE verification without requiring a crypto import", () => {
    const value = fixture(), file = path.join(value.directory, "bootstrap.exe"), bytes = fs.readFileSync(file);
    bytes.writeUInt32LE(0, 272); bytes.writeUInt32LE(0, 276); fs.writeFileSync(file, bytes);
    value.receipt.assets.bootstrap.sha256 = digest(bytes); value.writeReceipt();
    expect(validateSourceArtifactFiles(value.directory, value.extraction()).files).toHaveLength(4);
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
payload = b'x' * 128 if mode == 'oversize' else b'public-fixture'
module.PIN['verifiedFiles'] = dict((name, dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())) for name in ['source-node.exe','bootstrap.exe','build-receipt.json','LICENSE'])
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
clock_modes = ['clock-difference', 'held-clock-mutation', 'named-clock-mutation', 'different-device', 'different-inode', 'different-size', 'different-mtime', 'different-links']
if mode in clock_modes:
    original_fstat, original_lstat = module.os.fstat, module.os.lstat
    observation = dict(fd=None, calls=0, named_mutation=False)
    class StatView:
        def __init__(self, info, changes): self.info, self.changes = info, changes
        def __getattr__(self, key): return self.changes[key] if key in self.changes else getattr(self.info, key)
    def clock_change(info, increment):
        return dict(st_ctime=info.st_ctime + increment, st_ctime_ns=info.st_ctime_ns + increment * 1000000000)
    def observed_fstat(fd):
        info = original_fstat(fd)
        if observation['fd'] is None: observation['fd'] = fd
        if fd != observation['fd']: return info
        observation['calls'] += 1
        changes = {}
        if mode == 'clock-difference': changes = clock_change(info, 7)
        if mode == 'held-clock-mutation': changes = clock_change(info, observation['calls'])
        if mode == 'named-clock-mutation' and observation['calls'] > 1: observation['named_mutation'] = True
        field = dict([('different-device','st_dev'),('different-inode','st_ino'),('different-size','st_size'),('different-mtime','st_mtime_ns'),('different-links','st_nlink')]).get(mode)
        if field: changes[field] = getattr(info, field) + 1
        return StatView(info, changes)
    def observed_lstat(file, *args, **kwargs):
        info = original_lstat(file, *args, **kwargs)
        if observation['named_mutation'] and os.path.normcase(os.path.abspath(file)) == os.path.normcase(archive): return StatView(info, clock_change(info, 1))
        return info
    module.os.fstat, module.os.lstat = observed_fstat, observed_lstat
try:
    result = module.extract(archive, destination)
    print(json.dumps(dict(status='accepted', files=result['files'], pythonVersion=list(sys.version_info[:3]))))
except Exception as error:
    print(json.dumps(dict(status='refused', boundedGrowth=len(reads) == 1 and reads[0] <= module.PIN['zipBytes'] + 1 and not os.path.exists(destination), diagnostic=module.refusal(error), pythonVersion=list(sys.version_info[:3]))))
`;
describe("same-fd authenticated four-member ZIP boundary", () => {
  const run = (mode: string) => {
    const result = spawnSync(python, ["-I", "-B", "-c", fixture, path.resolve("scripts/experimental/extract-node-cng-artifact.py"), temporary(), mode], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
    expect(result.status, "The synthetic ZIP interpreter did not complete.").toBe(0); return JSON.parse(result.stdout);
  };
  it("extracts exactly four public regular files only after the synthetic fixed ZIP authenticates", () => {
    const result = run("plain"), diagnostic = parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(result.diagnostic ?? null)));
    const version = Array.isArray(result.pythonVersion) && result.pythonVersion.length === 3 && result.pythonVersion.every((value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255) ? result.pythonVersion : undefined;
    const message = (diagnostic ? JSON.stringify(diagnostic) : "No closed extraction diagnostic.") + (version ? ` interpreter=${JSON.stringify(version)}` : "");
    expect(result.status, message).toBe("accepted");
    expect(result.files.map((value: { name: string }) => value.name)).toEqual(["LICENSE", "bootstrap.exe", "build-receipt.json", "source-node.exe"]);
  });
  it.each(["traversal", "case", "directory", "control", "duplicate", "symlink", "special", "privileged", "oversize", "crc", "encryption", "outerhash", "existing", "alias"])("refuses %s without weakening the production pin or CLI", mode => expect(run(mode).status).toBe("refused"));
  it("stops a growing archive after at most pinned bytes plus one, before any output directory", () => expect(run("growing")).toMatchObject({ status: "refused", boundedGrowth: true }));
  it("accepts different cross-API ctime values only while both APIs' own snapshots and stable identities stay unchanged", () => expect(run("clock-difference").status).toBe("accepted"));
  it.each(["held-clock-mutation", "named-clock-mutation"])("refuses same-API ctime_ns mutation: %s", mode => {
    const result = run(mode); expect(result.status).toBe("refused");
    expect(result.diagnostic).toMatchObject({ stage: 16, identityMismatch: 16, failure: 1 });
    expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(result.diagnostic)))).toEqual(result.diagnostic);
  });
  it.each([["different-device", 1], ["different-inode", 2], ["different-size", 4], ["different-mtime", 8], ["different-links", 32]])("refuses a stable cross-API field mismatch: %s", (mode, mask) => {
    const result = run(mode as string); expect(result.status).toBe("refused"); expect(result.diagnostic).toMatchObject({ stage: 4, identityMismatch: mask, failure: 1 });
    expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(result.diagnostic)))).toEqual(result.diagnostic);
  });
  it("emits inventory/type refusal metadata only after whole-ZIP authentication", () => {
    const early = run("outerhash").diagnostic, inventory = run("symlink").diagnostic;
    expect(early).toMatchObject({ stage: 5, entryCount: 0, acceptedMask: 0, entries: [], failure: 1 });
    expect(inventory).toMatchObject({ stage: 9, entryCount: 4, acceptedMask: 15, failure: 1 });
    expect(inventory.entries[0]).toMatchObject({ member: 1, kind: 3 });
    expect(parseSourceArtifactExtractionRefusal(Buffer.from(JSON.stringify(inventory)))).toEqual(inventory);
    expect(JSON.stringify(inventory)).not.toMatch(/source-node|fixture.zip|LICENSE|private/);
  });
});
