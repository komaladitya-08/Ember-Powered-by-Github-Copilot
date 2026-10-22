/**
 * Decoding what wsl.exe prints (§4.1). The inbox wsl.exe writes its own output (`--list`, `--version`, its error
 * messages) as UTF-16LE whatever the console, the Store/MSI WSL honours `WSL_UTF8=1` and writes UTF-8, and what a
 * command inside a distro prints is the distro's own bytes (UTF-8). So the encoding is sniffed per output, never
 * assumed: NULs at odd offsets near the start mean UTF-16LE. Pure; every OS imports it (tests run on Linux).
 */

/** How far into an output the encoding is sniffed (the design's 64 bytes). */
const SNIFF_BYTES = 64;

const UTF16 = new TextDecoder("utf-16le");
const UTF8 = new TextDecoder("utf-8");
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/** True when `bytes` holds a NUL at an odd offset within its first `limit` bytes (ASCII in UTF-16LE). */
function oddNul(bytes: Uint8Array, limit: number): boolean {
  const end = Math.min(bytes.length, limit);
  for (let i = 1; i < end; i += 2) if (bytes[i] === 0) return true;
  return false;
}

/** True when `bytes` is valid UTF-8 (a NUL-free UTF-8 output never looks like UTF-16LE). */
function validUtf8(bytes: Uint8Array): boolean {
  try {
    UTF8_STRICT.decode(bytes);
    return true;
  } catch {
    return false; // not UTF-8: the caller tries UTF-16LE
  }
}

/**
 * Whether wsl.exe wrote `bytes` as UTF-16LE: a UTF-16LE byte-order mark, or a NUL at an odd offset in the first 64
 * bytes. Output whose first 64 bytes hold no NUL at all (32 non-Latin characters in a row) is UTF-16LE only when it
 * isn't valid UTF-8 and has such NULs further on.
 */
export function isUtf16le(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  if (oddNul(bytes, SNIFF_BYTES)) return true;
  if (bytes.length <= SNIFF_BYTES || bytes.subarray(0, SNIFF_BYTES).includes(0)) return false;
  return !validUtf8(bytes) && oddNul(bytes, bytes.length);
}

/**
 * wsl.exe's output as text: UTF-16LE (its byte-order mark dropped) or UTF-8 (a UTF-8 byte-order mark dropped);
 * invalid sequences become U+FFFD. Nothing else is changed.
 */
export function decodeWsl(bytes: Uint8Array): string {
  if (isUtf16le(bytes)) {
    const even = bytes.length - (bytes.length % 2);
    // TextDecoder drops a leading byte-order mark itself (ignoreBOM is false).
    return UTF16.decode(bytes.subarray(0, even));
  }
  return UTF8.decode(bytes);
}

/** wsl.exe's output as lines: decoded, `\r` stripped, each line trimmed, empty lines dropped (§4.1). */
export function decodeLines(bytes: Uint8Array): string[] {
  return decodeWsl(bytes)
    .replace(/\r/g, "")
    .split("\n")
    .map(l => l.replace(/\0/g, "").trim())
    .filter(l => l !== "");
}

/**
 * wsl.exe's (or a launcher's) error output as one plain sentence for "Couldn't start: …": decoded, terminal codes and
 * control characters removed, lines joined with a space, at most `max` characters (an ellipsis marks a cut).
 */
export function decodeMessage(bytes: Uint8Array, max = 300): string {
  const text = decodeLines(bytes)
    // eslint-disable-next-line no-control-regex -- terminal codes are exactly what is removed here
    .map(l => l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim())
    .filter(l => l !== "")
    .join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
