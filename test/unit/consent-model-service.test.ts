/**
 * The consent cards name where what Ember reads goes (review #122): GitHub Copilot, or, when the administrator set the
 * organisation's own model endpoint, "your organisation's model service" (Ember then never uses a GitHub sign-in). The
 * card's hash covers the sentence the user actually read; the settings window already words it so.
 */

import { describe, expect, it } from "vitest";
import { commandsConsent, sshConsent, wslConsent } from "../../app/main/targets/consent";
import { consentText } from "../../app/renderer/prompt/copy";

const FACTS = { kind: "local" as const, privileged: false, windows: false, podman: false };
const SSH = {
  label: "build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: [] }, desktopOff: false, graceSeconds: 20,
};
const text = (c: { body: readonly string[] }) => c.body.join("\n");

describe("the consent cards with the organisation's own model service", () => {
  it("say what is read goes to the organisation's model service, never to GitHub Copilot", () => {
    for (const card of [
      wslConsent({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)", byok: true }),
      commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts: { ...FACTS, byok: true } }),
      sshConsent({ os: "linux", target: "ssh:build-01", facts: { ...SSH, byok: true } }),
    ]) {
      expect(text(card), card.title).toMatch(/your organisation's model service/);
      expect(text(card), card.title).not.toMatch(/Copilot|GitHub sign-in/);
    }
  });

  it("say GitHub Copilot as before without it, and the two cards' hashes differ", () => {
    const plain = commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts: FACTS });
    expect(text(plain)).toMatch(/goes to GitHub Copilot as part of the task/);
    expect(text(wslConsent({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" }))).toMatch(/goes to GitHub Copilot, as it does/);
    expect(text(sshConsent({ os: "linux", target: "ssh:build-01", facts: SSH }))).toMatch(/your GitHub sign-in stay on this computer/);
    expect(plain.sha256).not.toBe(commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts: { ...FACTS, byok: true } }).sha256);
  });

  it("are worded the same by the prompt window's copy", () => {
    const wsl = consentText({ feature: "wsl", os: "win32", target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)", byok: true });
    const commands = consentText({ feature: "commands", os: "linux", target: "local", targetLabel: "This computer", commands: { byok: true } });
    const ssh = consentText({ feature: "ssh", os: "linux", target: "ssh:build-01", targetLabel: "build-01", ssh: { login: "deploy", hostname: "build-01.example.com", port: 22, jump: [], desktop: "screen", byok: true } });
    for (const c of [wsl, commands, ssh]) {
      expect(text(c)).toMatch(/your organisation's model service/);
      expect(text(c)).not.toMatch(/Copilot|GitHub sign-in/);
    }
    expect(text(wsl)).toBe(text(wslConsent({ target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)", byok: true })));
  });
});
