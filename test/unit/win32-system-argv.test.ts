/**
 * splitWindowsArgs: a shortcut's argument string split the way CommandLineToArgvW splits it, so the terminal check
 * sees what a shortcut really starts. The cases are Microsoft's documented examples (where the C runtime and
 * CommandLineToArgvW agree) plus the quote-run rule CommandLineToArgvW keeps.
 */

import { describe, expect, it } from "vitest";
import { splitWindowsArgs } from "../../app/main/platform/win32/system/argv";

describe("splitWindowsArgs", () => {
  it("splits on spaces and tabs outside quotes, and drops leading and trailing blanks", () => {
    expect(splitWindowsArgs("  /k   vsdevcmd.bat\t-arch=x64 ")).toEqual(["/k", "vsdevcmd.bat", "-arch=x64"]);
    expect(splitWindowsArgs("")).toEqual([]);
    expect(splitWindowsArgs("   ")).toEqual([]);
  });

  it("keeps quoted spaces and removes the quotes (Microsoft's examples)", () => {
    expect(splitWindowsArgs("\"a b c\" d e")).toEqual(["a b c", "d", "e"]);
    expect(splitWindowsArgs("\"ab\\\"c\" \"\\\\\" d")).toEqual(["ab\"c", "\\", "d"]);
    expect(splitWindowsArgs("a\\\\\\b d\"e f\"g h")).toEqual(["a\\\\\\b", "de fg", "h"]);
    expect(splitWindowsArgs("a\\\\\\\"b c d")).toEqual(["a\\\"b", "c", "d"]);
    expect(splitWindowsArgs("a\\\\\\\\\"b c\" d e")).toEqual(["a\\\\b c", "d", "e"]);
  });

  it("keeps backslashes that don't come before a quote, as in Windows paths", () => {
    expect(splitWindowsArgs("\"C:\\Program Files\\App\\\" --dir C:\\Users\\me\\")).toEqual(["C:\\Program Files\\App\" --dir C:\\Users\\me\\"]);
    expect(splitWindowsArgs("--dir C:\\Users\\me\\ --x")).toEqual(["--dir", "C:\\Users\\me\\", "--x"]);
  });

  it("gives an empty word for empty quotes", () => {
    expect(splitWindowsArgs("a \"\" b")).toEqual(["a", "", "b"]);
  });

  it("makes every third quote of a run a literal quote", () => {
    expect(splitWindowsArgs("\"a\"\"\"b\"")).toEqual(["a\"b"]);
    // Four quotes: open, close, a literal quote, and the fourth opens a quoted part that runs to the end.
    expect(splitWindowsArgs("\"\"\"\" x")).toEqual(["\" x"]);
  });
});
