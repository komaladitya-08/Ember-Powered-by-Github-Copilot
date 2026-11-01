/**
 * Which sign-in Ember uses when one is refused (review #139), and the GitHub CLI asked for github.com's token, not the
 * GH_HOST or enterprise host's (review #143).
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

import { connectFirstAccepted, ghCliToken, resolveToken, type ResolvedToken } from "../../app/main/agent/auth";
import { explainStartError } from "../../app/main/agent/host";

const ENV_PAT = "github_pat_" + "e".repeat(30); // not a real token
const GH = "gho_" + "c".repeat(36); // not a real token

describe("the GitHub CLI's token", () => {
  const answer = (stdout: string, err: Error | null = null) => execFile.mockImplementationOnce((_cmd, _args, _opts, cb: (e: Error | null, out: string) => void) => cb(err, stdout));

  it("is github.com's, whatever GH_HOST or the default host says (Copilot is on github.com)", async () => {
    answer(`${GH}\n`);
    expect(await ghCliToken()).toBe(GH);
    expect(execFile).toHaveBeenLastCalledWith("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 3000 }, expect.any(Function));
  });

  it("is none when only an enterprise host is logged in (gh fails for github.com): the next source is used", async () => {
    answer("", new Error("no oauth token found for github.com"));
    expect(await resolveToken(null, {}, {})).toBeNull();
  });
});

describe("a refused sign-in", () => {
  it("says which environment variable a token came from", async () => {
    expect(await resolveToken(null, { GITHUB_TOKEN: ENV_PAT }, async () => GH)).toEqual({ token: ENV_PAT, source: "environment", name: "GITHUB_TOKEN" });
  });

  it("is skipped once refused, so a working GitHub CLI sign-in is reached", async () => {
    expect(await resolveToken(null, { GITHUB_TOKEN: ENV_PAT }, async () => GH, new Set([ENV_PAT]))).toEqual({ token: GH, source: "github-cli" });
    expect(await resolveToken(null, { GITHUB_TOKEN: ENV_PAT }, async () => ENV_PAT, new Set([ENV_PAT]))).toBeNull();
  });

  it("gives way to the next source when Copilot refuses it, and the last refusal stands when nothing else is left", async () => {
    const refused = new Set<string>();
    const tried: (string | null)[] = [];
    const sources: ResolvedToken[] = [{ token: ENV_PAT, source: "environment", name: "GITHUB_TOKEN" }, { token: GH, source: "github-cli" }];
    const find = async () => sources.find(s => !refused.has(s.token)) ?? null;
    // Copilot refuses the environment's token and accepts gh's.
    const start = async (t: ResolvedToken | null) => { tried.push(t?.token ?? null); return { phase: t?.token === GH ? "ready" : "error", refused: t?.token === ENV_PAT }; };
    const r = await connectFirstAccepted(find, start, refused);
    expect(r).toEqual({ phase: "ready", found: sources[1] });
    expect(tried).toEqual([ENV_PAT, GH]);
    expect([...refused]).toEqual([ENV_PAT]);
    // Both refused: the second one's error stands (no loop).
    refused.clear();
    tried.length = 0;
    const r2 = await connectFirstAccepted(find, async t => { tried.push(t?.token ?? null); return { phase: "error", refused: !!t }; }, refused);
    expect(r2).toEqual({ phase: "error", found: sources[1] });
    expect(tried).toEqual([ENV_PAT, GH]);
  });

  it("isn't skipped for a failure that isn't a refusal (offline: the same sign-in is retried later)", async () => {
    const refused = new Set<string>();
    const tried: (string | null)[] = [];
    const r = await connectFirstAccepted(async () => ({ token: ENV_PAT, source: "environment" }), async t => { tried.push(t?.token ?? null); return { phase: "error", refused: false }; }, refused);
    expect(r.phase).toBe("error");
    expect(tried).toEqual([ENV_PAT]);
    expect(refused.size).toBe(0);
  });

  it("is forgotten when the user signs out, so a GitHub CLI sign-in refused before is tried afresh (a new Copilot seat)", async () => {
    // As main: the GitHub CLI's token was refused (the account had no Copilot then), so looking for a sign-in passes it over.
    const refused = new Set([GH]);
    expect(await resolveToken(null, {}, async () => GH, refused)).toBeNull();
    // main's Sign out forgets the refusals with the sign-in in use, before the next "Connect with GitHub CLI" looks.
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\s+/g, " ");
    const signOut = /ipcMain\.handle\(IPC\.signOut, guard\(async \(\) => \{(.*?)\}\)\);/.exec(main)?.[1] ?? "";
    expect(signOut).toContain("currentToken = null;");
    expect(signOut).toContain("refusedTokens.clear();");
    refused.clear();
    expect(await resolveToken(null, {}, async () => GH, refused)).toEqual({ token: GH, source: "github-cli" });
  });

  it("names the variable in the message, and how to get past it", () => {
    const text = explainStartError(new Error("not authenticated"), { source: "environment", sourceName: "GITHUB_TOKEN" });
    expect(text).toMatch(/GITHUB_TOKEN/);
    expect(text).toMatch(/restart Ember/);
    // Other sources: as before.
    expect(explainStartError(new Error("not authenticated"), { source: "github-cli" })).toMatch(/\(the GitHub CLI sign-in\)/);
  });
});
