/**
 * The settings window's Model provider group (Copilot section): the user's own model provider, over
 * `window.emberProvider` (app/main/provider-ipc.ts) and the settings. The switch shows the card (copy.ts
 * providerConsentText, FEATURE_CONSENT_VERSION.provider) for the endpoint's host before anything goes there, and again
 * for another host. The API key is typed into a password field and sent to main once; the page only ever hears whether
 * one is saved ("Key saved", with Replace and Remove). An edit of the provider in force to another host is held here,
 * unsaved, until that host's card is agreed and its details answer as a model service does, or the person says to use
 * them as typed (integrations-c3-1, -c5-1): the details in force stay in force meanwhile, as first run's step for a provider in use keeps them (first-run-r2-1). Words come from copy.ts.
 */

import type { EmberProviderApi, ProviderMove, ProviderState } from "../../shared/ipc";
import type { Settings, SettingsPatch } from "../../main/settings";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { AZURE_API_VERSION, AgreeGuard, agreeAction, endpointHost, endpointProblem, heldAnswer, latestOnly, MODEL_ID, type ProviderType } from "../../shared/provider";
import { noteProviderChoice } from "./provider-choice";
import { type OwnProvider, PROVIDER_NO_KEYRING, PROVIDER_WORDS, providerAgreedText, providerAgreedUnlisted, providerCardShown, providerConsentText, providerHeldChecking, providerHeldHint, providerHeldKept, providerHeldKey, providerHeldUnlisted, providerHint, providerTestText, providerTestWaits } from "./copy";
import { providerFailField, providerKeepLabel } from "./first-run-copy";

declare global { interface Window { emberProvider?: EmberProviderApi } }

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const select = (id: string) => $(id) as HTMLSelectElement;
const api = () => window.emberProvider;

type Own = Settings["provider"];
let save: (patch: SettingsPatch) => Promise<boolean> = async () => false;
let own: Own | null = null;
let state: ProviderState | null = null;
/** `state` is the answer to the newest read (none pending, none failed): only then does it name where requests go. */
let stateFresh = false;
/** Replace was pressed: the key field shows although a key is saved. */
let replacing = false;
/** The card was put away with Not now (for this host): it doesn't come back until the switch is turned on again. */
let declinedFor: string | null = null;
/** The host the card was last drawn for (null: no card up). */
let cardHost: string | null = null;
/** The host of an address just entered: if the card comes up for it, that is said (focus has moved on by then). */
let announceFor: string | null = null;
/** "I agree" is armed as Ember's questions are: not for 500 ms after a redraw for another host, and only for the host pressed. */
const agreeGuard = new AgreeGuard();
/** The details a change writes (never the switch or the card's record). */
type Details = Partial<Omit<Own, "on" | "consent">>;
/**
 * An edit of the provider in force to another host, held unsaved (integrations-c3-1): `from` is the host in force as it
 * began, `fields` everything edited since (the address always). Saved only with the card's yes for the new host, once
 * its details answer; until then requests still go to `from`, never to Copilot, and nothing goes to the new host.
 */
let held: { from: string; fields: Details } | null = null;
/** Counts held edits put away or readdressed, so a check of an older one says nothing. */
let heldRun = 0;
/** The host a held edit's check is asking now (its "I agree" waits meanwhile). */
let checkingFor: string | null = null;
/**
 * A held edit's host answered its check, but not with a model list (a 404 at that address, or a web page): the card
 * offers "Use it as typed" for exactly that edit (`run`: heldRun as it was checked; `asked`: what the check asked
 * with), and nothing is saved before that press (integrations-c5-1, -c7-1).
 */
let asTyped: { host: string; run: number; asked: string } | null = null;

/**
 * What a held edit's check asks with: the provider type (which sets the list's path and the key's header), the
 * address, Azure's API version and the key in the field. A change of any means that host was never asked this way, so
 * the offer made for the old ones goes (integrations-x7-2). The models and the wire API are no part of the question.
 */
function askedWith(): string {
  const d = { ...own, ...held?.fields };
  return JSON.stringify([d.type, d.baseUrl, d.azureApiVersion ?? null, input("byok-key").value.trim()]);
}
/** Ember has no GitHub sign-in (the agent's phase): with the card waiting, nothing answers until it is agreed. */
let signedOut = false;

/** One line under the group: how the last action went (`error`: in red). */
function say(text: string, error = false): void {
  const el = $("byok-msg");
  el.textContent = text;
  el.classList.toggle("error", error);
}

/** The user agreed to the card for this very host. */
const agreedFor = (p: Own, host: string | null) => !!host && p.consent.version >= FEATURE_CONSENT_VERSION.provider && p.consent.host === host;

/**
 * Saves the fields changed, and only those: main merges them into the user's own settings (withOwnProvider), so values
 * the organisation's policy applies here are never written back, and the card's record never travels this way.
 */
function change(patch: Partial<Omit<Own, "consent">>): Promise<boolean> {
  // An edit held for another host takes the rest of the details with it, saved together (integrations-c3-1).
  if (held && !("on" in patch)) { held = { ...held, fields: { ...held.fields, ...patch } }; draw(); return Promise.resolve(true); }
  noteProviderChoice();
  return save({ provider: patch } as SettingsPatch);
}

/** The host the user's own provider is in force for, by the settings the page holds (on, agreed to for its host), or null. */
function inForceHost(): string | null {
  const host = own ? endpointHost(own.baseUrl) : null;
  return own?.on && !state?.managed && agreedFor(own, host) ? host : null;
}

/**
 * An address entered (typed and left, or found in the field by "I agree"): with the provider in force for another host,
 * held with its card until that is agreed and answers (integrations-c3-1); back to the host in force, saved at once
 * with whatever was held, as any edit of that host is.
 */
function enter(address: string): void {
  announceFor = address ? endpointHost(address) : null;
  const from = held?.from ?? inForceHost();
  if (from && endpointHost(address) !== from) {
    held = { from, fields: { ...held?.fields, baseUrl: address } };
    heldRun++;
    checkingFor = null;
    draw();
    return;
  }
  const fields = held?.fields;
  if (held) { held = null; heldRun++; checkingFor = null; }
  void change({ ...fields, baseUrl: address });
}

/** The held edit put away: the details in force come back into the fields, and nothing was saved (integrations-c3-1). */
function keepInForce(): void {
  if (!held) return;
  const from = held.from;
  held = null;
  heldRun++;
  checkingFor = null;
  input("byok-key").value = "";
  draw();
  say(providerHeldKept(from));
  input("byok-url").focus();
}

/**
 * The card's yes for a held edit's host: its details are asked first (the one GET Test connection makes, to that host
 * only, with a key typed for it or none), and saved with the yes in one change only once they answer with a model
 * list. An answer without one (a gateway that answers chat only, but also a mistyped path or a web page) keeps the
 * edit held and offers "Use it as typed" (integrations-c5-1, -c7-1). A failure, or an edit or Keep using meanwhile,
 * saves nothing (integrations-c3-1).
 */
async function adopt(host: string): Promise<void> {
  const a = api();
  const was = held;
  if (!a || !own || !was) return;
  const run = heldRun;
  const asked = askedWith();
  const keyField = input("byok-key");
  const key = keyField.value.trim() ? keyField.value : "";
  const d = { ...own, ...was.fields };
  checkingFor = host;
  asTyped = null;
  draw();
  say(providerHeldChecking(host));
  const tried = await a.test({ type: d.type, baseUrl: d.baseUrl, host, ...(key ? { key } : {}) }).catch(() => ({ ok: false as const, why: PROVIDER_WORDS.testFailed }));
  // Put away or readdressed meanwhile: this check says nothing about what the fields hold now.
  if (run !== heldRun || !held || !own) return;
  checkingFor = null;
  if (!tried.ok) {
    // Something answered there, but not with a model list: the provider that works and its key stay until the person
    // says the address is right (integrations-c5-1). Nothing answering, a refused key or another error changes nothing.
    const unlisted = heldAnswer(tried) === "unlisted";
    if (unlisted) asTyped = { host, run, asked };
    draw();
    say(unlisted ? providerHeldUnlisted(held.from, tried.why) : providerHeldKept(held.from, tried.why), true);
    input(providerFailField(tried) === "key" ? "byok-key" : "byok-url").focus();
    return;
  }
  await commit(host, false, tried.ids);
}

/**
 * Saves a held edit with the card's yes for its host in one change, then the key typed for it. `unlisted`: by "Use it
 * as typed", for a host whose check answered with no model list (integrations-r4-2's chat-only gateways).
 */
async function commit(host: string, unlisted: boolean, ids?: string[]): Promise<void> {
  const a = api();
  if (!a || !own || !held) return;
  const keyField = input("byok-key");
  const key = keyField.value.trim() ? keyField.value : "";
  // Details edited while it was asked (a model) go too: they don't change where requests go.
  const now = { ...own, ...held.fields };
  const move: ProviderMove = { type: now.type, baseUrl: now.baseUrl, conductor: now.conductor, worker: now.worker, wireApi: now.wireApi, azureApiVersion: now.azureApiVersion };
  noteProviderChoice();
  const keep = held;
  held = null;
  asTyped = null;
  heldRun++;
  const done = await a.agree(host, move);
  // Not recorded (the settings changed meanwhile): still held, if the provider it began from is still in force.
  if (!done.ok) { if (!held && inForceHost() === keep.from) held = keep; draw(); say(done.why, true); return; }
  if (key) {
    const k = await a.saveKey(key);
    if (!k.ok) { say(k.why, true); void reread(); return; }
    keyField.value = "";
  }
  say(unlisted ? providerAgreedUnlisted(host, now.conductor ?? null) : providerAgreedText(host));
  if (ids) suggestModels(ids);
  input("byok-url").focus();
  void reread();
}

function draw(): void {
  if (!own) return;
  const managed = state?.managed ?? null;
  // A held edit whose provider is no longer in force for the host it began from (turned off, managed, changed elsewhere,
  // or just agreed with it) has nothing left to hold.
  if (held && inForceHost() !== held.from) { held = null; checkingFor = null; }
  // The fields show the held edit over the settings: the card, Test connection and the hint follow what is typed.
  const p: Own = held ? { ...own, ...held.fields } : own;
  const on = p.on && !managed;
  const host = endpointHost(p.baseUrl);
  const sw = input("byok-on");
  sw.checked = on;
  sw.disabled = managed !== null;
  sw.closest(".switch-row")?.classList.toggle("locked", managed !== null);
  if (managed) sw.title = "Managed by your organisation"; else sw.removeAttribute("title");
  for (const el of document.querySelectorAll<HTMLElement>("#byok .byok-field")) el.hidden = !on;
  // The card: on, with an address, not agreed to for it, and not put away for it.
  const asking = on && !!host && !agreedFor(p, host) && declinedFor !== host;
  $("byok-consent").hidden = !asking;
  // The card came up for an address just entered (Tab has moved on to the next field): said, never silent (integrations-7).
  if (announceFor !== null && host === announceFor) {
    if (asking && cardHost !== host && !$("byok-consent").contains(document.activeElement)) say(providerCardShown(host));
    announceFor = null;
  }
  // The host the card names, remembered: "I agree" is for it, whatever the field says by the time it is clicked.
  cardHost = asking ? host : null;
  agreeGuard.drawn(cardHost);
  // A held edit's card: its quiet button keeps the provider in use, and the switch would turn that off too (with no
  // GitHub sign-in, to nothing), so no sentence about going back to Copilot, as first run's step for a provider in use
  // (integrations-v4-1).
  if (asking) $("byok-consent-text").textContent = providerConsentText(host, held ? "in-use" : "home");
  // A held edit's quiet button keeps the provider in force, never turns it off; its "I agree" waits for its check.
  const no = held ? providerKeepLabel(held.from) : "Not now";
  if ($("byok-no").textContent !== no) $("byok-no").textContent = no;
  // aria-disabled, not disabled: the focus stays on it while its check runs.
  if (checkingFor !== null) $("byok-yes").setAttribute("aria-disabled", "true"); else $("byok-yes").removeAttribute("aria-disabled");
  // "Use it as typed" is for the very edit whose check answered with no model list: a change of its address, provider
  // type, Azure version or key takes the offer away, and with it the line that named the button (integrations-x7-2).
  if (asTyped && (!held || asTyped.run !== heldRun || asTyped.host !== cardHost)) asTyped = null;
  else if (asTyped && asTyped.asked !== askedWith()) { asTyped = null; say(""); }
  $("byok-as-typed").hidden = !asTyped || checkingFor !== null;
  // Nothing goes to a host the card isn't agreed for, Test connection included: it waits for the yes.
  const test = $("byok-test") as HTMLButtonElement;
  test.disabled = !agreedFor(p, host) || !!managed;
  // Disabled, it says why beside it (and to a screen reader on the button).
  const waits = providerTestWaits({ host, agreed: agreedFor(p, host), managed: !!managed });
  $("byok-test-why").hidden = !on || waits === null;
  $("byok-test-why").textContent = waits ?? "";
  // Fields keep what is being typed: only one without the focus is rewritten from the settings.
  const fill = (id: string, v: string) => { const el = input(id); if (document.activeElement !== el) el.value = v; };
  if (document.activeElement !== select("byok-type")) select("byok-type").value = p.type;
  fill("byok-url", p.baseUrl);
  fill("byok-conductor", p.conductor ?? "");
  fill("byok-worker", p.worker ?? "");
  fill("byok-azure", p.azureApiVersion ?? "");
  if (document.activeElement !== select("byok-wire")) select("byok-wire").value = p.wireApi === "responses" ? "responses" : "";
  // Anthropic has one API; the Azure version only for Azure.
  (select("byok-wire").closest(".choice") as HTMLElement).hidden = p.type === "anthropic";
  $("byok-azure-row").hidden = p.type !== "azure";
  // The key: saved (with Replace and Remove), its field, or why none can be kept here.
  // A key saved for the host in force never goes to a held edit's host: its field is for that host's key.
  const saved = !!state?.keySaved && !held;
  const keyring = state?.keyring !== false;
  $("byok-key-saved").hidden = !saved || replacing;
  $("byok-key-form").hidden = (saved && !replacing) || (!keyring && !saved);
  $("byok-no-keyring").hidden = keyring || saved;
  $("byok-no-keyring").textContent = PROVIDER_NO_KEYRING;
  $("byok-hint").textContent = held ? providerHeldHint(held.from, host) : providerHint({ managed, inForce: !!state?.inForce, on, host, signedOut });
  onDestination();
}

/** The models the last Test connection named, offered in both model fields (values only: the service's text, never markup). */
function suggestModels(ids: readonly string[]): void {
  const list = $("byok-models");
  list.replaceChildren(...ids.filter(id => MODEL_ID.test(id)).slice(0, 50).map(id => { const o = document.createElement("option"); o.value = id; return o; }));
}

/**
 * The switch as drawn (`on`, not the organisation's service) and the host whose card is up (`card`, null: none), for
 * Home's status panel while nothing is connected (integrations-c2-3).
 */
export function providerCard(): { on: boolean; card: string | null } {
  return { on: !!own?.on && !state?.managed, card: cardHost };
}

/** The agent's phase says whether Ember has a GitHub sign-in: the hint under the group follows it (integrations-r3-1). */
export function providerSignedOut(now: boolean): void {
  if (now === signedOut) return;
  signedOut = now;
  draw();
}

/** Told when what the page knows of the provider changes (the words naming where requests go follow it). */
let onDestination: () => void = () => undefined;
export function onProviderDestination(fn: () => void): void { onDestination = fn; }

/**
 * Whether the user's own provider is in force, from main's own answer (ProviderState.inForce and .host, which main
 * computes as it routes: on, agreed to for the host, allowed), not from the settings the page holds. Unknown while a read
 * is pending or failed, or before the first settings: the page never guesses Copilot. Without the provider bridge there
 * is no user provider, so that is known.
 */
export function ownProvider(): OwnProvider {
  if (!api()) return { known: true, host: null };
  if (!own || !state || !stateFresh) return { known: false };
  return { known: true, host: state.inForce && state.host ? state.host : null };
}

const refresh = latestOnly<ProviderState>(
  async () => { const a = api(); if (!a) throw new Error("no bridge"); return a.state(); },
  r => {
    state = r.ok ? r.value : null; stateFresh = r.ok;
    draw();
  },
);

/** A read is starting: until it answers, where requests go isn't known. */
function reread(): Promise<void> {
  stateFresh = false;
  onDestination();
  return refresh();
}

/** The settings changed (here, by voice or in the file): the group follows them. */
export function providerSettings(s: Settings): void {
  own = s.provider;
  draw();
  void reread();
}

/** Wires the group's controls; `saveSettings` is Home's own save (it says why a change couldn't be saved). */
export function startProvider(saveSettings: (patch: SettingsPatch) => Promise<boolean>): void {
  save = saveSettings;
  const a = api();
  if (!a) { $("byok-h").hidden = true; $("byok").hidden = true; return; }
  a.onChanged(() => void reread());
  input("byok-on").addEventListener("change", e => {
    const on = (e.target as HTMLInputElement).checked;
    declinedFor = null;
    say("");
    // Off with an edit held: the edit is put away unsaved, as Keep using does, and only the switch is saved, so the
    // address in use and its key stay for when it is turned on again (integrations-v4-1).
    if (held) { held = null; heldRun++; checkingFor = null; input("byok-key").value = ""; }
    void change({ on });
    if (on && own && endpointHost(own.baseUrl) && !agreedFor(own, endpointHost(own.baseUrl))) queueMicrotask(() => $("byok-yes").focus());
  });
  // The host is taken as "I agree" is pressed: pressing blurs the address field, whose save can redraw the card for
  // another host before the click lands, and then nothing is agreed.
  $("byok-yes").addEventListener("pointerdown", () => agreeGuard.press());
  $("byok-yes").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") agreeGuard.press(); });
  $("byok-yes").addEventListener("click", () => {
    const pressedFor = agreeGuard.activate();
    if (!pressedFor) return;
    // The yes is for the host the card named. The field naming another one now (an edit whose save hasn't come back
    // yet): that address is saved and the card is drawn again for its host, to be read and agreed to; nothing is agreed.
    const next = agreeAction(pressedFor, input("byok-url").value);
    if (!next) return;
    if ("problem" in next) { say(next.problem, true); input("byok-url").focus(); return; }
    if ("save" in next) {
      // A held edit: the address in the field is held in its place, and the card drawn again for it.
      if (held) { enter(next.save); say(PROVIDER_WORDS.readAgain); $("byok-yes").focus(); return; }
      void change({ baseUrl: next.save }).then(() => { say(PROVIDER_WORDS.readAgain); $("byok-yes").focus(); });
      return;
    }
    if (held) { if (checkingFor === null) void adopt(next.agree); return; }
    noteProviderChoice();
    void a.agree(next.agree).then(r => {
      if (!r.ok) { say(r.why, true); return; }
      say(providerAgreedText(next.agree));
      $("byok-consent").hidden = true;
      input("byok-url").focus();
    });
  });
  // The second, explicit press for a host that answered its check with no model list (integrations-c5-1): for the card
  // and the address as they were checked, never one typed since.
  $("byok-as-typed").addEventListener("click", () => {
    const offer = asTyped;
    if (!offer || !held || offer.run !== heldRun || offer.host !== cardHost || checkingFor !== null) return;
    // Asked with another type or key than the fields hold now: nothing is adopted (integrations-x7-2).
    if (offer.asked !== askedWith()) { draw(); return; }
    const next = agreeAction(offer.host, input("byok-url").value);
    if (!next || !("agree" in next) || endpointHost(held.fields.baseUrl ?? "") !== offer.host) return;
    void commit(offer.host, true);
  });
  $("byok-no").addEventListener("click", () => {
    if (held) { keepInForce(); return; }
    declinedFor = own ? endpointHost(own.baseUrl) : null;
    void change({ on: false });
    input("byok-on").focus();
  });
  select("byok-type").addEventListener("change", e => void change({ type: (e.target as HTMLSelectElement).value as ProviderType }));
  input("byok-url").addEventListener("change", e => {
    const v = (e.target as HTMLInputElement).value.trim();
    const problem = v ? endpointProblem(v) : null;
    if (problem) { say(problem, true); return; }
    say("");
    enter(v);
  });
  const model = (id: string, key: "conductor" | "worker") => input(id).addEventListener("change", e => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v && !MODEL_ID.test(v)) { say(PROVIDER_WORDS.badModel, true); return; }
    // The line that names "Use it as typed" stays while the button does: a model is no part of what was asked.
    if (!asTyped) say("");
    void change({ [key]: v || null });
  });
  model("byok-conductor", "conductor");
  model("byok-worker", "worker");
  select("byok-wire").addEventListener("change", e => void change({ wireApi: (e.target as HTMLSelectElement).value === "responses" ? "responses" : null }));
  input("byok-azure").addEventListener("change", e => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v && !AZURE_API_VERSION.test(v)) { say(PROVIDER_WORDS.badAzure, true); return; }
    void change({ azureApiVersion: v || null });
  });
  // A key typed over the one a held edit was checked with: its offer goes as it is typed (integrations-x7-2).
  input("byok-key").addEventListener("input", () => { if (asTyped) draw(); });
  $("byok-key-form").addEventListener("submit", e => {
    e.preventDefault();
    const field = input("byok-key");
    const key = field.value;
    if (!key.trim()) { say(PROVIDER_WORDS.pasteKey, true); field.focus(); return; }
    // Saved now it would be for the host still in force: it waits in the field for the held edit's yes (integrations-c3-1).
    if (held) { say(providerHeldKey(endpointHost(held.fields.baseUrl ?? ""))); return; }
    noteProviderChoice();
    void a.saveKey(key).then(r => {
      if (r.ok) { field.value = ""; replacing = false; say(PROVIDER_WORDS.keySaved); } else say(r.why, true);
      return reread();
    }).then(() => { if (!replacing) ($("byok-key-replace") as HTMLButtonElement).focus(); });
  });
  $("byok-key-replace").addEventListener("click", () => { replacing = true; draw(); input("byok-key").focus(); });
  $("byok-key-remove").addEventListener("click", () => {
    noteProviderChoice();
    void a.removeKey().then(r => { say(r.ok ? PROVIDER_WORDS.keyRemoved : r.why, !r.ok); replacing = false; return reread(); }).then(() => input("byok-key").focus());
  });
  $("byok-test").addEventListener("click", () => {
    const btn = $("byok-test") as HTMLButtonElement;
    btn.disabled = true;
    say(PROVIDER_WORDS.testing);
    void a.test().then(r => { say(providerTestText(r), !r.ok); if (r.ok) suggestModels(r.ids ?? []); }, () => say(PROVIDER_WORDS.testFailed, true)).finally(() => { btn.disabled = false; });
  });
  void reread();
}
