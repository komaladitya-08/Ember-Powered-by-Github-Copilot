import { describe, expect, it } from "vitest";
import { costWords, failureView, homeConnectionView, modelRows, ownProviderOffer, providerCheckLine, taskModelChoices } from "../../app/renderer/home/first-run-copy";

describe("first run: own provider offer (FE #2)", () => {
  const base = { bridge: true, managedProvider: false, locked: false, userProviderOff: false };
  it("is offered to someone who may use their own provider", () => {
    expect(ownProviderOffer(base)).toEqual({ offered: true });
  });
  it("is never offered, and says why, when the organisation fixes or forbids it", () => {
    expect(ownProviderOffer({ ...base, managedProvider: true })).toMatchObject({ offered: false, why: expect.stringContaining("organisation decides") });
    expect(ownProviderOffer({ ...base, userProviderOff: true })).toMatchObject({ offered: false, why: expect.stringContaining("turned off") });
    expect(ownProviderOffer({ ...base, locked: true })).toMatchObject({ offered: false });
    expect(ownProviderOffer({ ...base, bridge: false })).toMatchObject({ offered: false });
  });
});

describe("first run: what a failed connection offers (FE #3)", () => {
  it("never makes signing in again the primary remedy for an entitlement failure", () => {
    for (const ownOffered of [true, false]) {
      for (const detail of ["No Copilot for this account.", "Disabled by your organisation's policy."]) {
        const v = failureView({ reason: "no-access", detail, ownOffered });
        expect(v.primary).not.toBe("sign-in");
        expect(v.others).not.toContain("sign-in");
      }
    }
  });
  it("leads with their own provider when offered, else with a different account", () => {
    expect(failureView({ reason: "no-access", ownOffered: true })).toMatchObject({ primary: "own-provider", others: ["switch-account", "retry"] });
    expect(failureView({ reason: "no-access", ownOffered: false })).toMatchObject({ primary: "switch-account", others: ["retry"] });
  });
  it("sends an organisation's refusal to its administrator and others to Copilot's page", () => {
    expect(failureView({ reason: "no-access", detail: "Disabled by your organisation's policy.", ownOffered: true }).help).toContain("administrator");
    expect(failureView({ reason: "no-access", detail: "No seat.", ownOffered: true }).help).toContain("github.com/features/copilot");
  });
  it("signs in again only for a refused sign-in, and retries a network failure", () => {
    expect(failureView({ reason: "sign-in", ownOffered: true }).primary).toBe("sign-in");
    expect(failureView({ reason: "network", ownOffered: true })).toMatchObject({ primary: "retry", others: ["own-provider"] });
    expect(failureView({ reason: "network", ownOffered: false }).others).toEqual([]);
    expect(failureView({ reason: "models", ownOffered: false }).primary).toBe("retry");
  });
});

describe("first run: the provider check says only what it found (FE #2)", () => {
  it("words a result", () => {
    expect(providerCheckLine({ ok: true, host: "api.example.com", models: 3 })).toBe("Connected to api.example.com. It lists 3 models.");
    expect(providerCheckLine({ ok: true, host: "a.b", models: 1 })).toBe("Connected to a.b. It lists 1 model.");
    expect(providerCheckLine({ ok: true, host: "a.b", models: null })).toBe("Connected to a.b.");
    expect(providerCheckLine({ ok: false, why: "The key was refused." })).toBe("The key was refused.");
  });
});

describe("first run: the models Ember chose (FE #4, #5)", () => {
  const text = { id: "t", name: "Text One", vision: false, cost: 0 };
  const seen = { id: "v", name: "Vision Two", vision: true, cost: 3 };
  it("words the premium multiplier only when Copilot gave one", () => {
    expect(costWords(undefined)).toBe("");
    expect(costWords(0)).toBe("no premium requests");
    expect(costWords(1)).toBe("1 premium request a message");
    expect(costWords(3)).toBe("3× premium requests a message");
    expect(costWords(0.33333)).toBe("0.33× premium requests a message");
  });
  it("rows name both models with their cost and a text-only limit", () => {
    expect(modelRows({ models: [text, seen], conductor: "t", worker: "v", own: false })).toEqual([
      { label: "Conversation", value: "Text One", note: "no premium requests" },
      { label: "Tasks", value: "Vision Two", note: "3× premium requests a message" },
    ]);
    expect(modelRows({ models: [text], conductor: "t", worker: "t", own: false })[1].note).toBe("no premium requests; text only, it can't read screenshots");
  });
  it("own provider shows its names with no Copilot costs", () => {
    expect(modelRows({ models: [], conductor: "gpt-4.1", worker: null, own: true })).toEqual([
      { label: "Conversation", value: "gpt-4.1", note: "" }, { label: "Tasks", value: "gpt-4.1", note: "" },
    ]);
  });
  it("the task selector is never empty or unexplained for a catalogue without vision models", () => {
    const c = taskModelChoices([text], "t");
    expect(c.options.map(m => m.id)).toEqual(["t"]);
    expect(c.textOnly).toBe(true);
    expect(c.label).not.toContain("must understand images");
    expect(c.note).toContain("Text One");
    expect(c.note).toContain("text");
  });
  it("keeps the vision-only list and label when a vision model exists, and shows nothing for an empty catalogue", () => {
    const c = taskModelChoices([text, seen], "v");
    expect(c.options.map(m => m.id)).toEqual(["v"]);
    expect(c).toMatchObject({ textOnly: false, note: "" });
    expect(taskModelChoices([], null).options).toEqual([]);
  });
});

describe("Home's connection buttons by why Copilot isn't connected (FE #3)", () => {
  const base = { phase: "error", ownOffered: true, signingIn: false, waiting: false };
  it("never leads an account without Copilot with signing in again", () => {
    const v = homeConnectionView({ ...base, reason: "no-access", detail: "Copilot isn't available to this account." });
    expect(v.primary).toBe("own-provider");
    expect(v.show).toEqual({ "own-provider": true, "switch-account": true, retry: true, "sign-in": false });
    expect(v.help).toContain("github.com/features/copilot");
  });
  it("names the administrator, and leads with another account when the provider is forbidden by policy", () => {
    const v = homeConnectionView({ ...base, reason: "no-access", detail: "Disabled by your organisation's policy.", ownOffered: false });
    expect(v.primary).toBe("switch-account");
    expect(v.show["own-provider"]).toBe(false);
    expect(v.show["sign-in"]).toBe(false);
    expect(v.help).toContain("administrator");
  });
  it("keeps signing in first for a signed-out Copilot, with the provider beside it and Check again as before", () => {
    const v = homeConnectionView({ ...base, phase: "signed-out" });
    expect(v.primary).toBe("sign-in");
    expect(v.show).toEqual({ "sign-in": true, "own-provider": true, "switch-account": false, retry: true });
  });
  it("shows nothing while signing in, and only Reconnect while waiting for tasks", () => {
    expect(homeConnectionView({ ...base, signingIn: true }).show).toEqual({ "sign-in": false, "own-provider": false, "switch-account": false, retry: false });
    expect(homeConnectionView({ ...base, waiting: true, reason: "network" }).show).toEqual({ "sign-in": false, "own-provider": false, "switch-account": false, retry: true });
    expect(homeConnectionView({ ...base, phase: "ready" }).show.retry).toBe(false);
  });
});
