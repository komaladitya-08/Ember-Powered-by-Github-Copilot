/**
 * Pictures from a session (a tool's image result, `tool.execution_complete` `result.binaryResultsForLlm` and
 * `result.contents`, and `session.binary_asset`): untrusted bytes from the runtime, an MCP server or a generated
 * image, shown only as a data URL the page builds itself (never a URL the payload names, so nothing loads from the
 * network or navigates). Only PNG, JPEG, GIF and WebP whose first bytes are that format's own, as whole base64 within
 * IMAGE_DATA_MAX characters: never SVG (it is a document), never data main cut to fit an event (it ends "…"), and
 * never base64 the runtime's own redaction put stars into (probed on runtime 1.0.97: its secret filter masks every
 * occurrence of a provider's key, inside base64 too). Pure: unit-tested in test/unit/code-transcript-events.test.ts.
 */
import { arr, rec, str } from "./sdk";

/** The picture types a coding window draws. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Base64 characters of one picture at most (main cuts any string past 128 KiB before it reaches the window). */
export const IMAGE_DATA_MAX = 2 * 1024 * 1024;
/** Pictures one tool row draws at most. */
export const IMAGES_PER_ITEM = 8;

/** Whether the first bytes are `mime`'s own signature. */
function signed(mime: string, head: string): boolean {
  const b = (i: number) => head.charCodeAt(i);
  switch (mime) {
    case "image/png": return head.startsWith("\x89PNG\r\n\x1a\n");
    case "image/jpeg": return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
    case "image/gif": return head.startsWith("GIF87a") || head.startsWith("GIF89a");
    case "image/webp": return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
    default: return false;
  }
}

/** The data URL a picture is drawn from, or null when it isn't one the window draws safely. */
export function imageSrc(mimeType: unknown, data: unknown): string | null {
  if (typeof mimeType !== "string" || !(IMAGE_TYPES as readonly string[]).includes(mimeType)) return null;
  if (typeof data !== "string" || data.length < 16 || data.length > IMAGE_DATA_MAX || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  let head: string;
  try { head = atob(data.slice(0, 16)); } catch { return null; /* not base64 after all */ }
  return signed(mimeType, head) ? `data:${mimeType};base64,${data}` : null;
}

/** One picture of a session, as an item or a tool row draws it. */
export interface Picture { src: string; description?: string }
/** A picture that couldn't be drawn: how many there were (the row says so instead). */
export interface Pictures { shown: Picture[]; withheld: number }

/** The pictures of a tool's result (`binaryResultsForLlm` and `contents` of type "image"), each once. */
export function resultPictures(result: unknown): Pictures {
  const shown: Picture[] = [];
  const seen = new Set<string>();
  let withheld = 0;
  for (const p of [...arr(result, "binaryResultsForLlm"), ...arr(result, "contents")]) {
    if (str(p, "type") !== "image") continue;
    const o = rec(p);
    const src = imageSrc(o?.mimeType, o?.data);
    if (!src) { withheld++; continue; }
    if (seen.has(src)) continue;
    seen.add(src);
    if (shown.length >= IMAGES_PER_ITEM) { withheld++; continue; }
    shown.push({ src, ...(str(p, "description") ? { description: str(p, "description")!.slice(0, 400) } : {}) });
  }
  return { shown, withheld };
}
