/**
 * Settings › Memory while the organisation has memory off, or its policy has stopped Ember (memory-r9-3): what was
 * saved before is still on the computer, so its owner can still see it and forget it, and Ember never says "Nothing
 * remembered." over facts it keeps, nor that a GitHub check is what memory waits for.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryEpochAccount, MemoryOwner } from "../../app/main/memory/owner";
import { MemoryService } from "../../app/main/memory/service";
import { memoryViewOf } from "../../app/main/memory/view";
import { forgetReply, rememberNote } from "../../app/main/memory/questions";
import { memoryForgottenText, memoryManagedText } from "../../app/renderer/home/copy";
import { factsCount } from "../../app/renderer/home/forget-confirm";
import { memoryOwnerOffersErase, memoryOwnerText, memoryPausedReply } from "../../app/shared/memory-owner";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" }];

/** Yesterday: memory on, account 42 verified, two facts kept. Today: a new run. */
function saved() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memmanaged-"));
  const before = new MemoryOwner(dir);
  before.verify(42, true);
  const kept = new MemoryService({ dir, log: quiet });
  kept.remember("Has type 1 diabetes", USER, "I have type 1 diabetes");
  kept.remember("Works at Globex", USER, "I work at Globex");
  kept.stop();
  return { dir, owner: new MemoryOwner(dir), memory: new MemoryService({ dir, log: quiet }) };
}

describe("what Settings › Memory is given while the organisation has memory off (memory-r9-3)", () => {
  it("lists what was saved before for its verified owner, though the policy keeps memory off (memory-r9-3)", () => {
    const { owner, memory } = saved();
    // The policy has features.memory false: nothing new is bound (create false), and the same account is verified.
    owner.verify(42, false);
    const view = memoryViewOf({ consented: true, owner, epoch: 3, memory });
    expect(view.rows.map(r => r.text).sort()).toEqual(["Has type 1 diabetes", "Works at Globex"]);
    expect(view).toMatchObject({ ownership: "ready", reason: null, epoch: 3, trouble: null });
  });

  it("still lists nothing before consent, for another account, or with nobody verified (memory-r9-3)", () => {
    const { owner, memory } = saved();
    owner.verify(42, false);
    expect(memoryViewOf({ consented: false, owner, epoch: 0, memory }).rows).toEqual([]);
    owner.verify(7, false);
    expect(memoryViewOf({ consented: true, owner, epoch: 0, memory })).toMatchObject({ rows: [], ownership: "locked", reason: "other-account" });
    owner.pause("lockdown");
    expect(memoryViewOf({ consented: true, owner, epoch: 0, memory })).toMatchObject({ rows: [], ownership: "locked", reason: "lockdown", trouble: null });
  });
});

describe("what Memory says while the organisation's policy keeps it off (memory-r9-3)", () => {
  it("says the organisation turned memory off and that what was saved can still be seen and forgotten, never to be undone (memory-r9-3)", () => {
    expect(memoryManagedText(true)).toBe("Your organisation has turned memory off, so Ember keeps nothing new and uses none of this. What it saved before is still on this computer: you can see it and forget it here. A Forget can't be undone while memory is off.");
    expect(memoryManagedText(false)).toBe("Your organisation has turned memory off.");
    expect(memoryForgottenText("Works at Globex", 0, [], true)).toBe("Forgotten: “Works at Globex”. It can't be put back while your organisation has memory off.");
    expect(memoryForgottenText("Works at Globex", 1)).toBe("Forgotten: “Works at Globex”, and a note Ember made from it.");
  });

  it("gives a lockdown its own reason, never a GitHub check that will come back, and offers Forget everything for what is saved (memory-r9-3)", () => {
    expect(memoryOwnerText("lockdown", true)).toBe("Your organisation's policy has stopped Ember for now, so it can't check whose saved memory this is. It stays hidden on this computer, and Forget everything clears it.");
    expect(memoryOwnerText("lockdown", false)).toBe("Your organisation's policy has stopped Ember for now, so memory is off.");
    expect(memoryOwnerOffersErase("lockdown", true)).toBe(true);
    expect(memoryOwnerOffersErase("lockdown", false)).toBe(false);
    expect(memoryPausedReply("lockdown")).toEqual({ text: "Your organisation's policy has stopped me for now, so memory is off and I can't keep what you tell me.", open: false });
    expect(rememberNote("lockdown").text).toBe("Your organisation's policy has stopped me for now, so I won't keep this after Ember closes.");
    expect(forgetReply("lockdown")).toEqual({ text: "Your organisation's policy has stopped me for now, so I can't change what's saved.", open: false });
    // Memory is for no account then: Home lets go of a draft and of where focus was.
    const epoch = new MemoryEpochAccount();
    epoch.verified(42);
    expect(epoch.paused("lockdown")).toBe(true);
    // Forget everything's question counts what is saved as kept unless forgotten, never as nothing.
    expect(factsCount({ rows: [], ownership: "locked", reason: "lockdown", erasesOnSignOut: false })).toEqual({ state: "kept" });
  });

  it("is wired so in main and Home (main.ts and home/main.ts source) (memory-r9-3)", () => {
    const MAIN = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(MAIN).toContain("const memoryView = () => memoryViewOf({ consented: consented(), owner: memoryOwner, epoch: memoryEpoch, memory });");
    expect(MAIN).not.toContain("rows: memoryAllowed() && consented() && memoryOwner.ready ? memory.review() : [],");
    // Undo stays refused once the organisation turned memory off.
    expect(MAIN).toContain("const open = memoryOwner.ready && memoryAllowed() && consented();");
    const HOME = fs.readFileSync(path.join(__dirname, "../../app/renderer/home/main.ts"), "utf8");
    expect(HOME).toContain("memoryUndo = gone && !managed.has(\"memory\") ? { token: gone.undo, text: gone.text } : null;");
    expect(HOME).toContain("correct.hidden = !!row.until || managed.has(\"memory\");");
  });
});
