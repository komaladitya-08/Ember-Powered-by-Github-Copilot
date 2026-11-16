import { expect, it } from "vitest";
import { classifyWindowsNodeCngInprocessOutput } from "../fixtures/windows-node-cng-inprocess-output";

const file = "D:\\fixed-owned-tree\\tools\\lpac-cng-inprocess.test.cjs";
const message = `Could not find '${file}'`;
it.each(["\n", "\r\n"])("classifies only the exact known filename and newline%j", newline => {
  expect(classifyWindowsNodeCngInprocessOutput(Buffer.from(message + newline), file)).toBe(1);
});
it.each([
  "", message, message + "\r", message + "\r\r\n", message + "\n\n", "prefix " + message + "\n", message + "\nstack",
  message.replace("lpac-", "host-") + "\n", message.replace("Could not find", "could not find") + "\n",
  message.replaceAll("\\", "/") + "\n", "\uFEFF" + message + "\n", message + "\0\n",
])("leaves every changed message shape unknown (%#)", value => {
  expect(classifyWindowsNodeCngInprocessOutput(Buffer.from(value), file)).toBe(0);
});
it("does not decode invalid UTF8, UTF16, oversized or foreign values", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from(message + "\n", "utf16le"), Buffer.alloc(65537), null, {}]) {
    expect(classifyWindowsNodeCngInprocessOutput(bytes as Buffer, file)).toBe(0);
  }
});
it("does not resolve a different, noncanonical or control-bearing host filename", () => {
  for (const value of [file.replace("fixed-owned", "another-owned"), file.replace("\\tools", "\\.\\tools"), "relative.test.cjs", "D:/fixture/test.cjs", file + "\n", file + "\u200b", file + "\ud800", null, {}]) {
    expect(classifyWindowsNodeCngInprocessOutput(Buffer.from(message + "\n"), value as string)).toBe(0);
  }
});
