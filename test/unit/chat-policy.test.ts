/**
 * The organisation's policy as a native chat session takes it (chat-policy.ts): the SDK's managedSettings where it has
 * a counterpart, the permission modes left open, and whether a person may approve for longer than once.
 */

import { describe, expect, it } from "vitest";
import { AdminPolicySchema, heldUntilRestart, lockedDown, type LoadedAdminPolicy } from "../../app/main/admin";
import { ASK_EVERYTHING, chatPolicy } from "../../app/main/agent/chat-policy";

const file = (policy: Record<string, unknown>): LoadedAdminPolicy => ({ policy: AdminPolicySchema.parse(policy), source: "/etc/ember/policy.json" });
const none: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const ON = { commands: { local: "on" } };

describe("the organisation's policy for native chats", () => {
  it("adds nothing without a policy file: every SDK mode is open and standing approvals are offered", () => {
    expect(chatPolicy(none)).toEqual({ managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true });
  });

  it("allows no chat at all under LOCKDOWN, a policy held until a restart, or with acting off", () => {
    expect(chatPolicy(lockedDown("/etc/ember/policy.json", "broken"))).toBeNull();
    expect(chatPolicy(heldUntilRestart(none))).toBeNull();
    expect(chatPolicy(file({ ...ON, features: { actions: false } }))).toBeNull();
  });

  it("caps the SDK's modes as approvals.maxMode caps Ember's", () => {
    expect(chatPolicy(file({ ...ON, approvals: { maxMode: "interactive" } }))).toEqual({
      managedSettings: { permissions: { disableBypassPermissionsMode: "disable", disableAssistedPermissionsMode: true } }, permissionModes: ["manual"], standing: true,
    });
    expect(chatPolicy(file({ ...ON, approvals: { maxMode: "assisted" } }))).toEqual({
      managedSettings: { permissions: { disableBypassPermissionsMode: "disable" } }, permissionModes: ["manual", "assisted"], standing: true,
    });
    expect(chatPolicy(file({ ...ON, approvals: { maxMode: "autopilot" } }))?.permissionModes).toEqual(["manual", "assisted", "allow-all"]);
  });

  it("turns the SDK's judge off with features.aiReview: false", () => {
    expect(chatPolicy(file({ ...ON, features: { aiReview: false } }))).toEqual({
      managedSettings: { permissions: { disableAssistedPermissionsMode: true } }, permissionModes: ["manual", "allow-all"], standing: true,
    });
  });

  it("keeps every request with a person, once at a time, without approval modes, without grants, or confirming every action", () => {
    for (const p of [{ features: { autonomy: false } }, { allowGrants: false }]) {
      expect(chatPolicy(file({ ...ON, ...p }))).toEqual({
        managedSettings: { permissions: { disableBypassPermissionsMode: "disable", disableAssistedPermissionsMode: true } }, permissionModes: ["manual"], standing: false,
      });
    }
    expect(chatPolicy(file({ ...ON, confirmEveryAction: true }))).toEqual({
      managedSettings: { permissions: { disableBypassPermissionsMode: "disable", disableAssistedPermissionsMode: true, ask: [...ASK_EVERYTHING] } },
      permissionModes: ["manual"], standing: false,
    });
  });

  it("denies the shell where the policy turns commands on this computer off (or never names them), and asks where it says ask", () => {
    expect(chatPolicy(file({}))?.managedSettings).toEqual({ permissions: { deny: ["Shell"] } });
    expect(chatPolicy(file({ commands: { local: "off" } }))?.managedSettings).toEqual({ permissions: { deny: ["Shell"] } });
    expect(chatPolicy(file({ commands: { local: "ask" } }))?.managedSettings).toEqual({ permissions: { ask: ["Shell"] } });
  });

  it("denies every MCP tool with extensions off", () => {
    expect(chatPolicy(file({ ...ON, features: { extensions: false } }))?.managedSettings).toEqual({ permissions: { deny: ["Mcp(*)"] } });
  });

  it("only ever tightens: no field of the policy opens a mode or a grant", () => {
    const open = chatPolicy(none)!;
    for (const p of [{ maxActionsPerMinute: 5 }, { neverLook: ["Firefox"] }, { auditRetentionDays: 3 }, { features: { voice: false, memory: false, ssh: false, screenImages: false } }]) {
      const got = chatPolicy(file({ ...ON, ...p }))!;
      expect(got.permissionModes).toEqual(open.permissionModes);
      expect(got.standing).toBe(true);
    }
  });
});
