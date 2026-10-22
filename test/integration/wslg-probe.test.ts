/**
 * The WSLg probe (SSH/WSL design §10.2, job `wslg-probe`; owned by WB): what WSLg looks like on a real Windows runner,
 * recorded as artefacts in dist/wslg-probe/ for the matcher and the router to be checked against. It never passes or
 * fails on what it finds (until WSLg on hosted runners is known to be stable): it records whether RAIL windows appear
 * on the runner's desktop, their classes, titles, owners and msrdc image path; UIA's tree of each; the Start menu's
 * wslg.exe shortcuts and how wslgLaunch reads them; the helper's status inside the distro, its bus candidates and their
 * scores; and the distro's AT-SPI frames beside the RAIL windows' rectangles with the transforms match.ts finds.
 * Where WSLg is absent it says so and stops. Skipped without EMBER_WSL_TEST; with EMBER_WSL_TEST=1 it fails off
 * Windows or without wsl.exe (the facility is missing), so CI learns what broke.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtspiSidecar, type AxWindow } from "../../app/main/perception/sidecar";
import { openWin32Windows } from "../../app/main/platform/win32";
import type { ScreenLike } from "../../app/main/platform/types";
import { expandEnvironmentStrings, parseShellLink } from "../../app/main/platform/win32/system/lnk";
import { splitWindowsArgs } from "../../app/main/platform/win32/system/argv";
import { isWslgImage } from "../../app/main/policy/remote-surface";
import { isWslLauncher, wslgLaunch } from "../../app/main/wsl/apps";
import { helperLaunch, parseLinuxPath, runFixedScript, WSLPATH_SCRIPT } from "../../app/main/wsl/launch-sidecar";
import { contentBox, matchWindows, railTitle, type LinuxFrame, type RailWindow } from "../../app/main/wsl/match";
import { linuxFrame } from "../../app/main/wsl/router";
import { openRailProbe, railWindows, WslgPids } from "../../app/main/wsl/rail";
import { UiaBridge, bridgeEnv } from "./uia-client";

const required = process.env.EMBER_WSL_TEST === "1";
const onWindows = process.platform === "win32";
const DISTRO = process.env.EMBER_WSL_DISTRO || "Ubuntu-22.04";
const OUT = path.resolve("dist/wslg-probe");
const UIA_SCRIPT = path.resolve("sidecar/uia/ember_uia.ps1");
const HELPER_SCRIPT = path.resolve("sidecar/atspi/ember_atspi.py");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; }, file: "" };

/** wsl.exe's output: UTF-16LE when it has NULs at odd offsets (the inbox wsl.exe), else UTF-8. */
function decode(b: Buffer): string {
  const head = b.subarray(0, 64);
  const utf16 = head.length > 1 && [...head].some((v, i) => i % 2 === 1 && v === 0);
  return (utf16 ? b.toString("utf16le") : b.toString("utf8")).replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
}

function run(file: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(file, args, { windowsHide: true, timeout: 60_000, env: { ...process.env, WSL_UTF8: "1" } });
  return { code: r.status, out: decode(r.stdout ?? Buffer.alloc(0)), err: decode(r.stderr ?? Buffer.alloc(0)) };
}

/** Every .lnk under `dir`, at most four folders down. */
function shortcuts(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(e => (e.isDirectory() ? shortcuts(path.join(dir, e.name), depth + 1) : /\.lnk$/i.test(e.name) ? [path.join(dir, e.name)] : []));
}

describe.skipIf(!required)("WSLg on this runner (artefacts only)", () => {
  it("records what WSLg shows, what UIA and AT-SPI see of it, and how Ember would match them", async () => {
    expect(onWindows, "the wslg-probe needs Windows").toBe(true);
    fs.mkdirSync(OUT, { recursive: true });
    const record: Record<string, unknown> = { distro: DISTRO, at: new Date().toISOString() };
    const save = () => fs.writeFileSync(path.join(OUT, "probe.json"), JSON.stringify(record, null, 2));
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const wslExe = [path.win32.join(programFiles, "WSL", "wsl.exe"), path.win32.join(systemRoot, "System32", "wsl.exe")].find(p => fs.existsSync(p));
    expect(wslExe, "wsl.exe").toBeTruthy();
    record.wslExe = wslExe;
    record.version = run(wslExe!, ["--version"]);
    record.list = run(wslExe!, ["--list", "--verbose"]);
    const wslg = path.win32.join(programFiles, "WSL", "wslg.exe");
    record.wslgExe = fs.existsSync(wslg) ? wslg : null;
    if (!fs.existsSync(wslg)) {
      record.verdict = "WSLg is absent on this runner (no wslg.exe in WSL's install folder): nothing more to probe";
      console.log(record.verdict);
      save();
      return;
    }

    // Two Linux apps, started as their Start menu shortcuts would start them.
    for (const app of ["xeyes", "gedit"]) {
      const child = spawn(wslg, ["-d", DISTRO, "--cd", "~", "--", app], { detached: true, stdio: "ignore" });
      child.on("error", err => { record[`start-${app}`] = String(err); });
      child.unref();
    }

    // The RAIL windows, as the Windows window system and rail.ts see them.
    const screen: ScreenLike = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [] };
    const ws = openWin32Windows({ screen });
    expect(ws, "the Windows window system").not.toBeNull();
    const probe = openRailProbe("win32");
    const pids = new WslgPids(probe);
    let rails: RailWindow[] = [];
    for (let i = 0; i < 90 && rails.filter(r => !r.popup).length < 2; i++) {
      await sleep(500);
      rails = railWindows(ws!.stack(), pids.of(ws!.stack()), probe);
    }
    const msrdc = ws!.stack().filter(w => /^msrdc$/i.test(w.wmClass));
    const classes = new Map(ws!.clientWindows().map(w => [w.id, w.wmClassName]));
    record.msrdcWindows = msrdc.map(w => ({
      hwnd: w.id, pid: w.pid, title: w.title, className: classes.get(w.id) ?? null, image: w.pid ? probe?.imagePath(w.pid) ?? null : null,
      wslgImage: w.pid ? isWslgImage(probe?.imagePath(w.pid) ?? "") : false, owner: probe?.owner(w.id) ?? 0, popup: w.overrideRedirect,
      frame: { x: w.x, y: w.y, width: w.width, height: w.height }, outer: w.outer, inner: w.inner,
    }));
    record.rails = rails;
    if (!rails.length) {
      record.verdict = "no RAIL window of WSLg's msrdc appeared within 45 s (WSLg may not run on hosted runners)";
      console.log(record.verdict);
      save();
      return;
    }

    // UIA's tree of each RAIL window (expected: a frame and a client pane, nothing inside).
    if (fs.existsSync(UIA_SCRIPT)) {
      const bridge = new UiaBridge(UIA_SCRIPT, bridgeEnv(process.env, { EMBER_UIA_CACHE: path.join(OUT, "uia-cache") }));
      try {
        await bridge.ready;
        const trees: unknown[] = [];
        for (const r of rails.filter(x => !x.popup)) {
          const a = await bridge.request("snapshot", { hwnd: r.hwnd, deadlineMs: 4000 }, 15_000);
          const nodes = ((a.result as { nodes?: { role?: string; name?: string }[] } | undefined)?.nodes ?? []);
          trees.push({ hwnd: r.hwnd, count: nodes.length, nodes: nodes.slice(0, 40).map(n => ({ role: n.role, name: n.name })), error: a.error ?? null });
        }
        record.uia = trees;
      } catch (err) {
        record.uia = { error: String(err) };
      } finally {
        bridge.child.stdin.end();
      }
    }

    // The Start menu's WSLg shortcuts and how Ember reads them.
    const menus = [path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs"), path.join(process.env.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs")];
    record.shortcuts = menus.flatMap(m => shortcuts(m)).flatMap((file): unknown[] => {
      try {
        const link = parseShellLink(fs.readFileSync(file));
        const target = link.target ? expandEnvironmentStrings(link.target, process.env) : null;
        if (!target || !/wslg\.exe$/i.test(target)) return [];
        const argv = [target, ...splitWindowsArgs(link.arguments)];
        return [{ file, target, arguments: link.arguments, wslLauncher: isWslLauncher(target), read: wslgLaunch(argv) }];
      } catch (err) {
        return [{ file, error: String(err) }];
      }
    }).slice(0, 50);

    // Inside the distro: the helper's status, its bus candidates and scores, and its frames.
    const linux = parseLinuxPath(await runFixedScript({ wslExe: wslExe!, distro: DISTRO, script: WSLPATH_SCRIPT, input: [HELPER_SCRIPT], env: process.env, jobHost: null }));
    record.helperPath = linux;
    if (linux) {
      const launch = helperLaunch({ wslExe: wslExe!, distro: DISTRO, scriptLinuxPath: linux, env: process.env, jobHost: null, mayStart: () => true });
      const helper = new AtspiSidecar("", quiet, undefined, undefined, launch);
      try {
        record.status = await helper.request("status", {}, 20_000).catch(err => ({ error: String(err) }));
        const titles = [...new Set(rails.filter(r => !r.popup).map(r => railTitle(r.title, [DISTRO])).filter(Boolean))];
        record.findBus = await helper.request("find_bus", { titles }, 20_000).catch(err => ({ error: String(err) }));
        const listed = await helper.request<{ windows: AxWindow[] }>("list_windows", {}, 10_000).catch(err => ({ error: String(err), windows: [] }));
        const frames = (listed.windows ?? []).map(linuxFrame).filter((f): f is LinuxFrame => f !== null);
        record.frames = listed;
        const fg = ws!.activeWindow()?.id ?? 0;
        const matched = matchWindows(rails, frames, { distro: DISTRO, foreground: fg });
        record.matches = [...matched.values()].map(m => ({
          hwnd: m.hwnd, frame: { name: m.frame.name, program: m.frame.program, bounds: m.frame.bounds, box: contentBox(m.frame.bounds, m.frame.children) },
          inner: rails.find(r => r.hwnd === m.hwnd)?.inner, transform: m.transform,
        }));
        record.unmatched = rails.filter(r => !r.popup && !matched.has(r.hwnd)).map(r => ({ hwnd: r.hwnd, title: r.title }));
      } finally {
        helper.stop();
      }
    }
    record.verdict = "recorded";
    save();
    console.log(JSON.stringify({ rails: rails.length, matches: (record.matches as unknown[] | undefined)?.length ?? 0, bus: record.findBus }));
    expect(fs.existsSync(path.join(OUT, "probe.json"))).toBe(true);
  }, 300_000);
});
