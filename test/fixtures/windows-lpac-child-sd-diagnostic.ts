/** Fixed stopped-only diagnostic data. These AccessCheck observations never confer launch or readout authority. */
export const WINDOWS_LPAC_CHILD_SD_MAGIC = 0x44435345;
export const WINDOWS_LPAC_CHILD_SD_BYTES = 80;
const ALL_ACCESS = 0x1fffff; // Windows Vista+ SDK PROCESS_ALL_ACCESS and THREAD_ALL_ACCESS on the required Server targets.
export class WindowsLpacChildSdDiagnosticError extends Error {
  constructor() { super("The fixed child-object access diagnostic was invalid."); this.name = "WindowsLpacChildSdDiagnosticError"; }
}
/** The instrumented producer returns to ordinary denial only after its diagnostic writer completed. */
export function readWindowsLpacChildSdDiagnostic<T>(rootExit: number, read: () => T): T | null {
  if (rootExit === 33) throw new WindowsLpacChildSdDiagnosticError();
  if (rootExit !== 18) return null;
  return read();
}
export interface WindowsLpacChildSdDiagnostic {
  setup: { stage: number; error: number };
  process: { requested: number; checked: boolean; allowed: boolean; granted: number; error: number };
  thread: { requested: number; checked: boolean; allowed: boolean; granted: number; error: number };
  defaults: { ownerSourceClass: number; groupSourceClass: number };
  copiedDacls: number;
  cleanup: { primaryClosed: boolean; duplicateClosed: boolean };
}
export function parseWindowsLpacChildSdDiagnostic(bytes: Buffer): WindowsLpacChildSdDiagnostic {
  const invalid = () => { throw new WindowsLpacChildSdDiagnosticError(); };
  if (!Buffer.isBuffer(bytes) || bytes.length !== WINDOWS_LPAC_CHILD_SD_BYTES) invalid();
  const word = (index: number) => bytes.readUInt32LE(index * 4), bit = (index: number) => {
    const value = word(index); if (value !== 0 && value !== 1) invalid(); return value === 1;
  };
  if (word(0) !== WINDOWS_LPAC_CHILD_SD_MAGIC || word(1) !== 1 || word(2) < 1 || word(2) > 8 || word(19) !== 0 ||
    word(4) !== ALL_ACCESS || word(9) !== ALL_ACCESS || ![0, 4].includes(word(14)) || ![0, 5].includes(word(15)) || word(16) > 3) invalid();
  const check = (offset: number) => {
    const checked = bit(offset + 1), allowed = bit(offset + 2), granted = word(offset + 3), error = word(offset + 4);
    if ((!checked && (allowed || granted !== 0)) || (checked && error !== 0)) invalid();
    return { requested: word(offset), checked, allowed, granted, error };
  };
  const process = check(4), thread = check(9), primaryClosed = bit(17), duplicateClosed = bit(18);
  if (word(2) === 8) {
    if (word(3) !== 0 || word(14) !== 4 || word(15) !== 5 || word(16) !== 3 || !primaryClosed || !duplicateClosed) invalid();
  } else if (word(3) === 0) invalid();
  return { setup: { stage: word(2), error: word(3) }, process, thread,
    defaults: { ownerSourceClass: word(14), groupSourceClass: word(15) }, copiedDacls: word(16), cleanup: { primaryClosed, duplicateClosed } };
}
