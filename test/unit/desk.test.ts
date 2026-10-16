import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { freeDisplay, removeTree, running } from "../../app/main/desk/desk";
import { deskRecipe, guardX, lockDownLibreOffice } from "../../app/main/desk/place";
import { keysymFor, wheelButtons, xButton } from "../../app/main/desk/view";
import { PolicyEngine } from "../../app/main/policy/policy";
import { appEnv, darkTheme, execArgv, hasBuiltInShell, isTerminalApp, parseDesktopFile, type DesktopApp } from "../../app/main/hands/system";

const app = (id: string, name: string, exec: string, more: Partial<DesktopApp> = {}): DesktopApp => ({ id, name, exec, file: "", keywords: [], ...more });

describe("desk", () => {
  it("picks the first free display number", () => {
    const taken = new Set(["/tmp/.X90-lock", "/tmp/.X11-unix/X91"]);
    expect(freeDisplay(90, { exists: p => taken.has(p), lockPid: () => 4242, alive: () => true })).toBe(92);
  });

  it("reuses a display whose X server is gone (stale lock), but never one that is alive or not ours", () => {
    const files = new Set(["/tmp/.X90-lock", "/tmp/.X11-unix/X90", "/tmp/.X91-lock", "/tmp/.X92-lock", "/tmp/.X93-lock"]);
    const pids: Record<number, number | null> = { 90: 100, 91: 200, 92: null, 93: 300 };
    const removed: string[] = [];
    const probe = {
      exists: (p: string) => files.has(p),
      lockPid: (n: number) => pids[n] ?? null,
      alive: (pid: number) => pid === 200,
      remove: (p: string) => { if (p.includes("93")) return false; files.delete(p); removed.push(p); return true; },
    };
    // :90 is stale (its pid is gone): lock and socket are removed and it is used again.
    expect(freeDisplay(90, probe)).toBe(90);
    expect(removed).toEqual(["/tmp/.X90-lock", "/tmp/.X11-unix/X90"]);
    // :91 alive, :92 unreadable lock, :93 another user's stale lock (can't remove): :94.
    expect(freeDisplay(91, probe)).toBe(94);
  });

  it("knows a child has exited even before Node reaps it", () => {
    const stat = (s: string) => () => `123 (Xvfb (desk) x) ${s} 1 2 3`;
    expect(running(123, stat("S"))).toBe(true);
    expect(running(123, stat("Z"))).toBe(false);
    expect(running(123, () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); })).toBe(false);
    expect(running(undefined)).toBe(false);
    expect(running(process.pid)).toBe(true);
  });

  it("starts apps as Ember's own instances", () => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), "ember-profiles-"));
    expect(deskRecipe(app("firefox", "Firefox", "firefox %u"), { handOff: "/h" }, p)).toEqual(["firefox", "--new-instance", "--profile", path.join(p, "firefox")]);
    expect(fs.statSync(path.join(p, "firefox")).isDirectory()).toBe(true);
    expect(deskRecipe(app("mozilla-thunderbird", "Thunderbird", "thunderbird %u"), { handOff: "/h" }, p)).toEqual(["thunderbird", "--new-instance", "--profile", path.join(p, "thunderbird")]);
    expect(deskRecipe(app("libreoffice-writer", "LibreOffice Writer", "libreoffice --writer %U"), { handOff: "/h" }, p))
      .toEqual(["libreoffice", "--writer", `-env:UserInstallation=${pathToFileURL(path.join(p, "libreoffice")).href}`]);
    // On a desk, LibreOffice's profile is the desk's own (in its runtime folder, gone when it stops).
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "ember-runtime-"));
    expect(deskRecipe(app("libreoffice-calc", "LibreOffice Calc", "libreoffice --calc %U"), { handOff: "/h", env: { XDG_RUNTIME_DIR: runtime } }, p).at(-1))
      .toBe(`-env:UserInstallation=${pathToFileURL(path.join(runtime, "libreoffice")).href}`);
    for (const d of [p, runtime]) removeTree(d);
    expect(deskRecipe(app("org.gnome.gedit", "Text Editor", "gedit %U"), { handOff: "/h" }, p)).toEqual(["gedit"]);
    expect(deskRecipe(app("ember-bench", "Ember Bench", "python3 /src/test/fixtures/gtk3_bench.py"), { handOff: "/h" }, p)).toEqual(["python3", "/src/test/fixtures/gtk3_bench.py"]);
  });

  it("gives LibreOffice a profile URL that survives spaces and other characters in the path", () => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), "ember profiles #1 "));
    const argv = deskRecipe(app("libreoffice-calc", "LibreOffice Calc", "libreoffice --calc %U"), { handOff: "/h" }, p);
    const url = argv.at(-1)!.replace("-env:UserInstallation=", "");
    expect(url).toMatch(/^file:\/\/\/.*%20profiles%20%231%20/);
    expect(new URL(url).pathname).toBe(encodeURI(path.join(p, "libreoffice")).replace(/#/g, "%23"));
    removeTree(p);
  });

  it("runs LibreOffice on the desk with macros off, the macro editors switched off and its macro folders read-only, keeping the rest of its profile", () => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), "ember-lo-"));
    // LibreOffice's presets: a new profile's Basic libraries start as a copy of them.
    const presets = fs.mkdtempSync(path.join(os.tmpdir(), "ember-lo-presets-"));
    fs.mkdirSync(path.join(presets, "basic", "Standard"), { recursive: true });
    fs.writeFileSync(path.join(presets, "basic", "Standard", "Module1.xba"), "<module/>");
    const file = path.join(p, "user", "registrymodifications.xcu");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A profile where someone lowered the macro security on the desk, plus a setting of the user's own.
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry">\n`
      + `<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>\n`
      + `<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>\n</oor:items>\n`);
    lockDownLibreOffice(p, presets);
    lockDownLibreOffice(p, presets); // twice: still one of each
    const xcu = fs.readFileSync(file, "utf8");
    // No macro can be written where LibreOffice runs them from (saving a document over a module, a new script).
    const mode = (f: string) => fs.statSync(path.join(p, "user", f)).mode & 0o777;
    expect(fs.readFileSync(path.join(p, "user", "basic", "Standard", "Module1.xba"), "utf8")).toBe("<module/>");
    expect([mode("basic"), mode("basic/Standard"), mode("basic/Standard/Module1.xba"), mode("Scripts")]).toEqual([0o500, 0o500, 0o400, 0o500]);
    expect(xcu).toContain('<prop oor:name="DisableExtensionInstallation" oor:op="fuse"><value>true</value></prop>');
    expect(xcu).toContain("<value>PackageManager</value>");
    expect(xcu.match(/MacroSecurityLevel/g)).toHaveLength(1);
    expect(xcu).toContain('<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>');
    expect(xcu).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>');
    // No lock file next to what Ember saves (the user's LibreOffice would open it read-only); nothing fetched on load.
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>false</value></prop></item>');
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>');
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>');
    expect(xcu.match(/UseLocking/g)).toHaveLength(1);
    for (const c of ["BasicIDEAppear", "MacroDialog", "RunMacro", "ScriptOrganizer"]) expect(xcu.match(new RegExp(`<value>${c}</value>`, "g")), c).toHaveLength(1);
    expect(xcu).toContain('oor:name="FirstRun"');
    expect(xcu).toMatch(/^<\?xml[\s\S]*<\/oor:items>\n$/);
    for (const d of [p, presets]) expect(removeTree(d)).toBe(true);
  });

  it("never runs terminals", () => {
    expect(() => deskRecipe(app("org.gnome.Terminal", "Terminal", "gnome-terminal"), { handOff: "/h" }, "/p")).toThrow(/terminals/);
    expect(() => deskRecipe(app("xterm", "XTerm", "xterm"), { handOff: "/h" }, "/p")).toThrow(/terminals/);
    expect(() => deskRecipe(app("my-shell", "Quick shell", "sh -c \"exec urxvt -e bash\""), { handOff: "/h" }, "/p")).toThrow(/terminals/);
  });

  it("doesn't run apps with a terminal or shell built in on the desk (VS Code, Emacs, IDEs)", () => {
    expect(() => deskRecipe(app("code", "Visual Studio Code", "/usr/share/code/code --unity-launch %F"), { handOff: "/h" }, "/p")).toThrow(/terminal built in/);
    expect(() => deskRecipe(app("com.visualstudio.code", "Code", "/usr/bin/flatpak run --command=code com.visualstudio.code"), { handOff: "/h" }, "/p")).toThrow(/terminal built in/);
    expect(() => deskRecipe(app("emacs", "Emacs", "emacs %F"), { handOff: "/h" }, "/p")).toThrow(/terminal built in/);
    expect(() => deskRecipe(app("jetbrains-pycharm-ce", "PyCharm Community Edition", "/opt/pycharm/bin/pycharm.sh %f"), { handOff: "/h" }, "/p")).toThrow(/terminal built in/);
  });

  it("maps browser keys and buttons to X", () => {
    const names: Record<string, number> = { Return: 0xff0d, Left: 0xff51, F5: 0xffc2, Control_L: 0xffe3, Control_R: 0xffe4, Shift_R: 0xffe2 };
    const lookup = (n: string) => names[n] ?? 0;
    expect(keysymFor("Enter", lookup)).toBe(0xff0d);
    expect(keysymFor("ArrowLeft", lookup)).toBe(0xff51);
    expect(keysymFor("F5", lookup)).toBe(0xffc2);
    expect(keysymFor("a", lookup)).toBe(0x61);
    expect(keysymFor("é", lookup)).toBe(0);
    expect(keysymFor("Control", lookup, "ControlLeft")).toBe(0xffe3);
    expect(keysymFor("Control", lookup, "ControlRight")).toBe(0xffe4);
    expect(keysymFor("Shift", lookup, "ShiftRight")).toBe(0xffe2);
    // Left, middle, right; back and forward are 8 and 9 in X (not a right click).
    expect([0, 1, 2, 3, 4, 5].map(xButton)).toEqual([1, 2, 3, 8, 9, 0]);
    expect(wheelButtons(0, 1)).toEqual([5]);
    expect(wheelButtons(0, -1)).toEqual([4]);
    expect(wheelButtons(-1, 0)).toEqual([6]);
    expect(wheelButtons(1, 0)).toEqual([7]);
    expect(wheelButtons(0, 0)).toEqual([]);
  });

  it("stops every X call on a dead display (Xlib would end Ember), and never closes it", () => {
    let up = true;
    const calls: string[] = [];
    const conn = { capture: (x: number) => { calls.push(`capture ${x}`); return null; }, close: () => { calls.push("close"); }, width: 7 };
    const g = guardX(conn, () => up);
    g.capture(1);
    expect(g.width).toBe(7);
    up = false;
    expect(() => g.capture(2)).toThrow(/desk has stopped/);
    g.close();
    expect(calls).toEqual(["capture 1"]);
    up = true;
    g.close();
    expect(calls).toEqual(["capture 1", "close"]);
  });

  it("lets Ember use mouse and keys freely on its desk, but still confirms risky buttons and refuses secrets", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({}) });
    expect(e.decide({ taskId: "t", kind: "keys", app: "gedit", window: "w", value: "ctrl+s", onDesk: true }).verdict).toBe("allow");
    expect(e.decide({ taskId: "t", kind: "cursor_click", app: "gedit", window: "w", element: { role: "panel", name: "Canvas" }, onDesk: true }).verdict).toBe("allow");
    expect(e.decide({ taskId: "t", kind: "click", app: "gedit", window: "w", element: { role: "push button", name: "Bold" }, onDesk: true }).verdict).toBe("allow");
    const send = e.decide({ taskId: "t", kind: "click", app: "Mail", window: "w", element: { role: "push button", name: "Send" }, onDesk: true });
    expect(send).toMatchObject({ verdict: "confirm", risky: true });
    // Nothing of the user's is borrowed there: the question says where instead (DK7-2).
    expect(send.prompt).toBe("Click “Send” push button in Mail on my desk?");
    expect(e.decide({ taskId: "t", kind: "keys", app: "gedit", window: "w", value: "ctrl+w", onDesk: true }).prompt).toBe("Press Ctrl+W in gedit on my desk?");
    expect(e.decide({ taskId: "t", kind: "text", app: "x", window: "w", element: { role: "password text", name: "" }, value: "x", onDesk: true }).verdict).toBe("deny");
  });
});

describe("terminals", () => {
  const t = (exec: string, more: Partial<DesktopApp> = {}) => isTerminalApp(app(more.id ?? "some.App", more.name ?? "Some App", exec, more));

  it("knows terminals by program, wherever the Exec line hides it", () => {
    for (const exec of ["uxterm", "urxvt", "/usr/bin/wezterm start", "foot", "kgx", "guake", "gnome-terminal --", "kitty", "alacritty", "tilix", "konsole",
      "terminator", "xfce4-terminal", "mate-terminal", "lxterminal", "qterminal", "st", "cool-retro-term", "blackbox", "terminology", "tilda", "rxvt"]) {
      expect(t(exec), exec).toBe(true);
    }
    expect(t("env FOO=1 kitty")).toBe(true);
    expect(t("nice -n 10 xterm")).toBe(true);
    expect(t("sh -c \"xterm -e top\"")).toBe(true);
    expect(t("bash -c 'cd ~ && exec gnome-terminal'")).toBe(true);
    expect(t("python3 -c \"import os; os.system('xterm')\"")).toBe(true);
    expect(t("python3 /usr/bin/terminator")).toBe(true);
    expect(t("/usr/bin/flatpak run --branch=stable org.gnome.Console")).toBe(true);
    expect(t("exo-open --launch TerminalEmulator")).toBe(true);
  });

  it("knows shells waiting for commands", () => {
    expect(t("bash")).toBe(true);
    expect(t("/bin/sh -i")).toBe(true);
    expect(t("python3")).toBe(true);
    expect(t("tmux")).toBe(true);
  });

  it("knows terminals by desktop id, name, Categories and Terminal=true", () => {
    expect(t("myterm", { id: "org.gnome.Ptyxis" })).toBe(true);
    expect(t("myterm", { id: "debian-uxterm" })).toBe(true);
    expect(t("myterm", { id: "org.gnome.Console" })).toBe(true);
    expect(t("myterm", { name: "Guake Terminal" })).toBe(true);
    expect(t("myterm", { categories: ["System", "TerminalEmulator"] })).toBe(true);
    expect(t("htop", { terminal: true })).toBe(true);
  });

  it("lets ordinary apps (and script apps) through", () => {
    for (const exec of ["gedit %U", "firefox %u", "libreoffice --writer %U", "python3 /opt/bench/gtk3_bench.py", "sh -c \"cd /opt/app && ./run\"",
      "/usr/bin/flatpak run org.gnome.Calculator", "env GDK_BACKEND=x11 gimp %U", "nautilus --new-window %U"]) {
      expect(t(exec), exec).toBe(false);
    }
  });

  it("reads Categories and Terminal from .desktop files", () => {
    const parsed = parseDesktopFile("[Desktop Entry]\nType=Application\nName=XTerm\nExec=xterm\nCategories=System;TerminalEmulator;\nTerminal=false\n");
    expect(parsed).toMatchObject({ name: "XTerm", categories: ["System", "TerminalEmulator"] });
    expect(parsed?.terminal).toBeUndefined();
    expect(parseDesktopFile("[Desktop Entry]\nType=Application\nName=top\nExec=top\nTerminal=true\n")?.terminal).toBe(true);
    // GLib's booleans: "1" is true too (and "0" false).
    expect(parseDesktopFile("[Desktop Entry]\nType=Application\nName=top\nExec=top\nTerminal=1\n")?.terminal).toBe(true);
    expect(parseDesktopFile("[Desktop Entry]\nType=Application\nName=top\nExec=top\nTerminal=0\n")?.terminal).toBeUndefined();
    expect(parseDesktopFile("[Desktop Entry]\nType=Application\nName=x\nExec=x\nNoDisplay=1\n")?.visible).toBe(false);
    // Key-file escapes come off before the Exec line is read.
    expect(parseDesktopFile("[Desktop Entry]\nType=Application\nName=x\nExec=sh\\s-c\\sxterm\n")?.exec).toBe("sh -c xterm");
  });

  it("reads Exec lines as GLib does: quotes, backslashes, comments, field codes", () => {
    const table: [string, string[]][] = [
      ["xterm", ["xterm"]],
      ["'xterm'", ["xterm"]],
      ["\\xterm", ["xterm"]],
      ["x\\ term -e", ["x term", "-e"]],
      ['sh -c "echo \\"hi\\" \\$HOME \\n"', ["sh", "-c", 'echo "hi" $HOME \\n']],
      ["sh -c 'a \"b\" c'", ["sh", "-c", 'a "b" c']],
      ["gedit %U", ["gedit"]],
      ["app --opt=100%% %f", ["app", "--opt=100%"]],
      ["app # a comment", ["app"]],
      ['"/opt/My App/run" ""', ["/opt/My App/run", ""]],
    ];
    for (const [exec, argv] of table) expect(execArgv(exec), exec).toEqual(argv);
  });

  it("follows wrappers to the command they run, and refuses ones that run commands elsewhere or as someone else", () => {
    const terminals = [
      "env -S \"xterm -e bash\"", "env -S'xterm -e bash'", "env --split-string=\"FOO=1 xterm\"", "env -u VAR xterm", "env -C /tmp xterm", "env -i PATH=/bin xterm",
      "env --unset VAR --chdir /tmp xterm", "env -- xterm", "/usr/bin/env -vS 'nice xterm'",
      "timeout 10 xterm", "timeout -s KILL -k 5 10 xterm", "timeout --signal=TERM 10s xterm", "taskset 0x1 xterm", "taskset -c 0,1 xterm",
      "nice -n 5 xterm", "nice -10 xterm", "ionice -c 3 xterm", "stdbuf -o L xterm", "stdbuf --output=L xterm", "setsid -f xterm", "nohup xterm",
      "chrt -f 10 xterm", "chrt --sched-runtime 5 -d 0 xterm", "flock /tmp/l xterm", "flock -w 3 /tmp/l xterm", "flock /tmp/l -c 'exec xterm'", "dbus-launch --exit-with-session xterm",
      "systemd-cat -t x xterm", "firejail --private xterm",
      "systemd-run --user xterm", "systemd-run --user gedit", "sudo gedit", "pkexec gedit", "su -c xterm", "doas gedit", "runuser -u a gedit",
      "gtk-launch org.gnome.Terminal", "gtk-launch org.gnome.gedit", "gio launch /usr/share/applications/xterm.desktop", "xdg-open /usr/share/applications/xterm.desktop",
      "dbus-send --session --dest=org.gnome.Terminal /x org.x.Y", "busctl --user call org.gnome.Terminal /x", "gdbus call --session -d org.x",
      "flatpak run --command=xterm org.gnome.gedit", "flatpak run --command bash org.gnome.gedit", "flatpak --user run --branch=stable --command=sh org.x.Y -c 'xterm'",
      "flatpak enter org.gnome.gedit bash", "flatpak run org.gnome.Console",
      "'xterm'", "\\xterm", "\"/usr/bin/xterm\" -e top", "sh -c 'nohup xterm'", "bash -c \"timeout 5 xterm\"", "python3 -m idlelib", "python3 -m code",
      "env env env env env env env env env env xterm",
      // It always opens a terminal, whatever runs in it.
      "xdg-terminal-exec", "xdg-terminal-exec gedit", "env xdg-terminal-exec",
    ];
    for (const exec of terminals) expect(isTerminalApp(app("some.App", "Some App", exec)), exec).toBe(true);
    const fine = ["env GDK_BACKEND=x11 gimp %U", "timeout 3600 gedit", "nice -n 5 evince %U", "taskset -p 0x1 1234", "flatpak run org.gnome.Calculator",
      "flatpak run --command=gnome-calculator org.gnome.Calculator", "flock /tmp/l gedit", "sh -c \"cd /opt/app && ./run\"", "python3 -m http.server",
      "stdbuf -oL /usr/bin/evince", "env -u GTK_MODULES nautilus --new-window %U", "sh -c 'exec /opt/app/code-runner'"];
    for (const exec of fine) expect(isTerminalApp(app("some.App", "Some App", exec)), exec).toBe(false);
  });

  it("knows apps with a shell or terminal built in, by program, desktop id, name and Categories", () => {
    const shellApps: [string, string, string, string[]?][] = [
      ["emacs", "Emacs", "emacs %F"], ["emacs", "GNU Emacs (GUI)", "/usr/bin/emacs-26.1 %F"], ["xemacs", "XEmacs", "xemacs"], ["gvim", "GVim", "gvim -f %F"],
      ["nvim-qt", "Neovim Qt", "nvim-qt %F"], ["idle3", "IDLE (using Python-3.6)", "idle3"], ["org.thonny.Thonny", "Thonny", "thonny %F"],
      ["spyder3", "Spyder", "spyder3"], ["jetbrains-pycharm-ce", "PyCharm", "/opt/pycharm/bin/pycharm.sh %f"], ["jetbrains-idea", "IntelliJ IDEA", "/opt/idea/bin/idea.sh"],
      ["com.jetbrains.CLion", "CLion", "/app/bin/clion"], ["android-studio", "Android Studio", "/opt/android-studio/bin/studio.sh"],
      ["eclipse", "Eclipse", "/usr/bin/eclipse"], ["org.kde.kate", "Kate", "kate -b %U"], ["geany", "Geany", "geany %F"], ["org.gnome.Builder", "Builder", "gnome-builder"],
      ["code-oss", "Code - OSS", "code-oss %F"], ["codium", "VSCodium", "/usr/share/codium/codium %F"], ["atom", "Atom", "atom %F"], ["sublime_text", "Sublime Text", "/opt/sublime_text/sublime_text %F"],
      ["org.qt-project.qtcreator", "Qt Creator", "qtcreator %F"], ["org.kde.kdevelop", "KDevelop", "kdevelop"], ["lazarus", "Lazarus", "startlazarus"],
      ["netbeans", "Apache NetBeans", "/usr/bin/netbeans"], ["arduino", "Arduino IDE", "arduino"], ["rstudio", "RStudio", "/usr/lib/rstudio/bin/rstudio %F"],
      ["org.octave.Octave", "GNU Octave", "octave --gui"], ["matlab", "MATLAB", "matlab -desktop"], ["jupyter-notebook", "Jupyter Notebook", "jupyter-notebook"],
      ["some.Thing", "Some IDE", "thing", ["Development", "IDE"]],
    ];
    for (const [id, name, exec, categories] of shellApps) {
      expect(hasBuiltInShell({ id, name, exec, ...(categories ? { categories } : {}) }), `${id} ${exec}`).toBe(true);
      expect(isTerminalApp(app(id, name, exec, categories ? { categories } : {})), id).toBe(true);
    }
    // By name only (the policy asks with what the model typed).
    for (const name of ["emacs", "pycharm", "Visual Studio Code", "IDLE"]) expect(isTerminalApp({ id: name, name }), name).toBe(true);
    // Editors without one, office apps and others stay allowed.
    const fine: [string, string, string][] = [["org.gnome.gedit", "Text Editor", "gedit %U"], ["org.kde.kwrite", "KWrite", "kwrite %U"], ["mousepad", "Mousepad", "mousepad %F"],
      ["libreoffice-writer", "LibreOffice Writer", "libreoffice --writer %U"], ["org.gnome.Calculator", "Calculator", "gnome-calculator"],
      ["obs", "OBS Studio", "obs"], ["io.github.qr_code_generator", "QR Code Generator", "qr-code"], ["idle-slayer", "Idle Slayer", "idleslayer"]];
    for (const [id, name, exec] of fine) expect(isTerminalApp(app(id, name, exec)), id).toBe(false);
  });
});

describe("appEnv", () => {
  it("removes Electron's markers so launched apps keep their accessibility", () => {
    const env = appEnv({ NO_AT_BRIDGE: "1", CHROME_DESKTOP: "ember.desktop", ELECTRON_RUN_AS_NODE: "1", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME", XDG_CURRENT_DESKTOP: "Unity", HOME: "/home/a" });
    expect(env).toEqual({ XDG_CURRENT_DESKTOP: "GNOME", HOME: "/home/a" });
  });

  const user = {
    HOME: "/home/a", USER: "a", LOGNAME: "a", SHELL: "/bin/bash", PATH: "/usr/bin", LANG: "de_DE.UTF-8", LC_TIME: "en_GB.UTF-8", TZ: "Europe/Berlin",
    XMODIFIERS: "@im=ibus", GTK_IM_MODULE: "ibus", QT_IM_MODULE: "ibus", XDG_DATA_DIRS: "/usr/share", XDG_CONFIG_DIRS: "/etc/xdg", https_proxy: "http://proxy:3128",
    DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_CONFIG_HOME: "/home/a/.config", XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0",
  };
  const secrets = {
    GH_TOKEN: "x", GITHUB_TOKEN: "x", COPILOT_GITHUB_TOKEN: "x", EMBER_PROVIDER_API_KEY: "x", OPENAI_API_KEY: "x", GOOGLE_API_KEY: "x", NPM_TOKEN: "x",
    npm_config__authToken: "x", AWS_SECRET_ACCESS_KEY: "x", SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh", SSH_AGENT_PID: "1", GPG_AGENT_INFO: "x",
    GNOME_KEYRING_CONTROL: "/run/user/1000/keyring", SESSION_MANAGER: "local/host:@/tmp/.ICE-unix/1", EMBER_USER_DATA: "/x", GH_HOST: "github.example",
    LD_PRELOAD: "/tmp/x.so", ELECTRON_RUN_AS_NODE: "1", NO_AT_BRIDGE: "1", APPIMAGE: "/x", EMBER_BENCH_LOG: "/x",
  };

  it("passes only an allowlist: never Ember's sign-in, keys or the user's agents", () => {
    const env = appEnv({ ...user, ...secrets });
    expect(env).toEqual(user);
  });

  it("gives Ember's desk no user session (it brings its own display, bus and folders)", () => {
    const env = appEnv({ ...user, ...secrets }, { session: false });
    for (const k of ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY"]) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ HOME: "/home/a", PATH: "/usr/bin", LANG: "de_DE.UTF-8", LC_TIME: "en_GB.UTF-8", XMODIFIERS: "@im=ibus", GTK_IM_MODULE: "ibus" });
    for (const k of Object.keys(secrets)) expect(env[k], k).toBeUndefined();
  });
});

describe("dark style on GNOME 3.32", () => {
  it("switches the user's own theme to its dark variant and back, never to another theme", () => {
    expect(darkTheme("Adwaita", true, [])).toBe("Adwaita-dark");
    expect(darkTheme("Adwaita-dark", false, [])).toBe("Adwaita");
    expect(darkTheme("Arc", true, ["Arc", "Arc-Dark"])).toBe("Arc-Dark");
    expect(darkTheme("Arc-Dark", false, ["Arc", "Arc-Dark"])).toBe("Arc");
    expect(darkTheme("Arc-Dark", true, [])).toBe("Arc-Dark");
    // Turning dark off on a light theme leaves it alone (it used to become Adwaita).
    expect(darkTheme("Yaru", false, ["Yaru", "Yaru-dark"])).toBe("Yaru");
    expect(() => darkTheme("HighContrast", true, ["HighContrast"])).toThrow(/no dark version/);
  });
});
