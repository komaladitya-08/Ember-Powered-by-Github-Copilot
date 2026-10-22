/**
 * Decoding wsl.exe's output (app/main/wsl/decode.ts, design §4.1): the inbox wsl.exe writes UTF-16LE, the Store WSL
 * writes UTF-8 under WSL_UTF8=1, and the encoding is sniffed per output (NULs at odd offsets), byte-order marks
 * dropped; lines lose their CR, are trimmed and empty ones dropped; error exits become one plain sentence.
 */

import { describe, expect, it } from "vitest";
import { decodeLines, decodeMessage, decodeWsl, isUtf16le } from "../../app/main/wsl/decode";
import { utf16 } from "./wsl-wa-fakes";

describe("decodeWsl", () => {
  it("reads the inbox wsl.exe's UTF-16LE with and without a byte-order mark", () => {
    expect(decodeWsl(utf16("Ubuntu\r\nDebian\r\n", true))).toBe("Ubuntu\r\nDebian\r\n");
    expect(decodeWsl(utf16("Ubuntu\r\nDebian\r\n"))).toBe("Ubuntu\r\nDebian\r\n");
    expect(isUtf16le(utf16("x", true))).toBe(true);
  });

  it("reads UTF-8 (WSL_UTF8=1, and what commands print) and drops a UTF-8 byte-order mark", () => {
    expect(decodeWsl(Buffer.from("Wird ausgeführt\n", "utf8"))).toBe("Wird ausgeführt\n");
    expect(decodeWsl(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Ubuntu", "utf8")]))).toBe("Ubuntu");
    expect(isUtf16le(Buffer.from("日本語のテキスト", "utf8"))).toBe(false);
  });

  it("tells UTF-16LE from UTF-8 when the first 64 bytes are all non-Latin characters", () => {
    const japanese = "ディストリビューションが実行されていませんディストリビューションが実行されていません。\r\n";
    expect(utf16(japanese).subarray(0, 64).includes(0)).toBe(false);
    expect(decodeWsl(utf16(japanese))).toBe(japanese);
    expect(decodeWsl(Buffer.from(japanese, "utf8"))).toBe(japanese);
  });

  it("gives empty text for empty output and survives an odd trailing byte", () => {
    expect(decodeWsl(Buffer.alloc(0))).toBe("");
    expect(decodeLines(Buffer.alloc(0))).toEqual([]);
    expect(decodeWsl(Buffer.concat([utf16("ab"), Buffer.from([0x41])]))).toBe("ab");
  });
});

describe("decodeLines", () => {
  it("strips CR, trims and drops empty lines (CRLF output of either encoding)", () => {
    const text = "  NAME      STATE     VERSION\r\n* Ubuntu    Running   2\r\n\r\n  Debian    Stopped   1\r\n";
    const want = ["NAME      STATE     VERSION", "* Ubuntu    Running   2", "Debian    Stopped   1"];
    expect(decodeLines(utf16(text, true))).toEqual(want);
    expect(decodeLines(Buffer.from(text, "utf8"))).toEqual(want);
  });

  it("drops stray NULs left in a line", () => {
    expect(decodeLines(Buffer.from("Ubuntu\0\n", "utf8"))).toEqual(["Ubuntu"]);
  });
});

describe("decodeMessage", () => {
  it("turns an error exit's UTF-16LE text into one plain sentence", () => {
    const err = utf16("There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n");
    expect(decodeMessage(err)).toBe("There is no distribution with the supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND");
  });

  it("removes terminal codes and control characters and cuts long text with an ellipsis", () => {
    expect(decodeMessage(Buffer.from("\x1b[31mchdir(/nope) failed 2\x1b[0m\x07\n", "utf8"))).toBe("chdir(/nope) failed 2");
    expect(decodeMessage(Buffer.from("\x1b]0;title\x07ok", "utf8"))).toBe("ok");
    const long = decodeMessage(Buffer.from("x".repeat(500), "utf8"), 100);
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is empty when there is nothing to say", () => {
    expect(decodeMessage(Buffer.from("\r\n \r\n", "utf8"))).toBe("");
  });
});
