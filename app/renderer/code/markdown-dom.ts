/**
 * Markdown blocks (markdown.ts) as DOM nodes, built with createElement and text nodes only: never innerHTML, so no
 * model text can become markup (design-system.md "Insert model or app text with textContent"). Headings start at h3
 * (the window's own h1 and h2 are its title and the session's), a fenced block gets a Copy button (handled by one
 * listener on the transcript, `copyTarget`), and a link is its words with its address shown after them: the window
 * opens nothing itself (opening one goes through main, which the contract doesn't offer yet). Tested under a fake
 * document in test/unit/code-markdown.test.ts.
 */
import { linkKind, parseMarkdown, type Block, type Inline } from "./markdown";
import { CODE_COPY, codeBlockLabel } from "./copy";

type El = HTMLElement;

function h(tag: string, cls?: string, ...kids: (Node | string)[]): El {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

function inlineNodes(list: readonly Inline[]): Node[] {
  return list.map((n): Node => {
    switch (n.t) {
      case "text": return document.createTextNode(n.s);
      case "code": return h("code", "md-inline-code", n.s);
      case "strong": return h("strong", "md-strong", ...inlineNodes(n.c));
      case "br": return document.createElement("br");
      case "link": {
        const kind = linkKind(n.href);
        // A web address is a real link, opened by main in the person's browser (the transcript's click handler:
        // `linkTarget`); a mail address is shown, not opened.
        const label = h(kind === "web" ? "a" : "span", "md-link", ...inlineNodes(n.c));
        if (kind === "other") return label;
        if (kind === "web") label.setAttribute("href", n.href);
        label.dataset.href = n.href;
        label.setAttribute("title", n.href);
        const words = n.c.length === 1 && n.c[0].t === "text" ? n.c[0].s : null;
        // The address is shown beside its words where they differ, so what a link leads to is never hidden.
        if (words === n.href || words === n.href.replace(/^mailto:/i, "")) return label;
        const wrap = h("span", "md-link-wrap", label, " ", h("span", "md-href", `(${n.href})`));
        return wrap;
      }
    }
  });
}

function blockNode(b: Block): El {
  switch (b.t) {
    case "h": return h(`h${Math.min(6, b.level + 2)}`, "md-h", ...inlineNodes(b.c));
    case "p": return h("p", "md-p", ...inlineNodes(b.c));
    case "hr": return h("hr", "md-hr");
    case "quote": return h("blockquote", "md-quote", ...b.c.map(blockNode));
    case "list": {
      const list = h(b.ordered ? "ol" : "ul", "md-list", ...b.items.map(item => h("li", "", ...item.map(blockNode))));
      if (b.ordered && b.start !== 1) list.setAttribute("start", String(b.start));
      return list;
    }
    case "code": {
      const pre = h("pre", "md-pre", h("code", "", b.s));
      pre.setAttribute("tabindex", "0");
      pre.setAttribute("aria-label", codeBlockLabel(b.lang));
      const copy = h("button", "btn quiet small md-copy", CODE_COPY);
      copy.setAttribute("type", "button");
      copy.dataset.copy = "code";
      copy.setAttribute("aria-label", `${CODE_COPY}: ${codeBlockLabel(b.lang)}`);
      const bar = h("div", "md-code-bar", h("span", "md-lang", b.lang), copy);
      return h("div", "md-code", bar, pre);
    }
  }
}

/** `text` as markdown nodes, ready to append. */
export function markdownNodes(text: string): El[] {
  return parseMarkdown(text).map(blockNode);
}

/** The web address a click on `target` opens (a transcript link's), or null: the window never navigates itself. */
export function linkTarget(target: Element): string | null {
  const a = target.closest("a.md-link") as HTMLElement | null;
  const href = a?.dataset?.href;
  return href && linkKind(href) === "web" ? href : null;
}

/** The text a Copy button in `root` copies: its code block's code (null for anything else). */
export function copyTarget(button: Element): string | null {
  if (!(button as HTMLElement).dataset?.copy) return null;
  const block = button.closest(".md-code, .copyable");
  const code = block?.querySelector("pre");
  return code?.textContent ?? null;
}
