/**
 * Customise › Models: the models this account may use (client `models.list`: vendor, context window, images,
 * reasoning efforts, the billing multiplier, the organisation's policy), the open session's model and reasoning effort
 * (`model.getCurrent`, changed with `model.switchTo` and `model.setReasoningEffort`), and the other providers the SDK
 * finds (`providers.getCatalog`, `discover`, `getStatus`, `models.list`), shown read-only. A provider of the person's
 * own with a key is Ember's settings' to keep (Models & connections › Model provider): nothing here takes a key.
 */
import { effortName } from "./copy";
import {
  EFFORT_LABEL, EFFORT_NONE, EFFORT_SET, MODELS_AVAILABLE, MODELS_NONE, MODELS_SESSION, MODEL_LABEL, MODEL_SWITCH, PROVIDERS, PROVIDERS_FIND,
  PROVIDERS_LEAD, PROVIDERS_NONE, PROVIDER_NEEDS_INPUT, SESSION_PART_NONE, PROVIDER_NEEDS_TRUST, effortChanged, modelMeta, modelSwitched, policyWords, providerModelLine,
  providerOutcome, providerReach, providerState,
} from "./copy-customise";
import { action, defineSection, field, list, load, part, problem, row } from "./customise-kit";
import { currentModel, modelRows, providerInstances, providerModels, providerRows, providerStatus, switchOutcome, type ModelRow } from "./customise-read";
import { el, idPart } from "./dom";

defineSection("Models", "both", ctx => {
  let models: ModelRow[] = [];
  return {
    draw(body) {
      const avail = part(MODELS_AVAILABLE, { scope: "client" });
      const mine = part(MODELS_SESSION, { scope: "session", session: ctx.session() });
      const prov = part(PROVIDERS, { scope: "session", session: ctx.session(), lead: PROVIDERS_LEAD });
      body.replaceChildren(mine.root, avail.root, prov.root);
      void load(avail.body, () => ctx.call("client", "models.list", {}), v => {
        models = modelRows(v);
        drawSession(mine.body);
        return list(MODELS_AVAILABLE, models.map(m => row({
          name: m.name, id: `cz-model-${idPart(m.id)}`, lines: [modelMeta(m), ...m.notices.slice(0, 2)], mono: m.id !== m.name ? m.id : undefined,
          tags: [policyWords(m.policy)],
        })), MODELS_NONE);
      }).then(v => { if (v === null) drawSession(mine.body); });
      if (ctx.session()) drawProviders(prov.body);
      else prov.body.replaceChildren(problem({ reason: SESSION_PART_NONE }));
    },
  };

  function drawSession(host: HTMLElement): void {
    if (!ctx.session()) { host.replaceChildren(problem({ reason: SESSION_PART_NONE })); return; }
    void load(host, () => ctx.call("session", "model.getCurrent"), v => {
      const cur = currentModel(v);
      const pick = el("select");
      const usable = models.filter(m => m.policy !== "disabled");
      const ids = new Set(usable.map(m => m.id));
      if (cur.modelId && !ids.has(cur.modelId)) pick.append(el("option", { value: cur.modelId, textContent: cur.modelId }));
      for (const m of usable) pick.append(el("option", { value: m.id, textContent: m.name, selected: m.id === cur.modelId }));
      const effort = el("select");
      const model = (id: string) => models.find(m => m.id === id);
      const fillEfforts = () => {
        const m = model(pick.value);
        const list = m?.efforts ?? [];
        effort.replaceChildren(...list.map(e => el("option", { value: e, textContent: e === m?.defaultEffort ? `${effortName(e)} (default)` : effortName(e), selected: e === (pick.value === cur.modelId ? cur.effort : m?.defaultEffort) })));
        effort.disabled = !list.length;
        effortWrap.hidden = !list.length;
        noEffort.hidden = !!list.length;
      };
      const modelField = field("cz-model-pick", MODEL_LABEL, pick);
      const effortField = field("cz-effort-pick", EFFORT_LABEL, effort);
      const effortWrap = effortField.root;
      const noEffort = el("p", { className: "hint", textContent: EFFORT_NONE });
      pick.addEventListener("change", fillEfforts);
      const switchBtn = action(MODEL_SWITCH, async () => {
        const id = pick.value;
        const r = await ctx.call("session", "model.switchTo", { modelId: id, ...(effort.value && !effort.disabled ? { reasoningEffort: effort.value } : {}) });
        if (!r.ok) { modelField.error(r.reason); return; }
        modelField.error("");
        const out = switchOutcome(r.value);
        ctx.say(modelSwitched(model(id)?.name ?? id, out.deferred));
        cur.modelId = id;
      }, { prominent: true });
      const effortBtn = action(EFFORT_SET, async () => {
        const r = await ctx.call("session", "model.setReasoningEffort", { reasoningEffort: effort.value });
        if (!r.ok) { effortField.error(r.reason); return; }
        effortField.error("");
        cur.effort = effort.value;
        ctx.say(effortChanged(effort.value));
      });
      fillEfforts();
      return [el("div", { className: "cz-form cz-inline" }, modelField.root, effortWrap, noEffort, el("div", { className: "cz-form-actions" }, switchBtn, effortBtn))];
    });
  }

  function drawProviders(host: HTMLElement): void {
    void load(host, () => ctx.call("session", "providers.getCatalog"), v => {
      const rows = providerRows(v);
      return list(PROVIDERS, rows.map(p => {
        const out = el("div", { className: "cz-sub" });
        const canLook = !p.needsInput && !p.needsTrust;
        const look = canLook ? action(PROVIDERS_FIND, () => discover(p.adapterId, out), { aria: `${PROVIDERS_FIND}: ${p.name}` }) : null;
        return row({ name: p.name, lines: [providerReach(p.network), p.needsInput ? PROVIDER_NEEDS_INPUT : p.needsTrust ? PROVIDER_NEEDS_TRUST : undefined], actions: [look], more: [out] });
      }), PROVIDERS_NONE);
    });
  }

  async function discover(adapterId: string, out: HTMLElement): Promise<void> {
    await load(out, () => ctx.call("session", "providers.discover", { adapterId }), v => {
      const found = providerInstances(v);
      if (!found.instances.length) return el("p", { className: "cz-line", textContent: providerOutcome(found.outcome === "success" ? "absent" : found.outcome) });
      return el("ul", { className: "cz-list nested" }, ...found.instances.map(i => {
        const state = el("p", { className: "cz-line" });
        const modelsOut = el("div", { className: "cz-sub" });
        void load(state, () => ctx.call("session", "providers.getStatus", { instance: i.reference }), s => { const st = providerStatus(s); return el("span", { textContent: providerState(st.status, st.version) }); });
        void load(modelsOut, () => ctx.call("session", "providers.models.list", { instance: i.reference }), m => {
          const ms = providerModels(m);
          return ms.length ? el("ul", { className: "cz-plain", attrs: { "aria-label": `${i.name}: ${MODEL_LABEL}` } }, ...ms.map(x => el("li", { textContent: providerModelLine(x) }))) : el("p", { className: "cz-line", textContent: providerOutcome("absent") });
        });
        return row({ name: i.name, mono: i.endpoint, more: [state, modelsOut] });
      }));
    });
  }
});
