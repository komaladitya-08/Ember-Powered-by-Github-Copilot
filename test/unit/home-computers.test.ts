/**
 * Settings › Computers and Commands (computers-copy.ts): what each row says and offers, and what the page asks of the
 * targets runtime. Each block names the review finding it pins.
 */
import { describe, expect, it } from "vitest";
import * as cc from "../../app/renderer/home/computers-copy";
import { AdminPolicySchema } from "../../app/main/admin";
import { SettingsSchema, type Settings } from "../../app/main/settings";
import { buildRegistry } from "../../app/main/targets/registry";
import type { TargetSummary } from "../../app/shared/targets";

const summary = (over: Partial<TargetSummary>): TargetSummary => ({ id: "local", kind: "local", label: "This computer", state: "ready", can: "apps and commands", active: true, ...over });
const ssh = (over: Partial<TargetSummary>): TargetSummary => summary({ id: "ssh:build-01", kind: "ssh", label: "build-01", active: false, ...over });
const wsl = (over: Partial<TargetSummary>): TargetSummary => summary({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", active: false, ...over });
const settings = (over: Record<string, unknown> = {}) => ({
  targets: { active: "local", offerSsh: true, dismissedOffers: [], hosts: [{ id: "build-01", dest: "deploy@build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: [] }, consent: { version: 1, at: null } }], wsl: { on: true, consent: { version: 1, at: null } }, pcId: "" },
  commands: {},
  ...over,
}) as unknown as Settings;
const noPolicy: cc.TargetsAdmin = { source: null, features: {} };
const sshRow = (t: TargetSummary) => cc.computersView({ os: "linux", settings: settings(), admin: noPolicy, summaries: [summary({}), t] }).ssh.rows[0];

describe("a computer's status says what is true and what to do next (review #156, #190)", () => {
  it("says a connected computer with nothing to use needs commands turned on, and a stalled link isn't answering", () => {
    expect(sshRow(ssh({ can: "nothing yet" }))).toMatchObject({ status: "Connected, commands off", note: "Turn on commands for build-01 under Commands to use it." });
    expect(sshRow(ssh({ can: "isn't answering" }))).toMatchObject({ status: "Connected, but not answering", note: null });
    expect(sshRow(ssh({ can: "commands once you agree" })).status).toBe("Connected: commands once you agree");
    expect(sshRow(ssh({ can: "apps and commands" })).status).toBe("Connected: apps and commands");
  });

  it("offers Cancel, not Disconnect, while connecting", () => {
    const row = sshRow(ssh({ state: "connecting", can: "connecting…" }));
    expect(row.status).toBe("Connecting…");
    expect(row.actions[0]).toMatchObject({ label: "Cancel", act: { kind: "disconnect", hostId: "build-01" }, ariaLabel: "Stop connecting to build-01" });
    expect(sshRow(ssh({}))!.actions[0]).toMatchObject({ label: "Disconnect", ariaLabel: "Disconnect build-01" });
  });

  it("says a distro is off while WSL is off in Ember, rather than not available", () => {
    const rows = cc.computersView({ os: "win32", settings: settings(), admin: noPolicy, summaries: [summary({}), wsl({ state: "unavailable", can: "WSL is off in Ember" })] }).wsl!.rows;
    expect(rows[0]).toMatchObject({ status: "Off", note: null });
    const setUp = cc.computersView({ os: "win32", settings: settings(), admin: noPolicy, summaries: [summary({}), wsl({ state: "unavailable", can: "set it up first" })] }).wsl!.rows;
    expect(setUp[0]).toMatchObject({ status: "Not available", note: "Set it up first" });
  });

  it("never says “commands once you agree only”", () => {
    const [local] = buildRegistry({
      os: "linux", admin: { policy: AdminPolicySchema.parse({}), source: null }, settings: SettingsSchema.parse({}), localDesktop: false,
      commands: () => "needs-consent", wsl: null, links: new Map(),
    });
    expect(local.can).toBe("commands once you agree");
  });
});

describe("each “Ask me before every command” switch names its computer (review #158)", () => {
  it("gives the sub-switch a name that starts with its words and ends with where", () => {
    const on = { on: true, askEvery: false, consent: { version: 1, at: null } };
    const v = cc.commandsView({
      summaries: [summary({}), wsl({}), ssh({})], admin: noPolicy,
      settings: settings({ commands: { local: on, "wsl:Ubuntu": on, "ssh:build-01": on } }),
    });
    expect(v.rows.map(r => [r.askEvery.label, r.askEvery.ariaLabel])).toEqual([
      ["Ask me before every command", "Ask me before every command on this computer"],
      ["Ask me before every command", "Ask me before every command in Ubuntu (WSL)"],
      ["Ask me before every command", "Ask me before every command on build-01"],
    ]);
  });
});

describe("adding a computer keeps what was typed until it is added (review #159, #188)", () => {
  it("clears the field only when the host was added, and says what failed otherwise", () => {
    expect(cc.addResult({ ok: true })).toEqual({ clear: true, message: "" });
    expect(cc.addResult({ ok: true, message: "build-01 is connected." })).toEqual({ clear: true, message: "build-01 is connected." });
    expect(cc.addResult({ ok: false, message: "Ember can't find bild-01.example.com. Check the name, or add it to your SSH config." }))
      .toEqual({ clear: false, message: "Ember can't find bild-01.example.com. Check the name, or add it to your SSH config." });
    expect(cc.addResult({ ok: false, message: "Not now." })).toEqual({ clear: false, message: "Not now." });
    expect(cc.addResult(undefined)).toEqual({ clear: false, message: cc.ACT_FAILED });
  });

  it("says something while the card or the connection is pending", () => {
    expect(cc.addPending("bild-01.example.com")).toBe("Connecting to bild-01.example.com… If Ember asks, answer in the window that opens.");
  });
});
