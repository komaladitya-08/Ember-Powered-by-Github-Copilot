/**
 * A password or a PIN as a topic is no value (memory-r11-2): an IT, helpdesk or security person's role ("IT support:
 * password resets and laptops"), a project ("Works on the password reset flow at Globex") or a device ("Tests the PIN
 * pad firmware") is kept, in Tell Ember about you and as any fact. Round ten's clause reader refused any word beside a
 * password's name; it still refuses a value said there, however the topic words stand round it.
 */

import { describe, expect, it } from "vitest";
import { factRefusal } from "../../app/main/memory/fact-guard";
import { MemoryGraph } from "../../app/main/memory/graph";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService } from "../../app/main/memory/service";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

/** The re-rater's refused roles and work facts, then neighbours of each. */
const TOPICS = [
  "IT support: password resets and laptops", "Service desk analyst, mostly password resets", "Bank cashier, I help customers with PIN resets",
  "Security engineer on sign-in and passwords at Globex", "Identity team lead, passwords and passkeys", "Helpdesk, I unlock accounts and reset passwords",
  "Sysadmin, I manage the LDAP passwords", "Works on the password reset flow at Globex", "Is building the PIN entry screen for the banking app",
  "Owns the passwords service team", "Is writing the password policy for Globex", "Tests the PIN pad firmware at Verifone",
  // Neighbours.
  "Desktop support, password unlocks and printers", "Runs password audits for the council", "Teaches staff about password hygiene",
  "Product owner for PIN management at Barclays", "Helps customers who forget passwords", "Engineer on the passwordless team at Okta",
  "Writes guidance on passphrases for the NCSC", "Support analyst handling PIN unblocks for card holders", "Prefers tokens over passwords",
];

/** A value said beside those topic words: still refused. */
const VALUES = [
  "IT support: password resets, the admin password is bluebird", "Password reset code: Summer2024", "Helpdesk, my password is sunshine",
  "My passwords are sunshine and rainbow", "Password resets: sunshine", "Reset passwords to tangerine", "The PIN pad code is 4821",
  "Service desk, the PIN is 0412", "Password policy: hunter2 for everyone", "Passwords sunshine and rainbow", "Password reset sunshine",
  "IT support, passwords: bluebird", "The LDAP passwords are tangerine", "PIN pad 4821",
];

describe("a password or a PIN as a topic", () => {
  it.each(TOPICS.map(s => [s]))("keeps %j, which names passwords as work, not a value (memory-r11-2)", text => {
    expect(factRefusal(text)).toBeNull();
    expect(new MemoryGraph().add({ text: `Role and work: ${text}`, about: USER, source: "user" }).kind).toBe("added");
  });

  it.each(VALUES.map(s => [s]))("still refuses %j, a value beside those words (memory-r11-2)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it("keeps an IT support role told in Tell Ember about you (memory-r11-2)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-topics-"));
    const s = new MemoryService({ dir, log: quiet });
    const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet });
    expect(l.introduce({ name: "Ram", work: "IT support: password resets and laptops" })).toBe(2);
    expect(s.list().map(i => i.text)).toContain("Role and work: IT support: password resets and laptops");
    s.stop();
  });
});
