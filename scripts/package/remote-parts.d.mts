// Types for remote-parts.mjs, and the shapes of what it writes (dist/remote-parts/remote-parts.json) and of
// remote-runtime.json beside it, which the PC reads before it sends anything to a remote (SA's runtime-download and
// plan, TG's doctor). Each parts archive holds the parts folder's contents at its root (no top folder): unpack it into
// the folder that becomes versions/<partsId>/.

/** The targets an agent runs on in v1. */
export type PartsTarget = "linux-x64" | "linux-arm64" | "darwin-arm64" | "darwin-x64";
export const PARTS_TARGETS: PartsTarget[];

/** One archive: its file name in dist/remote-parts (resources/remote-parts once staged), SHA-256 and size. */
export interface PartsArchive { file: string; sha256: string; bytes: number }

/** dist/remote-parts/remote-parts.json. */
export interface RemoteParts {
  /** Ember's version, "-", and 12 hex digits of the SHA-256 of every target's manifest.sha256 ("0.1.0-0123456789ab"). */
  partsId: string;
  targets: Record<PartsTarget, PartsArchive>;
}

/** scripts/package/remote-runtime.json: the Node runtime for remotes (design §5.2.1). */
export interface RemoteRuntime {
  /** How `pinned` was chosen and its hashes checked (the release's SHASUMS256.txt signature, once). */
  verification: string;
  /** The oldest Node 24 a remote may keep using (rises only for security releases). */
  minimum: string;
  /** The Node 24 release the PC uploads when a remote has none at or above `minimum`. */
  pinned: string;
  /** nodejs.org/dist/v<pinned>/<file> (or the admin's mirror, same layout); `xz` when the remote has xz, else `gz`. */
  targets: Record<PartsTarget, { xz: PartsArchive; gz: PartsArchive }>;
}

/** The newest symbol versions a Linux binary in the parts may need (RHEL 8). */
export const GLIBC_FLOOR: { GLIBC: string; GLIBCXX: string; CXXABI: string };
/** The symbol versions a 64-bit little-endian ELF file needs ("GLIBC_2.17", …), sorted. */
export function elfVersionNeeds(bytes: Uint8Array): string[];
/** The needs of `bytes` newer than GLIBC_FLOOR ([] when it runs on RHEL 8). */
export function tooNew(bytes: Uint8Array): string[];
/** Is `bytes` what a lockfile integrity string names? */
export function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean;
/** manifest.sha256's text (`sha256sum -c` format, sorted by path). */
export function manifestText(files: { path: string; data: Uint8Array }[]): string;
/** Ember's version + "-" + 12 hex digits of the SHA-256 of the manifests concatenated. */
export function partsIdOf(version: string, manifests: string[]): string;

/** What buildParts needs (every file's bytes; the koffi files of each Linux target under node_modules/). */
export interface PartsInputs {
  version: string;
  bundle: Uint8Array;
  atspi: Uint8Array;
  notice: Uint8Array;
  uninstall: Uint8Array;
  readme: Uint8Array;
  license: Uint8Array;
  notices: (target: PartsTarget) => Uint8Array;
  koffi: Partial<Record<PartsTarget, { path: string; data: Uint8Array }[]>>;
}
/** Every target's archive, the parts id and remote-parts.json's content (pure). */
export function buildParts(i: PartsInputs): { partsId: string; archives: { target: PartsTarget; file: string; bytes: Buffer }[]; json: RemoteParts };
/** remote-runtime.json: scripts/package/ holds it; it is written beside the parts and staged with them. */
export const RUNTIME_FILE: "remote-runtime.json";
/** Writes built parts into `out` (replacing it): the archives, remote-parts.json and the runtime policy's text. */
export function writeParts(out: string, built: { archives: { file: string; bytes: Uint8Array }[]; json: unknown }, runtimeText: string): void;
/** Copies the parts from `src` to `dest` (stage.mjs), each archive checked against remote-parts.json; throws on anything missing or different. */
export function stageParts(src: string, dest: string): void;
/** Builds every part into --out (default dist/remote-parts). */
export function main(argv?: string[]): { partsId: string; archives: { target: PartsTarget; file: string; bytes: Buffer }[]; json: RemoteParts };
