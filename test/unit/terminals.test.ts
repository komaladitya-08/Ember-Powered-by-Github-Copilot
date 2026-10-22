/** The terminal and shell vocabularies (hands/terminals.ts) and the checks that read them, per OS (design §4.15, §9.11). */

import { describe, expect, it, vi } from "vitest";

// Windows rows as package V will fill them (a few entries), so the per-OS mechanics are tested before the data lands.
// The Linux rows are the real module's.
vi.mock("../../app/main/hands/terminals", async importOriginal => {
  const m = await importOriginal<typeof import("../../app/main/hands/terminals")>();
  return {
    ...m,
    TERMINALS: { ...m.TERMINALS, win32: new Set(["cmd", "powershell", "windowsterminal", "wt"]), darwin: new Set(["terminal", "iterm2"]) },
    SHELL_APP: { ...m.SHELL_APP, win32: /^(devenv|notepad\+\+)$/ },
    SHELL_APP_ID: { ...m.SHELL_APP_ID, darwin: /^com\.apple\.scripteditor\d*$/ },
    REFUSED: { ...m.REFUSED, win32: /^(runas|mshta)$/ },
    TERMINAL_NAME: { ...m.TERMINAL_NAME, win32: /\b(terminal|console|command prompt|powershell)\b/i },
    TERMINAL_CLASSES: { ...m.TERMINAL_CLASSES, win32: ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"] },
  };
});

import {
  INTERPRETERS, LAUNCHERS, REFUSED, SHELLS, SHELL_APP, SHELL_APP_ID, SHELL_APP_NAME, SHELL_MODULES, TERMINALS, TERMINAL_CLASSES, TERMINAL_NAME, WRAPPERS,
} from "../../app/main/hands/terminals";
import { hasBuiltInShell, isTerminalApp } from "../../app/main/hands/system";

/** The lists as hands/system.ts had them before they moved (frozen: the Linux rows must never drift). */
const FROZEN = {
  terminals: [
    "xterm", "uxterm", "lxterm", "koi8rxterm", "urxvt", "urxvtc", "urxvtd", "rxvt", "rxvt-unicode", "aterm", "eterm", "mlterm", "st", "stterm", "xvt",
    "wezterm", "wezterm-gui", "foot", "footclient", "kitty", "alacritty", "terminator", "tilix", "terminix", "konsole", "yakuake", "guake", "tilda",
    "terminology", "cool-retro-term", "kgx", "gnome-console", "blackbox", "blackbox-terminal", "gnome-terminal", "gnome-terminal-server", "ptyxis",
    "xfce4-terminal", "mate-terminal", "lxterminal", "qterminal", "sakura", "roxterm", "termite", "deepin-terminal", "hyper", "tabby", "contour",
    "ghostty", "rio", "zutty", "kmscon", "warp-terminal", "evilvte", "lilyterm", "pterm", "putty", "terminal", "x-terminal-emulator",
    "xdg-terminal", "xdg-terminal-exec",
  ],
  shells: /^(sh|bash|rbash|dash|zsh|ksh|ksh93|mksh|pdksh|oksh|ash|yash|csh|tcsh|fish|elvish|xonsh|nu|pwsh|busybox|toybox|screen|tmux|byobu)$/,
  interpreters: /^(python|pypy|perl|ruby|irb|node|nodejs|deno|bun|lua|luajit|php|tclsh|wish|guile|gjs|jshell|julia|rscript|expect|ipython|bpython|ptpython)[\d.]*$/i,
  shellModules: /^(idlelib(\..*)?|code|pdb|asyncio|ipython|jupyter.*|qtconsole|thonny|spyder.*|bpython|ptpython)$/i,
  shellApp: new RegExp("^(x?emacs(client)?|g?vimx?|evim|nvim(-qt)?|neovim(-qt)?|neovide|gnvim|idle|thonny|spyder|code(-insiders|-oss)?|codium|vscodium|visual-studio-code"
    + "|atom|pulsar|subl|sublime_text|sublimetext|sublime-text|kate|geany|gnome-builder|qtcreator|kdevelop|lazarus(-ide)?|monodevelop|netbeans|arduino(-?ide)?"
    + "|rstudio|octave(-gui|-cli)?|matlab|jupyter[\\w-]*|eclipse|idea|intellij[\\w-]*|pycharm|clion|goland|webstorm|rider|phpstorm|rubymine|datagrip|dataspell"
    + "|android-?studio|jetbrains[\\w-]*|fleet|zed|lapce|codeblocks|anjuta)"
    + "([-_]?\\d[\\w.]*|-(ce|community|professional|ultimate|edu|eap|nightly|preview|beta|stable|bin|gui|cli|qt|gtk\\d?|x11|nox|lucid|python[\\d.]*))*(\\.sh)?$"),
  shellAppId: /^(org\.gnome\.builder|com\.visualstudio\.code.*|com\.vscodium\.codium|org\.kde\.kate|cc\.arduino\..*|org\.qt-project\.qtcreator|com\.jetbrains\..*|com\.google\.androidstudio|org\.octave\.octave|org\.jupyter\..*)$/,
  shellAppName: /\b(x?emacs|g?vim|neovim|neovide|thonny|spyder|visual studio code|vs ?code|vscodium|code - oss|sublime text|kate|geany|gnome builder|qt ?creator|kdevelop|lazarus|monodevelop|netbeans|arduino|rstudio|octave|matlab|jupyter\w*|eclipse|intellij|jetbrains|pycharm|clion|goland|webstorm|phpstorm|rubymine|datagrip|dataspell|android studio|code::blocks|anjuta)\b/i,
  refused: /^(sudo|sudoedit|pkexec|su|doas|runuser|run0|sg|newgrp|systemd-run|machinectl|nsenter|unshare|ssh|mosh|telnet|rsh|rlogin|gksu|gksudo|kdesu|kdesudo|beesu|xdg-su|flatpak-spawn|toolbox|distrobox|gtk-launch|gio|gvfs-open|gnome-open|xdg-open|kde-open5?|kioclient5?|exo-open|dex|dbus-send|gdbus|busctl|qdbus(-qt\d)?|dbus-update-activation-environment|snap|xdotool|xte|ydotool)$/,
  launchers: /^(python[\d.]*|sh|bash|env|flatpak|java|perl|ruby|node|gjs|mono|gtk-launch)$/,
  name: /\b(terminal|console)\b/i,
};
const same = (a: RegExp, b: RegExp) => expect([a.source, a.flags]).toEqual([b.source, b.flags]);

describe("the Linux terminal vocabulary", () => {
  it("is the list hands/system.ts always had, moved verbatim", () => {
    expect([...TERMINALS.linux]).toEqual(FROZEN.terminals);
    same(SHELLS.linux, FROZEN.shells);
    same(INTERPRETERS.linux, FROZEN.interpreters);
    same(SHELL_MODULES.linux, FROZEN.shellModules);
    same(SHELL_APP.linux, FROZEN.shellApp);
    same(SHELL_APP_ID.linux, FROZEN.shellAppId);
    same(SHELL_APP_NAME.linux, FROZEN.shellAppName);
    same(REFUSED.linux, FROZEN.refused);
    same(LAUNCHERS.linux, FROZEN.launchers);
    same(TERMINAL_NAME.linux, FROZEN.name);
    expect(Object.keys(WRAPPERS.linux)).toEqual(["nohup", "setsid", "exec", "dbus-launch", "dbus-run-session", "nice", "ionice", "stdbuf", "timeout", "taskset",
      "chrt", "flock", "systemd-cat", "firejail", "torsocks", "proxychains", "proxychains4", "prime-run", "primusrun", "optirun", "vglrun", "gamemoderun", "mangohud"]);
    expect(WRAPPERS.linux.timeout).toEqual({ value: "ks", long: ["kill-after", "signal"], positional: 1 });
    expect(TERMINAL_CLASSES.linux).toEqual([]);
  });

  it("leaves the Windows and macOS rows to their own words (vocabulary-win32 and vocabulary-darwin test each row)", async () => {
    const real = await vi.importActual<typeof import("../../app/main/hands/terminals")>("../../app/main/hands/terminals");
    expect(real.TERMINALS.win32.has("cmd")).toBe(true);
    expect(real.TERMINALS.darwin.has("iterm2")).toBe(true);
    expect(real.TERMINAL_CLASSES.win32).toContain("ConsoleWindowClass");
    expect(real.TERMINAL_CLASSES.darwin).toEqual([]);
    for (const word of ["cmd", "iterm2", "windowsterminal"]) expect(real.TERMINALS.linux.has(word), word).toBe(false);
  });
});

describe("isTerminalApp and hasBuiltInShell on Linux", () => {
  it("keep today's answers when no OS is given", () => {
    expect(isTerminalApp({ id: "org.gnome.Terminal", name: "Terminal", exec: "gnome-terminal" })).toBe(true);
    expect(isTerminalApp({ id: "mousepad", name: "Mousepad", exec: "mousepad %U" })).toBe(false);
    expect(isTerminalApp({ id: "x", name: "X", exec: "env FOO=1 nice -n 5 xterm" })).toBe(true);
    expect(isTerminalApp({ id: "x", name: "X", exec: "sudo gedit" })).toBe(true);
    expect(isTerminalApp({ id: "x", name: "X", exec: "python3 -m idlelib" })).toBe(true);
    expect(hasBuiltInShell({ id: "emacs", name: "Emacs", exec: "emacs %F" })).toBe(true);
    expect(hasBuiltInShell({ id: "org.gnome.gedit", name: "Text Editor", exec: "gedit" })).toBe(false);
  });

  it("never reads a window class on Linux (its row is empty)", () => {
    expect(isTerminalApp({ id: "gedit", name: "gedit", windowClass: "ConsoleWindowClass" })).toBe(false);
    expect(isTerminalApp({ id: "gedit", name: "gedit", windowClass: "ConsoleWindowClass" }, "linux")).toBe(false);
  });

  it("reads Linux names as Linux names: no Windows extensions or id separators", () => {
    // "kitty.exe" is no Linux program name, and an id is split at dots only.
    expect(isTerminalApp({ id: "x", name: "X", exec: "/opt/kitty.exe" })).toBe(false);
    expect(isTerminalApp({ id: "com.example!kitty", name: "Example" })).toBe(false);
    expect(isTerminalApp({ id: "com.example.kitty", name: "Example" })).toBe(true);
  });

  it("prefers a catalogue's pre-split argv to the Exec line", () => {
    expect(isTerminalApp({ id: "x", name: "X", argv: ["/usr/bin/xterm"], exec: "mousepad" })).toBe(true);
    expect(isTerminalApp({ id: "x", name: "X", argv: ["/usr/bin/mousepad"], exec: "xterm" })).toBe(false);
  });
});

describe("isTerminalApp on Windows", () => {
  it("knows console hosts by their window class, whatever their program (case-insensitive, as Windows compares classes)", () => {
    expect(isTerminalApp({ id: "ping", name: "ping", windowClass: "ConsoleWindowClass" }, "win32")).toBe(true);
    expect(isTerminalApp({ id: "x", name: "x", windowClass: "cascadia_hosting_window_class" }, "win32")).toBe(true);
    expect(isTerminalApp({ id: "notepad", name: "notepad", windowClass: "Notepad" }, "win32")).toBe(false);
  });

  it("reads program paths with backslashes and without their extension", () => {
    expect(isTerminalApp({ id: "System Tools/Command Prompt", name: "Command Prompt", argv: ["C:\\Windows\\System32\\cmd.exe", "/k"] }, "win32")).toBe(true);
    expect(isTerminalApp({ id: "Accessories/Notepad", name: "Notepad", argv: ["C:\\Windows\\System32\\notepad.exe"] }, "win32")).toBe(false);
    expect(isTerminalApp({ id: "x", name: "Elevate", argv: ["C:\\Windows\\System32\\RUNAS.EXE", "/user:admin", "notepad"] }, "win32")).toBe(true);
    expect(isTerminalApp({ id: "x", name: "Script host", argv: ["C:\\Windows\\System32\\mshta.exe", "x.hta"] }, "win32")).toBe(true);
  });

  it("splits a packaged app's id at ! and _ (Microsoft.WindowsTerminal_8wekyb3d8bbwe!App)", () => {
    expect(isTerminalApp({ id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", name: "Windows Terminal" }, "win32")).toBe(true);
    expect(isTerminalApp({ id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", name: "Calculator" }, "win32")).toBe(false);
  });

  it("knows the names programs report (with or without .exe) and the name words of the OS's row", () => {
    expect(isTerminalApp({ id: "powershell.exe", name: "powershell.exe" }, "win32")).toBe(true);
    expect(isTerminalApp({ id: "x", name: "Developer PowerShell for VS 2022" }, "win32")).toBe(true);
    expect(hasBuiltInShell({ id: "Visual Studio 2022", name: "Visual Studio 2022", argv: ["C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe"] }, "win32")).toBe(true);
    expect(hasBuiltInShell({ id: "Notepad++", name: "Notepad++", argv: ["C:\\Program Files\\Notepad++\\notepad++.exe"] }, "win32")).toBe(true);
  });

  it("uses only that OS's words: a Linux terminal's name is no Windows terminal until the Windows row says so", () => {
    expect(isTerminalApp({ id: "x", name: "X", argv: ["C:\\tools\\xterm.exe"] }, "win32")).toBe(false);
    expect(isTerminalApp({ id: "x", name: "X", argv: ["C:\\tools\\cmd.exe"] }, "linux")).toBe(false);
  });
});

describe("isTerminalApp on macOS", () => {
  it("reads bundle ids and the OS's own names", () => {
    expect(isTerminalApp({ id: "com.apple.Terminal", name: "Terminal", argv: ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"] }, "darwin")).toBe(true);
    expect(hasBuiltInShell({ id: "com.apple.ScriptEditor2", name: "Script Editor" }, "darwin")).toBe(true);
    expect(isTerminalApp({ id: "com.apple.TextEdit", name: "TextEdit", argv: ["/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"] }, "darwin")).toBe(false);
    // A window class is a Windows idea: macOS's row is empty.
    expect(isTerminalApp({ id: "com.apple.TextEdit", name: "TextEdit", windowClass: "ConsoleWindowClass" }, "darwin")).toBe(false);
  });
});
