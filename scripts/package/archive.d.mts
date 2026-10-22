// Types for archive.mjs (the unit tests import it).
import type { Layout } from "./layout.d.mts";

export type ArchiveStep = { what: string; file: string; args: string[]; expect?: string[]; retries?: number };
export declare function archivePlan(layout: Layout, o: { version: string; out: string; systemRoot?: string }): {
  archives: string[];
  dmgRoot: string | null;
  steps: ArchiveStep[];
};
