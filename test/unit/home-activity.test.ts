/**
 * "What Ember did" for commands, SSH connections and WSL (review #152, #224), and reasons in the user's own words
 * (review #217): describeEntry turns real-shaped audit entries (the ones commands/flow.ts and remote/connections.ts
 * write) into lines, and the window asks main for every entry it keeps, so lines it can't show don't crowd out the rest.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ACTIVITY_LINES, activityLines, activityNote, activityProblemText, describeEntry, userWords, withCommandShells } from "../../app/renderer/home/copy";
import { ACTIVITY_ENTRIES, ACTIVITY_MAX_ENTRIES, recentLimit, type ActivityEntry } from "../../app/shared/ipc";

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
    // The act has one name everywhere: settings' "Remove helper" button is "Remove Ember's helper from build-01" (#191).
    expect(describeEntry(remote({ step: "failed", kind: "cancelled", uninstall: true }))).toMatchObject({ what: "Remove Ember's helper from build-01", why: "You cancelled it." });
    expect(describeEntry(remote({ step: "uninstalled" }))).toEqual({ tag: "Removed", cls: "ok", what: "Ember's helper from build-01" });
    // A card shown, and the start of a connection: the line after it says how it went.
    expect(describeEntry(remote({ step: "prompt", kind: "password" }))).toBeNull();
    expect(describeEntry(remote({ step: "connect", interactive: true, reconnect: false }))).toBeNull();
    expect(describeEntry({ t, event: "wsl", step: "connected", distro: "Ubuntu" })).toEqual({ tag: "Connected", cls: "ok", what: "Ubuntu (WSL)" });
  });

  it("shows a reconnect's tries as one line, when it gives up, so they don't crowd out the rest (review #152)", () => {
    // Newest first, as main sends them: lost, then about 24 tries over 10 minutes, then the end of trying.
    const tries = Array.from({ length: 24 }, () => remote({ step: "failed", kind: "network", reconnect: true }));
    const entries = [remote({ step: "gave-up", kind: "network" }), ...tries, remote({ step: "lost" }), remote({ step: "connected", ms: 900 })];
    expect(entries.map(e => describeEntry(e)).filter(Boolean)).toEqual([
      { tag: "Didn't work", cls: "no", what: "Reconnect to build-01", why: "Ember couldn't reach it." },
      { tag: "Lost", cls: "no", what: "build-01", why: "The connection dropped." },
      { tag: "Connected", cls: "ok", what: "build-01" },
    ]);
    // A connect the user started still says how it went.
    expect(describeEntry(remote({ step: "failed", kind: "network" }))).toMatchObject({ tag: "Didn't work", what: "Connect to build-01" });
  });

  it("asks main for every entry it keeps, so lines it can't show don't empty the list", () => {
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    const audit = readFileSync(new URL("../../app/main/policy/audit.ts", import.meta.url), "utf8");
    expect(main).toContain("ipcMain.handle(IPC.activity, guard((limit: unknown) => audit?.recent(recentLimit(limit)) ?? []));");
    const kept = Number(/static readonly KEEP = (\d+);/.exec(audit)?.[1]);
    expect(recentLimit(undefined)).toBeGreaterThanOrEqual(kept);
  });
});

describe("What Ember did: the whole record, a page at a time (safety-privacy-5)", () => {
  const now = new Date(2026, 10, 7, 15, 0);
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const click = (minutesAgo: number, app = "gedit"): ActivityEntry => ({ t: at(minutesAgo), event: "action", kind: "click", app, ok: true, element: { role: "push button", name: "Save" } });

  it("counts every line of today, not only those drawn", () => {
    // 120 actions in the last hour, then a task from yesterday with an allowed Send.
    const entries = [
      ...Array.from({ length: 120 }, (_, i) => click(i * 0.5)),
      { t: at(24 * 60), event: "confirm", kind: "click", app: "thunderbird", answer: "once", element: { role: "push button", name: "Send" } },
      { t: at(24 * 60 + 1), event: "decision", kind: "click", app: "thunderbird", verdict: "confirm", reason: "it sends", element: { role: "push button", name: "Send" } },
      { t: at(24 * 60 + 2), event: "task", phase: "asked", goal: "Send the report" },
    ];
    const lines = activityLines(entries, undefined, now);
    expect(lines).toHaveLength(123);
    expect(activityNote(lines, false)).toBe("120 today");
    // The second page starts with yesterday's heading and its allowed Send.
    expect(ACTIVITY_LINES).toBe(80);
    const second = lines.slice(ACTIVITY_LINES * 1, ACTIVITY_LINES * 2);
    expect(second.filter(l => l.day === "Today")).toHaveLength(40);
    expect(second[40]).toMatchObject({ day: "Yesterday", view: { tag: "You allowed", what: "Click “Send” in Thunderbird" } });
  });

  it("says at least so many today while the record read may hold more of today", () => {
    const lines = activityLines(Array.from({ length: 500 }, (_, i) => click(i * 0.1)), undefined, now);
    expect(activityNote(lines, true)).toBe("At least 500 today");
    expect(activityNote(lines, false)).toBe("500 today");
    expect(activityNote([], true)).toBe("");
  });

  it("reads more of the record only in whole pages, and never past the most it may", () => {
    expect(recentLimit(undefined)).toBe(ACTIVITY_ENTRIES);
    expect(recentLimit(ACTIVITY_ENTRIES * 3)).toBe(ACTIVITY_ENTRIES * 3);
    for (const bad of [-1, 0, 1.5, "1000", ACTIVITY_MAX_ENTRIES + 1, Number.NaN, {}]) expect(recentLimit(bad), String(bad)).toBe(ACTIVITY_ENTRIES);
    expect(recentLimit(ACTIVITY_MAX_ENTRIES)).toBe(ACTIVITY_MAX_ENTRIES);
  });
});

describe("What Ember did: tags and names (safety-privacy-10, safety-privacy-v2)", () => {
  it("tells a lasting grant from a one-off yes, and says what it changes", () => {
    const send = { t, event: "confirm", kind: "click", app: "gedit", element: { role: "push button", name: "Save" } };
    expect(describeEntry({ ...send, answer: "once" })).toEqual({ tag: "You allowed", cls: "ok", what: "Click “Save” in gedit" });
    expect(describeEntry({ ...send, answer: "always" })).toEqual({ tag: "Always allowed", cls: "ok", what: "Click “Save” in gedit", why: "From now on Ember may act in gedit without asking first, but it still asks before anything hard to undo." });
  });

  it("names a password manager it refused to read as people say it", () => {
    expect(describeEntry({ t, event: "decision", verdict: "deny", kind: "read", app: "keepassxc", reason: "this app is on the user's never-look list" }))
      .toEqual({ tag: "Refused", cls: "no", what: "Read in KeePassXC", why: "This app is on your never-look list." });
    expect(describeEntry({ t, event: "decision", verdict: "deny", kind: "read", app: "1password", reason: "r" })?.what).toBe("Read in 1Password");
    expect(describeEntry({ t, event: "decision", verdict: "deny", kind: "read", app: "seahorse", reason: "r" })?.what).toBe("Read in Passwords and Keys");
  });
});

describe("What Ember did: when the record can't be read (home-10)", () => {
  it("says the list may be old, or that nothing can show yet, and where the whole record is", () => {
    expect(activityProblemText(true)).toBe("Ember couldn't read its record just now, so this list may be out of date. It tries again every few seconds; the whole record is in the folder below.");
    expect(activityProblemText(false)).toBe("Ember couldn't read its record just now, so nothing can show here yet. It tries again every few seconds; the whole record is in the folder below.");
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
    // "the user's" that ends a clause is "yours", not "your" (decide.ts' reason for a tainted task).
    expect(userWords("It asks first: an earlier step in the task wasn't the user's.")).toBe("It asks first: an earlier step in the task wasn't yours.");
    expect(userWords("It asks first: an earlier step in the task wasn't the user's; it deletes or overwrites data."))
      .toBe("It asks first: an earlier step in the task wasn't yours; it deletes or overwrites data.");
    expect(userWords("the choice is the user's")).toBe("The choice is yours.");
    expect(userWords("The user's")).toBe("Yours.");
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
    // decide.ts' exact reason once a task is tainted (commands-decide.test.ts pins it there).
    expect(describeEntry(cmd({ phase: "decided", shell: "bash", verdict: "ask", reason: "It asks first: commands here run as an administrator; the organisation asks for every command; the user asked to check every command; it deletes or overwrites data; it may carry text Ember read elsewhere in the task; an earlier step in the task wasn't the user's." }))?.why)
      .toBe("It asks first: commands here run as an administrator; the organisation asks for every command; you asked to check every command; it deletes or overwrites data; it may carry text Ember read elsewhere in the task; an earlier step in the task wasn't yours.");
    expect(describeEntry(cmd({ phase: "decided", shell: "bash", verdict: "ask", reason: "It asks first: an earlier step in the task wasn't the user's." }))?.why)
      .toBe("It asks first: an earlier step in the task wasn't yours.");
  });
});
