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

/** A value after a topic phrase, by a copula, "all", a verb or a credential's own word (r11-memory-x11-1), then neighbours. */
const AFTER_TOPIC = [
  "My password reset code is tangerine", "Netflix password reset code is tangerine", "Bank password reset code is tangerine",
  "The password reset code for the bank is tangerine", "Gmail password reset is tangerine", "Wi-Fi password reset is tangerine",
  "Router password reset is tangerine", "Password reset is sunshine", "Password reset was tangerine", "Password reset now is tangerine",
  "Password recovery is tangerine", "Password unlock is tangerine", "Password reset is Tangerine", "Password reset is correct horse battery staple",
  "Passwords all are tangerine", "Passwords all tangerine", "Password resets are marmalade", "Password changes always to marmalade",
  "Passwords at home all start with marmalade",
  // Neighbours.
  "Passwords in the office all say marmalade", "Passwords aren't marmalade", "Password reset is marmalade now", "Password reset link code is tangerine",
  "The password reset code is tangerine", "Password resets and changes are marmalade", "PIN resets at the bank are marmalade",
  "Password policy at Globex is marmalade", "Password reset answer for Netflix: kingfisher", "Password resets always use marmalade",
  // A value used before the topic.
  "Use tangerine for password resets", "Types marmalade on the PIN pad", "I set kingfisher for the password reset", "Picked Tangerine for PIN resets",
];

/** A value after a phrase that says where or for whom (r11-memory-y11-1): a phrase names one thing, and a further word is the value. */
const AFTER_PHRASE = [
  "Passwords for my laptop marmalade", "Passwords on the router marmalade", "Passwords on my router tangerine", "Passwords for home tangerine",
  "Passwords in the office tangerine", "Passwords for Netflix tangerine", "Passwords for Gmail and Netflix tangerine",
  "Passwords for the family tangerine", "Passwords for the kids sunflower and daisy", "Passwords of my kids sunflower and daisy",
  "The passwords for the kids sunflower", "Passwords around the house sunflower", "Shared passwords at home tangerine",
  "Wi-Fi passwords for the cabin sunflower", "Passwords used at home sunflower", "Passwords at work begin marmalade",
  "Password reset at the bank tangerine", "Password resets at Globex tangerine", "Password resets for Globex Bluebird77",
  "Password reset in Okta sunflower", "Password reset by phone sunflower", "Password recovery from Gmail sunflower",
  "Password policy for the office Bluebird", "PIN pad at the shop Bluebird", "Password resets across the office sunflower",
  "Handles password resets on the Netflix account marmalade", "I handle password resets; the default is marmalade",
];

describe("a password or a PIN as a topic", () => {
  it.each(AFTER_PHRASE.map(s => [s]))("refuses %j, a value after a where-or-for-whom phrase (r11-memory-y11-1)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it.each(AFTER_TOPIC.map(s => [s]))("refuses %j, a value after the topic's words (r11-memory-x11-1)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

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
