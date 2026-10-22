/**
 * The import boundaries eslint.config.mjs enforces (Step 0a; critique integration-28, integration-11): electron only in
 * the files the owner's rule names, and no bare `node:path` where paths are a target's (they follow the target's
 * rules: `node:path/posix` or `node:path/win32`). ESLint's own API lints in-memory sources under file names that don't
 * exist, so nothing is written; the names are joined with this OS's separator, as ESLint receives them.
 */

import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { ESLint } from "eslint";

const root = path.resolve(__dirname, "../..");
const eslint = new ESLint({ cwd: root });

// The first lint loads the config and the TypeScript parser (about a second here, several on a busy CI runner running
// the whole suite): done once up front with room to spare, so no single test's 5 s budget pays for it.
beforeAll(async () => { await eslint.lintText("export {};\n", { filePath: path.join(root, "app", "main", "boundary-warm-up.ts") }); }, 60_000);

/** The rules that fired for `code` linted as the repository file `file`. */
async function rulesFor(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, ...file.split("/")) });
  return result.messages.map(m => m.ruleId ?? "(parse)");
}

const ELECTRON = 'import { app } from "electron";\nexport const name = app.getName();\n';
const BARE_PATH = 'import path from "node:path";\nexport const p = path.join("a", "b");\n';

describe("the electron import rule", () => {
  it("fires outside the allowed files", async () => {
    expect(await rulesFor("app/main/remote/boundary-check.ts", ELECTRON)).toContain("no-restricted-imports");
    expect(await rulesFor("app/main/platform/boundary-check.ts", ELECTRON)).toContain("no-restricted-imports");
    expect(await rulesFor("app/main/targets/boundary-check.ts", 'import type { WebContents } from "electron/main";\nexport type W = WebContents;\n')).toContain("no-restricted-imports");
  });

  it("lets main.ts, windows.ts, desk/view.ts and the preloads import it", async () => {
    for (const f of ["app/main/main.ts", "app/main/windows.ts", "app/main/desk/view.ts", "app/preload/command.ts"]) {
      expect(await rulesFor(f, ELECTRON), f).not.toContain("no-restricted-imports");
    }
  });
});

describe("the bare node:path rule", () => {
  it("fires in remote, commands and the WSL runner, also beside the electron rule", async () => {
    for (const f of ["app/main/remote/boundary-check.ts", "app/remote/boundary-check.ts", "app/main/commands/run/boundary-check.ts", "app/main/wsl/runner.ts"]) {
      expect(await rulesFor(f, BARE_PATH), f).toContain("no-restricted-imports");
      expect(await rulesFor(f, 'import path from "path";\nexport const p = path.sep;\n'), f).toContain("no-restricted-imports");
    }
    const both = await rulesFor("app/main/remote/boundary-check.ts", ELECTRON + 'import posix from "node:path";\nexport const q = posix.sep;\n');
    expect(both.filter(r => r === "no-restricted-imports")).toHaveLength(2);
  });

  it("allows the target-explicit path modules there, and node:path elsewhere", async () => {
    expect(await rulesFor("app/main/remote/boundary-check.ts", 'import posix from "node:path/posix";\nimport win32 from "node:path/win32";\nexport const s = posix.sep + win32.sep;\n')).toEqual([]);
    expect(await rulesFor("app/main/agent/boundary-check.ts", BARE_PATH)).toEqual([]);
  });
});
