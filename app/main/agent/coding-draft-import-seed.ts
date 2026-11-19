/** One-use host-only imported data bound to a newly captured source identity, never a saved continuation capability. */
import type { CodingArtifactSourceRef, CodingArtifactStore } from "./coding-artifact-store";
import type { CodingExportInput } from "./coding-result-export";
import { clearCodingContinuation } from "./coding-continuation";
import { CodingDraftError } from "./coding-draft-format";

declare const seedBrand: unique symbol;
export interface CodingDraftImportSeed { readonly [seedBrand]: true; close(): void }
interface State { data?: CodingExportInput; store: CodingArtifactStore; source: CodingArtifactSourceRef; projectId: string; path: string; owner: string; current(): boolean }
const seeds = new WeakMap<CodingDraftImportSeed, State>();
/** Issued only after a fresh stopped source capture and successful complete three-way comparison. */
export function issueCodingDraftImportSeed(state: State): CodingDraftImportSeed {
  const captured = { ...state, current: state.current.bind(state) };
  const token = Object.freeze({ close() { clearCodingContinuation(captured.data); captured.data = undefined; } }) as CodingDraftImportSeed;
  seeds.set(token, captured); return token;
}
/** Exact store-issued receipts must attest the new source again before any saved byte enters another private copy. */
export async function consumeCodingDraftImportSeed(token: CodingDraftImportSeed, input: {
  store: CodingArtifactStore; source: CodingArtifactSourceRef; projectId: string; path: string; owner: string; current(): boolean;
}): Promise<CodingExportInput> {
  const state = seeds.get(token);
  const check = () => {
    if (!state?.data || state.store !== input.store || state.projectId !== input.projectId || state.path !== input.path || state.owner !== input.owner ||
      state.current() !== true || input.current() !== true || !state.data) throw new CodingDraftError("stale");
  };
  check(); if (!await input.store.sameSource(state!.source, input.source, check)) throw new CodingDraftError("stale"); check();
  const data = state!.data!; state!.data = undefined; seeds.delete(token); return data;
}
