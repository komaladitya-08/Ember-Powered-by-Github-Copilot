import { expect, it } from "vitest";
import { selectWindowsNodeApplicationError, selectWindowsNodeEventTrace, windowsNodeEventProcessFailure, windowsNodeEventWindow, WINDOWS_NODE_EVENT_LIMIT, WINDOWS_NODE_EVENT_OBSERVER_MS } from "../fixtures/windows-node-lpac-events";

const expected = { pid: 0x1234, image: "C:\\fresh\\tools\\node.exe", startedAt: Date.parse("2026-11-16T00:00:00Z"), endedAt: Date.parse("2026-11-16T00:00:20Z") };
const genuine = () => ({ provider: "Application Error", providerGuid: "{a0e9b465-b939-57d7-b27d-95d8e925ff57}", channel: "Application", id: 1000,
  time: "2026-11-16T00:00:01.1234567Z", pid: "0x1234", image: expected.image, app: "node.exe", code: "80000003", module: "Node.EXE", offset: "000000000000abcd" });
const output = (records: unknown[]) => JSON.stringify({ version: 1, status: "records", records });

it("selects only the exact own process image and normalizes a small path-free fault receipt", () => {
  const result = selectWindowsNodeApplicationError(output([genuine()]), expected);
  expect(result).toEqual({ status: "found", code: "0x80000003", module: "node.exe", offset: "0x000000000000abcd" });
  expect(JSON.stringify(result)).not.toContain(expected.image); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256);
});

it.each([
  { pid: "0x1235" }, { pid: "4660" }, { image: "C:\\other\\tools\\node.exe" }, { image: "C:\\fresh\\tools\\..\\tools\\node.exe" },
  { image: "C:\\fresh\\tools\\node.exe:alias" }, { image: "file:///C:/fresh/tools/node.exe" }, { app: "other.exe" },
  { provider: "Spoofed Application Error" }, { providerGuid: "{00000000-0000-0000-0000-000000000000}" },
  { providerGuid: "{a0e9b465-b939-57d7-b27d-95d8e925ff57" }, { channel: "Security" }, { id: 1001 },
  { time: "2026-11-15T23:59:59Z" }, { time: "2026-11-16T00:00:21Z" }, { time: "not a date" },
])("does not select stale, foreign or spoofed records: %j", changes => {
  expect(selectWindowsNodeApplicationError(output([{ ...genuine(), ...changes }]), expected)).toEqual({ status: "absent" });
});

it("accepts only case-insensitive Windows identity equality, not a path prefix", () => {
  const event = { ...genuine(), image: expected.image.toUpperCase(), app: "NODE.EXE", pid: "0x00001234", module: "ntdll.dll", offset: "0x123", code: "0x80000003" };
  expect(selectWindowsNodeApplicationError(output([event]), expected)).toEqual({ status: "found", code: "0x80000003", module: "ntdll.dll", offset: "0x0000000000000123" });
  expect(selectWindowsNodeApplicationError(output([{ ...event, image: expected.image + ".other" }]), expected)).toEqual({ status: "absent" });
});

it.each([{ module: "C:\\private\\secret.dll" }, { module: "module.dll\nsecret" }, { code: "80000003 secret" }, { offset: "0x" + "1".repeat(17) }, { module: "x".repeat(97) }])(
  "does not print unbounded or malformed fault data: %j", changes => {
    const result = selectWindowsNodeApplicationError(output([{ ...genuine(), ...changes }]), expected);
    expect(result.status).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain("secret"); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256);
  });

it("caps event count and captured bytes before returning any application data", () => {
  expect(selectWindowsNodeApplicationError(output(Array(WINDOWS_NODE_EVENT_LIMIT + 1).fill(genuine())), expected)).toEqual({ status: "unavailable", reason: "parse" });
  expect(selectWindowsNodeApplicationError(" ".repeat(65537), expected)).toEqual({ status: "unavailable", reason: "bounds" });
  expect(selectWindowsNodeApplicationError({ Message: "private event" }, expected)).toEqual({ status: "unavailable", reason: "bounds" });
});

it("rejects malformed JSON, unknown fields and hidden alternate PID/message sources", () => {
  for (const value of ["not-json", output([{ ...genuine(), Message: "private event" }]), output([{ ...genuine(), pid: "0x1235", executionPid: expected.pid }]), JSON.stringify({ version: 1, status: "records", records: [], Message: "private event" })]) {
    expect(selectWindowsNodeApplicationError(value, expected)).toEqual({ status: "unavailable", reason: "parse" });
  }
});

it("deduplicates equal receipts and refuses ambiguous fault records for the same process", () => {
  expect(selectWindowsNodeApplicationError(output([genuine(), genuine()]), expected).status).toBe("found");
  expect(selectWindowsNodeApplicationError(output([genuine(), { ...genuine(), offset: "ff" }]), expected)).toEqual({ status: "unavailable", reason: "ambiguous" });
});

it("reports absence and API/schema unavailability separately without treating either as compatibility", () => {
  expect(selectWindowsNodeApplicationError(output([]), expected)).toEqual({ status: "absent" });
  for (const reason of ["event-api", "event-schema", "record-limit"]) expect(selectWindowsNodeApplicationError(JSON.stringify({ version: 1, status: "unavailable", reason }), expected)).toEqual({ status: "unavailable", reason });
  expect(selectWindowsNodeApplicationError(JSON.stringify({ version: 1, status: "unavailable", reason: "raw secret" }), expected)).toEqual({ status: "unavailable", reason: "parse" });
});

it("refuses an unbounded selection window, invalid PID and unsupported expected image", () => {
  for (const changed of [{ pid: 0 }, { pid: 0x100000000 }, { image: "\\\\host\\share\\node.exe" }, { image: "C:\\fresh\\alias:stream\\node.exe" },
    { endedAt: expected.startedAt - 1 }, { endedAt: expected.startedAt + 60001 }]) {
    expect(selectWindowsNodeApplicationError(output([genuine()]), { ...expected, ...changed })).toEqual({ status: "unavailable", reason: "bounds" });
  }
});

const stageNames = ["script-start", "encoding-object-created", "encoding-ready", "inputs-ready", "module-ready", "provider-ready", "schema-ready", "query-ready", "selection-ready", "result-ready"];
const progress = (count = stageNames.length) => stageNames.slice(0, count).map((stage, index) => JSON.stringify({ type: "stage", stage, elapsedMs: index * 10 })).join("\n") + "\n";
it("retains only ordered fixed stage timings alongside a revalidated complete own-process receipt", () => {
  const result = selectWindowsNodeEventTrace(progress() + output([genuine()]) + "\n", expected);
  expect(result).toMatchObject({ status: "found", code: "0x80000003", module: "node.exe", stage: "result-ready", elapsedMs: 90 });
  expect(result.stages).toHaveLength(10); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024); expect(JSON.stringify(result)).not.toContain(expected.image);
});

it("classifies the actual exec timeout code and reports the last completed fixed phase without inspecting a fragment", () => {
  const result = windowsNodeEventProcessFailure({ code: "ETIMEDOUT", stdout: Buffer.from(progress(5) + '{"private":"unfinished secret'), stderr: "private error", message: "private command" }, expected);
  expect(result).toMatchObject({ status: "unavailable", reason: "timeout", stage: "module-ready", elapsedMs: 40 });
  expect(result.stages).toHaveLength(5); expect(JSON.stringify(result)).not.toMatch(/private|secret|command/);
  expect(windowsNodeEventProcessFailure({ code: "ETIMEDOUT", stdout: "" }, expected)).toEqual({ status: "unavailable", reason: "timeout", stage: "process-start", elapsedMs: null, stages: [] });
});

it("does not infer timeout from a raw message, signal or a query envelope", () => {
  expect(windowsNodeEventProcessFailure({ code: "OTHER", message: "ETIMEDOUT", signal: "SIGTERM", stdout: progress(3) }, expected)).toMatchObject({ reason: "event-api", stage: "encoding-ready" });
  expect(selectWindowsNodeEventTrace(progress(3) + JSON.stringify({ version: 1, status: "unavailable", reason: "timeout" }) + "\n", expected)).toMatchObject({ reason: "parse" });
  expect(selectWindowsNodeEventTrace(progress(3) + JSON.stringify({ version: 1, status: "unavailable", reason: "event-api" }) + "\n", expected)).toMatchObject({ reason: "event-api", stage: "encoding-ready" });
});

it("distinguishes completion of the direct encoding constructor from completion of the console setter", () => {
  expect(windowsNodeEventProcessFailure({ code: "ETIMEDOUT", stdout: progress(2) }, expected)).toMatchObject({ reason: "timeout", stage: "encoding-object-created", elapsedMs: 10 });
  expect(windowsNodeEventProcessFailure({ code: "ETIMEDOUT", stdout: progress(3) }, expected)).toMatchObject({ reason: "timeout", stage: "encoding-ready", elapsedMs: 20 });
});

it.each([
  [{ type: "stage", stage: "private-path", elapsedMs: 0 }],
  [{ type: "stage", stage: "script-start", elapsedMs: -1 }],
  [{ type: "stage", stage: "script-start", elapsedMs: WINDOWS_NODE_EVENT_OBSERVER_MS + 1 }],
  [{ type: "stage", stage: "script-start", elapsedMs: 0.5 }],
  [{ type: "stage", stage: "script-start", elapsedMs: 0, private: "secret" }],
  [{ type: "stage", stage: "encoding-ready", elapsedMs: 0 }],
  [{ type: "stage", stage: "script-start", elapsedMs: 10 }, { type: "stage", stage: "encoding-object-created", elapsedMs: 9 }],
  [{ type: "stage", stage: "script-start", elapsedMs: 0 }, { type: "stage", stage: "script-start", elapsedMs: 1 }],
])("rejects untrusted stage values, bounds and ordering without echoing data: %j", (...records) => {
  const result = selectWindowsNodeEventTrace(records.map(record => JSON.stringify(record)).join("\n") + "\n", expected, "event-api");
  expect(result).toMatchObject({ status: "unavailable", reason: "parse" }); expect(JSON.stringify(result)).not.toMatch(/private|secret/);
});

it("caps lines/bytes and requires complete progress before accepting found/absent output", () => {
  expect(selectWindowsNodeEventTrace(progress(2) + output([]), expected)).toMatchObject({ status: "unavailable", reason: "parse" });
  expect(selectWindowsNodeEventTrace(progress() + output([]) + "\n" + output([]) + "\n", expected)).toMatchObject({ reason: "bounds" });
  expect(windowsNodeEventProcessFailure({ code: "ENOBUFS", stdout: " ".repeat(65537) }, expected)).toMatchObject({ reason: "bounds", stage: "process-start" });
  expect(windowsNodeEventProcessFailure({ code: "ETIMEDOUT", stdout: "unparsed raw secret\n" }, expected)).toMatchObject({ reason: "timeout", stage: "process-start" });
});

it("accepts host-observer stages within the 30s verifier budget and rejects later timings", () => {
  const line = (elapsedMs: number) => JSON.stringify({ type: "stage", stage: "script-start", elapsedMs }) + "\n";
  expect(WINDOWS_NODE_EVENT_OBSERVER_MS).toBe(30_000);
  expect(windowsNodeEventProcessFailure({ code: "ETIMEDOUT", stdout: line(29_999) }, expected)).toMatchObject({ reason: "timeout", elapsedMs: 29_999 });
  expect(selectWindowsNodeEventTrace(line(30_001), expected, "event-api")).toMatchObject({ reason: "parse", stage: "process-start" });
});

it("uses a fresh post-query clock so a record published during module loading can match", () => {
  const identity = { pid: expected.pid, image: expected.image, startedAt: expected.startedAt + 1000 };
  const beforeLoading = windowsNodeEventWindow(identity, expected.startedAt + 2000)!;
  const afterQuery = windowsNodeEventWindow(identity, expected.startedAt + 31_000)!;
  const delayed = output([{ ...genuine(), time: "2026-11-16T00:00:15Z" }]);
  expect(selectWindowsNodeApplicationError(delayed, beforeLoading)).toEqual({ status: "absent" });
  expect(selectWindowsNodeApplicationError(delayed, afterQuery).status).toBe("found");
  expect(afterQuery.endedAt).toBe(expected.startedAt + 31_000); expect(afterQuery.endedAt).toBeLessThanOrEqual(afterQuery.startedAt + 60_000);
});

it("never issues a future or expired observer window", () => {
  const identity = { pid: expected.pid, image: expected.image, startedAt: expected.startedAt + 1000 };
  expect(windowsNodeEventWindow(identity, identity.startedAt - 1)).toBeNull();
  expect(windowsNodeEventWindow(identity, expected.startedAt + 60_001)).toBeNull();
  expect(windowsNodeEventWindow({ ...identity, startedAt: NaN }, expected.endedAt)).toBeNull();
  const atLimit = windowsNodeEventWindow(identity, expected.startedAt + 60_000)!;
  expect(atLimit.endedAt).toBe(atLimit.startedAt + 60_000);
});
