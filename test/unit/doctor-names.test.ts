/**
 * One name for each check in the settings window's setup check and in `ember --doctor`, and one name for the tool
 * (review #229): the doctor names a row it shares with the window as the window does, with the window's own label.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { doctorChecks, type DoctorProbes } from "../../app/main/doctor";
import { inspectEnvironment } from "../../app/main/environment";
import { AdminPolicySchema } from "../../app/main/admin";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { parseDoctorReport } from "../../scripts/package/doctor-rows.mjs";

const versions = { electron: "44.5.0", chrome: "152", node: "24" };
const RHEL84 = 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.4"\nID="rhel"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n';
const probes = (over: Partial<DoctorProbes>): DoctorProbes => ({
  compositor: true, xtest: true, speechDispatcher: true, microphones: null, voiceModels: "bundled", runtime: true, auth: { kind: "github", source: "stored" },
  admin: { policy: AdminPolicySchema.parse({}), source: null }, desk: null, sandbox: null, env: inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "linux", arch: "x64" }),
  ...over,
});

describe("the doctor calls a check what the setup check calls it (review #229)", () => {
  it("on Linux: the accessibility row", () => {
    const env = inspectEnvironment({
      env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" }, osRelease: RHEL84, glibc: "2.28", versions, platform: "linux", arch: "x64",
      accessibility: { enabled: true, pyatspi: false },
    });
    const window = env.checks.find(c => c.id === "accessibility")!;
    const doctor = doctorChecks(probes({ env, microphones: [] })).find(c => c.id === "accessibility")!;
    expect(doctor.label).toBe(window.label);
    expect(doctor.fix).toBe("sudo dnf install python3-pyatspi python3-gobject");
  });

  it("on macOS: reading and using apps, the Applications folder and the microphone, once each", () => {
    const env = inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "darwin", arch: "arm64",
      mac: { version: "14.6", accessibility: false, screen: "granted", microphone: "denied", inputMonitoring: true, inApplications: false, root: false } });
    // darwin/system/doctor.ts' rows, as it writes them for these answers.
    const extra: DoctorProbes["extra"] = [
      { id: "accessibility-permission", status: "fail", label: "Accessibility", detail: "Not allowed, so Ember can't read or use apps.", fix: "System Settings › Privacy & Security › Accessibility: switch Ember on." },
      { id: "screen-recording", status: "ok", label: "Screen Recording", detail: "Allowed. macOS asks again about once a month; choose Allow." },
      { id: "microphone-permission", status: "warn", label: "Microphone access", detail: "Off for Ember, so “Hey Ember” can't hear you." },
      { id: "location", status: "warn", label: "Location", detail: "Not in the Applications folder, so its permissions and login item may not stick." },
    ];
    const checks = doctorChecks(probes({ os: "darwin", env, helper: { toolkitAccessibility: true }, extra, shortcuts: SHORTCUTS.darwin, words: PLATFORM_WORDS.darwin }));
    const label = (id: string) => env.checks.find(c => c.id === id)!.label;
    expect(checks.find(c => c.id === "accessibility-permission")).toMatchObject({ label: label("accessibility"), status: "fail" });
    expect(checks.find(c => c.id === "location")?.label).toBe(label("location"));
    expect(checks.filter(c => /microphone/i.test(c.label)).map(c => [c.id, c.label])).toEqual([["microphone-permission", label("microphone")]]);
    expect(checks.find(c => c.id === "screen-recording")?.label).toBe(label("screen-recording"));
  });

  it("on Windows: one Microphone row, the one that says what Windows allows", () => {
    const env = inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "win32", arch: "x64",
      windows: { build: 22631, elevated: false, session: "console", powershell: "full", dpiMixed: false } });
    const checks = doctorChecks(probes({
      os: "win32", env, helper: { toolkitAccessibility: true }, shortcuts: SHORTCUTS.win32, words: PLATFORM_WORDS.win32,
      extra: [{ id: "microphone-privacy", status: "ok", label: "Microphone privacy", detail: "Desktop apps may use the microphone" }],
    }));
    expect(checks.filter(c => /microphone/i.test(c.label)).map(c => [c.id, c.label])).toEqual([["microphone-privacy", "Microphone"]]);
  });

  it("is what the developer docs call the tool and each row", () => {
    const doc = (f: string) => readFileSync(new URL(`../../docs/${f}`, import.meta.url), "utf8");
    const developing = doc("DEVELOPING.md");
    for (const [f, text] of [["DEVELOPING.md", developing], ["COMMANDS-WSL-SSH.md", doc("COMMANDS-WSL-SSH.md")]]) {
      expect(text.match(/.{0,40}check-up.{0,20}/gi) ?? [], f).toEqual([]);
    }
    // The troubleshooting tables (§10.9 Windows, §11.8 macOS): a row's first cell is its label in the report.
    const rows = (heading: string) => {
      const from = developing.indexOf(heading);
      const table = developing.slice(from, developing.indexOf("\n\n", developing.indexOf("|---|", from)));
      return table.split("\n").filter(l => l.startsWith("| ") && !l.startsWith("|---")).slice(1).flatMap(l => l.split("|")[1].trim().split(/, /));
    };
    const windows = rows("### 10.9 Troubleshooting");
    const mac = rows("### 11.8 Troubleshooting");
    expect(windows).toContain("Microphone");
    expect(windows).not.toContain("Microphone privacy");
    expect(windows.filter(r => r === "Microphone")).toHaveLength(1);
    expect(mac).toEqual(expect.arrayContaining(["Reading and using apps", "Microphone", "Applications folder", "Root"]));
    for (const old of ["Accessibility", "Microphone access", "Location"]) expect(mac).not.toContain(old);
    expect(mac.filter(r => r === "Microphone")).toHaveLength(1);
  });

  it("names the tool the setup check, as the settings window does", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toContain("process.stdout.write(`Ember ${app.getVersion()} setup check\\n\\n${formatDoctor(checks)}\\n`);");
    expect(parseDoctorReport("Ember 0.1.0 setup check\n\nok    Copilot  Signed in.\n").header).toBe("Ember 0.1.0 setup check");
  });
});
