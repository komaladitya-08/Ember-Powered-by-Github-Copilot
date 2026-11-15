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
    const guard = createCodingSafety({ workspace, home: dir, os: "linux", ember: { paths: [secret], pids: [], names: /^ember$/ } });
    const input = (toolName: string, toolArgs: unknown): PreToolUseHookInput => ({ sessionId: "s", timestamp: new Date(), workingDirectory: workspace, toolName, toolArgs });
    expect(await guard(input("view", { path: path.join(secret, "settings.json") }))).toContain("protected");
    expect(await guard(input("create", { path: "link/new-file" }))).toContain("protected");
    expect(await guard(input("grep", { path: dir, pattern: "secret" }))).toContain("protected");
    expect(await guard(input("bash", { command: `cat ${secret}/settings.json` }))).toContain("protected");
    expect(await guard(input("view", { path: "src/index.ts" }))).toBeNull();
    expect(await guard(input("bash", { command: "printf hello" }))).toBeNull();
  });
});
