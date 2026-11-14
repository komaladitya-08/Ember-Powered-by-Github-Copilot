/**
 * A password or a PIN said in an everyday word order is never kept as a fact (memory-r10-1): the value before its name
 * ("sunshine is my Netflix password"), the name then who uses it ("The password I use is sunshine"), the value set off
 * by commas ("I use the same password, sunshine, everywhere"), "has the password …", a phrase "as a password", and a
 * PIN's digits anywhere in its sentence ("My bank PIN is my birthday, 0412"). Memory's note promises it never keeps
 * passwords, codes or card numbers, however they are said; the guard must not depend on word order.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { factRefusal, saidSecret } from "../../app/main/memory/fact-guard";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

/** The re-rater's and the challenger's kept examples, then three neighbours of each. */
const WORD_ORDERS = [
  // The value before its name.
  "sunshine is my password", "sunshine is my Netflix password", "Sunshine is the Netflix password", "Fido was my old password",
  "\"purple rain\" is the Wi-Fi password", "Rex is their bank PIN", "bluebird is my email passphrase",
  // The name, then who uses it.
  "The password I use is sunshine", "The PIN they use is the same everywhere: sunshine", "The password she chose is bluebird", "The passcode we set was Fido",
  // A phrase as the password, or the value between commas.
  "I use sunshine as my password everywhere", "Uses purple monkey dishwasher as a password", "I use my dog's name Rex1 as my password",
  "Uses the cat's name Tibbles as the Netflix password", "I use the same password, sunshine, everywhere", "Has one password, bluebird, for everything",
  "Netflix password: same as the Wi-Fi, sunshine", "Password is the dog's name, Rex", "The Spotify password, Fido, is shared with the family",
  // "has the password …".
  "Has the password sunshine for Netflix", "Has the PIN 0412 on the bank card", "Got the password bluebird from IT", "Set the passcode as Fido",
  // A PIN or passcode's digits anywhere in its sentence.
  "My bank PIN is my birthday, 0412", "My PIN is the same as my birthday, 0412", "The PIN for my phone is my house number, 4821",
  "Their passcode matches the year we met, 1998", "My voicemail PIN, same as ever, is 4821",
  // "For <service> I use …" and a login that is a user and a value.
  "For Netflix I use sunshine", "For Gmail, I use bluebird", "The Netflix login is ram and sunshine",
  // A value shaped like a password, then what it is for (the challenger's "Remember: hunter2 for the VPN").
  "Remember: hunter2 for the VPN", "Winter2024 on Netflix", "Tr0ub4dor for the work laptop",
];

/** Facts about passwords and PINs with no value in them, which memory may keep. */
const NO_VALUE = [
  "Uses 1Password as their password manager", "Bitwarden is my password manager", "Netflix is my password manager's first entry",
  "Uses Bitwarden as a password manager", "Has the password manager open", "Has the password for Netflix written down somewhere safe",
  "Forgot their Netflix password", "Wants to reset the bank PIN", "Changed their password in 2024", "Prefers long passphrases",
  "The password I use for work expires monthly", "Asked how to change the PIN", "Has a PIN on the SIM card", "It is my password that expired",
  "For Netflix I use the family account", "Uses the same password manager everywhere", "Their password rules ask for 12 characters",
  "Python3 for the laptop", "Firefox for banking", "Remember: Chrome for Netflix",
  "Works at Globex", "Prefers short answers", "Was born in 1990",
];

describe("a password or PIN said in an everyday word order (memory-r10-1)", () => {
  it.each(WORD_ORDERS.map(s => [s]))("refuses %j as a fact (memory-r10-1)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it.each(NO_VALUE.map(s => [s]))("keeps %j, which holds no password (memory-r10-1)", text => {
    expect(saidSecret(text)).toBeNull();
  });

  it("keeps none of them through the remember tool, and writes none to memory.json (memory-r10-1)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memorder-"));
    const s = new MemoryService({ dir, log: quiet });
    for (const said of ["sunshine is my Netflix password", "My bank PIN is my birthday, 0412", "Has the password sunshine for Netflix"]) {
      expect(s.remember(said, USER, said)).toMatch(/^Not remembered/);
    }
    expect(s.remember("Priya is my wife, her PIN is the same as her birthday, 0412", [{ name: "Priya", kind: "person" }], "Priya is my wife, her PIN is the same as her birthday, 0412")).toMatch(/^Not remembered/);
    s.flush();
    expect(fs.existsSync(path.join(dir, "memory.json")) ? fs.readFileSync(path.join(dir, "memory.json"), "utf8") : "").not.toMatch(/sunshine|0412/);
    s.stop();
  });
});

/** The adversarial review's kept examples (r10-memory-x10-1), then three neighbours of each shape. */
const ANY_ORDER = [
  "sunshine's my Netflix password", "sunshine — that's my Netflix password", "My Netflix password? sunshine.",
  "the password for Netflix, if you need it, is sunshine", "My Gmail password is the same as my Netflix one: sunshine",
  "I always use sunshine for my passwords", "Netflix password → sunshine", "My pwd is sunshine", "Netflix pw sunshine",
  "Netflix login: ram / sunshine", "Sunshine99 is what I type for Netflix", "Use sunshine when Netflix asks for my password",
  "Type sunshine into Netflix's password box", "My Netflix password used to be sunshine and still is",
  // Neighbours.
  "bluebird's the Gmail password", "Fido — that's the bank PIN", "The Wi-Fi password? bluebird", "Gmail pwd bluebird",
  "The PIN for the bank, in case you need it, is Fido", "Spotify password -> bluebird", "Gmail login: ram / bluebird",
  "bluebird is what I use for Gmail", "Enter bluebird when Spotify asks for a password", "Put Fido in the PIN box",
  "Their passcode has always been bluebird", "Mot de passe Netflix: soleil", "Contraseña de Netflix es sol123",
];

/** Facts that name a password or a PIN beside everyday words, with no value in them, kept as before (r10-memory-x10-1). */
const NAMES_ONLY = [
  "Has the password for Netflix written down somewhere safe", "The password I use for work expires monthly", "Their PIN is in the drawer",
  "Forgot their Gmail password again yesterday", "Keeps every password in a notebook at home", "Wants a stronger password for the bank",
  "Changes the Netflix password every few months", "Needs a new PIN for the debit card", "Their password has 16 characters",
  "Locked out after typing the wrong password three times", "Got a password reset email from Netflix", "Uses 1Password for passwords",
];

describe("a password or PIN said with its value anywhere in the clause (r10-memory-x10-1)", () => {
  it.each(ANY_ORDER.map(s => [s]))("refuses %j as a fact (r10-memory-x10-1)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it.each(NAMES_ONLY.map(s => [s]))("keeps %j, which names a password but holds none (r10-memory-x10-1)", text => {
    expect(saidSecret(text)).toBeNull();
  });
});
