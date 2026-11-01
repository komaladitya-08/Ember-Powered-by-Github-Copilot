// What a staged Ember looks like on each target, as data: where Electron's files go and under which names, which
// binary carries the fuses, which platform builds of the native packages ship, which sidecar and dist files are
// needed, and what the archives are called. stage.mjs, archive.mjs and the tests read it.
// It has no side effects and reads nothing from disk, so every target's layout can be unit-tested on Linux
// (test/unit/layout.test.ts). Each target is staged on its own OS: Electron and the native packages come from that
// machine's npm ci, so cross-staging is not supported.

/** The targets Ember is staged for, as `${platform}-${arch}`. linux-x64 is today's RPM/AppImage layout. */
export const TARGETS = ["linux-x64", "win32-x64", "win32-arm64", "darwin-arm64", "darwin-x64"];

/**
 * Packages published once per platform (npm installs only the host's). Every one of them that isn't the target's
 * own build is left out of the package: another OS's binaries, musl builds, sharp's wasm fallback.
 */
export const PLATFORM_FAMILIES = ["@github/copilot-sdk-", "@img/sharp-", "@koromix/koffi-"];

/**
 * The remote agent's parts for SSH targets (scripts/package/remote-parts.mjs): dist/remote-parts/ is staged as this
 * folder under every target's resources folder (stage.mjs), where the PC finds the archive it sends a remote.
 */
export const REMOTE_PARTS_DIR = "remote-parts";

/** Packages never bundled: tslib is only @emnapi's, and @emnapi is only sharp's wasm fallback's. */
const NEVER_BUNDLED = name => name === "tslib" || name.startsWith("@emnapi/");

/** The Copilot runtime's helpers for its own built-in tools, pruned on every target (see stage.mjs). */
const COPILOT_TOOLS = ["ripgrep", "tgrep", "plugins", "builtin-skills"];

/** Built files every target needs (relative to dist/app). A trailing "/" means a folder that must not be empty. */
const COMMON_DIST = ["main.cjs", "renderer/shared/ember.css", "renderer/fonts/InterVariable.woff2", "renderer/fonts/LICENSE.txt", "voice.cjs", "preload/", "renderer/"];

/**
 * The SSH and command helpers Ember starts beside main.cjs, which fail only at first use when missing: the SSH link
 * worker (remote-link.cjs) everywhere, the password helper ssh runs (askpass.cjs) on Linux and macOS (Linux runs it as
 * plain Node; macOS, whose build refuses node mode, as a worker thread of Ember's own askpass mode, review #177;
 * Windows compiles ember-askpass.exe instead), and Windows' command job host (job-host.cjs).
 */
const POSIX_HELPERS = ["askpass.cjs", "remote-link.cjs"];
const WINDOWS_HELPERS = ["remote-link.cjs", "job-host.cjs"];

/**
 * The layout of one target. Paths are POSIX-style; join them with path.join on the OS that stages.
 * @param {string} platform process.platform of the target ("linux", "win32" or "darwin")
 * @param {string} arch process.arch of the target ("x64" or "arm64")
 * @returns {import("./layout.d.mts").Layout}
 */
export function layoutFor(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!TARGETS.includes(target)) throw new Error(`Ember isn't staged for ${target} (targets: ${TARGETS.join(", ")})`);
  const copilot = `@github/copilot-sdk-${target}`;
  const koffi = `@koromix/koffi-${target}`;
  const koffiDir = `${koffi}/${platform}_${arch}`;
  const tools = COPILOT_TOOLS.map(d => `${copilot}/${d}`);
  if (platform === "linux") {
    return {
      platform, arch, target, label: target,
      // Electron's whole dist folder becomes dist/package/ember, its binary renamed "ember" (rpm.sh, appimage.sh
      // and the installed /opt/ember expect these names).
      electronSource: ".", electronExe: "electron", electronFuseFile: "electron",
      appDir: "ember", exe: "ember", renames: [["electron", "ember"]],
      resourcesDir: "resources", noticesDir: ".", electronNotices: [],
      fuseFile: "ember", remove: ["resources/default_app.asar"],
      platformPackages: [copilot, `@img/sharp-${target}`, `@img/sharp-libvips-${target}`, koffi],
      // koffi's musl build: Ember runs on glibc.
      prune: [`${koffi}/musl_x64`, ...tools],
      sidecarFiles: [{ from: "sidecar/atspi/ember_atspi.py", to: "sidecar/atspi/ember_atspi.py" }],
      // The desk helper (run as plain Node beside main.cjs) is Linux-only, like the desk.
      requiredDist: [...COMMON_DIST.slice(0, 1), "desk-agent.cjs", ...COMMON_DIST.slice(1), ...POSIX_HELPERS],
      sidecarDist: [],
      // The Windows/macOS accessibility host never runs here (the Python AT-SPI sidecar does).
      excludeDist: ["ax-sidecar.cjs"],
      icon: null, exeResources: false, signing: null, voiceModels: "beside",
    };
  }
  if (platform === "win32") {
    return {
      platform, arch, target, label: `win-${arch}`,
      // The folder users unzip: Ember\Ember.exe.
      electronSource: ".", electronExe: "electron.exe", electronFuseFile: "electron.exe",
      appDir: "Ember", exe: "Ember.exe", renames: [["electron.exe", "Ember.exe"]],
      resourcesDir: "resources", noticesDir: ".", electronNotices: [],
      fuseFile: "Ember.exe", remove: ["resources/default_app.asar"],
      // sharp's Windows builds carry libvips themselves (there is no @img/sharp-libvips-win32-* package).
      platformPackages: [copilot, `@img/sharp-${target}`, koffi],
      // koffi's import library and exports file are for linking against it, not for loading it.
      prune: [`${koffiDir}/koffi.lib`, `${koffiDir}/koffi.exp`, ...tools],
      // The UI Automation bridge: compiled by Windows PowerShell 5.1 at run time, so it ships as source. The AT-SPI
      // sidecar is the helper Ember runs inside WSL distros to read WSLg's Linux apps (SSH/WSL design §4.3). SSH's
      // askpass helper is compiled the same way at first use, from resources\ssh (askpass-win.ts, §5.1.6).
      sidecarFiles: [
        { from: "sidecar/uia/ember_uia.ps1", to: "sidecar/uia/ember_uia.ps1" },
        { from: "sidecar/uia/ember_uia.cs", to: "sidecar/uia/ember_uia.cs" },
        { from: "sidecar/atspi/ember_atspi.py", to: "sidecar/atspi/ember_atspi.py" },
        { from: "resources/ssh/ember_askpass.cs", to: "ssh/ember_askpass.cs" },
      ],
      // `ember --doctor` for a console: Ember.exe is a windowed program, which cmd.exe doesn't wait for (design §9.9).
      launchers: [{ from: "packaging/windows/ember-doctor.cmd", to: "ember-doctor.cmd" }],
      requiredDist: [...COMMON_DIST, "ax-sidecar.cjs", ...WINDOWS_HELPERS],
      // The accessibility host, run as Ember's own binary in node mode (ELECTRON_RUN_AS_NODE).
      sidecarDist: ["ax-sidecar.cjs"],
      excludeDist: ["desk-agent.cjs"],
      // For shortcuts and windows, and written into Ember.exe with its version resource (exe-resources.mjs).
      icon: { kind: "ico", file: "resources/ember.ico" },
      exeResources: true, signing: null, voiceModels: "inside",
    };
  }
  return {
    platform, arch, target, label: `mac-${arch}`,
    // Copying Electron.app as Ember.app names the bundle. Its executable is renamed too (with Info.plist's
    // CFBundleExecutable, mac-bundle.mjs): Electron's app.isPackaged is false for any executable named "electron"
    // (checked), and a packaged Ember that takes itself for a development build honours EMBER_* overrides from
    // the environment and starts with --inspect. The helper apps keep Electron's names: Electron looks for
    // "Electron Helper*.app" first, whatever its executable is called.
    electronSource: "Electron.app", electronExe: "Electron.app/Contents/MacOS/Electron",
    electronFuseFile: "Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    appDir: "Ember.app", exe: "Contents/MacOS/Ember", renames: [["Contents/MacOS/Electron", "Contents/MacOS/Ember"]],
    resourcesDir: "Contents/Resources",
    // Electron's licences sit beside Electron.app in its dist folder: they move inside the bundle, or the shipped
    // app would carry no Chromium licences.
    noticesDir: "Contents/Resources", electronNotices: ["LICENSE", "LICENSES.chromium.html", "version"],
    // The fuse wire is in the framework, not in the small launcher executable.
    fuseFile: "Contents/Frameworks/Electron Framework.framework/Electron Framework",
    remove: ["Contents/Resources/default_app.asar"],
    platformPackages: [copilot, `@img/sharp-${target}`, `@img/sharp-libvips-${target}`, koffi],
    // libvips's glib headers are for building against it.
    prune: [`@img/sharp-libvips-${target}/lib/glib-2.0`, ...tools],
    sidecarFiles: [],
    requiredDist: [...COMMON_DIST, "ax-sidecar.cjs", ...POSIX_HELPERS],
    sidecarDist: ["ax-sidecar.cjs"],
    excludeDist: ["desk-agent.cjs"],
    icon: { kind: "icns", file: "Contents/Resources/ember.icns", replaces: "Contents/Resources/electron.icns" },
    // Info.plist names the bundle (mac-bundle.mjs); there is no PE resource to rewrite.
    exeResources: false,
    // Flipping the fuses breaks Electron's signature, and arm64 macOS kills unsigned code: re-signed ad hoc.
    signing: "adhoc", voiceModels: "inside",
  };
}

/**
 * The archives archive.mjs makes from the staged app (file names in dist/package). Linux has none here: rpm.sh and
 * appimage.sh name their own.
 * @param {import("./layout.d.mts").Layout} layout
 * @param {string} version package.json's version
 */
export function artifactNames(layout, version) {
  if (layout.platform === "win32") return [`Ember-${version}-${layout.label}.zip`];
  if (layout.platform === "darwin") return [`Ember-${version}-${layout.label}.zip`, `Ember-${version}-${layout.label}.dmg`];
  return [];
}

/**
 * The package name of a folder in node_modules, from its path (either separator):
 * ".../node_modules/@img/sharp-win32-x64" → "@img/sharp-win32-x64"; null if the path isn't in node_modules.
 * @param {string} dir
 */
export function packageNameOf(dir) {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const first = parts[at + 1];
  if (!first.startsWith("@")) return first;
  return at + 2 < parts.length ? `${first}/${parts[at + 2]}` : null;
}

/**
 * Which production packages ship for `layout`: every package except other platforms' builds and the never-bundled
 * ones. `missing` lists the target's own platform builds that aren't installed (staging must stop: the app would
 * start without its Copilot runtime, image library or FFI).
 * @param {string[]} dirs the production package folders (from npm ls)
 * @param {import("./layout.d.mts").Layout} layout
 */
export function selectPackages(dirs, layout) {
  const bundle = [], skipped = [];
  const found = new Set();
  for (const dir of dirs) {
    const name = packageNameOf(dir);
    if (name === null) { skipped.push({ dir, name: dir, why: "not in node_modules" }); continue; }
    if (layout.platformPackages.includes(name)) { bundle.push(dir); found.add(name); continue; }
    if (PLATFORM_FAMILIES.some(f => name.startsWith(f))) { skipped.push({ dir, name, why: `not ${layout.target}'s build` }); continue; }
    if (NEVER_BUNDLED(name)) { skipped.push({ dir, name, why: "only sharp's wasm fallback uses it" }); continue; }
    bundle.push(dir);
  }
  return { bundle, skipped, missing: layout.platformPackages.filter(n => !found.has(n)) };
}

/**
 * The package folders in `npm ls --parseable` output, as paths under `root`, without the root itself.
 * npm prints the root first; every other line is made relative to what npm printed for it and joined to `root`.
 * That survives npm's differences from `root`: another drive-letter case on Windows, a symlinked checkout, and
 * npm's log redaction (it masks anything shaped like a token, such as a UUID in a folder name).
 * @param {string} output npm's stdout
 * @param {string} root the repository root
 * @param {{ join(...p: string[]): string; relative(from: string, to: string): string }} pathApi node:path (or path.win32 in tests)
 */
export function prodPackageDirs(output, root, pathApi) {
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const printedRoot = lines[0];
  return lines.slice(1).map(l => pathApi.relative(printedRoot, l)).filter(r => r !== "").map(r => pathApi.join(root, r));
}

/**
 * How to run npm with `args` from Node on `platform`. Windows's npm is npm.cmd, which Node refuses to spawn without a
 * shell (CVE-2024-27980): run npm's own CLI script with this Node when npm started us (npm_execpath), else go through
 * the shell with a fixed command line (the arguments are literals, never user input).
 * @param {{ platform: string; execPath: string; npmExecPath?: string }} host
 * @param {string[]} args
 * @returns {{ file: string; args: string[]; shell: boolean }}
 */
export function npmInvocation(host, args) {
  if (host.platform !== "win32") return { file: "npm", args, shell: false };
  if (host.npmExecPath && /^npm-cli\.c?js$/i.test(host.npmExecPath.split(/[\\/]/).pop() ?? "")) {
    return { file: host.execPath, args: [host.npmExecPath, ...args], shell: false };
  }
  // Letters, digits and . = - _ @ / only: none is special to cmd.exe, and a scoped package spec needs @ and /.
  const unsafe = args.find(a => !/^[\w.=@/-]+$/.test(a));
  if (unsafe !== undefined) throw new Error(`won't pass ${JSON.stringify(unsafe)} to npm through the shell`);
  return { file: ["npm", ...args].join(" "), args: [], shell: true };
}
