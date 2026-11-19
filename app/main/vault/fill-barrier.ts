import type { VaultPart } from "../../shared/vault";

/** The host owns the start hold and returns false only after releasing a failed hold. */
export interface VaultFillBarrier {
  prepareForVaultFill(): Promise<boolean>;
  finishVaultFill(): void;
}

/** Stop native coding before noting the value, and keep starts held until all redaction gates are in place. */
export async function recordVaultFill(part: VaultPart, value: string, currentHost: () => VaultFillBarrier | null,
  note: (part: VaultPart, value: string) => void, stopExtensions: () => void): Promise<void> {
  const host = currentHost();
  if (!host || !await host.prepareForVaultFill()) throw new Error("Ember couldn't stop coding before the vault fill.");
  try {
    if (host !== currentHost()) throw new Error("Ember's session changed before the vault fill.");
    note(part, value);
    stopExtensions();
  } finally {
    host.finishVaultFill();
  }
}
