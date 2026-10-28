/**
 * Ember's hello once it starts (main.ts greet): what it says, its mood, its button and how long it stays. Pure, so it
 * is unit-tested; main gathers what it reads. Once Copilot is connected, a setup row that holds Ember back is named,
 * with Open settings while the settings window is closed (review #95).
 */

import type { BubbleState } from "../shared/overlay";
import { setupHello, type SetupRow } from "../shared/setup-attention";

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
  const thought = i.waiting ? "I can't reach GitHub yet: I'll connect as soon as the network is back."
    : !connected
      ? i.settingsOpen ? "I'm not connected to Copilot yet: connect me in the settings window." : `I'm not connected to Copilot yet. Open settings${i.settingsKey ? ` (${i.settingsKey})` : ""} to connect me.`
      : `${where}${gaps ? ` ${gaps}` : ""} ${i.keys}`;
  const settled = connected && !gaps;
  return {
    thought,
    mood: settled ? "idle" : i.waiting ? "error" : "attention",
    actions: settled || i.settingsOpen || i.waiting ? [] : [{ id: "ui:settings", label: "Open settings" }],
    holdMs: settled ? 7000 : 15000,
  };
}
