import { describe, expect, it } from "vitest";
import { inspectWindowsNodeSourceFatalOutput } from "../fixtures/windows-node-source-fatal";

const inspect = (text: string) => inspectWindowsNodeSourceFatalOutput(Buffer.from(text));
const assertion = (file = "C:\\private-user\\private-build\\src\\node_platform.cc", line = "104",
  text = "(0) == (uv_thread_create(t.get(), start_thread, this))") =>
  `\n  #  C:\\private-user\\source-node.exe[12345]: private signature at ${file}:${line}\n  #  Assertion failed: ${text}\n\n`;
const stack = "----- Native stack trace -----\n\n 1: 00007FF6ABCDEF01 node::Assert+123 [C:\\private-user\\private-build]\n 2: 00007FF6ABCDEF02 node::PlatformInit+456\n";

describe("source-built Node public fatal signature codes", () => {
  it("leaves zero output and the original libuv failure contract unchanged", () => {
    expect(inspect("")).toEqual({ output: { status: "no-location", bytes: 0 } });
    expect(inspect("WSAStartup: (10107) private message\r\r\n")).toMatchObject({ nativeFailure: { operation: "WSAStartup", code: 10107 } });
  });
  it("reports only pinned public site/check codes from a Node assertion pair", () => {
    const result = inspect(assertion() + stack);
    expect(result.nodeDiagnostic).toEqual({ format: 1, site: 2, line: 104, check: 1, nativeFrames: 2, publicFrames: [1, 3] });
    for (const secret of ["private-user", "private-build", "private signature", "12345", "ABCDEF", "uv_thread_create"])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("classifies direct native-backtrace output without inferring a failed API", () => {
    expect(inspect(stack).nodeDiagnostic).toEqual({ format: 3, nativeFrames: 2, publicFrames: [1, 3] });
  });
  it("recognizes only public OOM constants and does not return fatal message text", () => {
    expect(inspect("FATAL ERROR: private location Allocation failed - JavaScript heap out of memory\n").nodeDiagnostic).toEqual({ format: 2, reason: 1 });
    expect(inspect("FATAL ERROR: private location Allocation failed - process out of memory\n").nodeDiagnostic).toEqual({ format: 2, reason: 2 });
    expect(inspect("FATAL ERROR: private arbitrary message\n").nodeDiagnostic).toEqual({ format: 2 });
  });
  it("does not invent a public location or check for unknown/private source files", () => {
    expect(inspect(assertion("C:\\private\\secret.cc")).nodeDiagnostic).toEqual({ format: 1 });
    expect(inspect(assertion("C:\\private\\src\\node_platform.cc", "783")).nodeDiagnostic).toEqual({ format: 1 });
    expect(inspect(assertion("C:\\private\\src\\node_platform.cc", "104", "private unknown expression")).nodeDiagnostic).toEqual({ format: 1, site: 2, line: 104 });
  });
  it.each(["C:\\private\\src\\..\\src\\node_platform.cc", "C:\\private\\src\\other\\src\\node_platform.cc", "C:\\private\\src\\.\\node_platform.cc"])("refuses unsafe or recovered public suffix %s", file => {
    expect(inspect(assertion(file)).nodeDiagnostic).toEqual({ format: 1 });
  });
  it("does not grant a check code to another otherwise public site", () => {
    expect(inspect(assertion("..\\src\\node.cc", "104")).nodeDiagnostic).toEqual({ format: 1, site: 1, line: 104 });
  });
  it("requires the exact paired Node assertion format", () => {
    expect(inspect("  #  Assertion failed: private message\n").nodeDiagnostic).toBeUndefined();
    expect(inspect("private prefix\n" + assertion().split("\n").slice(2).join("\n")).nodeDiagnostic).toBeUndefined();
    expect(inspect(assertion().replace(" at ", " around ")).nodeDiagnostic).toBeUndefined();
  });
  it("marks multiple public headers ambiguous without copying any content", () => {
    expect(inspect(assertion() + assertion()).nodeDiagnostic).toEqual({ format: 4 });
    expect(inspect(assertion() + "FATAL ERROR: private\n").nodeDiagnostic).toEqual({ format: 4 });
  });
  it("does not accept arbitrary embedded names or malformed native frame numbers", () => {
    expect(inspect(stack.replace("node::Assert", "private::node::Assert")).nodeDiagnostic?.publicFrames).toEqual([3]);
    expect(inspect(stack.replace(" 2:", " 3:")).nodeDiagnostic).toBeUndefined();
    expect(inspect(stack.replace("00007FF6ABCDEF01", "private-address")).nodeDiagnostic).toBeUndefined();
    expect(inspect(stack + "\n" + stack).nodeDiagnostic).toBeUndefined();
  });
  it.each(["\x00", "\x1b", "\x7f", "é", "\r"])("preserves base encoding/newline refusal for %j", invalid => {
    const result = inspect(assertion() + invalid);
    expect(result.nodeDiagnostic).toBeUndefined(); expect(result.output.status).toBe("unreadable");
  });
  it("does not exceed the original output bound", () => {
    expect(inspect(assertion() + "x".repeat(65536)).output.status).toBe("oversize");
  });
  it("supports only the base parser's observed newline normalization", () => {
    expect(inspect(assertion().replaceAll("\n", "\r\r\n")).nodeDiagnostic).toMatchObject({ format: 1, site: 2, check: 1 });
    expect(inspect(assertion().replaceAll("\n", "\r\r\r\n")).nodeDiagnostic).toBeUndefined();
  });
});
