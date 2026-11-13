/** Selected metadata, safe removal and explicit export preserve the existing project authorisation boundaries. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectSelection, removeProjectFile } from "../../app/main/agent/project";
import { exportProjectText } from "../../app/main/agent/project-export";
import { PROJECT_ACTIONS_MANAGED, projectManagedOff, projectUnavailable, PROJECT_COMMANDS_MANAGED, PROJECT_COMMANDS_OFF, projectAnswerParts, projectAnswerText, projectCommandsState, projectBytes, projectCommandsOn, projectConnectionText, projectSelectionText, workspaceOpened } from "../../app/renderer/home/project-copy";

let dir: string;
let privateDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-output-"));
  privateDir = path.join(dir, "profile");
  fs.mkdirSync(privateDir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it("reports stat-only sizes and removes exactly one selected basename without choosing a new path", async () => {
  const first = path.join(dir, "first.ts"), second = path.join(dir, "second.ts"), missing = path.join(dir, "moved.ts");
  fs.writeFileSync(first, "one"); fs.writeFileSync(second, "two!");
  expect(await projectSelection([first, second, missing])).toEqual({ names: ["first.ts", "second.ts", "moved.ts"], sizes: [3, 4, null] });
  const selected = [first, second];
  expect(removeProjectFile(selected, "first.ts")).toEqual([second]);
  expect(selected).toEqual([first, second]);
  for (const name of [first, "FIRST.ts", "../first.ts", "absent.ts", {}, null]) expect(() => removeProjectFile(selected, name)).toThrow("selected file");
  expect(await projectSelection(removeProjectFile([first], "first.ts"))).toEqual({ names: [], sizes: [] });
});

it("discloses known, missing and over-limit attachment sizes", () => {
  expect(projectBytes(12)).toBe("12 B");
  expect(projectBytes(1536)).toBe("1.5 KiB");
  expect(projectSelectionText(["one.ts", "two.ts"], [1024, 1024])).toBe("2 of 6 files · 2.0 KiB total. 24 KiB per file, 64 KiB per request.");
  expect(projectSelectionText(["moved.ts"], [null])).toContain("Size checked on Send");
  expect(projectSelectionText(["large.ts"], [25 * 1024])).toContain("exceeds the limit");
  expect(projectSelectionText(["a.ts", "b.ts", "c.ts"], [23 * 1024, 23 * 1024, 23 * 1024])).toContain("exceeds the limit");
});

it("says commands are off on this computer before a project command is typed, and only then (integrations-12)", () => {
  expect(PROJECT_COMMANDS_OFF).toBe("Commands are off on this computer. Turn them on in Commands to run one here.");
  expect(projectCommandsOn({ commands: {} })).toBe(false);
  expect(projectCommandsOn({ commands: { local: { on: false } } })).toBe(false);
  expect(projectCommandsOn({ commands: { "wsl:Ubuntu": { on: true } } })).toBe(false);
  expect(projectCommandsOn({ commands: { local: { on: true } } })).toBe(true);
  expect(projectCommandsOn(null)).toBe(false);
});

it("says the organisation turned commands off, never to turn on a switch the person can't (integrations-12)", () => {
  expect(PROJECT_COMMANDS_MANAGED).toBe("Your organisation has turned off commands on this computer.");
  expect(projectCommandsState({ commands: {} }, "off")).toBe("managed");
  expect(projectCommandsState({ commands: {} }, "on")).toBe("off");
  expect(projectCommandsState({ commands: {} }, undefined)).toBe("off");
  expect(projectCommandsState({ commands: { local: { on: true } } }, "ask")).toBe("on");
});

it("says the organisation turned Projects off with acting in apps, in the pane and from main, never that it is unavailable right now (integrations-r7-1)", () => {
  expect(PROJECT_ACTIONS_MANAGED).toBe("Your organisation has turned off Ember acting in apps, so Projects is off here.");
  expect(projectManagedOff({ features: { actions: false }, error: null })).toBe(true);
  expect(projectManagedOff({ features: {}, error: null })).toBe(false);
  expect(projectManagedOff({ features: { actions: true }, error: null })).toBe(false);
  expect(projectManagedOff(null)).toBe(false);
  // A lockdown turns actions off too, and says so itself at the top of the window.
  expect(projectManagedOff({ features: { actions: false }, error: "policy.json: unexpected token" })).toBe(false);
  expect(projectUnavailable({ managed: true, busy: false })).toBe(PROJECT_ACTIONS_MANAGED);
  expect(projectUnavailable({ managed: true, busy: true })).toBe(PROJECT_ACTIONS_MANAGED);
  // Another step under way says that (integrations-i6); the rest is said where it is seen.
  expect(projectUnavailable({ managed: false, busy: true })).toBe("Ember is still on the last project step. Wait for it to finish, or cancel it.");
  expect(projectUnavailable({ managed: false, busy: false })).toBe("Project work is unavailable right now.");
});

it("says only sending waits while Ember isn't connected, and that the person's work stays (integrations-r1)", () => {
  expect(projectConnectionText(false, { files: true, work: true })).toBe("Ember isn't connected right now. Your work here stays, and you can send once it connects.");
  expect(projectConnectionText(false, { files: false, work: true })).toBe("Ember isn't connected right now. Your work here stays, and you can send once it connects.");
  expect(projectConnectionText(false, { files: false, work: false })).toBe("Connect a model to work with project files.");
  expect(projectConnectionText(true, { files: true, work: true })).toBe("Review the selection before sending.");
  expect(projectConnectionText(true, { files: false, work: true })).toBe("Choose the files for this request.");
});

it("says why a draft offers no Apply and an answer won't go with the next send, never that a diff that applies couldn't be verified (integrations-c4-1)", () => {
  expect(projectAnswerText({ mode: "patch", patch: true, withheld: null, canContinue: true })).toBe("Patch ready to review.");
  expect(projectAnswerText({ mode: "patch", patch: false, withheld: null, canContinue: true })).toBe("Draft ready. Ember could not verify an exact patch to apply.");
  expect(projectAnswerText({ mode: "patch", patch: false, withheld: { name: "client.ts", line: 3 }, canContinue: true }))
    .toBe("Draft ready. Ember won't offer to apply it: line 3 of the patched client.ts appears to contain a password, token or key.");
  expect(projectAnswerText({ mode: "patch", patch: false, withheld: { name: "client.ts", line: null }, canContinue: false }))
    .toBe("Draft ready. Ember won't offer to apply it: the patched client.ts appears to contain a password, token or key. Ember won't include this answer on the next send either.");
  expect(projectAnswerText({ mode: "review", patch: false, withheld: null, canContinue: true })).toBe("Project answer ready.");
  expect(projectAnswerText({ mode: "review", patch: false, withheld: null, canContinue: false }))
    .toBe("Project answer ready. Ember won't include this answer on the next send, as it appears to contain a password, token or key.");
});

it("exports exact inert text only after the destination is chosen, privately and without staging residue", () => {
  const destination = path.join(dir, "answer.txt");
  const text = "<script>untrusted()</script>\n```diff\n--- a/file.ts\n```";
  exportProjectText(destination, text, privateDir, () => true);
  expect(fs.readFileSync(destination, "utf8")).toBe(text);
  if (process.platform !== "win32") expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  exportProjectText(destination, "explicit replacement", privateDir, () => true);
  expect(fs.readFileSync(destination, "utf8")).toBe("explicit replacement");
  expect(fs.readdirSync(dir).sort()).toEqual(["answer.txt", "profile"]);
});

it("rejects stale output, private storage, links and concurrent destination edits without overwriting them", () => {
  const destination = path.join(dir, "answer.txt");
  expect(() => exportProjectText(destination, "output", privateDir, () => false)).toThrow("cancelled");
  expect(fs.existsSync(destination)).toBe(false);
  expect(() => exportProjectText(path.join(privateDir, "settings.json"), "output", privateDir, () => true)).toThrow("outside");
  fs.writeFileSync(destination, "user version");
  expect(() => exportProjectText(destination, "model output", privateDir, () => true, [destination])).toThrow("approved patch");
  const current = vi.fn().mockReturnValueOnce(true).mockImplementation(() => { fs.writeFileSync(destination, "concurrent edit"); return true; });
  expect(() => exportProjectText(destination, "model output", privateDir, current)).toThrow("destination changed");
  expect(fs.readFileSync(destination, "utf8")).toBe("concurrent edit");
  if (process.platform !== "win32") {
    const link = path.join(dir, "link.txt");
    fs.symlinkSync(destination, link);
    expect(() => exportProjectText(link, "model output", privateDir, () => true)).toThrow("without links");
    expect(fs.readFileSync(destination, "utf8")).toBe("concurrent edit");
  }
  expect(fs.readdirSync(dir).filter(name => name.startsWith(".ember-export-"))).toEqual([]);
});


it("recognises complete fenced code while keeping HTML, incomplete fences and language labels inert", () => {
  expect(projectAnswerParts("A plan.\n```ts\nconst example = '<img src=x onerror=alert(1)>';\n```\nAfter.")).toEqual([
    { kind: "text", text: "A plan.\n" },
    { kind: "code", language: "ts", text: "const example = '<img src=x onerror=alert(1)>';" },
    { kind: "text", text: "After." },
  ]);
  expect(projectAnswerParts("```ts\nincomplete")).toEqual([{ kind: "text", text: "```ts\nincomplete" }]);
  expect(projectAnswerParts("<script>bad()</script>")).toEqual([{ kind: "text", text: "<script>bad()</script>" }]);
});

it("says what opening a saved workspace restored: its folder to choose again, and an answer left out since the provider's key changed (integrations-r9-3)", () => {
  expect(workspaceOpened("Greeting", { folderGone: false, answerLeft: false })).toBe("Opened workspace “Greeting”.");
  expect(workspaceOpened("Greeting", { folderGone: true, answerLeft: false })).toBe("Opened workspace “Greeting”. Choose the command folder again.");
  expect(workspaceOpened("Greeting", { folderGone: false, answerLeft: true })).toBe("Opened workspace “Greeting”. Its last answer was saved before this provider's key or settings changed, so Ember left it out.");
  expect(workspaceOpened("Greeting", { folderGone: true, answerLeft: true })).toBe("Opened workspace “Greeting”. Choose the command folder again. Its last answer was saved before this provider's key or settings changed, so Ember left it out.");
});
