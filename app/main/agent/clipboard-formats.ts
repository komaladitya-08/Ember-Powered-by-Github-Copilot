/**
 * Which clipboard formats Ember saves and puts back around a paste on the user's screen (agent/clipboard.ts), per
 * OS. Reading the wrong format can crash Electron (a raw X target such as PIXMAP on Linux), so each OS lists what it
 * may read rather than what it may not. The Linux row is clipboard.ts's rule, moved here so there is one copy of it;
 * the Windows and macOS rows are the same MIME-only rule until their package verifies what Electron lists and accepts
 * back there (design §9.11: losing a rich format is safe, a crash is not).
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

const MIME_ONLY: ClipboardFormats = {
  savable: savableFormat,
  passwordMarker: type => targetOf(type) === KDE_PASSWORD_HINT,
  ownTextMarkers: [],
};

/** The clipboard rules of each OS (SystemPlatform.clipboardFormats). */
export const CLIPBOARD_FORMATS: Readonly<Record<OS, ClipboardFormats>> = {
  linux: MIME_ONLY,
  win32: MIME_ONLY,
  darwin: MIME_ONLY,
};
