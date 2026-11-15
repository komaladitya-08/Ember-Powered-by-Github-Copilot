import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { ALL_SCOPES } from "../../app/main/policy/autonomy";

const engine = (autonomy: boolean) => new PolicyEngine({
  neverLook: () => [], grants: () => ({ firefox: "act" }), autonomy: () => autonomy ? { ...ALL_SCOPES } : null,
});
const action = (window: string, name: string, overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  taskId: "page", kind: "click", app: "firefox", window, goal: "Inspect the page", inPage: true,
  element: { role: "push button", name }, ...overrides,
});

describe("generic progression controls on risky pages", () => {
  it.each([
    ["Delete account - Example", "Finish"], ["Delete account - Example", "Next"],
    ["Erase all data - Example", "Done"], ["Review your order - Example", "Finish"],
    ["Payment - Example", "Next"],
    ["Delete account - Example", "Next >"], ["Review your order - Example", "Finish →"],
  ])("asks for %s / %s with a normal grant and work without asking", (window, name) => {
    for (const autonomy of [false, true]) {
      for (const kind of ["click", "toggle", "cursor_click"] as const) {
        expect(engine(autonomy).decide(action(window, name, { kind }))).toMatchObject({ verdict: "confirm", risky: true });
        expect(engine(autonomy).decide(action(window, name, { kind, inPage: false, onPage: true, onDesk: true }))).toMatchObject({ verdict: "confirm", risky: true });
      }
      for (const value of ["Return", "space"]) {
        expect(engine(autonomy).decide(action(window, name, { kind: "keys", value }))).toMatchObject({ verdict: "confirm", risky: true });
      }
    }
  });

  it("does not classify safe exits or unrelated progression as a risky page action", () => {
    for (const name of ["Cancel", "Back", "Read-only"]) {
      for (const window of ["Delete account - Example", "Payment - Example"]) {
        for (const r of [{}, { kind: "keys" as const, value: "Return" }]) {
          expect(engine(true).decide(action(window, name, r)).verdict, `${window} / ${name} / ${r.kind ?? "click"}`).toBe("allow");
        }
      }
    }
    expect(engine(false).decide(action("Account settings", "Next")).verdict).toBe("allow");
  });

  it("still marks the step risky when explicitly configured Autopilot lets it go ahead", () => {
    const autopilot = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act" }), autopilot: () => true });
    expect(autopilot.decide(action("Delete account - Example", "Finish"))).toMatchObject({ verdict: "allow", risky: true, mode: "autopilot" });
  });

  it("lets Assisted's check approve a matching page action", async () => {
    const assisted = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act" }), assisted: () => true });
    const request = action("Delete account - Example", "Finish", { goal: "delete my account" });
    const decision = assisted.decide(request);
    expect(decision).toMatchObject({ verdict: "confirm", risky: true });
    expect(await assisted.assist(request, decision, {
      words: "delete my account", signal: new AbortController().signal, check: async () => "match",
    })).toMatchObject({ verdict: "allow", risky: true, review: "match", autonomy: true });
  });
});
