/**
 * The user's clipboard while Ember pastes text into a field on their screen
 * (tier 3). Everything on it is saved first, in every format it offers (text,
 * HTML, images, files), and put back exactly afterwards; an empty clipboard is
 * left empty. Electron's clipboard is passed in, so this is tested without it.
 */

/** What was on the clipboard: one record of format → data per item. */
export interface ClipboardSnapshot { readonly items: ReadonlyArray<Readonly<Record<string, unknown>>> }

export interface PasteClipboard {
  /** Everything on the clipboard now, to put back later. */
  save(): Promise<ClipboardSnapshot>;
  writeText(text: string): Promise<void>;
  /** Puts a saved clipboard back exactly (an empty one is cleared). */
  restore(snapshot: ClipboardSnapshot): Promise<void>;
}

/** A clipboard that only knows text (the older wiring): only text is saved and put back. */
export interface TextClipboard { readText(): Promise<string>; writeText(text: string): Promise<void> }

/** The parts of Electron 44's clipboard used here (its calls are asynchronous; clear() is not). */
export interface ElectronClipboardLike<I> {
  read(): Promise<{ readonly types: readonly string[]; getType(type: string): Promise<unknown> }[]>;
  write(items: I[]): Promise<void>;
  writeText(text: string): Promise<void>;
  clear(): void;
}

/** `electronClipboard(clipboard, ClipboardItem)` in main. */
export function electronClipboard<I>(cb: ElectronClipboardLike<I>, Item: new (data: Record<string, never>) => I): PasteClipboard {
  return {
    async save() {
      const items: Record<string, unknown>[] = [];
      for (const item of await cb.read()) {
        // Read now, every format: the clipboard is about to hold Ember's text instead.
        const data: Record<string, unknown> = {};
        for (const type of item.types) {
          try { data[type] = await item.getType(type); } catch { /* a format that went away meanwhile */ }
        }
        if (Object.keys(data).length) items.push(data);
      }
      return { items };
    },
    writeText: text => cb.writeText(text),
    async restore(snapshot) {
      if (!snapshot.items.length) { cb.clear(); return; }
      await cb.write(snapshot.items.map(data => new Item(data as Record<string, never>)));
    },
  };
}

export function asPasteClipboard(c: PasteClipboard | TextClipboard): PasteClipboard {
  if ("save" in c) return c;
  return {
    save: async () => ({ items: [{ "text/plain": await c.readText() }] }),
    writeText: text => c.writeText(text),
    restore: s => c.writeText(String(s.items[0]?.["text/plain"] ?? "")),
  };
}
