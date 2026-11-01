/**
 * Non-Unicode shortcuts store their strings in the system's ANSI code page (#65): parseShellLink decodes them with
 * the decoder Windows gives (MultiByteToWideChar(CP_ACP)), so a cp1251 "C:\Apps\Привет\app.exe" stays Cyrillic and
 * the app is offered; without a decoder, or when it can't decode, the bytes are read as Latin-1, as before.
 */

import { describe, expect, it } from "vitest";
import { parseShellLink, type AnsiDecoder } from "../../app/main/platform/win32/system/lnk";
import { ansiLink, CP1251_PRIVET as CYRILLIC } from "./win32-system-fakes";

const ansiPath = Buffer.concat([Buffer.from("C:\\Apps\\", "latin1"), CYRILLIC, Buffer.from("\\app.exe\0", "latin1")]);

const cp1251: AnsiDecoder = bytes => new TextDecoder("windows-1251").decode(bytes);

describe("ANSI shortcut strings in the system code page (#65)", () => {
  it("decodes a non-Unicode LinkInfo path with the code page's decoder", () => {
    expect(parseShellLink(ansiLink(ansiPath), cp1251).target).toBe("C:\\Apps\\Привет\\app.exe");
  });

  it("decodes ANSI StringData (the description) the same way", () => {
    expect(parseShellLink(ansiLink(ansiPath, CYRILLIC), cp1251).description).toBe("Привет");
  });

  it("reads Latin-1 without a decoder, and when the decoder can't decode or throws", () => {
    const latin = "C:\\Apps\\Ïðèâåò\\app.exe";
    expect(parseShellLink(ansiLink(ansiPath)).target).toBe(latin);
    expect(parseShellLink(ansiLink(ansiPath), () => null).target).toBe(latin);
    expect(parseShellLink(ansiLink(ansiPath), () => { throw new Error("no code page"); }).target).toBe(latin);
  });

  it("never asks the decoder about Unicode strings or empty ones", () => {
    const asked: string[] = [];
    const spy: AnsiDecoder = b => { asked.push(b.toString("latin1")); return b.toString("latin1"); };
    parseShellLink(ansiLink(Buffer.from("C:\\x.exe\0", "latin1")), spy);
    expect(asked).toEqual(["C:\\x.exe"]);
  });
});
