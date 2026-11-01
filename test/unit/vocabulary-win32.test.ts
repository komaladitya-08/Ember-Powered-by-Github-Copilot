/**
 * The Windows vocabularies (design §9.11): every row with a positive and a negative example, through the checks that
 * read it (isTerminalApp, hasBuiltInShell, isSecurityWindow, the policy, never-look, the clipboard), so a word that
 * goes missing or one that starts matching ordinary apps fails here. Also: every provisional Windows row the
 * composition carried in interim.ts is still refused through the real modules, and the Linux rows are frozen copies.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { NEVER_LOOK_DEFAULTS, NEVER_LOOK_NAMES, neverLookLabel } from "../../app/shared/never-look";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { hasBuiltInShell, isTerminalApp, programsOf, type DesktopApp } from "../../app/main/hands/system";
import {
  INTERPRETERS, LAUNCHERS, REFUSED, SHELLS, SHELL_APP, SHELL_APP_ID, SHELL_APP_NAME, SHELL_MODULES, TERMINALS, TERMINAL_CLASSES, TERMINAL_ID_WORDS,
  TERMINAL_NAME, WRAPPERS,
} from "../../app/main/hands/terminals";
import { PolicyEngine, isRiskyLabel, isSecurityWindow, refusesTyping, type ActionRequest } from "../../app/main/policy/policy";
import {
  FILE_PATH_WORDS, OFFICE_APP, RISKY_EXTRA, RUN_FILE_DIALOG_EXTRA, RUNS_PROGRAM_EXTRA, SECURITY_APP, SECURITY_CLASS, SECURITY_TITLE, TABBED_APP,
  TERMINAL_REQUEST, TERMINAL_REQUEST_WSL, TYPING_REFUSED, WEB_APP, terminalRequest,
} from "../../app/main/policy/vocabulary";
import { CLIPBOARD_FORMATS, savableFormat } from "../../app/main/agent/clipboard-formats";
import { electronClipboard } from "../../app/main/agent/clipboard";
import { isNeverLook } from "../../app/main/perception/elements";
import * as interim from "../../app/main/platform/win32/system/interim";

const W = "win32" as const;
const terminal = (app: Parameters<typeof isTerminalApp>[0]) => isTerminalApp(app, W);
const shell = (app: Parameters<typeof hasBuiltInShell>[0]) => hasBuiltInShell(app, W);
/** A window's app as the policy asks about it (main.ts: `{ id: name, name }`). */
const named = (name: string) => terminal({ id: name, name });
/** A Start Menu shortcut to `exe` with `args`. */
const lnk = (name: string, exe: string, ...args: string[]) => ({ id: `Programs/${name}`, name, argv: [exe, ...args] });

describe("the Windows terminals, shells and command surfaces", () => {
  it("knows Windows' consoles, WSL and the common third-party terminals by program, with or without .exe and any case", () => {
    for (const p of ["cmd", "CMD.EXE", "powershell", "pwsh", "pwsh-preview", "WindowsTerminal", "wt", "OpenConsole", "conhost", "wsl", "wslhost", "bash",
      "ubuntu2204", "debian", "kali", "mintty", "git-bash", "cmder", "ConEmu64", "fluentterminal", "MobaXterm", "SecureCRT", "putty", "alacritty",
      "wezterm-gui", "Tabby", "Termius"]) expect(named(p), p).toBe(true);
    for (const p of ["notepad", "explorer", "msedge", "winword", "calculatorapp", "mspaint", "systemsettings", "teams"]) expect(named(p), p).toBe(false);
    expect(TERMINALS.win32.has("cmd")).toBe(true);
    expect(TERMINALS.win32.has("notepad")).toBe(false);
  });

  it("reads a shortcut's target, through backslashes and explorer.exe, and never takes File Explorer for one", () => {
    expect(terminal(lnk("Command Prompt", "C:\\Windows\\System32\\cmd.exe"))).toBe(true);
    expect(terminal(lnk("Dev", "C:\\Windows\\System32\\cmd.exe", "/k", "vsdevcmd.bat"))).toBe(true);
    expect(terminal(lnk("Shell", "C:\\Windows\\explorer.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))).toBe(true);
    expect(terminal(lnk("File Explorer", "C:\\Windows\\explorer.exe"))).toBe(false);
    expect(terminal(lnk("Documents", "C:\\Windows\\explorer.exe", "C:\\Users\\ada\\Documents"))).toBe(false);
    expect(terminal(lnk("Notepad", "C:\\Windows\\System32\\notepad.exe"))).toBe(false);
    expect(WRAPPERS.win32).toEqual({ explorer: {} });
  });

  it("refuses shells and interpreters waiting for typed code, but not a program an interpreter runs", () => {
    expect(SHELLS.win32.test("bash")).toBe(true);
    expect(SHELLS.win32.test("notepad")).toBe(false);
    expect(INTERPRETERS.win32.test("python3.12")).toBe(true);
    expect(INTERPRETERS.win32.test("pythonw")).toBe(true);
    expect(INTERPRETERS.win32.test("excel")).toBe(false);
    expect(SHELL_MODULES.win32.test("idlelib")).toBe(true);
    expect(SHELL_MODULES.win32.test("http.server")).toBe(false);
    expect(terminal(lnk("Python 3.12", "C:\\Python312\\python.exe"))).toBe(true);
    expect(terminal(lnk("IDLE", "C:\\Python312\\pythonw.exe", "-m", "idlelib"))).toBe(true);
    expect(terminal(lnk("Tool", "C:\\Python312\\pythonw.exe", "C:\\Tools\\tool.pyw"))).toBe(false);
    expect(terminal(lnk("Sh", "C:\\Program Files\\Git\\bin\\sh.exe", "-c", "wt.exe"))).toBe(true);
  });

  it("refuses apps with a shell built in, and Start, Search, Task Manager and PowerToys Run", () => {
    for (const p of ["devenv", "powershell_ise", "notepad++", "cursor", "windsurf", "code", "code - insiders", "pycharm64", "idea64", "studio64", "sublime_text",
      "runemacs", "searchhost", "searchapp", "startmenuexperiencehost", "searchui", "taskmgr", "powertoys.powerlauncher"]) {
      expect(SHELL_APP.win32.test(p), p).toBe(true);
      expect(named(p), p).toBe(true);
    }
    for (const p of ["notepad", "wordpad", "winword", "codec", "studio one", "explorer"]) expect(SHELL_APP.win32.test(p), p).toBe(false);
    expect(shell(lnk("IDLE (Python 3.12 64-bit)", "C:\\Python312\\pythonw.exe", "C:\\Python312\\Lib\\idlelib\\idle.pyw"))).toBe(true);
    expect(shell({ id: "Visual Studio 2022", name: "Visual Studio 2022" })).toBe(true);
    expect(shell({ id: "x", name: "Visual Studio Code" })).toBe(true);
    expect(shell({ id: "x", name: "Notepad++" })).toBe(true);
    expect(shell({ id: "x", name: "Task Manager" })).toBe(true);
    expect(shell({ id: "x", name: "Notepad" })).toBe(false);
    expect(SHELL_APP_NAME.win32.test("Microsoft Visual Basic for Applications - Book1")).toBe(true);
    expect(SHELL_APP_NAME.win32.test("Visual Studio Installer")).toBe(true);
    expect(SHELL_APP_NAME.win32.test("Paint 3D")).toBe(false);
  });

  it("knows packaged apps by their ids (Windows Terminal, PowerShell, the WSL distributions), split at ! and _", () => {
    for (const id of ["Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "Microsoft.PowerShell_8wekyb3d8bbwe!Microsoft.PowerShell",
      "CanonicalGroupLimited.Ubuntu22.04LTS_79rhkp1fndgsc!ubuntu2204", "TheDebianProject.DebianGNULinux_76v4gfsz19hv4!debian",
      "MicrosoftCorporationII.WindowsSubsystemForLinux_8wekyb3d8bbwe!App", "Microsoft.VisualStudioCode"]) {
      expect(terminal({ id, name: "App" }), id).toBe(true);
    }
    expect(SHELL_APP_ID.win32.test("microsoft.windowsterminal_8wekyb3d8bbwe!app")).toBe(true);
    expect(SHELL_APP_ID.win32.test("microsoft.windowscalculator_8wekyb3d8bbwe!app")).toBe(false);
    expect(terminal({ id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "Calculator" })).toBe(false);
  });

  it("knows a console window by its class, whatever program it hosts, in any case", () => {
    for (const windowClass of ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow", "mintty", "PuTTY", "VirtualConsoleClass", "consolewindowclass"]) {
      expect(terminal({ id: "ping", name: "ping", windowClass }), windowClass).toBe(true);
    }
    for (const windowClass of ["Notepad", "Chrome_WidgetWin_1", "#32770", "CabinetWClass"]) expect(terminal({ id: "x", name: "x", windowClass }), windowClass).toBe(false);
    expect(TERMINAL_CLASSES.win32).toHaveLength(6);
  });

  it("refuses programs that run commands as someone else or a script they are handed, and judges app names", () => {
    for (const p of ["runas", "sudo", "psexec64", "ssh", "winrs", "mshta", "wscript", "cscript", "regsvr32", "msiexec", "cmstp", "installutil", "msbuild",
      "forfiles", "pcalua", "schtasks", "at", "sc", "reg", "bitsadmin", "certutil", "wmic", "msdt", "wslg"]) {
      expect(REFUSED.win32.test(p), p).toBe(true);
      expect(terminal(lnk("x", `C:\\Windows\\System32\\${p}.exe`, "x")), p).toBe(true);
    }
    for (const p of ["notepad", "regedit", "scp", "atx", "msiexecutor"]) expect(REFUSED.win32.test(p), p).toBe(false);
    for (const n of ["Windows Terminal", "Command Prompt", "Developer Command Prompt for VS 2022", "Developer PowerShell for VS 2022", "Anaconda Prompt",
      "Miniforge Prompt", "Git Bash", "Recovery Console"]) {
      expect(TERMINAL_NAME.win32.test(n), n).toBe(true);
      expect(terminal({ id: "x", name: n }), n).toBe(true);
    }
    for (const n of ["Notepad", "Snipping Tool", "Prompt Builder", "Terminally Ill"]) expect(TERMINAL_NAME.win32.test(n), n).toBe(false);
  });

  it("drops launchers from the programs an app's windows report, never File Explorer", () => {
    const app = (programs: string[]): DesktopApp => ({ id: "x", name: "x", file: "x.lnk", keywords: [], argv: [], programs });
    expect(programsOf(app(["rundll32", "javaw", "pythonw", "py", "applicationframehost", "myapp"]), LAUNCHERS.win32)).toEqual(new Set(["myapp"]));
    expect(programsOf(app(["explorer"]), LAUNCHERS.win32)).toEqual(new Set(["explorer"]));
  });

  it("keeps \"console\" a terminal word in Windows ids (none of its apps is a log viewer)", () => {
    expect(TERMINAL_ID_WORDS.win32).toEqual(["console"]);
  });
});

describe("the provisional Windows rows interim.ts carried, now in the OS-keyed modules", () => {
  // The lists the composition's provisional checks held before Phase 1 and V merged (WS's interim.ts).
  const PROGRAMS = ["cmd", "powershell", "pwsh", "pwsh-preview", "windowsterminal", "wt", "openconsole", "conhost", "wsl", "wslhost", "bash", "ubuntu",
    "ubuntu2004", "ubuntu2204", "ubuntu2404", "debian", "kali", "mintty", "git-bash", "cmder", "conemu", "conemu64", "mobaxterm", "securecrt", "xshell",
    "termius", "putty"];
  const SHELL_PROGRAMS = ["devenv", "powershell_ise", "notepad++", "cursor", "windsurf", "code", "code - insiders", "searchhost", "searchapp",
    "startmenuexperiencehost", "searchui", "taskmgr"];
  const REFUSED_PROGRAMS = ["runas", "psexec", "psexec64", "mshta", "wscript", "cscript", "regsvr32", "msiexec", "cmstp", "installutil", "msbuild", "forfiles",
    "pcalua", "schtasks", "at", "sc", "reg", "bitsadmin", "certutil", "wmic"];

  it("refuses every one of them as a shortcut's target, as a window's app and as a catalogue entry's program", () => {
    for (const p of [...PROGRAMS, ...SHELL_PROGRAMS, ...REFUSED_PROGRAMS]) {
      expect(terminal(lnk("x", `C:\\Tools\\${p}.exe`)), p).toBe(true);
      expect(interim.isTerminalApp({ id: "Some App", name: "Some App", programs: [p] } as Parameters<typeof interim.isTerminalApp>[0], W), p).toBe(true);
    }
    for (const p of [...PROGRAMS.filter(p => !["at", "sc", "reg"].includes(p)), ...SHELL_PROGRAMS]) expect(named(p), p).toBe(true);
    for (const p of SHELL_PROGRAMS) {
      expect(interim.hasBuiltInShell({ id: "Some App", name: "Some App", programs: [p] } as Parameters<typeof interim.hasBuiltInShell>[0], W), p).toBe(true);
    }
  });

  it("doesn't take a catalogue entry for a terminal by an ordinary program, nor an interpreter-run app for a REPL", () => {
    const entry = (programs: string[]) => ({ id: "Some App", name: "Some App", programs }) as Parameters<typeof interim.isTerminalApp>[0];
    expect(interim.isTerminalApp(entry(["notepad"]), W)).toBe(false);
    expect(interim.isTerminalApp(entry(["pythonw"]), W)).toBe(false);
    expect(interim.hasBuiltInShell(entry(["notepad"]), W)).toBe(false);
  });

  it("keeps the security programs, classes and titles, the never-look list and the clipboard markers", () => {
    for (const app of ["credentialuibroker", "consent", "logonui", "lockapp", "sechealthui", "securityhealthhost", "smartscreen", "bdeunlock", "bdeuisrv",
      "microsoft.aad.brokerplugin", "wwahost", "pinenrollmentbroker", "bioenrollmenthost", "credentialenrollmentmanager"]) {
      expect(interim.isSecurityWindow({ app }, W), app).toBe(true);
      expect(interim.isSecurityWindow({ app: `${app.toUpperCase()}.EXE` }, W), app).toBe(true);
    }
    expect(interim.isSecurityClass("Credential Dialog Xaml Host")).toBe(true);
    expect(interim.isSecurityClass(" $$$Secure UAP Dummy Window Class For Interim Dialog ")).toBe(true);
    expect(interim.isSecurityClass("Notepad")).toBe(false);
    expect(interim.isSecurityWindow({ title: "  Making sure it’s you " }, W)).toBe(true);
    expect(interim.NEVER_LOOK_DEFAULTS_WIN32).toEqual(NEVER_LOOK_DEFAULTS.win32);
    expect(interim.CLIPBOARD_FORMATS_WIN32).toBe(CLIPBOARD_FORMATS.win32);
    expect(interim.LAUNCHERS).toBe(LAUNCHERS);
  });
});

describe("the Windows security vocabulary", () => {
  it("knows every security program, with or without .exe, in any case, and only as the whole program", () => {
    for (const app of ["CredentialUIBroker", "CredentialUIBroker.exe", "consent.exe", "LogonUI", "LockApp", "credwiz", "SecHealthUI", "SecurityHealthHost",
      "SecurityHealthSystray", "smartscreen", "BdeUnlock", "bdeuisrv", "Microsoft.AAD.BrokerPlugin", "WWAHost", "PinEnrollmentBroker", "BioEnrollmentHost",
      "CredentialEnrollmentManager", "UserAccountControlSettings"]) {
      expect(SECURITY_APP.win32?.test(app), app).toBe(true);
      expect(isSecurityWindow({ app, title: "" }, W), app).toBe(true);
    }
    for (const app of ["consenting", "notepad", "logon", "credentialuibroker2", "my consent form", "explorer", "smartscreen.exe.bak"]) {
      expect(isSecurityWindow({ app, title: "x" }, W), app).toBe(false);
    }
  });

  it("knows the credential and consent dialogs' window classes, as perception passes them (the class as the app)", () => {
    expect(SECURITY_CLASS.win32).toEqual(["credential dialog xaml host", "$$$secure uap dummy window class for interim dialog"]);
    for (const c of SECURITY_CLASS.win32) expect(c).toBe(c.toLowerCase());
    expect(isSecurityWindow({ app: "Credential Dialog Xaml Host" }, W)).toBe(true);
    expect(isSecurityWindow({ app: "$$$Secure UAP Dummy Window Class For Interim Dialog" }, W)).toBe(true);
    expect(isSecurityWindow({ app: "Chrome_WidgetWin_1" }, W)).toBe(false);
  });

  it("knows the security titles as whole titles, curly apostrophes and spacing aside", () => {
    for (const title of ["Windows Security", "User Account Control", "User Account Control Settings", "Enter network credentials", "Windows Hello",
      "Making sure it's you", "Making sure it’s you", "Credential Manager", "Stored User Names and Passwords", "BitLocker Drive Encryption",
      "Windows Defender Firewall", "Windows Defender Firewall with Advanced Security", "  windows   security  "]) {
      expect(isSecurityWindow({ app: "someapp", title }, W), title).toBe(true);
    }
    for (const title of ["Windows Security notes.txt - Notepad", "About User Account Control - Microsoft Edge", "credential manager.docx - Word", "Windows",
      "Hello"]) {
      expect(isSecurityWindow({ app: "someapp", title }, W), title).toBe(false);
    }
  });

  it("keeps Linux's prompts out of Windows: GNOME's programs mean nothing there", () => {
    expect(isSecurityWindow({ app: "polkit-gnome-authentication-agent-1" }, W)).toBe(false);
    expect(isSecurityWindow({ app: "x", title: "Authentication Required" }, W)).toBe(false);
  });
});

describe("browsers, mail and office suites on Windows", () => {
  it("knows browsers, mail and chat apps by program, whole words only", () => {
    for (const app of ["msedge", "msedge.exe", "chrome", "firefox", "brave", "opera", "vivaldi", "outlook", "olk", "hxoutlook", "thunderbird", "ms-teams", "teams",
      "slack", "discord", "WhatsApp", "Signal", "Telegram"]) expect(TABBED_APP.win32?.test(app), app).toBe(true);
    for (const app of ["folkets", "notepad", "chromecast", "mailmerge", "winword", "explorer"]) expect(TABBED_APP.win32?.test(app), app).toBe(false);
  });

  it("knows web-engine apps (Edge, the new Outlook, Teams, Electron) apart from desktop mail", () => {
    for (const app of ["msedge", "msedgewebview2", "olk", "ms-teams", "slack", "electron", "discord"]) expect(WEB_APP.win32?.test(app), app).toBe(true);
    for (const app of ["outlook", "thunderbird", "notepad", "winword"]) expect(WEB_APP.win32?.test(app), app).toBe(false);
  });

  it("knows Word, Excel, PowerPoint and LibreOffice", () => {
    for (const app of ["winword", "WINWORD.EXE", "excel", "powerpnt", "soffice", "soffice.bin", "libreoffice"]) expect(OFFICE_APP.win32?.test(app), app).toBe(true);
    for (const app of ["notepad", "word", "excelsior", "msedge"]) expect(OFFICE_APP.win32?.test(app), app).toBe(false);
  });
});

describe("risky and run-a-program labels on Windows", () => {
  const engine = () => new PolicyEngine({ neverLook: () => [], grants: () => ({ explorer: "act", taskmgr: "act" }), keys: KEYS.win32, os: W });
  const click = (name: string, role = "push button", extra: Partial<ActionRequest> = {}): ActionRequest => ({
    taskId: "t", kind: "click", app: "explorer", window: "Downloads", element: { role, name }, ...extra,
  });

  it("asks every time for the system's own words for what can't be undone, also in other languages", () => {
    for (const label of ["Move to Recycle Bin", "End task", "Empty Recycle Bin", "Delete permanently", "Papierkorb entleeren", "Fin de tâche", "Finalizar tarea",
      "Termina attività", "Finalizar tarefa"]) {
      expect(isRiskyLabel(label, W), label).toBe(true);
      expect(engine().decide(click(label, "menu item")), label).toMatchObject({ verdict: "confirm", risky: true });
    }
    for (const label of ["Move to", "Open", "Task view", "Bin", "Recycle"]) expect(isRiskyLabel(label, W), label).toBe(false);
    // Linux keeps its own lists only.
    expect(isRiskyLabel("Move to Recycle Bin")).toBe(false);
    expect(RISKY_EXTRA.win32).toContain("end task");
  });

  it("never unblocks a file, runs it anyway, or answers Explorer's security warning with Run", () => {
    for (const label of ["Unblock", "Run anyway", "Débloquer", "Desbloquear", "Exécuter quand même", "Trotzdem ausführen", "仍要运行"]) {
      expect(engine().decide(click(label, "check box")), label).toMatchObject({ verdict: "deny", tier: "never", reason: "Ember doesn't run programs, so it never makes files executable or runs them" });
    }
    const warning = (name: string, text: string) => ({ name, text });
    expect(engine().decide(click("Run", "push button", { dialog: warning("Open File - Security Warning", "The publisher could not be verified.") })).tier).toBe("never");
    expect(engine().decide(click("Run", "push button", { dialog: warning("Datei öffnen - Sicherheitswarnung", "") })).tier).toBe("never");
    expect(engine().decide(click("Run", "push button", { dialog: warning("Backup", "Run the backup now?") })).tier).not.toBe("never");
    expect(engine().decide(click("Block", "check box")).tier).not.toBe("never");
    expect(RUNS_PROGRAM_EXTRA.win32).toContain("unblock");
    expect(RUN_FILE_DIALOG_EXTRA.win32).toContain("open file - security warning");
  });
});

describe("typing into Windows' command boxes", () => {
  const rules = TYPING_REFUSED.win32;
  const into = (field: string, value: string, app = "explorer") => ({ app, element: { role: "text", name: field }, value });

  it("refuses a program's name, a runnable file, a terminal's path or a URI in File Explorer's address box", () => {
    for (const value of ["cmd", " powershell ", "wt", "%ComSpec%", "\"cmd\"", "notepad.exe", "C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\System32\\cmd",
      "%windir%\\System32\\WindowsPowerShell\\v1.0\\powershell", "\\\\server\\share\\setup.msi", "C:\\x\\run.bat", "evil.ps1", "y.vbs", "a.lnk", "x.hta",
      "shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "shell:startup", "ms-msdt:/id", "file:///C:/x/y", "search-ms:query=x"]) {
      expect(refusesTyping(rules, into("Address", value)), value).toBe(true);
    }
    for (const field of ["Address: Documents", "Adresse", "Dirección", "アドレス"]) expect(refusesTyping(rules, into(field, "cmd")), field).toBe(true);
  });

  it("refuses a command line there too: the box passes what follows the program to it", () => {
    for (const value of ["cmd /k whoami", "powershell -NoExit -Command Get-Process", "wt -d .", "%ComSpec% /c dir", "notepad C:\\x\\notes.txt",
      "C:\\Windows\\System32\\cmd.exe /k dir", "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -c x", "C:\\Windows\\System32\\cmd /k dir",
      "%windir%\\System32\\WindowsPowerShell\\v1.0\\powershell -c x", "\\\\server\\share\\setup.msi /quiet", "C:\\x\\run.bat now"]) {
      expect(refusesTyping(rules, into("Address", value)), value).toBe(true);
    }
    for (const value of ["C:\\Users\\ada\\My Documents", "\\\\server\\share\\Q3 reports", "%USERPROFILE%\\Pictures\\Summer 2026", "C:\\Program Files (x86)"]) {
      expect(refusesTyping(rules, into("Address", value)), value).toBe(false);
    }
  });

  it("lets a folder's path through, and leaves other apps' address fields alone", () => {
    for (const value of ["C:\\Users\\ada\\Documents", "D:\\", "C:", "\\\\server\\share\\reports", "%USERPROFILE%\\Downloads", "C:\\Program Files\\Git"]) {
      expect(refusesTyping(rules, into("Address", value)), value).toBe(false);
    }
    expect(refusesTyping(rules, into("Address", "cmd", "msedge"))).toBe(false);
    expect(refusesTyping(rules, into("Address and search bar", "cmd", "explorer"))).toBe(false);
    expect(refusesTyping(rules, into("Search Downloads", "cmd"))).toBe(false);
    expect(refusesTyping(rules, into("Shipping address", "London", "chrome"))).toBe(false);
  });

  it("refuses any text in the Run dialog's box (it runs what is typed)", () => {
    for (const field of ["Open:", "Open", "Öffnen:", "Ouvrir :", "打开(O):"]) expect(refusesTyping(rules, into(field, "anything at all")), field).toBe(true);
    expect(refusesTyping(rules, into("Open with", "x"))).toBe(false);
    expect(refusesTyping(rules, into("File name:", "notes.txt"))).toBe(false);
  });

  it("is what the Windows policy decides for type_text", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ explorer: "act" }), keys: KEYS.win32, os: W });
    const type = (name: string, value: string) => e.decide({ taskId: "t", kind: "text", app: "explorer", window: "Downloads", element: { role: "text", name }, value, mode: "replace" });
    expect(type("Address", "cmd")).toMatchObject({ verdict: "deny", tier: "never", reason: "Ember doesn't run programs, so it never types a program's name where it would start" });
    expect(type("Address", "C:\\Users\\ada\\Documents").verdict).toBe("allow");
  });
});

describe("file paths and the terminal named in a request, on Windows", () => {
  it("knows drive and network paths as a file named", () => {
    for (const s of ["save it as C:\\Users\\ada\\report", "put it on \\\\server\\share", "call it notes.txt", "in ~/x"]) expect(FILE_PATH_WORDS.win32.test(s), s).toBe(true);
    for (const s of ["save the report", "name it after the client"]) expect(FILE_PATH_WORDS.win32.test(s), s).toBe(false);
    expect(FILE_PATH_WORDS.linux.test("save it as C:\\Users\\ada\\report")).toBe(false);
  });

  it("hears PowerShell, cmd and WSL named as the way to do it, and a refusal of them", () => {
    const t = TERMINAL_REQUEST.win32;
    for (const s of ["open PowerShell and list the files", "do it in cmd", "use the command prompt", "run it in Windows Terminal", "start wsl", "open a terminal"]) {
      expect(t.asks.test(s), s).toBe(true);
    }
    for (const s of ["rename the file in File Explorer", "change the terminal font in Settings", "open Notepad"]) expect(t.asks.test(s), s).toBe(false);
    expect(t.asks.test("in File Explorer, not in PowerShell".replace(t.refuses, " "))).toBe(false);
    expect(t.names.test("Open PowerShell")).toBe(true);
    expect(t.names.test("Open Notepad")).toBe(false);
    expect(t.refuses.flags).toContain("g");
  });

  it("with WSL on, hears bare “WSL” as a place to work, while the WSL terminal and shell are still terminals (§3.15)", () => {
    // Chosen by state: Windows without WSL, Linux and macOS keep today's rows.
    expect(terminalRequest("win32", false)).toBe(TERMINAL_REQUEST.win32);
    expect(terminalRequest("linux", true)).toBe(TERMINAL_REQUEST.linux);
    expect(terminalRequest("darwin", true)).toBe(TERMINAL_REQUEST.darwin);
    expect(terminalRequest("win32", true)).toBe(TERMINAL_REQUEST_WSL);
    const t = TERMINAL_REQUEST_WSL;
    for (const s of ["open gedit in WSL", "start wsl", "list my files in WSL", "use WSL to open the notes"]) {
      expect(t.asks.test(s), s).toBe(false);
      // Today's row (WSL off) still hears them as the terminal.
      expect(TERMINAL_REQUEST.win32.asks.test(s), s).toBe(true);
    }
    for (const s of ["open the WSL terminal", "do it in a WSL shell", "open PowerShell and list the files", "do it in cmd", "use the command prompt", "run it in Windows Terminal", "open a terminal"]) {
      expect(t.asks.test(s), s).toBe(true);
    }
    expect(t.asks.test("in File Explorer, not in PowerShell".replace(t.refuses, " "))).toBe(false);
    expect(t.names.test("Open gedit in WSL")).toBe(false);
    expect(t.names.test("Open the WSL terminal")).toBe(true);
    expect(t.refuses.flags).toContain("g");
  });
});

describe("never-look on Windows", () => {
  it("starts with the password managers and Windows Security's prompt, each with its name", () => {
    expect(NEVER_LOOK_DEFAULTS.win32.map(neverLookLabel)).toEqual(["KeePass", "1Password", "Bitwarden", "LastPass", "Dashlane", "NordPass", "RoboForm", "Enpass",
      "Keeper", "Password prompts (Windows Security)"]);
    for (const d of NEVER_LOOK_DEFAULTS.win32) expect(NEVER_LOOK_NAMES[d], d).toBeTruthy();
  });

  it("hides the managers' windows by program or title, and never an ordinary window", () => {
    const list = [...NEVER_LOOK_DEFAULTS.win32];
    for (const w of [{ app: "KeePass", name: "Database.kdbx - KeePass" }, { app: "keepassxc", name: "Passwords" }, { app: "1Password", name: "1Password" },
      { app: "Bitwarden", name: "Bitwarden" }, { app: "CredentialUIBroker", name: "Windows Security" }]) expect(isNeverLook(w, list), w.app).toBe(true);
    for (const w of [{ app: "notepad", name: "passwords policy.txt - Notepad" }, { app: "winword", name: "Windows security review.docx - Word" }]) {
      expect(isNeverLook(w, list), w.name).toBe(false);
    }
  });
});

describe("the Windows clipboard", () => {
  const OS = (x: string) => `electron application/osclipboard;format="${x}"`;
  const f = CLIPBOARD_FORMATS.win32;

  it("takes Windows password managers' markers for a password however Electron lists them, and nothing else", () => {
    for (const t of ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore", OS("ExcludeClipboardContentFromMonitorProcessing"),
      OS("Clipboard Viewer Ignore"), OS("x-kde-passwordManagerHint")]) expect(f.passwordMarker(t), t).toBe(true);
    for (const t of ["text/plain", OS("CanIncludeInClipboardHistory"), OS("Rich Text Format"), "Clipboard Viewer"]) expect(f.passwordMarker(t), t).toBe(false);
  });

  it("saves MIME types only: never a GDI handle format or a Windows format CI hasn't verified", () => {
    for (const t of ["text/plain", "text/html", "image/png", OS("text/uri-list")]) expect(f.savable(t), t).toBe(true);
    for (const t of [OS("CF_BITMAP"), OS("CF_ENHMETAFILE"), OS("CF_METAFILEPICT"), OS("CF_PALETTE"), OS("CF_DSPTEXT"), OS("Rich Text Format"), OS("HTML Format")]) {
      expect(f.savable(t), t).toBe(false);
    }
    for (const t of ["text/plain", OS("PIXMAP"), "x-kde-passwordManagerHint"]) expect(f.savable(t), t).toBe(savableFormat(t));
  });

  it("marks Ember's own paste text so clipboard history and cloud sync skip it, and never puts a marked copy back", async () => {
    expect(f.ownTextMarkers).toEqual(["ExcludeClipboardContentFromMonitorProcessing"]);
    let items: { types: string[]; data: Record<string, unknown> }[] = [{ types: ["text/plain", OS("Clipboard Viewer Ignore")], data: { "text/plain": "hunter2" } }];
    const written: Record<string, unknown>[] = [];
    class Item { constructor(readonly data: Record<string, unknown>) {} }
    const cb = {
      read: async () => items.map(i => ({ types: i.types, getType: async (t: string) => i.data[t] ?? "" })),
      write: async (xs: Item[]) => { for (const x of xs) written.push(x.data); items = xs.map(x => ({ types: Object.keys(x.data), data: x.data })); },
      writeText: async (t: string) => { items = [{ types: ["text/plain"], data: { "text/plain": t } }]; },
      clear: () => { items = []; },
    };
    const clip = electronClipboard(cb, Item as never, 1000, f);
    const saved = await clip.save();
    expect(saved.password).toBe(true);
    await clip.writeText("Hello");
    expect(written.at(-1)).toEqual({ "text/plain": "Hello", ExcludeClipboardContentFromMonitorProcessing: "1" });
  });
});

describe("the Windows words", () => {
  it("name Windows' own things, never GNOME's or Linux's", () => {
    const w = PLATFORM_WORDS.win32;
    for (const [k, v] of Object.entries(w)) expect(v, k).not.toMatch(/GNOME|RHEL|Linux|dnf|X11|keyring/);
    expect(w.fileManager).toBe("File Explorer");
    expect(w.overviewOpen).toContain("Task View");
    expect(w.overviewOpen).toContain("Start");
    expect(w.permissionsNote).toBe("");
  });
});

describe("the Linux rows stay frozen copies", () => {
  const same = (a: RegExp | null, b: RegExp) => expect([a?.source, a?.flags]).toEqual([b.source, b.flags]);

  it("keeps the policy vocabulary's Linux rows as the expressions they were", () => {
    same(SECURITY_APP.linux, /polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|^firewall-config$|(^|\s)gnome-shell(\s|$)/i);
    same(SECURITY_TITLE.linux, /^\s*(authenticat(e|ion)\b.*\b(required|request)\b|authenticate\s*$|(password|passphrase|pin) (required|request(ed)?)\b|enter (the |your |a )?(password|passphrase|pin)\b|unlock\b.*\b(keyring|private key|password|passphrase)\b|\[sudo\]|sudo password\b)/);
    same(TABBED_APP.linux, /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|thunderbird|evolution|geary|claws|mail|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram/i);
    same(WEB_APP.linux, /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|electron|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram|whatsapp/i);
    same(OFFICE_APP.linux, /soffice|libreoffice/i);
    same(FILE_PATH_WORDS.linux, /[~/][\w.-]|\.\w{1,5}\b/);
    same(TERMINAL_REQUEST.linux.names, /\b(?:terminal|shell|command[- ]line|command prompt|console)\b/i);
    expect([SECURITY_CLASS.linux, RISKY_EXTRA.linux, RUNS_PROGRAM_EXTRA.linux, RUN_FILE_DIALOG_EXTRA.linux, TYPING_REFUSED.linux]).toEqual([[], [], [], [], []]);
  });

  it("keeps the Linux never-look list, clipboard rule, words and terminal id words", () => {
    expect(NEVER_LOOK_DEFAULTS.linux).toEqual(["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]);
    const OS = (x: string) => `electron application/osclipboard;format="${x}"`;
    for (const t of ["text/plain", OS("PIXMAP"), OS("x-kde-passwordManagerHint"), "x-kde-passwordManagerHint", OS("ExcludeClipboardContentFromMonitorProcessing")]) {
      expect(CLIPBOARD_FORMATS.linux.savable(t), t).toBe(savableFormat(t));
      expect(CLIPBOARD_FORMATS.linux.passwordMarker(t), t).toBe(t.includes("x-kde-passwordManagerHint"));
    }
    expect(CLIPBOARD_FORMATS.linux.ownTextMarkers).toEqual([]);
    expect(PLATFORM_WORDS.linux).toEqual({
      desktop: "Linux desktop (RHEL, GNOME)", apps: "Linux desktop applications (RHEL, GNOME)", fileManager: "Files",
      settingsApp: "Settings", openAppExamples: "Text Editor, Files, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
      fileDialogPathHint: "in a file dialog press Ctrl+L (or use its name field) and type the file's name",
      noScreen: "no X11 display or accessibility service", reinstall: "Reinstall Ember (sudo dnf reinstall ember).",
      shellUnchecked: "GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
      overviewOpen: "the Activities overview or the window switcher is open (it shows every window), so Ember looks away until it's closed",
      keyringMissing: "No keyring is available", micIndicator: "GNOME shows a microphone icon while Ember listens.", permissionsNote: "",
    });
    expect(TERMINAL_ID_WORDS.linux).toEqual(["console"]);
  });
});
