/** Local retrieval of the account's visible memory facts; only the selected page is mounted in Home. */
import type { MemoryView } from "../../shared/ipc";
import { searchFold } from "./search-copy";

/** Enough to browse a page without mounting the complete 5000-fact store. */
export const MEMORY_PAGE_SIZE = 50;
/** The sources carried by saved facts (labels come from Home's copy). */
export const MEMORY_SOURCES = ["user", "conversation", "task", "observed", "connector"] as const;

/** Every query word must occur in the fact; source filtering and paging never change the stored facts. */
export function memoryPage(rows: MemoryView["rows"], query: string, source: string, shown: number): { rows: MemoryView["rows"]; total: number } {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  const matching = rows.filter(row => (!source || row.source === source) && words.every(word => searchFold(row.text).includes(word)));
  return { rows: matching.slice(0, Math.max(MEMORY_PAGE_SIZE, shown)), total: matching.length };
}
