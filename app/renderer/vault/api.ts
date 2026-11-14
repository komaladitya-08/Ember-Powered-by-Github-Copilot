/**
 * The Secure Form's bridge (app/preload/vault.ts exposes exactly this as `window.emberVaultForm`): the form's three
 * channels and nothing else. Types only.
 */

import type { VaultFormView, VaultSubmitResult, VaultValues } from "../../shared/vault";

export interface VaultFormApi {
  /** The form to show, or null when main has none for this window. */
  form(): Promise<VaultFormView | null>;
  /** Save: what was typed, once. The answer says only whether it was kept, and which part wasn't. */
  submit(id: string, values: VaultValues): Promise<VaultSubmitResult>;
  /** Cancel, Esc or Close: nothing is kept. */
  cancel(id: string): void;
}
