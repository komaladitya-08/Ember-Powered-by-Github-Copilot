/**
 * The settings window's Computers and Commands sections (§8.3), drawn from computers-copy.ts's views. They show only
 * once the targets runtime answers (TARGETS_IPC through `window.emberTargets`): with no runtime the page is as it was.
 * Every change goes through the runtime (never updateSettings, which drops `targets` and `commands`): a switch that
 * needs a consent card stays as it is until the user agrees in the card and the settings say so. Rows are rebuilt only
 * when what they show changes, and keyboard focus stays where it was.
 */

import type { Status, StatusPlatform } from "../../shared/ipc";
import type { Settings } from "../../main/settings";
import type { TargetSummary, TargetsAct } from "../../shared/targets";
import {
  ACT_FAILED, ADD_INVALID, actMessage, addPending, addResult, commandsView, computersView, hostInput, type ComputerRow, type EmberTargetsApi, type Switch,
  type TargetsAdmin,
} from "./computers-copy";

declare global { interface Window { emberTargets?: EmberTargetsApi } }

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let summaries: TargetSummary[] | null = null;
let settings: Settings | null = null;
let admin: TargetsAdmin = { source: null, features: {} };
let os: StatusPlatform["os"] | undefined;

/** What the settings window knows of the organisation's rules for computers (main may send more: see TargetsAdmin). */
function adminOf(a: Status["admin"]): TargetsAdmin {
  const x = a as Status["admin"] & { commands?: TargetsAdmin["commands"]; sshHostsLimited?: boolean };
  return { source: a.error ? "error" : a.source, features: { wsl: a.features?.wsl, ssh: a.features?.ssh }, commands: x.commands, sshHostsLimited: x.sshHostsLimited };
}

const say = (id: string, text: string) => { $(id).textContent = text; };

async function act(a: TargetsAct, msg: string): Promise<void> {
  const api = window.emberTargets;
  if (!api) return;
  try {
    say(msg, actMessage(await api.act(a)) ?? "");
  } catch {
    say(msg, ACT_FAILED);
  }
}

/** An add under way: the form says so, and a second Connect waits for it. */
let adding = false;
/** Adds a host: the field keeps what was typed until the host is added (a typo stays to be fixed). */
async function add(dest: string, input: HTMLInputElement, button: HTMLElement): Promise<void> {
  const api = window.emberTargets;
  if (!api) return;
  adding = true;
  button.setAttribute("aria-disabled", "true");
  say("computers-msg", addPending(dest));
  try {
    const r = addResult(await api.act({ kind: "add", dest }));
    // Typed over meanwhile: what is there now is the user's.
    if (r.clear && hostInput(input.value) === dest) input.value = "";
    say("computers-msg", r.message);
  } catch {
    say("computers-msg", ACT_FAILED);
  } finally {
    adding = false;
    button.removeAttribute("aria-disabled");
  }
}

/** A switch the runtime decides: a change asks it, and the switch keeps showing the settings until they change. */
function asks(input: HTMLInputElement, onWant: (on: boolean) => void): void {
  input.addEventListener("change", () => {
    const want = input.checked;
    input.checked = !want;
    onWant(want);
  });
}

function setSwitch(input: HTMLInputElement, s: Switch): void {
  if (input.checked !== s.checked) input.checked = s.checked;
  input.disabled = s.disabled;
}

function switchRow(s: Switch, onWant: (on: boolean) => void, cls = "switch-row"): HTMLLabelElement {
  const row = el("label", cls);
  const input = el("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  if (s.ariaLabel) input.setAttribute("aria-label", s.ariaLabel);
  setSwitch(input, s);
  asks(input, onWant);
  row.append(input, el("span", "", s.label));
  return row;
}

function computerItem(r: ComputerRow): HTMLLIElement {
  const li = el("li", "target-row");
  const text = el("span", "target-text");
  // "build-01 · deploy@build-01.example.com" on one line, then the status.
  const name = el("span", "target-name");
  name.append(el("b", "", r.name));
  if (r.detail) name.append(el("span", "target-detail", ` · ${r.detail}`));
  text.append(name, el("span", "target-status", r.status));
  if (r.note) text.append(el("span", "target-note", r.note));
  li.append(text);
  if (r.actions.length) {
    const buttons = el("span", "target-actions");
    for (const a of r.actions) {
      const b = el("button", a.act.kind === "uninstall" || a.act.kind === "forget" ? "btn quiet small danger" : "btn quiet small", a.label);
      b.type = "button";
      if (a.ariaLabel) b.setAttribute("aria-label", a.ariaLabel);
      b.addEventListener("click", () => {
        if (a.confirm && !window.confirm(a.confirm)) return;
        void act(a.act, "computers-msg");
      });
      buttons.append(b);
    }
    li.append(buttons);
  }
  return li;
}

/** Replaces a list's children, keeping focus on the control at the same place when it had it. */
function replaceKeepingFocus(host: HTMLElement, items: HTMLElement[]): void {
  const focused = document.activeElement;
  const all = () => [...host.querySelectorAll<HTMLElement>("button, input")];
  const at = focused && host.contains(focused) ? all().indexOf(focused as HTMLElement) : -1;
  host.replaceChildren(...items);
  if (at >= 0) all()[Math.min(at, all().length - 1)]?.focus();
}

let computersKey = "";
let commandsKey = "";

/** Draws both sections from what is known now (nothing at all until the runtime has answered). */
function draw(): void {
  const shown = summaries !== null && settings !== null;
  for (const id of ["computers", "commands", "jump-computers", "jump-commands"]) $(id).hidden = !shown;
  if (!shown) return;
  const c = computersView({ os, summaries: summaries!, settings: settings!, admin });
  const rows = [c.local, ...(c.wsl?.rows ?? []), ...c.ssh.rows];
  const key = JSON.stringify(rows);
  if (key !== computersKey) {
    computersKey = key;
    replaceKeepingFocus($("computers-list"), rows.map(computerItem));
  }
  $("wsl-row").hidden = !c.wsl?.toggle;
  if (c.wsl?.toggle) setSwitch($("wsl-on") as HTMLInputElement, c.wsl.toggle);
  $("offer-row").hidden = !c.ssh.offer;
  if (c.ssh.offer) setSwitch($("offer-ssh") as HTMLInputElement, c.ssh.offer);
  $("host-form").hidden = !c.ssh.add;
  const managed = [...(c.wsl?.managed ? [c.wsl.managed] : []), ...c.ssh.managed];
  $("computers-managed").hidden = managed.length === 0;
  $("computers-managed").textContent = managed.join(" ");

  const v = commandsView({ summaries: summaries!, settings: settings!, admin });
  const ckey = JSON.stringify(v.rows);
  if (ckey !== commandsKey) {
    commandsKey = ckey;
    replaceKeepingFocus($("commands-list"), v.rows.flatMap(r => {
      const items: HTMLElement[] = [switchRow(r.run, on => void act({ kind: "commands", id: r.id, on }, "commands-msg"))];
      if (r.askEvery.shown) {
        items.push(switchRow(r.askEvery, on => void act({ kind: "commands", id: r.id, on: true, askEvery: on }, "commands-msg"), "switch-row sub-switch"));
      }
      if (r.managed) items.push(el("p", "row-note", r.managed));
      return items;
    }));
  }
  $("commands-managed").hidden = v.managed.length === 0;
  $("commands-managed").textContent = v.managed.join(" ");
}

/** The settings changed (or arrived). */
export function targetsSettings(s: Settings): void {
  settings = s;
  draw();
}

/** The status arrived: the OS, the organisation's rules and the settings. */
export function targetsStatus(st: Status): void {
  os = st.platform?.os;
  admin = adminOf(st.admin);
  settings = st.settings;
  draw();
}

/** Asks the runtime for the targets once, and follows its changes; without a runtime the sections stay hidden. */
export function startTargets(): void {
  const api = window.emberTargets;
  if (!api) return;
  api.onChanged(list => { summaries = Array.isArray(list) ? list : []; draw(); });
  void api.list().then(list => { summaries = Array.isArray(list) ? list : []; draw(); }, () => { /* no targets runtime answers: the sections stay hidden */ });
  asks($("wsl-on") as HTMLInputElement, on => void act({ kind: "wsl", on }, "computers-msg"));
  asks($("offer-ssh") as HTMLInputElement, on => void act({ kind: "offerSsh", on }, "computers-msg"));
  $("host-form").addEventListener("submit", e => {
    e.preventDefault();
    if (adding) return;
    const input = $("host-add") as HTMLInputElement;
    const dest = hostInput(input.value);
    if (!dest) { say("computers-msg", ADD_INVALID); input.focus(); return; }
    void add(dest, input, $("host-form").querySelector("button")!);
  });
  $("open-commands").addEventListener("click", () => void act({ kind: "openCommands" }, "commands-msg"));
}
