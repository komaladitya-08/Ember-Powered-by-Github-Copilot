/**
 * Home's words for the vault (the round's brief, decision 3): the list shows kind, destination and day, never a value,
 * Forget all asks first, and Sign out and Forget everything say the vault goes too.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  VAULT_EMPTY, VAULT_HINT, VAULT_OFF_HINT, VAULT_WORDS, forgetEverythingScope, signOutScope, vaultForgetAllScope, vaultForgetLabel, vaultHint, vaultRowText,
} from "../../app/renderer/home/copy";

const read = (f: string) => fs.readFileSync(f, "utf8");
const PAGE = read("app/renderer/home/index.html");

describe("Apps & privacy › Vault", () => {
  it("says what the vault is, and with the organisation's switch off that nothing new is kept (vault-3, vault-5)", () => {
    expect(VAULT_HINT).toBe("Logins, cards and contact details you gave Ember in its Secure Form, each for one app or site. In Autopilot, Ember asks for one the first time it needs it, keeps it locked with your computer's keyring and fills it in itself: the AI model never sees it, and Ember never shows it again. To change one, forget it and give it again.");
    expect(vaultHint(true)).toBe(VAULT_HINT);
    expect(vaultHint(false)).toBe(VAULT_OFF_HINT);
    expect(VAULT_OFF_HINT).toBe("Your organisation turned the vault off, so Ember keeps nothing new and fills nothing in. You can still forget what is listed here.");
    expect(VAULT_EMPTY).toBe("Nothing saved yet.");
  });

  it("words a row by kind, destination and day, and its Forget for a screen reader (vault-3)", () => {
    expect(vaultRowText("login", "github.com", "12 November 2026")).toBe("Login for github.com, saved 12 November 2026");
    expect(vaultRowText("contact", "Thunderbird", "1 May 2027")).toBe("Contact details for Thunderbird, saved 1 May 2027");
    expect(vaultForgetLabel("card", "github.com")).toBe("Forget the card for github.com");
    expect(VAULT_WORDS.forgot("contact", "Thunderbird")).toBe("Forgot the contact details for Thunderbird.");
  });

  it("asks before Forget all, with the count (vault-3)", () => {
    expect(vaultForgetAllScope(1)).toBe("Forget the 1 entry in the vault? Ember deletes it from this computer. It asks again, in Autopilot, the next time it needs it.");
    expect(vaultForgetAllScope(3)).toBe("Forget all 3 entries in the vault? Ember deletes them from this computer. It asks again, in Autopilot, the next time it needs one.");
  });

  it("has its list in Apps & privacy, named by its heading, with a status line and a question for Forget all (vault-3)", () => {
    const pane = PAGE.slice(PAGE.indexOf('data-pane="privacy"'), PAGE.indexOf('id="computers"'));
    expect(pane).toContain('<h3 class="sub" id="vault-h">Vault</h3>');
    expect(pane).toContain('<ul class="plain-list" id="vault-list" aria-labelledby="vault-h" tabindex="-1"></ul>');
    expect(pane).toContain('<div id="vault-forget-confirm" class="consent" role="group" aria-labelledby="vault-forget-scope" hidden>');
    expect(pane).toContain('<p class="hint" id="vault-msg" role="status"></p>');
    expect(read("app/renderer/home/main.ts")).toContain("mountVault(window.emberVault);");
  });

  it("is bridged to Home by the list and Forget only: never the Secure Form's channels (vault-3)", () => {
    const preload = read("app/preload/home.ts");
    expect([...preload.matchAll(/VAULT_IPC\.(\w+)/g)].map(m => m[1]).sort()).toEqual(["changed", "forget", "forgetAll", "list"]);
    for (const p of ["ask", "overlay", "handle", "mic", "desk", "command", "prompt"]) expect(read(`app/preload/${p}.ts`), p).not.toMatch(/vault/i);
  });

  it("says Sign out and Forget everything forget the vault too (vault-6)", () => {
    const c = { tasks: 2, facts: 5, reminders: 1, routines: 3 };
    expect(signOutScope(c)).toContain("3 routines. It also forgets what you saved in the vault.");
    expect(signOutScope({ ...c, kept: true })).toContain("Forget everything in Memory removes it. It also forgets what you saved in the vault.");
    expect(forgetEverythingScope(c)).toContain("if you keep one. It also forgets what you saved in the vault. 2 tasks, 1 reminder and 3 routines stay as they are");
    expect(signOutScope({ ...c, facts: null })).toMatch(/It also forgets what you saved in the vault\. Ember couldn't count everything right now/);
  });
});
