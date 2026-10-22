/**
 * Secret prompts (design L2, §3.11 step 2): a password-like prompt at the end of the output opens a span; on an
 * interactive run the program's first newline after the user's Enter closes it; on a pipe run nothing does, so the
 * span runs to the end (critique security-12).
 */

import { describe, expect, it } from "vitest";
import { OPEN_SPAN_END, SECRET_PROMPT, trackSecretPrompts } from "../../app/main/commands/prompts";

describe("SECRET_PROMPT", () => {
  it.each([
    "Password:", "password: ", "[sudo] password for ana: ", "Enter passphrase for key '/home/ana/.ssh/id_ed25519': ", "Passcode:", "PIN:",
    "Enter OTP: ", "Token:", "Client secret:", "Verification code: ", "One-time code:", "2FA code:", "Password\uff1a", "ana@host's password: ",
  ])("matches %j", line => {
    expect(SECRET_PROMPT.test(line)).toBe(true);
  });
  it.each(["Password reset sent.\n", "Compiling...", "Username:", "Name: ", "password: ok and then more text that runs past the end of the forty characters: x"])("leaves %j", line => {
    expect(SECRET_PROMPT.test(line)).toBe(false);
  });
});

describe("trackSecretPrompts", () => {
  it("opens a span at a prompt and closes it at the program's next line after Enter", () => {
    const t = trackSecretPrompts({ interactive: true });
    t.output("Connecting...\n[sudo] password for ana: ");
    const from = "Connecting...\n[sudo] password for ana: ".length;
    expect(t.spans()).toEqual([{ from, to: OPEN_SPAN_END }]);
    t.output("****");
    t.enter();
    t.output("\nDone\n");
    expect(t.spans()).toEqual([{ from, to: from + 4 }]);
  });

  it("keeps the span open until Enter, whatever the program prints", () => {
    const t = trackSecretPrompts({ interactive: true });
    t.output("Password: ");
    t.output("line one\nline two\n");
    expect(t.spans()).toEqual([{ from: 10, to: OPEN_SPAN_END }]);
  });

  it("never closes a span on a run nobody can type into", () => {
    const t = trackSecretPrompts({ interactive: false });
    t.output("Password: ");
    t.enter();
    t.output("hunter2\nmore\n");
    expect(t.spans()).toEqual([{ from: 10, to: OPEN_SPAN_END }]);
  });

  it("opens only when the output so far ends in the prompt", () => {
    const t = trackSecretPrompts({ interactive: true });
    t.output("Password: changed\n");
    expect(t.spans()).toEqual([]);
    t.output("Pass");
    expect(t.spans()).toEqual([]);
    t.output("word: ");
    expect(t.spans()).toEqual([{ from: 28, to: OPEN_SPAN_END }]);
  });

  it("sees a coloured prompt, and a prompt after a carriage return", () => {
    const t = trackSecretPrompts({ interactive: true });
    t.output("\x1b[1mPassword:\x1b[0m ");
    expect(t.spans()).toHaveLength(1);
    const u = trackSecretPrompts({ interactive: true });
    u.output("progress 50%\rEnter PIN: ");
    expect(u.spans()).toHaveLength(1);
  });

  it("tracks several prompts in one run", () => {
    const t = trackSecretPrompts({ interactive: true });
    t.output("Password: ");
    t.enter();
    t.output("\nOTP: ");
    t.enter();
    t.output("\nok\n");
    expect(t.spans()).toEqual([{ from: 10, to: 10 }, { from: 16, to: 16 }]);
  });

  it("ignores Enter when no span is open", () => {
    const t = trackSecretPrompts({ interactive: true });
    t.enter();
    t.output("hello\nPassword: ");
    t.output("\n");
    expect(t.spans()).toEqual([{ from: 16, to: OPEN_SPAN_END }]);
  });
});
