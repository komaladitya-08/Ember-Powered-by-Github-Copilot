import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodingSafety } from "../../app/main/agent/coding-safety";
import type { PreToolUseHookInput } from "../../app/main/agent/session-config";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe("coding native tool direct path checks", () => {
  it("refuses Ember private paths, symlink aliases, containing searches, and direct shell references", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-coding-safety-")); dirs.push(dir);
    const workspace = path.join(dir, "project"), secret = path.join(dir, "ember");
    await fs.mkdir(workspace); await fs.mkdir(secret); await fs.symlink(secret, path.join(workspace, "link"), "dir");
    const nativeOS = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    const shell = nativeOS === "win32" ? "powershell" : "bash";
    const guard = createCodingSafety({ workspace, home: dir, os: nativeOS, ember: { paths: [secret], pids: [], names: /^ember$/ } });
    const input = (toolName: string, toolArgs: unknown): PreToolUseHookInput => ({ sessionId: "s", timestamp: new Date(), workingDirectory: workspace, toolName, toolArgs });
    expect(await guard(input("view", { path: path.join(secret, "settings.json") }))).toContain("protected");
    expect(await guard(input("create", { path: "link/new-file" }))).toContain("protected");
    expect(await guard(input("grep", { path: dir, pattern: "secret" }))).toContain("protected");
    const file = path.join(secret, "settings.json");
    const quoted = shell === "powershell" ? `'${file.replaceAll("'", "''")}'` : `'${file.replaceAll("'", "'\\''")}'`;
    expect(await guard(input(shell, { command: shell === "powershell" ? `Get-Content -LiteralPath ${quoted}` : `cat -- ${quoted}` }))).toContain("protected");
    expect(await guard(input("view", { path: "src/index.ts" }))).toBeNull();
    expect(await guard(input(shell, { command: shell === "powershell" ? "Write-Output hello" : "printf hello" }))).toBeNull();
  });

  it("preserves Windows literal paths with backslashes, spaces and apostrophes in PowerShell", async () => {
    // The shell branch is lexical and uses the target's path rules, so this Windows regression also runs on Linux.
    const workspace = "C:\\Projects\\demo", home = "C:\\Users\\Ada Lovelace";
    const secret = `${home}\\AppData\\Roaming\\Ember's data`;
    const guard = createCodingSafety({ workspace, home, os: "win32", ember: { paths: [secret], pids: [], names: /^ember$/ } });
    const input = (file: string): PreToolUseHookInput => ({
      sessionId: "s", timestamp: new Date(), workingDirectory: workspace, toolName: "powershell",
      toolArgs: { command: `Get-Content -LiteralPath '${file.replaceAll("'", "''")}'` },
    });
    expect(await guard(input(`${secret}\\settings.json`))).toContain("protected");
    expect(await guard(input(`${secret.toUpperCase()}\\settings.json`))).toContain("protected");
    expect(await guard(input(`${workspace}\\ordinary notes.txt`))).toBeNull();
    expect(await guard(input(`${secret}-archive\\ordinary.txt`))).toBeNull();
  });
});
