/**
 * Copilot's markdown in the coding window (app/renderer/code/markdown.ts and markdown-dom.ts): read into a tree, then
 * drawn with elements and text nodes only. The fake document refuses markup outright, so these tests prove no model
 * text becomes HTML; links show their address and open nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inline, inlineText, linkKind, parseMarkdown } from "../../app/renderer/code/markdown";
import { markdownNodes } from "../../app/renderer/code/markdown-dom";
import { FakeEl, useFakeDocument } from "./view-dom-fake";

describe("reading markdown", () => {
  it("reads headings, paragraphs, rules, quotes and fenced and indented code", () => {
    expect(parseMarkdown("# Title\n\nSome *words* here\nrun on.\n\n---\n\n> quoted\n> more\n\n```ts\nconst a = 1;\n```\n\n    indented()\n")).toEqual([
      { t: "h", level: 1, c: [{ t: "text", s: "Title" }] },
      { t: "p", c: [{ t: "text", s: "Some words here run on." }] },
      { t: "hr" },
      { t: "quote", c: [{ t: "p", c: [{ t: "text", s: "quoted more" }] }] },
      { t: "code", lang: "ts", s: "const a = 1;" },
      { t: "code", lang: "", s: "indented()" },
    ]);
  });

  it("keeps an unclosed fence's code to the end, and raw HTML as text", () => {
    expect(parseMarkdown("```\nopen")).toEqual([{ t: "code", lang: "", s: "open" }]);
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([{ t: "p", c: [{ t: "text", s: "<img src=x onerror=alert(1)>" }] }]);
  });

  it("reads lists, ordered with their start, nested by indent", () => {
    const [list] = parseMarkdown("3. one\n4. two\n   - inner\n   - more\n5. three");
    expect(list).toMatchObject({ t: "list", ordered: true, start: 3 });
    const items = list.t === "list" ? list.items : [];
    expect(items).toHaveLength(3);
    expect(items[1][1]).toMatchObject({ t: "list", ordered: false });
  });

  it("reads inline code, strong text, links, bare addresses and hard line breaks; an escaped mark stays text", () => {
    expect(inline("Run `npm test` **now**, see [the docs](https://example.com/d) or https://example.com/x. \\*not\\*")).toEqual([
      { t: "text", s: "Run " }, { t: "code", s: "npm test" }, { t: "text", s: " " }, { t: "strong", c: [{ t: "text", s: "now" }] },
      { t: "text", s: ", see " }, { t: "link", href: "https://example.com/d", c: [{ t: "text", s: "the docs" }] }, { t: "text", s: " or " },
      { t: "link", href: "https://example.com/x", c: [{ t: "text", s: "https://example.com/x" }] }, { t: "text", s: ". *not*" },
    ]);
    expect(inline("a  \nb")).toEqual([{ t: "text", s: "a" }, { t: "br" }, { t: "text", s: "b" }]);
    expect(inline("snake_case_name stays")).toEqual([{ t: "text", s: "snake_case_name stays" }]);
    expect(inlineText(inline("**a** `b` [c](https://x.y)"))).toBe("a b c");
    expect([linkKind("https://a"), linkKind("mailto:a@b"), linkKind("javascript:alert(1)")]).toEqual(["web", "mail", "other"]);
  });
});

describe("drawing markdown", () => {
  let restore: () => void;
  beforeEach(() => { restore = useFakeDocument(); });
  afterEach(() => restore());

  it("builds elements and text nodes only, headings from h3, a Copy button on code, links with their address shown", () => {
    const nodes = markdownNodes("# Title\n\nSee [docs](https://example.com/d) and [bad](javascript:alert(1)).\n\n```sh\nrm -rf <b>build</b>\n```") as unknown as FakeEl[];
    expect(nodes.map(n => n.tag)).toEqual(["h3", "p", "div"]);
    const p = nodes[1];
    const link = p.find("md-link")!;
    expect(link.dataset.href).toBe("https://example.com/d");
    expect(p.find("md-href")!.textContent).toBe("(https://example.com/d)");
    // A link that isn't a web or mail address is only its words.
    expect(p.findAll("md-link")[1].dataset.href).toBeUndefined();
    expect(p.textContent).toBe("See docs (https://example.com/d) and bad.");
    const code = nodes[2];
    expect(code.find("tag:pre")!.textContent).toBe("rm -rf <b>build</b>");
    expect(code.find("md-copy")!.dataset.copy).toBe("code");
    expect(code.find("md-copy")!.getAttribute("aria-label")).toBe("Copy: Code, sh");
  });
});
