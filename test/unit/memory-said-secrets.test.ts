/**
 * A password, PIN or key said with a verb instead of its name, or under a name the guard lacked, is never kept as a
 * fact (memory-r9-4): "Signs in to Netflix with … and Winter#2024", "Unlocks their phone with 482913", "The client
 * secret is …", "My memorable word is …". Memory's note promises it never keeps passwords, codes or card numbers,
 * however they are said. `factRefusal` (fact-guard.ts) is what every fact passes: `memoryRefusal`, then these.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { factRefusal, saidSecret } from "../../app/main/memory/fact-guard";
import { MemoryGraph } from "../../app/main/memory/graph";
import { memoryRefusal } from "../../app/main/memory/guard";
import { MemoryLearning } from "../../app/main/memory/learning";
import { MemoryService } from "../../app/main/memory/service";

const quiet = { info: () => undefined, warn: () => undefined };
const USER = [{ name: "User", kind: "person" as const }];

/** In the first person, and in the third person memory writes facts in. */
const WITH_A_VERB = [
  "I sign in to Netflix with ram@example.com and Winter#2024", "Signs in to Netflix with ram@example.com and Winter#2024",
  "I log in to the router as admin with Summer2024!", "Logs in to the router as admin with Summer2024!", "Logs in as admin with Summer2024!",
  "Signs in with jsmith / Winter#2024", "Logs into Jira as ram with Winter#2024", "Signs on to the mainframe using Tr0ub4dor&3",
  "I unlock my phone with 482913", "Unlocks their phone with 482913", "My phone unlocks with 482913", "Unlocks the phone with 4821",
  "The laptop unlocks with Summer2024!", "Gets into the office with 4821#", "Disarms the alarm with 4821", "I open the garage with 4821",
  "Opens the garage with 4821", "Opens the front door with the code 4821",
  "Types Summer2024! to unlock the laptop", "Enters 4821 at the gate", "Enters 4821 on the alarm panel", "Keys in 4821 to disarm the alarm",
  "Uses Winter#2024 to sign in to Jira", "Uses hunter2 for Netflix", "Uses Summer2024! for the work VPN", "Netflix uses hunter2",
  "Uses admin / Summer2024! on the router",
];
const PAIRS_AND_PLACES = [
  "Jira: ram / Winter#2024", "Jira login ram / Winter#2024", "Router: admin / Summer2024!",
  "The front door is 4821", "Front door: 4821", "Front door 4821", "The office door is 4821", "The alarm is 4821", "The gym's code is 4821",
  "The code is 4821", "My code is 4821", "The combination is 4821", "The combination is 32-18-04", "My phone unlock pattern is 1-4-7-8-9",
  "The work VPN is Summer2024!", "Work laptop: Summer2024!", "FileVault: Summer2024!", "BitLocker is 482913-482913", "The Wi-Fi is BlueSky99",
  "My Wi-Fi is HomeNet and the key is BlueSky99",
];
const UNDER_OTHER_NAMES = [
  "My authenticator secret is JBSWY3DPEHPK3PXP", "The 2FA secret for GitHub is JBSWY3DPEHPK3PXP", "2FA setup key: JBSWY3DPEHPK3PXP",
  "Authenticator setup key for Google is JBSW Y3DP EHPK 3PXP", "My authenticator key is JBSWY3DPEHPK3PXP", "The MFA seed is JBSWY3DPEHPK3PXP", "TOTP seed JBSWY3DPEHPK3PXP",
  "The private key is 5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS", "My bitcoin private key 5KJvsngHeMpm884wtkJNzQGaCErckhHJBGFsvd3VyK5qMZXj3hS",
  "My encryption key is 3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e", "The AWS secret key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY is for staging",
  "The client secret is 8Q~abcdefghijklmnopqrstuvwxyz012345", "Client secret 8Q~abcdefghijklmnopqrstuvwxyz012345 for the Azure app",
  "The shared secret is Tr0ub4dor&3", "My secret is hunter2", "The secret is Tr0ub4dor&3",
  "Secret word for the bank: Sunshine", "My memorable word is Sunshine", "My bank's memorable word is Sunshine", "The memorable word for Barclays is Sunshine",
  "My memorable information is Sunshine99", "My secret word is Sunshine", "My security word: Sunshine", "The secret answer is Fluffy",
  "p/w hunter2", "pass: hunter2", "The pass is hunter2", "pswd: hunter2", "My passkey is hunter2",
  "The card's three digits are 123", "The three digits on the back are 123", "Card security number 123",
  "Account 123456789 routing 021000021",
];
/** Facts that say how someone signs in or what they use, with no secret in them. */
const NO_SECRET = [
  "Signs in with SSO", "Signs in to GitHub with a passkey", "Logs in with OAuth2", "Logs in with 2FA", "Signs in with Face ID",
  "Signs in with their work account", "Signs in with ram@example.com", "Logs in as admin", "Logs in at 9am every day", "Signs in to the VPN with Cisco AnyConnect",
  "Unlocks the phone with a fingerprint", "Unlocks the door with the key under the mat", "Unlocks the laptop with Touch ID",
  "Opens PDFs with Acrobat", "Opens archives with 7zip", "Opens the report with 2024 figures", "Opens the garage with a remote",
  "Types 12345 into the search box", "Enters 2024 in the year field", "Types python3 to open the REPL",
  "Uses Python3 for scripting", "Uses 1Password for passwords", "Uses 1Password for the work account", "Uses Windows11 on the laptop", "Uses WPA3 for the Wi-Fi",
  "Uses 2FA to sign in", "Uses Touch ID to unlock the laptop", "Uses VS2022 for C++", "Uses i3-wm for tiling", "Uses Firefox for banking",
  "Jira: ram's board", "Team: design / platform", "Ratio: 16 / 9", "Root: 45G / 100G", "Pronouns: she / her", "Stack: React / Node20", "PyTorch / Caffe2",
  "Wi-Fi: HomeNet / WPA2-PSK", "Uses Python3 on the laptop", "Uses python3 on the laptop", "The Wi-Fi is 300Mbps", "The TOTP seed rotation is yearly", "The authenticator key fob is in the drawer",
  "The front door is red", "The front door is 12", "My locker is 4821", "The safe is in the study", "The gym's code of conduct is strict",
  "The code is 4821 lines long", "The area code is 0113", "The combination is unusual",
  "The work VPN is WireGuard", "Work laptop: ThinkPad X1", "The Wi-Fi is slow", "The Wi-Fi is 5GHz", "The Wi-Fi is WPA3-only", "FileVault: on",
  "BitLocker is enabled", "The phone is iPhone15", "The router is AX6000", "The laptop is a MacBook Pro 14",
  "The 2FA secret is stored in 1Password", "My authenticator is Authy", "The MFA seed is rotated yearly", "The private key is ~/.ssh/id_ed25519",
  "The private key is kept on a YubiKey", "The encryption key is AES-256", "The private key is RSA-4096", "The client secret is configured in Azure",
  "The shared secret is rotated monthly", "My secret is that I dislike meetings", "The secret is patience",
  "The memorable word is required for phone banking", "The security word is asked for on the phone",
  "The pass is valid until June", "Season pass: 2024-25", "The bus pass is £120.50", "The tests pass on Node 22",
  "The card's three digits are on the back", "Card security number is required", "Account manager: Priya", "The routing table has 9 entries",
  "Works at Globex", "Prefers short answers", "Lives at 4 Abbey Road, York", "Was born in 1990", "Has 3 monitors", "Phone number is 07700 900123",
  "Flight BA2490 leaves on Friday", "Likes to be called Ram", "Role and work: Senior designer at Globex", "Timezone and working hours: UK, 9 to 5",
];

/** Ordinary facts the verb guard refused: a product's name with its version, a time, a year, a name with a hyphen. */
const LOOK_ALIKES = [
  "Uses iPhone15 for Instagram", "Uses Excel365 for the bank reconciliation", "Uses Figma2 for Slack mockups", "Uses Canon5D for Instagram",
  "Slack uses Electron28", "Spotify uses Ogg320", "Bank uses 3DSecure2", "The VPN is NordVPN2",
  "The alarm is 0630 on weekdays", "The alarm is 0715 every day", "The garage is 2019 and newer",
  "The secret is Vitamin-D3", "My pass is Zone1-3", "Favourite memorable place is Lisbon", "Their memorable date is the wedding",
  "The three digits on the back of the shirt are 123",
];

/** The same secrets in other words: a value shaped like a password wherever it stands, digits beside what they open. */
const BY_SHAPE = [
  "Password-wise, Netflix is Winter#2024", "Netflix is Winter#2024", "Uses the same Winter#2024 everywhere", "Reuses Winter#2024 for most sites",
  "Everything is Winter#2024", "All accounts: Winter#2024", "The work VPN wants Summer2024!", "VPN = Summer2024!", "Laptop login Summer2024!",
  "Unlocks the laptop by typing Summer2024!", "Their laptop opens with Summer2024!", "Wi-Fi at the office is Summer2024!",
  "SSH into the server as root with Summer2024!", "sudo is Summer2024!", "Root is Summer2024!", "Spotify = Pa55word!",
  "The door keypad takes 4821", "Punches in 4821 to get into the office", "The lock opens on 4821", "The safe opens with 32-18-04",
  "Garage keypad 4821", "To disarm, press 4821", "Press 4821 then # at the gate", "The padlock is set to 4821", "Luggage lock 482",
  "Suitcase combination 482", "Phone unlock is 482913", "Phone: 482913", "iPhone is 482913", "PIN-wise the card is 4821", "ATM number is 4821",
  "Cash machine code 4821", "Withdraws cash with 4821", "Voicemail is 4821", "The tablet's lock is 4821", "The SIM is 4821",
  "Default login admin/admin123", "Router admin is admin123", "Login: jsmith/Spring2023", "Hotspot password-free, key BlueSky99",
  "First pet was called Biscuit (security question)", "Security question: Biscuit", "Passport number 123456789", "Driving licence: MORGA753116SM9IJ",
  "The login is p4ss@word", "Netflix is Winter@2024",
];
/** Ordinary facts beside those shapes. */
const BESIDE_SHAPES = [
  "Phone number is 07700 900123", "Bought the phone in 2023", "The phone costs 1000", "Phone contract is 2400 a year", "Card ending 4242 is the work one",
  "Has 5000 in cash", "The door is 1200 mm wide", "The safe holds 2000 documents", "Feels safe with 2000 people around", "The laptop has 1600 pixels",
  "The laptop was bought in 2021", "The alarm goes off at 0630", "Sets the alarm for 0630", "The tablet is a 2022 model", "Keeps the iPad since 2019",
  "Locker 4821 at the gym", "The gate is 4821 Elm Street", "Unlocks at level 4821 in the game", "Gets in with the 0742 train", "Unlocks achievements with 5000 points",
  "Loves C++17", "Twitter handle is @ram_42", "Email is ram42@example.com", "Hashtag #100DaysOfCode", "Raised $20k for charity", "Favourite band is Blink-182",
  "Admin is Priya", "Root cause was DNS", "Login is through Okta", "Security questions are annoying", "Passport expires in 2030", "Passport is in the drawer",
  "Hotspot key is in the drawer", "Network key is printed on the router", "The phone code for Leeds is 0113", "Bengaluru, PIN code: 560001",
  "Login was #142 in the issue tracker", "The login is root@127.0.0.1:2222", "Deploys as deploy@build-01:22", "Network key: WPA2-PSK",
];

describe("what a fact may not say with a verb, or under another name (memory-r9-4)", () => {
  it.each(BY_SHAPE.map(s => [s]))("refuses %j, a secret in other words, by the value's shape or what it opens (memory-x9-6)", text => {
    expect(factRefusal(text)).not.toBeNull();
    expect(new MemoryGraph().add({ text, about: USER, source: "user" }).kind).toBe("refused");
  });

  it.each(BESIDE_SHAPES.map(s => [s]))("keeps the ordinary fact %j beside those shapes (memory-x9-6)", text => {
    expect(saidSecret(text)).toBeNull();
  });

  it.each(LOOK_ALIKES.map(s => [s]))("keeps the ordinary fact %j (memory-x9-8)", text => {
    expect(saidSecret(text)).toBeNull();
    expect(new MemoryGraph().add({ text, about: USER, source: "user" }).kind).toBe("added");
  });

  it.each(["Uses hunter2 for Netflix", "Uses Winter2024 for Netflix", "The alarm is 4821", "My bank's memorable place is Lisbon", "The card's three digits are 123", "The pass is hunter2", "The secret is Tr0ub4dor&3"].map(s => [s]))("still refuses %j beside those look-alikes (memory-x9-8)", text => {
    expect(factRefusal(text)).not.toBeNull();
  });

  it.each([...WITH_A_VERB, ...PAIRS_AND_PLACES, ...UNDER_OTHER_NAMES].map(s => [s]))("refuses %j as a fact, and keeps nothing of it (memory-r9-4)", text => {
    expect(factRefusal(text)).not.toBeNull();
    const g = new MemoryGraph();
    expect(g.add({ text, about: USER, source: "user" }).kind).toBe("refused");
    expect(g.toJSON().facts).toEqual([]);
  });

  it.each(NO_SECRET.map(s => [s]))("keeps %j (memory-r9-4)", text => {
    expect(saidSecret(text)).toBeNull();
    expect(factRefusal(text)).toBe(memoryRefusal(text));
    expect(new MemoryGraph().add({ text, about: USER, source: "user" }).kind).toBe(memoryRefusal(text) ? "refused" : "added");
  });

  it("only ever refuses more than the guard did: whatever memoryRefusal refuses, factRefusal refuses for the same reason (memory-r9-4)", () => {
    for (const text of ["my password is hunter2", "The door code is 4821", "Card 4111 1111 1111 1111 for the hotel", "my SSN is 123-45-6789", "-----BEGIN OPENSSH PRIVATE KEY-----"]) {
      expect(memoryRefusal(text)).not.toBeNull();
      expect(factRefusal(text)).toBe(memoryRefusal(text));
    }
    expect(factRefusal("Unlocks their phone with 482913")).toBe("it holds a password, PIN or code");
    expect(factRefusal("The client secret is 8Q~abcdefghijklmnopqrstuvwxyz012345")).toBe("it holds a password, token or key");
    expect(factRefusal("The card's three digits are 123")).toBe("it holds a card's security code");
    expect(factRefusal("Account 123456789 routing 021000021")).toBe("it holds an account or ID number");
  });

  it("holds through the remember tool, a correction, a name a fact is about, and Tell Ember about you (memory-r9-4)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memsaid-"));
    const s = new MemoryService({ dir, log: quiet });
    const l = new MemoryLearning({ memory: s, inForce: () => true, questionsOn: () => false, askedAt: () => null, setAskedAt: () => undefined, idle: () => true, locked: () => false, say: () => true, log: quiet });
    const said = "Remember that I sign in to Netflix with ram@example.com and Winter#2024";
    expect(l.conductorMemory().remember("Signs in to Netflix with ram@example.com and Winter#2024", USER, said)).toBe("Not remembered: it holds a password, PIN or code. Tell the user plainly if they asked you to remember it.");
    expect(s.remember("The router's login", [{ name: "admin / Summer2024!" }], "the router's login")).toMatch(/^Not remembered/);
    expect(s.remember("Works at Globex", USER, "I work at Globex")).toMatch(/^Remembered/);
    const row = s.list().find(i => i.text === "Works at Globex")!;
    expect(() => s.correct(row, "Unlocks their phone with 482913")).toThrow("This correction holds a secret, so Ember hasn't saved it.");
    expect(l.introduce({ work: "I sign in to Jira with ram and Winter#2024" })).toBe(0);
    s.flush();
    expect(fs.readFileSync(path.join(dir, "memory.json"), "utf8")).not.toMatch(/Winter#2024|482913/);
    s.stop();
  });
});
