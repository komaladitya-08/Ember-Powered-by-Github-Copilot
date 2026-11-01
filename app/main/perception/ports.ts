/**
 * The ports workers and the host use to see and act on a screen, whichever screen it is: this computer's Perception
 * and accessibility sidecar, the desk's, WSL's routed reader, or a remote's over SSH (§2.6, §5.5). Types only, so
 * every implementation is checked against exactly what its users call. Plain Node.
 */

import type { Perception } from "./index";
import type { AtspiSidecar } from "./sidecar";
import type { ActionKind } from "../policy/policy";

/**
 * What workers and the host use of a screen's perception: the local Perception, the desk's, or a remote's. Only this
 * screen's says why its system-dialog check is on when that isn't a dialog (systemDialogReason, optional).
 */
export type PerceptionPort = Pick<Perception, "focused" | "read" | "atPoint" | "quickContext" | "describe" | "perceive" | "systemDialogOpen" | "windows">
  & Partial<Pick<Perception, "systemDialogReason">>;
/** What Perception uses of its reader (AtspiSidecar, or WSL's routed one). */
export type PerceptionSidecar = Pick<AtspiSidecar, "listWindows" | "readWindow" | "atPoint" | "secretFields" | "markSecret" | "shellOverlays" | "scaleElements" | "readElement">;
/** What a worker uses of the reader, plus the remote's step stamp. */
export type SidecarPort = Pick<AtspiSidecar, "readElement" | "canDo" | "doAction" | "setText" | "setValue" | "selectOption" | "listOptions" | "scaleOf" | "stop">;
/** What gate 1 decided about a step, sent with it to a remote (a record for gate 2, never a credential). */
export interface ActStamp {
  taskId: string;
  kind: ActionKind;
  app: string;
  window: string;
  element: { role: string; name: string } | null;
  /** sha256Hex of the value typed, chosen or set (never the value). */
  valueSha256?: string;
  verdict: "allow" | "confirm";
  /** The user's yes, when one was given (its age travels in ageMs). */
  approval: { given: true } | null;
  /**
   * Milliseconds since the decision (or since the user's yes, when asked), measured on the PC's monotonic clock when
   * the step is sent; gate 2 refuses ≥ 10 000. No absolute time crosses machines (critique integration-6).
   */
  ageMs: number;
}
