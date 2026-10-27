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

  it("doesn't offer the speech models RPM to an AppImage, which can't install it beside Ember's own RPM", () => {
    const fix = (sandbox: DoctorProbes["sandbox"]) => row(doctorChecks(probes({ sandbox })), "voice-models").fix ?? "";
    expect(fix({ userNamespaces: true, suidHelper: false, appImage: true })).not.toMatch(/ember-voice-models/);
    expect(fix({ userNamespaces: true, suidHelper: false, appImage: true })).toMatch(/download them/);
    expect(fix({ userNamespaces: true, suidHelper: false })).toMatch(/or install ember-voice-models/);
  });

  it("is in the README: the AppImage still needs the packages the RPM brings for reading apps, and its own doctor", () => {
    expect([...rpmA11y].sort()).toEqual(["at-spi2-core", "python3-gobject", "python3-pyatspi"]);
    const readme = fs.readFileSync(path.resolve("README.md"), "utf8").replace(/\s+/g, " ");
    const appImage = /Or run `Ember-[^`]+\.AppImage`[^]*?(?=## )/.exec(readme)?.[0] ?? "";
    expect(appImage).toContain(`sudo dnf install ${rpmA11y.join(" ")}`);
    expect(appImage).toMatch(/\.AppImage doctor/);
  });
});
