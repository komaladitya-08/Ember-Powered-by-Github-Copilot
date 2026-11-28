/**
 * Request cards, inline in the transcript: a permission (exactly main's `choices`, what will run or change shown in
 * full, the SDK's assisted recommendation and risk assessment as lines of their own), the model's question, an
 * elicitation (a form from its schema, or an address to open), leaving plan mode, the auto model switch, session
 * limits, MCP sign-in and sampling. Each answers once through `respond` with the SDK's own result shape (requests.ts)
 * and becomes a one-line record once main or the SDK says it is answered.
 *
 * As Ember's other approval surfaces: a press that grants something counts only once the card has been in view for
 * AGREE_ARM_MS, and never from a held Enter or Space (`heldPress`); Don't allow, Not now and Keep planning are never
 * held back. Nothing on a card moves while it waits.
 */
import { linkRefusal, type CodePendingRequest, type CodeRequestKind } from "../../shared/code";
import { AGREE_ARM_MS, heldPress } from "../../shared/provider";
import type { CodeApp } from "./app";
import {
  ANSWER_LABEL, ANSWER_SEND, AUTO_ANSWERS, AUTO_TITLE, CARD_LEAD, COPY_ADDRESS, OPEN_ADDRESS, ELICITATION_CANCEL, ELICITATION_DECLINE, ELICITATION_SUBMIT,
  ELICITATION_URL, ELICITATION_URL_DONE, FIELDS, LIMITS_ADD, LIMITS_AMOUNT, LIMITS_AMOUNT_NEEDED, LIMITS_CANCEL, LIMITS_TITLE, LIMITS_UNSET, MANAGED,
  NEEDS_YOU, NOT_BUILT, OAUTH_NOTE, OAUTH_NOT_NOW, PLAN_EXIT_TITLE, PLAN_FEEDBACK, PLAN_KEEP, PLAN_LABEL, QUESTION_LEAD, READ_ONLY, REASON_LABEL,
  REASON_SUMMARY, RECOMMENDED, SAMPLING_NOTE, SAMPLING_REFUSE, SENDING, WRITES_FILES, answeredRecord, assistedLine, autoLead, autoRecord, covers,
  decisionLabel, elicitationLead, elicitationRecord, fieldProblem, genericRecord, limitsLead, limitsRecord, oauthLead, oauthTitle, permissionRecord,
  permissionTitle, planAction, planRecord, riskLine, samplingTitle, sandboxBypass, warningLine,
} from "./copy";
import { diffView } from "./diff-view";
import { copyText, el, idPart } from "./dom";
import { markdownNodes } from "./markdown-dom";
import {
  AUTO_MODE_ANSWERS, ELICITATION_CANCEL as EL_CANCEL, ELICITATION_DECLINE as EL_DECLINE, FEEDBACK_MAX, ANSWER_MAX, OAUTH_CANCEL,
  SAMPLING_REFUSE as SAMPLE_NO, autoModeCard, elicitationAccept, elicitationCard, grants, limitsAnswer, limitsCard, oauthCard, permissionAnswer,
  permissionCard, planExitAnswer, planExitCard, questionAnswer, questionCard, samplingServer, type FormField,
} from "./requests";
import type { Answering } from "./store";
import type { RequestItem } from "./transcript";

/** When each request's card first came into view, so its granting answers wait until it has been seen a moment. */
export class Arming {
  private seen = new Map<string, number>();
  private io: IntersectionObserver | null = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(entries => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.request;
        if (e.isIntersecting && id && !this.seen.has(id)) this.seen.set(id, performance.now());
      }
    })
    : null;
  constructor(private readonly armMs = AGREE_ARM_MS) {}
  watch(card: HTMLElement): void { this.io?.observe(card); }
  forget(card: HTMLElement): void { this.io?.unobserve(card); }
  armed(requestId: string): boolean { return performance.now() - (this.seen.get(requestId) ?? Infinity) >= this.armMs; }
}

/** The title a card's question has, for the live region and the needs-you bar. */
export function requestTitle(kind: CodeRequestKind, data: unknown): string {
  switch (kind) {
    case "permission": return permissionTitle(permissionCard(data).view);
    case "user-input": return questionCard(data).question;
    case "elicitation": return elicitationLead(elicitationCard(data).source);
    case "exit-plan-mode": return PLAN_EXIT_TITLE;
    case "auto-mode-switch": return AUTO_TITLE;
    case "session-limits": return LIMITS_TITLE;
    case "mcp-oauth": return oauthTitle(oauthCard(data).server);
    case "sampling": return samplingTitle(samplingServer(data));
  }
}

/** A record's line, once a request is answered. */
export function recordLine(item: RequestItem): string {
  switch (item.request) {
    case "permission": return permissionRecord(item.outcome, item.by);
    case "user-input": {
      const answer = typeof item.outcome === "object" && item.outcome ? (item.outcome as { answer?: unknown }).answer : undefined;
      return answeredRecord(typeof answer === "string" ? answer : undefined, item.by);
    }
    case "elicitation": return elicitationRecord(item.outcome, item.by);
    case "exit-plan-mode": return planRecord(item.outcome, item.by);
    case "auto-mode-switch": return autoRecord(item.outcome, item.by);
    case "session-limits": return limitsRecord(item.outcome, item.by);
    default: return genericRecord(item.by);
  }
}

export interface CardContext {
  app: CodeApp;
  sessionId: string;
  arming: Arming;
  /** Main's pending entry (its choices), when main has it waiting. */
  pending: CodePendingRequest | undefined;
  answering: Answering | undefined;
  /** Put before every id the card makes, where the same request's card is also drawn elsewhere (the Plan tab). */
  idPrefix?: string;
}

const field = (dl: HTMLDListElement, label: string, value: Node | string) => { dl.append(el("dt", { textContent: label }), el("dd", {}, value)); };
const code = (text: string) => el("pre", { className: "card-code", textContent: text, tabIndex: 0 });

/** A request's card (or its record once answered). */
export function requestCard(item: RequestItem, ctx: CardContext): HTMLElement {
  const title = requestTitle(item.request, item.data);
  const id = `${ctx.idPrefix ?? ""}req-${idPart(item.requestId)}`;
  if (item.done || (!ctx.pending && item.by)) {
    const done = el("div", { className: "card resolved", data: { request: item.requestId } },
      el("span", { className: "sr", textContent: `${title} ` }),
      el("p", { className: "record", textContent: recordLine(item), data: { status: recordStatus(item) } }));
    return done;
  }
  const sending = ctx.answering?.state === "sending";
  const card = el("div", { className: `card${item.request === "permission" ? " permission" : ""}`, id, attrs: { role: "group", "aria-labelledby": `${id}-t` }, data: { request: item.requestId, kind: item.request } });
  card.append(
    el("p", { className: "card-lead" }, el("span", { className: "tag", textContent: NEEDS_YOU }), el("span", { textContent: item.request === "user-input" ? QUESTION_LEAD : CARD_LEAD })),
    el("p", { className: "card-title", id: `${id}-t`, textContent: title }));
  const answer = (payload: unknown) => { void ctx.app.respond({ sessionId: ctx.sessionId, requestId: item.requestId, kind: item.request, payload }); };
  /** A button that grants: it waits until the card was in view a moment, and a held key presses nothing. */
  const grant = (b: HTMLButtonElement, fn: () => void) => {
    b.addEventListener("keydown", e => { if (heldPress(e)) e.preventDefault(); });
    b.addEventListener("click", () => { if (ctx.arming.armed(item.requestId)) fn(); });
    return b;
  };
  const btn = (label: string, focus: string, opts: { prominent?: boolean } = {}) =>
    el("button", { type: "button", className: `btn small${opts.prominent ? "" : " quiet"}`, textContent: label, disabled: sending || !ctx.pending, data: { focus } });
  const actions = el("div", { className: "card-actions" });

  switch (item.request) {
    case "permission": drawPermission(card, item, ctx, actions, btn, grant, answer, id); break;
    case "user-input": {
      const q = questionCard(item.data);
      q.choices.forEach((c, i) => { const b = btn(c, `choice-${i}`); b.addEventListener("click", () => { const a = questionAnswer(q, c, false); if (a) answer(a); }); actions.append(b); });
      if (actions.childElementCount) card.append(actions);
      if (q.freeform) {
        const input = el("textarea", { id: `${id}-answer`, rows: 2, maxLength: ANSWER_MAX, disabled: sending, data: { focus: "answer" } });
        const send = el("button", { type: "submit", className: "btn quiet small", textContent: ANSWER_SEND, disabled: sending || !ctx.pending, data: { focus: "answer-send" } });
        const form = el("form", { className: "card-form" }, el("label", { htmlFor: input.id, textContent: ANSWER_LABEL }), input, el("div", { className: "card-actions" }, send));
        form.addEventListener("submit", e => { e.preventDefault(); const a = questionAnswer(q, input.value, true); if (a) answer(a); });
        input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
        card.append(form);
      }
      break;
    }
    case "elicitation": drawElicitation(card, item, ctx, btn, answer, id); break;
    case "exit-plan-mode": {
      const p = planExitCard(item.data);
      if (p.summary) card.append(el("div", { className: "card-text md" }, ...markdownNodes(p.summary)));
      if (p.plan) card.append(el("p", { className: "card-sub", textContent: PLAN_LABEL }), el("div", { className: "card-plan md", tabIndex: 0, attrs: { "aria-label": PLAN_LABEL } }, ...markdownNodes(p.plan)));
      const feedback = el("textarea", { id: `${id}-feedback`, rows: 2, maxLength: FEEDBACK_MAX, disabled: sending, data: { focus: "feedback" } });
      for (const action of p.actions) {
        const rec = action === p.recommended;
        const b = btn(planAction(action), `plan-${action}`, { prominent: rec });
        if (rec) b.append(el("span", { className: "sr", textContent: ` (${RECOMMENDED})` }));
        grant(b, () => { const a = planExitAnswer(p, action, feedback.value); if (a) answer(a); });
        actions.append(rec ? el("span", { className: "rec" }, b, el("span", { className: "rec-tag", textContent: RECOMMENDED, attrs: { "aria-hidden": "true" } })) : b);
      }
      const keepPlanning = btn(PLAN_KEEP, "plan-keep");
      keepPlanning.addEventListener("click", () => answer(planExitAnswer(p, null, feedback.value)));
      actions.append(keepPlanning);
      card.append(actions, el("div", { className: "card-form" }, el("label", { htmlFor: feedback.id, textContent: PLAN_FEEDBACK }), feedback));
      break;
    }
    case "auto-mode-switch": {
      card.append(el("p", { className: "card-text", textContent: autoLead(autoModeCard(item.data)) }));
      for (const a of AUTO_MODE_ANSWERS) {
        const b = btn(AUTO_ANSWERS[a], `auto-${a}`);
        if (a === "no") b.addEventListener("click", () => answer(a)); else grant(b, () => answer(a));
        actions.append(b);
      }
      card.append(actions);
      break;
    }
    case "session-limits": {
      const l = limitsCard(item.data);
      card.append(el("p", { className: "card-text", textContent: limitsLead(l.used, l.max) }));
      const amount = el("input", { type: "number", id: `${id}-amount`, min: "1", step: "1", inputMode: "numeric", disabled: sending, data: { focus: "amount" } });
      const problem = el("p", { className: "card-problem", attrs: { role: "alert" } });
      const add = btn(LIMITS_ADD, "limits-add");
      grant(add, () => { const a = limitsAnswer("add", Number(amount.value)); if (a) answer(a); else { problem.textContent = LIMITS_AMOUNT_NEEDED; amount.focus(); } });
      const unset = btn(LIMITS_UNSET, "limits-unset");
      grant(unset, () => answer(limitsAnswer("unset")));
      const stop = btn(LIMITS_CANCEL, "limits-cancel");
      stop.addEventListener("click", () => answer(limitsAnswer("cancel")));
      card.append(el("div", { className: "card-form inline" }, el("label", { htmlFor: amount.id, textContent: LIMITS_AMOUNT }), amount, add), problem, el("div", { className: "card-actions" }, unset, stop));
      break;
    }
    case "mcp-oauth": {
      const o = oauthCard(item.data);
      card.append(el("p", { className: "card-text", textContent: oauthLead(o.url, o.reason) }));
      const no = btn(OAUTH_NOT_NOW, "oauth-no");
      no.addEventListener("click", () => answer(OAUTH_CANCEL));
      actions.append(no);
      card.append(el("p", { className: "hint", textContent: OAUTH_NOTE }), actions);
      break;
    }
    case "sampling": {
      card.append(el("p", { className: "hint", textContent: SAMPLING_NOTE }));
      const no = btn(SAMPLING_REFUSE, "sampling-no");
      no.addEventListener("click", () => answer(SAMPLE_NO));
      actions.append(no);
      card.append(actions);
      break;
    }
  }
  if (sending) card.append(el("p", { className: "hint", textContent: SENDING }));
  if (ctx.answering?.state === "refused" && ctx.answering.reason) card.append(el("p", { className: "card-problem", textContent: ctx.answering.reason }));
  ctx.arming.watch(card);
  return card;
}

function recordStatus(item: RequestItem): string {
  const o = item.outcome;
  if (item.request === "user-input") return "done";
  const kind = typeof o === "object" && o ? String((o as { kind?: unknown; action?: unknown; approved?: unknown }).kind ?? (o as { action?: unknown }).action ?? "") : typeof o === "string" ? o : "";
  if (kind.startsWith("approve") || kind === "accept" || kind === "yes" || kind === "yes_always" || (typeof o === "object" && o && (o as { approved?: unknown }).approved === true)) return "done";
  return "stopped";
}

type Btn = (label: string, focus: string, opts?: { prominent?: boolean }) => HTMLButtonElement;

function drawPermission(card: HTMLElement, item: RequestItem, ctx: CardContext, actions: HTMLElement, btn: Btn, grant: (b: HTMLButtonElement, fn: () => void) => HTMLButtonElement, answer: (p: unknown) => void, id: string): void {
  const c = permissionCard(item.data);
  const v = c.view;
  const dl = el("dl", { className: "card-fields" });
  const notes: string[] = [];
  switch (v.kind) {
    case "shell":
      field(dl, FIELDS.command, code(v.command));
      if (v.intention) field(dl, FIELDS.reason, v.intention);
      if (v.paths.length) field(dl, FIELDS.paths, v.paths.join("\n"));
      if (v.urls.length) field(dl, FIELDS.urls, v.urls.join("\n"));
      if (v.warning) notes.push(warningLine(v.warning));
      if (v.writesFiles) notes.push(WRITES_FILES);
      if (v.sandboxBypass !== undefined) notes.push(sandboxBypass(v.sandboxBypass));
      if (ctx.pending?.choices?.includes("approve-for-session") && v.commands.length) notes.push(covers(v.commands.map(x => x.identifier)));
      break;
    case "write":
      field(dl, FIELDS.file, v.file);
      if (v.intention) field(dl, FIELDS.reason, v.intention);
      if (v.diff) field(dl, FIELDS.changes, diffView(v.diff, v.file));
      else if (v.newContents !== undefined) field(dl, FIELDS.contents, code(v.newContents));
      if (v.sandboxBypass !== undefined) notes.push(sandboxBypass(v.sandboxBypass));
      break;
    case "read": field(dl, FIELDS.path, v.path); if (v.intention) field(dl, FIELDS.reason, v.intention); break;
    case "url": field(dl, FIELDS.address, v.url); if (v.intention) field(dl, FIELDS.reason, v.intention); break;
    case "mcp":
      field(dl, FIELDS.server, v.server);
      field(dl, FIELDS.tool, v.title ? `${v.title} (${v.tool})` : v.tool);
      if (v.args !== undefined) field(dl, FIELDS.args, code(v.args));
      if (v.readOnly) notes.push(READ_ONLY);
      break;
    case "memory": field(dl, FIELDS.fact, v.fact); if (v.reason) field(dl, FIELDS.reason, v.reason); break;
    case "custom-tool": field(dl, FIELDS.tool, v.description ? `${v.tool}: ${v.description}` : v.tool); if (v.args !== undefined) field(dl, FIELDS.args, code(v.args)); break;
    case "hook": field(dl, FIELDS.tool, v.tool); if (v.message) field(dl, FIELDS.message, v.message); if (v.args !== undefined) field(dl, FIELDS.args, code(v.args)); break;
    case "other": field(dl, FIELDS.details, code(v.details)); break;
  }
  if (dl.childElementCount) card.append(dl);
  if (c.assisted) card.append(el("p", { className: "card-assisted", textContent: assistedLine(c.assisted) }));
  if (c.risk) card.append(el("p", { className: "card-risk", textContent: riskLine(c.risk) }));
  if (c.managed) notes.push(MANAGED);
  for (const n of notes) card.append(el("p", { className: "hint", textContent: n }));
  const choices = ctx.pending?.choices ?? [];
  const reason = el("textarea", { id: `${id}-reason`, rows: 2, maxLength: FEEDBACK_MAX, disabled: ctx.answering?.state === "sending", data: { focus: "reason" } });
  const problem = el("p", { className: "card-problem", attrs: { role: "alert" } });
  for (const choice of choices) {
    const b = btn(decisionLabel(choice, v.kind), choice);
    const go = () => {
      const payload = permissionAnswer(choices, choice, choice === "reject" ? reason.value : "");
      if (!payload) { problem.textContent = NOT_BUILT; return; }
      answer(payload);
    };
    if (grants(choice)) grant(b, go); else b.addEventListener("click", go);
    actions.append(b);
  }
  card.append(actions);
  if (choices.includes("reject")) {
    const fold = el("details", { className: "disclose card-reason" }, el("summary", { textContent: REASON_SUMMARY, data: { focus: "reason-fold" } }),
      el("label", { htmlFor: reason.id, textContent: REASON_LABEL }), reason);
    card.append(fold);
  }
  card.append(problem);
}

function drawElicitation(card: HTMLElement, item: RequestItem, ctx: CardContext, btn: Btn, answer: (p: unknown) => void, id: string): void {
  const e = elicitationCard(item.data);
  if (e.message) card.append(el("p", { className: "card-text", textContent: e.message }));
  const sending = ctx.answering?.state === "sending";
  if (e.mode === "url") {
    const url = e.url ?? "";
    const copy = btn(COPY_ADDRESS, "copy-url");
    copy.addEventListener("click", () => { void copyText(url); });
    // Opened by main in the person's browser, only where main would open it (an http or https address, no sign-in in it).
    const open = linkRefusal(url) ? null : btn(OPEN_ADDRESS, "open-url");
    open?.addEventListener("click", () => { void ctx.app.openLink(ctx.sessionId, url); });
    const done = btn(ELICITATION_URL_DONE, "url-done");
    done.addEventListener("click", () => answer({ action: "accept" }));
    const decline = btn(ELICITATION_DECLINE, "decline");
    decline.addEventListener("click", () => answer(EL_DECLINE));
    card.append(el("p", { className: "card-sub", textContent: ELICITATION_URL }), el("p", { className: "card-address", textContent: url }), el("div", { className: "card-actions" }, open, copy, done, decline));
    return;
  }
  const form = el("form", { className: "card-form elicit", attrs: { novalidate: "" } });
  const inputs = new Map<string, { f: FormField; read(): string | boolean | string[]; node: HTMLElement }>();
  for (const f of e.fields) {
    const fid = `${id}-f-${idPart(f.name)}`;
    const hint = f.description ? el("p", { className: "hint", id: `${fid}-hint`, textContent: f.description }) : null;
    const label = `${f.label}${f.required ? "" : " (optional)"}`;
    let node: HTMLElement;
    let read: () => string | boolean | string[];
    if (f.kind === "boolean") {
      const box = el("input", { type: "checkbox", id: fid, checked: f.default === true, disabled: sending });
      node = el("label", { className: "check" }, box, label);
      read = () => box.checked;
    } else if (f.kind === "choice") {
      const sel = el("select", { id: fid, disabled: sending }, ...(f.required ? [] : [el("option", { value: "", textContent: "" })]), ...f.options.map(o => el("option", { value: o.value, textContent: o.label })));
      if (typeof f.default === "string") sel.value = f.default;
      node = el("div", { className: "field" }, el("label", { htmlFor: fid, textContent: label }), sel);
      read = () => sel.value;
    } else if (f.kind === "choices") {
      const boxes = f.options.map(o => ({ o, box: el("input", { type: "checkbox", checked: Array.isArray(f.default) && f.default.includes(o.value), disabled: sending }) }));
      node = el("fieldset", { className: "field" }, el("legend", { textContent: label }), ...boxes.map(({ o, box }) => el("label", { className: "check" }, box, o.label)));
      read = () => boxes.filter(b => b.box.checked).map(b => b.o.value);
    } else {
      const type = f.kind === "number" || f.kind === "integer" ? "number" : f.format === "email" ? "email" : f.format === "uri" ? "url" : f.format === "date" ? "date" : "text";
      const input = el("input", { type, id: fid, disabled: sending, value: f.default !== undefined && !Array.isArray(f.default) ? String(f.default) : "" });
      if (f.required) input.setAttribute("aria-required", "true");
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.maxLength !== undefined) input.maxLength = f.maxLength;
      if (f.kind === "integer") input.step = "1";
      node = el("div", { className: "field" }, el("label", { htmlFor: fid, textContent: label }), input);
      read = () => input.value;
    }
    if (hint) { node.append(hint); node.querySelector("input, select")?.setAttribute("aria-describedby", hint.id); }
    inputs.set(f.name, { f, read, node });
    form.append(node);
  }
  const problems = el("div", { className: "card-problem", attrs: { role: "alert" } });
  const submit = el("button", { type: "submit", className: "btn small", textContent: ELICITATION_SUBMIT, disabled: sending || !ctx.pending, data: { focus: "submit" } });
  const decline = btn(ELICITATION_DECLINE, "decline");
  decline.addEventListener("click", () => answer(EL_DECLINE));
  const cancel = btn(ELICITATION_CANCEL, "cancel");
  cancel.addEventListener("click", () => answer(EL_CANCEL));
  form.append(problems, el("div", { className: "card-actions" }, submit, decline, cancel));
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    const values: Record<string, string | boolean | string[]> = {};
    for (const [name, i] of inputs) values[name] = i.read();
    const r = elicitationAccept(e, values);
    if (!r.ok) {
      problems.replaceChildren(...r.problems.map(p => el("p", { textContent: fieldProblem(inputs.get(p.name)?.f.label ?? p.name, p.problem) })));
      inputs.get(r.problems[0].name)?.node.querySelector<HTMLElement>("input, select")?.focus();
      return;
    }
    answer(r.answer);
  });
  card.append(form);
}
