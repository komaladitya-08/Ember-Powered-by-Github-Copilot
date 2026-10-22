/**
 * Every character of a command or an untrusted prompt made visible (§3.9.1, critique security-10), for the command and
 * prompt windows' pages. The rules are CL's `visibleText` in `app/shared/visible-text.ts` (the one module both windows
 * and main's checks use, so what the card shows and what the classifier flags can't drift apart); this module adds what
 * the pages need around it: a segment's label, where a line ends, and which legend lines a string needs. Renderer-safe
 * and pure.
 */

import { visibleText, type VisibleSegment } from "../../shared/visible-text";

export { visibleText, type VisibleSegment };

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * What a segment shows. visibleText's segments carry their token ("⟨RLO⟩", "→"); a segment that carries the raw
 * character instead (from elsewhere) is shown the same way, and a raw character with no token of its own by its code
 * point, so nothing special ever reaches the page as itself.
 */
export function segmentLabel(seg: VisibleSegment): string {
  if (seg.kind === "plain" || seg.kind === "mixed") return seg.text;
  if (seg.kind === "tab") return seg.text === "\t" ? "→" : seg.text;
  if (seg.text.startsWith("⟨")) return seg.text;
  return [...seg.text].map(ch => {
    const shown = visibleText(ch)[0];
    return shown && shown.kind !== "plain" && shown.kind !== "mixed" ? shown.text : `⟨${hex(ch.codePointAt(0)!)}⟩`;
  }).join("");
}

/** The segment ends a line (a newline shown as a control): the page breaks the line after its token. */
export const breaksLine = (seg: VisibleSegment): boolean => seg.kind === "control" && (seg.text === "⟨U+000A⟩" || seg.text === "\n");

/** Which legend lines a string needs (§8.5): ⟨ ⟩ tokens, and letters from another alphabet. */
export function legendFor(segments: readonly VisibleSegment[]): { tokens: boolean; mixed: boolean } {
  return {
    tokens: segments.some(s => s.kind === "control" || s.kind === "bidi" || s.kind === "invisible" || s.kind === "nbsp"),
    mixed: segments.some(s => s.kind === "mixed"),
  };
}
