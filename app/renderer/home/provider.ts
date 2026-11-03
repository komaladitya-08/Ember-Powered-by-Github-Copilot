/**
 * The settings window's Model provider group (Copilot section): the user's own model provider, over
 * `window.emberProvider` (app/main/provider-ipc.ts) and the settings. The switch shows the card (copy.ts
 * providerConsentText, FEATURE_CONSENT_VERSION.provider) for the endpoint's host before anything goes there, and again
 * for another host. The API key is typed into a password field and sent to main once; the page only ever hears whether
 * one is saved ("Key saved", with Replace and Remove). Words come from copy.ts.
 */

import type { EmberProviderApi, ProviderState } from "../../shared/ipc";
import type { Settings, SettingsPatch } from "../../main/settings";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { AZURE_API_VERSION, agreeAction, endpointHost, endpointProblem, MODEL_ID, type ProviderType } from "../../shared/provider";
import { PROVIDER_NO_KEYRING, PROVIDER_WORDS, providerConsentText, providerHint, providerTestText } from "./copy";

declare global { interface Window { emberProvider?: EmberProviderApi } }

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const select = (id: string) => $(id) as HTMLSelectElement;
const api = () => window.emberProvider;

type Own = Settings["provider"];
let save: (patch: SettingsPatch) => Promise<boolean> = async () => false;
let own: Own | null = null;
let state: ProviderState | null = null;
/** Replace was pressed: the key field shows although a key is saved. */
let replacing = false;
/** The card was put away with Not now (for this host): it doesn't come back until the switch is turned on again. */
let declinedFor: string | null = null;
/** The host the card was last drawn for (null: no card up). */
let cardHost: string | null = null;

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
  return save({ provider: patch } as SettingsPatch);
}

function draw(): void {
  const p = own;
  if (!p) return;
  const managed = state?.managed ?? null;
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
  // The host the card names, remembered: "I agree" is for it, whatever the field says by the time it is clicked.
  cardHost = asking ? host : null;
  if (asking) $("byok-consent-text").textContent = providerConsentText(host);
  // Nothing goes to a host the card isn't agreed for, Test connection included: it waits for the yes.
  const test = $("byok-test") as HTMLButtonElement;
  test.disabled = !agreedFor(p, host) || !!managed;
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
  const saved = !!state?.keySaved;
  const keyring = state?.keyring !== false;
  $("byok-key-saved").hidden = !saved || replacing;
  $("byok-key-form").hidden = (saved && !replacing) || (!keyring && !saved);
  $("byok-no-keyring").hidden = keyring || saved;
  $("byok-no-keyring").textContent = PROVIDER_NO_KEYRING;
  $("byok-hint").textContent = providerHint({ managed, inForce: !!state?.inForce, on, host });
}

async function refresh(): Promise<void> {
  const a = api();
  if (!a) return;
  try { state = await a.state(); } catch { state = null; /* drawn from the settings alone */ }
  draw();
}

/** The settings changed (here, by voice or in the file): the group follows them. */
export function providerSettings(s: Settings): void {
  own = s.provider;
  draw();
  void refresh();
}

/** Wires the group's controls; `saveSettings` is Home's own save (it says why a change couldn't be saved). */
export function startProvider(saveSettings: (patch: SettingsPatch) => Promise<boolean>): void {
  save = saveSettings;
  const a = api();
  if (!a) { $("byok-h").hidden = true; $("byok").hidden = true; return; }
  a.onChanged(() => void refresh());
  input("byok-on").addEventListener("change", e => {
    const on = (e.target as HTMLInputElement).checked;
    declinedFor = null;
    say("");
    void change({ on });
    if (on && own && endpointHost(own.baseUrl) && !agreedFor(own, endpointHost(own.baseUrl))) queueMicrotask(() => $("byok-yes").focus());
  });
  $("byok-yes").addEventListener("click", () => {
    // The yes is for the host the card named. The field naming another one now (an edit whose save hasn't come back
    // yet): that address is saved and the card is drawn again for its host, to be read and agreed to; nothing is agreed.
    const next = agreeAction(cardHost, input("byok-url").value);
    if (!next) return;
    if ("problem" in next) { say(next.problem, true); input("byok-url").focus(); return; }
    if ("save" in next) {
      void change({ baseUrl: next.save }).then(() => { say(PROVIDER_WORDS.readAgain); $("byok-yes").focus(); });
      return;
    }
    void a.agree(next.agree).then(r => {
      if (!r.ok) { say(r.why, true); return; }
      $("byok-consent").hidden = true;
      input("byok-url").focus();
    });
  });
  $("byok-no").addEventListener("click", () => {
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
    void change({ baseUrl: v });
  });
  const model = (id: string, key: "conductor" | "worker") => input(id).addEventListener("change", e => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v && !MODEL_ID.test(v)) { say(PROVIDER_WORDS.badModel, true); return; }
    say("");
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
  $("byok-key-form").addEventListener("submit", e => {
    e.preventDefault();
    const field = input("byok-key");
    const key = field.value;
    if (!key.trim()) { say(PROVIDER_WORDS.pasteKey, true); field.focus(); return; }
    void a.saveKey(key).then(r => {
      if (r.ok) { field.value = ""; replacing = false; say(PROVIDER_WORDS.keySaved); } else say(r.why, true);
      return refresh();
    }).then(() => { if (!replacing) ($("byok-key-replace") as HTMLButtonElement).focus(); });
  });
  $("byok-key-replace").addEventListener("click", () => { replacing = true; draw(); input("byok-key").focus(); });
  $("byok-key-remove").addEventListener("click", () => {
    void a.removeKey().then(r => { say(r.ok ? PROVIDER_WORDS.keyRemoved : r.why, !r.ok); replacing = false; return refresh(); }).then(() => input("byok-key").focus());
  });
  $("byok-test").addEventListener("click", () => {
    const btn = $("byok-test") as HTMLButtonElement;
    btn.disabled = true;
    say(PROVIDER_WORDS.testing);
    void a.test().then(r => say(providerTestText(r), !r.ok), () => say(PROVIDER_WORDS.testFailed, true)).finally(() => { btn.disabled = false; });
  });
  void refresh();
}
