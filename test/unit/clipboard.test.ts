/**
 * The user's clipboard around a paste (review round 5): Ember's own text is recognised as Electron holds it, a picture
 * is never dropped for being slow (or put back as its empty icon formats), and a new picture copied while Ember waited
 * is what goes back.
 */

import { describe, expect, it } from "vitest";
import { ClipboardTimeout, electronClipboard } from "../../app/main/agent/clipboard";

const raw = (name: string) => `electron application/osclipboard;format="${name}"`;
class Item { constructor(readonly data: Record<string, unknown>) {} }
type Entry = { types: string[]; getType(t: string): Promise<unknown> };

/** A clipboard as Electron 44 lists it; `hold` is how Electron keeps text it is given (exactly, by default). */
function board(initial: Record<string, unknown>[], hold: (t: string) => string | null = t => t, timeoutMs = 200) {
  const entry = (d: Record<string, unknown>): Entry => ({ types: Object.keys(d), getType: async (t: string) => d[t] });
  const state = { items: initial.map(entry), written: 0, cleared: 0 };
  const cb = electronClipboard<Item>({
    read: async () => state.items,
    write: async items => { state.items = items.map(i => entry(i.data)); state.written++; },
    writeText: async t => { const h = hold(t); state.items = h === null ? [] : [entry({ "text/plain": h })]; },
    clear: () => { state.items = []; state.cleared++; },
  }, Item as unknown as new (d: Record<string, never>) => Item, timeoutMs);
  const text = async () => (state.items[0]?.types.includes("text/plain") ? state.items[0].getType("text/plain") : null);
  return { state, cb, text };
}

describe("Ember's own text on the clipboard", () => {
  it("is recognised as Electron holds it, so the user's clipboard comes back", async () => {
    for (const [given, held] of [["", null], ["﻿Hello", "Hello"], ["half \uD83D pair", "half � pair"]] as const) {
      const b = board([{ "text/plain": "the user's copy", "text/html": "<b>the user's copy</b>" }], t => (t === given ? held : t));
      const saved = await b.cb.save();
      await b.cb.writeText(given);
      await b.cb.restore(saved, given);
      expect(await b.text()).toBe("the user's copy");
      expect(b.state.written).toBe(1);
    }
  });

  it("a clipboard cleared after Ember's text went on stays cleared", async () => {
    const b = board([{ "text/plain": "a password" }]);
    const saved = await b.cb.save();
    await b.cb.writeText("Ember");
    b.state.items = [];
    await b.cb.restore(saved, "Ember");
    expect(b.state.items).toEqual([]);
    expect(b.state.written).toBe(0);
  });
});

describe("a copied picture", () => {
  const slow = () => new Promise(() => undefined);
  const png = new Blob([new Uint8Array([137, 80, 78, 71])]);

  it("is saved as its PNG; one not ready in time means no paste, never a clipboard put back without it", async () => {
    // GTK's copy of a big screenshot: a dozen formats, the icon ones empty (too big for an icon).
    const gtk = (pngData: () => Promise<unknown>) => ({ types: [raw("application/ico"), raw("text/ico"), "image/png", raw("image/bmp"), raw("image/x-ico"), raw("image/jpeg")], getType: (t: string) => (t === "image/png" ? pngData() : Promise.resolve(new Blob([]))) });
    const late = board([]);
    late.state.items = [gtk(slow)];
    await expect(late.cb.save()).rejects.toBeInstanceOf(ClipboardTimeout);
    const ready = board([]);
    const reads: string[] = [];
    ready.state.items = [{ ...gtk(async () => png), getType: (t: string) => { reads.push(t); return t === "image/png" ? Promise.resolve(png) : Promise.resolve(new Blob([])); } }];
    const saved = await ready.cb.save();
    expect(saved.items).toEqual([{ "image/png": png }]);
    expect(reads).toEqual(["image/png"]);
    // A browser's Copy Image: HTML beside the picture, no text. The picture is what was copied.
    const web = board([]);
    web.state.items = [{ types: ["text/html", "image/png"], getType: (t: string) => (t === "image/png" ? slow() : Promise.resolve("<img src=x>")) }];
    await expect(web.cb.save()).rejects.toBeInstanceOf(ClipboardTimeout);
    // Beside words (spreadsheet cells), the picture of them is extra and may be left out.
    const cells = board([]);
    cells.state.items = [{ types: ["text/plain", "image/png"], getType: (t: string) => (t === "image/png" ? slow() : Promise.resolve("6")) }];
    expect((await cells.cb.save()).items).toEqual([{ "text/plain": "6" }]);
  });

  it("an owner that gives nothing for what it lists isn't saved (nor pasted over); empty formats aren't put back", async () => {
    const empty = board([{ "image/png": new Blob([]), [raw("application/ico")]: new Blob([]) }]);
    await expect(empty.cb.save()).rejects.toThrow(/gave nothing/);
    const some = board([{ "text/plain": "words", "text/html": "", [raw("x-kde-passwordManagerHint")]: "" }]);
    expect(Object.keys((await some.cb.save()).items[0])).toEqual(["text/plain", raw("x-kde-passwordManagerHint")]);
  });

  it("copied anew while Ember waited (same formats, no text to tell them apart) is saved again", async () => {
    const b = board([{ "image/png": png }]);
    const saved = await b.cb.save();
    expect(await b.cb.unchanged(saved)).toBe(false);
    // With text, an unchanged clipboard is known as such.
    const t = board([{ "text/plain": "words", "image/png": png }]);
    expect(await t.cb.unchanged(await t.cb.save())).toBe(true);
    const none = board([]);
    expect(await none.cb.unchanged(await none.cb.save())).toBe(true);
  });
});
