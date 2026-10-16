/** Messages between the main process and the overlay / handle renderers. */

import type { Emotion, Gesture } from "@ember/characters";
import type { BubbleMood } from "@ember/bubble";
import type { Settings } from "../main/settings";
import type { MicState } from "./voice";

export const OVERLAY = {
  init: "overlay:init",
  frame: "overlay:frame",
  settings: "overlay:settings",
  state: "overlay:state",
  interactive: "overlay:interactive",
  bubbleAction: "overlay:bubble-action",
  handleMenu: "handle:menu",
  /** The fallback card's content height, so the card fits what it shows. */
  handleFit: "handle:fit",
  /** Where the task cards are (global DIP), so Ember keeps off their buttons. */
  cards: "overlay:cards",
} as const;

export interface Rect { x: number; y: number; width: number; height: number }

export interface OverlayInit {
  displayId: number;
  /** This overlay's display bounds in global DIP. */
  bounds: Rect;
  settings: Settings;
  /** True when this window is the small fallback buddy (no compositor). */
  fallback: boolean;
  /** Ember's handle in global DIP when it is on this display (the bubble keeps off it), else null. */
  handle?: Rect | null;
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
  /** The task whose bubble this is (its work, its question): the corner card shows that task's row and Stop with it. */
  task?: string;
}

export interface TaskCard {
  id: string;
  title: string;
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  detail: string;
  /** Buttons on the card ("Stop" while it works, "Close" on a failure); clicks come back as bubble actions with these ids. */
  actions?: { id: string; label: string }[];
}

export interface EmberState {
  emotion: Emotion;
  talking: boolean;
  bubble: BubbleState;
  tasks: TaskCard[];
  status: string | null;
  /** The control Ember is working on (global DIP): Ember flies beside it and it glows. */
  focus?: Rect | null;
  /** A body gesture to play (pointing at the control, typing, thumbs up…). */
  gesture?: Gesture | null;
  /** Microphone: off, waiting for "Hey Ember", or hearing a request. */
  mic?: MicState;
  /** Places the bubble keeps off (global DIP), e.g. the settings window while the user works in it. */
  avoid?: Rect[];
  /** What the handle says when nothing else is going on: "Ready", or why Ember can't answer yet. */
  idle?: string;
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
  /** The task cards' area in global DIP (null: no cards on this display). */
  setCards(rect: Rect | null): void;
}

export interface HandleApi {
  onSettings(fn: (s: Settings) => void): void;
  onState(fn: (s: EmberState) => void): void;
  onInit(fn: (i: OverlayInit) => void): void;
  openMenu(): void;
  bubbleAction(id: string): void;
  /** Fallback card only: the height its content needs. */
  fit(height: number): void;
}
