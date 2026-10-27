/**
 * The Windows rows of `ember --doctor` (win32/system/doctor.ts): microphone privacy, running as administrator, the
 * PowerShell state from system facts, PowerShell logging when a policy turns it on, and the helper's exact command
 * line, script and compiled DLL with its SHA-256 for an administrator's allow-list; Linux-only probes are left out.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BRIDGE_ARGS, cachedHelper, ELEVATED_TEXT, helperCommandRow, POWERSHELL_TEXT, win32DoctorProbes, type Win32DoctorDeps } from "../../app/main/platform/win32/system/doctor";
import { POWERSHELL_POLICY_KEY, type PowerShellFacts } from "../../app/main/platform/win32/system/powershell";
import { FakeRegistry, fakeApi, HKLM } from "./win32-system-fakes";

const DIR = "C:\\Program Files\\Ember\\resources\\sidecar\\uia";
const USER_DATA = "C:\\Users\\Ana\\AppData\\Local\\ember";
const SOURCE = Buffer.from("// ember_uia.cs\n");
const DLL_BYTES = Buffer.from("MZ compiled");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const DLL = `${USER_DATA}\\uia-cache\\ember_uia-${sha(SOURCE)}.dll`;

function deps(o: { mic?: string; elevated?: boolean | null; facts?: Partial<PowerShellFacts>; registry?: FakeRegistry; files?: Record<string, Buffer>; userData?: string | null } = {}): Win32DoctorDeps {
  const files = o.files ?? { [`${DIR}\\ember_uia.cs`]: SOURCE, [DLL]: DLL_BYTES };
  return {
    env: { SystemRoot: "C:\\Windows" },
    api: () => fakeApi(o.registry, { elevated: () => (o.elevated === undefined ? false : o.elevated) }),
    powershell: { get: () => ({ lockdown: false, gpo: null, marked: [], ...o.facts }) },
    helperDir: DIR,
    app: { getPath: (() => { if (o.userData === null) throw new Error("before ready"); return o.userData ?? USER_DATA; }) as never },
    systemPreferences: { getMediaAccessStatus: () => (o.mic ?? "granted") as never },
    readFile: p => files[p] ?? null,
  };
}

const row = async (d: Win32DoctorDeps, id: string) => (await win32DoctorProbes(d)).extra.find(r => r.id === id);

describe("the Windows doctor probes", () => {
  it("leave out what is Linux-only and check the microphone in the settings window", async () => {
    const p = await win32DoctorProbes(deps());
    expect(p).toMatchObject({ microphones: null, speechDispatcher: true, sandbox: null, fileWatchers: null, desk: null });
    expect(p.extra.map(r => r.id)).toEqual(["microphone-privacy", "elevated", "powershell", "helper-command"]);
  });

  it("warn when Windows keeps desktop apps from the microphone", async () => {
    // Both supported Windows' paths (review #100): Windows 10 22H2 calls the page "Privacy".
    expect(await row(deps({ mic: "denied" }), "microphone-privacy")).toMatchObject({ status: "warn",
      fix: "Settings › Privacy & security › Microphone (Settings › Privacy › Microphone on Windows 10) › Let desktop apps access your microphone" });
    expect(await row(deps({ mic: "granted" }), "microphone-privacy")).toMatchObject({ status: "ok", detail: "Desktop apps may use the microphone" });
    expect(await row(deps({ mic: "not-determined" }), "microphone-privacy")).toMatchObject({ status: "ok" });
  });

  it("warn when Ember runs as administrator, or can't tell", async () => {
    expect(await row(deps({ elevated: true }), "elevated")).toMatchObject({ status: "warn", detail: ELEVATED_TEXT });
    expect(await row(deps({ elevated: false }), "elevated")).toMatchObject({ status: "ok" });
    expect(await row(deps({ elevated: null }), "elevated")).toMatchObject({ status: "warn", detail: "Ember couldn't tell whether it runs as administrator." });
  });

  it("say what stops PowerShell from running the helper", async () => {
    expect(await row(deps({ facts: { lockdown: true } }), "powershell")).toMatchObject({ status: "warn", detail: POWERSHELL_TEXT.constrained });
    expect(await row(deps({ facts: { gpo: { scope: "machine", enableScripts: 1, executionPolicy: "AllSigned" } } }), "powershell")).toMatchObject({ status: "warn", detail: POWERSHELL_TEXT.policy });
    const blocked = await row(deps({ facts: { gpo: { scope: "machine", enableScripts: 1, executionPolicy: "RemoteSigned" }, marked: [`${DIR}\\ember_uia.ps1`] } }), "powershell");
    expect(blocked).toMatchObject({ status: "warn", detail: POWERSHELL_TEXT["blocked-download"] });
    expect(blocked?.fix).toMatch(/Unblock it/);
    expect(await row(deps(), "powershell")).toMatchObject({ status: "ok" });
  });

  it("note PowerShell logging turned on by policy", async () => {
    const registry = new FakeRegistry().dword(HKLM, `${POWERSHELL_POLICY_KEY}\\ModuleLogging`, "EnableModuleLogging", 1);
    expect(await row(deps({ registry }), "powershell-logging")).toMatchObject({ status: "ok", detail: "PowerShell logging is on: the accessibility helper's start-up is logged (never what is on screen)" });
    const off = new FakeRegistry().dword(HKLM, `${POWERSHELL_POLICY_KEY}\\Transcription`, "EnableTranscripting", 0);
    expect(await row(deps({ registry: off }), "powershell-logging")).toBeUndefined();
  });

  it("print the helper's command line, script and compiled DLL with its SHA-256", async () => {
    const r = await row(deps(), "helper-command");
    expect(r?.status).toBe("ok");
    expect(r?.detail).toBe(
      `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe ${BRIDGE_ARGS.join(" ")} "${DIR}\\ember_uia.ps1"`
      + ` · script ${DIR}\\ember_uia.ps1 · compiled helper ${DLL} (SHA-256 ${sha(DLL_BYTES)})`,
    );
    expect(BRIDGE_ARGS.join(" ")).toBe("-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File");
  });

  it("say when the helper isn't compiled yet, or can't be found", async () => {
    expect((await row(deps({ files: { [`${DIR}\\ember_uia.cs`]: SOURCE } }), "helper-command"))?.detail).toMatch(/not compiled yet/);
    expect((await row(deps({ files: {} }), "helper-command"))?.detail).toMatch(/unknown \(ember_uia\.cs couldn't be read\)/);
    expect((await row(deps({ userData: null }), "helper-command"))?.detail).toMatch(/unknown/);
  });
});

describe("cachedHelper and helperCommandRow", () => {
  it("name the DLL after the source's SHA-256, as the bootstrap does", () => {
    expect(cachedHelper({ helperDir: DIR, userData: USER_DATA, readFile: p => (p.endsWith(".cs") ? SOURCE : null) })).toEqual({ dll: DLL, sha256: null });
  });

  it("quote paths with spaces and use the environment's SystemRoot", () => {
    const r = helperCommandRow({ env: { SystemRoot: "D:\\Win" }, helperDir: "C:\\Ember\\uia", userData: null, readFile: () => null });
    expect(r.detail.startsWith("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo")).toBe(true);
    expect(r.detail).toContain("-File C:\\Ember\\uia\\ember_uia.ps1 ·");
  });
});
