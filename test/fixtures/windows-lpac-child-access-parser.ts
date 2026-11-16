/** Stopped-only fixed-case Procmon evidence. CSV metadata never establishes native process or readout authority. */
import path from "node:path/win32";

export const WINDOWS_LPAC_CHILD_ACCESS_MAX_BYTES = 32 * 1024 * 1024;
export const WINDOWS_LPAC_CHILD_ACCESS_MAX_ROWS = 10_000;
/** Encoded field bytes, including CSV quotes and quote escapes. */
export const WINDOWS_LPAC_CHILD_ACCESS_MAX_FIELD_BYTES = 64 * 1024;
const HEADER = ["Time of Day", "Process Name", "PID", "Operation", "Path", "Result", "Detail"] as const;

/** Zero is always unknown; captured operation/result strings never leave this module. */
export const WINDOWS_LPAC_CHILD_ACCESS_OPERATION = Object.freeze({
  CreateFile: 1, QueryOpen: 2, ReadFile: 3, CloseFile: 4, QueryInformationFile: 5,
  QueryBasicInformationFile: 6, QueryStandardInformationFile: 7, QueryNameInformationFile: 8,
  QuerySecurityFile: 9, CreateFileMapping: 10, "Load Image": 11, "Process Create": 12,
  "Process Start": 13, "Process Exit": 14, "Thread Create": 15, "Thread Exit": 16,
  RegOpenKey: 17, RegQueryKey: 18, RegQueryValue: 19, RegCloseKey: 20, RegQueryKeySecurity: 21,
  RegEnumKey: 22, RegEnumValue: 23, WriteFile: 24, SetDispositionInformationFile: 25, SetBasicInformationFile: 26,
} as const);
export const WINDOWS_LPAC_CHILD_ACCESS_RESULT = Object.freeze({
  SUCCESS: 1, "ACCESS DENIED": 2, "NAME NOT FOUND": 3, "PATH NOT FOUND": 4,
  "BUFFER OVERFLOW": 5, "BUFFER TOO SMALL": 6, REPARSE: 7, "NO MORE ENTRIES": 8,
  "INVALID PARAMETER": 9, "PRIVILEGE NOT HELD": 10,
} as const);
/** Exact private controls: 1 image, 2 ordinary-AAP canary, 3 work, 4 state. Public path families use 10–22. */
export const WINDOWS_LPAC_CHILD_ACCESS_PATH_CLASS = Object.freeze({
  unknown: 0, image: 1, ordinaryAAPCanary: 2, work: 3, state: 4,
  imageFileExecutionOptions: 10, saferCodeIdentifiers: 11, namespaceSeparation: 12, memoryManagement: 13,
  system32: 20, syswow64: 21, winsxs: 22,
} as const);

export type WindowsLpacChildAccessRefusalCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
/** Codes: input, context, UTF-8, CSV syntax/control, schema, bounds, PID, own-image metadata, coverage, lifetime. */
export class WindowsLpacChildAccessParseError extends Error {
  readonly code: WindowsLpacChildAccessRefusalCode;
  constructor(code: WindowsLpacChildAccessRefusalCode) {
    super("The fixed child-access witness did not contain complete bounded evidence.");
    this.name = "WindowsLpacChildAccessParseError";
    this.code = Number.isInteger(code) && code >= 1 && code <= 10 ? code : 1;
  }
}
export interface WindowsLpacChildAccessContext {
  /** Selected only from held, independently attested native owners. This CSV selector grants no authority. */
  ownedPids: ReadonlySet<number>;
  paths: { image: string; ordinaryAAPCanary: string; work: string; state: string; windows: string };
}
export type WindowsLpacChildAccessCount = readonly [operation: number, result: number, pathClass: number, count: number];
export interface WindowsLpacChildAccessAggregate {
  readonly schema: 1;
  readonly status: 1;
  /** Exact image success, exact ordinary-AAP canary denial, and one final exit for every selected native owner. */
  readonly coverage: 7;
  readonly rows: readonly WindowsLpacChildAccessCount[];
}
const refuse = (code: WindowsLpacChildAccessRefusalCode): never => { throw new WindowsLpacChildAccessParseError(code); };
const ordinary = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 32767 || !/^[A-Za-z]:\\/.test(value) || /[/\p{Cc}\p{Cf}<>"|?*]/u.test(value) || path.normalize(value) !== value) return false;
  return value.slice(3).split("\\").every(part => part.length > 0 && part !== "." && part !== ".." && !part.includes(":") && !/[. ]$/.test(part));
};
const inFamily = (value: string, root: string) => value === root || value.startsWith(root + "\\");
const fixedNumber = (table: Readonly<Record<string, number>>, value: string) => Object.hasOwn(table, value) ? table[value] : 0;

/** Caller must prove all native writers stopped and hold its finalized no-write/delete file pin before calling. */
export function parseWindowsLpacChildAccessCsv(bytes: Uint8Array, context: WindowsLpacChildAccessContext): WindowsLpacChildAccessAggregate {
  let source: Uint8Array | undefined;
  const field: number[] = [], fields: string[] = [];
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > WINDOWS_LPAC_CHILD_ACCESS_MAX_BYTES ||
      bytes.buffer instanceof SharedArrayBuffer) refuse(1);
    source = Uint8Array.from(bytes);
    let selected: Set<number>, controls: WindowsLpacChildAccessContext["paths"];
    try {
      if (!(context.ownedPids instanceof Set) || context.ownedPids.size < 1 || context.ownedPids.size > 2) refuse(2);
      selected = new Set(context.ownedPids);
      if ([...selected].some(value => !Number.isInteger(value) || value < 1 || value > 0xffffffff)) refuse(2);
      controls = { ...context.paths };
      if (![controls.image, controls.ordinaryAAPCanary, controls.work, controls.state, controls.windows].every(ordinary)) refuse(2);
      const root = path.dirname(controls.work).toLowerCase();
      if (controls.work.toLowerCase() !== path.join(root, "work") || controls.state.toLowerCase() !== path.join(root, "state") ||
        controls.image.toLowerCase() !== path.join(root, "tools", "fixture.exe") ||
        controls.ordinaryAAPCanary.toLowerCase() !== path.join(root, "all-app-packages.txt")) refuse(2);
      controls = { image: controls.image.toLowerCase(), ordinaryAAPCanary: controls.ordinaryAAPCanary.toLowerCase(),
        work: controls.work.toLowerCase(), state: controls.state.toLowerCase(), windows: controls.windows.toLowerCase() };
    } catch { return refuse(2); }
    const classify = (value: string): number => {
      const lower = value.toLowerCase();
      if (ordinary(value)) {
        if (lower === controls.image) return 1;
        if (lower === controls.ordinaryAAPCanary) return 2;
        if (inFamily(lower, controls.work)) return 3;
        if (inFamily(lower, controls.state)) return 4;
        for (const [suffix, code] of [["system32", 20], ["syswow64", 21], ["winsxs", 22]] as const)
          if (inFamily(lower, controls.windows + "\\" + suffix)) return code;
      }
      for (const [root, code] of [
        ["hklm\\software\\microsoft\\windows nt\\currentversion\\image file execution options", 10],
        ["hklm\\software\\policies\\microsoft\\windows\\safer\\codeidentifiers", 11],
        ["hklm\\system\\currentcontrolset\\control\\session manager\\namespaceseparation", 12],
        ["hklm\\system\\currentcontrolset\\control\\session manager\\memory management", 13],
      ] as const) if (inFamily(lower, root)) return code;
      return 0;
    };
    let records = 0, coverage = 0, encoded = 0;
    const exited = new Set<number>(), counts = new Map<string, [number, number, number, number]>();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const endField = () => {
      let value: string;
      try { value = decoder.decode(Uint8Array.from(field)); } catch { return refuse(3); }
      if (/[\p{Cc}\p{Cf}]/u.test(value)) refuse(4);
      fields.push(value); field.fill(0); field.length = 0; encoded = 0;
      if (fields.length > HEADER.length) refuse(5);
    };
    const endRecord = () => {
      if (fields.length !== HEADER.length) refuse(5);
      if (records === 0) {
        if (!HEADER.every((value, index) => fields[index] === value)) refuse(5);
      } else {
        if (records > WINDOWS_LPAC_CHILD_ACCESS_MAX_ROWS) refuse(6);
        if (!/^[1-9]\d{0,9}$/.test(fields[2])) refuse(7);
        const pid = Number(fields[2]); if (pid > 0xffffffff) refuse(7);
        if (selected.has(pid)) {
          if (exited.has(pid)) refuse(10);
          if (fields[1].toLowerCase() !== "fixture.exe") refuse(8);
          const operation = fixedNumber(WINDOWS_LPAC_CHILD_ACCESS_OPERATION, fields[3]);
          const result = fixedNumber(WINDOWS_LPAC_CHILD_ACCESS_RESULT, fields[5]), pathClass = classify(fields[4]);
          if (operation === 1 && result === 1 && pathClass === 1) coverage |= 1;
          if (operation === 1 && result === 2 && pathClass === 2) coverage |= 2;
          if (operation === 14) { if (result !== 1) refuse(10); exited.add(pid); }
          const key = `${operation},${result},${pathClass}`, existing = counts.get(key);
          if (existing) existing[3]++;
          else counts.set(key, [operation, result, pathClass, 1]);
        }
      }
      records++; fields.fill(""); fields.length = 0;
    };
    let state: "start" | "plain" | "quoted" | "closed" = "start", started = false;
    const countByte = () => { if (++encoded > WINDOWS_LPAC_CHILD_ACCESS_MAX_FIELD_BYTES) refuse(6); };
    let offset = source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf ? 3 : 0;
    for (; offset < source.length; offset++) {
      const byte = source[offset];
      if (state === "quoted") {
        countByte();
        if (byte === 34) {
          if (source[offset + 1] === 34) { countByte(); field.push(34); offset++; }
          else state = "closed";
        } else {
          if (byte === 10 || byte === 13) refuse(4);
          field.push(byte);
        }
        continue;
      }
      if (byte === 44) { endField(); state = "start"; started = true; continue; }
      if (byte === 13) {
        if (source[offset + 1] !== 10) refuse(4);
        offset++; endField(); endRecord(); state = "start"; started = false; continue;
      }
      if (byte === 10 || state === "closed") refuse(4);
      countByte(); started = true;
      if (byte === 34) { if (state !== "start") refuse(4); state = "quoted"; }
      else { field.push(byte); state = "plain"; }
    }
    if (started || fields.length || field.length || records === 0) refuse(4); // A finalized export ends with its complete CRLF record.
    if (coverage !== 3 || exited.size !== selected.size) refuse(9);
    const rows = [...counts.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map(value => Object.freeze(value));
    return Object.freeze({ schema: 1, status: 1, coverage: 7, rows: Object.freeze(rows) });
  } catch (error) {
    if (error instanceof WindowsLpacChildAccessParseError) throw error;
    return refuse(1);
  } finally { source?.fill(0); field.fill(0); fields.fill(""); }
}
