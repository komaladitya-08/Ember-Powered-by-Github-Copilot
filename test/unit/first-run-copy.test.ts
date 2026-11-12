import { describe, expect, it } from "vitest";
import { costWords, failureView, homeConnectionView, inMyVoice, keyPlaceholder, modelRows, ownProviderOffer, pressOnStep, PROVIDER_STEP, providerCheckLine, providerModelMissing, providerFailField, providerInUseLine, providerKeepLabel, providerKeptLine, signInWays, taskModelChoices } from "../../app/renderer/home/first-run-copy";
import { retryMessage, tagline } from "../../app/renderer/home/copy";
import { statusWord } from "../../app/renderer/home/status-copy";
import { KEY_NO_KEYRING, KEY_WRITE_FAILED, PROVIDER_MANAGED, PROVIDER_NO_CONSENT, providerDown, providerNotAgreed, testConnection } from "../../app/main/provider";
import { explainSignInError, explainStartError, runtimeWords, START_TIMEOUT_DETAIL, startErrorReason, USER_PROVIDER_NO_MODEL } from "../../app/main/agent/host";
import { PROVIDER_BAD_REQUEST } from "../../app/main/provider-ipc";
import { cliTimedOutMessage } from "../../app/main/agent/github-app";
import { DEFAULT_SETTINGS } from "../../app/main/settings";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";

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
  it("names on Models & connections the field below for a missing model, never the pane the person is on (integrations-r8-3)", () => {
    const base = { phase: "error", reason: "models", ownOffered: true, signingIn: false, waiting: false, service: "user" };
    const noModel = homeConnectionView({ ...base, detail: "Enter the model your provider should use in Ember's settings, under Models & connections." });
    expect(noModel.line).toBe("Enter the model your provider should use in “Conversation model”, below.");
    // Its button still leads, to that field (main.ts focuses byok-conductor for this reason).
    expect(noModel.primary).toBe("provider");
    // Main's other reasons are said in its own words.
    expect(homeConnectionView({ ...base, detail: "None of the models you entered for your provider are allowed by your administrator." }).line).toBeUndefined();
    expect(homeConnectionView({ ...base, service: "admin", detail: "Enter the model your provider should use in Ember's settings, under Models & connections." }).line).toBeUndefined();
  });
  it("names that field for main's own no-model sentence as main's start says it, so a change to main's words can't bring the pane's name back unseen (integrations-x8-3)", () => {
    // The status a start that names no model gives: its reason and detail, made by main from its own constant.
    const err = new Error(USER_PROVIDER_NO_MODEL);
    const v = homeConnectionView({ phase: "error", reason: startErrorReason(err), detail: explainStartError(err), ownOffered: true, signingIn: false, waiting: false, service: "user" });
    expect(v.line).toBe("Enter the model your provider should use in “Conversation model”, below.");
    expect(v.primary).toBe("provider");
  });
  it("says in Home's tagline and status that the provider can't connect, never to connect Copilot", () => {
    const t = { failing: 0, onboarded: true, hidden: false, overlay: true, service: "user" };
    expect(tagline({ ...t, phase: "error" })).toBe("Beside your cursor. Can't connect to your model provider yet: Models & connections says why.");
    expect(tagline({ ...t, phase: "starting" })).toBe("Beside your cursor. Connecting to your model provider…");
    expect(tagline({ ...t, phase: "error", waitingForTasks: true })).toMatch(/Your model provider isn't answering/);
    expect(tagline({ ...t, service: undefined, phase: "error" })).toBe("Beside your cursor. Connect Copilot to start asking.");
    expect(statusWord({ phase: "error", failing: 0, running: 0, asking: 0, waitingForTasks: true, service: "user" }).word).toBe("Waiting for the model service");
  });
  it("says in Home's tagline that Ember reconnects when its own model connection stopped, and once it gave up, never blames the provider or asks to connect Copilot (accessibility-visual-c1-2)", () => {
    const t = { failing: 0, onboarded: true, hidden: false, overlay: true, service: "user" };
    expect(tagline({ ...t, phase: "error", runtime: "reconnecting" })).toBe("Beside your cursor. Reconnecting to your model provider…");
    expect(tagline({ ...t, phase: "error", runtime: "stopped" })).toBe("Beside your cursor. Ember's model connection isn't running: Models & connections says why.");
    expect(tagline({ ...t, service: undefined, phase: "error", runtime: "reconnecting" })).toBe("Beside your cursor. Reconnecting to Copilot…");
    expect(tagline({ ...t, service: undefined, phase: "error", runtime: "stopped" })).toBe("Beside your cursor. Copilot isn't running: Models & connections says why.");
    expect(tagline({ ...t, phase: "error", runtime: "reconnecting", waitingForTasks: true })).toMatch(/Your model provider isn't answering/);
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
  it("names the models the service lists, as Home's Test connection does (first-run-c7-1)", () => {
    expect(providerCheckLine({ ok: true, host: "127.0.0.1:18392", models: 1, ids: ["llama3.2:3b"] })).toBe("Connected to 127.0.0.1:18392. It lists 1 model: llama3.2:3b.");
    expect(providerCheckLine({ ok: true, host: "a.b", models: 3, ids: ["m1", "m2", "m3"] })).toBe("Connected to a.b. It lists 3 models, such as m1 and m2.");
  });
  it("fails the check on the model field when the service doesn't list the name typed, naming what it lists (first-run-c7-1)", () => {
    // The step's own example, "gpt-4.1", typed for a server that lists only llama3.2:3b: the check said "Connected…
    // It lists 1 model." and offered Continue, and the first request failed with "That model isn't available."
    const one = { host: "127.0.0.1:18392", models: 1, ids: ["llama3.2:3b"] };
    expect(providerModelMissing(one, { type: "openai", conductor: "gpt-4.1", worker: "" })).toEqual({
      field: "conductor", line: "127.0.0.1:18392 answered, but it doesn't list gpt-4.1. It lists 1 model: llama3.2:3b. Enter that name.",
    });
    // The neighbouring shape (integrations-9): a tag left off a name that has no “latest”.
    expect(providerModelMissing(one, { type: "openai", conductor: "llama3.2", worker: "" })?.field).toBe("conductor");
    expect(providerModelMissing(one, { type: "openai", conductor: "llama3.2:3b", worker: "" })).toBeNull();
    // The model for tasks is checked too, after the conversation's.
    const three = { host: "a.b", models: 3, ids: ["m1", "m2", "m3"] };
    expect(providerModelMissing(three, { type: "openai", conductor: "m2", worker: "m9" })).toEqual({
      field: "worker", line: "a.b answered, but it doesn't list m9. It lists 3 models: m1, m2 and m3. Enter one of those names.",
    });
    expect(providerModelMissing(three, { type: "openai", conductor: "m0", worker: "m9" })?.field).toBe("conductor");
    expect(providerModelMissing(three, { type: "openai", conductor: "m1", worker: "m3" })).toBeNull();
    const many = { host: "a.b", models: 7, ids: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"] };
    expect(providerModelMissing(many, { type: "anthropic", conductor: "x", worker: "" })?.line).toBe("a.b answered, but it doesn't list x. It lists 7 models, such as m1, m2, m3 and m4. Enter a name it lists.");
    // Said as the step's own line, in the first person and without Ember's name.
    expect(providerModelMissing(one, { type: "openai", conductor: "gpt-4.1", worker: "" })?.line).not.toMatch(/Ember/);
  });
  it("never fails a name the service may still take: a list it can't read whole, a deployment, a short name for a listed model (first-run-c7-1)", () => {
    const typed = { type: "openai" as const, conductor: "gpt-4.1", worker: "" };
    // No list, no readable ids, or more models than the ids read (the list is cut at 50, and odd ids are left out).
    expect(providerModelMissing({ host: "a.b", models: null }, typed)).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 2 }, typed)).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 0, ids: [] }, typed)).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 60, ids: ["m1", "m2"] }, typed)).toBeNull();
    // Azure asks for a deployment's name, which its model list doesn't hold.
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["gpt-4o"] }, { ...typed, type: "azure" })).toBeNull();
    // Ollama takes "llama3.2" for "llama3.2:latest"; services take a model's name for its dated snapshot, and "-latest".
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["llama3.2:latest"] }, { ...typed, conductor: "llama3.2" })).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["claude-sonnet-4-5-20250929"] }, { ...typed, conductor: "claude-sonnet-4-5" })).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["claude-3-5-haiku-20241022"] }, { ...typed, conductor: "claude-3-5-haiku-latest" })).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["gpt-4.1-2025-04-14"] }, typed)).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["GPT-4.1"] }, typed)).toBeNull();
    // A model path's last part ("models/gemini-2.0-flash", "org/model").
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["models/gemini-2.0-flash"] }, { ...typed, conductor: "gemini-2.0-flash" })).toBeNull();
    // Still a different model: a longer name that only starts the same.
    expect(providerModelMissing({ host: "a.b", models: 1, ids: ["gpt-4.1-mini"] }, typed)?.field).toBe("conductor");
  });
  it("never fails a name on one page of a list that says more follows (first-run-x7-1)", async () => {
    // Anthropic's GET /v1/models: 20 models a page, with has_more and last_id; the name typed is on the next page.
    const page = Array.from({ length: 20 }, (_, i) => ({ type: "model", id: `claude-model-${i}-20250101` }));
    const agreedFor = (host: string) => ({ ...DEFAULT_SETTINGS.provider, on: true, type: "anthropic" as const, baseUrl: `https://${host}`, consent: { version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-08T12:00:00Z", host } });
    const typed = { type: "anthropic" as const, conductor: "claude-haiku-4-5", worker: "" };
    const answers = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as Parameters<typeof testConnection>[2];
    for (const rest of [{ has_more: true, last_id: "claude-model-19-20250101" }, { next_page_token: "abc" }, { nextPageToken: "abc" }, { next: "https://a.example/v1/models?page=2" }, { next_cursor: "abc" }]) {
      const r = await testConnection(agreedFor("a.example"), null, answers({ data: page, ...rest }));
      expect(r).toMatchObject({ ok: true, models: 20, more: true });
      if (r.ok) expect(providerModelMissing(r, typed)).toBeNull();
    }
    // A list that says it ends there is read whole, and still fails a name it doesn't hold.
    for (const rest of [{}, { has_more: false, last_id: "x" }, { next_page_token: "" }, { next: null }]) {
      const r = await testConnection(agreedFor("a.example"), null, answers({ data: page, ...rest }));
      expect(r).not.toHaveProperty("more");
      if (r.ok) expect(providerModelMissing(r, typed)?.field).toBe("conductor");
    }
  });
  it("never fails a name the service takes but lists differently (first-run-x7-2)", () => {
    const typed = (conductor: string) => ({ type: "openai" as const, conductor, worker: "" });
    const one = (id: string) => ({ host: "a.b", models: 1, ids: [id] });
    // "-latest" for an id with no date, and Anthropic's "-0" for a model's first snapshot.
    expect(providerModelMissing(one("grok-3"), typed("grok-3-latest"))).toBeNull();
    expect(providerModelMissing(one("claude-opus-4-20250514"), typed("claude-opus-4-0"))).toBeNull();
    // A ":latest" or a path typed that the list leaves off.
    expect(providerModelMissing(one("llama3.2"), typed("llama3.2:latest"))).toBeNull();
    expect(providerModelMissing(one("models/gemini-2.0-flash"), typed("models/gemini-2.0-flash"))).toBeNull();
    expect(providerModelMissing(one("gemini-2.0-flash"), typed("models/gemini-2.0-flash"))).toBeNull();
    // A dated preview of the model named.
    expect(providerModelMissing(one("gpt-4-1106-preview"), typed("gpt-4"))).toBeNull();
    // A server that lists its model's file (llama.cpp's) answers whatever name is sent: its list holds no names.
    expect(providerModelMissing(one("/models/x.gguf"), typed("gpt-4.1"))).toBeNull();
    expect(providerModelMissing(one("mistral-7b-instruct.Q4_K_M.gguf"), typed("gpt-4.1"))).toBeNull();
    expect(providerModelMissing({ host: "a.b", models: 2, ids: ["llama3.2:3b", "C:/models/x.gguf"] }, typed("gpt-4.1"))).toBeNull();
    // Still different models: another tag, another size, another model under the same path.
    expect(providerModelMissing(one("llama3.2:3b"), typed("llama3.2:latest"))?.field).toBe("conductor");
    expect(providerModelMissing(one("gpt-4o-mini-2024-07-18"), typed("gpt-4o"))?.field).toBe("conductor");
    expect(providerModelMissing(one("gpt-4.1-mini"), typed("gpt-4.1-latest"))?.field).toBe("conductor");
    expect(providerModelMissing(one("models/gemini-2.0-flash"), typed("models/gemini-2.5-pro"))?.field).toBe("conductor");
    expect(providerModelMissing(one("-20250101"), typed("-latest"))?.field).toBe("conductor");
    expect(providerModelMissing(one("meta/llama-3.3-70b"), typed("other/llama-3.3-70b"))?.field).toBe("conductor");
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
    expect(providerKeptLine("Ember can't reach 127.0.0.1:18397. Check the address and the network.", "127.0.0.1:18300")).toBe("I can't reach 127.0.0.1:18397. Check the address and the network. Nothing has changed: I'm still using 127.0.0.1:18300.");
  });
  it("says it in one voice, mine, and offers to keep the details in use (first-run-c3-1)", () => {
    expect(providerKeptLine("b.example sent Ember to another address. Enter the address it moved to.", "a.example")).toBe("b.example sent me to another address. Enter the address it moved to. Nothing has changed: I'm still using a.example.");
    expect(providerKeptLine("Ember can't verify b.example's certificate.", "a.example")).toBe("I can't verify b.example's certificate. Nothing has changed: I'm still using a.example.");
    expect(providerKeptLine("b.example didn't accept the API key. Check it, or replace it.", "a.example")).toBe("b.example didn't accept the API key. Check it, or replace it. Nothing has changed: I'm still using a.example.");
    expect(providerKeepLabel("a.example")).toBe("Keep using a.example");
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

describe("first run says main's connection words as mine, on every visit (first-run-r4-2)", () => {
  // main's own sentences (shared with Models & connections, which speaks of Ember), as the steps receive them.
  const agreed = (baseUrl: string, host: string) => ({ ...DEFAULT_SETTINGS.provider, on: true, baseUrl, consent: { version: FEATURE_CONSENT_VERSION.provider, at: "2026-11-08T12:00:00Z", host } });
  const failing = (err: Error) => async () => { throw err; };
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  it("says a failed check of the provider's details as mine, on a first visit as after a failed edit of the one in use", async () => {
    const down = await testConnection(agreed("http://127.0.0.1:18397/v1", "127.0.0.1:18397"), null, failing(refused));
    expect(providerCheckLine(down)).toBe("I can't reach 127.0.0.1:18397. Check the address and the network.");
    expect(providerKeptLine(providerCheckLine(down), "127.0.0.1:18300")).toBe("I can't reach 127.0.0.1:18397. Check the address and the network. Nothing has changed: I'm still using 127.0.0.1:18300.");
    const moved = await testConnection(agreed("https://b.example/v1", "b.example"), null, failing(new TypeError("fetch failed: redirect mode is set to error")));
    expect(providerCheckLine(moved)).toBe("b.example sent me to another address. Enter the address it moved to.");
    const cert = await testConnection(agreed("https://b.example/v1", "b.example"), null, failing(new Error("self signed certificate in certificate chain")));
    expect(providerCheckLine(cert)).toBe("I can't verify b.example's certificate.");
    expect(providerCheckLine({ ok: false, why: KEY_NO_KEYRING })).toBe("I can't keep the key safely here: this computer has no keyring for passwords, so the key would be saved as plain text. Set up a keyring (GNOME Keyring or KWallet), then try again.");
    expect(providerCheckLine({ ok: false, why: KEY_WRITE_FAILED })).toBe("I couldn't save the key: my data folder can't be written. Try again.");
    expect(providerCheckLine({ ok: false, why: PROVIDER_MANAGED })).toBe("Your organisation decides which model service I use.");
    expect(providerCheckLine({ ok: false, why: PROVIDER_NO_CONSENT })).toBe("Finish setting me up first.");
    expect(providerCheckLine({ ok: false, why: providerNotAgreed("b.example") })).toBe("Agree to the note above first: I send nothing to b.example until you do.");
  });
  it("says why the provider in use can't connect as mine, under “I'm using the model provider you set up”", () => {
    const down = { ok: false as const, why: "Ember can't reach 127.0.0.1:18397. Check the address and the network.", cause: "refused" as const };
    expect(providerInUseLine({ host: "127.0.0.1:18397", phase: "error", detail: providerDown(down, "127.0.0.1:18397", true)! })).toEqual({ line: "I can't reach the model server on this computer (127.0.0.1:18397). Start it, and I'll connect in a moment.", tone: "error" });
    expect(providerInUseLine({ host: "api.example.com", phase: "error", detail: providerDown({ ...down, cause: "unreachable" }, "api.example.com", false)! }).line).toBe("I can't reach api.example.com. Check the address and the network: I'll try again in a moment.");
    expect(providerInUseLine({ host: "api.example.com", phase: "error", detail: providerDown({ ok: false, why: "api.example.com didn't answer within 10 seconds.", cause: "timeout" }, "api.example.com", false)! }).line).toBe("api.example.com didn't answer within 10 seconds. I'll try again in a moment.");
  });
  it("says the sign-in step's connection words as mine too, leaving Ember's name where it names the app", () => {
    expect(inMyVoice(START_TIMEOUT_DETAIL)).toBe("Copilot isn't answering. I'll try again in a moment.");
    expect(inMyVoice(explainStartError(new Error("net::ERR_INTERNET_DISCONNECTED")))).toBe("I can't reach GitHub right now. I'll try again when the network is back.");
    expect(inMyVoice(explainStartError(new Error("503 Service Unavailable")))).toBe("Copilot had a problem on its side while I connected. I'll try again in a moment.");
    expect(inMyVoice(explainStartError(new Error("client not connected")))).toBe("My Copilot runtime stopped while connecting. Press Check again.");
    expect(inMyVoice(explainStartError(new Error("401 Unauthorized"), { proxy: { url: "http://proxy.corp:3128" } }))).toBe("Copilot didn't accept the GitHub sign-in I found. It may have expired, or this account may not have Copilot. Sign in again. I sent Copilot through your system proxy (http://proxy.corp:3128); if that proxy needs its own sign-in, set HTTPS_PROXY for Ember with it.");
    expect(inMyVoice(explainSignInError(new Error("getaddrinfo ENOTFOUND github.com")))).toBe("I can't reach GitHub right now. Check the network, then sign in again.");
    expect(inMyVoice(explainStartError(new Error("unable to verify the first certificate")))).toBe("I can't verify GitHub's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate for Ember.");
    expect(inMyVoice(cliTimedOutMessage("linux", true))).toMatch(/^I didn't see a new GitHub sign-in\. /);
    expect(inMyVoice("Your model service refused the request. Check its API key in Ember's settings (Ctrl+Alt+E).")).toBe("Your model service refused the request. Check its API key in Ember's settings (Ctrl+Alt+E).");
    expect(inMyVoice("GitHub didn't accept Ember's sign-in request. Make sure Ember is up to date.")).toBe("GitHub didn't accept Ember's sign-in request. Make sure Ember is up to date.");
    expect(inMyVoice("Your organisation doesn't allow Ember to connect to build-01.")).toBe("Your organisation doesn't allow Ember to connect to build-01.");
    // Said once: a line already in my voice stays as it is.
    for (const s of ["I can't reach GitHub right now. I'll try again when the network is back.", "Connected to your own provider (127.0.0.1:11434)."]) expect(inMyVoice(s)).toBe(s);
  });
  it("says what main's sentence calls Ember's as mine once it says Ember as I: my saved sign-in, my files, what I know (first-run-v5-1)", () => {
    // main's own calls: the sign-in it used (host.ts passes its source, and the variable's name, every time).
    const refused = (source: string, sourceName?: string) => inMyVoice(explainStartError(new Error("not authenticated"), { source, sourceName }));
    expect(refused("stored")).toBe("Copilot didn't accept the GitHub sign-in I found (my saved sign-in). It may have expired, or this account may not have Copilot. Sign in again.");
    expect(refused("environment")).toBe("Copilot didn't accept the GitHub sign-in I found (a token from the environment). It may have expired, or this account may not have Copilot. Sign in again.");
    // The environment Ember runs in is named as the app's, as "set HTTPS_PROXY for Ember" is.
    expect(refused("environment", "COPILOT_GITHUB_TOKEN")).toBe("Copilot didn't accept the GitHub token in COPILOT_GITHUB_TOKEN (set in Ember's environment). It may have expired, lack the Copilot permission, or belong to an account without Copilot. Replace it or remove COPILOT_GITHUB_TOKEN, then restart me; or run “gh auth login” in a terminal and press Check again.");
    expect(inMyVoice(retryMessage({ found: true, source: "stored" }))).toBe("Found my saved sign-in; connecting…");
    // A file error that names no file.
    expect(inMyVoice(explainStartError(new Error("EACCES: permission denied, mkdir")))).toBe("I'm not allowed to use one of my files. Check that its folder belongs to you, then press Check again.");
    expect(inMyVoice(explainStartError(new Error("ENOENT: no such file or directory")))).toBe("I couldn't find one of my files. Press Check again; if it keeps happening, restart me.");
    expect(inMyVoice(explainStartError(new Error("ENOSPC: no space left on device, write")))).toBe("I couldn't save one of my files: the disk (or your storage quota) is full. Free some space, then press Check again.");
    expect(inMyVoice(explainStartError(new Error("EBUSY: resource busy or locked")))).toBe("One of my files is in use by another program. Close it, then press Check again.");
    expect(inMyVoice(explainStartError(new Error("EACCES: permission denied, open '/home/u/.config/ember/a.json'")))).toBe("I'm not allowed to use /home/u/.config/ember/a.json. Check that its folder belongs to you, then press Check again.");
    expect(providerCheckLine({ ok: false, why: PROVIDER_BAD_REQUEST })).toBe("I couldn't do that: the request wasn't one I know.");
  });
  it("says my model connection for the own provider's and the organisation's runtime words, under the first-person lead (first-run-v5-2)", () => {
    const own = runtimeWords("user");
    const line = (detail: string) => providerInUseLine({ host: "localhost:11434", phase: "error", detail }).line;
    expect(line(own.stopped)).toBe("My model connection stopped unexpectedly. Reconnecting…");
    // The provider step has no Check again: it says the way to the sign-in step's Try again (first-run-w5-2).
    expect(line(own.keepsStopping)).toBe("My model connection keeps stopping. Go back and press Try again, or restart me.");
    expect(line(own.noWatchersWhy)).toBe("My model connection isn't answering: the system's limit on file watchers (fs.inotify.max_user_instances) is used up. Close some apps, or ask IT to raise the limit.");
    expect(inMyVoice(runtimeWords(true).keepsStopping)).toBe("My model connection keeps stopping. Press Check again to retry, or restart me.");
    // A cut-off task's words are main's own, in my voice already: only ever a task's outcome (first-run-w5-1).
    expect(own.cutOff).toBe("My model connection stopped unexpectedly; the task didn't finish.");
    expect(inMyVoice(own.cutOff)).toBe(own.cutOff);
    // Said once: welcome.ts says the status' detail as mine, and the line says it again.
    expect(line(inMyVoice(own.keepsStopping))).toBe(line(own.keepsStopping));
  });
});

describe("first run's lines name only a button the step shows (first-run-w5-2)", () => {
  const files = ["EACCES: permission denied, mkdir", "ENOENT: no such file or directory", "ENOSPC: no space left on device, write", "EBUSY: resource busy or locked", "EROFS: read-only file system, open '/home/u/.config/ember/a.json'"].map(m => inMyVoice(explainStartError(new Error(m))));
  it("says the sign-in step's Try again for main's Check again, which the step shows only for the GitHub CLI", () => {
    const tried = (line: string) => signInWays({ line, checkAgain: false, primary: "retry", others: ["own-provider"] });
    expect(files.map(l => tried(l).line)).toEqual([
      "I'm not allowed to use one of my files. Check that its folder belongs to you, then press Try again.",
      "I couldn't find one of my files. Press Try again; if it keeps happening, restart me.",
      "I couldn't save one of my files: the disk (or your storage quota) is full. Free some space, then press Try again.",
      "One of my files is in use by another program. Close it, then press Try again.",
      "I couldn't save /home/u/.config/ember/a.json: the disk is read-only. Ask IT to check Ember's data folder, then press Try again.",
    ]);
    // Try again leads already: nothing is added beside it.
    expect(tried(files[1]).others).toEqual(["own-provider"]);
    for (const service of ["user", true, false] as const) expect(tried(inMyVoice(runtimeWords(service).keepsStopping)).line).toMatch(/^(My model connection|Copilot) keeps stopping\. Press Try again, or restart me\.$/);
    expect(tried(inMyVoice("Ember's Copilot runtime stopped while connecting. Press Check again.")).line).toBe("My Copilot runtime stopped while connecting. Press Try again.");
    // The GitHub CLI's Check again is shown: the line says it as main does.
    for (const l of files) expect(signInWays({ line: l, checkAgain: true, primary: "retry", others: [] })).toEqual({ line: l, others: [] });
  });
  it("shows Try again when the line asks to check again and nothing on the step does it: a refused token, my organisation's service", () => {
    const token = inMyVoice(explainStartError(new Error("not authenticated"), { source: "environment", sourceName: "COPILOT_GITHUB_TOKEN" }));
    expect(signInWays({ line: token, checkAgain: false, primary: "sign-in", others: ["own-provider"] })).toEqual({
      line: "Copilot didn't accept the GitHub token in COPILOT_GITHUB_TOKEN (set in Ember's environment). It may have expired, lack the Copilot permission, or belong to an account without Copilot. Replace it or remove COPILOT_GITHUB_TOKEN, then restart me; or run “gh auth login” in a terminal and press Try again.",
      others: ["own-provider", "retry"],
    });
    expect(signInWays({ line: inMyVoice(runtimeWords(true).keepsStopping), checkAgain: false, primary: "continue", others: [] }).others).toEqual(["retry"]);
    // A line that asks for no check adds nothing; Try again already among the others isn't added twice.
    expect(signInWays({ line: "Signed in as octo.", checkAgain: false, primary: "sign-in", others: ["own-provider"] })).toEqual({ line: "Signed in as octo.", others: ["own-provider"] });
    expect(signInWays({ line: files[0], checkAgain: false, primary: "provider", others: ["retry"] }).others).toEqual(["retry"]);
  });
  it("leaves Models & connections' own Check again as it is, and says the way back on the provider step", () => {
    const gaveUp = "My model connection stopped unexpectedly and keeps stopping, so I've stopped reconnecting. Press Check again in Models & connections to try once more, or restart me.";
    expect(pressOnStep(gaveUp, "try-again")).toBe(gaveUp);
    expect(pressOnStep(files[0], "go-back")).toBe("I'm not allowed to use one of my files. Check that its folder belongs to you, then go back and press Try again.");
    expect(pressOnStep(files[1], "go-back")).toBe("I couldn't find one of my files. Go back and press Try again; if it keeps happening, restart me.");
    expect(pressOnStep(files[1], "check-again")).toBe(files[1]);
  });
});

describe("first run: the provider step's key field and its waiting reason", () => {
  it("says a key is saved only for the address it was saved for, as main's state says it now (first-run follow-up: key placeholder)", () => {
    expect(keyPlaceholder({ keySaved: true, keyHost: "api.example.com", host: "api.example.com" })).toBe("A key is saved. Paste a new one to replace it");
    // Another address typed: the saved key never goes there, so it asks for that address's own.
    expect(keyPlaceholder({ keySaved: true, keyHost: "api.example.com", host: "api2.example.com" })).toBe("Paste your key");
    expect(keyPlaceholder({ keySaved: true, keyHost: "api.example.com", host: null })).toBe("Paste your key");
    expect(keyPlaceholder({ keySaved: false, keyHost: "api.example.com", host: "api.example.com" })).toBe("Paste your key");
  });
  it("gives the waiting button a short reason of its own beside the no-keyring line, not that line again (first-run follow-up: w-why)", () => {
    expect(PROVIDER_STEP.noKeyringWhy).toBe("I can't keep a key safely on this computer.");
    expect(PROVIDER_STEP.noKeyring).not.toBe(PROVIDER_STEP.noKeyringWhy);
    expect(PROVIDER_STEP.noKeyring.length).toBeGreaterThan(2 * PROVIDER_STEP.noKeyringWhy.length);
  });
});
