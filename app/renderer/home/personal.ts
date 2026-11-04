/**
 * Settings › Voice's personalisation rows (Keep learning my voice, Reset to my enrolment, Learn my words with the words
 * learnt, Suggest what I might say next) and the conversation's “That's not what I said” (app/main/personal/). The
 * words are copy.ts's; main checks every argument again.
 */

import type { VoiceStatus, VoiceWord } from "../../shared/ipc";
import type { Settings, SettingsPatch } from "../../main/settings";
import { PERSONAL_TEXT, WORD_DELETE_FAILED, WORDS_DELETE_FAILED, forgetWordLabel, personalView, teachOutcomeText, wordRowText } from "./copy";
import { KeyedRows } from "./keyed-rows";

const $ = (id: string) => document.getElementById(id)!;

type Save = (patch: SettingsPatch) => Promise<unknown>;

let current: Settings | null = null;
let save: Save = async () => undefined;
let wordRows: KeyedRows<VoiceWord> | null = null;

/** The voice settings as Home last had them, with this change. */
const voiceWith = (change: Partial<Settings["voice"]>): Settings["voice"] => ({
  consent: false, speakerRejection: true, muted: false, match: false, natural: false, naturalModel: "kokoro", learn: true, words: true, suggest: true, conversation: true,
  ...(current?.voice ?? {}), ...change,
});

function renderWords(list: VoiceWord[]): void {
  wordRows ??= new KeyedRows<VoiceWord>($("words-list"), {
    key: word => JSON.stringify([word.heard, word.meant, word.at]),
    empty: () => PERSONAL_TEXT.wordsEmpty,
    fallback: () => $("words-on"),
    create: read => {
      const word = read();
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("span"), { textContent: wordRowText(word) }));
      const button = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Forget" });
      button.setAttribute("aria-label", forgetWordLabel(word));
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-disabled") === "true") return;
        button.setAttribute("aria-disabled", "true");
        $("words-note").textContent = "";
        void window.ember.forgetVoiceWord(read()).then(renderWords, () => {
          button.removeAttribute("aria-disabled");
          $("words-note").textContent = WORD_DELETE_FAILED;
        });
      });
      li.append(button);
      return li;
    },
  });
  wordRows.render(list);
  const all = $("words-forget-all");
  const wasFocused = document.activeElement === all;
  all.hidden = !list.length;
  if (wasFocused && all.hidden) $("words-on").focus();
}

/** The rows as the settings say (the learning row only once Voice Match knows the voice). */
export function personalSettings(s: Settings): void {
  current = s;
  ($("match-learn") as HTMLInputElement).checked = s.voice.learn;
  ($("words-on") as HTMLInputElement).checked = s.voice.words;
  ($("suggest-on") as HTMLInputElement).checked = s.voice.suggest;
  ($("conversation-on") as HTMLInputElement).checked = s.voice.conversation;
}

/**
 * Voice Match's state: the learning row shows once it knows the voice; Reset to my enrolment only while it is on and its
 * model is in, and it learnt something (personalView).
 */
export function personalMatch(v: VoiceStatus | null, matchHidden: boolean): void {
  const view = personalView(v?.match, matchHidden);
  $("match-learn-row").hidden = !view.learnRow;
  $("match-learnt").textContent = view.learnt;
  ($("match-learnt") as HTMLElement).hidden = !view.learnt;
  $("match-reset").hidden = !view.reset;
}

/**
 * The conversation's requests Ember heard (not typed) get “That's not what I said”: the user retypes the words in place,
 * and Ember keeps the correction (Learn my words). `rows`: the conversation's list.
 */
export function markHeard(rows: HTMLElement): void {
  void window.ember.voiceHeard().then(heard => {
    const ids = new Set(heard);
    // By the row's own id (TranscriptEntry.heardId), never its words: the same words typed later aren't "heard".
    for (const li of rows.querySelectorAll<HTMLLIElement>("li.you[data-heard-id]")) {
      const id = Number(li.dataset.heardId);
      if (!ids.has(id) || li.querySelector(".not-said")) continue;
      const text = li.querySelector("p")?.textContent ?? "";
      const btn = Object.assign(document.createElement("button"), { type: "button", className: "link not-said", textContent: PERSONAL_TEXT.notSaid });
      btn.addEventListener("click", () => teachForm(li, id, text, btn));
      li.append(btn);
    }
  }, () => { /* nothing heard to mark */ });
}

let formN = 0;
function teachForm(li: HTMLLIElement, heardId: number, shown: string, opener: HTMLButtonElement): void {
  if (li.querySelector("form.teach")) return;
  opener.hidden = true;
  const id = `teach-${++formN}`;
  const form = Object.assign(document.createElement("form"), { className: "teach add-row" });
  const label = Object.assign(document.createElement("label"), { className: "sr", htmlFor: id, textContent: PERSONAL_TEXT.teachLabel });
  const input = Object.assign(document.createElement("input"), { type: "text", id, value: shown, maxLength: 2000, spellcheck: false, autocomplete: "off" });
  const ok = Object.assign(document.createElement("button"), { type: "submit", className: "btn small", textContent: PERSONAL_TEXT.teachSave });
  const no = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: PERSONAL_TEXT.teachCancel });
  const note = Object.assign(document.createElement("p"), { className: "teach-note" });
  note.setAttribute("role", "status");
  const close = () => { form.remove(); opener.hidden = false; opener.focus(); };
  no.addEventListener("click", close);
  form.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); } });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const meant = input.value.trim();
    if (!meant || ok.getAttribute("aria-disabled") === "true") return;
    ok.setAttribute("aria-disabled", "true");
    input.readOnly = true;
    note.textContent = "Saving…";
    void window.ember.teachWords(heardId, meant).then(r => {
      if (!form.isConnected) return;
      note.textContent = teachOutcomeText(r.outcome, r.word?.meant ?? meant);
      if (r.outcome === "learnt") {
        const focused = form.contains(document.activeElement);
        form.replaceChildren(note);
        opener.remove();
        if (focused) { note.tabIndex = -1; note.focus({ preventScroll: true }); }
      } else { input.readOnly = false; ok.removeAttribute("aria-disabled"); }
    }, () => {
      if (!form.isConnected) return;
      note.textContent = "Couldn't save the correction. Try again.";
      input.readOnly = false;
      ok.removeAttribute("aria-disabled");
    });
  });
  form.append(label, input, ok, no, note);
  li.append(form);
  input.focus();
  input.select();
}

/** Wires the rows (once). `saveSettings`: Home's own save. */
export function startPersonal(saveSettings: Save): void {
  save = saveSettings;
  $("match-learn-label").textContent = PERSONAL_TEXT.learn;
  $("match-learn-hint").textContent = PERSONAL_TEXT.learnHint;
  $("match-reset").textContent = PERSONAL_TEXT.reset;
  $("words-label").textContent = PERSONAL_TEXT.words;
  $("words-hint").textContent = PERSONAL_TEXT.wordsHint;
  $("words-h").textContent = PERSONAL_TEXT.wordsHeading;
  $("words-forget-all").textContent = PERSONAL_TEXT.forgetAllWords;
  $("conversation-label").textContent = PERSONAL_TEXT.conversation;
  $("conversation-hint").textContent = PERSONAL_TEXT.conversationHint;
  $("suggest-label").textContent = PERSONAL_TEXT.suggest;
  $("suggest-hint").textContent = PERSONAL_TEXT.suggestHint;
  $("match-learn").addEventListener("change", e => { void save({ voice: voiceWith({ learn: (e.target as HTMLInputElement).checked }) }); });
  $("words-on").addEventListener("change", e => { void save({ voice: voiceWith({ words: (e.target as HTMLInputElement).checked }) }); });
  $("conversation-on").addEventListener("change", e => { void save({ voice: voiceWith({ conversation: (e.target as HTMLInputElement).checked }) }); });
  $("suggest-on").addEventListener("change", e => { void save({ voice: voiceWith({ suggest: (e.target as HTMLInputElement).checked }) }); });
  $("match-reset").addEventListener("click", () => {
    void window.ember.resetVoice().then(() => { $("voice-live").textContent = PERSONAL_TEXT.resetDone; ($("match-learn") as HTMLElement).focus(); });
  });
  $("words-forget-all").addEventListener("click", () => {
    const button = $("words-forget-all");
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    $("words-note").textContent = "";
    void window.ember.forgetVoiceWords().then(() => renderWords([]), () => { $("words-note").textContent = WORDS_DELETE_FAILED; }).finally(() => button.removeAttribute("aria-disabled"));
  });
  void window.ember.voiceWords().then(renderWords, () => renderWords([]));
  window.ember.onVoiceWords(renderWords);
}
