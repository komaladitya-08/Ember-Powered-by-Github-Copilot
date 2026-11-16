/** Conservative terminal barrier for legacy native acquisition seams in this separate source experiment. */
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";

export class WindowsNodeSourceOwnershipError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsNodeSourceOwnershipError"; this.message = "Source-Node native ownership is unverified; retain its owners."; }
}
export class WindowsNodeSourceOwnership {
  #unsafe = false;
  get unsafe(): boolean { return this.#unsafe; }
  guard<T>(operation: () => T): T {
    if (this.#unsafe) throw new WindowsNodeSourceOwnershipError();
    try { return operation(); }
    catch { this.#unsafe = true; throw new WindowsNodeSourceOwnershipError(); }
  }
}
