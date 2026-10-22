/**
 * What the remote agent's bundle has in place of app/main/perception/capture.ts (§5.2.2; owned by package SB): the
 * build aliases capture.ts to this file, so sharp's loader never enters dist/remote/ember-remote.cjs. Every function
 * throws: the agent gives Perception its own `capture` (PerceptionOptions.capture), which encodes PNG without sharp.
 * STUB from Step 0a.
 */

import type { Capture, CaptureOptions } from "../main/perception/capture";
import type { Bounds } from "../main/perception/sidecar";
import type { PerceptionWindows } from "../main/platform/types";

export type { Capture, CaptureOptions };

const UNAVAILABLE = "screenshots on a remote go through the agent's own capture (PerceptionOptions.capture)";

export function bgraToRgba(_bgra: Buffer): Buffer {
  throw new Error(UNAVAILABLE);
}

export function maskRect(_rgba: Buffer, _width: number, _height: number, _r: Bounds): void {
  throw new Error(UNAVAILABLE);
}

export async function captureRect(_x11: Pick<PerceptionWindows, "capture">, _rect: Bounds, _opts: CaptureOptions = {}): Promise<Capture | null> {
  throw new Error(UNAVAILABLE);
}

export function imageToScreen(_c: Capture, _p: { x: number; y: number }): { x: number; y: number } {
  throw new Error(UNAVAILABLE);
}
