/**
 * The coding window's request cards as data (app/renderer/code/requests.ts): what each kind shows from the SDK's
 * payload, and the exact answer shape the SDK takes for it, built only from what the person picked among the offered
 * choices.
 */
import { describe, expect, it } from "vitest";
import {
  ELICITATION_CANCEL, ELICITATION_DECLINE, FEEDBACK_MAX, autoModeCard, elicitationAccept, elicitationCard, grants, limitsAnswer, limitsCard, oauthCard,
  permissionAnswer, permissionCard, planExitAnswer, planExitCard, questionAnswer, questionCard,
} from "../../app/renderer/code/requests";

const shell = { requestId: "r", permissionRequest: { kind: "shell", fullCommandText: "rm -rf build && npm run build", intention: "Clean build", commands: [{ identifier: "rm", readOnly: false }, { identifier: "npm run", readOnly: false }], possiblePaths: ["build"], possibleUrls: [{ url: "https://registry.npmjs.org" }], hasWriteFileRedirection: true, warning: "Deletes files", canOfferSessionApproval: true, requestSandboxBypass: true, requestSandboxBypassReason: "needs network" }, promptRequest: { assistedApproval: { recommendation: "requireApproval", reason: "deletes" } }, riskAssessment: { level: "high" } };

describe("permission cards", () => {
  it("show what will run in full, the assisted check's recommendation and the SDK's risk assessment", () => {
    const c = permissionCard(shell);
    expect(c.view).toEqual({ kind: "shell", command: "rm -rf build && npm run build", intention: "Clean build", commands: [{ identifier: "rm", readOnly: false }, { identifier: "npm run", readOnly: false }], paths: ["build"], urls: ["https://registry.npmjs.org"], writesFiles: true, warning: "Deletes files", sandboxBypass: "needs network" });
    expect(c.assisted).toEqual({ recommendation: "requireApproval", reason: "deletes" });
    expect(c.risk).toContain("high");
    expect(permissionCard({ permissionRequest: { kind: "write", fileName: "/a.ts", diff: "@@ -1 +1 @@\n-a\n+b", managedApprovalRequired: true } })).toMatchObject({ view: { kind: "write", file: "/a.ts", diff: "@@ -1 +1 @@\n-a\n+b" }, managed: true });
    expect(permissionCard({ permissionRequest: { kind: "mcp", serverName: "gh", toolName: "merge", args: { pr: 1 }, readOnly: false } }).view).toEqual({ kind: "mcp", server: "gh", tool: "merge", args: "{\n  \"pr\": 1\n}", readOnly: false });
    // A kind the window doesn't know shows everything the SDK sent.
    expect(permissionCard({ permissionRequest: { kind: "workflow", name: "deploy", phases: 3 } }).view).toEqual({ kind: "other", sdkKind: "workflow", details: "{\n  \"name\": \"deploy\",\n  \"phases\": 3\n}" });
  });

  it("answer with the SDK's decision for exactly an offered choice, its scope built from the request", () => {
    const choices = ["approve-once", "approve-for-session", "reject"];
    expect(permissionAnswer(shell, choices, "approve-once")).toEqual({ kind: "approve-once" });
    expect(permissionAnswer(shell, choices, "approve-for-session")).toEqual({ kind: "approve-for-session", approval: { kind: "commands", commandIdentifiers: ["rm", "npm run"] } });
    expect(permissionAnswer(shell, choices, "reject", "  not the build folder  ")).toEqual({ kind: "reject", feedback: "not the build folder" });
    expect(permissionAnswer(shell, choices, "reject", "x".repeat(FEEDBACK_MAX + 5))).toEqual({ kind: "reject", feedback: "x".repeat(FEEDBACK_MAX) });
    expect(permissionAnswer(shell, choices, "reject", "   ")).toEqual({ kind: "reject" });
    // Never a choice main didn't offer, whatever the window is asked.
    expect(permissionAnswer(shell, ["approve-once", "reject"], "approve-for-session")).toBeNull();
    const url = { permissionRequest: { kind: "url", url: "https://docs.example.com/a" } };
    const all = ["approve-for-session", "approve-permanently", "approve-read-only-for-session"];
    expect(permissionAnswer(url, all, "approve-for-session")).toEqual({ kind: "approve-for-session", domain: "docs.example.com" });
    expect(permissionAnswer(url, all, "approve-permanently")).toEqual({ kind: "approve-permanently", domain: "docs.example.com" });
    expect(permissionAnswer({ permissionRequest: { kind: "url", url: "file:///etc/passwd" } }, all, "approve-permanently")).toBeNull();
    expect(permissionAnswer({ permissionRequest: { kind: "read", path: "/home/me/app/a.ts" } }, all, "approve-read-only-for-session")).toEqual({ kind: "approve-read-only-for-session", directories: ["/home/me/app"] });
    expect(permissionAnswer({ permissionRequest: { kind: "mcp", serverName: "gh", toolName: "merge" } }, all, "approve-for-session")).toEqual({ kind: "approve-for-session", approval: { kind: "mcp", serverName: "gh", toolName: "merge" } });
    expect(permissionAnswer({ permissionRequest: { kind: "shell", commands: [] } }, all, "approve-for-session")).toBeNull();
    expect([grants("approve-once"), grants("reject"), grants("user-not-available")]).toEqual([true, false, false]);
  });
});

describe("the model's question", () => {
  it("answers with one of its choices as offered, or the person's own words where it takes them", () => {
    const q = questionCard({ question: "Both?", choices: ["Yes", "No"], allowFreeform: false });
    expect(questionAnswer(q, "Yes", false)).toEqual({ answer: "Yes", wasFreeform: false });
    expect(questionAnswer(q, "Maybe", false)).toBeNull();
    expect(questionAnswer(q, "Maybe", true)).toBeNull();
    const open = questionCard({ question: "Which file?" });
    expect(open.freeform).toBe(true);
    expect(questionAnswer(open, "  src/a.ts ", true)).toEqual({ answer: "src/a.ts", wasFreeform: true });
    expect(questionAnswer(open, "   ", true)).toBeNull();
  });
});

describe("elicitation", () => {
  const data = {
    message: "Details for the deploy", elicitationSource: "deployer",
    requestedSchema: { type: "object", required: ["env", "replicas"], properties: {
      env: { type: "string", title: "Environment", enum: ["staging", "prod"], enumNames: ["Staging", "Production"] },
      replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 5 },
      notify: { type: "boolean", title: "Notify", default: true },
      tags: { type: "array", items: { anyOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] } },
      note: { type: "string", maxLength: 5 },
    } },
  };

  it("builds a field for each property of its schema", () => {
    const c = elicitationCard(data);
    expect(c.mode).toBe("form");
    expect(c.source).toBe("deployer");
    expect(c.fields.map(f => [f.name, f.kind, f.required])).toEqual([["env", "choice", true], ["replicas", "integer", true], ["notify", "boolean", false], ["tags", "choices", false], ["note", "text", false]]);
    expect(c.fields[0].options).toEqual([{ value: "staging", label: "Staging" }, { value: "prod", label: "Production" }]);
    expect(c.fields[3].options.map(o => o.value)).toEqual(["a", "b"]);
    expect(elicitationCard({ message: "Open it", mode: "url", url: "https://example.com/x" })).toMatchObject({ mode: "url", url: "https://example.com/x" });
  });

  it("accepts values typed as the schema says, or names the fields with a problem", () => {
    const c = elicitationCard(data);
    expect(elicitationAccept(c, { env: "prod", replicas: "3", notify: false, tags: ["b", "z"], note: "" })).toEqual({ ok: true, answer: { action: "accept", content: { env: "prod", replicas: 3, notify: false, tags: ["b"] } } });
    const bad = elicitationAccept(c, { env: "dev", replicas: "2.5", note: "too long" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems).toEqual([{ name: "env", problem: "option" }, { name: "replicas", problem: "integer" }, { name: "note", problem: "length" }]);
    const missing = elicitationAccept(c, { replicas: "9" });
    expect(!missing.ok && missing.problems).toEqual([{ name: "env", problem: "required" }, { name: "replicas", problem: "range" }]);
    expect([ELICITATION_DECLINE, ELICITATION_CANCEL]).toEqual([{ action: "decline" }, { action: "cancel" }]);
  });
});

describe("leaving plan mode, auto mode, limits and sign-in", () => {
  it("approves the plan with one of its offered actions, or keeps planning with feedback", () => {
    const p = planExitCard({ summary: "S", planContent: "1. a", actions: ["exit_only", "interactive", "autopilot"], recommendedAction: "interactive" });
    expect(p).toEqual({ summary: "S", plan: "1. a", actions: ["exit_only", "interactive", "autopilot"], recommended: "interactive" });
    expect(planExitAnswer(p, "autopilot")).toEqual({ approved: true, selectedAction: "autopilot" });
    expect(planExitAnswer(p, "autopilot_fleet")).toBeNull();
    expect(planExitAnswer(p, null, "add tests")).toEqual({ approved: false, feedback: "add tests" });
    expect(planExitAnswer(p, null)).toEqual({ approved: false });
  });

  it("reads the auto-mode switch, the limits and the MCP server, and builds a limits answer only with an amount where it needs one", () => {
    expect(autoModeCard({ errorCode: "rate_limited", retryAfterSeconds: 90 })).toEqual({ errorCode: "rate_limited", retryAfterSeconds: 90 });
    expect(limitsCard({ usedAiCredits: 50, maxAiCredits: 50 })).toEqual({ used: 50, max: 50 });
    expect(limitsAnswer("add", 25)).toEqual({ action: "add", additionalAiCredits: 25 });
    expect(limitsAnswer("set", 100)).toEqual({ action: "set", maxAiCredits: 100 });
    expect(limitsAnswer("add", Number.NaN)).toBeNull();
    expect(limitsAnswer("add", -1)).toBeNull();
    expect([limitsAnswer("unset"), limitsAnswer("cancel")]).toEqual([{ action: "unset" }, { action: "cancel" }]);
    expect(oauthCard({ serverName: "gh", serverUrl: "https://api.example.com/mcp", reason: "refresh" })).toEqual({ server: "gh", url: "https://api.example.com/mcp", reason: "refresh" });
  });
});
