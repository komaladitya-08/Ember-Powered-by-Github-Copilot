/** Publication transaction for the fixed manual witness. Native proofs are performed by the supplied trusted owners. */
import type { WindowsLpacChildAccessReadPin } from "./windows-lpac-child-access-native";
import type { WindowsLpacChildAccessAggregate } from "./windows-lpac-child-access-parser";

const phases = new WeakMap<object, number>();
export class ChildAccessReadoutError extends Error {
  constructor(phase: number) { super("The fixed child-access witness did not complete its stopped publication transaction."); this.name = "ChildAccessReadoutError";
    phases.set(this, Number.isInteger(phase) && phase >= 1 && phase <= 11 ? phase : 0); }
}
export const childAccessReadoutPhase = (error: unknown): number => error !== null && typeof error === "object" ? phases.get(error) ?? 0 : 0;
/** Forget an ownership reference only after its exact synchronous close positively succeeds. */
export function closeChildAccessOwnedStack<T>(owners: T[], close: (owner: T) => void): void {
  while (owners.length) { const owner = owners[owners.length - 1]; close(owner); owners.pop(); }
}
export interface ChildAccessReadout {
  requireRootStopped(): void;
  requireCollectorStopped(): void;
  pinPml(): WindowsLpacChildAccessReadPin;
  exportPml(pin: WindowsLpacChildAccessReadPin): void;
  pinCsv(): WindowsLpacChildAccessReadPin;
  stopWatchdog(): Promise<void>;
  decode(bytes: Buffer): WindowsLpacChildAccessAggregate;
  closeOwners(): Promise<void>;
  removeKnownScratch(): void;
  retain(owners: unknown): void;
}
/** No return value escapes until all exact owners/pins close and known owned scratch is removed. */
export async function completeChildAccessReadout(input: ChildAccessReadout): Promise<WindowsLpacChildAccessAggregate> {
  let phase = 1, pml: WindowsLpacChildAccessReadPin | undefined, csv: WindowsLpacChildAccessReadPin | undefined, bytes: Buffer | undefined;
  try {
    input.requireRootStopped(); phase = 2; input.requireCollectorStopped();
    phase = 3; pml = input.pinPml(); pml.unchanged();
    phase = 4; input.exportPml(pml); pml.unchanged();
    phase = 5; csv = input.pinCsv(); csv.unchanged();
    phase = 6; await input.stopWatchdog();
    phase = 7; input.requireRootStopped(); input.requireCollectorStopped(); pml.unchanged(); csv.unchanged();
    bytes = csv.read();
    phase = 8; const result = input.decode(bytes); bytes.fill(0); bytes = undefined;
    pml.unchanged(); csv.unchanged();
    phase = 9; csv.close(); csv = undefined; pml.close(); pml = undefined;
    phase = 10; await input.closeOwners();
    phase = 11; input.removeKnownScratch();
    return result;
  } catch {
    bytes?.fill(0); input.retain({ pml, csv });
    throw new ChildAccessReadoutError(phase); // No captured data, native Error/cause or path leaves the transaction.
  }
}
