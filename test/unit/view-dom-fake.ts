/**
 * A small fake document for the view renderer's unit tests (app/renderer/shared/view-dom.ts), which run under plain
 * Node: elements keep their tag, classes, data, attributes, children and text, and refuse markup outright (innerHTML,
 * outerHTML, insertAdjacentHTML and a style attribute all throw), so a test proves every string went in as text.
 */

export class FakeNode {
  parent: FakeEl | null = null;
  constructor(public text = "") {}
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; }
  remove(): void { this.parent?.removeChild(this); }
  replaceWith(n: FakeNode): void {
    const p = this.parent;
    if (!p) return;
    const i = p.kids.indexOf(this);
    n.remove();
    p.kids.splice(i, 1, n);
    n.parent = p;
    this.parent = null;
  }
}

export class FakeEl extends FakeNode {
  kids: FakeNode[] = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = "";
  hidden = false;
  scope = "";
  /** How many times this element's children were put in again (a whole redraw replaces them). */
  replaced = 0;
  constructor(public tag: string, public ns?: string) { super(); }

  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c: string[]) => { this.className = [...new Set([...list(), ...c])].join(" "); },
      remove: (...c: string[]) => { this.className = list().filter(x => !c.includes(x)).join(" "); },
      contains: (c: string) => list().includes(c),
      toggle: (c: string, on?: boolean) => { const has = list().includes(c); const want = on ?? !has; if (want && !has) this.classList.add(c); if (!want && has) this.classList.remove(c); return want; },
    };
  }
  get children(): FakeEl[] { return this.kids.filter((k): k is FakeEl => k instanceof FakeEl); }
  get firstElementChild(): FakeEl | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeEl | null { return this.children.at(-1) ?? null; }
  override get textContent(): string { return this.text + this.kids.map(k => k.textContent).join(""); }
  override set textContent(v: string) { this.kids = []; this.text = v; }
  set innerHTML(_v: string) { throw new Error("markup is never set"); }
  set outerHTML(_v: string) { throw new Error("markup is never set"); }
  insertAdjacentHTML(): void { throw new Error("markup is never set"); }
  setAttribute(k: string, v: string): void {
    if (k === "style") throw new Error("no inline styles");
    if (k === "class") this.className = v; else this.attrs[k] = v;
  }
  getAttribute(k: string): string | null { return k === "class" ? this.className : this.attrs[k] ?? null; }
  append(...c: (FakeNode | string)[]): void { for (const x of c) this.insertBefore(typeof x === "string" ? new FakeNode(x) : x, null); }
  replaceChildren(...c: (FakeNode | string)[]): void { for (const k of [...this.kids]) k.parent = null; this.kids = []; this.replaced++; this.append(...c); }
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    n.remove();
    const i = ref ? this.kids.indexOf(ref) : -1;
    if (i < 0) this.kids.push(n); else this.kids.splice(i, 0, n);
    n.parent = this;
    return n;
  }
  removeChild(n: FakeNode): void { this.kids = this.kids.filter(k => k !== n); n.parent = null; }
  /** Every element under this one (depth first), this one excluded. */
  all(): FakeEl[] { return this.children.flatMap(c => [c, ...c.all()]); }
  /** The first element under this one with this class (or tag, given as "tag:x"). */
  find(sel: string): FakeEl | undefined { return this.all().find(e => (sel.startsWith("tag:") ? e.tag === sel.slice(4) : e.classList.contains(sel))); }
  findAll(sel: string): FakeEl[] { return this.all().filter(e => (sel.startsWith("tag:") ? e.tag === sel.slice(4) : e.classList.contains(sel))); }
  querySelector(sel: string): FakeEl | null { return this.find(sel.replace(/^\./, "")) ?? null; }
  get scrollHeight(): number { return 0; }
  get clientHeight(): number { return 0; }
}

/** Puts a fake document on globalThis; returns a function that restores what was there. */
export function useFakeDocument(): () => void {
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (ns: string, tag: string) => new FakeEl(tag, ns),
    createTextNode: (s: string) => new FakeNode(s),
  };
  return () => { g.document = saved; };
}
