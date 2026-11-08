import { describe, expect, it } from "vitest";
import { costWords, failureView, homeConnectionView, modelRows, ownProviderOffer, providerCheckLine, providerFailField, providerInUseLine, providerKeptLine, taskModelChoices } from "../../app/renderer/home/first-run-copy";
import { tagline } from "../../app/renderer/home/copy";
import { statusWord } from "../../app/renderer/home/status-copy";

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

describe("a failing own provider is explained as the provider's, never Copilot's (integrations-3)", () => {
  it("leads with the provider's details, and offers no GitHub account, sign-in or provider switch", () => {
    for (const reason of ["models", "sign-in", "no-access"]) {
      const v = failureView({ reason, detail: "Enter the model your provider should use in Ember's settings, under Models & connections.", ownOffered: true, service: "user" });
      expect(v, reason).toEqual({ help: "", primary: "provider", others: ["retry"] });
    }
    for (const reason of ["network", "not-answering", "other"]) expect(failureView({ reason, ownOffered: true, service: "user" }), reason).toEqual({ help: "", primary: "retry", others: ["provider"] });
    const home = homeConnectionView({ phase: "error", reason: "models", detail: "Enter the model…", ownOffered: true, signingIn: false, waiting: false, service: "user" });
    expect(home).toEqual({ help: "", primary: "provider", show: { provider: true, retry: true, "sign-in": false, "switch-account": false, "own-provider": false } });
    // The organisation's service: only trying again.
    expect(failureView({ reason: "models", ownOffered: false, service: "admin" })).toEqual({ help: "", primary: "retry", others: [] });
  });
  it("says in Home's tagline and status that the provider can't connect, never to connect Copilot", () => {
    const t = { failing: 0, onboarded: true, hidden: false, overlay: true, service: "user" };
    expect(tagline({ ...t, phase: "error" })).toBe("Ember is beside your cursor. Ember can't connect to your model provider yet: Models & connections says why.");
    expect(tagline({ ...t, phase: "starting" })).toBe("Ember is beside your cursor. Connecting to your model provider…");
    expect(tagline({ ...t, phase: "error", waitingForTasks: true })).toMatch(/Your model provider isn't answering/);
    expect(tagline({ ...t, service: undefined, phase: "error" })).toBe("Ember is beside your cursor. Connect Copilot to start asking.");
    expect(statusWord({ phase: "error", failing: 0, running: 0, asking: 0, waitingForTasks: true, service: "user" }).word).toBe("Waiting for the model service");
  });

  it("words Copilot's own model failure by its cause: the account's settings, or the administrator's list", () => {
    const personal = failureView({ reason: "models", detail: "None of the models Copilot lists are enabled for this account. Turn one on in your Copilot settings on GitHub.", ownOffered: true });
    expect(personal.help).toBe("Copilot lists no model this account may use. Turn one on in your Copilot settings on GitHub, or use your own model provider.");
    expect(personal.help).not.toContain("administrator");
    const admin = failureView({ reason: "models", detail: "None of the models your administrator allows are available to this account.", ownOffered: false });
    expect(admin.help).toBe("None of the models your administrator allows is one I can use. Ask them to allow one.");
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
    expect(v.show).toEqual({ "own-provider": true, "switch-account": true, retry: true, "sign-in": false, provider: false });
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
    expect(v.show).toEqual({ "sign-in": true, "own-provider": true, "switch-account": false, retry: true, provider: false });
  });
  it("says my own provider waits for its note instead of leading with a GitHub sign-in, and never offers the provider that is already on (integrations-c2-3)", () => {
    const none = { "sign-in": false, "own-provider": false, "switch-account": false, retry: false, provider: false };
    const v = homeConnectionView({ ...base, phase: "signed-out", detail: "Not connected to Copilot: sign in with GitHub below.", own: { on: true, card: "127.0.0.1:18409" } });
    expect(v).toEqual({
      line: "Not connected: Ember is waiting for you to agree to use 127.0.0.1:18409.",
      help: "Agree in the note under Model provider below, or turn off “Use my own model provider” to use GitHub Copilot instead.",
      show: none, primary: null,
    });
    // The note put away with Not now: signing in leads again, but the switch that is on isn't offered as a way on.
    const declined = homeConnectionView({ ...base, phase: "signed-out", own: { on: true, card: null } });
    expect(declined.primary).toBe("sign-in");
    expect(declined.show).toEqual({ ...none, "sign-in": true, retry: true });
    expect(declined.line).toBeUndefined();
    // A failed Copilot sign-in while the switch is on and its note waits: the failure still leads.
    expect(homeConnectionView({ ...base, reason: "sign-in", own: { on: true, card: "127.0.0.1:18409" } }).show).toEqual({ ...none, "sign-in": true, retry: true });
    expect(homeConnectionView({ ...base, phase: "signed-out", own: { on: false, card: null } }).show["own-provider"]).toBe(true);
  });
  it("shows nothing while signing in, and only Reconnect while waiting for tasks", () => {
    expect(homeConnectionView({ ...base, signingIn: true }).show).toEqual({ "sign-in": false, "own-provider": false, "switch-account": false, retry: false, provider: false });
    expect(homeConnectionView({ ...base, waiting: true, reason: "network" }).show).toEqual({ "sign-in": false, "own-provider": false, "switch-account": false, retry: true, provider: false });
    expect(homeConnectionView({ ...base, phase: "ready" }).show.retry).toBe(false);
  });
});

describe("first run: the provider in use, as Home says it", () => {
  it("says a server on this computer is connected, but a host elsewhere only in use, since nothing contacted it at the start (integrations-r2-6)", () => {
    expect(providerInUseLine({ host: "127.0.0.1:11434", phase: "ready" })).toEqual({ line: "Connected to your own provider (127.0.0.1:11434).", tone: "ok" });
    expect(providerInUseLine({ host: "localhost:1234", phase: "ready" })).toEqual({ line: "Connected to your own provider (localhost:1234).", tone: "ok" });
    expect(providerInUseLine({ host: "api.example.com", phase: "ready" })).toEqual({ line: "Using your own provider (api.example.com).", tone: "ok" });
    expect(providerInUseLine({ host: "api.example.com", phase: "starting" })).toEqual({ line: "Connecting to your own provider (api.example.com)…", tone: "" });
  });
});

describe("first run: a failed check of new details for a provider in use (first-run-r2-1)", () => {
  it("says the details in use are still the ones used, after what failed", () => {
    expect(providerKeptLine("Ember can't reach 127.0.0.1:18397. Check the address and the network.", "127.0.0.1:18300")).toBe("Ember can't reach 127.0.0.1:18397. Check the address and the network. Nothing has changed: I'm still using 127.0.0.1:18300.");
  });
  it("hands the focus to the field the failure names: the address when nothing answered, the key when the key failed", () => {
    expect(providerFailField({ why: "Ember can't reach b.example. Check the address and the network.", cause: "unreachable" })).toBe("address");
    expect(providerFailField({ why: "b.example didn't answer within 10 seconds.", cause: "timeout" })).toBe("address");
    expect(providerFailField({ why: "b.example answered, but has no model list at that address. Check the endpoint and the provider." })).toBe("address");
    expect(providerFailField({ why: "b.example didn't accept the API key. Check it, or replace it." })).toBe("key");
    expect(providerFailField({ why: "b.example needs an API key." })).toBe("key");
    expect(providerFailField({ why: "Ember can't keep the key safely here: this computer has no keyring for passwords." })).toBe("key");
  });
});
