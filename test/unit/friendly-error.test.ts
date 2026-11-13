/**
 * friendlyError for the errors that used to reach the bubble raw (review #219, #23): timeouts, a long conversation's
 * token limit, a bare status code, and anything else unrecognised (said plainly with a next step; the raw text goes to
 * the log only).
 */

import { describe, expect, it } from "vitest";
import { friendlyError, problemTitle } from "../../app/main/agent/presenter";

describe("friendlyError: what used to show raw", () => {
  it("a timeout is Copilot taking too long, not a code error", () => {
    expect(friendlyError("Request timed out after 60000ms")).toBe("Copilot took too long to answer. Try again in a moment.");
    expect(friendlyError("Error: timeout of 30000ms exceeded")).toBe("Copilot took too long to answer. Try again in a moment.");
    // A network timeout is still the network.
    expect(friendlyError("connect ETIMEDOUT 140.82.112.5:443")).toMatch(/can't reach Copilot/);
  });

  it("anything unrecognised gets a next step, and none of the raw text", () => {
    for (const raw of ["Cannot read properties of undefined (reading 'content')", "Unexpected token < in JSON at position 0", "Session not found: 7f3c", "Something odd {\"x\":1}"]) {
      const said = friendlyError(raw, undefined, { settingsKey: "Ctrl+Alt+E" });
      expect(said).toBe("Copilot reported a problem. Try again; if it keeps happening, check Copilot in Ember's settings (Ctrl+Alt+E).");
    }
    expect(friendlyError("odd", undefined, { provider: true })).toMatch(/ reported a problem\. Try again/);
    expect(friendlyError("odd", undefined, { provider: true })).not.toMatch(/odd/);
  });

  it("a conversation the runtime couldn't write to disk is this computer's disk, not the model service (reliability-c7-3)", () => {
    // What the runtime reports with the data folder's disk full (errorType "persistence"); the cause may or may not be in it.
    const persist = "Failed to persist session events: GenericFailure, Failed to append to JSONL file /home/u/.config/ember/copilot/session-state/ember-conductor-1/events.jsonl: Failed to back up recoverable JSONL";
    const full = "I couldn't save this conversation: the disk (or your storage quota) is full. Free some space, then ask again.";
    for (const provider of [false, true, "user"] as const) {
      expect(friendlyError(`${persist}: ENOSPC: no space left on device, write`, "persistence", { provider })).toBe(full);
      expect(friendlyError(`${persist}: No space left on device (os error 28)`, undefined, { provider })).toBe(full);
      expect(friendlyError(`${persist}: EDQUOT: disk quota exceeded, write`, undefined, { provider })).toBe(full);
      const said = friendlyError(persist, "persistence", { provider });
      expect(said).toBe("I couldn't save this conversation on this computer. Check that its disk has free space, then ask again.");
      // No path, and nothing sends the person to the model's settings.
      expect(said).not.toMatch(/events\.jsonl|model service|Copilot/);
      expect(problemTitle(said, provider)).toBe("I couldn't save this conversation");
      expect(problemTitle(full, provider)).toBe("I couldn't save this conversation");
    }
  });

  it("says a full disk as the conversation's only where saving it failed, and never for the model service's own error (reliability-x7-2)", () => {
    const save = /couldn't save this conversation/;
    // The user's own model server ran out of room: its problem, with the way to Models & connections, as before.
    const theirs = friendlyError('HTTP 500: {"error":"write /root/.ollama/models/blobs/x: no space left on device"}', "query", { provider: "user" });
    expect(theirs).not.toMatch(save);
    expect(theirs).not.toMatch(/disk/);
    expect(friendlyError("no space left on device", undefined, { provider: "user", statusCode: 500 })).not.toMatch(/disk/);
    // A task's worker session that couldn't start on a full disk: the disk, but no conversation failed to save.
    const start = friendlyError("Request session.create failed with message: session construction failed: ENOSPC: No space left on device (os error 28)");
    expect(start).toBe("This computer's disk (or your storage quota) is full, so I couldn't go on. Free some space, then ask again.");
    expect(problemTitle(start)).toBe("The disk is full");
    expect(problemTitle(start, "user")).toBe("The disk is full");
    // A conversation that couldn't be written for want of permission isn't told to free space, and names no path.
    const denied = friendlyError("Failed to persist session events: EACCES: permission denied, open '/home/u/.config/ember/copilot/x'", "persistence");
    expect(denied).toBe("I couldn't save this conversation: I'm not allowed to write in my data folder on this computer. Check the folder's permissions, then ask again.");
    expect(problemTitle(denied)).toBe("I couldn't save this conversation");
    expect(friendlyError("Failed to persist session events: EROFS: read-only file system, write", "persistence")).toBe(denied);
    // A bare "os error 28" beside something else is no full disk.
    expect(friendlyError("curl: (28) Operation timed out; os error 28")).not.toMatch(/disk|save/);
  });

  it("a long conversation's token limit says so", () => {
    for (const raw of ["CAPIError: 400 prompt token count of 140000 exceeds the limit of 128000", "Error: 400 {\"error\":{\"code\":\"model_max_prompt_tokens_exceeded\"}}"]) {
      expect(friendlyError(raw)).toMatch(/conversation may have got too long/);
      expect(friendlyError(raw)).toMatch(/New conversation/);
      expect(friendlyError(raw)).not.toMatch(/quit|reopen/i);
    }
    // Context exhaustion is the conversation's too (review of #184); only a request that is itself too long keeps the short advice.
    for (const raw of ["context length exceeded", "Error: context window limit reached"]) expect(friendlyError(raw)).toMatch(/New conversation/);
    expect(friendlyError("request too long")).toBe("That was too much for me to handle at once. Try a shorter request.");
  });

  it("a local file failure when the runtime's session starts is this computer's, never Copilot's problem or a full disk (reliability-r9-3)", () => {
    const WRITE = "I couldn't go on: this computer didn't let me read or write a file I need. Check that my data folder can be written, then ask again.";
    const OPEN = "This computer has too many files open, so I couldn't go on. Close a few apps, then ask again.";
    const WATCH = "This computer has run out of file watchers, so I couldn't go on. Close a few apps, then ask again.";
    expect(friendlyError("session construction failed: EROFS: read-only file system (os error 30)")).toBe(WRITE);
    expect(friendlyError("session construction failed: Permission denied (os error 13)")).toBe(WRITE);
    expect(friendlyError("Failed to create session: Operation not permitted (os error 1)")).toBe(WRITE);
    expect(friendlyError("EACCES: permission denied, open '/home/u/.config/ember/copilot/x'")).toBe(WRITE);
    expect(friendlyError("session construction failed: Too many open files (os error 24)")).toBe(OPEN);
    expect(friendlyError("EMFILE: too many open files, watch")).toBe(OPEN);
    expect(friendlyError("ENOSPC: System limit for number of file watchers reached, watch '/home/u/project'")).toBe(WATCH);
    for (const said of [WRITE, OPEN, WATCH]) expect(said).not.toMatch(/\/home|os error|Copilot/);
    // A saved conversation that the system wouldn't let be written is the data folder's permissions (reliability-y7-2).
    expect(friendlyError("Failed to persist session events: Operation not permitted (os error 1)", "persistence")).toBe("I couldn't save this conversation: I'm not allowed to write in my data folder on this computer. Check the folder's permissions, then ask again.");
    // The model service's own refusal is still the service's: a status, and no errno of this computer's.
    expect(friendlyError("403 Permission denied for this model")).not.toBe(WRITE);
    expect(friendlyError("HTTP 500: EACCES while writing the cache", undefined, { provider: "user" })).not.toBe(WRITE);
    expect(friendlyError("permission denied")).not.toBe(WRITE);
    // A real full disk is still the disk.
    expect(friendlyError("ENOSPC: no space left on device, write")).toBe("This computer's disk (or your storage quota) is full, so I couldn't go on. Free some space, then ask again.");
  });

  it("a bare status code is a refused request, with what to try", () => {
    expect(friendlyError("Error: 400 {\"error\":{\"message\":\"\"}}")).toBe("Copilot refused that request (400). Try asking in other words.");
    expect(friendlyError("422")).toBe("Copilot refused that request (422). Try asking in other words.");
  });
});
