// Provision only the trusted Bubblewrap executable's Ubuntu userns permission, without changing global restrictions.
// usage: node scripts/ci/coding-userns-preflight.mjs
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const PROFILE_NAME = "ember-ci-bwrap", PROFILE_PATH = "/etc/apparmor.d/ember-ci-bwrap";
export const codingUsernsProfile = `abi <abi/4.0>,
include <tunables/global>
profile ember-ci-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
`;
export const codingNamespaceProbe = Object.freeze(["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
  "--new-session", "--die-with-parent", "--clearenv", "--ro-bind", "/", "/", "--chdir", "/", "--", "/usr/bin/true"]);
const fixedEnv = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
const exec = promisify(execFile);
const fail = message => { throw new Error(message); };
const emit = (stage, value) => console.log(`coding.${stage} ${JSON.stringify(value)}`);
async function run(file, args) {
  try { const result = await exec(file, args, { cwd: "/", env: fixedEnv, encoding: "utf8", timeout: 5000, maxBuffer: 65_536, killSignal: "SIGKILL" }); return { ...result, ok: true }; }
  catch { return { stdout: "", stderr: "", ok: false }; } // Raw command diagnostics can include paths/arguments; only fixed stages escape.
}
async function read(file, maximum = 4096) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const bytes = Buffer.alloc(maximum + 1), result = await handle.read(bytes, 0, bytes.length, 0); if (result.bytesRead > maximum) fail("metadata too large"); return bytes.subarray(0, result.bytesRead).toString("utf8").trim(); }
  finally { await handle.close(); }
}
async function optional(file) { try { return await read(file); } catch { return "unavailable"; } }
async function metadata() {
  const enabled = await optional("/sys/module/apparmor/parameters/enabled");
  const restricted = await optional("/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
  const unconfined = await optional("/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined");
  const label = await optional("/proc/self/attr/current");
  return { enabled: enabled === "Y", restricted: /^[01]$/.test(restricted) ? restricted : "unavailable",
    unconfined: /^[01]$/.test(unconfined) ? unconfined : "unavailable", label: label === "unconfined" ? "unconfined" : "other" };
}

/** Output contains only fixed audit fields for bwrap; never a journal record, argv, path, or arbitrary profile label. */
export function codingBwrapAudit(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) return [];
  const records = [];
  for (const line of text.split("\n").slice(-40)) {
    const values = Object.fromEntries([...line.matchAll(/\b([a-z_]+)=(?:"([^"]*)"|([^\s]+))/g)].map(match => [match[1], match[2] ?? match[3]]));
    if (values.comm !== "bwrap" || values.apparmor !== "DENIED") continue;
    const profile = ["unconfined", "unprivileged_userns", PROFILE_NAME].includes(values.profile) ? values.profile : "other";
    const operation = ["capable", "userns_create", "exec"].includes(values.operation) ? values.operation : "other";
    const cap = /^(?:[0-9]|[1-3][0-9]|40)$/.test(values.capability ?? "") ? Number(values.capability) : null;
    const capname = ["net_admin", "sys_admin", "setuid", "setgid", "sys_chroot", "mknod"].includes(values.capname) ? values.capname : null;
    records.push({ profile, operation, capability: cap, capname });
  }
  return records;
}
async function audit(since, stage) {
  const result = await run("/usr/bin/sudo", ["-n", "/usr/bin/journalctl", "--kernel", "--since", `@${since}`, "--no-pager", "--lines=40", "--output=cat", "--grep", 'apparmor=.*comm="bwrap"']);
  emit(stage, { available: result.ok, records: codingBwrapAudit(result.stdout) });
}
async function trustedBwrap() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid() === 0) fail("normal-user Linux x64 required");
  for (const file of ["/", "/usr", "/usr/bin", "/usr/bin/bwrap"]) {
    const stat = await fs.lstat(file), executable = file === "/usr/bin/bwrap";
    if (stat.uid !== 0 || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
        (executable ? !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o6000) !== 0 || (stat.mode & 0o111) === 0 : !stat.isDirectory())) fail("untrusted fixed setup path");
  }
  const status = await read("/proc/self/status", 16_384), effective = /^CapEff:\s*([0-9a-f]+)$/mi.exec(status);
  if (!effective || BigInt(`0x${effective[1]}`) !== 0n) fail("initial namespace capabilities must be empty");
}
async function installProfile() {
  for (const folder of ["/etc", "/etc/apparmor.d"]) {
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) fail("untrusted profile directory");
  }
  const existing = await fs.lstat(PROFILE_PATH).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== 0 || existing.nlink !== 1 ||
      (existing.mode & 0o022) !== 0 || await read(PROFILE_PATH) !== codingUsernsProfile.trim())) fail("unexpected existing CI profile");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ci-userns-"));
  try {
    await fs.chmod(temporary, 0o700); const file = path.join(temporary, "profile");
    await fs.writeFile(file, codingUsernsProfile, { flag: "wx", mode: 0o600 });
    if (!(await run("/usr/bin/sudo", ["-n", "/usr/bin/install", "-o", "root", "-g", "root", "-m", "0644", file, PROFILE_PATH])).ok) fail("profile install failed");
    const installed = await fs.lstat(PROFILE_PATH);
    if (!installed.isFile() || installed.isSymbolicLink() || installed.uid !== 0 || installed.nlink !== 1 ||
        (installed.mode & 0o777) !== 0o644 || await read(PROFILE_PATH) !== codingUsernsProfile.trim()) fail("installed profile could not be verified");
    if (!(await run("/usr/bin/sudo", ["-n", "/usr/sbin/apparmor_parser", "--replace", PROFILE_PATH])).ok) fail("profile load failed");
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  const profiles = await run("/usr/bin/sudo", ["-n", "/usr/bin/cat", "/sys/kernel/security/apparmor/profiles"]);
  if (!profiles.ok || !profiles.stdout.split("\n").some(line => line === `${PROFILE_NAME} (unconfined)`)) fail("loaded profile could not be confirmed");
}

export async function prepareCodingUserns() {
  await trustedBwrap(); const before = await metadata(), since = Math.floor(Date.now() / 1000) - 1;
  emit("userns_before", before);
  const packages = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Package} ${Version}\n", "apparmor", "bubblewrap"]);
  emit("userns_packages", packages.ok ? packages.stdout.split("\n").filter(line => /^(apparmor|bubblewrap) [0-9A-Za-z.+:~_-]{1,100}$/.test(line)) : []);
  const baseline = await run("/usr/bin/bwrap", [...codingNamespaceProbe]); emit("userns_baseline", { passed: baseline.ok });
  if (baseline.ok) return;
  await audit(since, "userns_audit_before");
  if (!before.enabled || before.restricted !== "1" || before.label !== "unconfined") fail("namespace failure is outside the supported AppArmor exemption");
  // Canonical's documented per-executable userns permission, matching Ubuntu's packaged flatpak/sbuild profiles.
  // This grants no Linux capability to the outer user; Bubblewrap still creates every private namespace itself.
  await installProfile();
  const after = await metadata(); emit("userns_after", after);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail("global AppArmor restrictions changed");
  const repaired = await run("/usr/bin/bwrap", [...codingNamespaceProbe]); emit("userns_scoped_profile_probe", { passed: repaired.ok });
  await audit(since, "userns_audit_after");
  if (!repaired.ok) fail("namespace probe still failed with the exact-executable profile");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) fail("this setup takes no arguments");
  prepareCodingUserns().catch(() => { console.error("coding.userns_preflight failed; no namespace, policy or privilege fallback was used."); process.exitCode = 1; });
}
