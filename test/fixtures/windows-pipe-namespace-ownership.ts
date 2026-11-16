/** Terminal guard for legacy native acquisition seams in this independent prerequisite. */
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
export class WindowsPipeNamespaceOwnershipError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsPipeNamespaceOwnershipError"; this.message = "Pipe prerequisite ownership is unverified; retain every owner."; }
}
export class WindowsPipeNamespaceOwnership {
  #unsafe = false;
  get unsafe(): boolean { return this.#unsafe; }
  guard<T>(operation: () => T): T {
    if (this.#unsafe) throw new WindowsPipeNamespaceOwnershipError();
    try { return operation(); }
    catch { this.#unsafe = true; throw new WindowsPipeNamespaceOwnershipError(); }
  }
}
