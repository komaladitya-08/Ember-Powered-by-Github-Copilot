/**
 * The user's clipboard while Ember pastes text into a field on their screen
 * (tier 3). Everything on it is saved first, in every format it offers (text,
 * HTML, images, files), and put back exactly afterwards; an empty clipboard is
 * left empty. Electron's clipboard is passed in, so this is tested without it.
 * Saving gives up after SAVE_TIMEOUT_MS (an owner that doesn't answer), and then nothing is pasted.
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

/** How long saving the clipboard may take in all: an app that owns it and doesn't answer (frozen, or very slow) means no paste. */
export const SAVE_TIMEOUT_MS = 1500;

export class ClipboardTimeout extends Error {
  constructor() {
    super("the clipboard didn't answer in time (the app that owns it may be frozen or busy)");
  }
}

/**
 * Formats read: MIME types only ("text/plain", "image/png", "x-special/gnome-copied-files"). Electron 44
 * also lists raw X targets (PIXMAP, BITMAP, DRAWABLE…), and reading one of those crashes it.
 */
export const savableFormat = (type: string) => /^[\w.+-]+\/[\w.+-]+/.test(type);

/** `p`, or ClipboardTimeout once `deadline` (ms since the epoch) has passed. */
function by<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClipboardTimeout()), Math.max(0, deadline - Date.now())); timer.unref?.(); });
  return Promise.race([p.finally(() => clearTimeout(timer)), late]);
}

/** `electronClipboard(clipboard, ClipboardItem)` in main. */
export function electronClipboard<I>(cb: ElectronClipboardLike<I>, Item: new (data: Record<string, never>) => I, timeoutMs = SAVE_TIMEOUT_MS): PasteClipboard {
  return {
    async save() {
      const deadline = Date.now() + timeoutMs;
      const items: Record<string, unknown>[] = [];
      for (const item of await by(cb.read(), deadline)) {
        // Read now, every format: the clipboard is about to hold Ember's text instead.
        const data: Record<string, unknown> = {};
        for (const type of item.types.filter(savableFormat)) {
          try {
            data[type] = await by(item.getType(type), deadline);
          } catch (err) {
            // A format that went away meanwhile is skipped; an owner that stopped answering ends it.
            if (err instanceof ClipboardTimeout) throw err;
          }
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
    save: async () => ({ items: [{ "text/plain": await by(c.readText(), Date.now() + SAVE_TIMEOUT_MS) }] }),
    writeText: text => c.writeText(text),
    restore: s => c.writeText(String(s.items[0]?.["text/plain"] ?? "")),
  };
}
