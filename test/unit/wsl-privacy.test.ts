/**
 * The vocabulary union for WSLg windows (design §4.5, critique wsl-9) and the WSL-aware system (§4.8): a
 * "wsl:<distro>:<app>" window is also judged as a Linux app by every name its program goes by (the exe, argv0, argv1,
 * the AT-SPI name, and comm's 15-byte cut-offs), and an unidentified msrdc window by its title with Linux's security
 * words. It only ever refuses more; every other window is judged exactly as before. OS-neutral.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isTerminalApp, isTerminalWindowApp } from "../../app/main/hands/system";
import { isSecurityWindow } from "../../app/main/policy/policy";
import type { AppIdentity, SystemPlatform } from "../../app/main/platform/types";
import { isTruncatedTerminal, linuxNamesOfApp, wslAwarePrivacy, wslAwareSystem } from "../../app/main/wsl/privacy";
import { dropRouter, routerFor } from "../../app/main/wsl/router";
import { geditScene, harness } from "./wsl-fakes";

/** The PC's own checks on Windows, as main builds them (by name, through the catalogue). */
const windowsChecks = {
  isSecurityWindow: (w: { app?: string; title?: string; name?: string }) => isSecurityWindow(w, "win32"),
  isTerminalApp: (a: AppIdentity) => isTerminalWindowApp(a.name ?? a.id, { list: () => [], isTerminalApp: x => isTerminalApp(x, "win32"), appKey: s => s.toLowerCase() }, "win32"),
};
const privacy = wslAwarePrivacy(windowsChecks);
const term = (app: string) => privacy.isTerminalApp({ id: app, name: app });

const routers: ReturnType<typeof harness>[] = [];
afterEach(() => { for (const h of routers.splice(0)) dropRouter(routerFor(h.options)); });

describe("comm's cut-off names", () => {
  it("are a terminal's when they are its first 15 bytes", () => {
    expect(isTruncatedTerminal("gnome-terminal-")).toBe(true);
    expect(isTruncatedTerminal("GNOME-TERMINAL-")).toBe(true);
    expect(isTruncatedTerminal("gnome-terminal")).toBe(false); // 14 bytes: a whole name (and a terminal by name anyway)
    expect(isTruncatedTerminal("gnome-calculato")).toBe(false);
    expect(isTruncatedTerminal("xfce4-terminal")).toBe(false);
  });
});

describe("terminals under WSLg", () => {
  it("are refused by the app's own name, by comm's cut-off and by any name the router saw", async () => {
    for (const app of ["wsl:Ubuntu:gnome-terminal-server", "wsl:ubuntu:gnome-terminal-", "wsl:Ubuntu:xterm", "wsl:Ubuntu:konsole", "wsl:Ubuntu:tilix",
      "wsl:Debian:qterminal", "wsl:Ubuntu:code", "wsl:Ubuntu:emacs", "wsl:Ubuntu:xfce4-terminal"]) {
      expect(term(app), app).toBe(true);
    }
    for (const app of ["wsl:Ubuntu:gedit", "wsl:Ubuntu:gnome-calculator", "wsl:Ubuntu:evince", "wsl:Ubuntu:run.py"]) expect(term(app), app).toBe(false);
    // The same window, as the router saw it: python3 runs run.py, comm says gnome-terminal-, AT-SPI says "Terminal".
    const h = harness();
    routers.push(h);
    h.wsl.add("Ubuntu");
    const s = geditScene(h);
    h.setups.set("Ubuntu", x => { x.frames = [{ ...s.frame, program: "python3.10", argv0: "python3", argv1: "/opt/run.py", comm: "gnome-terminal-", app: "Terminal" }]; });
    await routerFor(h.options, h.deps).refresh();
    expect(linuxNamesOfApp("wsl:Ubuntu:run.py")).toEqual(expect.arrayContaining(["run.py", "gnome-terminal-", "terminal"]));
    expect(term("wsl:Ubuntu:run.py")).toBe(true);
  });

  it("judge an id that is a WSLg app's too (the policy passes the app as both)", () => {
    expect(privacy.isTerminalApp({ id: "wsl:Ubuntu:xterm", name: "xterm (Ubuntu)" })).toBe(true);
  });
});

describe("security windows under WSLg", () => {
  it("are Linux's by any of their names or by their title, identified or not", () => {
    for (const app of ["wsl:Ubuntu:polkit-gnome-authentication-agent-1", "wsl:Ubuntu:pinentry-gnome3", "wsl:Ubuntu:ssh-askpass", "wsl:Ubuntu:gcr-prompter"]) {
      expect(privacy.isSecurityWindow({ app, title: "" }), app).toBe(true);
    }
    expect(privacy.isSecurityWindow({ app: "wsl:Ubuntu:gedit", title: "Authentication Required" })).toBe(true);
    expect(privacy.isSecurityWindow({ app: "msrdc", title: "Authentication Required" })).toBe(true);
    expect(privacy.isSecurityWindow({ app: "msrdc.exe", title: "[sudo] password for ana" })).toBe(true);
    expect(privacy.isSecurityWindow({ app: "msrdc", title: "notes.txt - gedit" })).toBe(false);
    expect(privacy.isSecurityWindow({ app: "wsl:Ubuntu:gedit", title: "notes.txt - gedit" })).toBe(false);
  });
});

describe("every other window", () => {
  it("is judged exactly as the PC's own checks judge it", () => {
    const apps = ["notepad", "cmd", "powershell", "WindowsTerminal", "msedge", "Terminal", "gedit", "consent", "CredentialUIBroker", "explorer", "", "wsl", "wslg"];
    const titles = ["", "Windows Security", "Authentication Required", "User Account Control", "notes"];
    for (const app of apps) {
      expect(privacy.isTerminalApp({ id: app, name: app }), app).toBe(windowsChecks.isTerminalApp({ id: app, name: app }));
      for (const title of titles) expect(privacy.isSecurityWindow({ app, title }), `${app} ${title}`).toBe(windowsChecks.isSecurityWindow({ app, title }));
    }
  });

  it("is never judged more leniently (the union only refuses more)", () => {
    const always = wslAwarePrivacy({ isSecurityWindow: () => true, isTerminalApp: () => true });
    for (const app of ["wsl:Ubuntu:gedit", "msrdc", "notepad"]) {
      expect(always.isSecurityWindow({ app, title: "x" })).toBe(true);
      expect(always.isTerminalApp({ id: app, name: app })).toBe(true);
    }
  });
});

describe("the WSL-aware system", () => {
  const sys = (os: "linux" | "win32") => ({
    os, words: { a: 1 }, paths: { userData: () => "x" },
    apps: { list: () => [], find: () => null, launch: () => undefined, isTerminalApp: () => true, hasBuiltInShell: () => false, programsOf: () => new Set<string>(), appKey: (s: string) => s },
    which(this: { os: string }, cmd: string) { return `${this.os}:${cmd}`; },
  }) as unknown as SystemPlatform;

  it("is the system itself off Windows", () => {
    const linux = sys("linux");
    expect(wslAwareSystem(linux)).toBe(linux);
  });

  it("on Windows swaps in the WSL-aware catalogue and keeps everything else the system's own", () => {
    const win = sys("win32");
    const aware = wslAwareSystem(win);
    expect(aware).not.toBe(win);
    expect(aware.apps).not.toBe(win.apps);
    expect(aware.apps).toBe(aware.apps);
    expect(aware.words).toBe(win.words);
    expect(aware.paths).toBe(win.paths);
    expect(aware.os).toBe("win32");
    expect(aware.which("gh")).toBe("win32:gh");
    // No WSL known: the catalogue's own answers.
    expect(aware.apps.isTerminalApp({ id: "x", name: "x" })).toBe(true);
  });
});
