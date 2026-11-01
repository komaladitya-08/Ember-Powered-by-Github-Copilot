import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopChildEnv, discoverDesktop, parseBusctlStrings, parseEnviron, parseProps, type DesktopIo } from "../../app/remote/desktop-linux";

const FIXTURES = fileURLToPath(new URL("../fixtures/remote/", import.meta.url));

/** A process in fake /proc: its cgroup line and environment (null: unreadable, as with file capabilities). */
interface Proc { pid: number; cgroup: string; environ: Record<string, string> | null }

const scope = (id: string) => `0::/user.slice/user-1000.slice/session-${id}.scope`;
const userService = (unit: string) => `0::/user.slice/user-1000.slice/user@1000.service/session.slice/${unit}`;

/** DesktopIo over a fixture folder and a fake /proc. */
function ioFrom(name: string, o: { uid?: number; procs?: Proc[]; sockets?: string[]; files?: string[]; ember?: boolean; manager?: string | null; saver?: string | null } = {}): DesktopIo {
  const dir = path.join(FIXTURES, name);
  const read = (f: string) => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  };
  const procs = o.procs ?? [];
  return {
    uid: o.uid ?? 1000,
    user: "deploy",
    host: "build-01",
    home: "/home/deploy",
    showUser: async uid => (uid === 1000 ? read("show-user.txt") : null),
    showSession: async id => read(`show-session-${id}.txt`),
    managerEnvironment: async () => (o.manager !== undefined ? o.manager : read("manager-env.txt")),
    gnomeScreenSaver: async () => (o.saver !== undefined ? o.saver : read("screensaver.txt") ?? "absent"),
    processes: async () => procs.map(p => p.pid),
    cgroup: async pid => procs.find(p => p.pid === pid)?.cgroup ?? null,
    environ: async pid => {
      const env = procs.find(p => p.pid === pid)?.environ;
      return env ? Buffer.from(Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(""), "utf8") : null;
    },
    socketOwnedBy: async (p, uid) => uid === 1000 && (o.sockets ?? ["/run/user/1000/bus"]).includes(p),
    exists: async p => (o.files ?? []).includes(p),
    emberRunning: async () => o.ember ?? false,
  };
}

const sessionEnv = (id: string, extra: Record<string, string> = {}) => ({
  DISPLAY: ":0", XDG_SESSION_ID: id, XAUTHORITY: "/run/user/1000/gdm/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  XDG_CURRENT_DESKTOP: "GNOME", LANG: "en_US.UTF-8", SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh", GH_TOKEN: "ghp_secret", ...extra,
});

describe("discoverDesktop on RHEL 8 (systemd 239)", () => {
  it("finds deploy's X11 session on seat0 and takes its environment from a process in its scope, never another's", async () => {
    const io = ioFrom("rhel8-x11", {
      procs: [
        { pid: 900, cgroup: userService("dbus.service"), environ: { DISPLAY: ":5", XDG_SESSION_ID: "2" } },
        { pid: 1400, cgroup: scope("2"), environ: null },
        { pid: 1450, cgroup: scope("4"), environ: { DISPLAY: "localhost:10.0", XDG_SESSION_ID: "4" } },
        { pid: 1500, cgroup: scope("2"), environ: sessionEnv("2") },
      ],
    });
    const found = await discoverDesktop(io, { waylandText: false });
    expect(found).toEqual({
      access: "screen",
      session: { id: "2", type: "x11", locked: false, active: true },
      env: {
        DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_CURRENT_DESKTOP: "GNOME", LANG: "en_US.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000",
      },
    });
  });

  it("doesn't use a locked screen, by logind's hint or by GNOME's screensaver, or when the screensaver can't be asked (critique remote-14)", async () => {
    const procs = [{ pid: 1500, cgroup: scope("2"), environ: sessionEnv("2") }];
    expect(await discoverDesktop(ioFrom("rhel8-x11-locked", { procs }), { waylandText: false })).toMatchObject({ access: "none", why: "build-01's screen is locked." });
    for (const saver of ["b true\n", null, "garbage"]) {
      expect(await discoverDesktop(ioFrom("rhel8-x11", { procs, saver }), { waylandText: false })).toMatchObject({ access: "none", why: "build-01's screen is locked." });
    }
    expect((await discoverDesktop(ioFrom("rhel8-x11", { procs, saver: "absent" }), { waylandText: false })).access).toBe("screen");
  });

  it("doesn't use deploy's session while another user has the screen", async () => {
    expect(await discoverDesktop(ioFrom("rhel8-x11-switched"), { waylandText: false })).toEqual({
      access: "none", why: "deploy isn't using build-01's screen right now: Ember will run commands only.",
    });
  });

  it("says commands only on a server with no desktop, and when loginctl can't answer", async () => {
    const why = "build-01 has no desktop: Ember will run commands only.";
    expect(await discoverDesktop(ioFrom("rhel8-headless"), { waylandText: false })).toEqual({ access: "none", why });
    expect(await discoverDesktop(ioFrom("no-such-machine"), { waylandText: false })).toEqual({ access: "none", why });
  });

  it("doesn't use a VNC session, which has no seat (L21)", async () => {
    expect(await discoverDesktop(ioFrom("rhel8-vnc"), { waylandText: false })).toEqual({
      access: "none", why: "build-01's desktop is a remote session: Ember will run commands only.",
    });
  });

  it("never uses a desktop as root", async () => {
    expect(await discoverDesktop(ioFrom("rhel8-x11", { uid: 0 }), { waylandText: false })).toEqual({ access: "none", why: "Ember doesn't use a desktop as root." });
  });

  it("stays off a screen where Ember itself is already running", async () => {
    const procs = [{ pid: 1500, cgroup: scope("2"), environ: sessionEnv("2") }];
    expect(await discoverDesktop(ioFrom("rhel8-x11", { procs, ember: true }), { waylandText: false })).toMatchObject({ access: "none", why: "Ember is already running on build-01's screen." });
  });
});

describe("discoverDesktop on Ubuntu 24.04 (systemd 255)", () => {
  it("takes GNOME's session environment from the user manager, allow-listed (critique remote-9, remote-13)", async () => {
    const found = await discoverDesktop(ioFrom("ubuntu2404-x11"), { waylandText: false });
    expect(found).toEqual({
      access: "screen",
      session: { id: "2", type: "x11", locked: false, active: true },
      env: {
        LANG: "en_GB.UTF-8", DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
        XDG_SESSION_DESKTOP: "ubuntu", DESKTOP_SESSION: "ubuntu-xorg", GDMSESSION: "ubuntu-xorg", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
    });
  });

  it("finds the display in the session scope when GNOME 3.34+ runs its shell outside it and the manager doesn't say", async () => {
    const io = ioFrom("ubuntu2404-x11", {
      manager: 'as 1 "LANG=en_GB.UTF-8"\n',
      procs: [
        { pid: 2100, cgroup: userService("org.gnome.Shell@x11.service"), environ: sessionEnv("2", { DISPLAY: ":7" }) },
        { pid: 2000, cgroup: scope("2"), environ: { ...sessionEnv("2"), XDG_SESSION_ID: "2" } },
      ],
    });
    const found = await discoverDesktop(io, { waylandText: false });
    expect(found.access).toBe("screen");
    expect(found.access !== "none" && found.env.DISPLAY).toBe(":0");
  });

  it("refuses a display with a host part (ssh -X's tunnel back to the PC) wherever it comes from", async () => {
    const io = ioFrom("ubuntu2404-x11", {
      manager: 'as 2 "DISPLAY=localhost:10.0" "LANG=C"\n',
      procs: [{ pid: 2000, cgroup: scope("2"), environ: sessionEnv("2", { DISPLAY: "localhost:10.0" }) }],
    });
    // logind's own Display (":0") is the session's; the tunnel never is.
    const found = await discoverDesktop(io, { waylandText: false });
    expect(found.access !== "none" && found.env.DISPLAY).toBe(":0");
    const noLogind = ioFrom("rhel8-vnc");
    expect((await discoverDesktop(noLogind, { waylandText: false })).access).toBe("none");
  });

  it("keeps a Wayland session to commands until its CI job passes, and gives text access with it (L5)", async () => {
    expect(await discoverDesktop(ioFrom("ubuntu2404-wayland"), { waylandText: false })).toMatchObject({
      access: "none", why: "Ember can't use build-01's Wayland desktop yet; it can run commands there.", session: { type: "wayland", locked: false },
    });
    const io = ioFrom("ubuntu2404-wayland", { sockets: ["/run/user/1000/bus", "/run/user/1000/wayland-0"] });
    const found = await discoverDesktop(io, { waylandText: true });
    expect(found).toMatchObject({ access: "text", session: { type: "wayland" }, env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } });
  });

  it("drops a Wayland socket that isn't this user's", async () => {
    const found = await discoverDesktop(ioFrom("ubuntu2404-wayland", { sockets: ["/run/user/1000/bus"] }), { waylandText: true });
    expect(found.access).toBe("text");
    expect(found.access !== "none" && found.env.WAYLAND_DISPLAY).toBeUndefined();
  });

  it("doesn't use an xrdp session", async () => {
    expect(await discoverDesktop(ioFrom("ubuntu2404-xrdp"), { waylandText: false })).toEqual({
      access: "none", why: "build-01's desktop is a remote session: Ember will run commands only.",
    });
  });

  it("never guesses between two desktops of the same user", async () => {
    expect(await discoverDesktop(ioFrom("ubuntu2404-two-seats"), { waylandText: false })).toEqual({
      access: "none", why: "Ember can't tell which of deploy's two desktops to use.",
    });
  });
});

describe("the readers' formats", () => {
  it("reads Key=Value lines by name, whatever their order (critique remote-2)", () => {
    const shuffled = "LockedHint=no\nType=x11\nId=2\nActive=yes\nDisplay=:0\n";
    expect(Object.fromEntries(parseProps(shuffled))).toEqual({ LockedHint: "no", Type: "x11", Id: "2", Active: "yes", Display: ":0" });
  });

  it("reads busctl's plain strings with their C escapes, and nothing else", () => {
    expect(parseBusctlStrings('as 3 "A=\\"q\\"" "B=caf\\303\\251" "C=a\\\\b"\n')).toEqual(['A="q"', "B=café", "C=a\\b"]);
    expect(parseBusctlStrings("as 0\n")).toEqual([]);
    expect(parseBusctlStrings('as 2 "A=1"\n')).toBeNull();
    expect(parseBusctlStrings('{"type":"as","data":["A=1"]}')).toBeNull();
  });

  it("splits /proc environ files on NUL", () => {
    expect(Object.fromEntries(parseEnviron(Buffer.from("A=1\0B=x=y\0\0", "utf8")))).toEqual({ A: "1", B: "x=y" });
  });
});

describe("desktopChildEnv (§5.3.4 step 7)", () => {
  it("starts from the agent's HOME, USER, LOGNAME, SHELL, PATH and LANG, lays the session over them, and keeps nothing secret", () => {
    const env = desktopChildEnv(
      { HOME: "/home/deploy", USER: "deploy", LOGNAME: "deploy", SHELL: "/bin/bash", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SSH_CONNECTION: "x", SSH_AUTH_SOCK: "/tmp/a", DISPLAY: "localhost:10.0", GH_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1", EMBER_LOG_LEVEL: "debug" },
      { DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", LANG: "en_GB.UTF-8", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    );
    expect(env).toEqual({
      HOME: "/home/deploy", USER: "deploy", LOGNAME: "deploy", SHELL: "/bin/bash", PATH: "/usr/bin:/bin", LANG: "en_GB.UTF-8",
      DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  it("never takes the SSH login's DISPLAY", () => {
    expect(desktopChildEnv({ HOME: "/h", DISPLAY: "localhost:10.0" }, {}).DISPLAY).toBeUndefined();
    expect(desktopChildEnv({ HOME: "/h" }, { DISPLAY: "10.0.0.5:0" }).DISPLAY).toBeUndefined();
  });
});
