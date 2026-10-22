/**
 * App names on Windows. Ember's `wmClass` for a window is its program's file name without ".exe", as the system
 * reports it ("notepad", "msedge", "Code"), because never-look, password prompts and grants match on it and the
 * accessibility sidecar reports the same name. A UWP app's window is a frame owned by ApplicationFrameHost.exe with
 * the app's own window (Windows.UI.Core.CoreWindow, another process) inside: its name is the hosted app's program.
 * Pure decisions; hwnd.ts does the lookups.
 */

/** The frame UWP apps live in, and the class of the app's own window inside it. */
export const FRAME_HOST_PROGRAM = "ApplicationFrameHost";
export const FRAME_CLASS = "ApplicationFrameWindow";
export const CORE_WINDOW_CLASS = "Windows.UI.Core.CoreWindow";

/**
 * The program name in an image path: the file name after the last "\" or "/", without a trailing ".exe" (any case).
 * "C:\Windows\System32\notepad.exe" → "notepad", "\Device\HarddiskVolume3\Apps\Code.EXE" → "Code". "" for "".
 */
export function programName(imagePath: string): string {
  const base = imagePath.slice(Math.max(imagePath.lastIndexOf("\\"), imagePath.lastIndexOf("/")) + 1);
  return base.replace(/\.exe$/i, "");
}

/** Do two app names name the same program (case-insensitive; ".exe" on either side doesn't matter)? */
export function sameProgram(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\.exe$/i, "").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** Is this the frame of a UWP app (its name is then the hosted app's, not ApplicationFrameHost)? */
export function isUwpFrame(program: string, className: string): boolean {
  return className === FRAME_CLASS && sameProgram(program, FRAME_HOST_PROGRAM);
}

/** A Windows.UI.Core.CoreWindow seen while resolving a frame: its process, its program and its title. */
export interface CoreWindowSeen { pid: number; program: string; title?: string }

/**
 * The program a UWP frame hosts: its CoreWindow child in another process (the usual case), else, when the app is
 * minimised or suspended and Windows has moved its CoreWindow out of the frame, the top-level CoreWindow with the
 * frame's title. null when neither is found (the caller keeps "ApplicationFrameHost": a name nobody grants).
 */
export function hostedProgram(frame: { pid: number; title: string }, children: readonly CoreWindowSeen[], topLevels: readonly CoreWindowSeen[]): string | null {
  const child = children.find(c => c.pid !== frame.pid && c.program);
  if (child) return child.program;
  if (!frame.title) return null;
  const sameTitle = topLevels.filter(t => t.pid !== frame.pid && t.program && t.title === frame.title);
  // Two apps' windows with the same title: either could be it, so neither is.
  return sameTitle.length === 1 ? sameTitle[0].program : null;
}
