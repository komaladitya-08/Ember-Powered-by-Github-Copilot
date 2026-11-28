/**
 * The coding window's words (app/renderer/code/copy.ts): pinned, in sentence case with curly quotes round names,
 * never raw SDK text where Ember speaks, and the window's page set up as the design system asks.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "../../app/renderer/code/copy";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");

describe("the coding window's words", () => {
  it("names the SDK's modes as the Copilot app does, and says why a change didn't apply", () => {
    expect(["interactive", "plan", "autopilot"].map(copy.agentModeName)).toEqual(["Interactive", "Plan", "Autopilot"]);
    expect(["manual", "assisted", "allow-all"].map(copy.permissionModeName)).toEqual(["Ask every time", "Assisted", "Approve all"]);
    expect(copy.modeRefused("permission", "allow-all", "manual", "Your organisation turns it off.")).toBe("“Approve all” wasn't applied, so “Ask every time” stays in force. Your organisation turns it off.");
    expect(copy.modeRefused("effort", "xhigh", undefined)).toBe("“Extra high” wasn't applied.");
  });

  it("names a session's state in words beside its mark, and in its row's name", () => {
    expect(copy.sessionLabel({ name: "Fix it", isolation: "worktree", branch: "ember/fix", pinned: true }, "needs-you")).toBe("Fix it, worktree ember/fix. Pinned. Needs you");
    expect(copy.sessionLabel({ name: " ", isolation: "folder", pinned: false }, "idle")).toBe("New session");
    expect(copy.sidebarEmpty("lo", false)).toBe("No sessions match “lo”.");
    expect(copy.archivedLink(3)).toBe("Archived (3)");
  });

  it("titles tool rows by what they did, and ends a command with its exit code and the sandbox", () => {
    const base = { args: null, state: "done", fileEdits: [] as { path: string }[] };
    expect(copy.toolTitle({ ...base, tool: "bash", command: "ls" })).toBe("Ran a command");
    expect(copy.toolTitle({ ...base, tool: "edit", args: { path: "/a/src/b.ts" }, state: "running" })).toBe("Changing src/b.ts…");
    expect(copy.toolTitle({ ...base, tool: "grep", args: { pattern: "redirect", path: "src" } })).toBe("Searched for “redirect” in src");
    expect(copy.toolTitle({ ...base, tool: "web_fetch", args: { url: "https://x.y" }, state: "failed" })).toBe("Couldn't fetch https://x.y");
    expect(copy.toolTitle({ ...base, tool: "x", mcp: { server: "gh", tool: "merge" } })).toBe("Used “merge” from “gh”");
    expect(copy.toolTitle({ ...base, tool: "task", agent: { displayName: "Explore" } })).toBe("Sub-agent “Explore”");
    expect(copy.toolEnd({ state: "failed", exitCode: 1, sandboxed: true })).toBe("Failed, exit code 1. Ran in the sandbox.");
    expect(copy.agentState({ state: "done", totalToolCalls: 1, durationMs: 4200 })).toBe("Finished: 1 step in 4 s.");
  });

  it("puts an error in a plain sentence with the SDK's remedy, never the SDK's own text", () => {
    expect(copy.problemLead("error")).toBe("Copilot ran into a problem and stopped this turn.");
    expect(copy.remedy("sign_in")).toBe("Sign in to GitHub again, then try again.");
    expect(copy.remedy("allow_sandbox_outbound")).toBe("Let the sandbox reach the internet (Customise › Sandbox), then try again.");
    expect(copy.remedy("unknown")).toBe("");
    expect(["on", "no-network", "off", undefined].map(copy.sandboxWords)).toEqual(["In the sandbox", "In the sandbox, without the network", "Outside the sandbox", ""]);
  });

  it("words a card's records by who answered", () => {
    expect(copy.permissionRecord({ kind: "approved-for-session" }, "user")).toBe("Allowed for this session, by you.");
    // The runtime's own record of a one-time yes (permission.completed's result), as the real window gets it.
    expect(copy.permissionRecord({ kind: "approved" }, "user")).toBe("Allowed once, by you.");
    expect(copy.permissionRecord({ kind: "denied-interactively-by-user" }, "companion")).toBe("Not allowed, by Ember's companion.");
    expect(copy.planRecord({ approved: true, selectedAction: "autopilot" }, "user")).toBe("Start on Autopilot: chosen by you.");
    expect(copy.decisionLabel("approve-for-session", "url")).toBe("Allow this site for the session");
    expect(copy.asksSaid("Change a file?", "Fix it")).toBe("Copilot asks in “Fix it”: Change a file?");
  });

  it("uses straight apostrophes, curly quotes and no tracked capitals", () => {
    const src = read("app/renderer/code/copy.ts");
    expect(src).not.toMatch(/’/);
    for (const value of Object.values(copy)) {
      if (typeof value !== "string") continue;
      expect(value, value).not.toMatch(/"[^"]+"/);
      expect(value, value).not.toMatch(/\b[A-Z]{4,}\b/);
    }
  });
});

describe("the coding window's page", () => {
  it("links the shared design system first, with Ember's content-window CSP and no inline styles or markup from text", () => {
    const html = read("app/renderer/code/index.html");
    expect(html).toContain('<html lang="en" class="content">');
    expect(html).toContain(`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`);
    expect(html.indexOf("../shared/ember.css")).toBeLessThan(html.indexOf("styles.css\""));
    expect(html).toContain("<title>Ember</title>");
    for (const f of fs.readdirSync("app/renderer/code").filter(f => f.endsWith(".ts"))) expect(read(`app/renderer/code/${f}`).replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("is built with the other pages, and its preload when there is one", () => {
    const build = read("scripts/build-app.mjs");
    expect(build).toContain('const pages = ["home", "overlay", "handle", "ask", "mic", "desk", "command", "prompt", "vault", "code"];');
    expect(build).toContain("entryPoints: pages.map(p => ({ in: `app/preload/${p}.ts`, out: p })),");
  });
});
