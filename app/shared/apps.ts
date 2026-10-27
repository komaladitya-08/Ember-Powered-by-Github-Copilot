/**
 * Names people know apps by, for questions, grants and settings (apps report a program or desktop id). The
 * familiar names differ per OS (Linux desktop ids, Windows program names, macOS bundle ids), so main and the settings
 * window say once at start-up which OS's table applies (useAppNames); until then it is Linux's, today's table.
 * Windows reports programs ("winword", "msedge"), so its table names the common ones as people say them; macOS mostly
 * reports the localized names people already know, so its table only names bundle ids that read badly capitalised.
 */

import type { OS } from "./shortcuts";

/**
 * A name table without Object's own keys, so a program called "constructor" or "__proto__" is never looked up as one
 * (a plain object answers those with Object's function and prototype, not a name). Every OS's table is one, Linux's
 * too: for its 22 names it answers as the plain object always did.
 */
const table = (names: Record<string, string>): Readonly<Record<string, string>> => Object.freeze(Object.assign(Object.create(null) as Record<string, string>, names));

/** Familiar names for apps that report a program or desktop id instead, per OS. */
export const APP_NAMES: Readonly<Record<OS, Readonly<Record<string, string>>>> = {
  linux: table({
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
  }),
  win32: table({
    winword: "Word",
    excel: "Excel",
    powerpnt: "PowerPoint",
    onenote: "OneNote",
    msaccess: "Access",
    outlook: "Outlook",
    olk: "Outlook",
    hxoutlook: "Mail",
    msedge: "Microsoft Edge",
    chrome: "Google Chrome",
    firefox: "Firefox",
    thunderbird: "Thunderbird",
    explorer: "File Explorer",
    notepad: "Notepad",
    "notepad++": "Notepad++",
    wordpad: "WordPad",
    mspaint: "Paint",
    systemsettings: "Settings",
    calculatorapp: "Calculator",
    calculator: "Calculator",
    "microsoft.photos": "Photos",
    snippingtool: "Snipping Tool",
    screensketch: "Snipping Tool",
    time: "Clock",
    "winstore.app": "Microsoft Store",
    windowsterminal: "Terminal",
    cmd: "Command Prompt",
    conhost: "Console",
    powershell: "Windows PowerShell",
    pwsh: "PowerShell",
    powershell_ise: "Windows PowerShell ISE",
    code: "Visual Studio Code",
    devenv: "Visual Studio",
    "ms-teams": "Teams",
    teams: "Teams",
    taskmgr: "Task Manager",
    regedit: "Registry Editor",
    control: "Control Panel",
    soffice: "LibreOffice",
    "soffice.bin": "LibreOffice",
    acrord32: "Adobe Acrobat Reader",
    acrobat: "Adobe Acrobat",
    searchhost: "Search",
    searchapp: "Search",
    startmenuexperiencehost: "Start",
    credentialuibroker: "Windows Security",
    consent: "User Account Control",
    sechealthui: "Windows Security",
    // Windows' frame host for packaged apps: never worth naming, the app inside it is what the user sees.
    applicationframehost: "",
  }),
  darwin: table({
    "com.apple.systempreferences": "System Settings",
    "com.apple.finder": "Finder",
    "com.apple.textedit": "TextEdit",
    "com.apple.mobilesms": "Messages",
    "com.apple.ical": "Calendar",
    "com.apple.addressbook": "Contacts",
    "com.apple.facetime": "FaceTime",
    "com.apple.appstore": "App Store",
    "com.apple.activitymonitor": "Activity Monitor",
    "com.apple.keychainaccess": "Keychain Access",
    "com.apple.scripteditor2": "Script Editor",
    "com.apple.iwork.pages": "Pages",
    "com.apple.iwork.numbers": "Numbers",
    "com.apple.iwork.keynote": "Keynote",
    "com.microsoft.word": "Microsoft Word",
    "com.microsoft.excel": "Microsoft Excel",
    "com.microsoft.powerpoint": "Microsoft PowerPoint",
    "com.microsoft.outlook": "Microsoft Outlook",
    "com.microsoft.vscode": "Visual Studio Code",
    "com.google.chrome": "Google Chrome",
    "org.mozilla.firefox": "Firefox",
  }),
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

/**
 * A WSLg Linux app's window ("wsl:<distro>:<app>", Windows only): the Linux app's familiar name and its distro, "gedit
 * (Ubuntu)". A distro named all in lower case is shown capitalised, as WSL's own names are.
 */
function wslApp(name: string): string | null {
  const m = /^wsl:([^:\s]+):(.+)$/i.exec(name);
  if (!m) return null;
  const app = m[2].trim();
  const known = APP_NAMES.linux[app.toLowerCase()];
  return `${known !== undefined && known ? known : capitalised(app)} (${capitalised(m[1])})`;
}

/**
 * An app on a computer reached over SSH, as its grant is kept ("ssh:<host>:<app>", review #194): "gedit on build-01".
 * That computer is Linux or a Mac whatever this one is, so its app is named from those tables.
 */
function remoteApp(name: string): string | null {
  const m = /^ssh:([^:\s]+):(.+)$/i.exec(name);
  if (!m) return null;
  const app = m[2].trim().replace(/\.desktop$/i, "");
  const mac = APP_NAMES.darwin[app.toLowerCase()];
  return `${mac !== undefined && mac ? mac : familiar(APP_NAMES.linux, app)} on ${m[1]}`;
}

/** The name people know an app by, on this computer's OS (useAppNames) or, for another computer's, on that one. */
export function friendlyApp(name: string): string {
  const names = APP_NAMES[appOs];
  if (appOs === "win32") {
    const wsl = wslApp(name.trim());
    if (wsl) return wsl;
  }
  const remote = remoteApp(name.trim());
  if (remote) return remote;
  // A desktop file name (firefox.desktop): the program is what's inside. On Windows a program may come with its ".exe".
  let n = name.trim().replace(/\.desktop$/i, "");
  if (appOs === "win32") n = n.replace(/\.exe$/i, "");
  return familiar(names, n);
}

/** A program's familiar name in one OS's table: known, a LibreOffice part, a desktop id's last part, or capitalised. */
function familiar(names: Readonly<Record<string, string>>, n: string): string {
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

