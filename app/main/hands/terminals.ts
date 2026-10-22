/**
 * What counts as a terminal, a command shell or an app with one built in, per OS: the word lists behind
 * hands/system.ts isTerminalApp() and hasBuiltInShell(). Ember never runs commands, so it never opens, or acts in,
 * anything these name. Data only, keyed by OS: the Linux rows are the lists hands/system.ts always had, moved here
 * verbatim, and must not change (tests pin them).
 *
 * The Windows and macOS rows (design §9.11) are matched on what those systems report: on Windows a program's file name,
 * lower case and without its extension ("cmd", "windowsterminal"), a Start Menu shortcut's target and a packaged app's
 * id (split at ".", "!" and "_"); on macOS a bundle's file name, executable and id ("com.apple.terminal") and the app's
 * name as the user's language shows it ("Terminal", "ターミナル"), which is why the macOS name rows carry Apple's
 * translations of the few apps that matter most. Each row also keeps the cross-platform programs of the Linux row that
 * exist there (Alacritty, WezTerm, VS Code, the JetBrains IDEs…). A word missing here is a terminal Ember could open,
 * so when in doubt a row errs towards refusing.
 */

import type { OS } from "../../shared/shortcuts";

/**
 * Whole words or phrases of any script, as regular-expression source: \b knows only ASCII letters, so it would never
 * see where "Terminál" or "Éditeur de script" ends (use with the "u" flag).
 */
const anyScriptWords = (alternatives: string) => String.raw`(?:^|[^\p{L}\p{N}])(?:${alternatives})(?=$|[^\p{L}\p{N}])`;

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
  win32: new Set([
    // Windows' own consoles and shells, and the console host and Windows Terminal that draw them.
    "cmd", "powershell", "pwsh", "pwsh-preview", "windowsterminal", "wt", "openconsole", "conhost",
    // WSL and the distributions' launchers (each opens a Linux shell).
    "wsl", "wslhost", "bash", "ubuntu", "ubuntu1804", "ubuntu2004", "ubuntu2204", "ubuntu2404", "debian", "kali",
    // Third-party terminals and SSH clients.
    "mintty", "git-bash", "git-cmd", "cmder", "conemu", "conemu64", "conemuc", "conemuc64", "fluentterminal", "mobaxterm", "securecrt",
    "xshell", "termius", "putty", "pterm", "kitty", "alacritty", "wezterm", "wezterm-gui", "hyper", "tabby", "warp", "rio", "contour", "terminal",
  ]),
  darwin: new Set([
    "terminal", "iterm", "iterm2", "warp", "xquartz", "x11", "xterm", "ghostty", "kitty", "alacritty", "wezterm", "wezterm-gui", "hyper", "tabby",
    "rio", "contour", "termius", "cool-retro-term",
  ]),
};

/** Command shells and terminal multiplexers: given no script, they wait for typed commands. */
export const SHELLS: Readonly<Record<OS, RegExp>> = {
  linux: /^(sh|bash|rbash|dash|zsh|ksh|ksh93|mksh|pdksh|oksh|ash|yash|csh|tcsh|fish|elvish|xonsh|nu|pwsh|busybox|toybox|screen|tmux|byobu)$/,
  // Git for Windows, MSYS2 and Cygwin bring the POSIX shells along.
  win32: /^(cmd|powershell|pwsh|sh|bash|dash|zsh|ksh|mksh|ash|csh|tcsh|fish|elvish|xonsh|nu|busybox|screen|tmux)$/,
  darwin: /^(sh|bash|dash|zsh|ksh|ksh93|mksh|ash|csh|tcsh|fish|elvish|xonsh|nu|pwsh|busybox|screen|tmux|byobu)$/,
};

/** Interpreters: with -c/-e they run the code given to them; alone, they wait for typed code. */
export const INTERPRETERS: Readonly<Record<OS, RegExp>> = {
  linux: /^(python|pypy|perl|ruby|irb|node|nodejs|deno|bun|lua|luajit|php|tclsh|wish|guile|gjs|jshell|julia|rscript|expect|ipython|bpython|ptpython)[\d.]*$/i,
  // Plus the windowless and launcher variants Windows installs (pythonw, py, rubyw, php-win).
  win32: /^(python|pythonw|py|pyw|pypy|perl|wperl|ruby|rubyw|irb|node|nodejs|deno|bun|lua|luajit|php|php-win|tclsh|wish|guile|jshell|julia|rscript|expect|ipython|bpython|ptpython)[\d.]*$/i,
  darwin: /^(python|pypy|perl|ruby|irb|node|nodejs|deno|bun|lua|luajit|php|tclsh|wish|guile|jshell|julia|rscript|expect|ipython|bpython|ptpython)[\d.]*$/i,
};

/** Python modules that are an interactive shell or an IDE (python -m idlelib). */
export const SHELL_MODULES: Readonly<Record<OS, RegExp>> = {
  linux: /^(idlelib(\..*)?|code|pdb|asyncio|ipython|jupyter.*|qtconsole|thonny|spyder.*|bpython|ptpython)$/i,
  win32: /^(idlelib(\..*)?|code|pdb|asyncio|ipython|jupyter.*|qtconsole|thonny|spyder.*|bpython|ptpython)$/i,
  darwin: /^(idlelib(\..*)?|code|pdb|asyncio|ipython|jupyter.*|qtconsole|thonny|spyder.*|bpython|ptpython)$/i,
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
  // Windows: Visual Studio, the PowerShell ISE, Notepad++ (Run › Run… starts any command line), the AI editors, the
  // JetBrains launchers (pycharm64…), and the command surfaces: Start and Search (a name typed there, then Enter, starts
  // it), Task Manager's "Run new task" and PowerToys Run.
  win32: new RegExp("^(x?emacs(client)?w?|runemacs|g?vimx?|nvim(-qt)?|neovim(-qt)?|neovide|idle|thonny|spyder|code(-insiders| - insiders)?|codium|vscodium"
    + "|cursor|windsurf|devenv|powershell_ise|notepad\\+\\+|atom|pulsar|subl|sublime_text|kate|geany|qtcreator|lazarus(-ide)?|netbeans(64)?|arduino( ide)?"
    + "|rstudio|octave(-gui|-cli)?|matlab|jupyter[\\w-]*|eclipse|idea|intellij[\\w-]*|pycharm|clion|goland|webstorm|rider|phpstorm|rubymine|datagrip|dataspell"
    + "|studio64|android-?studio|fleet|zed|lapce|codeblocks"
    + "|searchhost|searchapp|searchui|startmenuexperiencehost|taskmgr|powertoys\\.powerlauncher)"
    // The 64-bit launchers' suffix and versions (pycharm64, idea64, emacs-29.1), and IDLE run as idle.pyw.
    + "(64|[-_]?\\d[\\w.]*)?(\\.pyw?)?$"),
  // macOS: Xcode, the programmers' editors, the AI editors, and the automation apps whose documents run shell scripts
  // (Script Editor, Automator, Shortcuts), plus the launchers that run commands typed into them (Spotlight, Raycast, Alfred).
  darwin: new RegExp("^(xcode|bbedit|textmate|nova|macvim|mvim|script ?editor\\d*|automator|shortcuts|spotlight|raycast|alfred|cursor|windsurf"
    + "|x?emacs(client)?|g?vimx?|nvim|neovide|idle|thonny|spyder|code|code - insiders|codium|vscodium|visual studio code|sublime_text|sublime text|subl"
    + "|kate|geany|qtcreator|qt creator|netbeans|arduino( ide)?|rstudio|octave(-gui)?|matlab|jupyter[\\w-]*|eclipse|idea|intellij[\\w-]*|pycharm|clion"
    + "|goland|webstorm|rider|phpstorm|rubymine|datagrip|dataspell|android studio|fleet|zed|lapce|codeblocks)"
    + "([-_ ]?\\d[\\w.]*|-(ce|community|professional|ultimate|edu|eap|preview|beta))*$"),
};

/** Desktop ids (reverse DNS, lower case) of apps with a shell built in. */
export const SHELL_APP_ID: Readonly<Record<OS, RegExp>> = {
  linux: /^(org\.gnome\.builder|com\.visualstudio\.code.*|com\.vscodium\.codium|org\.kde\.kate|cc\.arduino\..*|org\.qt-project\.qtcreator|com\.jetbrains\..*|com\.google\.androidstudio|org\.octave\.octave|org\.jupyter\..*)$/,
  // Packaged apps' ids (Windows Terminal, PowerShell, the WSL distributions, VS Code from the Store).
  win32: /^(microsoft\.windowsterminal.*|microsoft\.powershell.*|canonicalgroup.*ubuntu.*|thedebianproject\..*|kalilinux\..*|microsoftcorporationii\.windowssubsystemforlinux.*|microsoft\.visualstudiocode.*|microsoft\.vscode.*)$/,
  // Bundle ids of the terminals and of the apps above (Automator's own applets are com.apple.automator.<name>).
  darwin: new RegExp("^(com\\.apple\\.terminal|com\\.googlecode\\.iterm2|dev\\.warp\\..*|org\\.xquartz\\..*|org\\.macosforge\\.xquartz\\..*|com\\.mitchellh\\.ghostty"
    + "|net\\.kovidgoyal\\.kitty|org\\.alacritty|com\\.github\\.wez\\.wezterm|co\\.zeit\\.hyper|org\\.tabby|com\\.raphaelamorim\\.rio"
    + "|com\\.apple\\.scripteditor\\d*|com\\.apple\\.automator.*|com\\.apple\\.shortcuts.*|com\\.apple\\.dt\\.xcode|com\\.apple\\.spotlight"
    + "|com\\.microsoft\\.vscode.*|com\\.visualstudio\\.code.*|com\\.vscodium.*|com\\.barebones\\.bbedit|com\\.macromates\\.textmate.*|com\\.panic\\.nova"
    + "|org\\.vim\\.macvim|org\\.gnu\\.emacs|com\\.google\\.android\\.studio.*|com\\.jetbrains\\..*|com\\.sublimetext\\..*|dev\\.zed\\.zed.*"
    + "|com\\.exafunction\\.windsurf|com\\.todesktop\\.230313mzl4w4u92|com\\.raycast\\.macos|com\\.runningwithcrayons\\.alfred.*)$"),
};

/** App names (as people read them) of apps with a shell built in. */
export const SHELL_APP_NAME: Readonly<Record<OS, RegExp>> = {
  linux: /\b(x?emacs|g?vim|neovim|neovide|thonny|spyder|visual studio code|vs ?code|vscodium|code - oss|sublime text|kate|geany|gnome builder|qt ?creator|kdevelop|lazarus|monodevelop|netbeans|arduino|rstudio|octave|matlab|jupyter\w*|eclipse|intellij|jetbrains|pycharm|clion|goland|webstorm|phpstorm|rubymine|datagrip|dataspell|android studio|code::blocks|anjuta)\b/i,
  // Notepad++ stands outside the word boundaries: "+" isn't a word character.
  win32: new RegExp(String.raw`\b(x?emacs|g?vim|neovim|neovide|thonny|spyder|visual studio code|vs ?code|vscodium|sublime text|kate|geany|qt ?creator|lazarus|netbeans`
    + String.raw`|arduino|rstudio|octave|matlab|jupyter\w*|eclipse|intellij|jetbrains|pycharm|clion|goland|webstorm|phpstorm|rubymine|datagrip|dataspell`
    + String.raw`|android studio|code::blocks|windows powershell ise|visual studio(?! code)|cursor|windsurf|task manager|powertoys run`
    + String.raw`|microsoft visual basic for applications)\b|notepad\+\+`, "i"),
  // With Apple's translations of Script Editor and Shortcuts (the app names macOS reports are the user's language's).
  darwin: new RegExp(String.raw`\b(x?emacs|g?vim|neovim|neovide|thonny|spyder|visual studio code|vs ?code|vscodium|sublime text|kate|geany|qt ?creator`
    + String.raw`|netbeans|arduino|rstudio|octave|matlab|jupyter\w*|eclipse|intellij|jetbrains|pycharm|clion|goland|webstorm|phpstorm|rubymine|datagrip`
    + String.raw`|dataspell|android studio|code::blocks|xcode|bbedit|textmate|nova|macvim|script editor|automator|shortcuts|spotlight|raycast|alfred|cursor`
    + String.raw`|windsurf)\b|` + anyScriptWords("skripteditor|kurzbefehle|raccourcis|atajos|comandi rapidi|editor de scripts|éditeur de script")
    + "|スクリプトエディタ|ショートカット|脚本编辑器|快捷指令|工序指令編寫程式|捷徑|스크립트 편집기|단축어", "iu"),
};

/** An app name that says it is a terminal or console, whatever its program. */
export const TERMINAL_NAME: Readonly<Record<OS, RegExp>> = {
  linux: /\b(terminal|console)\b/i,
  // Windows: the consoles' own names and the shortcuts that open one (Developer Command Prompt, Anaconda Prompt…).
  win32: /\b(terminal|console|command prompt|powershell|git bash|developer (command prompt|powershell)|(anaconda|miniconda|miniforge|mambaforge) (powershell )?prompt)\b/i,
  // macOS: Terminal as the user's language names it, and iTerm. Not "console": the Mac's Console is its log viewer.
  darwin: new RegExp(anyScriptWords("terminal[ei]?|iterm2?|terminál|τερματικό|pääte|терминал|термінал|מסוף") + "|ターミナル|终端|終端機|터미널|เทอร์มินัล", "iu"),
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
  // explorer.exe starts whatever program it is given (a shortcut to explorer.exe with cmd.exe's path is a terminal);
  // with a folder or nothing it is File Explorer, which this reads as no command.
  win32: { explorer: {} },
  darwin: {
    nohup: {}, nice: { value: "n", long: ["adjustment"] }, caffeinate: { value: "tw" },
    timeout: { value: "ks", long: ["kill-after", "signal"], positional: 1 }, gtimeout: { value: "ks", long: ["kill-after", "signal"], positional: 1 },
    stdbuf: { value: "ioe", long: ["input", "output", "error"] }, gstdbuf: { value: "ioe", long: ["input", "output", "error"] },
  },
};

/**
 * Programs that run commands Ember can't follow, or as someone else: never started. (systemd-run
 * runs it inside the user's own session, sudo and friends as another user, the launchers start
 * another desktop entry, URL or D-Bus service.)
 */
export const REFUSED: Readonly<Record<OS, RegExp>> = {
  linux: /^(sudo|sudoedit|pkexec|su|doas|runuser|run0|sg|newgrp|systemd-run|machinectl|nsenter|unshare|ssh|mosh|telnet|rsh|rlogin|gksu|gksudo|kdesu|kdesudo|beesu|xdg-su|flatpak-spawn|toolbox|distrobox|gtk-launch|gio|gvfs-open|gnome-open|xdg-open|kde-open5?|kioclient5?|exo-open|dex|dbus-send|gdbus|busctl|qdbus(-qt\d)?|dbus-update-activation-environment|snap|xdotool|xte|ydotool)$/,
  // Windows: running as someone else (runas, sudo, psexec), remote shells, and the system programs that run a script,
  // an installer or a scheduled command they are handed (mshta, regsvr32, msiexec, schtasks, msdt, wslg…).
  win32: new RegExp("^(runas|sudo|gsudo|psexec(64)?|ssh|telnet|winrs|mshta|wscript|cscript|regsvr32|msiexec|cmstp|installutil|regasm|regsvcs|msbuild"
    + "|forfiles|pcalua|scriptrunner|syncappvpublishingserver|msdt|wslg|schtasks|at|sc|reg|bitsadmin|certutil|wmic)$"),
  // macOS: running as someone else, remote shells, AppleScript, and what opens or schedules another program.
  darwin: /^(sudo|sudoedit|su|doas|login|ssh|mosh|telnet|rsh|rlogin|osascript|open|launchctl|automator|shortcuts|sandbox-exec|arch)$/,
};

/** Interpreters and launchers: an app started through one isn't known by their name (hands/system.ts programsOf). */
export const LAUNCHERS: Readonly<Record<OS, RegExp>> = {
  linux: /^(python[\d.]*|sh|bash|env|flatpak|java|perl|ruby|node|gjs|mono|gtk-launch)$/,
  // Never explorer: File Explorer's windows belong to explorer.exe.
  win32: /^(rundll32|dllhost|applicationframehost|javaw|pythonw|py|wscript|cscript|msiexec)$/,
  darwin: /^(open|osascript|java)$/,
};

/**
 * Window classes of console hosts (Windows: conhost's ConsoleWindowClass, Windows Terminal's
 * CASCADIA_HOSTING_WINDOW_CLASS…), which isTerminalApp checks when a window's class is known: a console
 * window's program can be any command-line tool. Compared without regard to case, as Windows registers them.
 * Linux and macOS have no such class: their rows stay empty.
 */
export const TERMINAL_CLASSES: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  // conhost, Windows Terminal, the pseudo-console, mintty (Git Bash, MSYS2, Cygwin), PuTTY and ConEmu.
  win32: ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow", "mintty", "PuTTY", "VirtualConsoleClass"],
  darwin: [],
};

/**
 * Words that make a desktop or bundle id a terminal's however its app is named (GNOME's Console is org.gnome.Console).
 * Not on macOS, where com.apple.Console is the log viewer. hands/system.ts's idIsTerminal still tests "console" on every
 * OS: until it reads this row, the Mac's Console is refused as a terminal there too (a harmless refusal).
 */
export const TERMINAL_ID_WORDS: Readonly<Record<OS, readonly string[]>> = {
  linux: ["console"],
  win32: ["console"],
  darwin: [],
};
