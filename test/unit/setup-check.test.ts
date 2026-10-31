/**
 * The settings window's setup check for other computers and WSL (§8.8, the lead's ruling): the targets runtime's doctor
 * rows as setup-check rows (as ember --doctor shows them), the route of a fix button's id (wsl-a11y:<distro> to the
 * targets runtime, this OS's fixes to the platform, anything else refused before anything runs), the rows kept and
 * waited for, and main's wiring of both behind the settings window's trusted-sender guard (read from its source: main.ts
 * is Electron's entry point and can't be loaded here).
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvReport } from "../../app/main/environment";
import type { PlatformDoctorRow } from "../../app/main/platform/types";
import { afterTargetFix, applySetupFix, setupChecks, targetChecksSource, targetFixOf, withTargetChecks, type FixRoutes } from "../../app/main/targets/setup-check";
import { commandTerminalRow, remoteTccRow, sshClientRow } from "../../app/main/targets/doctor";

const a11yOff: PlatformDoctorRow = {
  id: "wsl-a11y:Ubuntu", status: "warn", label: "Accessibility in Ubuntu", detail: "Linux apps in Ubuntu don't share their controls (toolkit accessibility is off)",
  fix: "Turn on accessibility for Linux apps in Ubuntu",
};
const rows: PlatformDoctorRow[] = [
  { id: "ssh-client", status: "ok", label: "SSH client", detail: "OpenSSH 8.0 at /usr/bin/ssh" },
  { id: "command-terminal", status: "warn", label: "Command window terminal", detail: "No script program: commands can't ask for passwords or answers", fix: "Install util-linux (`sudo dnf install util-linux`)." },
  a11yOff,
  { id: "wsl-a11y:Debian", status: "ok", label: "Accessibility in Debian", detail: "Linux apps in Debian share their controls" },
];
const env: EnvReport = {
  os: "Windows 11", sessionType: "", desktop: "", display: "", glibc: "", versions: { node: "24" } as EnvReport["versions"],
  checks: [{ id: "platform", label: "Platform", status: "ok", detail: "Windows 11 x64" }],
};

describe("setupChecks", () => {
  it("shows each row as the doctor does, with a fix button only for a wsl-a11y row that isn't ok", () => {
    expect(setupChecks(rows)).toEqual([
      { id: "ssh-client", label: "SSH client", status: "ok", detail: "OpenSSH 8.0 at /usr/bin/ssh" },
      { id: "command-terminal", label: "Command window terminal", status: "warn", detail: "No script program: commands can't ask for passwords or answers. Install util-linux (sudo dnf install util-linux)." },
      { id: "wsl-a11y:Ubuntu", label: "Accessibility in Ubuntu", status: "warn", detail: a11yOff.detail, fix: "wsl-a11y:Ubuntu" },
      { id: "wsl-a11y:Debian", label: "Accessibility in Debian", status: "ok", detail: "Linux apps in Debian share their controls" },
    ]);
    // A distro name that isn't one gets no button.
    expect(setupChecks([{ ...a11yOff, id: "wsl-a11y:../x" }])[0].fix).toBeUndefined();
  });

  it("puts the target rows after this OS's own, and a fix's words on its row", () => {
    const all = withTargetChecks(env, setupChecks(rows));
    expect(all.checks.map(c => c.id)).toEqual(["platform", "ssh-client", "command-terminal", "wsl-a11y:Ubuntu", "wsl-a11y:Debian"]);
    const after = afterTargetFix(all, "wsl-a11y:Ubuntu", "Restart your Linux apps.");
    expect(after.checks[3]).toEqual({ id: "wsl-a11y:Ubuntu", label: "Accessibility in Ubuntu", status: "warn", detail: "Restart your Linux apps." });
    expect(after.checks.filter((_, k) => k !== 3)).toEqual(all.checks.filter((_, k) => k !== 3));
  });
});

describe("the target rows' words in the window (review #157, #218)", () => {
  const words = (r: PlatformDoctorRow) => setupChecks([r])[0].detail;

  it("joins a detail and its fix with one full stop, and the Mac row's fix is a sentence", () => {
    expect(words(remoteTccRow("mini"))).toBe(
      "Commands on mini can't open your Desktop, Documents or Downloads folders until “Allow full disk access for remote users” is on. "
      + "Turn it on in System Settings › General › Sharing › Remote Login › ⓘ.",
    );
    expect(words({ id: "x", status: "warn", label: "X", detail: "Something is off!", fix: "Fix it." })).toBe("Something is off! Fix it.");
  });

  it("says once that there is no SSH client, with only this OS's way to install it", () => {
    expect(words(sshClientRow("linux", null))).toBe("No SSH client found. Install OpenSSH with: sudo dnf install openssh-clients");
    expect(words(sshClientRow("win32", null))).toBe("No SSH client found. Install the OpenSSH Client in Settings › Apps › Optional features, then try again.");
    expect(words(sshClientRow("darwin", null))).not.toMatch(/dnf|Optional features/);
  });

  it("gives Windows' OpenSSH 8.1 to 8.3 its own fix: passwords need 8.4", () => {
    expect(words(sshClientRow("win32", { path: "x", text: "OpenSSH_for_Windows_8.1p1" })))
      .toBe("Passwords can't be asked here: keys and the ssh-agent only. Update the OpenSSH Client to 8.4 or newer to enter passwords in Ember.");
  });

  it("names util-linux only on Linux", () => {
    expect(words(commandTerminalRow(null, "linux"))).toBe("No script program: commands can't ask for passwords or answers. Install util-linux with: sudo dnf install util-linux");
    expect(words(commandTerminalRow(null, "darwin"))).not.toMatch(/util-linux|dnf/);
  });

  it("shows no Markdown backticks (the page sets plain text), from any row or fix's words", () => {
    expect(words({ id: "wsl", status: "warn", label: "WSL", detail: "WSLg is off", fix: "Remove `guiApplications=false` from `%USERPROFILE%\\.wslconfig`." }))
      .toBe("WSLg is off. Remove guiApplications=false from %USERPROFILE%\\.wslconfig.");
    const env2 = withTargetChecks(env, setupChecks([a11yOff]));
    expect(afterTargetFix(env2, "wsl-a11y:Ubuntu", "Run `xhost` first.").checks[1].detail).toBe("Run xhost first.");
  });
});

describe("applySetupFix (fail closed on any other id)", () => {
  const routes = (target: FixRoutes["applyTarget"] = vi.fn(async () => ({ ok: true, message: "Restart your Linux apps." }))) => {
    const applyOs = vi.fn(async () => undefined);
    return { osFixes: ["enable-accessibility"] as FixRoutes["osFixes"], applyOs, applyTarget: target };
  };

  it("routes wsl-a11y:<distro> to the targets runtime's applyFix, and says its words", async () => {
    const r = routes();
    await expect(applySetupFix("wsl-a11y:Ubuntu-22.04", r)).resolves.toEqual({ target: "wsl-a11y:Ubuntu-22.04", message: "Restart your Linux apps." });
    expect(r.applyTarget).toHaveBeenCalledWith("wsl-a11y:Ubuntu-22.04");
    expect(r.applyOs).not.toHaveBeenCalled();
  });

  it("throws the targets runtime's refusal in its own words, and refuses without a runtime", async () => {
    const r = routes(vi.fn(async () => ({ ok: false, message: "Your organisation has turned this off." })));
    await expect(applySetupFix("wsl-a11y:Ubuntu", r)).rejects.toThrow("Your organisation has turned this off.");
    await expect(applySetupFix("wsl-a11y:Ubuntu", routes(null))).rejects.toThrow("Ember can't apply that fix right now.");
  });

  it("applies this OS's own fixes through the platform", async () => {
    const r = routes();
    await expect(applySetupFix("enable-accessibility", r)).resolves.toBeNull();
    expect(r.applyOs).toHaveBeenCalledWith("enable-accessibility");
    expect(r.applyTarget).not.toHaveBeenCalled();
  });

  it.each([["rm -rf /"], ["wsl-a11y:"], ["wsl-a11y:../etc"], ["wsl-a11y:a b"], ["open-microphone-settings"], ["WSL-A11Y:Ubuntu"], [42], [null], [{ id: "wsl-a11y:Ubuntu" }]])(
    "refuses %j before anything runs", async fix => {
      const r = routes();
      await expect(applySetupFix(fix, r)).rejects.toThrow(/unknown fix/);
      expect(r.applyOs).not.toHaveBeenCalled();
      expect(r.applyTarget).not.toHaveBeenCalled();
    });

  it("knows a target fix by its exact form", () => {
    expect(targetFixOf("wsl-a11y:Ubuntu")).toBe("wsl-a11y:Ubuntu");
    expect(targetFixOf("wsl-a11y:Ubuntu\n")).toBeNull();
    expect(targetFixOf(undefined)).toBeNull();
  });
});

describe("targetChecksSource", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("keeps a read for a while, reads again when asked fresh, and keeps the last rows when a read fails", async () => {
    let t = 0;
    const read = vi.fn(async (): Promise<PlatformDoctorRow[]> => rows.slice(0, 1));
    const checks = targetChecksSource(read, { keepMs: 1000, waitMs: 500, now: () => t });
    expect((await checks()).map(c => c.id)).toEqual(["ssh-client"]);
    t = 999;
    await checks();
    expect(read).toHaveBeenCalledTimes(1);
    await checks(true);
    expect(read).toHaveBeenCalledTimes(2);
    t = 5000;
    read.mockRejectedValueOnce(new Error("wsl.exe didn't answer"));
    expect((await checks()).map(c => c.id)).toEqual(["ssh-client"]);
  });

  it("waits only so long for a slow read, showing the rows from before; the read finishes for the next ask", async () => {
    vi.useFakeTimers();
    let release: (r: PlatformDoctorRow[]) => void = () => undefined;
    const read = vi.fn(() => new Promise<PlatformDoctorRow[]>(r => { release = r; }));
    const checks = targetChecksSource(read, { keepMs: 0, waitMs: 3000, now: () => 0 });
    const first = checks();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(first).resolves.toEqual([]);
    // Shared while it runs: no second read.
    const second = checks();
    expect(read).toHaveBeenCalledTimes(1);
    release(rows.slice(2, 3));
    expect((await second).map(c => c.fix)).toEqual(["wsl-a11y:Ubuntu"]);
  });
});

describe("main.ts's wiring of the setup check (the lead's ruling)", () => {
  /** main.ts without its comments, every run of white space made one space. */
  const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

  it("shows the targets runtime's doctor rows in the settings window's status", () => {
    expect(MAIN).toContain("const targetChecks = targetChecksSource(() => targets?.doctorRows() ?? Promise.resolve([]),");
    expect(MAIN).toContain("const environmentNow = async (fresh = false) => withTargetChecks(readEnvironment(), await targetChecks(fresh));");
    expect(MAIN).toContain("ipcMain.handle(IPC.getStatus, guard(async (): Promise<Status> => ({ appVersion: app.getVersion(), settings: settings.get(), environment: await environmentNow(),");
  });

  it("routes a fix through applySetupFix, only behind the settings window's guard", () => {
    expect(MAIN).toContain("ipcMain.handle(IPC.applyFix, guard(async (fix: string) => { const t = targets; const done = await applySetupFix(fix, { osFixes: sys.fixes.ids, applyOs: id => sys.fixes.apply(id), applyTarget: t ? id => t.applyFix(id) : null });");
    expect(MAIN).toContain("if (!isTrustedSender(url) || !home || home.isDestroyed() || event.sender !== home.webContents) throw new Error(`untrusted IPC sender: ${url}`);");
    // Nothing else applies a fix.
    expect(MAIN.match(/\.applyFix\(/g)).toHaveLength(1);
    expect(MAIN.match(/sys\.fixes\.apply\(/g)).toHaveLength(1);
  });
});
