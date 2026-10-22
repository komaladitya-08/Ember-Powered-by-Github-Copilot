/**
 * The WSL router (design §4.3, §4.4, §4.6; critiques wsl-7, wsl-8, wsl-16, wsl-20): one helper per running distro with
 * a WSLg window on screen, started only after an uncached running list names the distro (never booting it), never
 * revived on its own, never routed to when it runs as root, its bus chosen by the RAIL titles, stopped after 60 s
 * without a RAIL window, when the distro stops or WSL goes off; identities trusted for 2 s. OS-neutral fakes.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner, RunnerFacts, RunningCommand, RunSpec } from "../../app/main/commands/types";
import {
  A11Y_FIX_COMMAND, DIAG_SCRIPT, fixedScriptStdin, helperLaunch, helperScriptPath, parseDiag, parseHelperStatus, parseLinuxPath, runFixedScript, turnOnLinuxAccessibility,
  WSLPATH_SCRIPT,
  type SpawnLike,
} from "../../app/main/wsl/launch-sidecar";
import { geditScene, harness, RDP_MSRDC, stacked, WSLG_MSRDC, type FrameSpec } from "./wsl-fakes";
import {
  doctorHelperRows, IDENTITY_MS, IDLE_MS, linuxApp, linuxFrame, linuxNames, parseWslPath, routerFor, stopWslHelpers, wslHelperPids, wslNamesOf, dropRouter, WslRouter,
} from "../../app/main/wsl/router";
import type { Logger } from "../../app/main/logger";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet, file: "" };

const made: WslRouter[] = [];
function router(h: ReturnType<typeof harness>): WslRouter {
  const r = routerFor(h.options, h.deps);
  made.push(r);
  return r;
}
afterEach(() => { for (const r of made.splice(0)) dropRouter(r); });

/** Ubuntu running, gedit's RAIL window on screen, its helper listing gedit's frame. */
function ubuntu(o: Parameters<typeof harness>[0] = {}) {
  const h = harness(o);
  h.wsl.add("Ubuntu");
  const s = geditScene(h);
  h.setups.set("Ubuntu", helper => { helper.frames = [s.frame]; });
  return { h, s, r: router(h) };
}

describe("when WSL isn't in use", () => {
  it("starts nothing and identifies nothing off Windows, with WSL off, or without a WSL service", async () => {
    for (const setup of [{ os: "linux" as const }, { on: false }, {}]) {
      const { h, r } = ubuntu(setup);
      if (Object.keys(setup).length === 0) h.state.service = false;
      const s = await r.refresh();
      expect(s.windows.size).toBe(0);
      expect(r.identityNow(11, 4242, true)).toBeNull();
      expect(h.created).toEqual([]);
      expect(h.wsl.runningNowCalls).toBe(0);
    }
  });
});

describe("identifying a WSLg window", () => {
  it("starts the distro's helper after an uncached running list, checks it, chooses its bus by the RAIL titles, and matches", async () => {
    const { h, r } = ubuntu();
    const s = await r.refresh();
    const helper = h.helperOf("Ubuntu")!;
    expect(h.wsl.runningNowCalls).toBe(1);
    expect(helper.calls.map(c => c.method)).toEqual(["status", "find_bus", "list_windows"]);
    expect(helper.calls[1].params).toEqual({ titles: ["notes.txt - gedit"] });
    expect(s.windows.get(11)).toMatchObject({ app: "wsl:Ubuntu:gedit", pid: 4242, distro: "Ubuntu", path: "wsl:Ubuntu:700:/org/a11y/atspi/accessible/1", transform: { k: 1, dx: 74, dy: 177 } });
    expect(r.identityNow(11, 4242, false)).toBe("wsl:Ubuntu:gedit");
    // The same HWND with another process (a reused handle) isn't it.
    expect(r.identityNow(11, 4243, false)).toBeNull();
  });

  it("leaves a Remote Desktop client's msrdc windows alone (its image isn't WSL's)", async () => {
    const { h, r } = ubuntu();
    h.images[4242] = RDP_MSRDC;
    expect((await r.refresh()).windows.size).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("never boots a distro: a stopped one gets no helper, and nothing is started when the running list can't be read", async () => {
    const { h, r } = ubuntu();
    h.wsl.distros[0].running = false;
    expect((await r.refresh()).windows.size).toBe(0);
    expect(h.created).toEqual([]);
    h.wsl.distros[0].running = true;
    h.wsl.service.runningNow = async () => { throw new Error("wsl.exe failed"); };
    expect((await r.refresh()).windows.size).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("never routes to a helper reporting uid 0 (whatever the registry says), stops it and doesn't start it again while the distro runs", async () => {
    const { h, r } = ubuntu();
    h.setups.set("Ubuntu", helper => { helper.uid = 0; helper.frames = [geditScene(h).frame]; });
    expect((await r.refresh()).windows.size).toBe(0);
    const helper = h.helperOf("Ubuntu")!;
    expect(helper.stopped).toBe(1);
    expect(helper.calls.map(c => c.method)).toEqual(["status"]);
    h.state.now += 120_000;
    await r.refresh();
    expect(h.created).toEqual(["Ubuntu"]);
    expect(r.pids()).toEqual([]);
  });

  it("knows a distro WSL reports as root without starting anything there", async () => {
    const h = harness();
    h.wsl.add("Ubuntu", { defaultUid: 0 });
    geditScene(h);
    const r = router(h);
    expect((await r.refresh()).windows.size).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("stops a helper in a distro without WSLg or without pyatspi", async () => {
    for (const set of [(x: { wslg: boolean }) => { x.wslg = false; }, (x: { pyatspi: boolean }) => { x.pyatspi = false; }]) {
      const { h, r } = ubuntu();
      h.setups.set("Ubuntu", helper => set(helper as never));
      expect((await r.refresh()).windows.size).toBe(0);
      expect(h.helperOf("Ubuntu")!.stopped).toBe(1);
    }
  });

  it("leaves windows unidentified when the helper found no bus, and asks find_bus again for a new window that matches nothing", async () => {
    const { h, r } = ubuntu();
    h.setups.set("Ubuntu", helper => { helper.bus = "none"; });
    expect((await r.refresh()).windows.size).toBe(0);
    const helper = h.helperOf("Ubuntu")!;
    expect(helper.calls.map(c => c.method)).toEqual(["status", "find_bus"]);
    expect(helper.stopped).toBe(0);
  });

  it("asks find_bus again (at most every 5 s) when a RAIL window appears that matches nothing, and starts over when another bus fits", async () => {
    const { h, r } = ubuntu();
    await r.refresh();
    const helper = h.helperOf("Ubuntu")!;
    h.windows.stack.push(stacked(12, 4242, "Calculator (Ubuntu)", "msrdc", { x: 0, y: 0, width: 300, height: 400 }));
    h.state.now += 6000;
    await r.refresh();
    await new Promise(res => setTimeout(res, 0));
    expect(helper.calls.filter(c => c.method === "find_bus").map(c => c.params)).toEqual([{ titles: ["notes.txt - gedit"] }, { titles: ["notes.txt - gedit", "Calculator"] }]);
    // Not again for the same window.
    h.state.now += 6000;
    await r.refresh();
    await new Promise(res => setTimeout(res, 0));
    expect(helper.calls.filter(c => c.method === "find_bus")).toHaveLength(2);
    // Another bus fits better and the helper has the old one loaded: it is stopped, and a new process starts.
    helper.restartOnce = true;
    h.windows.stack.push(stacked(13, 4242, "Files (Ubuntu)", "msrdc", { x: 0, y: 0, width: 300, height: 400 }));
    h.state.now += 6000;
    await r.refresh();
    await new Promise(res => setTimeout(res, 0));
    expect(helper.stopped).toBe(1);
    h.state.now += 6000;
    await r.refresh();
    expect(h.wsl.runningNowCalls).toBe(2);
  });

  it("doesn't start a helper again on every look when it was ended while choosing its bus", async () => {
    const { h, r } = ubuntu();
    h.setups.set("Ubuntu", helper => { helper.findBusTooLong = true; });
    expect((await r.refresh()).windows.size).toBe(0);
    const helper = h.helperOf("Ubuntu")!;
    for (let i = 0; i < 3; i++) {
      h.state.now += IDENTITY_MS + 1;
      await r.refresh();
    }
    expect(helper.calls.filter(c => c.method === "status")).toHaveLength(1);
    expect(h.wsl.runningNowCalls).toBe(1);
    // Later it is tried again, with every check.
    h.setups.set("Ubuntu", x => { x.frames = [geditScene({ ...h, windows: { stack: [] } } as never).frame]; });
    h.state.now += 30_000;
    expect((await r.refresh()).windows.size).toBe(1);
    expect(h.wsl.runningNowCalls).toBe(2);
  });

  it("restarts a helper only through the checks, never on its own (critique wsl-20)", async () => {
    const { h, r } = ubuntu();
    await r.refresh();
    const helper = h.helperOf("Ubuntu")!;
    helper.crash();
    // Nothing the router didn't ask for may start it: its mayStart is closed.
    await expect(helper.listWindows()).rejects.toThrow("accessibility helper not running");
    h.state.now += IDENTITY_MS + 1;
    const s = await r.refresh();
    expect(h.wsl.runningNowCalls).toBe(2);
    expect(helper.calls.filter(c => c.method === "status")).toHaveLength(2);
    expect(s.windows.size).toBe(1);
  });

  it("hides never-look apps (KeePassXC, Seahorse, polkit): unidentified, so masked and refused, and out of every list", async () => {
    const h = harness();
    h.wsl.add("Ubuntu");
    geditScene(h);
    h.windows.stack.push(stacked(12, 4242, "Passwords.kdbx - KeePassXC", "msrdc", { x: 900, y: 0, width: 600, height: 400 }));
    const keepass: FrameSpec = { pid: 800, path: "/org/a11y/atspi/accessible/9", app: "KeePassXC", name: "Passwords.kdbx - KeePassXC", program: "keepassxc", bounds: { x: 0, y: 0, width: 600, height: 400 }, children: [{ x: 0, y: 0, width: 600, height: 400 }] };
    h.setups.set("Ubuntu", helper => { helper.frames = [geditScene({ ...h, windows: { stack: [] } } as never).frame, keepass]; });
    const r = router(h);
    const s = await r.refresh();
    expect([...s.windows.keys()]).toEqual([11]);
    expect(s.hidden.get(12)).toEqual({ distro: "Ubuntu", linuxPid: 800 });
    expect(r.skipPids("Ubuntu")).toEqual([800]);
    // The user's own list names gedit: its Linux process is skipped too (never a Windows pid).
    expect(r.skipPids("Ubuntu", ["gedit"]).sort()).toEqual([700, 800]);
    expect(r.skipPids("Debian", ["gedit"])).toEqual([]);
    expect(r.identityNow(12, 4242, true)).toBeNull();
  });

  it("trusts an identity for 2 s, then starts a new look and says nothing until it comes", async () => {
    const { h, r } = ubuntu();
    await r.refresh();
    h.state.now += IDENTITY_MS + 1;
    expect(r.identityNow(11, 4242, false)).toBeNull();
    await new Promise(res => setTimeout(res, 0));
    await r.refresh();
    expect(r.identityNow(11, 4242, false)).toBe("wsl:Ubuntu:gedit");
  });

  it("gives popups the identity of the window they belong to, for the stack only", async () => {
    const { h, r } = ubuntu({ owners: { 12: 11 } });
    h.windows.stack.push(stacked(12, 4242, "", "msrdc", { x: 120, y: 250, width: 200, height: 300 }, { overrideRedirect: true }));
    const s = await r.refresh();
    expect(s.popups.get(12)).toBe(11);
    expect(r.identityNow(12, 4242, true)).toBe("wsl:Ubuntu:gedit");
    expect(r.identityNow(12, 4242, false)).toBeNull();
  });

  it("starts nothing while WSL is on without the WSL card's consent (none, or an older card's)", async () => {
    const { h, r } = ubuntu();
    h.state.consent = 0;
    expect((await r.refresh()).windows.size).toBe(0);
    expect(r.active()).toBe(false);
    expect(h.created).toEqual([]);
    expect(h.wsl.runningNowCalls).toBe(0);
    h.state.consent = 1;
    expect((await r.refresh()).windows.size).toBe(1);
  });

  it("asks find_bus again (at most every 5 s) while no bus showed the windows, and identifies them once one does", async () => {
    const { h, r } = ubuntu();
    h.setups.set("Ubuntu", helper => { helper.bus = "none"; helper.frames = [geditScene({ ...h, windows: { stack: [] } } as never).frame]; });
    expect((await r.refresh()).windows.size).toBe(0);
    const helper = h.helperOf("Ubuntu")!;
    // Too soon: not asked again.
    h.state.now += IDENTITY_MS + 1;
    expect((await r.refresh()).windows.size).toBe(0);
    expect(helper.calls.filter(c => c.method === "find_bus")).toHaveLength(1);
    // gedit has joined its accessibility bus since.
    helper.bus = "proc";
    h.state.now += 5000;
    const s = await r.refresh();
    expect(helper.calls.filter(c => c.method === "find_bus")).toHaveLength(2);
    expect(s.windows.get(11)?.app).toBe("wsl:Ubuntu:gedit");
    expect(h.created).toEqual(["Ubuntu"]);
  });

  it("hides a window the user's never-look list names by any name its app goes by (comm, argv), not only its app id", async () => {
    const h = harness();
    h.wsl.add("Ubuntu");
    geditScene(h);
    h.windows.stack.push(stacked(12, 4242, "My notes", "msrdc", { x: 900, y: 0, width: 600, height: 400 }));
    const vault: FrameSpec = {
      pid: 801, path: "/org/a11y/atspi/accessible/7", app: "Electron", name: "My notes", program: "electron", argv0: "electron",
      argv1: "/opt/vault/resources/app.asar", comm: "vault-desktop", bounds: { x: 0, y: 0, width: 600, height: 400 }, children: [{ x: 0, y: 0, width: 600, height: 400 }],
    };
    h.setups.set("Ubuntu", helper => { helper.frames = [geditScene({ ...h, windows: { stack: [] } } as never).frame, vault]; });
    const r = router(h);
    expect((await r.refresh()).windows.get(12)?.app).toBe("wsl:Ubuntu:electron");
    h.state.neverLook = ["vault-desktop"];
    h.state.now += IDENTITY_MS + 1;
    const s = await r.refresh();
    expect(s.windows.has(12)).toBe(false);
    expect(s.hidden.get(12)).toEqual({ distro: "Ubuntu", linuxPid: 801 });
    expect(r.identityNow(12, 4242, true)).toBeNull();
    expect([...s.windows.keys()]).toEqual([11]);
  });

  it("doesn't give a root distro's msrdc to the one distro it reads from because it is the only one it may read", async () => {
    const h = harness();
    h.wsl.add("Ubuntu").add("kali-linux", { defaultUid: 0 });
    const s = geditScene(h, { hwnd: 21, pid: 4300, title: "" });
    // Ubuntu's gedit is its active window (minimised on Windows); Kali's untitled window, the same size, has the focus.
    h.windows.foreground = 21;
    h.setups.set("Ubuntu", helper => { helper.frames = [{ ...s.frame, active: true }]; });
    const r = router(h);
    const snap = await r.refresh();
    expect(snap.windows.size).toBe(0);
    expect(r.identityNow(21, 4300, false)).toBeNull();
  });
});

describe("several distros", () => {
  it("asks each running WSL 2 distro and gives each msrdc to the one whose frames name its windows, then keeps that", async () => {
    const h = harness();
    h.wsl.add("Ubuntu").add("Debian").add("Legacy", { version: 1 }).add("podman-machine-default", { tool: "podman" });
    const s = geditScene(h);
    h.setups.set("Ubuntu", helper => { helper.frames = [s.frame]; });
    h.setups.set("Debian", helper => { helper.frames = [{ ...s.frame, name: "xeyes" }]; });
    const r = router(h);
    const snap = await r.refresh();
    expect(h.created.sort()).toEqual(["Debian", "Ubuntu"]);
    expect(snap.windows.get(11)?.distro).toBe("Ubuntu");
    h.state.now += IDENTITY_MS + 1;
    await r.refresh();
    expect(h.helperOf("Debian")!.calls.filter(c => c.method === "list_windows")).toHaveLength(1);
  });

  it("gives a distro that just started its own msrdc while the cached running set still says it's stopped, and asks again which msrdc was whose", async () => {
    const h = harness();
    h.wsl.add("Ubuntu").add("Debian", { running: false });
    const s = geditScene(h);
    h.setups.set("Ubuntu", helper => { helper.frames = [s.frame]; });
    const r = router(h);
    expect((await r.refresh()).windows.get(11)?.app).toBe("wsl:Ubuntu:gedit");
    // The user opens gedit in Debian: it boots and its own msrdc shows the window, while WA's 2 s cache of the running set
    // (what isRunning answers) still says it's stopped. As in WA's service, an uncached read refreshes that cache.
    let cached = new Set(["Ubuntu"]);
    const truth = () => new Set(h.wsl.distros.filter(d => d.running).map(d => d.name));
    h.wsl.service.isRunning = n => cached.has(n);
    h.wsl.service.runningNow = async () => { h.wsl.runningNowCalls++; cached = truth(); return truth(); };
    h.wsl.distros[1].running = true;
    geditScene(h, { hwnd: 21, pid: 4300, title: "notes.txt - gedit (Debian)", inner: { x: 1000, y: 200, width: 800, height: 600 } });
    h.setups.set("Debian", helper => { helper.frames = [s.frame]; });
    h.state.now += IDENTITY_MS + 1;
    let snap = await r.refresh();
    expect(snap.windows.get(21)?.app).toBe("wsl:Debian:gedit");
    expect(snap.windows.get(11)?.app).toBe("wsl:Ubuntu:gedit");
    // Later looks (the cache refreshed in the background meanwhile) keep both right.
    cached = truth();
    for (let i = 0; i < 3; i++) {
      h.state.now += IDENTITY_MS + 1;
      snap = await r.refresh();
    }
    expect(snap.windows.get(21)?.app).toBe("wsl:Debian:gedit");
    expect(snap.windows.get(11)?.app).toBe("wsl:Ubuntu:gedit");
    expect(h.created.sort()).toEqual(["Debian", "Ubuntu"]);
  });

  it("identifies nothing when two distros' frames both name the windows (and the title doesn't say which)", async () => {
    const h = harness();
    h.wsl.add("Ubuntu").add("Debian");
    const s = geditScene(h, { title: "notes.txt - gedit" });
    for (const d of ["Ubuntu", "Debian"]) h.setups.set(d, helper => { helper.frames = [s.frame]; });
    const r = router(h);
    expect((await r.refresh()).windows.size).toBe(0);
  });
});

describe("the lifecycle", () => {
  it("stops a helper after 60 s without its distro's RAIL windows, and keeps it while they are on screen", async () => {
    const { h, r } = ubuntu();
    await r.refresh();
    expect(h.tickers).toHaveLength(1);
    h.state.now += IDLE_MS + 1;
    h.tickers[0]();
    expect(h.helperOf("Ubuntu")!.stopped).toBe(0);
    h.windows.stack = [];
    h.state.now += IDLE_MS + 1;
    h.tickers[0]?.();
    expect(h.helperOf("Ubuntu")!.stopped).toBe(1);
    expect(h.tickers).toHaveLength(0);
  });

  it("stops helpers when the distro stops or WSL is turned off", async () => {
    const { h, r } = ubuntu();
    await r.refresh();
    h.wsl.stop("Ubuntu");
    expect(h.helperOf("Ubuntu")!.stopped).toBe(1);
    h.wsl.distros[0].running = true;
    h.state.now += IDENTITY_MS + 1;
    await r.refresh();
    h.state.on = false;
    h.tickers[0]();
    expect(h.helpers.map(x => x.stopped)).toEqual([1, 1]);
  });

  it("is stopped by the kill switch's part and names its processes (Ember's own)", async () => {
    const { h, r } = ubuntu();
    await r.refresh();
    expect(wslHelperPids()).toEqual([h.helperOf("Ubuntu")!.pid]);
    stopWslHelpers();
    expect(h.helperOf("Ubuntu")!.stopped).toBe(1);
    expect(wslHelperPids()).toEqual([]);
  });
});

describe("what a distro says", () => {
  it("keeps only well-formed frames (fail closed on anything malformed)", () => {
    expect(linuxFrame({ pid: 7, path: "/a", app: "gedit", name: "x", children: [{ x: 1, y: 2, width: 3, height: 4 }, { x: "no" }], program: "gedit", comm: "x".repeat(40) }))
      .toEqual({ pid: 7, path: "/a", app: "gedit", name: "x", role: "", active: false, bounds: null, children: [{ x: 1, y: 2, width: 3, height: 4 }], program: "gedit", comm: "x".repeat(16) });
    for (const bad of [null, "x", {}, { path: "relative" }, { path: 5 }, { path: "/a\nb" }]) expect(linuxFrame(bad)).toBeNull();
    expect(linuxFrame({ pid: -1, path: "/a", program: "a\u0007b" })).toMatchObject({ pid: null });
    expect(linuxFrame({ pid: -1, path: "/a", program: "a\u0007b" })?.program).toBeUndefined();
  });

  it("names the app by its program, an interpreter's script, else the AT-SPI name; and keeps every name for the vocabulary", () => {
    expect(linuxApp({ program: "gedit", app: "gedit" })).toBe("gedit");
    expect(linuxApp({ program: "python3.10", argv1: "/usr/bin/terminator", app: "Terminator" })).toBe("terminator");
    expect(linuxApp({ program: "python3", argv1: "-m", app: "My App" })).toBe("my-app");
    expect(linuxApp({ app: "" })).toBeNull();
    expect(linuxApp({ program: "evil:name", app: "" })).toBe("evil-name");
    // Invisible characters (zero-width, bidi overrides) never reach an app id or hide a name from the vocabulary.
    expect(linuxApp({ program: "ged\u202eit\u200b", app: "" })).toBe("gedit");
    expect(linuxNames({ program: "gnome\u200b-terminal-server", app: "Ter\u2060minal" })).toEqual(["gnome-terminal-server", "terminal"]);
    expect(linuxNames({ program: "python3.10", argv0: "/usr/bin/python3", argv1: "/usr/bin/terminator", comm: "terminator", app: "Terminator" }))
      .toEqual(["python3.10", "python3", "terminator"]);
  });

  it("reads its own window paths back", () => {
    expect(parseWslPath("wsl:Ubuntu:700:/org/a11y/atspi/accessible/1")).toEqual({ distro: "Ubuntu", pid: 700, path: "/org/a11y/atspi/accessible/1" });
    for (const bad of ["wsl:Ubuntu:/x", "wsl::7:/x", "wsl:Ub untu:7:/x", "/org/a11y", "wsl:Ubuntu:7:x"]) expect(parseWslPath(bad)).toBeNull();
  });

  it("remembers every Linux name an app went by, for the vocabulary union", async () => {
    const h = harness();
    h.wsl.add("Ubuntu");
    const s = geditScene(h);
    h.setups.set("Ubuntu", helper => { helper.frames = [{ ...s.frame, program: "python3.10", argv0: "python3", argv1: "/opt/tool/run.py", comm: "gnome-terminal-", app: "Terminal" }]; });
    const r = router(h);
    const snap = await r.refresh();
    expect(snap.windows.get(11)?.app).toBe("wsl:Ubuntu:run.py");
    expect(wslNamesOf("WSL:ubuntu:run.py").sort()).toEqual(["gnome-terminal-", "python3", "python3.10", "run.py", "terminal"]);
  });
});

describe("the doctor's rows", () => {
  it("looks only inside running WSL 2 distros, and says why Linux apps can't be read", async () => {
    const h = harness({ diag: { uid: 1000, wslg: true, python3: true, pyatspi: false, a11y: false, pm: "dnf" } });
    h.wsl.add("Fedora").add("Stopped", { running: false }).add("Old", { version: 1 });
    const rows = await router(h).doctorRows();
    expect(rows).toEqual([
      { id: "wsl-helper:Fedora", status: "warn", label: "Linux apps in Fedora", detail: "To read Linux apps in Fedora, install the accessibility packages there: `sudo dnf install python3-pyatspi at-spi2-core`, then reopen your Linux apps." },
      { id: "wsl-a11y:Fedora", status: "warn", label: "Accessibility in Fedora", detail: "Linux apps in Fedora don't share their controls (toolkit accessibility is off)", fix: "Turn on accessibility for Linux apps in Fedora" },
    ]);
  });

  it("fails when the helper is missing from this install, and says when a distro runs as root", async () => {
    const missing = harness({ problem: "missing" });
    missing.wsl.add("Ubuntu");
    expect(await router(missing).doctorRows()).toEqual([{ id: "wsl-helper:Ubuntu", status: "fail", label: "Linux apps in Ubuntu", detail: "Missing from this install: reinstall Ember." }]);
    const root = harness({ diag: { uid: 0, wslg: true, python3: true, pyatspi: true, a11y: true, pm: "apt-get" } });
    root.wsl.add("Ubuntu");
    expect(await router(root).doctorRows()).toEqual([{ id: "wsl-helper:Ubuntu", status: "warn", label: "Linux apps in Ubuntu", detail: "Ember doesn't use Linux apps of a distro that runs as root." }]);
  });

  it("says all is well where it is", async () => {
    const h = harness({ diag: { uid: 1000, wslg: true, python3: true, pyatspi: true, a11y: true, pm: "apt-get" } });
    h.wsl.add("Ubuntu");
    expect(await router(h).doctorRows()).toEqual([
      { id: "wsl-helper:Ubuntu", status: "ok", label: "Linux apps in Ubuntu", detail: "Ember can read Linux apps in Ubuntu" },
      { id: "wsl-a11y:Ubuntu", status: "ok", label: "Accessibility in Ubuntu", detail: "Linux apps in Ubuntu share their controls" },
    ]);
  });
});

describe("the doctor's rows without a running router (ember --doctor, INT)", () => {
  it("looks inside running distros through a short-lived router and lets it go", async () => {
    const h = harness({ diag: { uid: 1000, wslg: true, python3: true, pyatspi: true, a11y: false, pm: "apt-get" } });
    h.wsl.add("Ubuntu");
    const rows = await doctorHelperRows({ os: "win32", log: quiet, wsl: h.wsl.service, resourcesPath: null, appDir: null, env: {}, helpers: h.deps.helpers });
    expect(rows.map(r => [r.id, r.status])).toEqual([["wsl-helper:Ubuntu", "ok"], ["wsl-a11y:Ubuntu", "warn"]]);
    // It stops watching WSL when it is done, and starts no helper.
    expect(h.wsl.listeners).toEqual([]);
    expect(h.created).toEqual([]);
    expect(await doctorHelperRows({ os: "linux", log: quiet, wsl: h.wsl.service, resourcesPath: null, appDir: null, env: {}, helpers: h.deps.helpers })).toEqual([]);
  });
});

describe("WSLg images", () => {
  it("are WSL's own msrdc (the fakes use the paths remote-surface.ts knows)", () => {
    expect(WSLG_MSRDC).toContain("WSL");
  });
});

describe("the helper's launch (§4.3)", () => {
  const jobHost = { execPath: "C:\\Ember\\Ember.exe", script: "C:\\Ember\\resources\\app\\dist\\app\\job-host.cjs" };
  const env = { Path: "C:\\Windows", WslEnv: "USERPROFILE/p", GH_TOKEN: "ghp_secret", EMBER_LOG_LEVEL: "debug", EMBER_ADMIN_POLICY: "x", NODE_OPTIONS: "--inspect" };

  it("is wsl.exe -d <distro> --cd ~ --exec /usr/bin/env EMBER_ATSPI_FIND_BUS=1 python3 -I <script>, under the job host, never a shell", () => {
    const mayStart = () => true;
    const l = helperLaunch({ wslExe: "C:\\Program Files\\WSL\\wsl.exe", distro: "Ubuntu", scriptLinuxPath: "/mnt/c/Ember/resources/sidecar/atspi/ember_atspi.py", env, jobHost, mayStart });
    expect(l.command).toBe(jobHost.execPath);
    expect(l.args).toEqual([jobHost.script, "--interactive", "--", "C:\\Program Files\\WSL\\wsl.exe", "-d", "Ubuntu", "--cd", "~", "--exec", "/usr/bin/env", "EMBER_ATSPI_FIND_BUS=1", "python3", "-I", "/mnt/c/Ember/resources/sidecar/atspi/ember_atspi.py"]);
    expect(l).toMatchObject({ firstRequestMs: 15_000, windowsHide: true, noRevive: true, mayStart });
    // Ember's secrets and switches stay behind; only the id base crosses into Linux (WSLENV replaced, any spelling).
    expect(l.env).toEqual({ Path: "C:\\Windows", EMBER_LOG_LEVEL: "debug", WSL_UTF8: "1", WSLENV: "EMBER_ATSPI_ID_BASE/u", ELECTRON_RUN_AS_NODE: "1" });
    const bare = helperLaunch({ wslExe: "C:\\Windows\\System32\\wsl.exe", distro: "Debian", scriptLinuxPath: "/x.py", env: {}, jobHost: null, mayStart });
    expect([bare.command, ...bare.args]).toEqual(["C:\\Windows\\System32\\wsl.exe", "-d", "Debian", "--cd", "~", "--exec", "/usr/bin/env", "EMBER_ATSPI_FIND_BUS=1", "python3", "-I", "/x.py"]);
    expect(bare.env).toEqual({ WSL_UTF8: "1", WSLENV: "EMBER_ATSPI_ID_BASE/u" });
  });

  it("translates the script's path with wslpath, the path on stdin in a quoted here-document of the fixed script (never on argv)", async () => {
    const runs: { command: string; args: string[]; stdin: string; ended?: boolean }[] = [];
    const spawn = fakeSpawn(runs, "/mnt/c/Ember/resources/sidecar/atspi/ember_atspi.py\n", 0);
    const out = await runFixedScript({ wslExe: "C:\\WSL\\wsl.exe", distro: "Ubuntu", script: WSLPATH_SCRIPT, input: ["C:\\Ember\\resources\\sidecar\\atspi\\ember_atspi.py"], env: {}, jobHost, spawn });
    expect(parseLinuxPath(out)).toBe("/mnt/c/Ember/resources/sidecar/atspi/ember_atspi.py");
    expect(runs[0].args).toEqual([jobHost.script, "--interactive", "--", "C:\\WSL\\wsl.exe", "-d", "Ubuntu", "--cd", "~", "--exec", "/bin/sh", "-s"]);
    // Not a line after the script: dash reads ahead, so `read` would get nothing and the path would run as a command.
    expect(runs[0].stdin).toBe("{ IFS= read -r p; wslpath -a -u \"$p\"; } <<'EMBER_INPUT_END'\nC:\\Ember\\resources\\sidecar\\atspi\\ember_atspi.py\nEMBER_INPUT_END\nexit\n");
    expect(runs[0].args.join(" ")).not.toContain("ember_atspi");
    // The job host's stdin is held open until the shell has finished (its end would end the job), then closed.
    expect(runs[0].ended).toBe(true);
  });

  it("passes input lines only as literal text: a line break, a NUL or the here-document's end can't be given", async () => {
    expect(fixedScriptStdin("echo hi")).toBe("echo hi\nexit\n");
    for (const bad of ["C:\\a\nrm -rf ~", "C:\\a\r", "a\0b", "EMBER_INPUT_END"]) {
      expect(fixedScriptStdin(WSLPATH_SCRIPT, [bad])).toBeNull();
      const runs: { command: string; args: string[]; stdin: string }[] = [];
      expect(await runFixedScript({ wslExe: "w", distro: "U", script: WSLPATH_SCRIPT, input: [bad], env: {}, jobHost: null, spawn: fakeSpawn(runs, "/x\n", 0) })).toBeNull();
      expect(runs).toEqual([]);
    }
    // The doctor's look ends well where a distro has no gsettings (its last test fails there).
    expect(DIAG_SCRIPT.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("takes no path from a failure, an empty answer or one that isn't a plain absolute path", async () => {
    expect(await runFixedScript({ wslExe: "w", distro: "U", script: "x", env: {}, jobHost: null, spawn: fakeSpawn([], "/x\n", 1) })).toBeNull();
    for (const bad of [null, "", "relative/x\n", "/a\u0007b\n", "wslpath: C:\\x: No such file or directory\n"]) expect(parseLinuxPath(bad)).toBeNull();
  });

  it("finds the script in the packaged resources, else beside dist/app in the source tree, else says it's missing", () => {
    const exists = (p: string) => p === "C:\\Ember\\resources\\sidecar\\atspi\\ember_atspi.py" || p === "C:\\src\\ember\\sidecar\\atspi\\ember_atspi.py";
    expect(helperScriptPath({ resourcesPath: "C:\\Ember\\resources", appDir: "C:\\src\\ember\\dist\\app", exists })).toBe("C:\\Ember\\resources\\sidecar\\atspi\\ember_atspi.py");
    expect(helperScriptPath({ resourcesPath: "C:\\Other", appDir: "C:\\src\\ember\\dist\\app", exists })).toBe("C:\\src\\ember\\sidecar\\atspi\\ember_atspi.py");
    expect(helperScriptPath({ resourcesPath: null, appDir: null, exists })).toBeNull();
  });

  it("reads the helper's status and the doctor's look defensively", () => {
    expect(parseHelperStatus({ uid: 1000, wslg: true, bus: "proc", pyatspi: true, toolkitAccessibility: false })).toEqual({ uid: 1000, wslg: true, bus: "proc", pyatspi: true, toolkitAccessibility: false });
    expect(parseHelperStatus({ uid: "0", wslg: "yes", bus: "elsewhere" })).toEqual({ uid: null, wslg: null, bus: null, pyatspi: null, toolkitAccessibility: null });
    expect(parseHelperStatus(null).uid).toBeNull();
    expect(parseDiag("uid=1000\nwslg=1\npm=apt-get\npython3=1\npyatspi=0\na11y=false\n")).toEqual({ uid: 1000, wslg: true, python3: true, pyatspi: false, a11y: false, pm: "apt-get" });
    expect(parseDiag("uid=1000\nwslg=0\npm=brew\npython3=0\n")).toEqual({ uid: 1000, wslg: false, python3: false, pyatspi: null, a11y: null, pm: null });
    expect(parseDiag(null)).toBeNull();
  });

  it("turns toolkit accessibility on through the distro's runner with Ember's own fixed command", async () => {
    const started: RunSpec[] = [];
    const runner = (code: number): CommandRunner => ({
      target: "wsl:Ubuntu", running: 0,
      facts: async () => ({ shells: ["bash", "sh"], home: "/home/ana" }) as unknown as RunnerFacts,
      inspect: async () => [], gitFacts: async () => null, stopAll: async () => undefined,
      start: spec => { started.push(spec); return { done: Promise.resolve({ code, signal: null, ended: "exit", ms: 5 }) } as unknown as RunningCommand; },
    });
    expect(await turnOnLinuxAccessibility(runner(0), "Ubuntu")).toEqual({ ok: true, message: "Restart your Linux apps." });
    expect(started[0]).toMatchObject({ shell: "sh", command: A11Y_FIX_COMMAND, cwd: "/home/ana", stamp: { verdict: "run", classes: [], approval: null } });
    expect(started[0].runId).toMatch(/^[0-9a-f]{16}$/);
    expect(A11Y_FIX_COMMAND).toContain("gsettings set org.gnome.desktop.interface toolkit-accessibility true");
    expect(await turnOnLinuxAccessibility(runner(3), "Ubuntu")).toEqual({ ok: false, message: "Ember can't turn it on: Ubuntu has no gsettings." });
    expect((await turnOnLinuxAccessibility(runner(5), "Ubuntu")).message).toMatch(/dconf/);
  });
});

/** A spawn that answers `out` with exit `code`, recording argv and what was written to stdin. */
function fakeSpawn(runs: { command: string; args: string[]; stdin: string; ended?: boolean }[], out: string, code: number): SpawnLike {
  return (command, args) => {
    const run: { command: string; args: string[]; stdin: string; ended?: boolean } = { command, args, stdin: "" };
    runs.push(run);
    const stdout = new EventEmitter(), stderr = new EventEmitter(), child = new EventEmitter();
    // The shell answers once it has its script (it ends on the script's own exit: stdin stays open until then).
    let answered = false;
    const answer = () => { if (!answered) { answered = true; setTimeout(() => { stdout.emit("data", Buffer.from(out)); child.emit("close", code); }, 0); } };
    const stdin = Object.assign(new EventEmitter(), {
      write: (s: string) => { run.stdin += s; if (s.endsWith("exit\n")) answer(); return true; },
      end: (s?: string) => { run.ended = true; if (s) run.stdin += s; answer(); },
    });
    return Object.assign(child, { stdin, stdout, stderr, kill: () => true }) as unknown as ReturnType<SpawnLike>;
  };
}
