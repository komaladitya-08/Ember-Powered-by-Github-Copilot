import { expect, it } from "vitest";
import { inspectWindowsNodeFatalOutput, parseWindowsNodeFatalOutput, WINDOWS_NODE_FATAL_MAX_BYTES, WINDOWS_NODE_FATAL_REFUSALS } from "../fixtures/windows-node-lpac-fatal";
import sources from "../../scripts/experimental/windows-node-lpac-sources.json";

const version = "22.23.5", file = "deps/v8/src/base/platform/platform-win32.cc";
const header = (source = file, line: string | number = 42) => `# Fatal error in ${source}, line ${line}\n`;
const parse = (text: string, release = version) => parseWindowsNodeFatalOutput(Buffer.from(text), release);

it.each([
  ["private text\0", "encoding"], [header() + "raw\rprivate", "newline"],
  ["# Fatal error in private malformed header\n", "header"], [header("C:\\private\\unknown.cc"), "public-source"],
  [header(file, 100001), "line"],
])("explains a refusal with a closed stage without exposing rejected content: %s", (text, stage) => {
  const bytes = Buffer.from(text), inspection = inspectWindowsNodeFatalOutput(bytes, version);
  expect(inspection.output).toEqual(parseWindowsNodeFatalOutput(bytes, version));
  expect(inspection.refusal).toMatchObject({ stage });
  expect(Object.keys(inspection.refusal!).every(key => ["stage", "representation", "newlines"].includes(key))).toBe(true);
  expect(JSON.stringify(inspection)).not.toMatch(/private|unknown|malformed|100001|Fatal|C:/);
  expect(Buffer.byteLength(JSON.stringify(inspection))).toBeLessThan(256);
});

it.each(["utf16le-ascii", "utf16be-ascii"])("classifies only the bounded %s byte shape without accepting or decoding it", representation => {
  const text = header() + "private-message\n", bytes = Buffer.from(text, "utf16le");
  if (representation === "utf16be-ascii") bytes.swap16();
  const inspection = inspectWindowsNodeFatalOutput(bytes, version);
  expect(inspection).toEqual({ output: { status: "unreadable", bytes: bytes.length }, refusal: { stage: "encoding", representation } });
  expect(JSON.stringify(inspection)).not.toMatch(/private|message|Fatal|logging|platform/);
});

it("keeps malformed wide data opaque and refuses unknown inputs/releases before representation inspection", () => {
  const bytes = Buffer.from([0, 0, 65, 0, 0xff, 0]);
  expect(inspectWindowsNodeFatalOutput(bytes, version)).toEqual({ output: { status: "unreadable", bytes: 6 }, refusal: { stage: "encoding", representation: "other" } });
  expect(inspectWindowsNodeFatalOutput(bytes, "private-release")).toEqual({ output: { status: "unreadable", bytes: 6 }, refusal: { stage: "release" } });
  expect(inspectWindowsNodeFatalOutput("private" as unknown as Buffer, version)).toEqual({ output: { status: "unreadable", bytes: 0 }, refusal: { stage: "input" } });
  expect(Object.isFrozen(WINDOWS_NODE_FATAL_REFUSALS)).toBe(true);
});

it.each([
  ["private\r\r\n", { crlf: 0, doubledCrlf: 1, bareCr: 0, lf: 0 }],
  ["private\r", { crlf: 0, doubledCrlf: 0, bareCr: 1, lf: 0 }],
  ["private\r\r\ntext\r\nmore\nlast\r", { crlf: 1, doubledCrlf: 1, bareCr: 1, lf: 1 }],
  ["private\r\r\r\n", { crlf: 0, doubledCrlf: 1, bareCr: 1, lf: 0 }],
])("counts only bounded newline structures without returning their surrounding text: %s", (text, newlines) => {
  const bytes = Buffer.from(text as string), inspection = inspectWindowsNodeFatalOutput(bytes, version);
  expect(inspection).toEqual({ output: { status: "unreadable", bytes: bytes.length }, refusal: { stage: "newline", newlines } });
  expect(JSON.stringify(inspection)).not.toMatch(/private|more|last|text/);
  expect(Object.values(inspection.refusal!.newlines!).every(count => Number.isInteger(count) && count >= 0 && count <= WINDOWS_NODE_FATAL_MAX_BYTES)).toBe(true);
});

it("caps newline inspection at the existing input bound and preserves refusal of double-CR source headers", () => {
  const text = header().replaceAll("\n", "\r\r\n");
  expect(parse(text)).toEqual({ status: "unreadable", bytes: Buffer.byteLength(text) });
  const bytes = Buffer.alloc(WINDOWS_NODE_FATAL_MAX_BYTES, 13), inspection = inspectWindowsNodeFatalOutput(bytes, version);
  expect(inspection.refusal).toEqual({ stage: "newline", newlines: { crlf: 0, doubledCrlf: 0, bareCr: WINDOWS_NODE_FATAL_MAX_BYTES, lf: 0 } });
  const oversized = inspectWindowsNodeFatalOutput(Buffer.concat([bytes, Buffer.from([13])]), version);
  expect(oversized).toEqual({ output: { status: "oversize", bytes: WINDOWS_NODE_FATAL_MAX_BYTES + 1 } });
});

it("returns only the pinned public filename and bounded line from a captured fatal header", () => {
  const text = "\n#\n" + header("C:\\private-user\\build-42\\node\\deps\\v8\\src\\base\\platform\\platform-win32.cc") +
    "# Check failed: private-user token=do-not-print\n#FailureMessage Object: 0xdeadbeef\nstack C:\\private-stack\\secret.cc\n";
  expect(parse(text)).toEqual({ status: "location", file, line: 42, bytes: Buffer.byteLength(text) });
  expect(JSON.stringify(parse(text))).not.toMatch(/private|token|Check|stack|deadbeef|build-42/);
  expect(Buffer.byteLength(JSON.stringify(parse(text)))).toBeLessThan(256);
});

it.each([
  "src/base/platform/platform-win32.cc",
  "..\\..\\src\\base\\platform\\platform-win32.cc",
  "/private-build/source/node/deps/v8/src/base/platform/platform-win32.cc",
  "/private-build/src/node/deps/v8/src/base/platform/platform-win32.cc",
])("strips build prefixes only at the complete known public V8 root: %s", source => {
  expect(parse(header(source))).toMatchObject({ status: "location", file, line: 42 });
});

it.each([
  "private.cc", "C:\\private-user\\secret.cc", "platform-win32.cc", "base/platform/platform-win32.cc",
  "deps/v8/src/base/platform/not-a-public-file.cc", "deps/v8/src/base/platform/platform-win32.cc.private",
  "deps/v8/src/base/platform/platform-win32.cc:stream", "deps/v8/src/base//platform/platform-win32.cc",
  "deps/v8/src/base/./platform/platform-win32.cc", "deps/v8/src/base/../base/platform/platform-win32.cc",
  "deps/v8/src/private/../../src/base/platform/platform-win32.cc", "src/private/../../src/base/platform/platform-win32.cc",
  "deps/v8/src/base/platform/platform-win32.cpp", "deps/v8/src/base/platform/PLATFORM-WIN32.cc",
])("withholds unknown, alternate or traversal-containing source names: %s", source => {
  const text = header(source), result = parse(text);
  expect(result).toEqual({ status: "unreadable", bytes: Buffer.byteLength(text) });
  expect(Object.keys(result).sort()).toEqual(["bytes", "status"]);
});

it("requires filename membership in the selected exact release rather than a union of versions", () => {
  const only22 = header("src/base/optional.h"), only24 = header("src/base/fpu.h");
  expect(parse(only22, "22.23.5")).toMatchObject({ status: "location", file: "deps/v8/src/base/optional.h" });
  expect(parse(only22, "24.21.0").status).toBe("unreadable");
  expect(parse(only24, "24.21.0")).toMatchObject({ status: "location", file: "deps/v8/src/base/fpu.h" });
  expect(parse(only24, "22.23.5").status).toBe("unreadable");
});

it.each(["", "v22.23.5", "22.23.4", "24.20.0", "__proto__", "private-version"])("refuses an unpinned release: %s", release => {
  expect(parse(header(), release)).toEqual({ status: "unreadable", bytes: Buffer.byteLength(header()) });
});

it.each([0, -1, 100001, 1000000, "NaN", "1e2", "42 private-message", "42.5"])("withholds an invalid or unbounded line: %s", line => {
  expect(parse(header(file, line))).toEqual({ status: "unreadable", bytes: Buffer.byteLength(header(file, line)) });
});

it("accepts only the bounded positive line range, without returning the build prefix", () => {
  for (const line of [1, 100_000]) expect(parse(header(file, line))).toMatchObject({ status: "location", file, line });
});

it.each([
  "", "\n#\n# Fatal error: private CHECK message with no location\n0x1234\n",
  "# Fatal error in , line 0\n# Check failed: private-message\n#FailureMessage Object: 0xabcdef\n",
  "# Safely terminating process due to error in src/base/logging.cc, line 12\n",
])("keeps absent or release-omitted locations absent without guessing from message text", text => {
  expect(parse(text)).toEqual({ status: "no-location", bytes: Buffer.byteLength(text) });
});

it("requires the exact anchored fatal header and accepts normal Windows newlines", () => {
  expect(parse("user said " + header())).toMatchObject({ status: "no-location" });
  expect(parse("  " + header())).toMatchObject({ status: "no-location" });
  expect(parse(header().replaceAll("\n", "\r\n"))).toMatchObject({ status: "location", file });
  expect(parse(header() + "raw\rprivate")).toMatchObject({ status: "unreadable" });
  expect(parse("# Fatal error in src/base/logging.cc\n")).toMatchObject({ status: "unreadable" });
});

it.each([
  header() + header(),
  header() + header("src/base/logging.h", 17),
  "# Fatal error in , line 0\n" + header(),
  header("private-unknown.cc") + header(),
])("refuses duplicate and conflicting fatal locations without returning any candidate", text => {
  expect(parse(text)).toEqual({ status: "ambiguous", bytes: Buffer.byteLength(text) });
});

it.each([
  Buffer.concat([Buffer.from(header()), Buffer.from([0xc3, 0x28])]),
  Buffer.from(header() + "\0private"), Buffer.from(header() + "\u001b[31mprivate"),
  Buffer.from(header("C:\\privat\u00e9\\deps\\v8\\src\\base\\logging.cc")),
  Buffer.from([0, 1, 2, 3, 255]),
])("rejects invalid UTF8, Unicode, NUL and binary data without returning captured bytes", bytes => {
  const result = parseWindowsNodeFatalOutput(bytes, version);
  expect(result).toEqual({ status: "unreadable", bytes: bytes.length });
  expect(JSON.stringify(result)).not.toMatch(/private|privat|logging|Fatal/);
});

it("caps input before decoding and bounds the oversized byte count", () => {
  expect(WINDOWS_NODE_FATAL_MAX_BYTES).toBe(65_536);
  const atLimit = Buffer.alloc(WINDOWS_NODE_FATAL_MAX_BYTES, 0x20); Buffer.from(header()).copy(atLimit);
  expect(parseWindowsNodeFatalOutput(atLimit, version)).toMatchObject({ status: "location", file, bytes: 65_536 });
  for (const length of [65_537, 128 * 1024]) expect(parseWindowsNodeFatalOutput(Buffer.alloc(length), version)).toEqual({ status: "oversize", bytes: 65_537 });
  expect(parseWindowsNodeFatalOutput("private" as unknown as Buffer, version)).toEqual({ status: "unreadable", bytes: 0 });
});

it("keeps a bounded receipt even when every non-header byte is private diagnostic text", () => {
  const text = "private-prompt private-env private-argv 0xdeadbeef\n".repeat(500) + header("src/base/logging.h", 99);
  const result = parse(text);
  expect(result).toMatchObject({ status: "location", file: "deps/v8/src/base/logging.h", line: 99 });
  expect(JSON.stringify(result)).not.toMatch(/private|prompt|env|argv|deadbeef/);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256);
});

it("records exact release-tree provenance and complete distinct ASCII source filename catalogs", () => {
  expect(sources.prefix).toBe("deps/v8/src/");
  expect(sources.versions["22.23.5"]).toMatchObject({ commit: "60553651579ec33ca1aef9e1eedab2c3855f1f7e", sourceTree: "2a6b4d309503bc9913dab633fd47dae60a2a7c1f", files: 2779, tagSignatureVerified: true });
  expect(sources.versions["24.21.0"]).toMatchObject({ commit: "955266bfdd854cd280dffd47548673914484e4c0", sourceTree: "c646810928449d9019cdbad4a3efbb177774928d", files: 2879, tagSignatureVerified: true });
  const flatten = (groups: Record<string, string[]>) => Object.entries(groups).flatMap(([directory, names]) => names.map(name => directory ? directory + "/" + name : name));
  for (const release of Object.values(sources.versions)) {
    const names = [...flatten(sources.commonFilesByDirectory), ...flatten(release.filesByDirectory)];
    expect(names).toHaveLength(release.files); expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:cc|h|inc)$/);
      expect(name.split("/")).not.toContain("."); expect(name.split("/")).not.toContain("..");
    }
    expect(release.sourceTreeUrl).toBe("https://api.github.com/repos/nodejs/node/git/trees/" + release.sourceTree + "?recursive=1");
  }
});
