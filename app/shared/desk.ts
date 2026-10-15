/** Ember's desk mini-view: channels and types. */

export const DESK = {
  frame: "desk:frame",
  mode: "desk:mode",
  takeOver: "desk:take-over",
  handBack: "desk:hand-back",
  hide: "desk:hide",
  input: "desk:input",
  /** The view lost the keyboard or went hidden: let go of everything held on the desk. */
  release: "desk:release",
} as const;

export type DeskInput =
  | { type: "move"; x: number; y: number }
  /** `button` is MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward). */
  | { type: "button"; button: number; down: boolean; x: number; y: number }
  /** Directions only (-1, 0 or 1): one scroll step each. */
  | { type: "wheel"; dx?: number; dy: number; x: number; y: number }
  | { type: "key"; key: string; code: string; down: boolean };

export interface DeskViewApi {
  onFrame(fn: (f: { url: string; width: number; height: number; title: string }) => void): void;
  onMode(fn: (m: { control: boolean }) => void): void;
  takeOver(): void;
  handBack(): void;
  hide(): void;
  input(e: DeskInput): void;
  release(): void;
}
