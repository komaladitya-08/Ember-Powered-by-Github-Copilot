/**
 * Ember's hello once it starts (main.ts greet): what it says, its mood, its button and how long it stays. Pure, so it
 * is unit-tested; main gathers what it reads. Once Copilot is connected, a setup row that holds Ember back is named,
 * with Open settings while the settings window is closed (review #95).
 */

import type { BubbleState } from "../shared/overlay";
import { onThisComputer } from "../shared/provider";
import { setupHello, type SetupRow } from "../shared/setup-attention";
import type { HeldShortcuts, ShortcutTable } from "../shared/shortcuts";

/**
 * How to ask Ember and stop it, by the chords it holds (`held`: default or fallback, D-45b), saying which defaults
 * another app has; for one it holds neither chord of, its handle, and settings' Ask Ember… or Stop everything (by the
 * settings chord it holds, else by opening Ember again: review #45), each named on its own (final review U2). `sc`: this
 * OS's defaults.
 */
export function keysLine(held: HeldShortcuts, sc: ShortcutTable): string {
  const { ask, stop, settings } = held;
  // Settings opens from the keyboard at the one Ember holds no chord for, or at both (environment.ts keyboardRoute).
  const opens = settings ? `press ${settings.label}: settings opens` : "open Ember again: its settings open";
  const said = ask && stop ? `Press ${ask.label} to ask me anything; ${stop.label} stops me.`
    : ask ? `Press ${ask.label} to ask me anything. To stop me, click my handle in the corner, or ${opens} at Stop everything.`
      : stop ? `${stop.label} stops me. To ask me something, click my handle in the corner, or ${opens} at Ask Ember…`
        : `Click my handle in the corner to ask me something or to stop me, or ${opens} at Ask Ember… and Stop everything.`;
  // The defaults another app has, where Ember names its fallback instead.
  const others = (["ask", "stop"] as const).filter(id => held[id] && held[id] !== sc[id]).map(id => sc[id].label);
  return `${said}${others.length ? ` Another app has ${others.join(" and ")}.` : ""}`;
}

export interface HelloInputs {
  /** The agent's phase (undefined before it exists). */
  phase: string | undefined;
  /** Offline at start: a retry waits for the network, and Ember connects by itself. */
  waiting: boolean;
  /** Ember can stay beside the cursor (false: this session can't show it there). */
  overlay: boolean;
  /** How to ask Ember and stop it: its shortcuts, or its handle when another app holds them. */
  keys: string;
  /** The settings shortcut as this OS writes it, while Ember holds it (null: another app does). */
  settingsKey: string | null;
  /** The settings window is open. */
  settingsOpen: boolean;
  /** This OS's setup rows now. */
  rows: readonly SetupRow[];
  /**
   * Why Ember can't work here at all (a desktop session it can't use, the organisation's lockdown), in Ember's voice:
   * said in place of everything else, since nothing else at start-up says it. null or absent: none.
   */
  cannotWork?: string | null;
  /**
   * The model service the connection uses when it isn't Copilot (the agent's status): the hello names it, by its host,
   * and never GitHub, Copilot or the network (first-run-r1).
   */
  service?: { kind: string; host: string };
  /**
   * Signed out, the host whose card the user's own provider waits for (main's providerWaitingHost): agreeing to it is
   * the way on, not a GitHub sign-in, so the hello names it and never Copilot (integrations-v4-3). null or absent: none.
   */
  providerWaiting?: string | null;
}

/** A model service that isn't Copilot, as the hello names it. */
function serviceName(s: { kind: string; host: string }): string {
  return s.kind === "user" ? `your model provider (${s.host})` : s.kind === "admin" ? `your organisation's model service (${s.host})` : `the model service (${s.host})`;
}

/** Not connected yet: what the hello says, for Copilot or the service in use. */
function notConnected(i: HelloInputs): string {
  if (i.phase === "signed-out" && i.providerWaiting) {
    // Signed out with the card waiting: agreeing is the way on, not a GitHub sign-in (integrations-v4-3).
    const ask = `I need your OK for ${i.providerWaiting} first.`;
    return i.settingsOpen ? `${ask} Agree to use it in Models & connections in the settings window, or turn off “Use my own model provider”.`
      : `${ask} Open settings${i.settingsKey ? ` (${i.settingsKey})` : ""} and agree to use it in Models & connections, or turn off “Use my own model provider”.`;
  }
  if (i.service) {
    const it = serviceName(i.service);
    return i.settingsOpen ? `I can't connect to ${it} yet: Models & connections in the settings window says why.` : `I can't connect to ${it} yet. Open settings${i.settingsKey ? ` (${i.settingsKey})` : ""} to see why.`;
  }
  return i.settingsOpen ? "I'm not connected to Copilot yet: connect me in the settings window." : `I'm not connected to Copilot yet. Open settings${i.settingsKey ? ` (${i.settingsKey})` : ""} to connect me.`;
}

/** A retry waits: for the network with Copilot; for the service in use, by name, and a model server here to be started. */
function waitingFor(service: HelloInputs["service"]): string {
  if (!service) return "I can't reach GitHub yet: I'll connect as soon as the network is back.";
  if (service.kind === "user" && onThisComputer(service.host)) return `I can't reach the model server on this computer (${service.host}) yet. Start it, and I'll connect in a moment.`;
  return `I can't reach ${serviceName(service)} yet. I'll connect as soon as it answers.`;
}

export interface Hello {
  thought: string;
  mood: BubbleState["mood"];
  actions: BubbleState["actions"];
  /** How long it stays (ms): longer when it asks the user to do something. */
  holdMs: number;
}

export function hello(i: HelloInputs): Hello {
  if (i.cannotWork) {
    return { thought: i.cannotWork, mood: "attention", actions: i.settingsOpen ? [] : [{ id: "ui:settings", label: "Open settings" }], holdMs: 15000 };
  }
  const connected = i.phase !== "signed-out" && i.phase !== "error";
  const gaps = connected ? setupHello(i.rows, i.settingsOpen) : null;
  const where = i.overlay ? "I'll stay by your cursor." : "This session can't show me beside your cursor, so I'll wait here.";
  const thought = i.waiting ? waitingFor(i.service) : !connected ? notConnected(i) : `${where}${gaps ? ` ${gaps}` : ""} ${i.keys}`;
  const settled = connected && !gaps;
  return {
    thought,
    mood: settled ? "idle" : i.waiting ? "error" : "attention",
    actions: settled || i.settingsOpen || i.waiting ? [] : [{ id: "ui:settings", label: "Open settings" }],
    holdMs: settled ? 7000 : 15000,
  };
}
