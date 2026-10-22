import { describe, expect, it } from "vitest";
import { appendPath, commandEnv, macExtraPath, mergeEnv } from "../../app/main/commands/run/env";

const RUN = "0123456789abcdef";
const base = (os: "linux" | "darwin" | "win32", over: Partial<Parameters<typeof commandEnv>[1]> = {}) => ({ os, pty: true, remote: false, extraPath: [], runId: RUN, ...over });

/** An environment as Ember (an Electron app started from the desktop) has it. */
const EMBER_ENV: NodeJS.ProcessEnv = {
  HOME: "/home/ana", USER: "ana", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "en_GB.UTF-8", DISPLAY: ":0",
  SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh", NPM_TOKEN: "npm_users-own", GH_ENTERPRISE_TOKEN: "users-own",
  EMBER_USER_DATA: "/tmp/x", EMBER_LOG_LEVEL: "debug", EMBER_RUN_ID: "ffffffffffffffff", EMBER_CMD: "stale",
  ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1",
  NODE_OPTIONS: "--require /tmp/hook.js", NODE_PATH: "/x", NODE_DEBUG: "net",
  COPILOT_GITHUB_TOKEN: "gho_ember", GH_TOKEN: "gho_ember", GITHUB_TOKEN: "gho_ember", COPILOT_AGENT_URL: "https://x",
  BASH_ENV: "/tmp/evil.sh", ENV: "/tmp/evil.sh", ZDOTDIR: "/tmp/z", PROMPT_COMMAND: "curl x", PS1: "$ ", PS2: "> ", PS3: "? ", PS4: "+ ",
  LD_PRELOAD: "/tmp/x.so", LD_LIBRARY_PATH: "/tmp", LD_AUDIT: "/tmp/a.so", LD_BIND_NOW: "1",
  DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", DYLD_LIBRARY_PATH: "/tmp", DYLD_FRAMEWORK_PATH: "/tmp",
  XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME", CHROME_DESKTOP: "ember.desktop", NO_AT_BRIDGE: "1",
  APPDIR: "/tmp/.mount_ember", APPIMAGE: "/home/ana/Ember.AppImage", ARGV0: "Ember.AppImage", OWD: "/home/ana",
  SSH_CONNECTION: "10.0.0.1 5 10.0.0.2 22", SSH_CLIENT: "10.0.0.1 5 22", SSH_TTY: "/dev/pts/1", SSH_ORIGINAL_COMMAND: "x",
  SUDO_ASKPASS: "/usr/bin/ssh-askpass", SSH_ASKPASS: "/usr/bin/ssh-askpass", UNSET: undefined,
};

describe("commandEnv", () => {
  it("removes Ember's own, Electron's, Node's and Copilot's variables and Ember's sign-in token", () => {
    const env = commandEnv(EMBER_ENV, base("linux"));
    for (const k of ["EMBER_USER_DATA", "EMBER_LOG_LEVEL", "EMBER_CMD", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_AGENT_URL"]) {
      expect(env, k).not.toHaveProperty(k);
    }
  });

  it("removes every variable that runs hidden code at a shell's or a program's start", () => {
    const env = commandEnv(EMBER_ENV, base("darwin"));
    for (const k of ["BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "PS1", "PS2", "PS3", "PS4", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH"]) {
      expect(env, k).not.toHaveProperty(k);
    }
    expect(env.LD_BIND_NOW).toBe("1");
  });

  it("removes bash's exported functions and what makes a shell read the command differently than it was classified", () => {
    const given = {
      PATH: "/usr/bin:/bin", "BASH_FUNC_ls%%": "() {  rm -rf ~\n}", "BASH_FUNC_which()": "() { :; }", CDPATH: "/usr",
      SHELLOPTS: "xtrace", BASHOPTS: "extglob:expand_aliases", GLOBIGNORE: "*", IFS: "x", BASH_FUNCTIONS_ARE_MINE: "kept",
    };
    for (const os of ["linux", "darwin"] as const) {
      const env = commandEnv(given, base(os));
      for (const k of ["BASH_FUNC_ls%%", "BASH_FUNC_which()", "CDPATH", "SHELLOPTS", "BASHOPTS", "GLOBIGNORE", "IFS"]) expect(env, `${os} ${k}`).not.toHaveProperty(k);
      expect(env.BASH_FUNCTIONS_ARE_MINE).toBe("kept");
    }
  });

  it("repairs what Electron and an AppImage changed, as appEnv does (critique integration-18)", () => {
    const env = commandEnv(EMBER_ENV, base("linux"));
    expect(env.XDG_CURRENT_DESKTOP).toBe("GNOME");
    for (const k of ["ORIGINAL_XDG_CURRENT_DESKTOP", "CHROME_DESKTOP", "NO_AT_BRIDGE", "APPDIR", "APPIMAGE", "ARGV0", "OWD"]) expect(env, k).not.toHaveProperty(k);
    expect(commandEnv({ XDG_CURRENT_DESKTOP: "GNOME" }, base("linux")).XDG_CURRENT_DESKTOP).toBe("GNOME");
  });

  it("keeps the user's own capabilities: their ssh-agent, their own tool tokens, their session", () => {
    const env = commandEnv(EMBER_ENV, base("linux"));
    expect(env).toMatchObject({ SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh", NPM_TOKEN: "npm_users-own", GH_ENTERPRISE_TOKEN: "users-own", HOME: "/home/ana", LANG: "en_GB.UTF-8", DISPLAY: ":0" });
    expect(env).not.toHaveProperty("UNSET");
  });

  it("removes SSH's session variables only on a remote", () => {
    expect(commandEnv(EMBER_ENV, base("linux"))).toMatchObject({ SSH_CONNECTION: "10.0.0.1 5 10.0.0.2 22", SSH_TTY: "/dev/pts/1" });
    const remote = commandEnv(EMBER_ENV, base("linux", { remote: true }));
    for (const k of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "SSH_ORIGINAL_COMMAND"]) expect(remote, k).not.toHaveProperty(k);
    expect(remote.SSH_AUTH_SOCK).toBe("/run/user/1000/keyring/ssh");
  });

  it("sets the run's marker and TERM by PTY", () => {
    expect(commandEnv(EMBER_ENV, base("linux"))).toMatchObject({ EMBER_RUN_ID: RUN, TERM: "xterm-256color" });
    expect(commandEnv({ TERM: "screen" }, base("linux", { pty: false }))).toMatchObject({ EMBER_RUN_ID: RUN, TERM: "dumb" });
  });

  it("makes programs that want an answer fail at once on runs without a PTY only (critique security-12)", () => {
    const pipes = commandEnv(EMBER_ENV, base("linux", { pty: false }));
    expect(pipes).toMatchObject({ GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never" });
    expect(pipes).not.toHaveProperty("SUDO_ASKPASS");
    expect(pipes).not.toHaveProperty("SSH_ASKPASS");
    const pty = commandEnv(EMBER_ENV, base("linux"));
    for (const k of ["GIT_TERMINAL_PROMPT", "DEBIAN_FRONTEND", "SSH_ASKPASS_REQUIRE"]) expect(pty, k).not.toHaveProperty(k);
    expect(pty.SUDO_ASKPASS).toBe("/usr/bin/ssh-askpass");
  });

  it("appends the extra folders to PATH, once each", () => {
    const env = commandEnv(EMBER_ENV, base("darwin", { extraPath: ["/opt/homebrew/bin", "/usr/local/bin/", "/opt/homebrew/sbin", "/opt/homebrew/bin"] }));
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin");
    expect(commandEnv({}, base("darwin", { extraPath: ["/opt/homebrew/bin"] })).PATH).toBe("/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin");
    expect(commandEnv({}, base("linux"))).not.toHaveProperty("PATH");
  });

  it("compares names without regard to case on Windows, keeping the stored spelling", () => {
    const env = commandEnv({
      Path: "C:\\Windows\\System32;C:\\Tools\\", SystemRoot: "C:\\Windows", Gh_Token: "gho_ember", github_token: "gho_ember", Copilot_Github_Token: "x",
      Node_Options: "--inspect", Ember_Log_Level: "debug", electron_run_as_node: "1", Term: "cygwin", Ember_Run_Id: "old",
      Ssh_Askpass: "x", NPM_TOKEN: "users-own",
    }, base("win32", { pty: false, extraPath: ["c:\\tools", "C:\\Program Files\\Git\\cmd"] }));
    expect(env).toEqual({
      Path: "C:\\Windows\\System32;C:\\Tools\\;C:\\Program Files\\Git\\cmd", SystemRoot: "C:\\Windows",
      Term: "dumb", EMBER_RUN_ID: RUN, NPM_TOKEN: "users-own",
      GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never",
    });
  });

  it("compares names exactly elsewhere, and never changes the environment it was given", () => {
    const given = { gh_token: "lower-case is another variable on Linux", GH_TOKEN: "x", PATH: "/bin" };
    const copy = { ...given };
    const env = commandEnv(given, base("linux"));
    expect(env.gh_token).toBe(given.gh_token);
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(given).toEqual(copy);
  });
});

describe("appendPath and mergeEnv", () => {
  it("leaves PATH alone with nothing to add, and refuses folders that would split it", () => {
    expect(appendPath("/bin", [], "linux")).toBe("/bin");
    expect(appendPath(undefined, [], "linux")).toBeUndefined();
    expect(appendPath("/bin", ["/a:/b", "/c\0", "", "/d"], "linux")).toBe("/bin:/d");
    expect(appendPath("C:\\A", ["C:\\B;C:\\C", "c:\\a\\"], "win32")).toBe("C:\\A");
  });

  it("lays launcher variables over the environment, without duplicates on Windows", () => {
    expect(mergeEnv({ Path: "x", Term: "dumb" }, { TERM: "xterm", EMBER_CMD: "c" }, "win32")).toEqual({ Path: "x", Term: "xterm", EMBER_CMD: "c" });
    expect(mergeEnv({ Term: "dumb" }, { TERM: "xterm" }, "linux")).toEqual({ Term: "dumb", TERM: "xterm" });
  });
});

describe("macExtraPath", () => {
  it("gives Homebrew's folders and /etc/paths(.d) lines that exist, read as data, once each", () => {
    const files: Record<string, string> = {
      "/etc/paths": "/usr/local/bin\n/usr/bin\n/bin\n# a comment\n\n/usr/sbin\nrelative/dir\n",
      "/etc/paths.d/10-cryptex": "/System/Cryptexes/App/usr/bin\n",
      "/etc/paths.d/50-x11": "/opt/X11/bin\n$(touch /tmp/pwned)\n",
      "/etc/paths.d/.hidden": "/hidden\n",
    };
    const dirs = new Set(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/System/Cryptexes/App/usr/bin", "/hidden"]);
    const got = macExtraPath({
      readText: f => files[f] ?? null,
      list: d => (d === "/etc/paths.d" ? ["50-x11", "10-cryptex", ".hidden"] : []),
      isDir: d => dirs.has(d),
    });
    expect(got).toEqual(["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/System/Cryptexes/App/usr/bin"]);
  });

  it("copes with no /etc/paths.d and unreadable folders", () => {
    expect(macExtraPath({ readText: () => null, list: () => { throw new Error("ENOENT"); }, isDir: d => { if (d === "/opt/homebrew/bin") throw new Error("EACCES"); return d === "/usr/local/bin"; } })).toEqual(["/usr/local/bin"]);
  });
});
