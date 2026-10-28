/**
 * main.ts's privacy wiring (design §4.5, §11.3 hook 2; critique integration-1): the WSL-aware union is built on top of
 * today's terminal check, isTerminalWindowApp with the OS's app catalogue, so on macOS a terminal shown under another
 * name is still known by its bundle id, and the PolicyEngine, Perception and the hands judge windows through that union.
 * main.ts can't be loaded in a unit test (it is Electron's entry point), so the wiring is read from its source and the
 * same composition is run here with the real wslAwarePrivacy (S0a's stub), the real macOS catalogue over bundles in a
 * temporary folder (darwin-terminal-window-app.test.ts's fakes) and the real PolicyEngine. The other Step 0b hooks
 * main.ts must keep (for the packages that replace S0a's stubs) are checked to be there too.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { darwinApps } from "../../app/main/platform/darwin/system/apps";
import { isTerminalApp, isTerminalWindowApp } from "../../app/main/hands/system";
import { isSecurityWindow, PolicyEngine } from "../../app/main/policy/policy";
import { wslAwarePrivacy } from "../../app/main/wsl/privacy";
import { KEYS } from "../../app/shared/shortcuts";
import type { AppCatalog, AppIdentity } from "../../app/main/platform/types";

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** An XML Info.plist with these string keys. */
const infoXml = (keys: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${
  Object.entries(keys).map(([k, v]) => `  <key>${k}</key>\n  <string>${v}</string>`).join("\n")}\n</dict>\n</plist>\n`;

function bundle(dir: string, name: string, keys: Record<string, string>): void {
  const b = path.join(dir, name);
  fs.mkdirSync(path.join(b, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(b, "Contents", "Info.plist"), infoXml(keys));
}

describe("main.ts's privacy wiring (critique integration-1)", () => {
  it("builds the WSL-aware union on isTerminalWindowApp with the OS's catalogue, and hands the union to the policy and Perception", () => {
    expect(MAIN).toContain("const privacy = wslAwarePrivacy({ isSecurityWindow: sys.privacy.isSecurityWindow, isTerminalApp: a => isTerminalWindowApp(a.name ?? a.id, sys.apps, platform.os) });");
    expect(MAIN).toContain("isTerminalApp: name => privacy.isTerminalApp({ id: name, name }),");
    expect(MAIN).toContain("keys: sys.keys, os: platform.os, isSecurityWindow: privacy.isSecurityWindow,");
    expect(MAIN).toContain("words: sys.words, isSecurityWindow: privacy.isSecurityWindow,");
    // Today's direct wiring is gone: nothing judges a window around the union.
    expect(MAIN).not.toContain("isTerminalApp: name => isTerminalWindowApp(");
    expect(MAIN).not.toMatch(/isSecurityWindow: sys\.privacy\.isSecurityWindow,? (?!isTerminalApp)/);
  });

  describe("run as main wires it, on macOS (darwin-terminal-window-app.test.ts's bundles)", () => {
    let root: string;
    let catalogue: AppCatalog;
    /** main.ts's composition, with macOS's catalogue and vocabulary. */
    const wired = () => {
      const privacy = wslAwarePrivacy({ isSecurityWindow: w => isSecurityWindow(w, "darwin"), isTerminalApp: (a: AppIdentity) => isTerminalWindowApp(a.name ?? a.id, catalogue, "darwin") });
      const policy = new PolicyEngine({
        neverLook: () => [], grants: () => ({ "shell window": "act", notes: "act" }), keys: KEYS.darwin, os: "darwin",
        isTerminalApp: name => privacy.isTerminalApp({ id: name, name }), isSecurityWindow: privacy.isSecurityWindow,
      });
      return { privacy, policy };
    };

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-privacy-wiring-"));
      const apps = path.join(root, "Applications");
      // Apple's Terminal, renamed: its file and display names say nothing; its executable and bundle id do.
      bundle(path.join(apps, "Utilities"), "Shell Window.app", { CFBundleExecutable: "Terminal", CFBundleIdentifier: "com.apple.Terminal" });
      bundle(apps, "Warp Preview.app", { CFBundleExecutable: "preview", CFBundleIdentifier: "dev.warp.Warp-Preview", CFBundleName: "Warp Preview" });
      bundle(apps, "Kitten.app", { CFBundleExecutable: "launcher", CFBundleIdentifier: "net.kovidgoyal.kitty" });
      bundle(apps, "Notes.app", { CFBundleExecutable: "Notes", CFBundleIdentifier: "com.apple.Notes", CFBundleName: "Notes" });
      catalogue = darwinApps({ roots: [{ dir: apps, vendors: true }, { dir: path.join(apps, "Utilities") }], extraBundles: [], home: () => root });
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("still refuses acting in Terminal shown under another name, by its bundle id, through wslAwarePrivacy", () => {
      const { privacy, policy } = wired();
      // By name alone it would pass: only the catalogue's bundle id tells.
      expect(isTerminalApp({ id: "Shell Window", name: "Shell Window" }, "darwin")).toBe(false);
      expect(privacy.isTerminalApp({ id: "Shell Window", name: "Shell Window" })).toBe(true);
      const click = (app: string) => policy.decide({ taskId: "t", kind: "click", app, window: "Default", element: { role: "menu item", name: "Paste" } });
      expect(click("Shell Window")).toMatchObject({ tier: "never", reason: "Ember doesn't run commands, so it never acts in terminals or apps with a shell built in" });
      expect(click("Kitten").tier).toBe("never");
      expect(policy.decide({ taskId: "t", kind: "open_app", app: "Warp Preview", window: "" })).toMatchObject({ tier: "never", reason: "Ember doesn't run commands, so it never opens terminals" });
      // An ordinary app is judged as before.
      expect(click("Notes").tier).not.toBe("never");
    });

    it("keeps macOS's security windows refused through the union", () => {
      const { privacy, policy } = wired();
      expect(privacy.isSecurityWindow({ app: "SecurityAgent", title: "" })).toBe(true);
      expect(policy.decide({ taskId: "t", kind: "click", app: "SecurityAgent", window: "Authenticate", element: { role: "push button", name: "OK" } }))
        .toMatchObject({ tier: "never", reason: "authentication and security windows are for the user only" });
    });
  });
});

describe("main.ts's Step 0b hooks (§11.3), for the packages that replace S0a's stubs", () => {
  const hooks: [string, string[]][] = [
    ["1: the imports and the runtime beside the agent", [
      'import { createTargets, targetDoctorRows, wslSwitchOn, type TargetsRuntimeExtra } from "./targets/runtime";', 'import { wrapForWsl } from "./wsl/routed-sidecar";',
      'import { wrapWindowsForWsl } from "./wsl/routed-windows";', 'import { wslAwarePrivacy, wslAwareSystem } from "./wsl/privacy";',
      "let targets: (TargetsRuntime & TargetsRuntimeExtra) | null = null;",
    ]],
    ["2: the routed sidecar and window system for Perception and the hands", [
      "const wslOptions = { os: platform.os, log: log.child(\"wsl\"), ws: () => wsRef, wsl: () => targets?.wsl ?? null, settings };",
      "const seenBy = wrapForWsl(sidecar, wslOptions);", "const wsSeen = ws && wrapWindowsForWsl(ws, wslOptions);",
      "sidecar: seenBy, x11: wsSeen,", "perception, sidecar: seenBy, audit, confirmer,", "const w = wsSeen.activeWindow();",
      "const w = wsSeen.focusWindow() ?? wsSeen.activeWindow();",
    ]],
    ["3: the targets runtime, whether or not there are hands", [
      "targets = createTargets({", "localHands: hands ?? null,", "isHome: sender =>",
      // The runtime's channels hear only Ember's own bundled pages.
      'const fromPage = (e: { senderFrame: { url: string } | null }) => isTrustedSender(e.senderFrame?.url ?? "");',
      "if (fromPage(e)) fn({ sender: e.sender }, ...args);", "if (!fromPage(e)) throw new Error(", "windows: { command: () => createCommandWindow(platform.os), prompt: () => createPromptWindow(platform.os) },",
      "fetch: (u, i) => net.fetch(u, i),", "elevated: () =>", "emberPids: () =>", "app.getAppMetrics()", "extraPath: () =>",
      'jobHost: platform.os === "win32" ? { execPath: process.execPath, script: path.join(__dirname, "job-host.cjs") } : null,',
    ]],
    ["4: AgentHost's system, targets and task base", ["system: wslAwareSystem(sys),", "targets: targets.agent,", "taskBase: { audit, confirmer },"]],
    ["5: the kill switch's part", ['{ name: "targets", stop: () => targets?.stopAll() },']],
    ["6: panel questions", ["panelReady: n => targets?.panelReady(n) ?? false,", "targets?.questionChanged(q);", "targets?.questionWords(q.question)"]],
    ["7: bubble actions", ['!id.startsWith("ui:cmdstop:")', "if (targets?.bubbleAction(id)) return;", 'confirmer?.answer(id, "bubble")']],
    ["8: the menu", ["...menuOptions(targets?.menuItems() ?? [], () => { opens = true; }),"]],
    ["9: a remote's quick context first", ["const remote = targets?.quickContext();"]],
    ["10: the quit words", ["quitQuestion(busyTasks(), targets?.busy() ?? { commands: 0, connections: 0 },"]],
    ["11: dispose at quit", ['app.on("will-quit", () => { void targets?.dispose(); });']],
    ["12: the doctor's rows", ["...(await targetDoctorRows({ os: platform.os, sys, admin: () => admin, resourcesPath: process.resourcesPath, packaged: app.isPackaged, wslOn: wslSwitchOn(settingsText()) }))"]],
    ["the settings page can't skip a consent card (S0a review)", ["const { patch, dropped } = settingsFromHome(sent);"]],
  ];
  for (const [hook, snippets] of hooks) {
    it(`keeps hook ${hook}`, () => {
      for (const s of snippets) expect(MAIN, s).toContain(s);
    });
  }

  it("asks the targets runtime for a quick context before the early return without perception, and after consent", () => {
    const consent = MAIN.indexOf("if (!consented()) { callContext = Promise.resolve(null); return; }");
    const remote = MAIN.indexOf("const remote = targets?.quickContext();");
    const local = MAIN.indexOf("if (!perception) { callContext = Promise.resolve(null); return; }");
    expect(consent).toBeGreaterThan(0);
    expect(remote).toBeGreaterThan(consent);
    expect(local).toBeGreaterThan(remote);
  });

  it("lets the kill switch stop commands right after the agent", () => {
    expect(MAIN).toMatch(/\{ name: "agent", stop: \(\) => agent\?\.abortAll\(\) \}, \{ name: "targets", stop: \(\) => targets\?\.stopAll\(\) \},/);
  });

  it("records settings' Stop everything as coming from settings, the handle's as from its menu", () => {
    expect(MAIN).toContain('ipcMain.handle(IPC.stopEverything, guard(() => { stopEverything("settings"); }));');
    expect(MAIN).toContain('click: () => stopEverything("menu") }');
  });

  it("opens settings from the keyboard at Ask Ember… while another app holds the ask shortcut (review #45)", () => {
    expect(MAIN).toContain("const showHomeFromKeys = () => { showHome(); const at = keyboardRoute(shortcutsTaken ?? [], sc); if (at) sendToHome(IPC.focusSection, at); };");
    // Ember started again, the Dock, and the settings shortcut; not the handle menu's Settings… (a pointer's way).
    expect(MAIN).toContain('app.on("second-instance", () => { log.info("instance.second", {}); showHomeFromKeys(); });');
    expect(MAIN).toContain('app.on("activate", () => showHomeFromKeys());');
    expect(MAIN).toContain("[sc.settings.accel]: showHomeFromKeys,");
    expect(MAIN).toContain("click: () => { opens = true; showHome(); } },");
  });
});
