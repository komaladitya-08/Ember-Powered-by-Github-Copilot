// Types for tar-writer.mjs (remote-parts.mjs and the unit tests import it).

/** One entry of a tar archive: a file with its bytes, or a folder. */
export interface TarEntry {
  /** Relative, "/"-separated, no "." or ".." parts. */
  path: string;
  mode: number;
  data?: Uint8Array;
  dir?: boolean;
}

/** A ustar archive of `entries`, sorted by name, mtime 0, uid and gid 0, padded to whole 10 KiB records. */
export function tarArchive(entries: TarEntry[]): Buffer;
/** `data` gzipped at level 9 with mtime 0 and the Unix OS byte in its header. */
export function gzip(data: Uint8Array): Buffer;
/** The files and folders of an uncompressed tar archive as npm pack writes it; throws on anything else. */
export function readTar(tar: Uint8Array): { path: string; mode: number; dir: boolean; data: Buffer }[];
