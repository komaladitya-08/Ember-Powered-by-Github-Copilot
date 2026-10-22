/**
 * The Windows setup-check inputs and fixes (win32/system/environment.ts, powershell.ts): the build, the session,
 * elevation and the PowerShell state in every case §9.8 lists, decided from facts (Constrained Language Mode, the
 * Group Policy execution policy with machine policy first, the helper files' Mark-of-the-Web, the helper's own
 * answer), never from an error message's wording; the facts kept for a minute; and the two fixes: the microphone
 * settings page, and "Unblock it", which removes exactly the two helper files' Zone.Identifier streams and only in
 * the RemoteSigned case.
 */

import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import type { HelperStatus } from "../../app/main/platform/types";
import { sessionKind, win32Environment, windowsBuild, WIN32_FIX_IDS } from "../../app/main/platform/win32/system/environment";
import {
  FACTS_MS, helperDir, POWERSHELL_POLICY_KEY, powershellFacts, powershellState, readExecutionPolicy, remoteSignedOnly, signedOnly, unblockHelper,
  type PowerShellFacts,
} from "../../app/main/platform/win32/system/powershell";
import { FakeRegistry, fakeApi, HKCU, HKLM } from "./win32-system-fakes";

const DIR = "C:\\Program Files\\Ember\\resources\\sidecar\\uia";
const PS1 = `${DIR}\\ember_uia.ps1`, CS = `${DIR}\\ember_uia.cs`;
const facts = (o: Partial<PowerShellFacts> = {}): PowerShellFacts => ({ lockdown: false, gpo: null, marked: [], ...o });
const helper = (o: Partial<HelperStatus> = {}): HelperStatus => ({ toolkitAccessibility: true, ...o });

describe("windowsBuild and sessionKind", () => {
  it("reads the build from the system version", () => {
    expect(windowsBuild("10.0.22631")).toBe(22631);
    expect(windowsBuild("10.0.19045.4170")).toBe(19045);
    expect(windowsBuild("garbage")).toBe(0);
  });

  it("tells a service's session, a remote desktop and the console apart", () => {
    expect(sessionKind({ SESSIONNAME: "Console" }, 1)).toBe("console");
    expect(sessionKind({ SessionName: "RDP-Tcp#3" }, 2)).toBe("rdp");
    expect(sessionKind({ SESSIONNAME: "Console" }, 0)).toBe("service");
    expect(sessionKind({}, null)).toBe("console");
  });
});

describe("the execution policy set by Group Policy", () => {
  it("reads machine policy first, then user policy, and nothing when neither is set", () => {
    const both = new FakeRegistry().dword(HKLM, POWERSHELL_POLICY_KEY, "EnableScripts", 1).sz(HKLM, POWERSHELL_POLICY_KEY, "ExecutionPolicy", "AllSigned")
      .dword(HKCU, POWERSHELL_POLICY_KEY, "EnableScripts", 1).sz(HKCU, POWERSHELL_POLICY_KEY, "ExecutionPolicy", "Unrestricted");
    expect(readExecutionPolicy(fakeApi(both))).toEqual({ scope: "machine", enableScripts: 1, executionPolicy: "AllSigned" });
    const user = new FakeRegistry().dword(HKCU, POWERSHELL_POLICY_KEY, "EnableScripts", 0);
    expect(readExecutionPolicy(fakeApi(user))).toEqual({ scope: "user", enableScripts: 0, executionPolicy: null });
    expect(readExecutionPolicy(fakeApi())).toBeNull();
    expect(readExecutionPolicy(null)).toBeNull();
  });

  it("knows which policies refuse every unsigned script and which refuse downloaded ones", () => {
    expect(signedOnly({ scope: "machine", enableScripts: 0, executionPolicy: null })).toBe(true);
    expect(signedOnly({ scope: "machine", enableScripts: 1, executionPolicy: "allsigned" })).toBe(true);
    expect(signedOnly({ scope: "user", enableScripts: 1, executionPolicy: "Restricted" })).toBe(true);
    expect(signedOnly({ scope: "machine", enableScripts: 1, executionPolicy: "RemoteSigned" })).toBe(false);
    expect(remoteSignedOnly({ scope: "machine", enableScripts: 1, executionPolicy: "RemoteSigned" })).toBe(true);
    expect(remoteSignedOnly({ scope: "machine", enableScripts: 0, executionPolicy: "RemoteSigned" })).toBe(false);
    expect(signedOnly(null) || remoteSignedOnly(null)).toBe(false);
  });
});

describe("powershellState", () => {
  const allSigned = { scope: "machine" as const, enableScripts: 1, executionPolicy: "AllSigned" };
  const remoteSigned = { scope: "machine" as const, enableScripts: 1, executionPolicy: "RemoteSigned" };

  it("is constrained under __PSLockdownPolicy or when the helper reports Constrained Language Mode, before anything else", () => {
    expect(powershellState(facts({ lockdown: true, gpo: allSigned }), helper())).toBe("constrained");
    expect(powershellState(facts(), helper({ toolkitAccessibility: false, languageMode: "ConstrainedLanguage", detail: "Cannot invoke method" }))).toBe("constrained");
  });

  it("is policy under a signed-only Group Policy, whatever the helper said", () => {
    expect(powershellState(facts({ gpo: allSigned }), helper())).toBe("policy");
    expect(powershellState(facts({ gpo: { scope: "user", enableScripts: 0, executionPolicy: null } }), undefined)).toBe("policy");
  });

  it("is blocked-download under RemoteSigned with a marked helper file, and not without the mark", () => {
    expect(powershellState(facts({ gpo: remoteSigned, marked: [PS1] }), helper({ toolkitAccessibility: false }))).toBe("blocked-download");
    expect(powershellState(facts({ gpo: remoteSigned }), helper())).toBe("full");
    expect(powershellState(facts({ marked: [PS1] }), helper())).toBe("full"); // no policy: -ExecutionPolicy Bypass applies
  });

  it("follows the helper's own answer otherwise, keyed on facts, not on its message", () => {
    expect(powershellState(facts(), undefined)).toBe("unknown");
    expect(powershellState(facts(), null)).toBe("unknown");
    expect(powershellState(facts(), helper({ toolkitAccessibility: null }))).toBe("unknown");
    expect(powershellState(facts(), helper({ toolkitAccessibility: false, detail: "execution policy ConstrainedLanguage AllSigned" }))).toBe("missing");
    expect(powershellState(facts(), helper())).toBe("full");
  });
});

describe("the PowerShell facts", () => {
  it("are read from the registry, the environment and the helper files' streams, and kept for a minute", () => {
    const registry = new FakeRegistry().dword(HKLM, POWERSHELL_POLICY_KEY, "EnableScripts", 1).sz(HKLM, POWERSHELL_POLICY_KEY, "ExecutionPolicy", "RemoteSigned");
    const streams = new Set([`${PS1}:Zone.Identifier`]);
    let clock = 0;
    const asked: string[] = [];
    const ps = powershellFacts({ api: () => fakeApi(registry), env: { __pslockdownpolicy: "4" }, dir: DIR, exists: p => { asked.push(p); return streams.has(p); }, now: () => clock });
    expect(ps.get()).toEqual({ lockdown: true, gpo: { scope: "machine", enableScripts: 1, executionPolicy: "RemoteSigned" }, marked: [PS1] });
    expect(asked).toEqual([`${PS1}:Zone.Identifier`, `${CS}:Zone.Identifier`]);
    streams.clear();
    clock = FACTS_MS - 1;
    expect(ps.get().marked).toEqual([PS1]);
    expect(ps.get(true).marked).toEqual([]);
    streams.add(`${CS}:Zone.Identifier`);
    clock += FACTS_MS;
    expect(ps.get().marked).toEqual([CS]);
  });

  it("find the helper beside Ember's resources when packaged, in the repository in development", () => {
    expect(helperDir({ packaged: true, resourcesPath: "C:\\Ember\\resources", appPath: "C:\\Ember\\resources\\app.asar" })).toBe("C:\\Ember\\resources\\sidecar\\uia");
    expect(helperDir({ packaged: false, resourcesPath: "C:\\x", appPath: "C:\\src\\ember" })).toBe("C:\\src\\ember\\sidecar\\uia");
  });
});

describe("unblockHelper", () => {
  const remoteSigned = { scope: "machine" as const, enableScripts: 1, executionPolicy: "RemoteSigned" };

  it("removes exactly the marked helper files' Zone.Identifier streams in the RemoteSigned case", () => {
    const removed: string[] = [];
    unblockHelper(facts({ gpo: remoteSigned, marked: [PS1, CS] }), p => removed.push(p));
    expect(removed).toEqual([`${PS1}:Zone.Identifier`, `${CS}:Zone.Identifier`]);
  });

  it("refuses where unblocking can't help, or there is nothing to unblock", () => {
    const rm = () => { throw new Error("nothing may be removed"); };
    expect(() => unblockHelper(facts({ lockdown: true, gpo: remoteSigned, marked: [PS1] }), rm)).toThrow(/restricted on this computer/);
    expect(() => unblockHelper(facts({ gpo: { ...remoteSigned, executionPolicy: "AllSigned" }, marked: [PS1] }), rm)).toThrow(/only signed PowerShell scripts/);
    expect(() => unblockHelper(facts({ gpo: remoteSigned }), rm)).toThrow(/nothing to unblock/);
    expect(() => unblockHelper(facts({ marked: [PS1] }), rm)).toThrow(/nothing to unblock/);
  });
});

describe("the Windows environment inputs", () => {
  const make = (o: { registry?: FakeRegistry; env?: NodeJS.ProcessEnv; elevated?: boolean | null; session?: number | null; streams?: Set<string> } = {}) => {
    const elevatedCalls: number[] = [];
    const api = fakeApi(o.registry, {
      elevated: () => { elevatedCalls.push(1); return o.elevated ?? false; },
      sessionId: () => (o.session === undefined ? 1 : o.session),
    });
    const removed: string[] = [];
    const opened: string[] = [];
    const ps = powershellFacts({ api: () => api, env: o.env ?? {}, dir: DIR, exists: p => !!o.streams?.has(p) });
    const e = win32Environment({
      env: o.env ?? { SESSIONNAME: "Console" }, api: () => api, powershell: ps, shell: { openExternal: async url => { opened.push(url); } },
      systemVersion: () => "10.0.22631", versions: { electron: "44.5.0", chrome: "146.0", node: "24.1.0" }, arch: "x64", pid: 4242,
      rm: p => { removed.push(p); o.streams?.delete(p); },
    });
    return { e, removed, opened, elevatedCalls };
  };

  it("builds the inputs inspectEnvironment needs, with the Windows block", () => {
    const { e } = make({ elevated: true });
    expect(e.environment({ windows: null, shortcutsTaken: ["Super+Alt+Space"], helper: helper({ dpi: "PerMonitorV2", processDpi: "System" }) })).toEqual({
      env: { SESSIONNAME: "Console" }, osRelease: null, glibc: null, versions: { electron: "44.5.0", chrome: "146.0", node: "24.1.0" },
      platform: "win32", arch: "x64", shortcutsTaken: ["Super+Alt+Space"], shortcuts: SHORTCUTS.win32,
      windows: { build: 22631, elevated: true, session: "console", powershell: "full", dpiMixed: true },
    });
  });

  it("reads elevation once, and treats an unknown answer as not elevated", () => {
    const { e, elevatedCalls } = make({ elevated: false });
    e.environment({ windows: undefined });
    e.environment({ windows: undefined });
    expect(elevatedCalls).toHaveLength(1);
    expect(make({ elevated: null }).e.environment({ windows: undefined }).windows.elevated).toBe(false);
  });

  it("says unknown before the helper answered, and doesn't call DPI mixed without both answers", () => {
    const w = make().e.environment({ windows: undefined }).windows;
    expect(w.powershell).toBe("unknown");
    expect(w.dpiMixed).toBe(false);
    expect(make().e.environment({ windows: undefined, helper: helper({ dpi: "PerMonitorV2", processDpi: "PerMonitorV2" }) }).windows.dpiMixed).toBe(false);
  });

  it("reports a service session", () => {
    expect(make({ session: 0 }).e.environment({ windows: undefined }).windows.session).toBe("service");
  });

  it("offers the microphone settings and Unblock it, with their labels", async () => {
    const { e, opened } = make();
    expect(e.fixes.ids).toEqual(WIN32_FIX_IDS);
    expect(e.fixes.ids).toEqual(["open-microphone-settings", "unblock-helper"]);
    expect(e.fixes.label("open-microphone-settings")).toBe("Open Settings");
    expect(e.fixes.label("unblock-helper")).toBe("Unblock it");
    await e.fixes.apply("open-microphone-settings");
    expect(opened).toEqual(["ms-settings:privacy-microphone"]);
    await expect(e.fixes.apply("enable-accessibility")).rejects.toThrow("unknown fix: enable-accessibility");
  });

  it("unblocks a downloaded helper only in the RemoteSigned case, then reads the state again", async () => {
    const registry = new FakeRegistry().dword(HKLM, POWERSHELL_POLICY_KEY, "EnableScripts", 1).sz(HKLM, POWERSHELL_POLICY_KEY, "ExecutionPolicy", "RemoteSigned");
    const streams = new Set([`${PS1}:Zone.Identifier`, `${CS}:Zone.Identifier`]);
    const { e, removed } = make({ registry, streams });
    expect(e.environment({ windows: undefined, helper: helper({ toolkitAccessibility: false }) }).windows.powershell).toBe("blocked-download");
    await e.fixes.apply("unblock-helper");
    expect(removed).toEqual([`${PS1}:Zone.Identifier`, `${CS}:Zone.Identifier`]);
    expect(e.environment({ windows: undefined, helper: helper() }).windows.powershell).toBe("full");
    const signed = make({ registry: new FakeRegistry().dword(HKLM, POWERSHELL_POLICY_KEY, "EnableScripts", 1).sz(HKLM, POWERSHELL_POLICY_KEY, "ExecutionPolicy", "AllSigned"), streams: new Set([`${PS1}:Zone.Identifier`]) });
    await expect(signed.e.fixes.apply("unblock-helper")).rejects.toThrow(/only signed/);
    expect(signed.removed).toEqual([]);
  });
});
