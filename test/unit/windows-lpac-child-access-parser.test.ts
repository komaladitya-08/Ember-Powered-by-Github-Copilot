/** Pure contracts: no collector, download, driver, filesystem or native execution is involved. */
import { describe, expect, it } from "vitest";
import {
  parseWindowsLpacChildAccessCsv, WindowsLpacChildAccessParseError,
  WINDOWS_LPAC_CHILD_ACCESS_MAX_BYTES, WINDOWS_LPAC_CHILD_ACCESS_MAX_ROWS, WINDOWS_LPAC_CHILD_ACCESS_MAX_FIELD_BYTES,
  type WindowsLpacChildAccessContext, type WindowsLpacChildAccessRefusalCode,
} from "../fixtures/windows-lpac-child-access-parser";

const PID = 4242, CHILD = 4343;
const paths = { image: "C:\\private\\witness\\tools\\fixture.exe", ordinaryAAPCanary: "C:\\private\\witness\\all-app-packages.txt",
  work: "C:\\private\\witness\\work", state: "C:\\private\\witness\\state", windows: "C:\\Windows" };
const context = (): WindowsLpacChildAccessContext => ({ ownedPids: new Set([PID]), paths: { ...paths } });
const header = ["Time of Day", "Process Name", "PID", "Operation", "Path", "Result", "Detail"];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const row = (operation: string, path: string, result = "SUCCESS", pid = PID, detail = "private details", name = "fixture.exe") =>
  ["9:10:11.1234567 AM", name, String(pid), operation, path, result, detail];
const csv = (rows: string[][], columns = header) => Buffer.from([columns, ...rows].map(values => values.map(quote).join(",")).join("\r\n") + "\r\n");
const controls = () => [row("CreateFile", paths.image), row("CreateFile", paths.ordinaryAAPCanary, "ACCESS DENIED")];
const complete = (extra: string[][] = []) => csv([...controls(), ...extra, row("Process Exit", "")]);
function refusal(bytes: Uint8Array, code: WindowsLpacChildAccessRefusalCode, input = context()) {
  let caught: unknown;
  try { parseWindowsLpacChildAccessCsv(bytes, input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WindowsLpacChildAccessParseError);
  expect((caught as WindowsLpacChildAccessParseError).code).toBe(code);
  expect((caught as Error).message).toBe("The fixed child-access witness did not contain complete bounded evidence.");
  expect(caught).not.toHaveProperty("cause");
  expect(JSON.stringify(caught)).not.toMatch(/private|secret|witness\\|4242|4343/);
}

describe("fixed child-access CSV aggregate", () => {
  it("requires only covered image/negative-canary/exit evidence and returns fixed numeric fields", () => {
    expect(parseWindowsLpacChildAccessCsv(complete(), context())).toEqual({ schema: 1, status: 1, coverage: 7,
      rows: [[1, 1, 1, 1], [1, 2, 2, 1], [14, 1, 0, 1]] });
  });
  it("accepts UTF-8 BOM and correctly handles quoted commas, quote escapes and non-ASCII private details", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), complete([
      row("ReadFile", paths.work + "\\document.txt", "SUCCESS", PID, 'secret, "private" café'),
    ])]);
    expect(parseWindowsLpacChildAccessCsv(bytes, context()).rows).toContainEqual([3, 1, 3, 1]);
  });
  it("accepts ordinary unquoted CSV without changing the seven-column schema", () => {
    const bytes = Buffer.from([header, ...controls(), row("Process Exit", "")].map(values => values.join(",")).join("\r\n") + "\r\n");
    expect(parseWindowsLpacChildAccessCsv(bytes, context()).coverage).toBe(7);
  });
  it("discards every unrelated row and emits no unrelated activity counts or captured strings", () => {
    const bytes = complete([
      row("PRIVATE OPERATION", "C:\\secret\\credential.txt", "SECRET RESULT", 9898, "token=private", "private-program.exe"),
      row("ReadFile", "C:\\secret\\other.txt", "SUCCESS", 9899, "private stack and argv", "fixture.exe"),
      row("PRIVATE OPERATION", "C:\\secret\\own.txt", "SECRET RESULT", PID, "private identity"),
    ]);
    const result = parseWindowsLpacChildAccessCsv(bytes, context());
    expect(result.rows).toEqual([[0, 0, 0, 1], [1, 1, 1, 1], [1, 2, 2, 1], [14, 1, 0, 1]]);
    expect(Object.keys(result)).toEqual(["schema", "status", "coverage", "rows"]);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|9898|9899|4242|argv|stack|credential|fixture|token/i);
    expect(result.rows.flat().every(Number.isSafeInteger)).toBe(true);
  });
  it("sorts and aggregates numeric classes while respecting path-component boundaries", () => {
    const result = parseWindowsLpacChildAccessCsv(complete([
      row("ReadFile", paths.state + "\\receipt.bin"), row("ReadFile", paths.work + "\\a.txt"),
      row("ReadFile", paths.work + "\\b.txt"), row("ReadFile", paths.work + "-other\\private.txt"),
    ]), context());
    expect(result.rows).toEqual([[1, 1, 1, 1], [1, 2, 2, 1], [3, 1, 0, 1], [3, 1, 3, 2], [3, 1, 4, 1], [14, 1, 0, 1]]);
  });
  it.each([
    ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\fixture.exe", 10],
    ["HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Safer\\CodeIdentifiers", 11],
    ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\NamespaceSeparation", 12],
    ["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\private-value", 13],
    ["C:\\Windows\\System32\\kernelbase.dll", 20], ["C:\\Windows\\SysWOW64\\kernel32.dll", 21],
    ["C:\\Windows\\WinSxS\\private-component\\binary.dll", 22],
    ["C:\\Windows\\System32-other\\private.dll", 0], ["HKLM\\SOFTWARE\\private\\key", 0],
    ["HKU\\S-1-5-21-private\\private-key", 0], ["\\Device\\HarddiskVolume99\\private", 0],
    [paths.work + "\\a.txt:private-stream", 0], [paths.work + "\\..\\private.txt", 0],
  ])("maps only fixed path classes without publishing their source (%s)", (value, expected) => {
    const result = parseWindowsLpacChildAccessCsv(complete([row("RegOpenKey", String(value), "ACCESS DENIED")]), context());
    expect(result.rows).toContainEqual([17, 2, expected, 1]);
    expect(JSON.stringify(result)).not.toContain(String(value));
  });
  it("folds Windows path/name case without normalizing textual aliases into evidence", () => {
    const bytes = csv([row("CreateFile", paths.image.toUpperCase(), "SUCCESS", PID, "", "FIXTURE.EXE"),
      row("CreateFile", paths.ordinaryAAPCanary.toUpperCase(), "ACCESS DENIED"), row("Process Exit", "")]);
    expect(parseWindowsLpacChildAccessCsv(bytes, context()).coverage).toBe(7);
    refusal(csv([row("CreateFile", "\\\\?\\" + paths.image), ...controls().slice(1), row("Process Exit", "")]), 9);
  });
  it("keeps the input unchanged and returns detached immutable numeric aggregates", () => {
    const bytes = complete(), before = Buffer.from(bytes), input = context(), result = parseWindowsLpacChildAccessCsv(bytes, input);
    input.paths.image = "C:\\private\\changed"; (input.ownedPids as Set<number>).clear();
    expect(bytes.equals(before)).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rows)).toBe(true); expect(result.rows.every(Object.isFrozen)).toBe(true);
    expect(parseWindowsLpacChildAccessCsv(complete(), context())).toEqual(result);
  });
});

describe("child-access owner metadata lifetime", () => {
  it("requires one final exit for each of at most two caller-selected native owners", () => {
    const input = context(); input.ownedPids = new Set([PID, CHILD]);
    const bytes = csv([...controls(), row("ReadFile", paths.work, "SUCCESS", CHILD), row("Process Exit", "", "SUCCESS", CHILD), row("Process Exit", "")]);
    expect(parseWindowsLpacChildAccessCsv(bytes, input).rows).toContainEqual([14, 1, 0, 2]);
    refusal(complete(), 9, input);
  });
  it.each(["Process Exit", "ReadFile", "PRIVATE AFTER EXIT"])("rejects any later metadata row for an exited owned PID (%s)", operation => {
    refusal(csv([...controls(), row("Process Exit", ""), row(operation, "C:\\secret\\after-exit")]), 10);
  });
  it.each(["ACCESS DENIED", "PRIVATE RESULT"])("refuses an unsuccessful or unknown owned exit observation (%s)", result => {
    refusal(csv([...controls(), row("Process Exit", "", result)]), 10);
  });
  it("does not require a Process Start event because capture begins after suspended creation", () => {
    expect(parseWindowsLpacChildAccessCsv(complete(), context()).coverage).toBe(7);
  });
  it("refuses a selected PID with different image-name metadata without trusting that name as authority", () => {
    refusal(complete([row("ReadFile", paths.work, "SUCCESS", PID, "private", "conhost.exe")]), 8);
  });
  it.each([[], [0], [-1], [NaN], [0x100000000], [PID, CHILD, 9999]].map(pids => ({ pids })))("refuses invalid native owner selectors without disclosure (%#)", ({ pids }) => {
    refusal(complete(), 2, { ...context(), ownedPids: new Set(pids) });
  });
});

describe("child-access CSV fail-closed bounds and format", () => {
  it.each([
    "\\\\server\\share\\fixture.exe", "\\\\?\\C:\\private\\fixture.exe", "C:\\private\\..\\fixture.exe",
    "C:\\private\\file:stream", "C:\\private\\folder.\\fixture.exe", "C:\\private\\folder \\fixture.exe",
    "C:\\private\nfixture.exe", "C:/private/fixture.exe", "C:\\private\\fi\u202exture.exe",
  ])("rejects unsafe classification inputs (%#)", image => {
    refusal(complete(), 2, { ...context(), paths: { ...paths, image } });
  });
  it("requires every private classification path to belong to the same exact fixed fixture layout", () => {
    refusal(complete(), 2, { ...context(), paths: { ...paths, state: "C:\\private\\other\\state" } });
    refusal(complete(), 2, { ...context(), paths: { ...paths, ordinaryAAPCanary: "C:\\private\\other\\all-app-packages.txt" } });
  });
  it("sanitizes thrown context getters and arbitrary input objects", () => {
    const input = context(); Object.defineProperty(input, "paths", { get() { throw new Error("C:\\secret\\getter"); } });
    refusal(complete(), 2, input); refusal("secret" as unknown as Uint8Array, 1);
  });
  it("rejects empty, oversized and concurrently mutable shared input before decoding", () => {
    refusal(Buffer.alloc(0), 1); refusal(Buffer.alloc(WINDOWS_LPAC_CHILD_ACCESS_MAX_BYTES + 1), 1);
    refusal(new Uint8Array(new SharedArrayBuffer(16)), 1);
  });
  it.each([[0xc0, 0xaf], [0xc3], [0xed, 0xa0, 0x80], [0xff]].map(invalid => ({ invalid })))("rejects invalid UTF-8 without replacement characters (%#)", ({ invalid }) => {
    const bytes = complete(), index = bytes.indexOf("private details");
    refusal(Buffer.concat([bytes.subarray(0, index), Buffer.from(invalid), bytes.subarray(index + 15)]), 3);
  });
  it.each([
    header.slice(0, 6), [...header, "Stack"], [header[0], header[1], "PID", "PID", ...header.slice(4)],
    [...header].reverse(), [...header.slice(0, 6), "PrivateColumn"],
  ].map(columns => ({ columns })))("requires the exact seven-column schema (%#)", ({ columns }) => { refusal(csv([], columns), 5); });
  it("rejects partial and excess row columns", () => {
    refusal(csv([controls()[0].slice(0, 6)]), 5); refusal(csv([[...controls()[0], "private extra"]]), 5);
  });
  it.each(["0", "04242", "-1", "1.5", "4294967296", "private", " 4242", "4242 ", "1e3"])("requires canonical bounded PID metadata (%s)", value => {
    const event = controls()[0]; event[2] = value; refusal(csv([event]), 7);
  });
  it.each([
    (text: string) => text.replaceAll("\r\n", "\n"),
    (text: string) => text.replaceAll("\r\n", "\r"),
    (text: string) => text.slice(0, -2),
    (text: string) => text.slice(0, -4),
    (text: string) => text.replace('"SUCCESS"', '"SUCCESS"private'),
    (text: string) => text.replace('"SUCCESS"', 'SU"CCESS'),
    (text: string) => text.replace('"SUCCESS"', '"SU\r\nCCESS"'),
  ])("refuses malformed or truncated CSV records (%#)", corrupt => { refusal(Buffer.from(corrupt(complete().toString("utf8"))), 4); });
  it.each(["\0", "\t", "\u007f", "\u202e", "\ufeff"])("rejects control/format content even in discarded Details (%#)", control => {
    refusal(complete([row("ReadFile", paths.work, "SUCCESS", 9999, "private" + control)]), 4);
  });
  it("bounds encoded fields even when their content is ignored", () => {
    const extra = row("ReadFile", paths.work, "SUCCESS", PID, "x".repeat(WINDOWS_LPAC_CHILD_ACCESS_MAX_FIELD_BYTES - 2));
    expect(parseWindowsLpacChildAccessCsv(complete([extra]), context()).rows).toContainEqual([3, 1, 3, 1]);
    extra[6] += "x"; refusal(complete([extra]), 6);
  });
  it("bounds all parsed records, including unrelated rows which never reach output", () => {
    const unknown = row("ReadFile", "C:\\secret\\unrelated", "SUCCESS", 9999);
    const maximum = csv([...controls(), ...Array.from({ length: WINDOWS_LPAC_CHILD_ACCESS_MAX_ROWS - 3 }, () => unknown), row("Process Exit", "")]);
    expect(parseWindowsLpacChildAccessCsv(maximum, context()).rows).toHaveLength(3);
    refusal(csv([...controls(), ...Array.from({ length: WINDOWS_LPAC_CHILD_ACCESS_MAX_ROWS - 2 }, () => unknown), row("Process Exit", "")]), 6);
  });
  it.each([
    [row("CreateFile", paths.image), row("Process Exit", "")],
    [row("CreateFile", paths.ordinaryAAPCanary, "ACCESS DENIED"), row("Process Exit", "")],
    controls(),
    [row("CreateFile", paths.image, "ACCESS DENIED"), row("CreateFile", paths.ordinaryAAPCanary), row("Process Exit", "")],
    [...controls(), row("Process Exit ", "")],
  ].map(rows => ({ rows })))("refuses incomplete real positive/negative/exit coverage rather than publishing absence (%#)", ({ rows }) => { refusal(csv(rows), 9); });
});
