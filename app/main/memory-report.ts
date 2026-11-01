/**
 * What each of Ember's processes costs in memory, for the development switch EMBER_MEMORY_LOG (main logs it as
 * `memory.report`). Working set counts the pages a process shares with the others (Electron's and Chromium's code) once
 * per process, so the sum over-counts several times; private bytes (Windows only) are each process's own. Each renderer
 * is named after the page it shows (renderer/<page>/) and its window's title, so the overlay on each display, the mic
 * page and the speech-only page tell apart. Plain Node, no Electron: main passes app.getAppMetrics() and its pages in.
 */

/** One process as app.getAppMetrics() reports it (memory in KB). */
export interface MetricLike {
  pid: number;
  type: string;
  serviceName?: string;
  name?: string;
  memory: { workingSetSize: number; privateBytes?: number };
}

/** One page main shows: its renderer's process id, URL and window title. */
export interface PageLike { pid: number; url: string; title: string }

/** One process in the report, in MB (one decimal). */
export interface MemoryRow { pid: number; kind: string; privateMb: number | null; workingSetMb: number }

const mb = (kb: number): number => Math.round(kb / 102.4) / 10;

/** The bundled page a URL loads (`mic` for …/renderer/mic/index.html), or "" for any other URL. */
export function pageOf(url: string): string {
  const m = /\/renderer\/([a-z-]+)\/[^/]*$/.exec(url.split(/[?#]/)[0] ?? "");
  return m?.[1] ?? "";
}

/**
 * The report's rows, largest private bytes (else working set) first, and the totals. A renderer shared by two pages
 * (Chromium may put same-site pages in one process) lists both.
 */
export function memoryReport(metrics: readonly MetricLike[], pages: readonly PageLike[]): { rows: MemoryRow[]; privateMb: number | null; workingSetMb: number } {
  const byPid = new Map<number, string[]>();
  for (const p of pages) {
    const name = [pageOf(p.url) || "page", p.title].filter(Boolean).join(" ");
    byPid.set(p.pid, [...byPid.get(p.pid) ?? [], name]);
  }
  const rows = metrics.map(m => {
    const kind = m.type === "Utility" ? `utility ${m.name || m.serviceName || ""}`.trim()
      : m.type === "Tab" ? `renderer ${byPid.get(m.pid)?.join(" + ") ?? "(no page)"}`
      : m.type.toLowerCase();
    return { pid: m.pid, kind, privateMb: m.memory.privateBytes === undefined ? null : mb(m.memory.privateBytes), workingSetMb: mb(m.memory.workingSetSize) };
  });
  rows.sort((a, b) => (b.privateMb ?? b.workingSetMb) - (a.privateMb ?? a.workingSetMb));
  const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 10) / 10;
  const privates = rows.map(r => r.privateMb);
  return {
    rows,
    privateMb: privates.every(x => x !== null) ? sum(privates as number[]) : null,
    workingSetMb: sum(rows.map(r => r.workingSetMb)),
  };
}
