/**
 * A fallback chord when another app holds one of Ember's shortcuts (owner decision D-45b, review #45b): each shortcut
 * has a documented fallback per OS (app/shared/shortcuts.ts), registered when the default is refused (hotkey.ts
 * holdShortcuts, with a fake registry here); what Ember holds (default, fallback or none) is what the setup check, the
 * keyboard route to settings and the greeting name.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALWAYS_HELD, FALLBACK_SHORTCUTS, KEYS, SHORTCUTS, heldShortcuts, type OS, type ShortcutId } from "../../app/shared/shortcuts";
import { canonicalKeys, isSystemKey } from "../../app/main/policy/policy";
import { holdShortcuts, type ShortcutRegistry } from "../../app/main/hotkey";
import { inspectEnvironment, keyboardRoute, type EnvInputs } from "../../app/main/environment";
import { keysLine } from "../../app/main/hello";
import { dockMenuItems, jumpListTasks, startView, wantsAsk } from "../../app/main/launcher";
import { commandsConsent, sshConsent, type SshCardFacts } from "../../app/main/targets/consent";
import { consentText } from "../../app/renderer/prompt/copy";

const OSES: OS[] = ["linux", "win32", "darwin"];
const IDS: ShortcutId[] = ["ask", "stop", "settings", "mute", "allow", "deny"];
/** An Electron accelerator as a combination the policy reads ("Control+Shift+Command+Y" → "ctrl+shift+cmd+y"). */
const asCombo = (accel: string) => accel.split("+").map(p => ({ Control: "ctrl", Command: "cmd", Super: "super", Alt: "alt", Shift: "shift" } as Record<string, string>)[p] ?? p.toLowerCase()).join("+");

describe("the fallback chords (D-45b)", () => {
  it("are the defaults with Shift on Linux and Windows, and Control+Shift+Command on another key on a Mac", () => {
    expect(FALLBACK_SHORTCUTS.linux.ask).toEqual({ accel: "Control+Alt+Shift+Space", label: "Ctrl+Alt+Shift+Space", keys: ["Ctrl", "Alt", "Shift", "Space"], say: "Control Alt Shift Space", chord: "ctrl+alt+shift+space" });
    expect(FALLBACK_SHORTCUTS.win32.stop).toEqual({ accel: "Super+Alt+Shift+X", label: "Win+Alt+Shift+X", keys: ["Win", "Alt", "Shift", "X"], say: "Windows key, Alt, Shift, X", chord: "alt+shift+super+x" });
    // ⌘, opens an app's settings and ⌘. stops: Ember's fallbacks keep those keys.
    expect(FALLBACK_SHORTCUTS.darwin.settings).toEqual({
      accel: "Control+Shift+Command+,", label: "Control+Shift+Command+Comma", keys: ["Control", "Shift", "Command", "Comma"],
      say: "Control Shift Command Comma", chord: "ctrl+shift+cmd+comma",
    });
    expect(FALLBACK_SHORTCUTS.darwin.stop).toMatchObject({ accel: "Control+Shift+Command+.", label: "Control+Shift+Command+Period", say: "Control Shift Command Period", chord: "ctrl+shift+cmd+period" });
    expect(Object.fromEntries(IDS.map(id => [id, FALLBACK_SHORTCUTS.darwin[id].label]))).toEqual({
      ask: "Control+Shift+Command+A", stop: "Control+Shift+Command+Period", settings: "Control+Shift+Command+Comma",
      mute: "Control+Shift+Command+U", allow: "Control+Shift+Command+Return", deny: "Control+Shift+Command+Esc",
    });
  });

  it("are each the policy's spelling of the accelerator, a key only the user presses, and never a default", () => {
    for (const os of OSES) {
      const defaults = new Set(Object.values(SHORTCUTS[os]).map(d => d.accel));
      const accels = new Set<string>();
      for (const id of IDS) {
        const f = FALLBACK_SHORTCUTS[os][id];
        expect(canonicalKeys(asCombo(f.accel), KEYS[os]), `${os} ${id}`).toBe(f.chord);
        // A task can't press it (it would ask, stop or answer for the user), as it can't press a default.
        expect(isSystemKey(f.chord, KEYS[os]), `${os} ${id}`).toBe(true);
        expect(defaults.has(f.accel), `${os} ${id}`).toBe(false);
        accels.add(f.accel);
        expect(f.label).toBe(f.keys.join("+"));
      }
      expect(accels.size).toBe(IDS.length);
    }
  });

  it("are the same key as the default with Shift added on Linux and Windows", () => {
    for (const os of ["linux", "win32"] as const) {
      for (const id of IDS) {
        const f = FALLBACK_SHORTCUTS[os][id], d = SHORTCUTS[os][id];
        expect(f.keys.at(-1), `${os} ${id}`).toBe(d.keys.at(-1));
        expect(f.keys, `${os} ${id}`).toEqual([...d.keys.slice(0, -1), "Shift", d.keys.at(-1)]);
      }
    }
  });

  it("keep the defaults' Control+Shift+Command on a Mac, without Option (VoiceOver's keys) and clear of the Mac's own", () => {
    const defaultKeys = new Set(Object.values(SHORTCUTS.darwin).map(d => d.keys.at(-1)));
    for (const id of IDS) {
      const f = FALLBACK_SHORTCUTS.darwin[id];
      expect(f.keys.slice(0, -1), id).toEqual(["Control", "Shift", "Command"]);
      // Control+Option is VoiceOver's VO key (D6): while it runs it takes those presses, so a chord with it never reaches
      // Ember. Control+Option+Shift+Command is also the "Hyper" chord Raycast and Karabiner users bind.
      expect(f.accel, id).not.toMatch(/\bAlt\b|\bOption\b/);
      expect(f.chord, id).not.toMatch(/\balt\b/);
      // Another key than every default's, and no digit: Control+Shift+Command+3, 4 and 6 are screenshots to the clipboard.
      expect(defaultKeys.has(f.keys.at(-1)), id).toBe(false);
      expect(f.keys.at(-1), id).not.toMatch(/^\d$/);
      expect(KEYS.darwin.systemKeys, id).not.toContain(f.chord);
    }
  });
});

describe("heldShortcuts", () => {
  const sc = SHORTCUTS.linux, fb = FALLBACK_SHORTCUTS.linux;
  it("is the default while Ember holds it, the fallback once another app holds the default, and null once both", () => {
    expect(heldShortcuts(sc, fb, []).ask).toBe(sc.ask);
    const held = heldShortcuts(sc, fb, ["Control+Alt+Space", "Control+Alt+X", "Control+Alt+Shift+X"]);
    expect(held.ask).toBe(fb.ask);
    expect(held.stop).toBeNull();
    expect(held.settings).toBe(sc.settings);
  });
});

/** A fake of Electron's globalShortcut: `others` are held by other apps; what Ember registers is kept. */
function registry(others: string[]) {
  const mine = new Map<string, ShortcutId>();
  const tried: string[] = [];
  const reg: ShortcutRegistry = {
    isRegistered: accel => mine.has(accel),
    register: (id, accel) => {
      tried.push(accel);
      if (others.includes(accel) || mine.has(accel)) return false;
      mine.set(accel, id);
      return true;
    },
  };
  return { reg, mine, tried, others };
}

describe("holdShortcuts (registration with a fallback)", () => {
  const sc = SHORTCUTS.win32, fb = FALLBACK_SHORTCUTS.win32;

  it("registers each default when it is free, and nothing else", () => {
    const r = registry([]);
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: [], missing: [] });
    expect([...r.mine]).toEqual([["Super+Alt+Space", "ask"], ["Super+Alt+X", "stop"], ["Super+Alt+E", "settings"], ["Super+Alt+M", "mute"]]);
  });

  it("registers the fallback when another app holds the default, for the same shortcut", () => {
    const r = registry(["Super+Alt+Space", "Super+Alt+M"]);
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: ["Super+Alt+Space", "Super+Alt+M"], missing: [] });
    expect(r.mine.get("Super+Alt+Shift+Space")).toBe("ask");
    expect(r.mine.get("Super+Alt+Shift+M")).toBe("mute");
    expect(heldShortcuts(sc, fb, ["Super+Alt+Space", "Super+Alt+M"]).ask?.label).toBe("Win+Alt+Shift+Space");
  });

  it("keeps today's route when both are taken: both reported, the shortcut missing, and tried again later", () => {
    const r = registry(["Super+Alt+X", "Super+Alt+Shift+X"]);
    const first = holdShortcuts(ALWAYS_HELD, sc, fb, r.reg);
    expect(first).toEqual({ taken: ["Super+Alt+X", "Super+Alt+Shift+X"], missing: ["stop"] });
    // The other app let go of the default: the next try (main's minute) takes it.
    r.others.splice(0, 1);
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: [], missing: [] });
    expect(r.mine.get("Super+Alt+X")).toBe("stop");
  });

  it("keeps a fallback it holds once the default comes free, so the chord it named doesn't change while Ember runs", () => {
    const r = registry(["Super+Alt+Space"]);
    holdShortcuts(ALWAYS_HELD, sc, fb, r.reg);
    r.others.length = 0;
    r.tried.length = 0;
    expect(holdShortcuts(ALWAYS_HELD, sc, fb, r.reg)).toEqual({ taken: ["Super+Alt+Space"], missing: [] });
    expect(r.tried).toEqual([]);
    expect(r.mine.has("Super+Alt+Space")).toBe(false);
  });

  it("holds the question keys the same way (Allow and Not now)", () => {
    const r = registry(["Super+Alt+Y"]);
    expect(holdShortcuts(["allow", "deny"], sc, fb, r.reg)).toEqual({ taken: ["Super+Alt+Y"], missing: [] });
    expect(r.mine.get("Super+Alt+Shift+Y")).toBe("allow");
    expect(r.mine.get("Super+Alt+N")).toBe("deny");
  });

  it("counts a registry that throws as a refusal", () => {
    const reg: ShortcutRegistry = { isRegistered: () => false, register: () => { throw new Error("invalid accelerator"); } };
    expect(holdShortcuts(["ask"], sc, fb, reg)).toEqual({ taken: ["Super+Alt+Space", "Super+Alt+Shift+Space"], missing: ["ask"] });
  });
});

describe("keyboardRoute with fallbacks (review #45)", () => {
  const sc = SHORTCUTS.linux, fb = FALLBACK_SHORTCUTS.linux;
  it("opens settings at Ask Ember… or Stop everything only while Ember holds neither chord of that shortcut", () => {
    expect(keyboardRoute(["Control+Alt+Space"], sc, fb)).toBeNull();
    expect(keyboardRoute(["Control+Alt+Space", "Control+Alt+Shift+Space"], sc, fb)).toBe("access:ask");
    expect(keyboardRoute(["Control+Alt+X", "Control+Alt+Shift+X", "Control+Alt+Space"], sc, fb)).toBe("access:stop");
    expect(keyboardRoute([], sc, fb)).toBeNull();
  });
});

describe("the setup check's shortcuts row names what Ember holds (D-45b)", () => {
  const linux: EnvInputs = { env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, osRelease: null, glibc: "2.28", versions: { node: "22" }, platform: "linux", arch: "x64", shortcutsTaken: [] };
  const row = (i: EnvInputs) => inspectEnvironment(i).checks.find(c => c.id === "shortcuts");

  it("says when a fallback is in use, and which chord does what now", () => {
    expect(row({ ...linux, shortcutsTaken: ["Control+Alt+Space"] })).toMatchObject({
      status: "warn",
      detail: "Ctrl+Alt+Space is taken by another app, so Ask Ember is Ctrl+Alt+Shift+Space. Ctrl+Alt+Shift+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone",
    });
    expect(row({ ...linux, shortcutsTaken: ["Control+Alt+Space", "Control+Alt+X"] })?.detail).toMatch(
      /^Ctrl\+Alt\+Space and Ctrl\+Alt\+X are taken by other apps, so Ask Ember is Ctrl\+Alt\+Shift\+Space and Stop everything is Ctrl\+Alt\+Shift\+X\. /);
  });

  it("keeps today's route when another app holds the fallback too, naming both chords", () => {
    const d = row({ ...linux, shortcutsTaken: ["Control+Alt+Space", "Control+Alt+Shift+Space"] })?.detail;
    expect(d).toBe("Another app already uses Ctrl+Alt+Space, Ctrl+Alt+Shift+Space. Ember keeps trying to get them; meanwhile, click Ember's handle in the corner (it has Ask, Stop everything and Settings), or, from the keyboard, open Ember again from your apps: its settings open at Ask Ember… and Stop everything, under Comfort & access.");
    // One on its fallback, one with neither: both said.
    expect(row({ ...linux, shortcutsTaken: ["Control+Alt+M", "Control+Alt+E", "Control+Alt+Shift+E"] })?.detail).toBe(
      "Ctrl+Alt+M is taken by another app, so Mute microphone is Ctrl+Alt+Shift+M. Another app already uses Ctrl+Alt+E, Ctrl+Alt+Shift+E. Ember keeps trying to get them; meanwhile, click Ember's handle in the corner (it has Ask, Stop everything and Settings), or, from the keyboard, open Ember again from your apps for its settings.");
  });

  it("names each OS's own fallbacks", () => {
    const win = { ...linux, platform: "win32", windows: { build: 22631, elevated: false, session: "console" as const, powershell: "full" as const, dpiMixed: false }, shortcuts: SHORTCUTS.win32, shortcutsTaken: ["Super+Alt+Space"] };
    expect(row(win)?.detail).toMatch(/^Win\+Alt\+Space is taken by another app, so Ask Ember is Win\+Alt\+Shift\+Space\. Win\+Alt\+Shift\+Space ask · Win\+Alt\+X stop/);
  });

  it("is unchanged while Ember holds every default", () => {
    expect(row(linux)).toMatchObject({ status: "ok", detail: "Ctrl+Alt+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone" });
  });
});

describe("the greeting names the chords Ember holds (D-45b)", () => {
  const sc = SHORTCUTS.linux, fb = FALLBACK_SHORTCUTS.linux;
  const line = (taken: string[]) => keysLine(heldShortcuts(sc, fb, taken), sc);

  it("names the defaults as before", () => {
    expect(line([])).toBe("Press Ctrl+Alt+Space to ask me anything; Ctrl+Alt+X stops me.");
  });

  it("names a fallback, and says which default another app has", () => {
    expect(line(["Control+Alt+Space"])).toBe("Press Ctrl+Alt+Shift+Space to ask me anything; Ctrl+Alt+X stops me. Another app has Ctrl+Alt+Space.");
    expect(line(["Control+Alt+Space", "Control+Alt+X"])).toBe("Press Ctrl+Alt+Shift+Space to ask me anything; Ctrl+Alt+Shift+X stops me. Another app has Ctrl+Alt+Space and Ctrl+Alt+X.");
  });

  it("keeps today's route when Ember holds neither chord of either, naming the settings chord it holds", () => {
    const both = ["Control+Alt+Space", "Control+Alt+Shift+Space", "Control+Alt+X", "Control+Alt+Shift+X"];
    expect(line([...both, "Control+Alt+E"])).toBe(
      "Click my handle in the corner to ask me something or to stop me, or press Ctrl+Alt+Shift+E: settings opens at Ask Ember… and Stop everything.");
    expect(line([...both, "Control+Alt+E", "Control+Alt+Shift+E"])).toBe(
      "Click my handle in the corner to ask me something or to stop me, or open Ember again: its settings open at Ask Ember… and Stop everything.");
  });

  it("names the chord Ember holds for one when it holds neither for the other, and the route for that one (final review U2)", () => {
    // Ask by its fallback or default; stop by neither: settings opens at Stop everything (keyboardRoute's "access:stop").
    expect(line(["Control+Alt+X", "Control+Alt+Shift+X", "Control+Alt+Space"])).toBe(
      "Press Ctrl+Alt+Shift+Space to ask me anything. To stop me, click my handle in the corner, or press Ctrl+Alt+E: settings opens at Stop everything. Another app has Ctrl+Alt+Space.");
    expect(line(["Control+Alt+X", "Control+Alt+Shift+X", "Control+Alt+E", "Control+Alt+Shift+E"])).toBe(
      "Press Ctrl+Alt+Space to ask me anything. To stop me, click my handle in the corner, or open Ember again: its settings open at Stop everything.");
    // Stop by its default; ask by neither: settings opens at Ask Ember… ("access:ask").
    expect(line(["Control+Alt+Space", "Control+Alt+Shift+Space", "Control+Alt+E"])).toBe(
      "Ctrl+Alt+X stops me. To ask me something, click my handle in the corner, or press Ctrl+Alt+Shift+E: settings opens at Ask Ember…");
    expect(keyboardRoute(["Control+Alt+Space", "Control+Alt+Shift+Space"], sc, fb)).toBe("access:ask");
    // The same on Windows and a Mac, with their own chords.
    const on = (os: OS, taken: string[]) => keysLine(heldShortcuts(SHORTCUTS[os], FALLBACK_SHORTCUTS[os], taken), SHORTCUTS[os]);
    expect(on("win32", ["Super+Alt+X", "Super+Alt+Shift+X"])).toBe(
      "Press Win+Alt+Space to ask me anything. To stop me, click my handle in the corner, or press Win+Alt+E: settings opens at Stop everything.");
    expect(on("darwin", ["Control+Shift+Command+Space", "Control+Shift+Command+A", "Control+Shift+Command+X"])).toBe(
      "Control+Shift+Command+Period stops me. To ask me something, click my handle in the corner, or press Control+Shift+Command+E: settings opens at Ask Ember… Another app has Control+Shift+Command+X.");
  });
});

/** A desktop entry's groups ("[Desktop Entry]", "[Desktop Action Ask]"), each its keys and values. */
function desktopGroups(entry: string): Record<string, Record<string, string>> {
  return Object.fromEntries(entry.split(/^(?=\[)/m).filter(g => g.trim()).map(g => {
    const [head, ...lines] = g.trim().split("\n");
    return [head, Object.fromEntries(lines.filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))];
  }));
}

/** main.ts without its comments, every run of white space made one space (it can't be loaded in a unit test). */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

describe("main.ts holds each shortcut by its default or its fallback, and names the one it holds (D-45b)", () => {
  it("registers Ember's shortcuts and the question keys through holdShortcuts with this OS's fallbacks", () => {
    expect(MAIN).toContain("const fb = FALLBACK_SHORTCUTS[platform.os];");
    expect(MAIN).toContain("holdShortcuts(ALWAYS_HELD, sc, fb, {");
    expect(MAIN).toContain("holdShortcuts(QUESTION_KEYS.map(k => k.id), sc, fb, {");
    // No accelerator is registered past it, but the menu's (never registered) and nothing else.
    expect(MAIN.match(/globalShortcut\.register\(/g)).toHaveLength(2);
  });

  it("names what it holds: the greeting, the handle menu, settings' keyboard route and the agent's and targets' words", () => {
    expect(MAIN).toContain("const holding = (id: ShortcutId): ShortcutDef | null => heldShortcuts(sc, fb, [...shortcutsTaken ?? [], ...questionTaken])[id];");
    // The settings window's chips and sentences (StatusPlatform.shortcuts).
    expect(MAIN).toContain("shortcuts: shownShortcuts(sc, heldShortcuts(sc, fb, [...shortcutsTaken ?? [], ...questionTaken])),");
    expect(MAIN).toContain("const keys = keysLine(heldShortcuts(sc, fb, shortcutsTaken ?? []), sc);");
    expect(MAIN).toContain("settingsKey: keyName(\"settings\"),");
    expect(MAIN).toContain("keyboardRoute(shortcutsTaken ?? [], sc, fb)");
    expect(MAIN).not.toMatch(/hasKey\(/);
  });
});

describe("the commands and SSH consent cards name the stop chord Ember holds (D-45b)", () => {
  const facts = { kind: "local" as const, privileged: false, windows: false, podman: false };
  const ssh = (stopKey?: string | null) => sshConsent({
    os: "linux", target: "ssh:build-01", ...(stopKey !== undefined ? { stopKey } : {}),
    facts: { label: "build-01", resolved: { user: "deploy", hostname: "build-01", port: 22, jump: [] } as unknown as SshCardFacts["resolved"], desktopOff: false, graceSeconds: 20 },
  });

  it("names the OS's default when main doesn't say, and the fallback Ember holds when it does", () => {
    expect(commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts }).body[0]).toContain(" Ctrl+Alt+X stops everything at once;");
    expect(commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts, stopKey: "Ctrl+Alt+Shift+X" }).body[0]).toContain(" Ctrl+Alt+Shift+X stops everything at once;");
    expect(ssh("Ctrl+Alt+Shift+X").body.join(" ")).toContain("quit Ember or press Ctrl+Alt+Shift+X.");
  });

  it("names Stop everything while Ember holds neither chord", () => {
    const card = commandsConsent({ os: "win32", target: "local", targetLabel: "This computer", facts, stopKey: null });
    expect(card.body[0]).toContain(" Stop everything, in Ember's handle menu and in settings, stops everything at once; what a command already changed stays changed.");
    expect(card.body.join(" ")).not.toMatch(/Win\+Alt/);
    expect(ssh(null).body.join(" ")).toContain("quit Ember or use Stop everything.");
  });

  it("the prompt window's own consent words name it the same way (round 3's shortcuts left)", () => {
    const words = (stopKey?: string | null) => consentText({ feature: "commands", os: "linux", target: "local", targetLabel: "This computer", ...(stopKey !== undefined ? { stopKey } : {}) });
    const card = (stopKey?: string | null) => commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts, ...(stopKey !== undefined ? { stopKey } : {}) });
    for (const stopKey of [undefined, "Ctrl+Alt+Shift+X", null]) expect(words(stopKey).body, String(stopKey)).toEqual(card(stopKey).body);
    const remote = (stopKey?: string | null) => consentText({
      feature: "ssh", os: "linux", target: "ssh:build-01", targetLabel: "build-01", ...(stopKey !== undefined ? { stopKey } : {}),
      ssh: { login: "deploy", hostname: "build-01", port: 22, jump: [], desktop: "headless" },
    }).body.join(" ");
    expect(remote()).toContain("quit Ember or press Ctrl+Alt+X.");
    expect(remote("Ctrl+Alt+Shift+X")).toContain("quit Ember or press Ctrl+Alt+Shift+X.");
    expect(remote(null)).toContain("quit Ember or use Stop everything.");
  });

  it("gets the chord from main at each card (targets runtime)", () => {
    const RUNTIME = fs.readFileSync(path.resolve("app/main/targets/runtime.ts"), "utf8");
    const calls = RUNTIME.match(/\b(sshConsent|commandsConsent)\(\{[^}]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) expect(c).toContain("stopKey: stopKeyNow()");
  });
});

describe("the README's keyboard routes say when settings is the way (D-45b)", () => {
  const rows = Object.fromEntries(fs.readFileSync(path.resolve("README.md"), "utf8").split("\n")
    .filter(l => /^\| (Ask Ember|Stop) \|/.test(l)).map(l => [l.split("|")[1].trim(), l]));

  it("sends the keyboard to settings only while another app holds the shortcut and its fallback, and names the launcher's Ask Ember", () => {
    // Ember's own windows have no taskbar button but settings' (skipTaskbar): its jump list is there once it is pinned.
    expect(rows["Ask Ember"]).toContain("If another app holds it and its fallback: **Ask Ember…** in settings, under **Comfort & access › Ember on screen**, or **Ask Ember** in the system's launcher (app menu, Dock menu, or the jump list once Ember is pinned to the taskbar) |");
    expect(rows.Stop).toContain("If another app holds it and its fallback: **Stop everything** under **Comfort & access › Ember on screen** |");
  });
});

describe("Ask Ember in the OS's launcher (D-45b)", () => {
  it("knows a start that asks for the ask box, first or handed over", () => {
    expect(wantsAsk(["/opt/ember/ember", "--ozone-platform=x11", "--ask"])).toBe(true);
    expect(wantsAsk(["C:\\Ember\\Ember.exe", "--allow-file-access-from-files", "--ask"])).toBe(true);
    expect(wantsAsk(["/opt/ember/ember", "--show-settings"])).toBe(false);
    expect(wantsAsk(["ember", "--asking"])).toBe(false);
  });

  it("opens the ask box at start for --ask once Ember is set up, settings before then or when the session can't work", () => {
    const at = (o: Partial<Parameters<typeof startView>[0]>) => startView({ onboarded: true, showSettings: false, atLogin: false, sessionProblem: false, ask: false, ...o });
    expect(at({ ask: true })).toBe("ask");
    expect(at({ ask: true, showSettings: true })).toBe("ask");
    expect(at({ ask: true, onboarded: false })).toBe("settings");
    expect(at({ ask: true, sessionProblem: true })).toBe("settings");
    // Today's: started by the user, settings; at login, the greeting.
    expect(at({})).toBe("settings");
    expect(at({ atLogin: true })).toBe("greet");
    expect(at({ atLogin: true, showSettings: true })).toBe("settings");
  });

  it("puts Ask Ember in the Windows jump list, starting Ember.exe with --ask", () => {
    expect(jumpListTasks({ execPath: "C:\\Users\\ana\\AppData\\Local\\Programs\\Ember\\Ember.exe", appPath: "unused", packaged: true })).toEqual([{
      program: "C:\\Users\\ana\\AppData\\Local\\Programs\\Ember\\Ember.exe", arguments: "--ask", title: "Ask Ember",
      description: "Open the ask box", iconPath: "C:\\Users\\ana\\AppData\\Local\\Programs\\Ember\\Ember.exe", iconIndex: 0,
    }]);
    // A development run: Electron with the app's folder first, quoted (it may have spaces).
    expect(jumpListTasks({ execPath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe", appPath: "C:\\My Repos\\ember", packaged: false })[0].arguments).toBe("\"C:\\My Repos\\ember\" --ask");
  });

  it("puts Ask Ember in the Dock menu on a Mac", () => {
    let asked = 0;
    const items = dockMenuItems(() => { asked++; });
    expect(items.map(i => i.label)).toEqual(["Ask Ember"]);
    items[0].click();
    expect(asked).toBe(1);
  });

  it("gives the Linux desktop entry an Ask Ember action that starts Ember with --ask (RPM and AppImage)", () => {
    const groups = desktopGroups(fs.readFileSync(path.resolve("packaging/ember.desktop"), "utf8"));
    expect(Object.keys(groups)).toEqual(["[Desktop Entry]", "[Desktop Action Ask]"]);
    expect(groups["[Desktop Entry]"]).toMatchObject({ Exec: "ember --show-settings", Actions: "Ask;" });
    expect(groups["[Desktop Action Ask]"]).toEqual({ Name: "Ask Ember", Exec: "ember --ask" });
    // The AppImage takes the entry as it is: nothing there rewrites its Exec lines (a rewrite of every Exec= would turn
    // the action into a second "open settings").
    const appimage = fs.readFileSync(path.resolve("scripts/package/appimage.sh"), "utf8");
    expect(appimage).toContain("cp \"$root/packaging/ember.desktop\" \"$app/ember.desktop\"");
    expect(appimage).not.toMatch(/\bsed\b[^\n]*ember\.desktop/);
    // The RPM installs the same file, and its launcher passes the argument on.
    expect(fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8")).toContain("install -Dm644 ember.desktop %{buildroot}%{_datadir}/applications/ember.desktop");
    expect(fs.readFileSync(path.resolve("packaging/ember"), "utf8")).toMatch(/exec "\$APP" --ozone-platform=x11 "\$@"\n?$/);
  });

  it.skipIf(process.platform === "win32")("gives the development entry the same Ask Ember action, and leaves it out of the login entry (round 3's shortcuts left)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ember-dev-entry-"));
    const r = spawnSync("bash", [path.resolve("scripts/install-desktop-entry.sh"), "--autostart"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(r.status, r.stderr).toBe(0);
    const ember = `"${path.resolve("node_modules/.bin/electron")}" "${path.resolve(".")}"`;
    const apps = desktopGroups(fs.readFileSync(path.join(home, ".local/share/applications/ember-dev.desktop"), "utf8"));
    expect(Object.keys(apps)).toEqual(["[Desktop Entry]", "[Desktop Action Ask]"]);
    expect(apps["[Desktop Entry]"]).toMatchObject({ Name: "Ember (dev)", Exec: `${ember} --show-settings`, Actions: "Ask;" });
    expect(apps["[Desktop Action Ask]"]).toEqual({ Name: "Ask Ember", Exec: `${ember} --ask` });
    // Started at login: the entry alone, with the autostart switch in its own group.
    const login = desktopGroups(fs.readFileSync(path.join(home, ".config/autostart/ember-dev.desktop"), "utf8"));
    expect(Object.keys(login)).toEqual(["[Desktop Entry]"]);
    expect(login["[Desktop Entry]"]).toMatchObject({ Exec: `${ember} --autostart`, "X-GNOME-Autostart-enabled": "true" });
    expect(login["[Desktop Entry]"]).not.toHaveProperty("Actions");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("opens the ask box for a second start's --ask on the first start's terms: set up, in a session Ember can use", () => {
    // main's second-instance asks startView as a start by the user (not at login, no --show-settings): never the greeting.
    const second = (o: { onboarded: boolean; sessionProblem: boolean }) => startView({ ...o, showSettings: false, atLogin: false, ask: true });
    expect(second({ onboarded: true, sessionProblem: false })).toBe("ask");
    expect(second({ onboarded: false, sessionProblem: false })).toBe("settings");
    expect(second({ onboarded: true, sessionProblem: true })).toBe("settings");
    // Else settings from the keyboard (at Ask Ember… or Stop everything while the keyboard needs them), not plain settings.
    expect(MAIN).toMatch(/if \(view === "ask"\) openAsk\(\{ source: "launcher" \}\); else showHomeFromKeys\(\); \}\);/);
  });

  it("main.ts opens the ask box for --ask, sets up the jump list and the Dock menu", () => {
    expect(MAIN).toContain('app.on("second-instance", (_e, argv) => { const ask = wantsAsk(argv); log.info("instance.second", ask ? { ask } : {}); const view = ask ? startView({ onboarded: settings.get().onboarded, showSettings: false, atLogin: false, sessionProblem: !!sessionGreeting(readEnvironment()), ask }) : "settings"; if (view === "ask") openAsk({ source: "launcher" }); else showHomeFromKeys(); });');
    expect(MAIN).toContain("ask: wantsAsk(process.argv)");
    expect(MAIN).toContain('if (view === "ask") openAsk({ source: "launcher" });');
    expect(MAIN).toContain('log.info("launcher.tasks", { ok: app.setUserTasks(jumpListTasks({ execPath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged })) });');
    // Each says it is set (the smoke test requires the line on its OS): whether Windows took the jump list, and the Dock menu.
    expect(MAIN).toContain('if (platform.os === "darwin" && app.dock) { app.dock.setMenu(Menu.buildFromTemplate(dockMenuItems(() => openAsk({ source: "launcher" })))); log.info("launcher.dock", {}); }');
  });
});
