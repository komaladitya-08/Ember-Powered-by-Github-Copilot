/** Messages between the main process and the overlay / handle renderers. */

import type { Emotion } from "@ember/characters";
import type { BubbleMood } from "@ember/bubble";
import type { Settings } from "../main/settings";

export const OVERLAY = {
  init: "overlay:init",
  frame: "overlay:frame",
  settings: "overlay:settings",
  state: "overlay:state",
  interactive: "overlay:interactive",
  bubbleAction: "overlay:bubble-action",
  handleMenu: "handle:menu",
} as const;

export interface Rect { x: number; y: number; width: number; height: number }

export interface OverlayInit {
  displayId: number;
  /** This overlay's display bounds in global DIP. */
  bounds: Rect;
  settings: Settings;
  /** True when this window is the small fallback buddy (no compositor). */
  fallback: boolean;
}

export interface OverlayFrame {
  /** Ember's centre in global DIP. */
  ember: { x: number; y: number };
  cursor: { x: number; y: number };
  visible: boolean;
}

export interface BubbleState {
  visible: boolean;
  mood: BubbleMood;
  title: string;
  thought: string;
  step: string | null;
  streaming: boolean;
  actions: { id: string; label: string; primary?: boolean }[];
}

export interface TaskCard {
  id: string;
  title: string;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  detail: string;
}

export interface EmberState {
  emotion: Emotion;
  talking: boolean;
  bubble: BubbleState;
  tasks: TaskCard[];
  status: string | null;
  /** The control Ember is working on (global DIP): Ember flies beside it and it glows. */
  focus?: Rect | null;
}

export const IDLE_BUBBLE: BubbleState = {
  visible: false, mood: "idle", title: "", thought: "", step: null, streaming: false, actions: [],
};

export interface OverlayApi {
  onInit(fn: (i: OverlayInit) => void): void;
  onFrame(fn: (f: OverlayFrame) => void): void;
  onSettings(fn: (s: Settings) => void): void;
  onState(fn: (s: EmberState) => void): void;
  setInteractive(rects: Rect[]): void;
  bubbleAction(id: string): void;
}

export interface HandleApi {
  onSettings(fn: (s: Settings) => void): void;
  onState(fn: (s: EmberState) => void): void;
  onInit(fn: (i: OverlayInit) => void): void;
  openMenu(): void;
  bubbleAction(id: string): void;
}
