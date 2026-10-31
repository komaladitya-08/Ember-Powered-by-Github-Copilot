/**
 * The file URL of one of Ember's bundled pages, for BrowserWindow.loadURL. Every window loads its page this way, not
 * with loadFile: loadFile leaves a literal % in the install folder's name as it is, and Chromium then decodes it, so in
 * a folder named "50%AB" no page loaded (ERR_FILE_NOT_FOUND) and every window stayed blank. pathToFileURL writes % as
 * %25 (and encodes #, ? and brackets), which Chromium decodes back to the real name. isTrustedSender (windows.ts)
 * trusts these URLs: it reads them undecoded. Plain Node, no Electron.
 */

import { pathToFileURL } from "node:url";

/** `file`: the page's absolute path; `query`: added as ?key=value (the ask window's opaque=1). */
export function pageUrl(file: string, query: Readonly<Record<string, string>> = {}): string {
  const url = pathToFileURL(file);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
