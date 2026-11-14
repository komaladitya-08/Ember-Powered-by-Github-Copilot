/**
 * What Settings › Memory is given (`MemoryView`, app/shared/ipc.ts): the saved facts, whether the account's memory is
 * open and why not, and what is wrong with the file.
 *
 * The rows are the account's own memory on its own computer, so they are listed whenever that account is verified and
 * the user has agreed to Ember at all: also while memory is switched off, and while the organisation has turned it off
 * (memory-r9-3). The policy stops Ember keeping and using memory; it never hid what was saved before from the person
 * it is about, who must be able to see it and forget it. Memory that isn't verified as this account's stays hidden,
 * whatever the policy. Plain Node: no Electron.
 */

import type { MemoryView } from "../../shared/ipc";
import type { MemoryOwner } from "./owner";
import type { MemoryService } from "./service";

export function memoryViewOf(o: {
  /** The user agreed to Ember (`hasConsent`): nothing is read before. */
  consented: boolean;
  owner: Pick<MemoryOwner, "ready" | "state" | "reason" | "mayEraseOnSignOut">;
  epoch: number;
  memory: Pick<MemoryService, "review" | "trouble">;
}): MemoryView {
  return {
    // What holds now, then what is no longer true: it is kept and can reach the model, so it is shown too (memory-c7-2).
    rows: o.consented && o.owner.ready ? o.memory.review() : [],
    ownership: o.owner.state, epoch: o.epoch, reason: o.owner.reason, erasesOnSignOut: o.owner.mayEraseOnSignOut,
    // After the rows, which read memory.json first: what was wrong with it, only for the account's open memory (memory-r2).
    trouble: o.owner.ready ? o.memory.trouble : null,
  };
}
