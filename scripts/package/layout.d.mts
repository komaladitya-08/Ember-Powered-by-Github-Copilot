// Types for layout.mjs (stage.mjs, archive.mjs and the unit tests import it).

/** One target's staged layout. Paths are POSIX-style and relative to the folder named in each field's comment. */
export interface Layout {
  platform: "linux" | "win32" | "darwin";
  arch: "x64" | "arm64";
  /** `${platform}-${arch}`, as npm names platform packages. */
  target: string;
  /** The target in archive names: "win-x64", "mac-arm64" (Linux: "linux-x64", unused). */
  label: string;
  /** What in Electron's dist folder becomes the app folder ("." or "Electron.app"). */
  electronSource: string;
  /** Electron's executable, relative to its dist folder (what require("electron") returns the path of). */
  electronExe: string;
  /** The binary with the fuse wire in an unpacked Electron, relative to its dist folder. */
  electronFuseFile: string;
  /** The app folder's name in dist/package. */
  appDir: string;
  /** Ember's executable, relative to the app folder. */
  exe: string;
  /** Renames inside the app folder after the copy: [from, to]. */
  renames: [string, string][];
  /** Electron's resources folder (process.resourcesPath), relative to the app folder. */
  resourcesDir: string;
  /** Where THIRD_PARTY_NOTICES and Electron's licences go, relative to the app folder. */
  noticesDir: string;
  /** Files of Electron's dist folder copied into noticesDir (those not already inside the app folder). */
  electronNotices: string[];
  /** The binary whose fuses are flipped, relative to the app folder. */
  fuseFile: string;
  /** Files of Electron's to delete, relative to the app folder. */
  remove: string[];
  /** The target's own builds of the per-platform packages; all must be installed. */
  platformPackages: string[];
  /** Folders and files to delete, relative to resources/app/node_modules. */
  prune: string[];
  /** Sidecar files: `from` relative to the repository, `to` relative to resourcesDir. */
  sidecarFiles: { from: string; to: string }[];
  /** Scripts beside the executable (Windows: ember-doctor.cmd): `from` relative to the repository, `to` to the app folder. */
  launchers?: { from: string; to: string }[];
  /** Built files the target needs, relative to dist/app ("x/" means a non-empty folder). */
  requiredDist: string[];
  /** The subset of requiredDist that --allow-missing-sidecar tolerates (built by a later phase of the port). */
  sidecarDist: string[];
  /** Built files left out of this target, relative to dist/app. */
  excludeDist: string[];
  /** The app icon stage.mjs writes, relative to the app folder (null: none). */
  icon: null | { kind: "ico"; file: string } | { kind: "icns"; file: string; replaces: string };
  /**
   * true: stage.mjs writes Ember's version resource and the ico icon into the executable and leaves out its certificate
   * table, before the fuses are flipped (Windows; exe-resources.mjs).
   */
  exeResources: boolean;
  /** "adhoc": the bundle is re-signed ad hoc after every byte has changed (macOS). */
  signing: null | "adhoc";
  /** "beside": dist/package/voice-models (the RPM sub-package); "inside": resources/voice-models, with --with-models. */
  voiceModels: "beside" | "inside";
}

export declare const TARGETS: string[];
export declare const PLATFORM_FAMILIES: string[];
export declare function layoutFor(platform: string, arch: string): Layout;
export declare function artifactNames(layout: Layout, version: string): string[];
export declare function packageNameOf(dir: string): string | null;
export declare function selectPackages(dirs: string[], layout: Layout): {
  bundle: string[];
  skipped: { dir: string; name: string; why: string }[];
  missing: string[];
};
export declare function prodPackageDirs(
  output: string,
  root: string,
  pathApi: { join(...p: string[]): string; relative(from: string, to: string): string },
): string[];
export declare function npmInvocation(
  host: { platform: string; execPath: string; npmExecPath?: string },
  args: string[],
): { file: string; args: string[]; shell: boolean };
