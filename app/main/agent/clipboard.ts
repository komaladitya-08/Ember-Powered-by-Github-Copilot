/**
 * The user's clipboard while Ember pastes text into a field on their screen
 * (tier 3). Everything on it is saved first, in every format it offers (text,
 * HTML, images, files, an app's own formats), and put back exactly afterwards;
 * an empty clipboard is left empty. A clipboard that changed while Ember waited
 * for its turn is saved again, and one that no longer holds Ember's text once
 * the paste is done (a password manager cleared it, the user copied something
 * new) is left as it is. A password manager's copy is never put back (holdsPassword).
 * Electron's clipboard is passed in, so this is tested without it.
 * Saving gives up after SAVE_TIMEOUT_MS (an owner that doesn't answer), and then nothing is pasted.
 */

/** What was on the clipboard: one record of format → data per item; `look`: its formats and text then. */
export interface ClipboardSnapshot { readonly items: ReadonlyArray<Readonly<Record<string, unknown>>>; readonly look?: string }

export interface PasteClipboard {
  /** Everything on the clipboard now, to put back later. */
  save(): Promise<ClipboardSnapshot>;
  /** Does the clipboard still offer what `snapshot` saved (the same formats and text)? */
  unchanged(snapshot: ClipboardSnapshot): Promise<boolean>;
  writeText(text: string): Promise<void>;
  /** Puts a saved clipboard back exactly (an empty one is cleared); with `written`, only while the clipboard still holds that text. */
  restore(snapshot: ClipboardSnapshot, written?: string): Promise<void>;
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

/** Electron 44 lists formats other than the common ones as `electron application/osclipboard;format="<X target>"`. */
const OS_FORMAT = /^electron application\/osclipboard;format="(.*)"$/;
const targetOf = (type: string) => OS_FORMAT.exec(type)?.[1] ?? type;
/**
 * Formats read: MIME types ("text/plain", "image/png", "x-special/gnome-copied-files", LibreOffice's own), however
 * Electron lists them, and password managers' "this is a password" marker (so clipboard history tools still skip the
 * password once it is back). Never raw X targets (PIXMAP, BITMAP, DRAWABLE…): reading one of those crashes Electron.
 */
export const savableFormat = (type: string) => { const t = targetOf(type); return /^[\w.+-]+\/[\w.+-]+/.test(t) || t === "x-kde-passwordManagerHint"; };
/**
 * Did a password manager put this on the clipboard (its "this is a password" marker)? Such a copy isn't put back:
 * the manager's clear timer may have fired while Ember's text was there, and nothing would clear the password again.
 */
export const holdsPassword = (s: ClipboardSnapshot) => s.items.some(item => Object.keys(item).some(t => targetOf(t) === "x-kde-passwordManagerHint"));
/**
 * Pictures of what was copied: a spreadsheet offers several, slow to make for a big range; GTK offers one picture in
 * a dozen formats, icon ones among them (application/ico, text/ico), empty when the picture is too big for an icon.
 */
const PICTURE = /^(image\/|application\/x-openoffice-(bitmap|emf|wmf|gdimetafile)\b|(application|text)\/(x-)?ico\b)/;
/** Data an owner gave nothing for (it couldn't make that format, or not in time). */
const isEmpty = (v: unknown) => v == null || v === "" || (v as Blob).size === 0 || (v as ArrayBuffer).byteLength === 0;

/** `p`, or ClipboardTimeout once `deadline` (ms since the epoch) has passed. */
function by<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClipboardTimeout()), Math.max(0, deadline - Date.now())); timer.unref?.(); });
  return Promise.race([p.finally(() => clearTimeout(timer)), late]);
}

/** A format's data as text (Electron gives a Blob), or null. */
const textOf = async (v: unknown): Promise<string | null> => (typeof v === "string" ? v : typeof (v as Blob | null)?.text === "function" ? (v as Blob).text() : null);

/** `electronClipboard(clipboard, ClipboardItem)` in main. */
export function electronClipboard<I>(cb: ElectronClipboardLike<I>, Item: new (data: Record<string, never>) => I, timeoutMs = SAVE_TIMEOUT_MS): PasteClipboard {
  /** What the clipboard offers now: each item's formats and text. */
  const look = async () => {
    const deadline = Date.now() + timeoutMs;
    const looks: unknown[] = [];
    for (const item of await by(cb.read(), deadline)) {
      looks.push([item.types, item.types.includes("text/plain") ? await textOf(await by(item.getType("text/plain"), deadline)) : null]);
    }
    return JSON.stringify(looks);
  };
  /** The clipboard's text now (null: none). */
  const plainText = async () => {
    const deadline = Date.now() + timeoutMs;
    const item = (await by(cb.read(), deadline))[0];
    return item?.types.includes("text/plain") ? textOf(await by(item.getType("text/plain"), deadline)) : null;
  };
  /**
   * Ember's last text, and the clipboard's text right after it went on: Electron doesn't always hold exactly the
   * text it is given (nothing for "", no leading U+FEFF, U+FFFD for half a surrogate pair).
   */
  let wrote: { text: string; held: string | null } | null = null;
  return {
    async save() {
      const deadline = Date.now() + timeoutMs;
      const items: Record<string, unknown>[] = [];
      const looks: unknown[] = [];
      // A copy is told apart from a new one by its formats and text; one without text (a picture) can't be.
      let comparable = true;
      for (const item of await by(cb.read(), deadline)) {
        // Read now, every format: the clipboard is about to hold Ember's text instead.
        const types = item.types.filter(savableFormat);
        const pictures = types.filter(t => PICTURE.test(targetOf(t)));
        const others = types.filter(t => !pictures.includes(t));
        const data: Record<string, unknown> = {};
        const read = async (type: string, optional: boolean) => {
          try {
            data[type] = await by(item.getType(type), deadline);
          } catch (err) {
            // A format that went away meanwhile is skipped; an owner that stopped answering ends it.
            if (err instanceof ClipboardTimeout && !optional) throw err;
          }
        };
        for (const type of others) await read(type, false);
        const text = data["text/plain"] === undefined ? null : await textOf(data["text/plain"]);
        // Beside text (cells, a shape's words), a picture of it is extra: only the PNG, and only while there is time.
        // Otherwise the picture is what was copied (a screenshot, a browser's Copy Image beside its HTML): its PNG
        // (else every picture offered) is saved, or nothing is pasted.
        const png = pictures.find(t => targetOf(t) === "image/png");
        if (text) { if (png) await read(png, true); }
        else for (const type of png ? [png] : pictures) await read(type, false);
        // A format that came empty isn't put back (an app pasting would take nothing from it); an item that came all
        // empty wasn't saved at all, so nothing is pasted.
        for (const type of Object.keys(data)) if (isEmpty(data[type]) && targetOf(type) !== "x-kde-passwordManagerHint") delete data[type];
        if (types.length && !Object.keys(data).length) throw new Error("the app that owns the clipboard gave nothing for what it holds");
        if (Object.keys(data).length) items.push(data);
        comparable &&= !!text;
        looks.push([item.types, item.types.includes("text/plain") ? text : null]);
      }
      return { items, ...(comparable ? { look: JSON.stringify(looks) } : {}) };
    },
    // A picture copied while Ember waited has the same formats as the one saved: that is saved again.
    unchanged: async snapshot => snapshot.look !== undefined && (await look()) === snapshot.look,
    async writeText(text) {
      wrote = null;
      await cb.writeText(text);
      const held = await plainText().catch(() => undefined);
      if (held !== undefined) wrote = { text, held };
    },
    async restore(snapshot, written) {
      // Something else is on it now (cleared on purpose, or a new copy): that stays. Ember's own text is as it read back.
      if (written !== undefined) {
        const now = await plainText().catch(() => undefined);
        if (now === undefined || now !== (wrote?.text === written ? wrote.held : written)) return;
      }
      if (!snapshot.items.length) { cb.clear(); return; }
      await cb.write(snapshot.items.map(data => new Item(data as Record<string, never>)));
    },
  };
}

export function asPasteClipboard(c: PasteClipboard | TextClipboard): PasteClipboard {
  if ("save" in c) return c;
  const read = () => by(c.readText(), Date.now() + SAVE_TIMEOUT_MS);
  return {
    save: async () => { const text = await read(); return { items: [{ "text/plain": text }], look: text }; },
    unchanged: async s => (await read()) === s.look,
    writeText: text => c.writeText(text),
    restore: async (s, written) => {
      if (written !== undefined && (await read().catch(() => null)) !== written) return;
      await c.writeText(String(s.items[0]?.["text/plain"] ?? ""));
    },
  };
}
