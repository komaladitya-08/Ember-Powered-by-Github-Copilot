/**
 * Which clipboard formats Ember saves and puts back around a paste on the user's screen (agent/clipboard.ts), per
 * OS. Reading the wrong format can crash Electron (a raw X target such as PIXMAP on Linux), so each OS lists what it
 * may read rather than what it may not. The Linux row is clipboard.ts's rule, moved here so there is one copy of it.
 *
 * Windows and macOS save MIME types only too (design §9.11), until CI shows which of their own formats Electron lists
 * and accepts back there: losing a rich format (RTF, a spreadsheet's own) is safe, a crash is not. What they add is
 * their password managers' markers (Windows: "ExcludeClipboardContentFromMonitorProcessing", KeePass's "Clipboard
 * Viewer Ignore"; macOS: nspasteboard.org's "org.nspasteboard.ConcealedType"), so a copied password is never put back
 * after a paste (a marker in a format that isn't saved still marks the copy: agent/clipboard.ts), and the marker
 * Ember writes beside its own paste text so clipboard history, cloud sync and clipboard managers skip it.
 */

import type { ClipboardFormats, OS } from "../platform/types";

/** Electron 44 lists formats other than the common ones as `electron application/osclipboard;format="<X target>"`. */
const OS_FORMAT = /^electron application\/osclipboard;format="(.*)"$/;
/** The name an OS gave a format, however Electron lists it. */
export const targetOf = (type: string) => OS_FORMAT.exec(type)?.[1] ?? type;

/** KDE's (and KeePassXC's) "this is a password" marker on X11. */
const KDE_PASSWORD_HINT = "x-kde-passwordManagerHint";

/**
 * Formats read: MIME types ("text/plain", "image/png", "x-special/gnome-copied-files", LibreOffice's own), however
 * Electron lists them, and password managers' "this is a password" marker (so clipboard history tools still skip the
 * password once it is back). Never raw X targets (PIXMAP, BITMAP, DRAWABLE…): reading one of those crashes Electron.
 */
export const savableFormat = (type: string) => { const t = targetOf(type); return /^[\w.+-]+\/[\w.+-]+/.test(t) || t === KDE_PASSWORD_HINT; };

/** A password marker test for these format names, however Electron lists them. */
const markedBy = (names: readonly string[]) => {
  const set = new Set(names);
  return (type: string) => set.has(targetOf(type));
};

const LINUX: ClipboardFormats = {
  savable: savableFormat,
  passwordMarker: markedBy([KDE_PASSWORD_HINT]),
  ownTextMarkers: [],
};

/** Windows' "don't monitor or keep this" format: password managers set it on a password, Ember on its own paste text. */
const WIN32_EXCLUDE = "ExcludeClipboardContentFromMonitorProcessing";

const WIN32: ClipboardFormats = {
  savable: savableFormat,
  // KDE's marker too: harmless where nothing writes it, and the rule stays a superset of Linux's.
  passwordMarker: markedBy([WIN32_EXCLUDE, "Clipboard Viewer Ignore", KDE_PASSWORD_HINT]),
  ownTextMarkers: [WIN32_EXCLUDE],
};

const DARWIN: ClipboardFormats = {
  savable: savableFormat,
  passwordMarker: markedBy(["org.nspasteboard.ConcealedType", KDE_PASSWORD_HINT]),
  // "Transient": clipboard managers don't record it (nspasteboard.org); it isn't a password, so it isn't a marker.
  ownTextMarkers: ["org.nspasteboard.TransientType"],
};

/** The clipboard rules of each OS (SystemPlatform.clipboardFormats). */
export const CLIPBOARD_FORMATS: Readonly<Record<OS, ClipboardFormats>> = {
  linux: LINUX,
  win32: WIN32,
  darwin: DARWIN,
};
