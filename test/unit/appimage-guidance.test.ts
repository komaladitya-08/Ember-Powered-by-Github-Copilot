/**
 * What an AppImage user is told: the AppImage carries only Ember's Electron side, so the setup check, `ember doctor`
 * and the README name the system packages the RPM would have brought, and never a package an AppImage can't use.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctorChecks, type DoctorProbes } from "../../app/main/doctor";
import { inspectEnvironment, type EnvInputs } from "../../app/main/environment";
import { AdminPolicySchema } from "../../app/main/admin";

const linux = (over: Partial<EnvInputs> = {}): EnvInputs => ({
  env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" },
  osRelease: 'NAME="Red Hat Enterprise Linux"\nVERSION_ID="8.4"\nID="rhel"\nPRETTY_NAME="Red Hat Enterprise Linux 8.4 (Ootpa)"\n',
  glibc: "2.28", versions: { electron: "44.5.0", chrome: "140", node: "24" }, platform: "linux", arch: "x64",
  accessibility: { enabled: true, pyatspi: true }, ...over,
});
const probes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  env: inspectEnvironment(linux()), compositor: true, xtest: true, speechDispatcher: true, microphones: ["mic"],
  voiceModels: "missing", runtime: true, auth: { kind: "github", source: "stored" },
  admin: { policy: AdminPolicySchema.parse({}), source: null }, desk: { ok: true, missing: [] },
  sandbox: { userNamespaces: true, suidHelper: false }, ...over,
});
const row = (checks: ReturnType<typeof doctorChecks>, id: string) => checks.find(c => c.id === id)!;
/** The packages the RPM requires for reading apps (ember.spec): the sidecar's Python bindings and the AT-SPI bus. */
const rpmA11y = (/^Requires:\s*(platform-python.*)$/m.exec(fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8"))?.[1] ?? "")
  .split(/[,\s]+/).filter(p => /pyatspi|gobject|at-spi2-core/.test(p));

describe("an AppImage's guidance", () => {
  it("names the same packages for missing Python bindings in the setup check as in ember doctor", () => {
    const env = inspectEnvironment(linux({ accessibility: { enabled: true, pyatspi: false } }));
    const setup = env.checks.find(c => c.id === "accessibility")!;
    const doctor = row(doctorChecks(probes({ env })), "accessibility");
    expect(doctor.fix).toBe("sudo dnf install python3-pyatspi python3-gobject");
    expect(setup.detail).toContain(doctor.fix);
  });

  it("offers the release's models zip for a Linux Ember packaged without them (no separate models RPM any more)", () => {
    const fix = (sandbox: DoctorProbes["sandbox"]) => row(doctorChecks(probes({ sandbox })), "voice-models").fix ?? "";
    expect(fix({ userNamespaces: true, suidHelper: false, appImage: true })).toMatch(/download them.*Ember-voice-models zip into \/usr\/share\/ember/);
    expect(fix({ userNamespaces: true, suidHelper: false })).not.toMatch(/ember-voice-models\b(?! zip)/);
  });

  it("is in the README: the AppImage still needs the packages the RPM brings for reading apps, and its own doctor", () => {
    expect([...rpmA11y].sort()).toEqual(["at-spi2-core", "python3-gobject", "python3-pyatspi"]);
    const readme = fs.readFileSync(path.resolve("README.md"), "utf8").replace(/\s+/g, " ");
    const appImage = /Or run `Ember-[^`]+\.AppImage`[^]*?(?=## )/.exec(readme)?.[0] ?? "";
    expect(appImage).toContain(`sudo dnf install ${rpmA11y.join(" ")}`);
    expect(appImage).toMatch(/\.AppImage doctor/);
  });

  it("names every package the RPM recommends for voice, speaking and the desk in the README's optional line", () => {
    const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
    const recommends = [...spec.matchAll(/^Recommends:\s*(.+)$/gm)].flatMap(m => m[1].split(/[,\s]+/)).filter(Boolean);
    // Left out on purpose: the tray extension shows icons Ember never makes.
    expect(fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")).not.toMatch(/\bnew Tray\(/);
    const wanted = recommends.filter(p => p !== "ember-voice-models" && p !== "gnome-shell-extension-top-icons");
    // pulseaudio-utils: parec (speaker rejection, without which a spoken request never counts as yours) and pactl.
    expect(wanted).toContain("pulseaudio-utils");
    const readme = fs.readFileSync(path.resolve("README.md"), "utf8");
    const optional = /^# Optional, for [^\n]*\nsudo dnf install ([^\n]+)$/m.exec(readme)?.[1].split(/\s+/) ?? [];
    expect([...optional].sort()).toEqual([...wanted].sort());
  });
});
