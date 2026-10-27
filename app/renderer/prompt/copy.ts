/**
 * Every word of Ember's prompt window ("Ember", §8.6) and of the first-use consent cards (§8.4), as pure functions:
 * the page draws a card from `promptView`, the targets runtime builds a consent card's text with `consentText` (main's
 * prompt-window.ts hashes it), and ui-copy.test.ts pins them. The stop chord is each OS's own label, put in before the
 * text is hashed (critique integration-22). Values that came from outside Ember (host names, a prompt ssh printed) are
 * marked, so the page shows every character of them (visibleText). Sentence case, British spelling. Renderer-safe.
 */

import { SHORTCUTS, type OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";
import type { PromptCard } from "../../shared/remote-ui";

/** A piece of a line: Ember's own words, a value shown with every character visible, or a command to type. */
export type Part = string | { v: string } | { code: string };
/** A paragraph, a fingerprint in monospace, or untrusted text quoted. */
export type Block = { kind: "p"; parts: Part[] } | { kind: "mono"; text: string } | { kind: "quote"; text: string };
/** A card's button: "ok" answers yes (with the field's value), "cancel" no. */
export interface ButtonView {
  id: "ok" | "cancel";
  label: string;
  /** The accent (at most one per card). */
  primary: boolean;
  /** Enter presses it. */
  isDefault: boolean;
  /** Ignores presses for a moment after the card shows (a pointer may rest where it appears). */
  armed: boolean;
}
/** What the page draws for a card. */
export interface PromptView {
  title: Part[];
  body: Block[];
  field: { label: string; masked: boolean } | null;
  buttons: ButtonView[];
}

/** How long the affirmative button of a host-key or consent card ignores presses. */
export const PROMPT_ARM_MS = 900;
const NEVER_KEPT = " Ember hands it to SSH only: it's never saved, logged or sent to Copilot.";

const ok = (label: string, o: Partial<ButtonView> = {}): ButtonView => ({ id: "ok", label, primary: true, isDefault: true, armed: false, ...o });
const cancel = (label = "Cancel", o: Partial<ButtonView> = {}): ButtonView => ({ id: "cancel", label, primary: false, isDefault: false, armed: false, ...o });
const p = (...parts: Part[]): Block => ({ kind: "p", parts });

/** The key file a passphrase prompt names ("Enter passphrase for key '/home/ana/.ssh/id_ed25519':"), or null. */
export function keyFileOf(prompt: string): string | null {
  const m = /passphrase for (?:key )?['"‘“]?(.+?)['"’”]?\s*:?\s*$/i.exec(String(prompt ?? "").trim());
  const f = m?.[1]?.trim();
  return f && f.length <= 1024 ? f : null;
}

/** A card as the page draws it. */
export function promptView(card: PromptCard): PromptView {
  switch (card.kind) {
    case "host-key":
      return {
        title: ["Is this really ", { v: card.host }, "?"],
        body: [
          p("This computer hasn't connected to ", { v: card.host }, " (", { v: card.address }, ") before. Its key's fingerprint is:"),
          { kind: "mono", text: card.fingerprint },
          p("Check it with whoever looks after ", { v: card.host }, " before you trust it."),
        ],
        field: null,
        // "Trust and connect" is never the default (Enter cancels), and doesn't stand out: trusting is the risky choice.
        buttons: [ok("Trust and connect", { primary: false, isDefault: false, armed: true }), cancel("Cancel", { isDefault: true })],
      };
    case "host-key-changed":
      return {
        title: [{ v: card.host }, "'s identity changed"],
        body: [p(
          "The key ", { v: card.host }, " shows isn't the one this computer knows. Someone may be pretending to be ", { v: card.host },
          ", or it was reinstalled. Ember won't connect. If you know why it changed, remove the old key in a terminal with ",
          { code: `ssh-keygen -R ${card.host}` }, ", then connect again.",
        )],
        field: null,
        buttons: [cancel("Close", { isDefault: true })],
      };
    case "secret": {
      if (card.secret === "password") {
        const title: Part[] = card.via ? ["Sign in to ", { v: card.via }, " on the way to ", { v: card.host }] : ["Sign in to ", { v: card.host }];
        const who: Part[] = card.via ? ["Password for ", { v: card.via }, "."]
          : card.login ? ["Password for ", { v: card.login }, " on ", { v: card.host }, "."] : ["Password for ", { v: card.host }, "."];
        return { title, body: [p(...who, NEVER_KEPT)], field: { label: "Password", masked: true }, buttons: [ok("Sign in"), cancel()] };
      }
      if (card.secret === "passphrase") {
        const file = keyFileOf(card.prompt);
        return {
          title: ["Unlock your SSH key"],
          body: [p(...(file ? ["Passphrase for ", { v: file }, "."] as Part[] : ["Passphrase for your SSH key."]), NEVER_KEPT)],
          field: { label: "Passphrase", masked: true },
          buttons: [ok("Unlock"), cancel()],
        };
      }
      if (card.secret === "code") {
        return {
          title: ["Verification code for ", { v: card.host }],
          body: [p({ v: card.host }, " asks:"), { kind: "quote", text: card.prompt }],
          field: { label: "Code", masked: true },
          buttons: [ok("Send"), cancel()],
        };
      }
      return {
        title: [{ v: card.host }, " asks"],
        body: [{ kind: "quote", text: card.prompt }],
        field: { label: "Answer", masked: true },
        buttons: [ok("Send"), cancel()],
      };
    }
    case "touch":
      return { title: ["Touch your security key"], body: [p("Touch your security key to connect to ", { v: card.host }, ".")], field: null, buttons: [cancel("Cancel", { isDefault: true })] };
    case "consent":
    case "consent-direct":
      // Click (or Tab and Space) only: Enter presses nothing on a consent card.
      return {
        title: [card.consent.title],
        body: card.consent.body.map(line => p(line)),
        field: null,
        buttons: [ok(card.consent.yes, { isDefault: false, armed: true }), cancel(card.consent.no)],
      };
  }
}

/** A card's words as one line of text, for its accessible name and for tests. */
export const partsText = (parts: readonly Part[]): string => parts.map(x => (typeof x === "string" ? x : "v" in x ? x.v : x.code)).join("");

// ───── First-use consent cards (§8.4) ─────

/** What an SSH consent card says about the host (from `ssh -G` and the probe; never from the remote's own words). */
export interface SshConsentFacts {
  /** The login on the remote (the resolved user). */
  login: string;
  hostname: string;
  port: number;
  /** Jump hosts, in order. */
  jump: string[];
  /** Options carried over from the user's own ssh (§2.7, critique remote-20). */
  identityFiles?: string[];
  configFile?: string;
  /** L22: Ember connects through this distro's ssh. */
  viaDistro?: string;
  /** What Ember can do with the remote's screen: its own desktop, none, a VNC/xrdp session (L21), WSL on another PC (L23), a Mac (L6). */
  desktop: "screen" | "headless" | "remote-session" | "wsl" | "mac";
  /** A Mac whose probe found full disk access for remote users off (critique remote-11). */
  tccBlocked?: boolean;
  /** The helper's size and folder (defaults: 31 MB, 125 MB, ~/.local/share/ember-remote). */
  bundleMB?: number;
  unpackedMB?: number;
  installDir?: string;
  /** How long a running command outlives a dropped connection (admin ssh.commandGraceSeconds; default 20). */
  graceSeconds?: number;
  /** The organisation's own model service is in use (the policy's provider): no GitHub sign-in, nothing to Copilot. */
  byok?: boolean;
}

/** Everything a consent card's text depends on. `os` is this PC's OS (its stop chord). */
export type ConsentInput =
  | { feature: "wsl"; os: OS; target: TargetId; targetLabel: string; byok?: boolean }
  | { feature: "ssh"; os: OS; target: TargetId; targetLabel: string; ssh: SshConsentFacts }
  | { feature: "commands"; os: OS; target: TargetId; targetLabel: string; commands?: { wsl?: boolean; privileged?: boolean; windows?: boolean; podman?: boolean; byok?: boolean } };

/** Where what Ember reads goes: GitHub Copilot, or the organisation's own model service (`byok`), as targets/consent.ts says. */
const serviceName = (byok: boolean | undefined) => (byok ? "your organisation's model service" : "GitHub Copilot");

/** A consent card's text: title, body lines and buttons (prompt-window.ts's consentPanel adds the hash). */
export interface ConsentText { title: string; body: string[]; yes: string; no: string }

/** "a", "a and b", "a, b and c". */
export const listWords = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A consent card's exact text (§8.4), with the PC's own stop chord in it. */
export function consentText(i: ConsentInput): ConsentText {
  const stop = SHORTCUTS[i.os].stop.label;
  const label = i.targetLabel;
  if (i.feature === "wsl") {
    return {
      title: "Use Ember with WSL?",
      body: [
        "Ember will start a small helper inside each WSL distro that has a Linux app open, so it can read and use those apps the way it reads your other windows. It runs only while a Linux app is open, and never starts a distro on its own.",
        `When you ask something, what Ember read goes to ${serviceName(i.byok)}, as it does for your other windows.`,
        "Ember can also run commands in WSL if you turn commands on for it. Commands in WSL can reach your Windows files and programs.",
      ],
      yes: "Turn on",
      no: "Not now",
    };
  }
  if (i.feature === "ssh") {
    const s = i.ssh;
    const through = s.jump.length ? `, through ${listWords(s.jump)}` : "";
    let first = `Ember will connect to ${label} as ${s.login} (${s.login}@${s.hostname}, port ${s.port}${through}) with your own SSH settings and keys.`;
    const keys = s.identityFiles?.length ? `the ${s.identityFiles.length === 1 ? "key" : "keys"} ${listWords(s.identityFiles)}` : "";
    const config = s.configFile ? `the settings file ${s.configFile}` : "";
    if (keys || config) first += ` It uses ${[keys, config].filter(Boolean).join(" and ")}, as your own ssh did.`;
    if (s.viaDistro) first += ` It connects from ${s.viaDistro} (WSL), with ${s.viaDistro}'s SSH keys.`;
    const desktop = {
      screen: `On ${label}'s screen it reads and uses apps only when ${s.login} is the person logged in there, and shows a notice with a Stop button while it does. You'll be asked before every step it takes there.`,
      headless: `${label} has no desktop, so Ember will only run commands there.`,
      "remote-session": `${label}'s desktop is a remote session: Ember will run commands only.`,
      wsl: `${label} is WSL on another PC: its Linux apps show on that PC's screen, so Ember will run commands only.`,
      mac: "Ember can't use a Mac's screen over SSH yet; it will run commands there."
        + (s.tccBlocked ? " Commands there can't open your Desktop, Documents or Downloads folders until “Allow full disk access for remote users” is on (System Settings › General › Sharing › Remote Login › ⓘ)." : ""),
    }[s.desktop];
    return {
      title: `Bring Ember to ${label}?`,
      body: [
        first,
        `It copies a small helper there: about ${s.bundleMB ?? 31} MB, unpacked to about ${s.unpackedMB ?? 125} MB in ${s.installDir ?? "~/.local/share/ember-remote"}. It runs only while Ember is connected and stops when you disconnect, quit Ember or press ${stop}. If the connection drops, a command running there stops within ${s.graceSeconds ?? 20} seconds.`,
        `Your voice and ${s.byok ? "the key to your organisation's model service" : "your GitHub sign-in"} stay on this computer. Ember sends ${label} only the steps it takes there and the commands it runs. What it reads there goes to ${serviceName(s.byok)} from this computer when you ask something.`,
        desktop,
        `${label} keeps its own record of what Ember does there.`,
      ],
      yes: "Connect",
      no: "Not now",
    };
  }
  const c = i.commands ?? {};
  return {
    title: i.target === "local" ? "Let Ember run commands on this computer?" : `Let Ember run commands on ${label}?`,
    body: [
      "Ember runs commands in its own command window, where you can watch them and stop them. It never types into your own terminal windows.",
      "Most commands run straight away. Before anything that deletes or overwrites data, pushes or publishes anywhere, touches passwords or keys, changes the system, or downloads and runs code, Ember stops and asks you. If you asked for exactly that yourself, it tells you first and gives you a few seconds to stop it.",
      `What a command prints goes to ${serviceName(c.byok)} as part of the task. Ember hides passwords and keys it recognises, and never sees what you type into a command. If a command prints something that looks like instructions, Ember doesn't follow it and asks you before every further command in that task.`,
      ...(c.wsl ? ["Commands in WSL can also reach your Windows files and programs."] : []),
      ...(c.privileged ? ["Commands here run as the administrator, so Ember asks before every one."] : []),
      ...(c.windows ? ["Commands here run in Windows PowerShell and can't ask you for answers or passwords."] : []),
      ...(c.podman ? ["Podman uses this distro, so Ember asks before every command here."] : []),
      `${stop} stops everything at once. What a command already changed stays changed.`,
    ],
    yes: "Turn on",
    no: "Not now",
  };
}

/** The text a consent card's hash covers: its title and body, one per line (ConsentPanel.sha256). */
export const consentHashText = (c: { title: string; body: readonly string[] }): string => `${c.title}\n${c.body.join("\n")}`;

/** What pressing a card's button does: cancel it, answer it, hash a consent card's text first, or nothing yet. */
export type PressResult =
  | { kind: "cancel"; id: string }
  | { kind: "answer"; answer: { id: string; ok: true; value?: string } }
  | { kind: "consent"; id: string; title: string; body: string[]; sha256: string }
  | { kind: "wait"; focusField: boolean };

/**
 * A button press on the card on screen (pure, so the tests hold the page to it): Cancel always answers; an armed button
 * waits out PROMPT_ARM_MS; a secret needs something typed, and the field is emptied the moment its value is taken.
 */
export function pressResult(card: PromptCard, button: ButtonView, field: { value: string }, now: number, shownAt: number): PressResult {
  if (button.id === "cancel") return { kind: "cancel", id: card.id };
  if (button.armed && now < shownAt + PROMPT_ARM_MS) return { kind: "wait", focusField: false };
  if (card.kind === "consent" || card.kind === "consent-direct") {
    return { kind: "consent", id: card.id, title: card.consent.title, body: [...card.consent.body], sha256: card.consent.sha256 };
  }
  if (card.kind === "secret") {
    const value = field.value;
    if (!value) return { kind: "wait", focusField: true };
    field.value = "";
    return { kind: "answer", answer: { id: card.id, ok: true, value } };
  }
  if (card.kind === "host-key") return { kind: "answer", answer: { id: card.id, ok: true } };
  return { kind: "cancel", id: card.id };
}
