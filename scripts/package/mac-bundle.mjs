// Finishes a staged Ember.app on macOS, after every other byte is in place: Info.plist says "Ember" (with the bundle
// id TCC grants are keyed to and the usage texts macOS shows in its prompts), the icon, then an ad hoc signature
// over the whole bundle. Signing must come last: flipping the fuses changed the Electron Framework binary, which
// voids Electron's signature, and arm64 macOS kills code whose signature doesn't match. Real certificates and
// notarisation are out of scope (an ad hoc signature is a new identity to TCC on every build).
// Info.plist is edited with plutil and read back key by key; the commands go through an injectable runner so the
// sequence can be tested on any OS.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The bundle id: TCC grants, the single-instance lock and the defaults domain hang on it (no "_" allowed). */
export const BUNDLE_ID = "io.github.komaladitya08.ember";

/** Contents/MacOS/<this>: stage.mjs renames Electron's executable to it (layout.mjs says why). */
export const EXECUTABLE = "Ember";

/**
 * What Info.plist must say, as [key, type, value]. Electron's own plist provides the rest (NSPrincipalClass, the
 * helpers' names). There is no usage text for Accessibility or Screen Recording: those prompts come from the APIs
 * themselves.
 * @param {string} version package.json's version
 * @returns {[string, "string" | "bool", string | boolean][]}
 */
export function infoPlistValues(version) {
  return [
    ["CFBundleName", "string", "Ember"],
    ["CFBundleDisplayName", "string", "Ember"],
    ["CFBundleIdentifier", "string", BUNDLE_ID],
    ["CFBundleExecutable", "string", EXECUTABLE],
    ["CFBundleShortVersionString", "string", version],
    ["CFBundleVersion", "string", version],
    ["CFBundleIconFile", "string", "ember.icns"],
    ["LSApplicationCategoryType", "string", "public.app-category.productivity"],
    ["LSMinimumSystemVersion", "string", "13.0"],
    ["NSHighResolutionCapable", "bool", true],
    // Without it, macOS refuses the microphone silently.
    ["NSMicrophoneUsageDescription", "string", "Ember listens for “Hey Ember” on this Mac only when you turn it on. Audio never leaves your Mac."],
    // Changing dark mode goes through System Events (osascript).
    ["NSAppleEventsUsageDescription", "string", "Ember changes appearance settings, such as dark mode, when you ask it to."],
    // macOS 15 asks before an app reaches the local network: an organisation's model service or proxy can be there, and
    // so can a computer Ember works on over SSH (design §5.1.8, critique remote-29).
    ["NSLocalNetworkUsageDescription", "string", "Ember connects to your organisation's model service or proxy, and to computers you connect to over SSH, when they are on your local network."],
  ];
}

/** Keys of Electron's that don't describe Ember: dropped when present. */
export const INFO_PLIST_DROP = ["ElectronTeamID", "ElectronAsarIntegrity"];

/** What `plutil -extract <key> raw` prints for a value. */
const raw = value => (typeof value === "boolean" ? String(value) : value);

/**
 * Edits, checks and signs Ember.app. `run(file, args)` runs a command and returns { status, stdout, stderr };
 * `writeIconset(svg, dir)` renders the icon's images (icon.mjs). Throws on the first step that fails.
 * @param {{ app: string; version: string; svg: string; tmp: string;
 *   run?: (file: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
 *   writeIconset: (svg: string, dir: string) => Promise<void>; log?: (line: string) => void }} o
 */
export async function finishMacBundle(o) {
  const run = o.run ?? defaultRun;
  const log = o.log ?? (() => {});
  const must = (file, args, what) => {
    const r = run(file, args);
    if (r.status !== 0) throw new Error(`${what} failed (${file} ${args.join(" ")}): ${(r.stderr || r.stdout).trim()}`);
    return r;
  };
  const plist = path.join(o.app, "Contents", "Info.plist");
  // Info.plist names the renamed executable; a bundle whose CFBundleExecutable is missing doesn't launch.
  if (!fs.existsSync(path.join(o.app, "Contents", "MacOS", EXECUTABLE))) throw new Error(`${o.app} has no Contents/MacOS/${EXECUTABLE}`);

  // 1. Info.plist, as XML so the edits stay readable in a diff of two builds.
  must("plutil", ["-convert", "xml1", plist], "converting Info.plist to XML");
  const values = infoPlistValues(o.version);
  for (const [key, type, value] of values) {
    must("plutil", ["-replace", key, `-${type}`, type === "bool" ? (value ? "YES" : "NO") : String(value), plist], `setting ${key}`);
  }
  // Present or not, asked in xml1: raw is for strings, numbers and booleans, and ElectronAsarIntegrity is a dictionary.
  for (const key of INFO_PLIST_DROP) {
    if (run("plutil", ["-extract", key, "xml1", "-o", "-", plist]).status === 0) must("plutil", ["-remove", key, plist], `removing ${key}`);
  }
  // Read every value back (-o -: without it, -extract would overwrite the file with the value).
  for (const [key, , value] of values) {
    const got = run("plutil", ["-extract", key, "raw", "-o", "-", plist]);
    if (got.status !== 0 || got.stdout.trim() !== raw(value)) {
      throw new Error(`Info.plist's ${key} is ${got.status === 0 ? JSON.stringify(got.stdout.trim()) : "missing"}, should be ${JSON.stringify(raw(value))}`);
    }
  }
  must("plutil", ["-lint", plist], "checking Info.plist");
  log(`  Info.plist: ${BUNDLE_ID} ${o.version}`);

  // 2. The icon, from the same SVG as every other target's.
  const iconset = path.join(o.tmp, "ember.iconset");
  await o.writeIconset(o.svg, iconset);
  const icns = path.join(o.app, "Contents", "Resources", "ember.icns");
  must("iconutil", ["-c", "icns", "-o", icns, iconset], "building ember.icns");
  if (!fs.existsSync(icns)) throw new Error(`iconutil wrote no ${icns}`);
  fs.rmSync(path.join(o.app, "Contents", "Resources", "electron.icns"), { force: true });

  // 3. The signature, over everything (frameworks and helper apps inside out, then the app). Extended attributes
  //    (a quarantine flag, Finder info) make codesign refuse with "resource fork … not allowed".
  must("xattr", ["-cr", o.app], "clearing extended attributes");
  must("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", o.app], "signing Ember.app ad hoc");
  must("codesign", ["--verify", "--deep", "--strict", "--verbose=2", o.app], "verifying Ember.app's signature");
  log("  signed ad hoc and verified (codesign --verify --deep --strict)");
}

/** Runs a command, capturing its output. */
function defaultRun(file, args) {
  const r = spawnSync(file, args, { encoding: "utf8" });
  if (r.error) return { status: null, stdout: "", stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
