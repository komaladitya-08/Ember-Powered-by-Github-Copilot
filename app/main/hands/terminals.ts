/**
 * What counts as a terminal, a command shell or an app with one built in, per OS: the word lists behind
 * hands/system.ts isTerminalApp() and hasBuiltInShell(). Ember never runs commands, so it never opens, or acts in,
 * anything these name. Data only, keyed by OS: the Linux rows are the lists hands/system.ts always had, moved here
 * verbatim; the Windows and macOS rows are filled by their own package (design §9.11) and match nothing until then
 * (Ember isn't switched on there before they are).
 */

import type { OS } from "../../shared/shortcuts";

/** Matches nothing: a row that hasn't been filled yet. */
const NONE = /(?!)/;

/** How a wrapper program (nice, timeout, env…) is read to find the command it starts. */
export interface WrapperRule {
  /** Short options that take a value (the rest of the word, or the next word). */
  value?: string;
  /** Long options that take a value (the next word, unless given as --name=value). */
  long?: string[];
  /** Positional arguments before the command (timeout's duration). */
  positional?: number;
  /** An option that means "no command follows" (ionice -p: it changes a running process). */
  noCommand?: RegExp;
}

/** Terminal emulators, by program name or desktop id (lower case). */
export const TERMINALS: Readonly<Record<OS, ReadonlySet<string>>> = {
  linux: new Set([
    "xterm", "uxterm", "lxterm", "koi8rxterm", "urxvt", "urxvtc", "urxvtd", "rxvt", "rxvt-unicode", "aterm", "eterm", "mlterm", "st", "stterm", "xvt",
    "wezterm", "wezterm-gui", "foot", "footclient", "kitty", "alacritty", "terminator", "tilix", "terminix", "konsole", "yakuake", "guake", "tilda",
    "terminology", "cool-retro-term", "kgx", "gnome-console", "blackbox", "blackbox-terminal", "gnome-terminal", "gnome-terminal-server", "ptyxis",
    "xfce4-terminal", "mate-terminal", "lxterminal", "qterminal", "sakura", "roxterm", "termite", "deepin-terminal", "hyper", "tabby", "contour",
    "ghostty", "rio", "zutty", "kmscon", "warp-terminal", "evilvte", "lilyterm", "pterm", "putty", "terminal", "x-terminal-emulator",
    "xdg-terminal", "xdg-terminal-exec",
  ]),
  win32: new Set(),
  darwin: new Set(),
};

/** Command shells and terminal multiplexers: given no script, they wait for typed commands. */
export const SHELLS: Readonly<Record<OS, RegExp>> = {
  linux: /^(sh|bash|rbash|dash|zsh|ksh|ksh93|mksh|pdksh|oksh|ash|yash|csh|tcsh|fish|elvish|xonsh|nu|pwsh|busybox|toybox|screen|tmux|byobu)$/,
  win32: NONE,
  darwin: NONE,
};

/** Interpreters: with -c/-e they run the code given to them; alone, they wait for typed code. */
export const INTERPRETERS: Readonly<Record<OS, RegExp>> = {
  linux: /^(python|pypy|perl|ruby|irb|node|nodejs|deno|bun|lua|luajit|php|tclsh|wish|guile|gjs|jshell|julia|rscript|expect|ipython|bpython|ptpython)[\d.]*$/i,
  win32: NONE,
  darwin: NONE,
};

/** Python modules that are an interactive shell or an IDE (python -m idlelib). */
export const SHELL_MODULES: Readonly<Record<OS, RegExp>> = {
  linux: /^(idlelib(\..*)?|code|pdb|asyncio|ipython|jupyter.*|qtconsole|thonny|spyder.*|bpython|ptpython)$/i,
  win32: NONE,
  darwin: NONE,
};

/**
 * Apps with a terminal or shell built in (IDEs, programmers' editors, REPLs): whatever is typed into
 * them can run as a command (Emacs' M-x shell, Vim's :!, IDLE, an IDE's terminal panel). Program
 * names or desktop-id parts, with any version after them.
 */
export const SHELL_APP: Readonly<Record<OS, RegExp>> = {
  linux: new RegExp("^(x?emacs(client)?|g?vimx?|evim|nvim(-qt)?|neovim(-qt)?|neovide|gnvim|idle|thonny|spyder|code(-insiders|-oss)?|codium|vscodium|visual-studio-code"
    + "|atom|pulsar|subl|sublime_text|sublimetext|sublime-text|kate|geany|gnome-builder|qtcreator|kdevelop|lazarus(-ide)?|monodevelop|netbeans|arduino(-?ide)?"
    + "|rstudio|octave(-gui|-cli)?|matlab|jupyter[\\w-]*|eclipse|idea|intellij[\\w-]*|pycharm|clion|goland|webstorm|rider|phpstorm|rubymine|datagrip|dataspell"
    + "|android-?studio|jetbrains[\\w-]*|fleet|zed|lapce|codeblocks|anjuta)"
    // Versions and editions after the name (emacs-26.1, idle3, idle-python3.6, pycharm-community, idea.sh).
    + "([-_]?\\d[\\w.]*|-(ce|community|professional|ultimate|edu|eap|nightly|preview|beta|stable|bin|gui|cli|qt|gtk\\d?|x11|nox|lucid|python[\\d.]*))*(\\.sh)?$"),
  win32: NONE,
  darwin: NONE,
};

/** Desktop ids (reverse DNS, lower case) of apps with a shell built in. */
export const SHELL_APP_ID: Readonly<Record<OS, RegExp>> = {
  linux: /^(org\.gnome\.builder|com\.visualstudio\.code.*|com\.vscodium\.codium|org\.kde\.kate|cc\.arduino\..*|org\.qt-project\.qtcreator|com\.jetbrains\..*|com\.google\.androidstudio|org\.octave\.octave|org\.jupyter\..*)$/,
  win32: NONE,
  darwin: NONE,
};

/** App names (as people read them) of apps with a shell built in. */
export const SHELL_APP_NAME: Readonly<Record<OS, RegExp>> = {
  linux: /\b(x?emacs|g?vim|neovim|neovide|thonny|spyder|visual studio code|vs ?code|vscodium|code - oss|sublime text|kate|geany|gnome builder|qt ?creator|kdevelop|lazarus|monodevelop|netbeans|arduino|rstudio|octave|matlab|jupyter\w*|eclipse|intellij|jetbrains|pycharm|clion|goland|webstorm|phpstorm|rubymine|datagrip|dataspell|android studio|code::blocks|anjuta)\b/i,
  win32: NONE,
  darwin: NONE,
};

/** An app name that says it is a terminal or console, whatever its program. */
export const TERMINAL_NAME: Readonly<Record<OS, RegExp>> = {
  linux: /\b(terminal|console)\b/i,
  win32: NONE,
  darwin: NONE,
};

/** Programs that start the next word as the real command (after their own options). */
export const WRAPPERS: Readonly<Record<OS, Readonly<Record<string, WrapperRule>>>> = {
  linux: {
    nohup: {}, setsid: {}, exec: { value: "a" }, "dbus-launch": { long: ["autolaunch", "config-file"] }, "dbus-run-session": { long: ["config-file", "dbus-daemon"] },
    nice: { value: "n", long: ["adjustment"] },
    ionice: { value: "cnpPu", long: ["class", "classdata", "pid", "pgid", "uid"], noCommand: /^-([a-z]*[pPu]|-pid|-pgid|-uid)/ },
    stdbuf: { value: "ioe", long: ["input", "output", "error"] },
    timeout: { value: "ks", long: ["kill-after", "signal"], positional: 1 },
    taskset: { positional: 1, noCommand: /^-([a-z]*p|-pid)/ },
    chrt: { value: "TPD", long: ["sched-runtime", "sched-period", "sched-deadline"], positional: 1, noCommand: /^-([a-z]*[pm]|-pid|-max)/ },
    flock: { value: "Ew", long: ["conflict-exit-code", "timeout", "wait"], positional: 1 },
    "systemd-cat": { value: "tp", long: ["identifier", "priority", "stderr-priority", "level-prefix"] },
    firejail: {}, torsocks: {}, proxychains: {}, proxychains4: {}, "prime-run": {}, primusrun: {}, optirun: {}, vglrun: { value: "dc" }, gamemoderun: {}, mangohud: {},
    // (Not xdg-terminal-exec: it always opens a terminal, whatever it runs in it, so it is a terminal itself.)
  },
  win32: {},
  darwin: {},
};

/**
 * Programs that run commands Ember can't follow, or as someone else: never started. (systemd-run
 * runs it inside the user's own session, sudo and friends as another user, the launchers start
 * another desktop entry, URL or D-Bus service.)
 */
export const REFUSED: Readonly<Record<OS, RegExp>> = {
  linux: /^(sudo|sudoedit|pkexec|su|doas|runuser|run0|sg|newgrp|systemd-run|machinectl|nsenter|unshare|ssh|mosh|telnet|rsh|rlogin|gksu|gksudo|kdesu|kdesudo|beesu|xdg-su|flatpak-spawn|toolbox|distrobox|gtk-launch|gio|gvfs-open|gnome-open|xdg-open|kde-open5?|kioclient5?|exo-open|dex|dbus-send|gdbus|busctl|qdbus(-qt\d)?|dbus-update-activation-environment|snap|xdotool|xte|ydotool)$/,
  win32: NONE,
  darwin: NONE,
};

/** Interpreters and launchers: an app started through one isn't known by their name (hands/system.ts programsOf). */
export const LAUNCHERS: Readonly<Record<OS, RegExp>> = {
  linux: /^(python[\d.]*|sh|bash|env|flatpak|java|perl|ruby|node|gjs|mono|gtk-launch)$/,
  win32: NONE,
  darwin: NONE,
};

/**
 * Window classes of console hosts (Windows: conhost's ConsoleWindowClass, Windows Terminal's
 * CASCADIA_HOSTING_WINDOW_CLASS…), which isTerminalApp checks when a window's class is known: a console
 * window's program can be any command-line tool. Compared without regard to case, as Windows registers them.
 * Linux and macOS have no such class: their rows stay empty.
 */
export const TERMINAL_CLASSES: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  win32: [],
  darwin: [],
};
