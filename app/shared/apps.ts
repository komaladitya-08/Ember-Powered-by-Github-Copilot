/**
 * Names people know apps by, for questions, grants and settings (apps report a program or desktop id). The
 * familiar names differ per OS (Linux desktop ids, Windows program names, macOS bundle ids), so main and the settings
 * window say once at start-up which OS's table applies (useAppNames); until then it is Linux's, today's table.
 */

import type { OS } from "./shortcuts";

/** Familiar names for apps that report a program or desktop id instead, per OS (the Windows and macOS rows are filled by their own package). */
export const APP_NAMES: Readonly<Record<OS, Readonly<Record<string, string>>>> = {
  linux: {
    "gnome-control-center": "Settings",
    "org.gnome.settings": "Settings",
    "org.gnome.controlcenter": "Settings",
    nautilus: "Files",
    "org.gnome.nautilus": "Files",
    "gnome-terminal-server": "Terminal",
    "gnome-terminal": "Terminal",
    "org.gnome.terminal": "Terminal",
    gedit: "gedit",
    "org.gnome.gedit": "gedit",
    "gnome-text-editor": "Text Editor",
    "org.gnome.texteditor": "Text Editor",
    "gnome-calculator": "Calculator",
    "org.gnome.calculator": "Calculator",
    evince: "Document Viewer",
    eog: "Image Viewer",
    "gnome-system-monitor": "System Monitor",
    "soffice.bin": "LibreOffice",
    soffice: "LibreOffice",
    firefox: "Firefox",
    thunderbird: "Thunderbird",
    mousepad: "Mousepad",
  },
  win32: {},
  darwin: {},
};

let appOs: OS = "linux";

/** Which OS's names friendlyApp uses: called once at start-up (main with its platform's OS, the settings window with Status.platform.os). */
export function useAppNames(os: OS): void {
  appOs = os;
}

/** A program name (all lower case, no spaces) capitalised; anything else as it is. */
function capitalised(n: string): string {
  return /^[a-z][a-z0-9-]*$/.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
}

export function friendlyApp(name: string): string {
  const names = APP_NAMES[appOs];
  // A desktop file name (firefox.desktop): the program is what's inside. On Windows a program may come with its ".exe".
  let n = name.trim().replace(/\.desktop$/i, "");
  if (appOs === "win32") n = n.replace(/\.exe$/i, "");
  if (!n) return "";
  const known = names[n.toLowerCase()];
  // An empty name is a real answer: a program that is never worth naming (Windows' frame host for packaged apps).
  if (known !== undefined) return known;
  if (/^libreoffice/i.test(n)) return "LibreOffice";
  // A desktop id (org.example.App, also with more parts): its last part, known or capitalised.
  if (/^[a-z]{2,}(\.[\w-]+){2,}$/i.test(n)) {
    const last = n.slice(n.lastIndexOf(".") + 1);
    return names[last.toLowerCase()] ?? capitalised(last);
  }
  return capitalised(n);
}

