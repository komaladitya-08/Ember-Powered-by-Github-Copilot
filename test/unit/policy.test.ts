import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { AuditLog } from "../../app/main/policy/audit";

const engine = (grants: Record<string, "observe" | "act"> = {}, now = () => 0) =>
  new PolicyEngine({ neverLook: () => ["keepassxc"], grants: () => grants, now, rateLimit: 3 });
const req = (r: Partial<ActionRequest>): ActionRequest => ({ taskId: "t1", kind: "click", app: "Mousepad", window: "notes.txt", ...r });

describe("PolicyEngine", () => {
  it("lets reads through", () => {
    expect(engine().decide(req({ kind: "read" })).verdict).toBe("allow");
  });

  it("never touches password fields, secret fields, terminals or never-look apps", () => {
    const e = engine({ mousepad: "act" });
    expect(e.decide(req({ kind: "text", element: { role: "password text", name: "" }, value: "x" })).tier).toBe("never");
    expect(e.decide(req({ kind: "text", element: { role: "text", name: "Card number" }, value: "4111" })).verdict).toBe("deny");
    expect(e.decide(req({ kind: "text", element: { role: "terminal", name: "" }, value: "rm -rf ~" })).verdict).toBe("deny");
    expect(e.decide(req({ app: "KeePassXC", element: { role: "push button", name: "OK" } })).verdict).toBe("deny");
    expect(e.decide(req({ app: "polkit-gnome-authentication-agent-1", window: "Authentication Required", element: { role: "push button", name: "Authenticate" } })).verdict).toBe("deny");
  });

  it("asks before the first action in an app, then not once granted", () => {
    const first = engine().decide(req({ element: { role: "push button", name: "Bold" } }));
    expect(first).toMatchObject({ verdict: "confirm", needsGrant: true });
    expect(first.prompt).toContain("Mousepad");
    expect(engine({ mousepad: "act" }).decide(req({ element: { role: "push button", name: "Bold" } })).verdict).toBe("allow");
  });

  it("always asks for risky clicks, even with a grant", () => {
    const d = engine({ mousepad: "act" }).decide(req({ element: { role: "push button", name: "Delete" } }));
    expect(d).toMatchObject({ verdict: "confirm", tier: "confirm", risky: true });
    expect(d.prompt).toBe("Click “Delete” push button in Mousepad?");
  });

  it("builds the prompt from the request, not from model text", () => {
    const d = engine().decide(req({ kind: "text", element: { role: "text", name: "Subject" }, value: "Hello" }));
    expect(d.prompt).toBe("Let me work in Mousepad? First step: type “Hello” into “Subject” text.");
  });

  it("runs tier-0 settings and app launches without asking", () => {
    expect(engine().decide(req({ kind: "setting", app: "", window: "", value: "Night Light → on" })).verdict).toBe("allow");
    expect(engine().decide(req({ kind: "open_app", app: "", window: "", value: "Files" })).verdict).toBe("allow");
  });

  it("rate-limits a runaway task", () => {
    const e = engine({ mousepad: "act" });
    const click = req({ element: { role: "push button", name: "Bold" } });
    for (let i = 0; i < 3; i++) expect(e.decide(click).verdict).toBe("allow");
    expect(e.decide(click).verdict).toBe("deny");
    expect(e.decide({ ...click, taskId: "t2" }).verdict).toBe("allow");
  });
});

describe("AuditLog", () => {
  it("appends JSON lines with owner-only permissions and prunes old months", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-audit-"));
    let now = new Date("2026-10-15T10:00:00Z");
    const log = new AuditLog(dir, () => now);
    log.write({ event: "decision", task: "t1", verdict: "allow" });
    log.write({ event: "action", task: "t1", ok: true });
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ t: "2026-10-15T10:00:00.000Z", event: "decision", verdict: "allow" });
    expect(fs.statSync(log.file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(dir, "audit-2026-01.jsonl"), "{}\n");
    now = new Date("2026-10-20T00:00:00Z");
    log.prune(30);
    expect(fs.existsSync(path.join(dir, "audit-2026-01.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "audit-2026-10.jsonl"))).toBe(true);
  });
});
