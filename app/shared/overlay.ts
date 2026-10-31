/** Messages between the main process and the overlay / handle renderers. */

import type { Emotion, Gesture } from "@ember/characters";
import type { BubbleMood } from "@ember/bubble";
import type { Settings } from "../main/settings";
import type { MicState } from "./voice";
import type { TargetSummary } from "./targets";

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
  /** The desktop's reduce-motion preference changed (the overlay's page follows it live), for Ember's follow spring. */
  motion: "overlay:motion",
} as const;

export interface Rect { x: number; y: number; width: number; height: number }

export interface OverlayInit {
  displayId: number;
  /** This overlay's display bounds in global DIP. */
  bounds: Rect;
  /** Its display's work area in global DIP (without the taskbar, Dock or top bar), when main says. */
  workArea?: Rect;
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
  /** The display Ember is on (the one nearest its centre): only its overlay shows the bubble. */
  on?: number;
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
  /** "Read all" was pressed: the whole answer shows, scrolling if it must. */
  expanded?: boolean;
  /** Where the task this bubble belongs to acts, when not on this computer ("on build-01", "in Ubuntu (WSL)"). */
  where?: string;
  /** A question's whole text, which its sentence shows only in part (a long typed text): shown in a block that scrolls. */
  whole?: WholeText;
}

/**
 * The whole of what a question shows only in part (Question.detail: a typed text cut to its two ends), shown in a block
 * that scrolls under its sentence (review #116). Its Allow works once all of it has been in view: the page that showed
 * it says so with wholeSeenAction(n), and main sends it back with `seen` set.
 */
export interface WholeText {
  /** The question's number (its buttons' "q<n>:" ids). */
  n: number;
  text: string;
  /** All of it has been in view (main was told): Allow works. */
  seen: boolean;
  /** How many times the approve key asked for more before then: each time, the block scrolls on by a page. */
  page: number;
}

/** What a page sends (as a bubble action) once all of question `n`'s whole text has been in view. */
export const wholeSeenAction = (n: number): string => `ui:seen:${n}`;
/** The question whose whole text a bubble action says has been in view (wholeSeenAction), or null for any other action. */
export function wholeSeenOf(id: string): number | null {
  const m = /^ui:seen:([1-9]\d{0,8})$/.exec(id);
  return m ? Number(m[1]) : null;
}
/** A button that works only once the question's whole text has been in view: every answer but Not now ("q<n>:deny"). */
export const waitsForWhole = (actionId: string, whole: WholeText | undefined): boolean =>
  !!whole && !whole.seen && actionId.startsWith(`q${whole.n}:`) && actionId !== `q${whole.n}:deny`;

export interface TaskCard {
  id: string;
  title: string;
  /** "queued": in line behind the tasks running now (nothing is needed from the user); "waiting": waits for the user. */
  status: "running" | "queued" | "waiting" | "done" | "failed" | "stopped";
  detail: string;
  /** Buttons on the card ("Stop" while it works, "Close" on a failure); clicks come back as bubble actions with these ids. */
  actions?: { id: string; label: string }[];
  /** Where the task acts, when not on this computer. */
  where?: string;
}

/** A running task's card detail from the moment its Stop is pressed until it has wound down. */
export const TASK_STOPPING = "Stopping…";

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
  /** The picker's target, for the handle's badge (absent or "local": no badge). */
  target?: TargetSummary;
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
  /** The desktop's reduce-motion preference changed while Ember runs (true: less motion). */
  setReducedMotion?(on: boolean): void;
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
