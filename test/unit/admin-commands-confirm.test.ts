/**
 * The administrator's "confirm every action" covers commands too (review #113): a kind whose commands are on asks
 * before every command (the stricter of it and `commands.<kind>`), everywhere the commands mode is read (the PC's
 * services, the summary a remote is told, the remote's own gate).
 */

import { describe, expect, it } from "vitest";
import { AdminPolicySchema, adminSummary, combineAdmin, commandMode, parseAdminPolicy, type LoadedAdminPolicy } from "../../app/main/admin";
import { decideCommand } from "../../app/main/commands/decide";
import { classifyCommand } from "../../app/main/commands/classify";
import type { CommandMode } from "../../app/main/commands/types";
import { bindingOf, contextOf, factsOf } from "../fixtures/commands/corpus";

const FILE = "/etc/ember/policy.json";
const none: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const policy = (raw: object) => parseAdminPolicy(JSON.stringify(raw), FILE);

describe("commandMode with confirmEveryAction", () => {
  it("makes every kind whose commands are on ask for every command", () => {
    const l = policy({ confirmEveryAction: true, commands: { local: "on", wsl: "on", ssh: "ask" } });
    expect(commandMode(l, "local")).toBe("ask");
    expect(commandMode(l, "wsl")).toBe("ask");
    expect(commandMode(l, "ssh")).toBe("ask");
    expect(adminSummary(l).commands).toEqual({ local: "ask", wsl: "ask", ssh: "ask" });
  });

  it("never turns on a kind that is off, and changes nothing without it", () => {
    const off = policy({ confirmEveryAction: true, commands: { local: "off" } });
    expect(commandMode(off, "local")).toBe("off");
    expect(commandMode(off, "wsl")).toBe("off");
    expect(commandMode(policy({ confirmEveryAction: true, features: { ssh: false }, commands: { ssh: "on" } }), "ssh")).toBe("off");
    expect(commandMode(policy({ commands: { local: "on" } }), "local")).toBe("on");
    expect(commandMode(none, "local")).toBe("on");
  });

  it("reaches a remote: its summary of the PC's policy makes the remote's commands ask too", () => {
    const pc = adminSummary(policy({ confirmEveryAction: true, commands: { ssh: "on" } }));
    const remote = adminSummary(policy({ commands: { ssh: "on" } }));
    expect(combineAdmin(pc, remote).commands.ssh).toBe("ask");
  });

  it("makes an ordinary command ask where it ran straight away before, saying the organisation asks", () => {
    const decide = (mode: CommandMode) => {
      const cls = classifyCommand("ls", "bash", contextOf("linux"));
      return decideCommand({
        cls, paths: new Map(), git: null, binding: bindingOf("linux"), facts: factsOf("linux", {}),
        mode, userAskEvery: false, userWords: "", agreed: [], tainted: false, carried: null,
      });
    };
    expect(decide(commandMode(policy({ commands: { local: "on" } }), "local")).verdict).toBe("run");
    const every = decide(commandMode(policy({ confirmEveryAction: true, commands: { local: "on" } }), "local"));
    expect(every.verdict).toBe("ask");
    expect(every.rules).toContain("admin.ask");
  });
});
