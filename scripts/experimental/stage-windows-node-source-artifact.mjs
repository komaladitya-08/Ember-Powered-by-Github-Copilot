/** Fixed authenticated public build reuse. No source build, arbitrary run/artifact input or PE execution. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildPin, attestWindowsNodeSourcePython, trustedWindowsNodeSourcePythonPath, windowsNodeSourceBuildEnvironment,
  parseWindowsNodeSourceBuildReceipt, windowsNodeSourceImageFingerprint } from "./build-windows-node-source.mjs";

const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const artifactPin = freeze(JSON.parse(fs.readFileSync(new URL("./windows-node-source-artifact-pin.json", import.meta.url), "utf8")));
const fail = () => { throw new Error("The fixed source artifact failed authenticated origin, ZIP or compiled-receipt verification."); };
const hash = value => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strict = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && equal(Object.keys(value).sort(), [...keys].sort());
const api = `https://api.github.com/repos/${artifactPin.repository}`;
export function validateSourceArtifactOrigin(repository, run, workflow, artifact) {
  if (repository?.id !== artifactPin.repositoryId || repository.full_name !== artifactPin.repository || run?.id !== artifactPin.runId ||
    run.run_attempt !== artifactPin.attempt || run.workflow_id !== artifactPin.workflowId || run.path !== artifactPin.workflowPath || run.event !== "pull_request" ||
    run.status !== "completed" || run.conclusion !== "failure" || run.head_branch !== artifactPin.headBranch || run.head_sha !== artifactPin.headCommit ||
    run.repository?.id !== artifactPin.repositoryId || run.head_repository?.id !== artifactPin.repositoryId || workflow?.id !== artifactPin.workflowId || workflow.path !== artifactPin.workflowPath ||
    artifact?.id !== artifactPin.artifactId || artifact.name !== artifactPin.artifactName || artifact.expired !== false || artifact.size_in_bytes !== artifactPin.zipBytes ||
    artifact.digest !== `sha256:${artifactPin.zipSha256}` || artifact.workflow_run?.id !== artifactPin.runId || artifact.workflow_run.repository_id !== artifactPin.repositoryId ||
    artifact.workflow_run.head_repository_id !== artifactPin.repositoryId || artifact.workflow_run.head_branch !== artifactPin.headBranch || artifact.workflow_run.head_sha !== artifactPin.headCommit) fail();
  return true;
}
export function sourceArtifactBlobUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !/^productionresults[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      !url.searchParams.has("sig") || !url.searchParams.has("se") || url.searchParams.get("spr") !== "https") fail();
    return url.href;
  } catch { fail(); }
}
async function boundedBody(response, maximum) {
  const chunks = []; let length = 0;
  if (!response.body) fail();
  for await (const chunk of response.body) { length += chunk.length; if (length > maximum) fail(); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks, length);
}
function ordinaryAncestry(value, exists = true) {
  const absolute = path.resolve(value);
  if (absolute !== value || /[\p{Cc}\p{Cf}]/u.test(value)) fail();
  let current = exists ? absolute : path.dirname(absolute);
  if (fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) fail();
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || current !== absolute && !stat.isDirectory()) fail();
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return absolute;
}
/** Request injection is a portable network test seam; every authority, path and digest remains fixed. */
export async function downloadSourceArtifact({ archivePath, token, request = globalThis.fetch }) {
  try {
    ordinaryAncestry(archivePath, false); if (fs.existsSync(archivePath) || typeof token !== "string" || !/^[A-Za-z0-9_.-]{20,2048}$/.test(token)) fail();
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache", "User-Agent": "ember-fixed-source-node-native-reuse" };
    const options = () => ({ headers, redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(30_000) });
    const metadata = async endpoint => {
      const response = await request(`${api}${endpoint}`, options());
      if (response.status !== 200) fail(); return JSON.parse((await boundedBody(response, 256 * 1024)).toString("utf8"));
    };
    const repository = await metadata(""), run = await metadata(`/actions/runs/${artifactPin.runId}`), workflow = await metadata(`/actions/workflows/${artifactPin.workflowId}`),
      artifact = await metadata(`/actions/artifacts/${artifactPin.artifactId}`);
    validateSourceArtifactOrigin(repository, run, workflow, artifact);
    const redirect = await request(`${api}/actions/artifacts/${artifactPin.artifactId}/zip`, options());
    if (redirect.status !== 302) fail();
    const blobUrl = sourceArtifactBlobUrl(redirect.headers.get("location"));
    // A completely new request carries no API Authorization, cookies or referrer to the signed Azure URL.
    const blob = await request(blobUrl, { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(120_000) });
    if (blob.status !== 200 || !blob.body) fail();
    const declared = blob.headers.get("content-length"); if (declared !== null && declared !== String(artifactPin.zipBytes)) fail();
    const fd = fs.openSync(archivePath, "wx", 0o600), digest = createHash("sha256"); let length = 0;
    try {
      for await (const chunk of blob.body) {
        const bytes = Buffer.from(chunk); length += bytes.length; if (length > artifactPin.zipBytes) fail(); digest.update(bytes);
        let written = 0; while (written < bytes.length) { const count = fs.writeSync(fd, bytes, written, bytes.length - written); if (count <= 0) fail(); written += count; }
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (length !== artifactPin.zipBytes || digest.digest("hex") !== artifactPin.zipSha256) fail();
    return { bytes: length, sha256: artifactPin.zipSha256 };
  } catch { fail(); }
}
function readOrdinary(file, maximum) {
  ordinaryAncestry(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd), buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    const end = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || length !== opened.size || opened.size !== before.size ||
      end.ino !== opened.ino || end.dev !== opened.dev || end.size !== opened.size || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs ||
      named.isSymbolicLink() || named.ino !== opened.ino || named.dev !== opened.dev || named.nlink !== 1) fail();
    return buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
export function validateSourceArtifactFiles(destination, extraction) {
  ordinaryAncestry(destination);
  if (!strict(extraction, ["schema", "issuer", "zipSha256", "files", "manifestSha256"]) || extraction.schema !== 1 || extraction.issuer !== artifactPin.issuer ||
    extraction.zipSha256 !== artifactPin.zipSha256 || !Array.isArray(extraction.files) || extraction.files.length !== 4 ||
    !equal(fs.readdirSync(destination).sort(), Object.keys(artifactPin.members).sort())) fail();
  const files = Object.keys(artifactPin.members).sort().map((name, index) => {
    const value = extraction.files[index], bytes = readOrdinary(path.join(destination, name), artifactPin.members[name]);
    if (!strict(value, ["name", "bytes", "sha256"]) || value.name !== name || value.bytes !== bytes.length || value.sha256 !== hash(bytes)) fail();
    return value;
  });
  const canonical = files.map(value => `${value.sha256} ${value.bytes} ${value.name}\n`).join("");
  if (hash(canonical) !== extraction.manifestSha256) fail();
  const receipt = parseWindowsNodeSourceBuildReceipt(readOrdinary(path.join(destination, "build-receipt.json"), 32768), artifactPin.compileCommit);
  for (const [key, name, maximum] of [["node", "source-node.exe", buildPin.maximumNodeBytes], ["bootstrap", "bootstrap.exe", buildPin.maximumBootstrapBytes]]) {
    const fingerprint = windowsNodeSourceImageFingerprint(readOrdinary(path.join(destination, name), maximum), maximum);
    if (!equal({ name, ...fingerprint }, receipt.assets[key])) fail();
  }
  return freeze({ schema: 1, issuer: artifactPin.issuer, sourceArtifactId: artifactPin.artifactId, sourceRunId: artifactPin.runId, sourceRunAttempt: artifactPin.attempt,
    compileCommit: artifactPin.compileCommit, zipSha256: artifactPin.zipSha256, manifestSha256: extraction.manifestSha256, files });
}
let stage = "inputs";
export async function stageWindowsNodeSourceArtifact({ destination, token, pythonPath = buildPin.pythonExecutable }) {
  try {
    if (process.platform !== "win32" || process.arch !== "x64") fail();
    trustedWindowsNodeSourcePythonPath(pythonPath); ordinaryAncestry(destination, false); if (fs.existsSync(destination)) fail();
    fs.mkdirSync(destination, { mode: 0o700 });
    const directories = { profile: path.join(destination, "profile"), temporary: path.join(destination, "temporary"), local: path.join(destination, "profile", "Local"), roaming: path.join(destination, "profile", "Roaming") };
    Object.values(directories).forEach(value => fs.mkdirSync(value, { mode: 0o700 }));
    const emptyTools = path.join(destination, "empty-tools"); fs.mkdirSync(emptyTools, { mode: 0o700 });
    const env = windowsNodeSourceBuildEnvironment(process.env, directories, { pythonDirectory: path.win32.dirname(buildPin.pythonExecutable), nasmDirectory: emptyTools });
    stage = "python-preflight"; const python = attestWindowsNodeSourcePython(pythonPath, env, destination);
    stage = "authenticated-download"; const archivePath = path.join(destination, "source-artifact.zip"); await downloadSourceArtifact({ archivePath, token });
    const assets = path.join(destination, "assets"), extractor = fileURLToPath(new URL("./extract-node-source-artifact.py", import.meta.url));
    const extractorBefore = hash(readOrdinary(extractor, 64 * 1024)), pinFile = fileURLToPath(new URL("./windows-node-source-artifact-pin.json", import.meta.url)), pinBefore = hash(readOrdinary(pinFile, 64 * 1024));
    stage = "verified-extraction";
    const text = execFileSync(python.pythonPath, ["-I", "-B", extractor, archivePath, assets], { env, cwd: destination, encoding: "utf8", windowsHide: true, timeout: 120_000,
      maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
    stage = "compiled-receipt"; const receipt = validateSourceArtifactFiles(assets, JSON.parse(text));
    if (extractorBefore !== hash(readOrdinary(extractor, 64 * 1024)) || pinBefore !== hash(readOrdinary(pinFile, 64 * 1024)) ||
      !equal(python.fingerprint, attestWindowsNodeSourcePython(python.pythonPath, env, destination).fingerprint)) fail();
    return { buildRoot: assets, buildCommit: artifactPin.compileCommit, receipt };
  } catch { fail(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (args.length !== 2 || args[0] !== "--destination") fail();
    const value = await stageWindowsNodeSourceArtifact({ destination: args[1], token: process.env.EMBER_NODE_SOURCE_ARTIFACT_TOKEN });
    if (!process.env.GITHUB_ENV) fail();
    fs.appendFileSync(process.env.GITHUB_ENV, `EMBER_NODE_SOURCE_BUILD_ROOT=${value.buildRoot}\nEMBER_NODE_SOURCE_BUILD_COMMIT=${value.buildCommit}\n`);
    console.log(JSON.stringify(value.receipt));
  } catch { console.error(JSON.stringify({ status: "refused", stage })); process.exitCode = 1; }
}
