/**
 * The classifier's tables as data (design §3.5, §3.4.5, §3.4.8): the global-option grammars that find a tool's verb,
 * the wrappers that run another command, the programs that run code, fetch, launch, open full-screen or GUI windows,
 * synthesise input, read secrets, and the per-verb rows of the package, service, cloud and source-control tools.
 * classify.ts holds the logic that reads them. A program that is in no row is ordinary (D4.2) unless one of §3.4's or
 * §3.6's rules applies. Pure data.
 */

import type { DangerClass } from "./types";

/** A global-option grammar: the options a verb-keyed tool accepts before its verb (§3.4.8). */
export interface GlobalGrammar {
  /** Options without a value (as written, with dashes). */
  flags: readonly string[];
  /** Options that take a value (`-C dir`, `--prefix=x`). */
  withValue: readonly string[];
  /** Options that point the tool at another computer (class b on their own), unless the value is local. */
  hostPointing?: readonly string[];
  /** Short single-letter options may be clustered (`-qv`). */
  cluster?: boolean;
}

/** §3.4.8: every verb-keyed program's options before its verb. An option before the verb not listed → unclear. */
export const GLOBAL_OPTIONS: Readonly<Record<string, GlobalGrammar>> = {
  git: {
    flags: ["--version", "--help", "-h", "-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--bare", "--literal-pathspecs",
      "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice",
      "--exec-path", "--html-path", "--man-path", "--info-path"],
    withValue: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--list-cmds", "--attr-source", "--exec-path"],
  },
  gh: { flags: ["--help", "-h", "--version"], withValue: ["-R", "--repo", "--hostname"] },
  npm: {
    flags: ["-g", "--global", "-s", "--silent", "-q", "--quiet", "-d", "-dd", "-ddd", "--verbose", "-y", "--yes", "--no", "--json",
      "--offline", "--prefer-offline", "--prefer-online", "--no-audit", "--no-fund", "--ignore-scripts", "--dry-run", "-l", "--long",
      "--force", "-f", "--legacy-peer-deps", "--strict-peer-deps", "--production", "--no-save", "-D", "--save-dev", "-E", "--save-exact",
      "-ws", "--workspaces", "--include-workspace-root", "--no-progress", "--color", "--no-color", "-v", "--version", "-h", "--help", "--foreground-scripts"],
    withValue: ["--prefix", "-C", "--loglevel", "-w", "--workspace", "--registry", "--userconfig", "--globalconfig", "--cache", "--tag",
      "--otp", "--scope", "--access", "--omit", "--include", "--install-strategy", "--before", "--location"],
  },
  pnpm: {
    flags: ["-r", "--recursive", "-w", "--workspace-root", "-s", "--silent", "--reporter=silent", "--frozen-lockfile", "-g", "--global",
      "--offline", "--prefer-offline", "-v", "--version", "-h", "--help", "--color", "--no-color", "--aggregate-output", "--shamefully-hoist"],
    withValue: ["-C", "--dir", "--filter", "-F", "--reporter", "--loglevel", "--workspace-concurrency", "--registry", "--store-dir"],
  },
  yarn: {
    flags: ["-s", "--silent", "--verbose", "--offline", "--frozen-lockfile", "--immutable", "--non-interactive", "--no-progress", "-v",
      "--version", "-h", "--help", "-W", "--ignore-workspace-root-check"],
    withValue: ["--cwd", "--modules-folder", "--cache-folder", "--registry", "--mutex"],
  },
  docker: {
    flags: ["-D", "--debug", "--tls", "--tlsverify", "-v", "--version", "--help"],
    withValue: ["--config", "-c", "--context", "-H", "--host", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
    hostPointing: ["-H", "--host", "-c", "--context"],
  },
  podman: {
    flags: ["--remote", "-r", "--debug", "-v", "--version", "--help", "--syslog"],
    withValue: ["--connection", "-c", "--url", "--identity", "--log-level", "--root", "--runroot", "--storage-driver", "--cgroup-manager",
      "--events-backend", "--hooks-dir", "--module", "--network-config-dir", "--runtime", "--tmpdir"],
    hostPointing: ["--remote", "-r", "--connection", "-c", "--url"],
  },
  kubectl: {
    flags: ["--insecure-skip-tls-verify", "--warnings-as-errors", "--match-server-version", "--disable-compression", "--help", "-h"],
    withValue: ["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--token", "--as", "--as-group",
      "--as-uid", "--request-timeout", "--cache-dir", "--certificate-authority", "--client-certificate", "--client-key",
      "--tls-server-name", "-v", "--v", "--log-file", "--username", "--password", "--profile", "--profile-output"],
    hostPointing: ["-s", "--server"],
  },
  helm: {
    flags: ["--debug", "-h", "--help"],
    withValue: ["-n", "--namespace", "--kube-context", "--kubeconfig", "--kube-apiserver", "--kube-token", "--kube-as-user", "--kube-as-group",
      "--kube-ca-file", "--registry-config", "--repository-cache", "--repository-config", "--burst-limit", "--qps"],
    hostPointing: ["--kube-apiserver"],
  },
  terraform: { flags: ["-help", "-version", "--help", "--version"], withValue: ["-chdir"] },
  aws: {
    flags: ["--debug", "--no-verify-ssl", "--no-paginate", "--no-sign-request", "--no-cli-pager", "--no-cli-auto-prompt", "--version", "help"],
    withValue: ["--profile", "--region", "--output", "--endpoint-url", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--color", "--cli-binary-format"],
  },
  az: { flags: ["--debug", "--verbose", "--only-show-errors", "-h", "--help", "--version"], withValue: ["-o", "--output", "--query", "--subscription"] },
  gcloud: {
    flags: ["--quiet", "-q", "--verbosity=debug", "--log-http", "--user-output-enabled", "--no-user-output-enabled", "-h", "--help", "--version"],
    withValue: ["--project", "--account", "--configuration", "--format", "--verbosity", "--impersonate-service-account", "--billing-project", "--flags-file", "--trace-token"],
  },
  p4: {
    flags: ["-s", "-G", "-b", "-I", "-V", "-ztag", "-h"],
    withValue: ["-c", "-C", "-d", "-H", "-p", "-P", "-q", "-u", "-x", "-r", "-z", "-L", "-Q"],
    hostPointing: [],
  },
  svn: {
    flags: ["--non-interactive", "--trust-server-cert", "--quiet", "-q", "--version", "--help", "-h", "--force-interactive", "--no-auth-cache"],
    withValue: ["--username", "--password", "--config-dir", "--config-option"],
  },
  hg: {
    flags: ["-q", "--quiet", "-v", "--verbose", "-y", "--noninteractive", "--debug", "--traceback", "--time", "--profile", "--version", "-h", "--help", "--hidden"],
    withValue: ["-R", "--repository", "--cwd", "--config", "--encoding", "--encodingmode", "--color", "--pager"],
  },
  cargo: {
    flags: ["-v", "-vv", "--verbose", "-q", "--quiet", "--frozen", "--locked", "--offline", "-V", "--version", "-h", "--help", "--list"],
    withValue: ["--color", "-C", "-Z", "--config", "--explain"],
  },
  dotnet: { flags: ["--info", "--version", "--list-sdks", "--list-runtimes", "-d", "--diagnostics", "-h", "--help"], withValue: [] },
  pip: {
    flags: ["-v", "--verbose", "-q", "--quiet", "--isolated", "--no-input", "--disable-pip-version-check", "--no-color", "--no-cache-dir",
      "--require-virtualenv", "--python-version", "-V", "--version", "-h", "--help", "--user"],
    withValue: ["--log", "--proxy", "--retries", "--timeout", "--exists-action", "--trusted-host", "--cert", "--client-cert", "--cache-dir", "--python", "--index-url", "-i"],
  },
  apt: { flags: ["-y", "--yes", "--assume-yes", "-q", "-qq", "--quiet", "-s", "--simulate", "--no-install-recommends", "-f", "--fix-broken", "-h", "--help", "-v", "--version"], withValue: ["-o", "-c", "-t", "--target-release"] },
  dnf: {
    flags: ["-y", "--assumeyes", "-q", "--quiet", "-v", "--verbose", "-C", "--cacheonly", "--refresh", "--nogpgcheck", "-h", "--help", "--version", "--best", "--nobest", "--allowerasing", "--skip-broken"],
    withValue: ["-c", "--config", "--enablerepo", "--disablerepo", "--repo", "--releasever", "--installroot", "-x", "--exclude", "--setopt"],
  },
  brew: { flags: ["-v", "--verbose", "-d", "--debug", "-q", "--quiet", "-h", "--help", "--version"], withValue: [] },
  winget: { flags: ["--help", "-?", "--version", "-v", "--info", "--disable-interactivity"], withValue: [] },
  systemctl: {
    flags: ["--user", "--system", "--global", "-q", "--quiet", "--no-block", "--no-pager", "--no-legend", "--now", "-a", "--all", "-l", "--full",
      "-f", "--force", "--runtime", "--failed", "-r", "--recursive", "--plain", "--wait", "-h", "--help", "--version", "--no-ask-password"],
    withValue: ["-t", "--type", "--state", "-p", "--property", "-H", "--host", "-M", "--machine", "-n", "--lines", "-o", "--output", "--signal", "-s", "--root", "--kill-whom", "--job-mode"],
    hostPointing: ["-H", "--host"],
  },
  launchctl: { flags: ["-h", "help"], withValue: [] },
  wsl: { flags: [], withValue: [] },
};

/** git's code-running settings (§3.4.8, critique security-2): `-c` with one of these → unclear; `git config` writing one → system. */
export const GIT_CODE_KEYS: readonly RegExp[] = [
  /^alias\./i, /^core\.sshcommand$/i, /^core\.pager$/i, /^pager\./i, /^core\.editor$/i, /^sequence\.editor$/i, /^core\.hookspath$/i,
  /^core\.fsmonitor$/i, /^core\.askpass$/i, /^core\.gitproxy$/i, /^diff\.external$/i, /^diff\..+\.textconv$/i, /^diff\..+\.command$/i,
  /^merge\..+\.driver$/i, /^filter\..+\.(clean|smudge|process)$/i, /^credential\.helper$/i, /^credential\..+\.helper$/i,
  /\.sshcommand$/i, /^protocol\..+\.allow$/i, /^protocol\.allow$/i, /^uploadpack\.packobjectshook$/i, /^gpg\.program$/i,
  /^gpg\..+\.program$/i, /^remote\..+\.(receivepack|uploadpack)$/i, /^include\.path$/i, /^includeif\..+\.path$/i, /\.command$/i,
  /^core\.worktree$/i, /^init\.templatedir$/i, /^url\..+\.(push)?insteadof$/i, /^http\..*proxy$/i,
  /^difftool\..+\.cmd$/i, /^mergetool\..+\.cmd$/i, /^sendemail\..*(smtpserver|tocmd|cccmd)$/i, /^receive\.procreceiverefs$/i,
];

/** Variables that change how commands are found or run (§3.4.1): setting one in a command → unclear. */
export const RISKY_ASSIGNMENTS = new Set([
  "IFS", "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "GIT_SSH_COMMAND", "GIT_SSH",
  "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_EXEC_PATH", "PAGER", "EDITOR", "VISUAL", "SSH_ASKPASS",
  "SUDO_ASKPASS", "PYTHONSTARTUP", "PYTHONPATH", "NODE_OPTIONS", "PERL5OPT", "RUBYOPT", "DOCKER_HOST", "KUBECONFIG", "PSModulePath",
  "SHELLOPTS", "BASHOPTS", "CDPATH", "FPATH", "PYTHONHOME", "PERL5LIB", "RUBYLIB", "NODE_PATH", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_TEMPLATE_DIR", "LESSOPEN", "LESSCLOSE", "MANPAGER", "SYSTEMD_PAGER", "BROWSER", "TERMINAL",
  // Prompts bash expands, command substitutions included (PS4 with `set -x` or `bash -x`).
  "PS0", "PS1", "PS2", "PS3", "PS4",
  // Where tools read settings that can name a program to run (a pager in ~/.gitconfig, a credential helper, an exec
  // plugin in a kubeconfig, credential_process in AWS's config, a gconv module, make's own flags).
  "HOME", "XDG_CONFIG_HOME", "GIT_CONFIG", "DOCKER_CONFIG", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "GCONV_PATH",
  "MAKEFLAGS", "MFLAGS", "GNUMAKEFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_HOME", "GRADLE_USER_HOME",
  "PIP_CONFIG_FILE", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_FIND_LINKS",
  // The folder a shell started with it believes it is in, when it names the same folder another way (a link to it):
  // its `cd ..` then leaves from there, not from where Ember judged (§3.6, L25).
  "PWD",
]);
/** Prefixes of such variables (`DYLD_*`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, bash's exported functions, npm's settings). */
export const RISKY_ASSIGNMENT_PREFIX = /^(DYLD_|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_|LD_|BASH_FUNC_|NPM_CONFIG_|YARN_)/i;

/** A variable name that may hold a secret (§3.5.4 "printing the environment"). */
export const SECRET_VAR = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i;

/** How a wrapper runs the command after it (§3.4.5). */
export interface WrapperRule {
  shortValue?: string;
  longValue?: readonly string[];
  /** Positional arguments before the command (timeout's duration, taskset's mask). */
  positional?: number;
  /** An option after which there is no command (ionice -p, taskset -p). */
  noCommand?: RegExp;
  /** What the wrapper itself adds. */
  finding?: { cls: DangerClass; rule: string; says: string };
  /** With nothing after it, it is interactive (a shell). */
  aloneInteractive?: boolean;
}

const KEEPS_RUNNING = "Keeps running after Ember stops; Stop can't end it.";

/** The wrappers whose option grammar Ember knows (a generic grammar: no cross-OS table is imported, see classify.ts). */
export const WRAPPERS: Readonly<Record<string, WrapperRule>> = {
  nohup: { finding: { cls: "escape", rule: "escape.nohup", says: KEEPS_RUNNING } },
  setsid: { finding: { cls: "escape", rule: "escape.setsid", says: KEEPS_RUNNING } },
  daemonize: { shortValue: "ceEloOpuU", finding: { cls: "escape", rule: "escape.daemonize", says: KEEPS_RUNNING } },
  disown: { finding: { cls: "escape", rule: "escape.disown", says: KEEPS_RUNNING } },
  nice: { shortValue: "n", longValue: ["adjustment"] },
  ionice: { shortValue: "cnpPu", longValue: ["class", "classdata", "pid", "pgid", "uid"], noCommand: /^-([a-z]*[pPu]|-pid|-pgid|-uid)/ },
  stdbuf: { shortValue: "ioe", longValue: ["input", "output", "error"] },
  gstdbuf: { shortValue: "ioe", longValue: ["input", "output", "error"] },
  timeout: { shortValue: "ks", longValue: ["kill-after", "signal"], positional: 1 },
  gtimeout: { shortValue: "ks", longValue: ["kill-after", "signal"], positional: 1 },
  chrt: { shortValue: "TPD", longValue: ["sched-runtime", "sched-period", "sched-deadline"], positional: 1, noCommand: /^-([a-z]*[pm]|-pid|-max)/ },
  taskset: { positional: 1, noCommand: /^-([a-z]*p|-pid)/ },
  time: { shortValue: "fo", longValue: ["format", "output"] },
  exec: { shortValue: "a" },
  catchsegv: {},
  unbuffer: {},
  chronic: {},
  ifne: {},
  fakeroot: { shortValue: "is", longValue: ["lib", "faked"] },
  faketime: { shortValue: "m", positional: 1 },
  numactl: { shortValue: "CNmpPiH", longValue: ["physcpubind", "cpunodebind", "membind", "preferred", "interleave"] },
  cgexec: { shortValue: "g" },
  "dbus-run-session": { longValue: ["config-file", "dbus-daemon"] },
  "dbus-launch": { longValue: ["autolaunch", "config-file"] },
  "xvfb-run": { shortValue: "nsfepw", longValue: ["server-num", "server-args", "auth-file", "error-file", "xauth-protocol", "wait"] },
  torsocks: {},
  proxychains: { shortValue: "f" },
  proxychains4: { shortValue: "f" },
  "prime-run": {},
  primusrun: {},
  optirun: {},
  vglrun: { shortValue: "dc" },
  gamemoderun: {},
  mangohud: {},
  caffeinate: { shortValue: "tw" },
  "systemd-inhibit": { longValue: ["what", "who", "why", "mode"] },
  "systemd-cat": { shortValue: "tp", longValue: ["identifier", "priority", "stderr-priority", "level-prefix"] },
  valgrind: {},
  ltrace: { shortValue: "eopsuEanlLAD" },
  strace: { shortValue: "eopsuEaIOSPXb" },
  tini: {},
  "dumb-init": {},
  chroot: { positional: 1, aloneInteractive: true, finding: { cls: "system", rule: "system.chroot", says: "Runs as an administrator (root)." } },
  sg: { positional: 1, finding: { cls: "system", rule: "system.sg", says: "Runs as another group." } },
  newgrp: { aloneInteractive: true, finding: { cls: "system", rule: "system.newgrp", says: "Runs as another group." } },
  nsenter: { shortValue: "tSGmuinpUCTrw", finding: { cls: "system", rule: "system.nsenter", says: "Runs as an administrator (root)." }, aloneInteractive: true },
  unshare: { finding: { cls: "system", rule: "system.unshare", says: "Changes how the system works." }, aloneInteractive: true },
  setpriv: { longValue: ["reuid", "regid", "groups", "inh-caps", "ambient-caps", "bounding-set", "securebits", "selinux-label", "apparmor-profile"], finding: { cls: "system", rule: "system.setpriv", says: "Runs as an administrator (root)." } },
  capsh: { finding: { cls: "system", rule: "system.capsh", says: "Runs as an administrator (root)." }, aloneInteractive: true },
  chpst: { shortValue: "uUbeE/nlLmdofpc", finding: { cls: "system", rule: "system.chpst", says: "Runs as another user." } },
  arch: {},
  "ssh-agent": { shortValue: "aEPt" },
};

/** The sudo family (§3.5.5): class e, the inner command classified too. */
export const SUDO_LIKE = new Set(["sudo", "doas", "pkexec", "run0", "gsudo", "sudoedit", "su", "runuser", "runas", "ksu", "calife", "please"]);

/** Shells whose `-c` text is classified as POSIX (fish and csh are unclear). */
export const POSIX_SHELLS: Readonly<Record<string, "bash" | "zsh" | "sh">> = {
  sh: "sh", bash: "bash", zsh: "zsh", dash: "sh", ksh: "sh", mksh: "sh", ash: "sh", posh: "sh", yash: "sh", rbash: "bash",
};
/** Shells Ember doesn't parse. */
export const OTHER_SHELLS = new Set(["fish", "csh", "tcsh", "nu", "xonsh", "elvish", "ion", "es", "rc", "oksh", "loksh"]);

/** Interpreters: inline code (`-c`, `-e`…) is unclear; reading stdin after a fetch is download-and-run (§3.4.5, §3.4.7). */
export const INTERPRETERS: Readonly<Record<string, { inline: readonly string[]; valueOpts?: string }>> = {
  python: { inline: ["-c"], valueOpts: "WXm" }, python2: { inline: ["-c"], valueOpts: "WXm" }, python3: { inline: ["-c"], valueOpts: "WXm" },
  pypy: { inline: ["-c"], valueOpts: "WXm" }, pypy3: { inline: ["-c"], valueOpts: "WXm" }, py: { inline: ["-c"], valueOpts: "WXm" },
  node: { inline: ["-e", "--eval", "-p", "--print"], valueOpts: "r" }, nodejs: { inline: ["-e", "--eval", "-p", "--print"], valueOpts: "r" },
  perl: { inline: ["-e", "-E"], valueOpts: "IMm" }, ruby: { inline: ["-e"], valueOpts: "Ir" }, php: { inline: ["-r", "-B", "-R", "-E", "-F"], valueOpts: "cdz" },
  lua: { inline: ["-e"], valueOpts: "l" }, luajit: { inline: ["-e"], valueOpts: "l" }, osascript: { inline: ["-e"], valueOpts: "l" },
  rscript: { inline: ["-e"] }, Rscript: { inline: ["-e"] }, r: { inline: ["-e"] }, R: { inline: ["-e"] }, julia: { inline: ["-e", "--eval", "-E", "--print"] }, tclsh: { inline: [] },
  wish: { inline: [] }, guile: { inline: ["-c"] }, racket: { inline: ["-e"] }, scala: { inline: ["-e"] }, groovy: { inline: ["-e"] },
  jshell: { inline: [] }, irb: { inline: [] }, ghci: { inline: ["-e"] }, runghc: { inline: [] }, expect: { inline: ["-c"] },
  awk: { inline: [] }, gawk: { inline: [] }, mawk: { inline: [] }, nawk: { inline: [] },
};

/** Network fetchers: piping one into an interpreter is download-and-run (§3.4.7). */
export const FETCHERS = new Set(["curl", "wget", "fetch", "aria2c", "invoke-webrequest", "invoke-restmethod", "iwr", "irm", "nc", "ncat", "netcat", "socat", "http", "https", "xh", "lwp-download", "lwp-request", "gsutil", "scp", "sftp", "ftp", "tftp", "bitsadmin", "certutil"]);
/** Decoders of hidden text (base64 -d and friends): piping one into an interpreter hides what runs. */
export const DECODERS = new Set(["base64", "base32", "xxd", "openssl", "gzip", "gunzip", "zcat", "xz", "unxz", "bzip2", "bunzip2", "uudecode", "rev", "tr"]);

/** Interactive full-screen programs (§3.5.7): unclear unless arguments make them finish. */
export const INTERACTIVE = new Set([
  "vim", "vi", "nvim", "view", "vimdiff", "nano", "pico", "emacs", "joe", "micro", "ne", "mcedit", "ed", "ex", "less", "more", "most", "pg",
  "man", "info", "top", "htop", "btop", "atop", "iotop", "nethogs", "iftop", "nmon", "glances", "watch", "mc", "ranger", "nnn", "lf", "vifm",
  "ncdu", "tig", "lazygit", "lazydocker", "k9s", "fzf", "dialog", "whiptail", "tmux", "screen", "byobu", "psql", "mysql", "mariadb", "sqlite3",
  "mongo", "mongosh", "redis-cli", "sqlplus", "bc", "dc", "telnet", "mosh", "gdb", "lldb", "pdb", "ipython", "bpython", "irb", "jshell",
  "ghci", "visudo", "vipw", "vigr", "crontab", "w3m", "lynx", "links", "elinks", "alpine", "mutt", "neomutt", "irssi", "weechat", "cmus",
  "minicom", "picocom", "nmtui", "alsamixer", "cfdisk", "tty-clock", "sl", "aptitude", "debconf", "dpkg-reconfigure", "passwd", "choice",
]);

/** GUI programs in command position (§3.4.7): unclear, "This opens an app window, which Ember can do itself …" */
export const GUI_PROGRAMS = new Set([
  "gedit", "kate", "kwrite", "mousepad", "leafpad", "pluma", "xed", "gnome-text-editor", "notepad", "notepad++", "write", "wordpad",
  "mspaint", "paint", "calc", "gnome-calculator", "kcalc", "firefox", "firefox-esr", "chrome", "google-chrome", "google-chrome-stable",
  "chromium", "chromium-browser", "msedge", "microsoft-edge", "brave", "brave-browser", "opera", "vivaldi", "safari", "nautilus", "dolphin",
  "thunar", "nemo", "caja", "pcmanfm", "konqueror", "libreoffice", "soffice", "lowriter", "localc", "loimpress", "textedit", "evince",
  "okular", "eog", "gwenview", "ristretto", "gimp", "inkscape", "krita", "vlc", "mpv", "totem", "rhythmbox", "audacity", "thunderbird",
  "evolution", "gnome-terminal", "konsole", "xterm", "terminator", "tilix", "alacritty", "kitty", "wezterm", "xfce4-terminal",
  "mate-terminal", "lxterminal", "urxvt", "rxvt", "st", "foot", "wt", "windowsterminal", "mintty", "conhost", "gvim", "emacsclient",
  "xeyes", "xclock", "xcalc", "zenity", "kdialog", "yad", "eclipse", "idea", "pycharm", "studio", "android-studio", "qtcreator",
  "gnome-control-center", "gnome-system-monitor", "taskmgr", "regedit", "mmc", "control", "devmgmt", "services", "eventvwr", "perfmon",
  "resmon", "winword", "excel", "powerpnt", "outlook", "onenote", "teams", "slack", "discord", "zoom", "spotify", "steam", "obs",
  "keepassxc", "keepass", "seahorse", "1password", "bitwarden", "sublime_text", "subl", "atom", "geany", "bluefish", "meld", "kdiff3",
  "xdg-email", "ise", "powershell_ise", "snippingtool", "magnify", "osk", "narrator", "charmap", "dxdiag", "msinfo32", "winver",
]);

/** Launchers that hand work to the desktop or a daemon (§3.4.7, critique wsl-6): class f. */
export const LAUNCHERS = new Set([
  "xdg-open", "wslview", "gnome-open", "kde-open", "kde-open5", "kde-open6", "exo-open", "gvfs-open", "open", "explorer", "code",
  "code-insiders", "cursor", "codium", "vscodium", "windsurf", "mate-open", "dde-open", "kioclient", "kioclient5", "handlr", "mimeopen",
  "see", "run-mailcap", "sensible-browser", "x-www-browser", "www-browser", "sensible-editor", "invoke-item", "ii",
]);

/** Programs that synthesise input or drive windows (§3.5.8): refused, they could answer Ember's own questions. */
export const INPUT_SYNTH = new Set([
  "xdotool", "ydotool", "ydotoold", "xte", "wtype", "dotool", "dotoold", "xvkbd", "cliclick", "autohotkey", "autohotkeyu64", "autohotkeyu32",
  "autohotkey64", "autohotkey32", "autoit3", "autoit3_x64", "xmacroplay", "xautomation", "sendkeys", "nircmdc", "evemu-play",
  "evemu-event",
]);

/** Programs that read or change passwords, keys or sign-ins whatever their arguments (§3.5.4 row 2). */
export const SECRET_PROGRAMS = new Set([
  "pass", "gopass", "op", "bw", "lpass", "kwallet-query", "cmdkey", "vaultcmd", "mimikatz", "sshpass", "ssh-add", "secret-tool",
  "keepassxc-cli", "kpcli", "gpg-agent", "pinentry", "pinentry-curses", "pinentry-tty", "keyring", "git-credential-store",
  "git-credential-cache", "git-credential-manager", "git-credential-manager-core", "git-credential-libsecret", "git-credential-osxkeychain",
  "git-credential-wincred", "aws-vault", "chamber", "sops", "age", "doppler", "infisical", "1password",
]);

/** Reading the clipboard (§3.5.4). */
export const CLIPBOARD_READERS = new Set(["wl-paste", "pbpaste", "get-clipboard", "gcb", "termux-clipboard-get", "clipnotify", "copyq"]);

/** Taking pictures of the screen (§3.5.4). */
export const SCREENSHOTTERS = new Set(["import", "scrot", "gnome-screenshot", "grim", "spectacle", "xwd", "screencapture", "maim", "flameshot", "shutter", "ksnip", "deepin-screenshot", "xfce4-screenshooter", "screenshot", "wf-recorder", "wl-screenrec", "recordmydesktop", "simplescreenrecorder", "peek", "kazam", "vokoscreen"]);

/** Disk erasing and partitioning (§3.5.1): always class a. */
export const DISK_TOOLS = new Set(["mke2fs", "mkswap", "wipefs", "fdisk", "sfdisk", "gdisk", "sgdisk", "parted", "cfdisk", "blkdiscard", "diskpart", "format-volume", "clear-disk", "initialize-disk", "remove-partition", "badblocks", "hdparm", "nvme", "zpool", "cryptsetup", "lvremove", "vgremove", "pvremove", "mdadm", "partprobe", "gparted"]);

/** Script, target and package-script names (§3.5.9, L8). */
export const NAME_PUBLISH = new Set(["deploy", "publish", "release", "push", "upload", "ship", "prod", "production", "promote"]);
export const NAME_DESTROY = new Set(["clean", "clobber", "distclean", "reset", "wipe", "purge", "nuke", "destroy", "drop", "rollback"]);
export const NAME_SYSTEM = new Set(["install", "setup", "bootstrap", "provision"]);

/**
 * Read verbs of the cloud and cluster CLIs (§3.5.2): anything else changes the service; delete verbs are c. Review #30
 * added the read-only ones a cloud engineer runs first (`aws s3 ls`, `aws logs tail`, `terraform validate`, `terraform
 * output`, `terraform fmt`, `helm history`, `gsutil ls`, `kubectl api-resources`).
 */
export const CLOUD_READ = new Set([
  "get", "list", "describe", "show", "logs", "top", "plan", "version", "status", "whoami", "explain", "diff", "help",
  "ls", "tail", "validate", "output", "fmt", "history", "search", "lint", "template", "providers", "graph", "cat", "du", "stat", "events",
  "api-resources", "api-versions", "cluster-info",
]);
/** Read commands of the cloud and cluster CLIs that take more than one word (§3.5.2, review #30): matched at the start. */
export const CLOUD_READ_PHRASES: readonly string[] = [
  "s3 ls", "config view", "config current-context", "config get-contexts", "config get-clusters", "config get-users", "auth list", "auth can-i",
  "auth whoami", "rollout status", "rollout history", "repo list", "dependency list", "plugin list", "state list", "state show",
  "workspace list", "workspace show", "stack ls", "storage ls",
];
export const CLOUD_DELETE = new Set(["delete", "destroy", "remove", "rm", "terminate", "purge", "drain", "uninstall", "rb", "deregister", "detach"]);
export const CLOUD_CLIS: Readonly<Record<string, string>> = {
  kubectl: "Kubernetes", oc: "OpenShift", helm: "Kubernetes", terraform: "the infrastructure", tofu: "the infrastructure",
  pulumi: "the infrastructure", aws: "AWS", az: "Azure", gcloud: "Google Cloud", gsutil: "Google Cloud Storage", doctl: "DigitalOcean",
  ansible: "the managed computers", "ansible-playbook": "the managed computers", eksctl: "AWS", flyctl: "Fly.io", fly: "Fly.io",
  heroku: "Heroku", vercel: "Vercel", netlify: "Netlify", wrangler: "Cloudflare", firebase: "Firebase", cdk: "AWS", sam: "AWS",
  serverless: "the cloud", sls: "the cloud", nomad: "Nomad", consul: "Consul", linode: "Linode", "linode-cli": "Linode", hcloud: "Hetzner Cloud",
  ibmcloud: "IBM Cloud", oci: "Oracle Cloud", aliyun: "Alibaba Cloud", scw: "Scaleway", exoscale: "Exoscale", openstack: "OpenStack", vault: "Vault",
};

/** System package managers (§3.5.5) and their read verbs. */
export const SYSTEM_PACKAGERS: Readonly<Record<string, { read: readonly string[] }>> = {
  apt: { read: ["list", "search", "show", "showsrc", "policy", "depends", "rdepends", "madison", "changelog", "help", "info"] },
  "apt-get": { read: ["check", "changelog", "download", "source", "help"] },
  "apt-cache": { read: ["*"] },
  aptitude: { read: ["search", "show", "versions", "why", "why-not", "help"] },
  dnf: { read: ["list", "search", "info", "provides", "repoquery", "repolist", "check-update", "history", "help", "deplist", "whatprovides", "updateinfo"] },
  yum: { read: ["list", "search", "info", "provides", "repoquery", "repolist", "check-update", "history", "help", "deplist", "whatprovides", "updateinfo"] },
  microdnf: { read: ["repolist", "help"] },
  zypper: { read: ["search", "se", "info", "if", "list-updates", "lu", "repos", "lr", "packages", "pa", "patches", "help", "what-provides"] },
  apk: { read: ["info", "search", "list", "policy", "stats", "dot", "help"] },
  snap: { read: ["list", "find", "info", "help", "version", "changes", "services", "connections", "interfaces", "known"] },
  flatpak: { read: ["list", "search", "info", "remotes", "remote-ls", "history", "help", "ps", "documents", "permissions"] },
  brew: { read: ["list", "ls", "search", "info", "desc", "deps", "uses", "leaves", "outdated", "config", "home", "--prefix", "--cellar", "--cache", "--repository", "help", "commands", "log", "missing", "options", "cat", "formulae", "casks"] },
  port: { read: ["list", "search", "info", "installed", "outdated", "deps", "contents", "provides", "help"] },
  winget: { read: ["list", "search", "show", "source", "hash", "validate", "features", "export", "settings", "--help", "-?", "--info"] },
  choco: { read: ["list", "search", "find", "info", "outdated", "help", "config", "source"] },
  scoop: { read: ["list", "search", "info", "status", "help", "home", "which", "prefix", "cat", "checkup", "export"] },
  pkg: { read: ["info", "search", "query", "rquery", "stats", "audit", "version", "which", "help"] },
  pacman: { read: [] },
  emerge: { read: ["--search", "-s", "--info", "--pretend", "-p"] },
  "nix-env": { read: ["-q", "--query"] },
  xbps: { read: [] },
  eopkg: { read: ["info", "list-installed", "search", "help"] },
  slackpkg: { read: ["search", "info", "help"] },
  urpmi: { read: [] },
  mas: { read: ["list", "search", "info", "outdated", "account", "help", "version"] },
};

/** Language package managers (§3.5.5): only these verbs install (other verbs build, test or run scripts). */
export const LANGUAGE_INSTALL_VERBS: Readonly<Record<string, readonly string[]>> = {
  npm: ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "install-clean", "ic", "update", "up", "upgrade", "udpate", "uninstall", "un", "unlink", "remove", "rm", "r", "link", "ln", "rebuild", "rb", "prune", "dedupe", "ddp", "install-test", "it", "install-ci-test", "cit"],
  pnpm: ["add", "install", "i", "update", "up", "upgrade", "remove", "rm", "uninstall", "un", "link", "ln", "unlink", "rebuild", "rb", "prune", "dedupe", "import", "fetch", "install-test", "it", "patch-commit"],
  yarn: ["add", "install", "remove", "upgrade", "up", "upgrade-interactive", "link", "unlink", "dedupe", "import", "autoclean"],
  bun: ["install", "i", "add", "a", "remove", "rm", "update", "upgrade", "link", "unlink", "pm"],
  pip: ["install", "uninstall", "download", "wheel"],
  pip3: ["install", "uninstall", "download", "wheel"],
  pipx: ["install", "uninstall", "upgrade", "upgrade-all", "reinstall", "reinstall-all", "inject", "uninject", "ensurepath"],
  poetry: ["add", "install", "remove", "update", "lock", "self"],
  pipenv: ["install", "uninstall", "update", "sync", "lock", "clean"],
  conda: ["install", "remove", "uninstall", "update", "upgrade", "create", "env"],
  mamba: ["install", "remove", "uninstall", "update", "upgrade", "create", "env"],
  micromamba: ["install", "remove", "uninstall", "update", "upgrade", "create", "env"],
  gem: ["install", "uninstall", "update", "i", "cleanup"],
  bundle: ["install", "update", "add", "remove", "lock", "clean"],
  bundler: ["install", "update", "add", "remove", "lock", "clean"],
  cargo: ["install", "uninstall", "add", "remove", "rm", "update"],
  go: ["install", "get"],
  composer: ["install", "require", "update", "remove", "upgrade", "global", "i", "u", "r"],
  dotnet: ["add", "remove", "restore", "tool", "workload", "new"],
  nuget: ["install", "update", "restore", "add", "delete"],
  cpan: ["*"],
  cpanm: ["*"],
  luarocks: ["install", "remove", "make", "build"],
  opam: ["install", "remove", "upgrade", "update", "pin", "switch", "init"],
  stack: ["install", "setup", "upgrade"],
  cabal: ["install", "update", "v2-install"],
  dart: ["pub"],
  flutter: ["pub", "upgrade", "downgrade"],
  deno: ["install", "uninstall", "add", "remove", "upgrade"],
  uv: ["add", "remove", "sync", "lock", "pip", "tool", "python", "self"],
  rye: ["add", "remove", "sync", "install", "uninstall", "tools", "toolchain", "self"],
  hatch: ["env"],
  pdm: ["add", "remove", "install", "sync", "update", "self"],
  mix: ["deps.get", "deps.update", "local.hex", "local.rebar", "archive.install", "escript.install"],
  rustup: ["install", "update", "uninstall", "toolchain", "target", "component", "self", "default", "override"],
  sdk: ["install", "uninstall", "upgrade", "update", "selfupdate", "flush"],
  asdf: ["install", "uninstall", "plugin", "global", "local", "shell", "update"],
  nvm: ["install", "uninstall", "use", "alias", "unalias", "reinstall-packages"],
  pyenv: ["install", "uninstall", "global", "local", "shell", "rehash"],
  rbenv: ["install", "uninstall", "global", "local", "shell", "rehash"],
  volta: ["install", "uninstall", "pin", "fetch", "setup"],
  fnm: ["install", "uninstall", "use", "default", "alias"],
  vcpkg: ["install", "remove", "upgrade", "integrate"],
  conan: ["install", "remove", "upload", "create", "export"],
  helm: [],
};

/** PowerShell 5.1's built-in aliases (§3.4.2; no profile is loaded, so no user alias exists), lower case → cmdlet. */
export const PS_ALIASES: Readonly<Record<string, string>> = {
  rm: "Remove-Item", del: "Remove-Item", erase: "Remove-Item", rd: "Remove-Item", rmdir: "Remove-Item", ri: "Remove-Item",
  cp: "Copy-Item", copy: "Copy-Item", cpi: "Copy-Item", mv: "Move-Item", move: "Move-Item", mi: "Move-Item",
  cat: "Get-Content", gc: "Get-Content", type: "Get-Content", ls: "Get-ChildItem", dir: "Get-ChildItem", gci: "Get-ChildItem",
  curl: "Invoke-WebRequest", wget: "Invoke-WebRequest", iwr: "Invoke-WebRequest", irm: "Invoke-RestMethod", iex: "Invoke-Expression",
  start: "Start-Process", saps: "Start-Process", kill: "Stop-Process", spps: "Stop-Process", sc: "Set-Content", si: "Set-Item",
  sp: "Set-ItemProperty", ni: "New-Item", echo: "Write-Output", write: "Write-Output", set: "Set-Variable", sv: "Set-Variable",
  cd: "Set-Location", chdir: "Set-Location", sl: "Set-Location", pwd: "Get-Location", gl: "Get-Location", ps: "Get-Process",
  gps: "Get-Process", sleep: "Start-Sleep", tee: "Tee-Object", select: "Select-Object", where: "Where-Object", "?": "Where-Object",
  foreach: "ForEach-Object", "%": "ForEach-Object", sort: "Sort-Object", measure: "Measure-Object", r: "Invoke-History",
  h: "Get-History", history: "Get-History", ghy: "Get-History", icm: "Invoke-Command", ipmo: "Import-Module", gcb: "Get-Clipboard",
  scb: "Set-Clipboard", clc: "Clear-Content", cli: "Clear-Item", rni: "Rename-Item", ren: "Rename-Item", mount: "New-PSDrive",
  ndr: "New-PSDrive", gp: "Get-ItemProperty", rp: "Remove-ItemProperty", ac: "Add-Content", gi: "Get-Item", ii: "Invoke-Item",
  pushd: "Push-Location", popd: "Pop-Location", gsv: "Get-Service", sasv: "Start-Service", spsv: "Stop-Service", ogv: "Out-GridView",
  gwmi: "Get-WmiObject", iwmi: "Invoke-WmiMethod", rwmi: "Remove-WmiObject", swmi: "Set-WmiInstance", sajb: "Start-Job",
  rjb: "Remove-Job", nal: "New-Alias", sal: "Set-Alias", nv: "New-Variable", rv: "Remove-Variable", ft: "Format-Table",
  fl: "Format-List", gal: "Get-Alias", gcm: "Get-Command", etsn: "Enter-PSSession", nsn: "New-PSSession", sls: "Select-String",
  rvpa: "Resolve-Path", cvpa: "Convert-Path", cpp: "Copy-ItemProperty", mp: "Move-ItemProperty", clp: "Clear-ItemProperty",
  clv: "Clear-Variable", gv: "Get-Variable", group: "Group-Object", clear: "Clear-Host", cls: "Clear-Host", diff: "Compare-Object",
  compare: "Compare-Object", gm: "Get-Member", gjb: "Get-Job", rcjb: "Receive-Job", spjb: "Stop-Job", wjb: "Wait-Job",
  fhx: "Format-Hex", clhy: "Clear-History", lp: "Out-Printer", gdr: "Get-PSDrive", rdr: "Remove-PSDrive", gu: "Get-Unique",
  epcsv: "Export-Csv", ipcsv: "Import-Csv", epsn: "Export-PSSession", ipsn: "Import-PSSession", rsn: "Remove-PSSession",
  gsn: "Get-PSSession", exsn: "Exit-PSSession", ise: "powershell_ise", man: "help", md: "mkdir", mkdir: "mkdir",
};

/** A PowerShell parameter: "v" takes a value, "s" is a switch. */
export type PsParamKind = "v" | "s";
export interface PsCmdletSpec {
  params: Readonly<Record<string, PsParamKind>>;
  /** Other names of parameters (lower case → canonical). */
  aliases?: Readonly<Record<string, string>>;
  /** Positional parameters in order. */
  pos: readonly string[];
}

/** Parameters every cmdlet takes. */
export const PS_COMMON: Readonly<Record<string, PsParamKind>> = {
  Verbose: "s", Debug: "s", ErrorAction: "v", WarningAction: "v", InformationAction: "v", ErrorVariable: "v", WarningVariable: "v",
  InformationVariable: "v", OutVariable: "v", OutBuffer: "v", PipelineVariable: "v", WhatIf: "s", Confirm: "s", UseTransaction: "s",
  ProgressAction: "v",
};
export const PS_COMMON_ALIASES: Readonly<Record<string, string>> = {
  vb: "Verbose", db: "Debug", ea: "ErrorAction", wa: "WarningAction", infa: "InformationAction", ev: "ErrorVariable", wv: "WarningVariable",
  iv: "InformationVariable", ov: "OutVariable", ob: "OutBuffer", pv: "PipelineVariable", wi: "WhatIf", cf: "Confirm", usetx: "UseTransaction",
};

const PATHS = { Path: "v", LiteralPath: "v", Filter: "v", Include: "v", Exclude: "v", Force: "s", Credential: "v" } as const;
const PATH_ALIASES = { pspath: "LiteralPath", lp: "LiteralPath" };

/** The cmdlets Ember judges by their parameters (§3.5.1-§3.5.5 PowerShell rows). */
export const PS_CMDLETS: Readonly<Record<string, PsCmdletSpec>> = {
  "remove-item": { params: { ...PATHS, Recurse: "s", Stream: "v" }, aliases: PATH_ALIASES, pos: ["Path"] },
  "clear-content": { params: { ...PATHS, Stream: "v" }, aliases: PATH_ALIASES, pos: ["Path"] },
  "clear-item": { params: { ...PATHS }, aliases: PATH_ALIASES, pos: ["Path"] },
  "copy-item": { params: { ...PATHS, Destination: "v", Container: "s", Recurse: "s", PassThru: "s", ToSession: "v", FromSession: "v" }, aliases: PATH_ALIASES, pos: ["Path", "Destination"] },
  "move-item": { params: { ...PATHS, Destination: "v", PassThru: "s" }, aliases: PATH_ALIASES, pos: ["Path", "Destination"] },
  "rename-item": { params: { Path: "v", LiteralPath: "v", NewName: "v", Force: "s", PassThru: "s", Credential: "v" }, aliases: PATH_ALIASES, pos: ["Path", "NewName"] },
  "set-content": { params: { ...PATHS, Value: "v", PassThru: "s", NoNewline: "s", Encoding: "v", Stream: "v", AsByteStream: "s" }, aliases: PATH_ALIASES, pos: ["Path", "Value"] },
  "add-content": { params: { ...PATHS, Value: "v", PassThru: "s", NoNewline: "s", Encoding: "v", Stream: "v", AsByteStream: "s" }, aliases: PATH_ALIASES, pos: ["Path", "Value"] },
  "out-file": { params: { FilePath: "v", LiteralPath: "v", Encoding: "v", Append: "s", Force: "s", NoClobber: "s", Width: "v", NoNewline: "s", InputObject: "v" }, aliases: { ...PATH_ALIASES, path: "FilePath", nooverwrite: "NoClobber" }, pos: ["FilePath", "Encoding"] },
  "tee-object": { params: { FilePath: "v", LiteralPath: "v", Append: "s", Variable: "v", InputObject: "v", Encoding: "v" }, aliases: { ...PATH_ALIASES, path: "FilePath" }, pos: ["FilePath"] },
  "export-csv": {
    params: { Path: "v", LiteralPath: "v", Append: "s", Force: "s", NoClobber: "s", NoTypeInformation: "s", IncludeTypeInformation: "s", Delimiter: "v", UseCulture: "s", Encoding: "v", InputObject: "v", QuoteFields: "v", UseQuotes: "v" },
    aliases: { ...PATH_ALIASES, nti: "NoTypeInformation", nooverwrite: "NoClobber", ita: "IncludeTypeInformation" }, pos: ["Path", "Delimiter"],
  },
  "export-clixml": { params: { Path: "v", LiteralPath: "v", Depth: "v", Force: "s", NoClobber: "s", Encoding: "v", InputObject: "v" }, aliases: { ...PATH_ALIASES, nooverwrite: "NoClobber" }, pos: ["Path"] },
  "new-item": { params: { Path: "v", Name: "v", ItemType: "v", Value: "v", Force: "s", Credential: "v" }, aliases: { type: "ItemType", target: "Value" }, pos: ["Path"] },
  "get-content": { params: { ...PATHS, ReadCount: "v", TotalCount: "v", Tail: "v", Delimiter: "v", Wait: "s", Raw: "s", Encoding: "v", Stream: "v", AsByteStream: "s" }, aliases: { ...PATH_ALIASES, first: "TotalCount", head: "TotalCount", last: "Tail" }, pos: ["Path"] },
  "get-childitem": { params: { ...PATHS, Recurse: "s", Depth: "v", Name: "s", Attributes: "v", Directory: "s", File: "s", Hidden: "s", ReadOnly: "s", System: "s", FollowSymlink: "s" }, aliases: { ...PATH_ALIASES, ad: "Directory", d: "Directory", af: "File", ah: "Hidden", h: "Hidden", ar: "ReadOnly", as: "System", s: "Recurse" }, pos: ["Path", "Filter"] },
  "get-item": { params: { ...PATHS, Stream: "v" }, aliases: PATH_ALIASES, pos: ["Path"] },
  "select-string": { params: { Pattern: "v", Path: "v", LiteralPath: "v", InputObject: "v", SimpleMatch: "s", CaseSensitive: "s", Quiet: "s", List: "s", NotMatch: "s", AllMatches: "s", Encoding: "v", Context: "v", Include: "v", Exclude: "v", Raw: "s", NoEmphasis: "s" }, aliases: PATH_ALIASES, pos: ["Pattern", "Path"] },
  "set-location": { params: { Path: "v", LiteralPath: "v", PassThru: "s", StackName: "v" }, aliases: PATH_ALIASES, pos: ["Path"] },
  "push-location": { params: { Path: "v", LiteralPath: "v", PassThru: "s", StackName: "v" }, aliases: PATH_ALIASES, pos: ["Path"] },
  "invoke-webrequest": { params: { Uri: "v", Method: "v", Body: "v", InFile: "v", OutFile: "v", Headers: "v", ContentType: "v", UseBasicParsing: "s", UseDefaultCredentials: "s", Credential: "v", UserAgent: "v", TimeoutSec: "v", MaximumRedirection: "v", PassThru: "s", Proxy: "v", ProxyCredential: "v", ProxyUseDefaultCredentials: "s", WebSession: "v", SessionVariable: "v", DisableKeepAlive: "s", TransferEncoding: "v", CertificateThumbprint: "v", Certificate: "v" }, aliases: { sv: "SessionVariable" }, pos: ["Uri"] },
  "invoke-restmethod": { params: { Uri: "v", Method: "v", Body: "v", InFile: "v", OutFile: "v", Headers: "v", ContentType: "v", UseBasicParsing: "s", UseDefaultCredentials: "s", Credential: "v", UserAgent: "v", TimeoutSec: "v", MaximumRedirection: "v", PassThru: "s", Proxy: "v", ProxyCredential: "v", ProxyUseDefaultCredentials: "s", WebSession: "v", SessionVariable: "v", DisableKeepAlive: "s", TransferEncoding: "v", CertificateThumbprint: "v", Certificate: "v" }, aliases: { sv: "SessionVariable" }, pos: ["Uri"] },
  "start-process": { params: { FilePath: "v", ArgumentList: "v", Verb: "v", Wait: "s", WorkingDirectory: "v", NoNewWindow: "s", PassThru: "s", RedirectStandardInput: "v", RedirectStandardOutput: "v", RedirectStandardError: "v", WindowStyle: "v", UseNewEnvironment: "s", Credential: "v", LoadUserProfile: "s" }, aliases: { args: "ArgumentList", path: "FilePath", lup: "LoadUserProfile", nnw: "NoNewWindow", rsi: "RedirectStandardInput", rso: "RedirectStandardOutput", rse: "RedirectStandardError" }, pos: ["FilePath", "ArgumentList"] },
  "stop-process": { params: { Id: "v", Name: "v", InputObject: "v", Force: "s", PassThru: "s" }, aliases: { processname: "Name" }, pos: ["Id"] },
  "set-itemproperty": { params: { ...PATHS, Name: "v", Value: "v", Type: "v", PassThru: "s", InputObject: "v" }, aliases: { ...PATH_ALIASES, pspropertyname: "Name" }, pos: ["Path", "Name", "Value"] },
  "new-itemproperty": { params: { ...PATHS, Name: "v", Value: "v", PropertyType: "v" }, aliases: { ...PATH_ALIASES, type: "PropertyType" }, pos: ["Path", "Name", "Value"] },
  "remove-itemproperty": { params: { ...PATHS, Name: "v" }, aliases: PATH_ALIASES, pos: ["Path", "Name"] },
  "rename-itemproperty": { params: { Path: "v", LiteralPath: "v", Name: "v", NewName: "v", PassThru: "s", Force: "s", Filter: "v", Include: "v", Exclude: "v", Credential: "v" }, aliases: PATH_ALIASES, pos: ["Path", "Name", "NewName"] },
  "set-item": { params: { ...PATHS, Value: "v", PassThru: "s", Type: "v" }, aliases: PATH_ALIASES, pos: ["Path", "Value"] },
  "get-itemproperty": { params: { ...PATHS, Name: "v" }, aliases: PATH_ALIASES, pos: ["Path", "Name"] },
  "expand-archive": { params: { Path: "v", LiteralPath: "v", DestinationPath: "v", Force: "s", PassThru: "s" }, aliases: PATH_ALIASES, pos: ["Path", "DestinationPath"] },
  "compress-archive": { params: { Path: "v", LiteralPath: "v", DestinationPath: "v", CompressionLevel: "v", Update: "s", Force: "s", PassThru: "s" }, aliases: PATH_ALIASES, pos: ["Path", "DestinationPath"] },
  "invoke-item": { params: { ...PATHS }, aliases: PATH_ALIASES, pos: ["Path"] },
  "start-bitstransfer": { params: { Source: "v", Destination: "v", TransferType: "v", Asynchronous: "s", Credential: "v", DisplayName: "v", Description: "v", Priority: "v", ProxyUsage: "v", ProxyList: "v", Authentication: "v", Suspended: "s", RetryInterval: "v", RetryTimeout: "v", Dynamic: "s" }, pos: ["Source", "Destination"] },
  "write-output": { params: { InputObject: "v", NoEnumerate: "s" }, pos: ["InputObject"] },
  "write-host": { params: { Object: "v", NoNewline: "s", Separator: "v", ForegroundColor: "v", BackgroundColor: "v" }, pos: ["Object"] },
};
