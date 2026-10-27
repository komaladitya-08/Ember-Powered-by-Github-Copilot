/**
 * Which setup-check rows need the user. Shared by the settings window (what shows before Start, the fold, the counts,
 * the sidebar's badge) and main (whether Start closes the window, what Ember's hello says), so the two always agree.
 * Pure and renderer-safe. A warning about reading, seeing or using apps holds Ember back as much as a failure does,
 * and a row with a button that fixes it is worth the user's look, because one click settles it (review #94, #95, #161).
 */

/** The fields of a setup-check row these decisions read (environment.ts Check). */
export interface SetupRow {
  readonly id: string;
  readonly label: string;
  readonly status: "ok" | "warn" | "fail";
  readonly fix?: string;
}

/**
 * Rows without which Ember can't read, see or use apps: "accessibility" (Linux's and Windows' screen reading, macOS's
 * Accessibility permission), and macOS's Screen Recording and Input Monitoring.
 */
const CAPABILITY_ROWS: ReadonlySet<string> = new Set(["accessibility", "screen-recording", "input-monitoring"]);

/** The row holds Ember back: it fails, or it warns that Ember can't read, see or use apps. */
export function holdsBack(r: SetupRow): boolean {
  return r.status === "fail" || (r.status === "warn" && CAPABILITY_ROWS.has(r.id));
}

/** The row needs the user: it holds Ember back, or it isn't OK and has a button that fixes it. */
export function needsUser(r: SetupRow): boolean {
  return holdsBack(r) || (r.status !== "ok" && r.fix !== undefined);
}

