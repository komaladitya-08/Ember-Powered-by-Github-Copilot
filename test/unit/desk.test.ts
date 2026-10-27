import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DeskManager, clearDeskLocks, clearDeskLocksNear, freeDisplay, removeTree, running } from "../../app/main/desk/desk";
import { deskRecipe, deskWindowAt, guardX, lockDownLibreOffice } from "../../app/main/desk/place";
import { keysymFor, wheelButtons, xButton } from "../../app/main/desk/view";
import { PolicyEngine } from "../../app/main/policy/policy";
import { appEnv, darkTheme, execArgv, hasBuiltInShell, isTerminalApp, parseDesktopFile, type DesktopApp } from "../../app/main/hands/system";
import type { Logger } from "../../app/main/logger";
import type { Rect, StackedWindow } from "../../app/main/x11";

const app = (id: string, name: string, exec: string, more: Partial<DesktopApp> = {}): DesktopApp => ({ id, name, exec, file: "", keywords: [], ...more });
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
/** A lock file LibreOffice writes beside a document it opens: ",user,host,date,profile URL;". */
const lockFile = (dir: string, name: string, profile: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `.~lock.${name}#`), `,Ana,host,16.10.2026 10:00,${profile};`);
};
const deskProfile = (id: string) => `file:///tmp/${id}/runtime/libreoffice`;
/** The names under `dir`, relative and with "/" between folders whatever the OS (Windows lists them with "\"). */
const listed = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(n => String(n).split(path.sep).join("/"));
const locksIn = (dir: string) => listed(dir).filter(n => path.basename(n).startsWith(".~lock.")).sort();

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
    // The live process table is /proc, which only Linux has (the desk is Linux-only).
    if (process.platform === "linux") expect(running(process.pid)).toBe(true);
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
    // It reads back as the same folder ("#" not taken for a fragment, no space lost), Windows paths too: compared as a
    // path, since Node also escapes "~", which a Windows runner's short temp path (C:\Users\RUNNER~1\…) has.
    expect(fileURLToPath(url)).toBe(path.join(p, "libreoffice"));
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
    // (POSIX modes: Windows has only a read-only flag, which it ignores on folders.)
    if (process.platform !== "win32") expect([mode("basic"), mode("basic/Standard"), mode("basic/Standard/Module1.xba"), mode("Scripts")]).toEqual([0o500, 0o500, 0o400, 0o500]);
    expect(xcu).toContain('<prop oor:name="DisableExtensionInstallation" oor:op="fuse"><value>true</value></prop>');
    expect(xcu).toContain("<value>PackageManager</value>");
    expect(xcu.match(/MacroSecurityLevel/g)).toHaveLength(1);
    expect(xcu).toContain('<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>');
    expect(xcu).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>');
    // Lock files stay on (LibreOffice's "Changed by Others" check needs them); nothing fetched on load.
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>true</value></prop></item>');
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>');
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>');
    expect(xcu.match(/UseLocking/g)).toHaveLength(1);
    for (const c of ["BasicIDEAppear", "MacroDialog", "RunMacro", "ScriptOrganizer"]) expect(xcu.match(new RegExp(`<value>${c}</value>`, "g")), c).toHaveLength(1);
    expect(xcu).toContain('oor:name="FirstRun"');
    expect(xcu).toMatch(/^<\?xml[\s\S]*<\/oor:items>\n$/);
    for (const d of [p, presets]) expect(removeTree(d)).toBe(true);
  });

  it("clears the lock files a desk's LibreOffice left beside documents, never the user's own (DSK9-2)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ember-handoff-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ember-elsewhere-"));
    const lock = (dir: string, name: string, profile: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `.~lock.${name}#`), `,Ana,host,16.10.2026 10:00,${profile};`);
    };
    lock(home, "letter.odt", "file:///tmp/ember-desk-abc123/runtime/libreoffice");
    lock(path.join(home, "Reports", "2026"), "budget.ods", "file:///tmp/ember-desk-abc123/runtime/libreoffice");
    lock(home, "notes.odt", "file:///tmp/ember-desk-zzz999/runtime/libreoffice");
    lock(home, "mine.odt", "file:///home/ana/.config/libreoffice/4");
    lock(elsewhere, "linked.odt", "file:///tmp/ember-desk-abc123/runtime/libreoffice");
    // A junction on Windows: a link to a folder that needs no symlink rights there (other systems ignore the type).
    fs.symlinkSync(elsewhere, path.join(home, "link"), "junction");
    fs.writeFileSync(path.join(home, "letter.odt"), "doc");
    // (Listed without going through the link: what lies behind it is checked on its own below.)
    const left = () => listed(home).filter(n => n.includes(".~lock.") && !n.startsWith("link/")).sort();
    // One desk's (as it stops): only its own.
    expect(clearDeskLocks(home, "ember-desk-abc123")).toBe(2);
    expect(left()).toEqual([".~lock.mine.odt#", ".~lock.notes.odt#"]);
    // Any desk's (as a desk starts): the user's own stays, and nothing behind a link is touched.
    expect(clearDeskLocks(home)).toBe(1);
    expect(left()).toEqual([".~lock.mine.odt#"]);
    expect(fs.existsSync(path.join(elsewhere, ".~lock.linked.odt#"))).toBe(true);
    expect(fs.readFileSync(path.join(home, "letter.odt"), "utf8")).toBe("doc");
    expect(clearDeskLocks(path.join(home, "missing"))).toBe(0);
    for (const d of [home, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("clears a desk's locks beside documents elsewhere in the home folder too, two folders down, never in hidden ones (DSK10-1)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ember-home-"));
    const handOff = path.join(home, "Ember");
    const ours = deskProfile("ember-desk-abc123");
    lockFile(handOff, "result.ods", ours);
    lockFile(path.join(handOff, "a", "b", "c"), "deep.ods", ours); // the hand-off folder: four folders down
    lockFile(home, "top.odt", ours);
    lockFile(path.join(home, "Documents"), "letter.odt", ours);
    lockFile(path.join(home, "Documents", "2026"), "budget.ods", ours);
    lockFile(path.join(home, "Documents", "2026", "Q3"), "far.ods", ours); // three down: not looked for
    lockFile(path.join(home, ".cache", "x"), "hidden.ods", ours); // a hidden folder: not looked in
    lockFile(path.join(home, "Documents"), "mine.odt", "file:///home/ana/.config/libreoffice/4");
    lockFile(path.join(home, "Documents"), "other.odt", deskProfile("ember-desk-zzz999"));
    expect(clearDeskLocksNear(handOff, "ember-desk-abc123", home)).toBe(5);
    expect(locksIn(home)).toEqual([".cache/x/.~lock.hidden.ods#", "Documents/.~lock.mine.odt#", "Documents/.~lock.other.odt#", "Documents/2026/Q3/.~lock.far.ods#"]);
    // Several desks' at once (as Ember exits), a folder left out, a depth.
    expect(clearDeskLocks(home, ["ember-desk-zzz999", "ember-desk-abc123"], { skip: new Set([path.join(home, "Documents")]) })).toBe(1);
    expect(locksIn(home)).toEqual(["Documents/.~lock.mine.odt#", "Documents/.~lock.other.odt#", "Documents/2026/Q3/.~lock.far.ods#"]);
    expect(clearDeskLocks(home, ["ember-desk-zzz999", "ember-desk-abc123"], { depth: 1 })).toBe(1);
    expect(clearDeskLocks(home, [])).toBe(0);
    expect(locksIn(home)).toEqual(["Documents/.~lock.mine.odt#", "Documents/2026/Q3/.~lock.far.ods#"]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("clears its LibreOffice's locks the moment it stops, and as Ember exits, not a moment later (DSK10-1)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-quit-"));
    const home = path.join(root, "home"), handOff = path.join(home, "Ember"), docs = path.join(home, "Documents"), tmp = path.join(root, "tmp");
    for (const d of [handOff, docs, tmp]) fs.mkdirSync(d, { recursive: true });
    // os.homedir() and os.tmpdir() go by these (Windows reads USERPROFILE and TEMP): the real home folder and other
    // desks stay out of it.
    const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { HOME: home, TMPDIR: tmp, USERPROFILE: home, TEMP: tmp, TMP: tmp });
    const before = process.listeners("exit");
    const ids = ["ember-desk-quit01", "ember-desk-quit02"];
    const desks = ids.map(id => {
      const m = new DeskManager(quiet, { handOff });
      const dir = path.join(tmp, id);
      fs.mkdirSync(dir);
      // As if its desk were up, with LibreOffice there (nothing runs: no X server is needed for this).
      Object.assign(m, { id, dir, info: { display: ":0", width: 1, height: 1, env: {}, handOff } });
      return m;
    });
    // Its exit handlers, called here rather than when the test's process exits.
    const exits = process.listeners("exit").filter(l => !before.includes(l)) as (() => void)[];
    for (const l of exits) process.removeListener("exit", l);
    try {
      expect(exits).toHaveLength(2);
      for (const id of ids) { lockFile(handOff, `${id}.ods`, deskProfile(id)); lockFile(docs, `${id}.ods`, deskProfile(id)); }
      lockFile(docs, "mine.ods", "file:///home/ana/.config/libreoffice/4");
      // Ember quits: will-quit stops the desk, and Ember may exit at once. Its locks are gone already, no one else's.
      desks[0].stop();
      expect(locksIn(home)).toEqual(["Documents/.~lock.ember-desk-quit02.ods#", "Documents/.~lock.mine.ods#", "Ember/.~lock.ember-desk-quit02.ods#"]);
      // Ember exits with a desk still up: its locks go as it does.
      exits[1]();
      expect(locksIn(home)).toEqual(["Documents/.~lock.mine.ods#"]);
      // And one its LibreOffice wrote as it ended, after the desk stopped.
      lockFile(handOff, "late.ods", deskProfile(ids[0]));
      exits[0]();
      expect(locksIn(home)).toEqual(["Documents/.~lock.mine.ods#"]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts the desk's LibreOffice dialogs in the hand-off folder, where its locks are cleared (DSK10-1)", () => {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), "ember-lo-work-"));
    const handOff = path.join(p, "Ana & Bo's <docs>", "Ember");
    const profile = path.join(p, "lo");
    lockDownLibreOffice(profile, undefined, handOff);
    lockDownLibreOffice(profile, undefined, handOff); // twice: still one
    const xcu = fs.readFileSync(path.join(profile, "user", "registrymodifications.xcu"), "utf8");
    const url = pathToFileURL(handOff).href;
    expect(url).toContain("&");
    // The items as LibreOffice writes them (Tools > Options > Paths, "My Documents"), with the URL as XML text; the old
    // setting is emptied, or LibreOffice takes it (the home folder) instead.
    expect(xcu).toContain(`<item oor:path="/org.openoffice.Office.Paths/Paths/org.openoffice.Office.Paths:NamedPath['Work']"><prop oor:name="WritePath" oor:op="fuse"><value>${url.replace(/&/g, "&amp;")}</value></prop></item>`);
    expect(xcu).toContain('<item oor:path="/org.openoffice.Office.Common/Path/Current"><prop oor:name="Work" oor:op="fuse"><value xsi:nil="true"/></prop></item>');
    expect(xcu.match(/NamedPath\['Work'\]/g)).toHaveLength(1);
    expect(xcu.match(/Common\/Path\/Current/g)).toHaveLength(1);
    expect(xcu).not.toMatch(/&(?!amp;|lt;|gt;)/);
    // The desk's recipe gives it the desk's hand-off folder.
    const runtime = path.join(p, "runtime");
    // (/home/ana/Ember, or on Windows that folder on the current drive.)
    const deskHandOff = path.resolve("/home/ana/Ember");
    deskRecipe(app("libreoffice-calc", "LibreOffice Calc", "libreoffice --calc %U"), { handOff: deskHandOff, env: { XDG_RUNTIME_DIR: runtime } }, p);
    expect(fs.readFileSync(path.join(runtime, "libreoffice", "user", "registrymodifications.xcu"), "utf8"))
      .toContain(`<prop oor:name="WritePath" oor:op="fuse"><value>${pathToFileURL(deskHandOff).href}</value></prop>`);
    expect(removeTree(p)).toBe(true);
  });

  it("finds a dialog on its desk by where it is when its title isn't its accessible name, and only one there (DSK10-2)", () => {
    // The window manager's frame: a 1 px border and a 20 px title bar.
    const w = (client: number, pid: number | null, title: string, outer: Rect, more: Partial<StackedWindow> = {}): StackedWindow => ({
      id: client + 1000, client, pid, title, wmClass: "mousepad", ...outer, outer,
      inner: { x: outer.x + 1, y: outer.y + 20, width: outer.width - 2, height: outer.height - 21 }, overrideRedirect: false, ...more,
    });
    const at = { x: 321, y: 351, width: 641, height: 134 };
    // Mousepad's "Question" (accessible name) asks whether to replace a file: its X title is empty.
    const question = w(3, 100, "", at);
    const stack = [
      w(1, 100, "*Untitled 1 - Mousepad", { x: 319, y: 147, width: 642, height: 505 }), w(2, 100, "Save As", { x: 92, y: 0, width: 1098, height: 800 }),
      question, w(4, 100, "", at, { overrideRedirect: true }), w(5, 200, "Question", at),
    ];
    expect(deskWindowAt(stack, 100, at)).toBe(3);
    // As toolkits that leave the window manager's frame out report it (Qt), a pixel or two off.
    expect(deskWindowAt(stack, 100, { ...question.inner, x: question.inner.x + 1 })).toBe(3);
    // None of the process's windows is there, or the process has none: nothing.
    expect(deskWindowAt(stack, 100, { x: 600, y: 600, width: 100, height: 50 })).toBe(0);
    expect(deskWindowAt(stack, 300, at)).toBe(0);
    expect(deskWindowAt(stack, 100, { x: 0, y: 0, width: 0, height: 0 })).toBe(0);
    // Two of its windows there: it can't tell which.
    expect(deskWindowAt([...stack, w(6, 100, "", at)], 100, at)).toBe(0);
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
    expect(send.prompt).toBe("Click the “Send” button in Mail on my desk?");
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
