/**
 * Windows' own folders, asked of Windows rather than read from environment variables a user can change: the Windows
 * and System32 folders (GetWindowsDirectoryW, GetSystemDirectoryW) and the known folders Ember reads
 * (SHGetKnownFolderPath: ProgramData, and the per-user and all-users Start Menu "Programs" folders, which may be
 * redirected or roaming). Each answer is kept for the process's life (they don't move while Ember runs); null when
 * Windows wouldn't say, which every caller treats as "not there" (nothing is listed, nothing launched).
 */

import type { Win32SysApi } from "./ffi";

/** KNOWNFOLDERIDs (KnownFolders.h). */
export const FOLDERID = {
  ProgramData: "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}",
  Programs: "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}",
  CommonPrograms: "{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}",
} as const;

/** Windows' folders, read once each through `api` (null: not on Windows, or the call failed). */
export interface KnownFolders {
  /** "C:\Windows\System32". */
  systemDirectory(): string | null;
  /** "C:\Windows". */
  windowsDirectory(): string | null;
  /** "C:\ProgramData". */
  programData(): string | null;
  /** The user's Start Menu programs ("…\AppData\Roaming\Microsoft\Windows\Start Menu\Programs"). */
  programs(): string | null;
  /** Every user's Start Menu programs ("C:\ProgramData\Microsoft\Windows\Start Menu\Programs"). */
  commonPrograms(): string | null;
}

/** The folders through `api` (asked lazily: nothing native is called until a folder is wanted). */
export function knownFolders(api: () => Win32SysApi | null): KnownFolders {
  const memo = new Map<string, string | null>();
  const once = (key: string, read: (a: Win32SysApi) => string | null) => () => {
    if (memo.has(key)) return memo.get(key)!;
    const a = api();
    let v: string | null;
    try {
      v = a ? read(a) : null;
    } catch {
      v = null; // a failed call is "not known", never a guess
    }
    // A failure isn't remembered when the API isn't there yet (tests, or before koffi loads): only real answers are.
    if (a) memo.set(key, v);
    return v;
  };
  return {
    systemDirectory: once("system", a => a.systemDirectory()),
    windowsDirectory: once("windows", a => a.windowsDirectory()),
    programData: once("programData", a => a.knownFolder(FOLDERID.ProgramData)),
    programs: once("programs", a => a.knownFolder(FOLDERID.Programs)),
    commonPrograms: once("commonPrograms", a => a.knownFolder(FOLDERID.CommonPrograms)),
  };
}
