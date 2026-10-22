// The macOS privacy (TCC) grants CI's macOS jobs write: SQL built by pure functions (tested on Linux) and a small CLI
// that runs sqlite3, codesign, csreq and defaults on the runner. GitHub's macOS images let a job write the system
// database with sudo and the user's database as the runner's user, as the image's own setup does.
// Two kinds of client get grants:
//   - paths (client_type 1): the binaries that may be TCC's responsible process for what the integration tests start
//     (the development Electron, node, the shells, the runner's own processes) get Accessibility, Screen Recording and
//     Input Monitoring's two halves (posting and listening to events) in the system database, and Apple Events to
//     System Events (dark mode, the target named by its code requirement as tccd itself records it) in the user
//     database, which the user's tccd evaluates;
//   - Ember.app's bundle id (client_type 0), with the bundle's real code requirement: tccd checks a bundle client's
//     requirement, and an ad hoc signature's designated requirement is its cdhash, so a NULL csreq describes no build.
//     CI writes it only after a first doctor run through LaunchServices has shown that Ember has no grant to borrow.
// Ember.app's own executable is deliberately not a path client: a direct grant would muddy that first run, and
// nothing else needs one (the smoke test's Ember is attributed to the runner's processes, which started it).
// macOS 15 also puts up a modal alert before an unapproved binary captures the screen, which nobody answers on a
// runner: approve-capture writes replayd's approvals for the binaries that capture.
// usage: node scripts/package/tcc.mjs grant-paths [--ancestors] <binary>...
//        node scripts/package/tcc.mjs grant-bundle <app>
//        node scripts/package/tcc.mjs approve-capture <binary>...
//        node scripts/package/tcc.mjs show
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The system database: Accessibility, Screen Recording and Input Monitoring live here (writable with sudo). */
export const SYSTEM_DB = "/Library/Application Support/com.apple.TCC/TCC.db";

/** The user's database: Apple Events live here. */
export const userDb = home => path.posix.join(home, "Library/Application Support/com.apple.TCC/TCC.db");

/** replayd's screen-capture approvals (a plist; `defaults` adds the extension). */
export const captureApprovals = home => path.posix.join(home, "Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals");

/** Accessibility, Screen Recording, and Input Monitoring's two halves: posting events and listening to them. */
export const SYSTEM_SERVICES = ["kTCCServiceAccessibility", "kTCCServiceScreenCapture", "kTCCServicePostEvent", "kTCCServiceListenEvent"];

/** Apple Events, granted towards one target app only. */
export const APPLE_EVENTS = "kTCCServiceAppleEvents";

/** The target of Ember's Apple Events: System Events changes dark mode. */
export const SYSTEM_EVENTS = "com.apple.systemevents";

/** The magic number every compiled code requirement (csreq -b) starts with. */
const REQUIREMENT_MAGIC = 0xfade0c00;

/**
 * A compiled code requirement (csreq -b) saying `identifier "<id>" and anchor apple`, as hex: what tccd keeps as an
 * Apple Events row's target identity (indirect_object_code_identity), and what the runner image's own rows for System
 * Events carry. The blob: magic 0xfade0c00, its length, kind 1 (an expression), opAnd (6), opIdent (2) with the
 * identifier as a length-prefixed string padded to four bytes, opAppleAnchor (3).
 * @param {string} identifier
 */
export function appleAnchorRequirement(identifier) {
  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) throw new Error(`${JSON.stringify(identifier)} isn't a code identifier`);
  const id = Buffer.from(identifier, "ascii");
  const padded = Buffer.concat([id, Buffer.alloc((4 - (id.length % 4)) % 4)]);
  const words = (...n) => Buffer.concat(n.map(v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }));
  const body = Buffer.concat([words(1, 6, 2, id.length), padded, words(3)]);
  return Buffer.concat([words(REQUIREMENT_MAGIC, body.length + 8), body]).toString("hex");
}

/** System Events' requirement: the target identity of every Apple Events row CI writes. */
export const SYSTEM_EVENTS_REQUIREMENT = appleAnchorRequirement(SYSTEM_EVENTS);

/** An approval replayd keeps until this date (it asks again once a stored date has passed). */
export const CAPTURE_APPROVED_UNTIL = "3024-01-01 00:00:00 +0000";

/** A quoted SQL string. Control characters are refused: no client path or bundle id has them. */
function sqlText(s) {
  const text = String(s);
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${JSON.stringify(text)} has a control character`);
  return `'${text.replaceAll("'", "''")}'`;
}

/** A SQL blob literal from hex, or NULL. */
function sqlBlob(hex) {
  if (hex === null || hex === undefined) return "NULL";
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("a code requirement must be hex bytes");
  return `X'${hex}'`;
}

/**
 * One allowed grant, as an INSERT OR REPLACE (the table's key is service, client, client type and target). Columns
 * are named, so it works with every access-table layout macOS 13 to 15 have. auth_value 2 is "allowed", auth_reason 4
 * "set by the system". `targetCsreq` is the target app's code requirement (hex), for Apple Events.
 * @param {{ service: string; client: string; clientType: 0 | 1; csreq?: string | null; target?: string | null; targetCsreq?: string | null; now: number }} g
 */
export function grantSql(g) {
  if (g.clientType !== 0 && g.clientType !== 1) throw new Error(`client type ${g.clientType}: 0 is a bundle id, 1 a path`);
  if (!Number.isInteger(g.now) || g.now <= 0) throw new Error("now must be a Unix time in seconds");
  return "INSERT OR REPLACE INTO access(service,client,client_type,auth_value,auth_reason,auth_version,csreq,policy_id,"
    + "indirect_object_identifier_type,indirect_object_identifier,indirect_object_code_identity,flags,last_modified) "
    + `VALUES(${sqlText(g.service)},${sqlText(g.client)},${g.clientType},2,4,1,${sqlBlob(g.csreq)},NULL,0,${sqlText(g.target ?? "UNUSED")},${sqlBlob(g.targetCsreq)},0,${g.now});`;
}

/**
 * The grants for path clients: every system service for each, and Apple Events to System Events for each.
 * @param {string[]} clients absolute paths of binaries
 * @param {number} now
 * @returns {{ system: string[]; user: string[] }}
 */
export function pathGrants(clients, now) {
  if (!clients.length) throw new Error("name at least one binary");
  const bad = clients.find(c => !String(c).startsWith("/"));
  if (bad !== undefined) throw new Error(`a path client is an absolute path, not ${JSON.stringify(bad)}`);
  const unique = [...new Set(clients)].sort();
  return {
    system: unique.flatMap(client => SYSTEM_SERVICES.map(service => grantSql({ service, client, clientType: 1, now }))),
    user: unique.map(client => grantSql({ service: APPLE_EVENTS, client, clientType: 1, target: SYSTEM_EVENTS, targetCsreq: SYSTEM_EVENTS_REQUIREMENT, now })),
  };
}

/**
 * The grants for an app bundle, with its compiled code requirement (hex): every system service, and Apple Events to
 * System Events.
 * @param {string} bundleId
 * @param {string} csreq
 * @param {number} now
 * @returns {{ system: string[]; user: string[] }}
 */
export function bundleGrants(bundleId, csreq, now) {
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error(`${JSON.stringify(bundleId)} isn't a bundle id`);
  if (!csreq) throw new Error("a bundle client needs its code requirement");
  return {
    system: SYSTEM_SERVICES.map(service => grantSql({ service, client: bundleId, clientType: 0, csreq, now })),
    user: [grantSql({ service: APPLE_EVENTS, client: bundleId, clientType: 0, csreq, target: SYSTEM_EVENTS, targetCsreq: SYSTEM_EVENTS_REQUIREMENT, now })],
  };
}

/** Statements in one transaction, for one sqlite3 call. */
export const transaction = statements => `BEGIN;${statements.join("")}COMMIT;`;

/**
 * The designated requirement in `codesign -d -r- <app>`'s output: `designated => cdhash H"…"` (an ad hoc signature;
 * codesign prefixes "# " when the requirement is implicit, as it is for one).
 * @param {string} output
 */
export function designatedRequirement(output) {
  const m = /^(?:#\s*)?designated\s*=>\s*(.+?)\s*$/m.exec(String(output));
  if (!m) throw new Error(`codesign printed no designated requirement: ${String(output).trim() || "(nothing)"}`);
  return m[1];
}

/** A query for the grants of `services` in a database, one row each (the requirements as their sizes, not their bytes). */
export const showSql = services => "SELECT service, client, client_type, auth_value, "
  + "CASE WHEN csreq IS NULL THEN 'csreq NULL' ELSE 'csreq ' || length(csreq) || ' bytes' END, indirect_object_identifier, "
  + "CASE WHEN indirect_object_code_identity IS NULL THEN '' ELSE 'target csreq ' || length(indirect_object_code_identity) || ' bytes' END "
  + `FROM access WHERE service IN (${services.map(sqlText).join(",")}) ORDER BY service, client;`;

/**
 * The absolute executables of the processes above `pid`, nearest first (a process whose command isn't an absolute
 * path is skipped, and the walk stops at launchd). `ps(pid)` gives { ppid, comm } or null.
 * @param {number} pid
 * @param {(pid: number) => { ppid: number; comm: string } | null} ps
 */
export function ancestors(pid, ps) {
  const out = [];
  for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
    const info = ps(p);
    if (!info) break;
    if (info.comm.startsWith("/")) out.push(info.comm);
    p = info.ppid;
  }
  return out;
}

/** `ps -o ppid=,comm=` output: "  123 /path/with spaces/comm" → { ppid: 123, comm: "/path/with spaces/comm" }. */
export function parsePs(line) {
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(line));
  return m ? { ppid: Number(m[1]), comm: m[2] } : null;
}

/** @typedef {(file: string, args: string[], input?: string) => { status: number | null; stdout: string; stderr: string }} Run */

/** Runs a step, throwing with its output when it fails. */
function must(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  return r;
}

/**
 * Restarts the user's and the system's tccd so they read the databases again: launchctl kickstart (the user's as the
 * user, else with sudo), else pkill (launchd starts tccd again on the next request). Throws when nothing worked.
 * @param {{ run: Run; uid: number; log: (line: string) => void; sleep: (ms: number) => void }} o
 */
export function restartTccd(o) {
  const user = `gui/${o.uid}/com.apple.tccd`;
  const userOk = o.run("launchctl", ["kickstart", "-k", user]).status === 0 || o.run("sudo", ["launchctl", "kickstart", "-k", user]).status === 0;
  const systemOk = o.run("sudo", ["launchctl", "kickstart", "-k", "system/com.apple.tccd.system"]).status === 0;
  if (userOk && systemOk) o.log("restarted the user's and the system's tccd (launchctl kickstart)");
  else {
    must(o.run("sudo", ["pkill", "-x", "tccd"]), `restarting tccd (launchctl kickstart refused the ${userOk ? "system's" : "user's"}; then pkill)`);
    o.log("restarted tccd with pkill (launchctl kickstart was refused)");
  }
  o.sleep(2000);
}

/**
 * Writes the path grants for `clients` into both databases and restarts tccd.
 * @param {{ clients: string[]; run: Run; now: number; home: string; uid: number; log: (line: string) => void; sleep: (ms: number) => void }} o
 */
export function grantPaths(o) {
  const { system, user } = pathGrants(o.clients, o.now);
  must(o.run("sudo", ["sqlite3", SYSTEM_DB, transaction(system)]), "writing the system TCC database");
  must(o.run("sqlite3", [userDb(o.home), transaction(user)]), "writing the user's TCC database");
  for (const c of [...new Set(o.clients)].sort()) o.log(`granted Accessibility, Screen Recording, Input Monitoring (post, listen) and Apple Events to System Events: ${c}`);
  restartTccd(o);
}

/**
 * Writes the bundle grants for `app` (its bundle id and real code requirement) into both databases and restarts
 * tccd. Returns what was granted.
 * @param {{ app: string; run: Run; now: number; home: string; uid: number; tmp: string; log: (line: string) => void; sleep: (ms: number) => void }} o
 */
export function grantBundle(o) {
  const bundleId = must(o.run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.posix.join(o.app, "Contents/Info.plist")]), "reading the bundle id").stdout.trim();
  // codesign prints "Executable=…" on stderr and the requirement on stdout; both are searched.
  const shown = must(o.run("codesign", ["-d", "-r-", o.app]), `reading ${o.app}'s code requirement`);
  const requirement = designatedRequirement(`${shown.stdout}\n${shown.stderr}`);
  const blobFile = path.join(o.tmp, "ember-csreq.bin");
  must(o.run("csreq", ["-r-", "-b", blobFile], requirement), "compiling the code requirement");
  const blob = fs.readFileSync(blobFile);
  if (blob.length < 8 || blob.readUInt32BE(0) !== REQUIREMENT_MAGIC) throw new Error(`csreq wrote no code requirement to ${blobFile}`);
  const { system, user } = bundleGrants(bundleId, blob.toString("hex"), o.now);
  must(o.run("sudo", ["sqlite3", SYSTEM_DB, transaction(system)]), "writing the system TCC database");
  must(o.run("sqlite3", [userDb(o.home), transaction(user)]), "writing the user's TCC database");
  o.log(`granted Accessibility, Screen Recording, Input Monitoring (post, listen) and Apple Events to System Events: ${bundleId} (bundle id), requirement ${requirement} (${blob.length} bytes)`);
  restartTccd(o);
  return { bundleId, requirement };
}

/**
 * Approves screen capture for each binary until CAPTURE_APPROVED_UNTIL, then prints the approvals.
 * @param {{ binaries: string[]; run: Run; home: string; log: (line: string) => void }} o
 */
export function approveCapture(o) {
  if (!o.binaries.length) throw new Error("name at least one binary");
  const plist = captureApprovals(o.home);
  must(o.run("mkdir", ["-p", path.posix.dirname(plist)]), "making replayd's group container");
  for (const b of [...new Set(o.binaries)].sort()) {
    if (!b.startsWith("/")) throw new Error(`approve an absolute path, not ${JSON.stringify(b)}`);
    must(o.run("defaults", ["write", plist, b, "-date", CAPTURE_APPROVED_UNTIL]), `approving screen capture for ${b}`);
  }
  o.log(must(o.run("defaults", ["read", plist]), "reading the screen-capture approvals").stdout.trim());
}

/**
 * Prints the grants of Ember's services in both databases (the user's may be unreadable: said, not fatal).
 * @param {{ run: Run; home: string; log: (line: string) => void }} o
 */
export function showGrants(o) {
  const system = must(o.run("sudo", ["sqlite3", SYSTEM_DB, showSql(SYSTEM_SERVICES)]), "reading the system TCC database");
  o.log(`system database (${SYSTEM_DB}):\n${system.stdout.trim() || "(no rows)"}`);
  const user = o.run("sqlite3", [userDb(o.home), showSql([APPLE_EVENTS, ...SYSTEM_SERVICES])]);
  o.log(`user database (${userDb(o.home)}):\n${user.status === 0 ? user.stdout.trim() || "(no rows)" : `unreadable: ${user.stderr.trim()}`}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...rest] = process.argv.slice(2);
  /** @type {Run} */
  const run = (file, args, input) => {
    const r = spawnSync(file, args, { encoding: "utf8", input });
    return r.error ? { status: null, stdout: "", stderr: r.error.message } : { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const common = {
    run, home: os.homedir(), uid: process.getuid?.() ?? -1, now: Math.floor(Date.now() / 1000),
    log: line => console.log(line), sleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
  const usage = () => {
    console.error("usage: node scripts/package/tcc.mjs grant-paths [--ancestors] <binary>... | grant-bundle <app> | approve-capture <binary>... | show");
    process.exit(2);
  };
  try {
    if (process.platform !== "darwin") throw new Error("this writes macOS's TCC databases: run it on macOS");
    if (command === "grant-paths") {
      const named = rest.filter(a => a !== "--ancestors");
      if (!named.length) usage();
      // A symlinked binary (Homebrew's or setup-node's node) is granted under both names.
      const clients = named.flatMap(c => [path.resolve(c), ...(fs.existsSync(c) ? [fs.realpathSync(c)] : [])]);
      if (rest.includes("--ancestors")) {
        const ps = pid => parsePs(run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]).stdout.split("\n")[0]);
        clients.push(...ancestors(process.ppid, ps));
      }
      grantPaths({ ...common, clients });
    } else if (command === "grant-bundle" && rest.length === 1) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tcc-"));
      try { grantBundle({ ...common, app: path.resolve(rest[0]), tmp }); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    } else if (command === "approve-capture" && rest.length) {
      // A binary that doesn't exist yet (Ember.app before staging) is approved by the path it will have.
      approveCapture({ ...common, binaries: rest.flatMap(b => [path.resolve(b), ...(fs.existsSync(b) ? [fs.realpathSync(b)] : [])]) });
    } else if (command === "show" && !rest.length) {
      showGrants(common);
    } else usage();
  } catch (err) {
    console.error(`${process.env.GITHUB_ACTIONS === "true" ? "::error::" : ""}${err.message}`);
    process.exit(1);
  }
}
