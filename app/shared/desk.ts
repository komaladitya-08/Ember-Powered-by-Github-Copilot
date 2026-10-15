/** Ember's desk mini-view: channels and types. */

export const DESK = {
  frame: "desk:frame",
  mode: "desk:mode",
  takeOver: "desk:take-over",
  handBack: "desk:hand-back",
  hide: "desk:hide",
  input: "desk:input",
} as const;

export type DeskInput =
  | { type: "move"; x: number; y: number }
  | { type: "button"; button: number; down: boolean; x: number; y: number }
  | { type: "wheel"; dy: number; x: number; y: number }
  | { type: "key"; key: string; code: string; down: boolean };

export interface DeskViewApi {
  onFrame(fn: (f: { url: string; width: number; height: number; title: string }) => void): void;
  onMode(fn: (m: { control: boolean }) => void): void;
  takeOver(): void;
  handBack(): void;
  hide(): void;
  input(e: DeskInput): void;
}
