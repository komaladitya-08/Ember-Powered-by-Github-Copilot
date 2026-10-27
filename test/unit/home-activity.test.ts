/**
 * "What Ember did" for commands, SSH connections and WSL (review #152, #224), and reasons in the user's own words
 * (review #217): describeEntry turns real-shaped audit entries (the ones commands/flow.ts and remote/connections.ts
 * write) into lines, and the window asks main for every entry it keeps, so lines it can't show don't crowd out the rest.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeEntry, userWords, withCommandShells } from "../../app/renderer/home/copy";
import type { ActivityEntry } from "../../app/shared/ipc";

const t = "2026-10-27T10:00:00.000Z";
const cmd = (e: Record<string, unknown>): ActivityEntry => ({ t, event: "command", task: "t1", target: "ssh:build-01", ...e });

describe("What Ember did: commands", () => {
  it("says where a command ran, how it ended, and never shows the command itself", () => {
    expect(describeEntry(cmd({ phase: "ended", runId: "r1", ended: "exit", code: 0, signal: null, ms: 120 })))
      .toEqual({ tag: "Done", cls: "ok", what: "Run a command on build-01" });
    expect(describeEntry(cmd({ phase: "ended", runId: "r1", ended: "exit", code: 2, signal: null, ms: 120 })))
      .toEqual({ tag: "Didn't work", cls: "no", what: "Run a command on build-01", why: "It ended with exit code 2." });
    expect(describeEntry(cmd({ phase: "ended", ended: "stopped-user", code: null })))
      .toMatchObject({ tag: "Stopped", cls: "no", why: "You stopped it." });
    expect(describeEntry(cmd({ phase: "ended", ended: "timeout", code: null }))).toMatchObject({ tag: "Didn't work", why: "It ran out of time." });
    expect(describeEntry(cmd({ phase: "ended", ended: "refused-remote", code: null, needsConfirm: false })))
      .toMatchObject({ tag: "Refused", cls: "no", why: "build-01's own check refused it." });
    const decided = describeEntry(cmd({ phase: "decided", shell: "bash", cwd: "/home/ana/proj", command: "rm -rf build", verdict: "ask", reason: "It asks first: it deletes files." }));
    expect(decided).toEqual({ tag: "Asked you", cls: "ask", what: "Run a bash command on build-01", why: "It asks first: it deletes files." });
    expect(JSON.stringify(decided)).not.toContain("rm -rf");
  });

  it("shows a refusal, a question and its answer, and leaves out the steps another line already says", () => {
    expect(describeEntry(cmd({ phase: "decided", shell: "powershell", target: "local", verdict: "refuse", reason: "Ember won't run this: it would change Ember's own safety settings." })))
      .toEqual({ tag: "Refused", cls: "no", what: "Run a PowerShell command on this computer", why: "Ember won't run this: it would change Ember's own safety settings." });
    expect(describeEntry(cmd({ phase: "answered", answer: "once", q: "card" }))).toEqual({ tag: "You allowed", cls: "ok", what: "Run a command on build-01" });
    expect(describeEntry(cmd({ phase: "answered", answer: "deny", q: "card" }))).toEqual({ tag: "You said no", cls: "no", what: "Run a command on build-01" });
    expect(describeEntry(cmd({ phase: "answered", answer: "expired", q: "card" }))).toMatchObject({ tag: "No answer", cls: "no" });
    expect(describeEntry(cmd({ phase: "answered", answer: "once", q: "consent", target: "wsl:Ubuntu" })))
      .toEqual({ tag: "You allowed", cls: "ok", what: "Turn on commands in Ubuntu (WSL)" });
    expect(describeEntry(cmd({ phase: "answered", answer: "deny", q: "announce" }))).toMatchObject({ tag: "Stopped", why: "You stopped it before it started." });
    expect(describeEntry(cmd({ phase: "decided", shell: "bash", verdict: "announce", reason: "The user's own words asked for this (push)." })))
      .toMatchObject({ tag: "Announced", what: "Run a bash command on build-01", why: "Your own words asked for this (push)." });
    // An ordinary command's decision, its start, a change of folder and its taint note: the end line says it.
    for (const phase of ["started", "cd", "tainted"]) expect(describeEntry(cmd({ phase })), phase).toBeNull();
    expect(describeEntry(cmd({ phase: "decided", shell: "bash", verdict: "run", reason: "An ordinary command." }))).toBeNull();
  });

  it("carries the shell from a command's decision to its answer and its end", () => {
    // Newest first, as main sends them; another task's command on another computer keeps its own shell.
    const entries = withCommandShells([
      cmd({ phase: "ended", ended: "exit", code: 0 }),
      cmd({ task: "t2", target: "local", phase: "ended", ended: "exit", code: 0 }),
      cmd({ phase: "answered", answer: "once", q: "card" }),
      cmd({ task: "t2", target: "local", phase: "decided", shell: "powershell", verdict: "run" }),
      cmd({ phase: "decided", shell: "zsh", verdict: "ask", reason: "r" }),
    ]);
    expect(entries.map(e => describeEntry(e)?.what ?? null)).toEqual([
      "Run a zsh command on build-01", "Run a PowerShell command on this computer", "Run a zsh command on build-01", null, "Run a zsh command on build-01",
    ]);
  });
});

describe("What Ember did: other computers", () => {
  const remote = (e: Record<string, unknown>): ActivityEntry => ({ t, event: "remote", host: "build-01", ...e });
  it("shows connections made, lost, ended and failed, and Ember removed", () => {
    expect(describeEntry(remote({ step: "connected", ms: 900 }))).toEqual({ tag: "Connected", cls: "ok", what: "build-01" });
    expect(describeEntry(remote({ step: "lost" }))).toEqual({ tag: "Lost", cls: "no", what: "build-01", why: "The connection dropped." });
    expect(describeEntry(remote({ step: "disconnected" }))).toEqual({ tag: "Ended", cls: "", what: "Connection to build-01" });
    expect(describeEntry(remote({ step: "failed", kind: "auth" }))).toEqual({ tag: "Didn't work", cls: "no", what: "Connect to build-01", why: "It needed you to sign in." });
    expect(describeEntry(remote({ step: "failed", kind: "protocol" }))).toEqual({ tag: "Didn't work", cls: "no", what: "Connect to build-01" });
    expect(describeEntry(remote({ step: "failed", kind: "cancelled", uninstall: true }))).toMatchObject({ what: "Remove Ember from build-01", why: "You cancelled it." });
    expect(describeEntry(remote({ step: "uninstalled" }))).toEqual({ tag: "Removed", cls: "ok", what: "Ember from build-01" });
    // A card shown, and the start of a connection: the line after it says how it went.
    expect(describeEntry(remote({ step: "prompt", kind: "password" }))).toBeNull();
    expect(describeEntry(remote({ step: "connect", interactive: true, reconnect: false }))).toBeNull();
    expect(describeEntry({ t, event: "wsl", step: "connected", distro: "Ubuntu" })).toEqual({ tag: "Connected", cls: "ok", what: "Ubuntu (WSL)" });
  });

  it("asks main for every entry it keeps, so lines it can't show don't empty the list", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    const audit = readFileSync(new URL("../../app/main/policy/audit.ts", import.meta.url), "utf8");
    const asked = Number(/IPC\.activity, guard\(\(\) => audit\?\.recent\((\d+)\)/.exec(main)?.[1]);
    const kept = Number(/static readonly KEEP = (\d+);/.exec(audit)?.[1]);
    expect(asked).toBeGreaterThanOrEqual(kept);
  });
});

describe("What Ember did: reasons in your words (review #217)", () => {
  it("starts with a capital, ends with a full stop and speaks to you", () => {
    expect(userWords("this app is on the user's never-look list")).toBe("This app is on your never-look list.");
    expect(userWords("The user moved the mouse or pressed a key, so Ember let go.")).toBe("You moved the mouse or pressed a key, so Ember let go.");
    expect(userWords("your organisation has turned off Ember acting in apps")).toBe("Your organisation has turned off Ember acting in apps.");
    expect(userWords("first action in Mousepad; not something the user asked for")).toBe("First action in Mousepad; not something you asked for.");
    expect(userWords("the user has said no to this before")).toBe("You have said no to this before.");
    expect(userWords("Is it done?")).toBe("Is it done?");
    // A name stays as it is written.
    expect(userWords("build-01's own check refused it")).toBe("build-01's own check refused it.");
    expect(userWords(undefined)).toBeUndefined();
    expect(userWords("  ")).toBeUndefined();
  });

  it("is how every line gives its reason", () => {
    expect(describeEntry({ t, event: "decision", verdict: "deny", kind: "click", reason: "this app is on the user's never-look list", app: "keepassxc" })?.why)
      .toBe("This app is on your never-look list.");
    expect(describeEntry({ t, event: "action", kind: "toggle", ok: false, error: "it didn't turn on" })?.why).toBe("It didn't turn on.");
    expect(describeEntry({ t, event: "action", kind: "click", ok: false, error: "no window known yet" })?.why).toBe("No window known yet.");
    expect(describeEntry({ t, event: "decision", kind: "cursor_text", verdict: "confirm", batch: 2, at: 1, batchVerdict: "deny", batchReason: "the user's keyboard is in use" })?.why)
      .toBe("Your keyboard is in use.");
    expect(describeEntry({ t, event: "task", phase: "failed", goal: "Tidy up", summary: "the window closed before Ember finished" })?.why).toBe("The window closed before Ember finished.");
  });
});
