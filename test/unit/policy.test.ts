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

describe("policy: review fixes (screen text can't hide risk)", () => {
  const e = new PolicyEngine({ neverLook: () => ["keepassxc"], grants: () => ({ firefox: "act", gedit: "act" }), isTerminalApp: n => /terminal|xterm/i.test(n) });
  const click = (name: string, window = "Page", goal = "pay invoice 4411") => e.decide({ taskId: "t", kind: "click", app: "Firefox", window, element: { role: "push button", name }, goal });

  it("look-alike letters, invisible characters and typographic apostrophes don't hide a risky word", () => {
    for (const name of ["Dеlete account", "De­lete", "Del​ete", "Ｓｅｎｄ", "Don’t Save"]) expect(click(name).verdict).toBe("confirm");
  });
  it("covers overwrite dialogs, trash, authorising apps and merges", () => {
    for (const name of ["Replace", "Move to Trash", "Authorize evil-app", "Merge pull request", "Run"]) expect(click(name).verdict).toBe("confirm");
  });
  it("“OK” in a dialog about deleting is as risky as the deleting", () => {
    expect(click("OK", "Delete 500 files?").verdict).toBe("confirm");
    expect(click("OK", "About Firefox").verdict).toBe("allow");
  });
  it("Enter on a focused risky button is a click on it, and destructive shortcuts are asked about on the desk too", () => {
    const keys = (value: string, element?: { role: string; name: string }, onDesk = false) =>
      e.decide({ taskId: "k", kind: "keys", app: "Files", window: "Home", element, value, onDesk, goal: "tidy my downloads" });
    expect(keys("Return", { role: "push button", name: "Delete all" }).prompt).toMatch(/press Return on “Delete all” push button/);
    expect(keys("Return", { role: "push button", name: "Delete all" }).aligned).toBe(false);
    expect(keys("shift+Delete", undefined, true).verdict).toBe("confirm");
    expect(keys("ctrl+Return", { role: "text", name: "Message" }, true).verdict).toBe("confirm");
    expect(keys("ctrl+s", { role: "text", name: "Doc" }, true).verdict).toBe("allow");
  });
  it("desktop-level shortcuts are never pressed", () => {
    for (const k of ["ctrl+alt+F2", "alt+F2", "super", "ctrl+alt+t", "Ctrl + Alt + BackSpace"]) {
      expect(e.decide({ taskId: "k", kind: "keys", app: "gedit", window: "w", value: k }).verdict).toBe("deny");
    }
  });
  it("typed line breaks and replacing a whole document are confirmed", () => {
    expect(e.decide({ taskId: "x", kind: "text", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value: "hello\n", mode: "insert" }).verdict).toBe("confirm");
    const doc = "line\n".repeat(50);
    const d = e.decide({ taskId: "x", kind: "text", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value: "hi", mode: "replace", currentText: doc });
    expect(d.verdict).toBe("confirm");
    expect(d.prompt).toMatch(/^Replace the text in/);
    expect(e.decide({ taskId: "x", kind: "text", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value: "hi", mode: "append", currentText: doc }).verdict).toBe("allow");
  });
  it("a risky verb must be in the request: sharing a filler word isn't enough", () => {
    const d = e.decide({ taskId: "a", kind: "click", app: "Firefox", window: "Form", element: { role: "push button", name: "Delete all my form data" }, goal: "fill in my name in the form" });
    expect(d.aligned).toBe(false);
    expect(d.prompt).toMatch(/You didn't ask for this/);
    expect(e.decide({ taskId: "a", kind: "click", app: "Firefox", window: "Form", element: { role: "push button", name: "Send" }, goal: "send the report to Ana" }).aligned).toBeUndefined();
  });
  it("never offers “Always” on a risky question", () => {
    const fresh = new PolicyEngine({ neverLook: () => [], grants: () => ({}) });
    expect(fresh.decide({ taskId: "r", kind: "click", app: "Thunderbird", window: "w", element: { role: "push button", name: "Send" }, goal: "send it" }).remember).toBe(false);
    expect(fresh.decide({ taskId: "r", kind: "click", app: "Thunderbird", window: "w", element: { role: "push button", name: "Bold" }, goal: "x" }).remember).toBe(true);
  });
  it("choosing a risky option and filling secret fields by any route are covered", () => {
    expect(e.decide({ taskId: "s", kind: "select", app: "Firefox", window: "Account", element: { role: "combo box", name: "Action" }, value: "Delete account" }).verdict).toBe("confirm");
    expect(e.decide({ taskId: "s", kind: "value", app: "Firefox", window: "Pay", element: { role: "spin button", name: "PIN" }, value: "1234" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "s", kind: "text", app: "Firefox", window: "Login", element: { role: "text", name: "Pаssword" }, value: "x" }).verdict).toBe("deny");
  });
  it("launching an app on the never-look list or a terminal is refused", () => {
    expect(e.decide({ taskId: "o", kind: "open_app", app: "KeePassXC", window: "", value: "KeePassXC" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "o", kind: "open_app", app: "XTerm", window: "", value: "XTerm" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "o", kind: "open_app", app: "Text Editor", window: "", value: "Text Editor" }).verdict).toBe("allow");
  });
});
