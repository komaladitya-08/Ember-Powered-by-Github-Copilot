/**
 * The macOS vocabularies (design §9.11): every row with a positive and a negative example, through the checks that
 * read it (isTerminalApp, hasBuiltInShell, isSecurityWindow, the policy, never-look, the clipboard). macOS reports an
 * app by its name in the user's language and by its bundle id, so both are tested, with a few of Apple's translations.
 * port/darwin's own list of security owners must stay inside SECURITY_APP.darwin, so one list can replace the other.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { NEVER_LOOK_DEFAULTS, NEVER_LOOK_NAMES, neverLookLabel } from "../../app/shared/never-look";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { hasBuiltInShell, isTerminalApp, programsOf, type DesktopApp } from "../../app/main/hands/system";
import {
  INTERPRETERS, LAUNCHERS, REFUSED, SHELLS, SHELL_APP, SHELL_APP_ID, SHELL_APP_NAME, TERMINALS, TERMINAL_CLASSES, TERMINAL_ID_WORDS, TERMINAL_NAME, WRAPPERS,
} from "../../app/main/hands/terminals";
import { PolicyEngine, isRiskyLabel, isSecurityWindow, refusesTyping, type ActionRequest } from "../../app/main/policy/policy";
import {
  FILE_PATH_WORDS, OFFICE_APP, RISKY_EXTRA, RUN_FILE_DIALOG_EXTRA, RUNS_PROGRAM_EXTRA, SECURITY_APP, SECURITY_CLASS, SECURITY_TITLE, TABBED_APP,
  TERMINAL_REQUEST, TYPING_REFUSED, WEB_APP,
} from "../../app/main/policy/vocabulary";
import { CLIPBOARD_FORMATS, savableFormat } from "../../app/main/agent/clipboard-formats";
import { electronClipboard } from "../../app/main/agent/clipboard";
import { isNeverLook } from "../../app/main/perception/elements";
import { SECURITY_OWNERS } from "../../app/main/platform/darwin/model";

const M = "darwin" as const;
const terminal = (app: Parameters<typeof isTerminalApp>[0]) => isTerminalApp(app, M);
const shell = (app: Parameters<typeof hasBuiltInShell>[0]) => hasBuiltInShell(app, M);
/** A window's app as the policy asks about it (main.ts: `{ id: name, name }`). */
const named = (name: string) => terminal({ id: name, name });
/** A bundle as the macOS catalogue lists it (darwin/system/apps.ts bundleApp). */
const bundle = (name: string, id: string, exe = name) => ({ id, name, argv: [`/Applications/${name}.app/Contents/MacOS/${exe}`] });

describe("the macOS terminals", () => {
  it("knows Terminal, iTerm, Warp, XQuartz and the cross-platform terminals by name, executable and bundle id", () => {
    for (const app of [bundle("Terminal", "com.apple.Terminal"), bundle("iTerm", "com.googlecode.iterm2", "iTerm2"), bundle("Warp", "dev.warp.Warp-Stable", "stable"),
      bundle("XQuartz", "org.xquartz.X11", "X11"), bundle("Ghostty", "com.mitchellh.ghostty", "ghostty"), bundle("kitty", "net.kovidgoyal.kitty"),
      bundle("Alacritty", "org.alacritty"), bundle("WezTerm", "com.github.wez.wezterm", "wezterm-gui"), bundle("Hyper", "co.zeit.hyper"),
      bundle("Tabby", "org.tabby")]) expect(terminal(app), app.name).toBe(true);
    for (const n of ["Terminal", "iTerm2", "iTerm", "Warp", "XQuartz", "com.apple.Terminal", "com.googlecode.iterm2"]) expect(named(n), n).toBe(true);
    for (const app of [bundle("TextEdit", "com.apple.TextEdit"), bundle("Finder", "com.apple.finder"), bundle("Safari", "com.apple.Safari"),
      bundle("Notes", "com.apple.Notes")]) expect(terminal(app), app.name).toBe(false);
    expect(TERMINALS.darwin.has("iterm2")).toBe(true);
    expect(TERMINALS.darwin.has("textedit")).toBe(false);
  });

  it("knows Terminal by its name in other languages (macOS reports the localized name)", () => {
    for (const n of ["ターミナル", "终端", "終端機", "터미널", "Terminale", "Терминал", "Термінал", "Τερματικό", "Pääte", "Terminál", "מסוף"]) {
      expect(TERMINAL_NAME.darwin.test(n), n).toBe(true);
      expect(named(n), n).toBe(true);
    }
    for (const n of ["TextEdit", "Terminally Ill", "Console", "Notes", "Pages"]) expect(TERMINAL_NAME.darwin.test(n), n).toBe(false);
  });

  it("doesn't take the Mac's Console, its log viewer, for a terminal by name or id word", () => {
    expect(TERMINAL_NAME.darwin.test("Console")).toBe(false);
    expect(TERMINAL_ID_WORDS.darwin).toEqual([]);
    expect(TERMINALS.darwin.has("console")).toBe(false);
  });

  it("refuses shells and interpreters waiting for typed code, and an app wrapped in caffeinate or nohup", () => {
    expect(SHELLS.darwin.test("zsh")).toBe(true);
    expect(SHELLS.darwin.test("textedit")).toBe(false);
    expect(INTERPRETERS.darwin.test("python3")).toBe(true);
    expect(INTERPRETERS.darwin.test("preview")).toBe(false);
    expect(terminal({ id: "x", name: "x", argv: ["/bin/zsh"] })).toBe(true);
    expect(terminal({ id: "x", name: "x", argv: ["/usr/bin/caffeinate", "-i", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"] })).toBe(true);
    expect(terminal({ id: "x", name: "x", argv: ["/usr/bin/nohup", "/Applications/TextEdit.app/Contents/MacOS/TextEdit"] })).toBe(false);
    expect(Object.keys(WRAPPERS.darwin)).toEqual(["nohup", "nice", "caffeinate", "timeout", "gtimeout", "stdbuf", "gstdbuf"]);
  });

  it("refuses apps with a shell built in, the automation apps and the launchers that run typed commands", () => {
    for (const app of [bundle("Xcode", "com.apple.dt.Xcode"), bundle("BBEdit", "com.barebones.bbedit"), bundle("TextMate", "com.macromates.TextMate"),
      bundle("Nova", "com.panic.Nova"), bundle("MacVim", "org.vim.MacVim"), bundle("Script Editor", "com.apple.ScriptEditor2"),
      bundle("Automator", "com.apple.Automator"), bundle("Shortcuts", "com.apple.shortcuts"), bundle("Cursor", "com.todesktop.230313mzl4w4u92"),
      bundle("Visual Studio Code", "com.microsoft.VSCode", "Electron"), bundle("Sublime Text", "com.sublimetext.4", "sublime_text"),
      bundle("PyCharm", "com.jetbrains.pycharm", "pycharm"), bundle("Android Studio", "com.google.android.studio", "studio"),
      bundle("Raycast", "com.raycast.macos"), bundle("Emacs", "org.gnu.Emacs")]) {
      expect(shell(app), app.name).toBe(true);
      expect(terminal(app), app.name).toBe(true);
    }
    for (const n of ["Xcode", "Script Editor", "Automator", "Shortcuts", "Spotlight", "Visual Studio Code", "Cursor", "Alfred 5"]) expect(named(n), n).toBe(true);
    for (const app of [bundle("TextEdit", "com.apple.TextEdit"), bundle("Pages", "com.apple.iWork.Pages"), bundle("Preview", "com.apple.Preview"),
      bundle("Safari", "com.apple.Safari")]) expect(shell(app), app.name).toBe(false);
    expect(SHELL_APP.darwin.test("script editor")).toBe(true);
    expect(SHELL_APP.darwin.test("xcode-beta")).toBe(true);
    expect(SHELL_APP.darwin.test("textedit")).toBe(false);
    expect(SHELL_APP_ID.darwin.test("com.apple.automator.my-workflow")).toBe(true);
    expect(SHELL_APP_ID.darwin.test("com.apple.textedit")).toBe(false);
  });

  it("knows Script Editor and Shortcuts by their names in other languages", () => {
    for (const n of ["Skripteditor", "Éditeur de script", "Editor de Scripts", "スクリプトエディタ", "脚本编辑器", "Kurzbefehle", "Raccourcis", "Atajos",
      "ショートカット", "快捷指令", "단축어"]) expect(SHELL_APP_NAME.darwin.test(n), n).toBe(true);
    for (const n of ["TextEdit", "Notizen", "Aperçu", "メモ"]) expect(SHELL_APP_NAME.darwin.test(n), n).toBe(false);
  });

  it("refuses programs that run commands as someone else, AppleScript and what opens another program", () => {
    for (const p of ["osascript", "open", "launchctl", "automator", "shortcuts", "sudo", "su", "ssh", "login", "sandbox-exec"]) {
      expect(REFUSED.darwin.test(p), p).toBe(true);
      expect(terminal({ id: "x", name: "x", argv: [`/usr/bin/${p}`, "x"] }), p).toBe(true);
    }
    for (const p of ["openssl", "textedit", "opendiff", "sshd-keygen"]) expect(REFUSED.darwin.test(p), p).toBe(false);
  });

  it("drops launchers from the programs an app's windows report, and ignores window classes (a Windows idea)", () => {
    const app = (programs: string[]): DesktopApp => ({ id: "x", name: "x", file: "/Applications/x.app", keywords: [], argv: [], programs });
    expect(programsOf(app(["open", "osascript", "java", "myapp"]), LAUNCHERS.darwin)).toEqual(new Set(["myapp"]));
    expect(TERMINAL_CLASSES.darwin).toEqual([]);
    expect(terminal({ id: "com.apple.TextEdit", name: "TextEdit", windowClass: "ConsoleWindowClass" })).toBe(false);
  });
});

describe("the macOS security vocabulary", () => {
  it("knows every authorisation, Touch ID, privacy and Gatekeeper agent, the login window and the screen saver, as whole names", () => {
    for (const app of ["SecurityAgent", "com.apple.SecurityAgent", "coreautha", "coreauthd", "loginwindow", "ScreenSaverEngine", "CoreServicesUIAgent",
      "universalAccessAuthWarn", "UserNotificationCenter", "AuthenticationServicesAgent", "Ticket Viewer", "Certificate Assistant"]) {
      expect(SECURITY_APP.darwin?.test(app), app).toBe(true);
      expect(isSecurityWindow({ app, title: "" }, M), app).toBe(true);
    }
    for (const app of ["SecurityAgentHelper", "TextEdit", "Notification Center", "login", "Screen Saver"]) expect(isSecurityWindow({ app, title: "x" }, M), app).toBe(false);
  });

  it("covers port/darwin's own list of security owners, so the two lists can become one", () => {
    for (const owner of SECURITY_OWNERS) expect(SECURITY_APP.darwin?.test(owner), owner).toBe(true);
  });

  it("knows Keychain Access and the Passwords app only as whole names, also in other languages and either Unicode form", () => {
    for (const app of ["Keychain Access", "com.apple.keychainaccess", "Schlüsselbundverwaltung", "Trousseaux d’accès", "Trousseaux d'accès", "Acceso a Llaveros",
      "キーチェーンアクセス", "钥匙串访问", "Passwords", "com.apple.Passwords", "Passwörter", "Mots de passe", "Contraseñas", "パスワード", "密码",
      "Schlüsselbundverwaltung".normalize("NFD"), "Trousseaux d’accès".normalize("NFD")]) {
      expect(isSecurityWindow({ app }, M), app).toBe(true);
    }
    for (const app of ["Passwords Plus", "My Passwords", "Keychain", "passwords.txt"]) expect(SECURITY_APP.darwin?.test(app), app).toBe(false);
  });

  it("knows Privacy & Security and the privacy pages that grant apps access, as whole titles", () => {
    for (const title of ["Privacy & Security", "Passwords", "Touch ID & Password", "Users & Groups", "Login Password", "Accessibility", "Screen Recording",
      "Screen & System Audio Recording", "Input Monitoring", "Full Disk Access", "Automation", "Developer Tools", "App Management",
      "Datenschutz & Sicherheit", "Confidentialité et sécurité", "Privacidad y seguridad", "プライバシーとセキュリティ", "隐私与安全性",
      "“Ember” wants to make changes.", "Terminal wants to use your confidential information stored in “login” in your keychain."]) {
      expect(isSecurityWindow({ app: "System Settings", title }, M), title).toBe(true);
    }
    for (const title of ["General", "Accessibility notes.txt", "Privacy policy — Safari", "Screen Recording 2026-10-22.mov", "Passwords.numbers", "Wi-Fi"]) {
      expect(isSecurityWindow({ app: "System Settings", title }, M), title).toBe(false);
    }
    // Tested on the normalised (lower-case) title, as policy.ts hands it over.
    expect(SECURITY_TITLE.darwin?.test("privacy & security")).toBe(true);
    expect(SECURITY_TITLE.darwin?.test("privacy & security notes")).toBe(false);
  });

  it("has no window classes on macOS, and keeps Linux's and Windows' prompts out", () => {
    expect(SECURITY_CLASS.darwin).toEqual([]);
    expect(isSecurityWindow({ app: "CredentialUIBroker" }, M)).toBe(false);
    expect(isSecurityWindow({ app: "polkit-gnome-authentication-agent-1" }, M)).toBe(false);
    expect(isSecurityWindow({ app: "x", title: "Windows Security" }, M)).toBe(false);
  });

  it("keeps Ember out of System Settings' privacy pages (it must never switch itself on)", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ "system settings": "act" }), keys: KEYS.darwin, os: M });
    const d = e.decide({ taskId: "t", kind: "click", app: "System Settings", window: "Accessibility", element: { role: "switch", name: "Ember" } });
    expect(d).toMatchObject({ verdict: "deny", tier: "never", reason: "authentication and security windows are for the user only" });
  });
});

describe("browsers, mail and office suites on macOS", () => {
  it("knows browsers, Mail, Messages and chat apps by name and bundle id, whole words only", () => {
    for (const app of ["Safari", "Google Chrome", "Firefox", "Brave Browser", "Arc", "Opera", "Vivaldi", "Mail", "com.apple.mail", "Microsoft Outlook", "Thunderbird",
      "Slack", "Microsoft Teams", "Discord", "Messages", "com.apple.MobileSMS", "Nachrichten", "メッセージ", "Telegram", "WhatsApp", "Signal"]) {
      expect(TABBED_APP.darwin?.test(app), app).toBe(true);
    }
    for (const app of ["TextEdit", "Mailchimp Helper", "Archive Utility", "Chromecast", "Finder"]) expect(TABBED_APP.darwin?.test(app), app).toBe(false);
  });

  it("knows web-engine and chat apps apart from Mail", () => {
    for (const app of ["Safari", "Google Chrome", "Slack", "Microsoft Teams", "Electron", "Messages", "Discord"]) expect(WEB_APP.darwin?.test(app), app).toBe(true);
    for (const app of ["Mail", "Microsoft Outlook", "Thunderbird", "TextEdit"]) expect(WEB_APP.darwin?.test(app), app).toBe(false);
  });

  it("knows Microsoft's, Apple's and LibreOffice's office apps", () => {
    for (const app of ["Microsoft Word", "Microsoft Excel", "Microsoft PowerPoint", "com.microsoft.Word", "Pages", "Numbers", "Keynote", "com.apple.iWork.Pages",
      "LibreOffice", "soffice"]) expect(OFFICE_APP.darwin?.test(app), app).toBe(true);
    for (const app of ["Word Counter", "TextEdit", "Microsoft Teams", "Preview"]) expect(OFFICE_APP.darwin?.test(app), app).toBe(false);
  });
});

describe("risky and run-a-program labels on macOS", () => {
  const engine = () => new PolicyEngine({ neverLook: () => [], grants: () => ({ finder: "act", "system settings": "act" }), keys: KEYS.darwin, os: M });
  const click = (name: string, role = "push button", extra: Partial<ActionRequest> = {}): ActionRequest => ({
    taskId: "t", kind: "click", app: "Finder", window: "Downloads", element: { role, name }, ...extra,
  });

  it("asks every time for Finder's and the system's words for what can't be undone, also in other languages", () => {
    for (const label of ["Move to Bin", "Force Quit", "Empty Bin", "Delete permanently", "Papierkorb entleeren", "Placer dans la corbeille",
      "Trasladar a la papelera", "Forzar salida", "Uscita forzata", "Forçar Encerrar"]) {
      expect(isRiskyLabel(label, M), label).toBe(true);
      expect(engine().decide(click(label, "menu item")), label).toMatchObject({ verdict: "confirm", risky: true });
    }
    for (const label of ["Move", "Bin", "Open", "Show in Finder"]) expect(isRiskyLabel(label, M), label).toBe(false);
    expect(isRiskyLabel("Move to Bin")).toBe(false); // Linux keeps its own lists only
    expect(RISKY_EXTRA.darwin).toContain("move to bin");
  });

  it("never opens an app anyway past Gatekeeper, in English or another language", () => {
    for (const label of ["Open Anyway", "Trotzdem öffnen", "Ouvrir quand même", "Abrir igualmente", "Apri comunque", "このまま開く", "仍要打开"]) {
      expect(engine().decide(click(label)), label).toMatchObject({ verdict: "deny", tier: "never", reason: "Ember doesn't run programs, so it never makes files executable or runs them" });
    }
    expect(engine().decide(click("Open")).tier).not.toBe("never");
    const gatekeeper = { name: "", text: "“tool” is an app downloaded from the Internet. Are you sure you want to open it?" };
    expect(engine().decide(click("Run", "push button", { dialog: gatekeeper })).tier).toBe("never");
    expect(RUNS_PROGRAM_EXTRA.darwin).toContain("open anyway");
    expect(RUN_FILE_DIALOG_EXTRA.darwin).toContain("are you sure you want to open it");
    // Gatekeeper's own window belongs to CoreServicesUIAgent, a security app: Ember stays out of it whatever its buttons say.
    expect(isSecurityWindow({ app: "CoreServicesUIAgent" }, M)).toBe(true);
  });

  it("has no box that runs what is typed (Finder's Go to Folder only goes there)", () => {
    expect(TYPING_REFUSED.darwin).toEqual([]);
    expect(refusesTyping(TYPING_REFUSED.darwin, { app: "Finder", element: { role: "text", name: "Go to Folder" }, value: "/bin/zsh" })).toBe(false);
  });
});

describe("file paths and the terminal named in a request, on macOS", () => {
  it("knows paths as Linux does", () => {
    expect(FILE_PATH_WORDS.darwin).toBe(FILE_PATH_WORDS.linux);
    expect(FILE_PATH_WORDS.darwin.test("save it in ~/Documents")).toBe(true);
    expect(FILE_PATH_WORDS.darwin.test("save the report")).toBe(false);
  });

  it("hears Terminal and iTerm named as the way to do it, never Console (the log viewer)", () => {
    const t = TERMINAL_REQUEST.darwin;
    for (const s of ["open Terminal and list the files", "use iTerm", "do it in the terminal", "run it from the command line", "use a zsh shell"]) {
      expect(t.asks.test(s), s).toBe(true);
    }
    for (const s of ["open Console and look at the crash logs", "change the terminal font in Settings", "open TextEdit"]) expect(t.asks.test(s), s).toBe(false);
    expect(t.asks.test("in Finder, not in Terminal".replace(t.refuses, " "))).toBe(false);
    expect(t.names.test("Open Terminal")).toBe(true);
    expect(t.names.test("Open Console")).toBe(false);
  });
});

describe("never-look on macOS", () => {
  it("starts with the password managers, Keychain Access and SecurityAgent, each with its name", () => {
    expect(NEVER_LOOK_DEFAULTS.darwin.map(neverLookLabel)).toEqual(["KeePassXC", "1Password", "Bitwarden", "LastPass", "Dashlane", "Enpass", "Strongbox", "MacPass",
      "Keychain Access", "Password prompts (SecurityAgent)"]);
    for (const d of NEVER_LOOK_DEFAULTS.darwin) expect(NEVER_LOOK_NAMES[d], d).toBeTruthy();
  });

  it("hides the managers' windows by app or title, and never an ordinary document about passwords", () => {
    const list = [...NEVER_LOOK_DEFAULTS.darwin];
    for (const w of [{ app: "KeePassXC", name: "Passwords.kdbx" }, { app: "1Password 8", name: "1Password" }, { app: "Keychain Access", name: "login" },
      { app: "SecurityAgent", name: "" }, { app: "Strongbox", name: "Vault" }]) expect(isNeverLook(w, list), w.app).toBe(true);
    for (const w of [{ app: "TextEdit", name: "passwords policy.rtf" }, { app: "Pages", name: "Security review" }]) expect(isNeverLook(w, list), w.name).toBe(false);
  });
});

describe("the macOS clipboard", () => {
  const OS = (x: string) => `electron application/osclipboard;format="${x}"`;
  const f = CLIPBOARD_FORMATS.darwin;

  it("takes nspasteboard.org's concealed type for a password however Electron lists it, and not the transient type", () => {
    for (const t of ["org.nspasteboard.ConcealedType", OS("org.nspasteboard.ConcealedType"), OS("x-kde-passwordManagerHint")]) expect(f.passwordMarker(t), t).toBe(true);
    for (const t of ["org.nspasteboard.TransientType", OS("org.nspasteboard.TransientType"), "text/plain", OS("public.utf8-plain-text")]) expect(f.passwordMarker(t), t).toBe(false);
  });

  it("saves MIME types only: no UTI until CI has verified what Electron accepts back", () => {
    for (const t of ["text/plain", "text/html", "image/png"]) expect(f.savable(t), t).toBe(true);
    for (const t of [OS("public.utf8-plain-text"), OS("public.rtf"), OS("com.apple.webarchive"), OS("org.nspasteboard.ConcealedType")]) expect(f.savable(t), t).toBe(false);
    for (const t of ["text/plain", OS("public.rtf")]) expect(f.savable(t), t).toBe(savableFormat(t));
  });

  it("marks Ember's own paste text transient, and never puts back a concealed copy", async () => {
    expect(f.ownTextMarkers).toEqual(["org.nspasteboard.TransientType"]);
    let items: { types: string[]; data: Record<string, unknown> }[] = [{ types: ["text/plain", OS("org.nspasteboard.ConcealedType")], data: { "text/plain": "hunter2" } }];
    const written: Record<string, unknown>[] = [];
    class Item { constructor(readonly data: Record<string, unknown>) {} }
    const cb = {
      read: async () => items.map(i => ({ types: i.types, getType: async (t: string) => i.data[t] ?? "" })),
      write: async (xs: Item[]) => { for (const x of xs) written.push(x.data); items = xs.map(x => ({ types: Object.keys(x.data), data: x.data })); },
      writeText: async (t: string) => { items = [{ types: ["text/plain"], data: { "text/plain": t } }]; },
      clear: () => { items = []; },
    };
    const clip = electronClipboard(cb, Item as never, 1000, f);
    expect((await clip.save()).password).toBe(true);
    await clip.writeText("Hello");
    expect(written.at(-1)).toEqual({ "text/plain": "Hello", "org.nspasteboard.TransientType": "1" });
    // Ember's own (transient) text is no password: a later save keeps it as an ordinary copy.
    expect((await clip.save()).password).toBeUndefined();
  });
});

describe("the macOS words", () => {
  it("name the Mac's own things, and ask for the three permissions keyboard borrowing needs", () => {
    const w = PLATFORM_WORDS.darwin;
    for (const [k, v] of Object.entries(w)) expect(v, k).not.toMatch(/GNOME|RHEL|Linux|dnf|X11|Windows/);
    expect(w.fileManager).toBe("Finder");
    expect(w.settingsApp).toBe("System Settings");
    expect(w.permissionsNote).toBe("macOS will ask you to allow Accessibility, Screen Recording and Input Monitoring for Ember.");
  });
});
