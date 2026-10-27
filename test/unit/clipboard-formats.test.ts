/** agent/clipboard-formats.ts: the clipboard formats Ember saves and puts back, per OS (design §4.10, §9.11). */

import { describe, expect, it } from "vitest";
import { CLIPBOARD_FORMATS, savableFormat, targetOf } from "../../app/main/agent/clipboard-formats";
import * as clipboard from "../../app/main/agent/clipboard";

const OS_FORMAT = (x: string) => `electron application/osclipboard;format="${x}"`;
const SAMPLES = [
  "text/plain", "text/html", "image/png", "x-special/gnome-copied-files", "application/x-openoffice-embed-source-xml;windows_formatname=\"Star Embed Source (XML)\"",
  "text/uri-list", OS_FORMAT("UTF8_STRING"), OS_FORMAT("PIXMAP"), OS_FORMAT("BITMAP"), OS_FORMAT("DRAWABLE"), OS_FORMAT("x-kde-passwordManagerHint"),
  OS_FORMAT("application/x-qt-image"), OS_FORMAT("TARGETS"), "x-kde-passwordManagerHint", "PIXMAP", "", "text", "image/",
];

describe("the Linux clipboard formats", () => {
  it("are the rule agent/clipboard.ts had, moved here: MIME types and KDE's password marker, never raw X targets", () => {
    for (const t of SAMPLES) expect(CLIPBOARD_FORMATS.linux.savable(t), t).toBe(clipboard.savableFormat(t));
    expect(savableFormat("text/plain")).toBe(true);
    expect(savableFormat(OS_FORMAT("PIXMAP"))).toBe(false);
    expect(savableFormat(OS_FORMAT("x-kde-passwordManagerHint"))).toBe(true);
  });

  it("know KDE's password marker however Electron lists it, as holdsPassword does", () => {
    const marker = CLIPBOARD_FORMATS.linux.passwordMarker;
    for (const t of SAMPLES) expect(marker(t), t).toBe(clipboard.holdsPassword({ items: [{ [t]: "x" }] }));
    expect(marker("x-kde-passwordManagerHint")).toBe(true);
    expect(marker(OS_FORMAT("x-kde-passwordManagerHint"))).toBe(true);
    expect(marker("text/plain")).toBe(false);
  });

  it("write nothing beside Ember's own paste text", () => {
    expect(CLIPBOARD_FORMATS.linux.ownTextMarkers).toEqual([]);
  });

  it("read the OS's name out of Electron's wrapper", () => {
    expect(targetOf(OS_FORMAT("UTF8_STRING"))).toBe("UTF8_STRING");
    expect(targetOf("text/plain")).toBe("text/plain");
  });
});

describe("the Windows and macOS clipboard formats", () => {
  it("stay MIME-only until CI has verified what Electron lists there (a lost rich format is safe, a crash is not)", () => {
    for (const os of ["win32", "darwin"] as const) {
      for (const t of SAMPLES) expect(CLIPBOARD_FORMATS[os].savable(t), `${os} ${t}`).toBe(savableFormat(t));
    }
    // What Ember writes beside its own paste text, so clipboard history and clipboard managers skip it (design §9.11).
    expect(CLIPBOARD_FORMATS.win32.ownTextMarkers).toEqual(["ExcludeClipboardContentFromMonitorProcessing"]);
    expect(CLIPBOARD_FORMATS.darwin.ownTextMarkers).toEqual(["org.nspasteboard.TransientType"]);
  });
});
