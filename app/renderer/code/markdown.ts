/**
 * The markdown Copilot writes, read into a small tree the window draws with DOM nodes (markdown-dom.ts), never HTML:
 * headings, paragraphs, lists (nested by indent), block quotes, rules, fenced and indented code, and inline code,
 * strong text, links and line breaks. Anything else stays text. Raw HTML in a message is text too, shown as written.
 * Emphasis with one `*` or `_` is kept as plain text without its marks (Ember sets no italics). Pure, and bounded: a
 * message longer than MD_MAX characters is read as its first MD_MAX. Unit-tested in test/unit/code-markdown.test.ts.
 */

export const MD_MAX = 200_000;

export type Inline =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "strong"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string; s: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,12})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,12})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

/** `text` read as blocks. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.slice(0, MD_MAX).replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines, 0);
}

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: "p", c: inline(para.join("\n")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim().startsWith(mark[0].repeat(mark.length)) && !lines[j].trim().slice(mark.length).trim()) break;
        body.push(lines[j]);
      }
      out.push({ t: "code", lang: fence[2] ?? "", s: body.join("\n") });
      i = j;
      continue;
    }
    // Indented code: four spaces, outside a paragraph.
    if (!para.length && /^( {4}|\t)/.test(line) && depth < 8) {
      const body: string[] = [];
      let j = i;
      for (; j < lines.length && (/^( {4}|\t)/.test(lines[j]) || !lines[j].trim()); j++) body.push(lines[j].replace(/^( {4}|\t)/, ""));
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push({ t: "code", lang: "", s: body.join("\n") });
      i = j - 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { flush(); out.push({ t: "h", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, c: inline(heading[2] ?? "") }); continue; }
    if (RULE.test(line)) { flush(); out.push({ t: "hr" }); continue; }
    if (QUOTE.test(line) && depth < 8) {
      flush();
      const body: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const q = QUOTE.exec(lines[j]);
        if (!q) break;
        body.push(q[1]);
      }
      out.push({ t: "quote", c: blocks(body, depth + 1) });
      i = j - 1;
      continue;
    }
    const bullet = BULLET.exec(line), ordered = ORDERED.exec(line);
    if ((bullet || ordered) && depth < 8) {
      flush();
      const { list, next } = readList(lines, i, depth);
      out.push(list);
      i = next - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/** A list from line `i`: its items, each the lines under its marker (indented further, or run on), read as blocks. */
function readList(lines: string[], i: number, depth: number): { list: Block; next: number } {
  const first = BULLET.exec(lines[i]) ?? ORDERED.exec(lines[i])!;
  const ordered = !BULLET.exec(lines[i]);
  const indent = first[1].length;
  const items: string[][] = [];
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j];
    const m = (ordered ? ORDERED : BULLET).exec(line);
    if (m && m[1].length === indent) { items.push([m[3]]); continue; }
    if (!line.trim()) {
      // A blank line ends the list unless the next line goes on with it (indented under it, or another item).
      const after = lines[j + 1] ?? "";
      const more = (ordered ? ORDERED : BULLET).exec(after);
      if (after.startsWith(" ".repeat(indent + 2)) || (more && more[1].length === indent)) { items[items.length - 1].push(""); continue; }
      break;
    }
    const lead = /^ */.exec(line)![0].length;
    if (lead > indent) { items[items.length - 1].push(line.slice(Math.min(lead, indent + (ordered ? 3 : 2)))); continue; }
    // A line with no marker and no indent runs on in the item's paragraph, unless it starts another kind of block.
    if (BULLET.test(line) || ORDERED.test(line) || HEADING.test(line) || FENCE.test(line) || QUOTE.test(line) || RULE.test(line)) break;
    items[items.length - 1].push(line);
  }
  const start = ordered ? Number(first[2]) : 1;
  return { list: { t: "list", ordered, start, items: items.map(lines => blocks(lines, depth + 1)) }, next: j };
}

/** Inline markup of a paragraph's text. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const push = (n: Inline) => { if (buf) { out.push({ t: "text", s: buf }); buf = ""; } out.push(n); };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // A backslash keeps the next mark as text.
    if (ch === "\\" && i + 1 < text.length && /[\\`*_[\]()#+\-.!<>~|]/.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
    if (ch === "\n") {
      // Two spaces or a backslash before a line break keep it; otherwise it is a space, as in markdown.
      if (buf.endsWith("  ")) { buf = buf.replace(/ +$/, ""); push({ t: "br" }); } else buf = `${buf.replace(/ +$/, "")} `;
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        let s = text.slice(i + run.length, end).replace(/\n/g, " ");
        if (s.startsWith(" ") && s.endsWith(" ") && s.trim()) s = s.slice(1, -1);
        push({ t: "code", s });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const mark = ch + ch;
      const end = text.indexOf(mark, i + 2);
      if (end > i + 2 && text[i + 2] !== " ") {
        push({ t: "strong", c: inline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== " " && text[i + 1] !== ch && (ch === "*" || !/\w/.test(text[i - 1] ?? ""))) {
      const end = findClose(text, ch, i + 1);
      if (end > i + 1) {
        // Emphasis: its words, upright, without the marks.
        const kids = inline(text.slice(i + 1, end));
        if (buf) { out.push({ t: "text", s: buf }); buf = ""; }
        out.push(...kids);
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const link = readLink(text, i);
      if (link) { push({ t: "link", href: link.href, c: inline(link.label) }); i = link.end; continue; }
    }
    if (ch === "<") {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/.exec(text.slice(i));
      if (auto) { push({ t: "link", href: auto[1], c: [{ t: "text", s: auto[1] }] }); i += auto[0].length; continue; }
    }
    if ((ch === "h" || ch === "w") && !/\w/.test(text[i - 1] ?? "")) {
      const bare = /^(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/.exec(text.slice(i));
      if (bare) { push({ t: "link", href: bare[0].startsWith("www.") ? `https://${bare[0]}` : bare[0], c: [{ t: "text", s: bare[0] }] }); i += bare[0].length; continue; }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ t: "text", s: buf });
  return merge(out);
}

/** The closing single mark of an emphasis, not before a space and not part of a word for `_`. */
function findClose(text: string, mark: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "\n" && text[j + 1] === "\n") return -1;
    if (text[j] === mark && text[j - 1] !== " " && text[j + 1] !== mark && (mark === "*" || !/\w/.test(text[j + 1] ?? ""))) return j;
  }
  return -1;
}

/** `[label](href)` at `i`, or null. */
function readLink(text: string, i: number): { label: string; href: string; end: number } | null {
  let depth = 0, j = i;
  for (; j < text.length; j++) {
    if (text[j] === "[") depth++;
    else if (text[j] === "]" && --depth === 0) break;
  }
  if (j >= text.length || text[j + 1] !== "(") return null;
  // The address may hold balanced brackets of its own ("…/Foo_(bar)").
  let close = -1;
  for (let k = j + 2, d = 0; k < text.length; k++) {
    if (text[k] === "(") d++;
    else if (text[k] === ")" && d-- === 0) { close = k; break; }
  }
  if (close < 0) return null;
  const href = text.slice(j + 2, close).trim().replace(/\s+"[^"]*"$/, "").replace(/^<|>$/g, "");
  if (!href || /\s/.test(href)) return null;
  return { label: text.slice(i + 1, j), href, end: close + 1 };
}

/** Neighbouring text runs joined. */
function merge(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of list) {
    const last = out[out.length - 1];
    if (n.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", s: last.s + n.s };
    else if (n.t !== "text" || n.s) out.push(n);
  }
  return out;
}

/** The words of inline nodes, as text (a link's label, a code span's code). */
export function inlineText(list: readonly Inline[]): string {
  return list.map(n => (n.t === "text" || n.t === "code" ? n.s : n.t === "br" ? "\n" : inlineText(n.c))).join("");
}

/** A link is shown with its address; only web and mail addresses count as one (anything else is text). */
export function linkKind(href: string): "web" | "mail" | "other" {
  if (/^https?:\/\//i.test(href)) return "web";
  if (/^mailto:/i.test(href)) return "mail";
  return "other";
}
