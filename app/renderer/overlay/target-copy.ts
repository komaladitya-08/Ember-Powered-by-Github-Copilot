/**
 * The bubble's words for computers and commands (§8.2), as pure functions: the targets runtime and the presenter build
 * every bubble of theirs from these (adding the action ids they handle), so ui-copy.test.ts pins what users see. Ember
 * speaks in the first person here, as in every bubble. Sentence case, British spelling. Renderer-safe and pure.
 * (A command's question and the commands card's question are the command flow's own, pinned by its tests.)
 */

import type { OS } from "../../shared/shortcuts";
import type { TargetKind } from "../../shared/targets";

/** A bubble's words: its title, its text, and its buttons (the first marked primary, when it is). */
export interface BubbleWords { title: string; text: string; actions: { label: string; primary?: boolean }[] }

/** The user's own ssh was seen (R4). */
export const sshSeen = (host: string): BubbleWords => ({
  title: `You're connected to ${host}`,
  text: "Bring me there too? I'll open my own connection with your SSH settings.",
  actions: [{ label: "Bring Ember", primary: true }, { label: "Not now" }, { label: "Don't offer again" }],
});

/** The user's own ssh was seen in a WSL tab, and connecting through the distro isn't proven (L22). */
export const sshSeenInWsl = (host: string, distro: string): BubbleWords => ({
  title: `You're connected to ${host} from ${distro}`,
  text: "I connect with Windows' SSH. Add your key to Windows' ssh-agent, or connect once from PowerShell, then bring me there.",
  actions: [{ label: "Not now" }, { label: "Don't offer again" }],
});

/** offer_connect: the user's words named a host Ember isn't connected to. */
export const offerConnect = (host: string): BubbleWords => ({
  title: `Connect to ${host}?`,
  text: `You asked for ${host}. I'm not connected to it yet.`,
  actions: [{ label: "Connect", primary: true }, { label: "Not now" }],
});

/** A connection's step, in a few words. Sizes in MB (rounded). */
export type ConnectStep = { step: "checking" | "starting" } | { step: "downloading" | "copying"; doneMB: number; totalMB: number };

/** Connecting, with where it has got to. */
export function connecting(host: string, s: ConnectStep): BubbleWords {
  let text: string;
  if ("doneMB" in s) {
    const of = `(${Math.round(s.doneMB)} of ${Math.round(s.totalMB)} MB)`;
    text = s.step === "downloading" ? `Downloading what I need for ${host} ${of}…` : `Copying what I need to ${host} ${of}…`;
  } else text = s.step === "checking" ? `Checking ${host}…` : `Starting up on ${host}…`;
  return { title: `Connecting to ${host}…`, text, actions: [{ label: "Cancel" }] };
}

/**
 * Connected. A host with no desktop is worked on through commands only: said so only when they aren't off there, else
 * what turns them on (a button, unless the organisation turned them off).
 */
export type ConnectedHow = "desktop" | "commands" | "commands-off" | "commands-off-by-admin";
export const connected = (host: string, how: ConnectedHow): BubbleWords => ({
  title: `I'm on ${host}`,
  text: how === "desktop" ? "Ask away: I'll work there. Your voice and your sign-in stay on this computer."
    : how === "commands" ? `${host} has no desktop, so I'll run commands there.`
      : how === "commands-off-by-admin" ? `${host} has no desktop, and your organisation has turned off commands there, so I can't work on it.`
        : `${host} has no desktop, and commands are off there. Turn them on so I can work there.`,
  actions: how === "commands-off" ? [{ label: "Turn on commands", primary: true }] : [],
});

/** The commands of a host with no desktop, turned on from its connected bubble (or not, and why). */
export const commandsOn = (host: string): BubbleWords => ({ title: `Commands are on for ${host}`, text: "Ask away: I'll run commands there.", actions: [] });
export const commandsStayOff = (host: string, why: string): BubbleWords => ({ title: `Commands stay off on ${host}`, text: why, actions: [] });

/** A connect failed (`why`: the connection's own words); Try again when another try may help. It stays until closed. */
export const cantConnect = (host: string, why: string, retry: boolean): BubbleWords => ({
  title: `Can't connect to ${host}`, text: why, actions: retry ? [{ label: "Try again" }, { label: "Close" }] : [{ label: "Close" }],
});

/** The host's key changed: the prompt window's card says why and what to do (§4.1). */
export const identityChanged = (host: string): string => `${host}'s identity changed, so I won't connect. The window that opened says what to do.`;

/** The link has been silent for 5 seconds: its commands stop when the grace runs out (L10). */
export const stalled = (host: string, graceSeconds: number): BubbleWords => ({
  title: `${host} isn't answering`,
  text: `Commands running there stop in ${seconds(graceSeconds)} unless it answers again. I'll send nothing new until then.`,
  actions: [{ label: "Disconnect" }],
});

/** A count of seconds as a sentence says it ("15 seconds", "1 second"), never "15 s", which can wrap away from its number. */
function seconds(n: number): string {
  const s = Math.max(0, Math.round(n));
  return `${s} second${s === 1 ? "" : "s"}`;
}

/** The connection dropped (L10). `workHere`: it was where Ember worked, and Ember works on this computer until it's back. */
export const lost = (host: string, workHere: boolean): BubbleWords => ({
  title: `Lost ${host}`,
  text: `The connection dropped, so everything there stopped. I'll try to reconnect${workHere ? "; until then I'll work on this computer" : ""}.`,
  actions: [{ label: "Reconnect", primary: true }, { label: "Stop trying" }],
});

/** The connection came back by itself after a loss; `again`: Ember works there again (it did when it dropped). */
export const backThere = (host: string, again: boolean): BubbleWords => ({
  title: `${host} is back`, text: again ? "The connection came back, so I'll work there again." : "The connection came back.", actions: [],
});

/** Why a task stopped with its computer (what its result says instead of "Stopped."). */
export type StopCause = "dropped" | "closed" | "stopped-there" | "locked" | "inactive";
export function stoppedTask(host: string, cause: StopCause): string {
  switch (cause) {
    case "dropped": return `${host}'s connection dropped, so I stopped this.`;
    case "closed": return `${host} isn't connected any more, so I stopped this.`;
    case "stopped-there": return `Someone at ${host} pressed Stop.`;
    case "locked": return `${host}'s screen locked, so I stopped this.`;
    case "inactive": return `${host}'s desktop session isn't active any more, so I stopped this.`;
  }
}

/** The connection came back by itself, from another computer under the same name: it isn't used (§7.4). */
export const cameBackDifferent = (host: string): BubbleWords => ({
  title: `Lost ${host}`, text: `${host} came back as a different computer, so I didn't use it. Reconnect to check it.`,
  actions: [{ label: "Reconnect", primary: true }],
});

/** Reconnecting after a loss stopped (`why`: the connection's own words). */
export const cantReconnect = (host: string, why: string): BubbleWords => ({ title: `Can't reconnect to ${host}`, text: why, actions: [{ label: "Reconnect", primary: true }] });

export const signInAgain = (host: string): BubbleWords => ({ title: `${host} needs you to sign in again`, text: "Reconnect to sign in.", actions: [{ label: "Reconnect", primary: true }] });

export const stoppedFromRemote = (host: string): BubbleWords => ({ title: `Stopped on ${host}`, text: `Someone at ${host} pressed Stop.`, actions: [] });

/** Only the tasks using its desktop stop (§5.3.4 step 8); tasks running only commands there go on. */
export const screenLocked = (host: string): BubbleWords => ({ title: `Stopped on ${host}`, text: `${host}'s screen locked, so I stopped working on its screen.`, actions: [] });

export const sessionInactive = (host: string): BubbleWords => ({ title: `Stopped on ${host}`, text: `${host}'s desktop session isn't active any more, so I stopped working on its screen.`, actions: [] });

export const backHere = (host: string): BubbleWords => ({ title: "Back on this computer", text: `${host} isn't connected any more, so I'll work here.`, actions: [] });

/**
 * An announcement (D4.4): `announce` is the flow's words ("Pushing to GitHub, as you asked."), `where` the task's place
 * as its badge says it ("on build-01"; absent: this computer). The badge (and a screen reader) says where, so only this
 * computer, which has none, is said; the bubble doesn't count down (the command window does), so: "a few seconds".
 */
export const announcement = (announce: string, where: string | undefined): BubbleWords => ({
  title: announce.trim().replace(/[.!]+$/, ""),
  text: `${where ? "" : "On this computer. "}It starts in a few seconds.`,
  actions: [{ label: "Stop" }],
});

export const wslFirstSeen = (): BubbleWords => ({
  title: "I can work in WSL",
  text: "I can read and use your Linux apps and run commands there. Turn this on in settings?",
  actions: [{ label: "Open settings", primary: true }, { label: "Not now" }],
});

/**
 * Under a bubble whose buttons the keyboard can't reach (the overlay never takes the keyboard): where the same buttons
 * are in settings, with the settings shortcut while Ember holds it (`key`; null: another app took it). An answer cut
 * short is whole in Conversation.
 */
export const keyboardRoute = (key: string | null, section: "Computers" | "Commands" | "Conversation" = "Computers"): string =>
  (key ? `Or press ${key} and go to ${section}.` : `Or open Ember's settings and go to ${section}.`);

/**
 * How to reach the window that shows a question whole (the command window, the window a consent card opened in) from
 * the keyboard: Alt+Tab reaches it on Linux and Windows; on macOS the command window is a panel Command+Tab doesn't list.
 */
export const panelHint = (kind: "command" | "consent", os: OS): string =>
  `${kind === "command" ? "The command is in Ember's command window" : "It's in the window that opened"}${os === "darwin" ? "." : ": press Alt+Tab to go there."}`;

/** What is spoken and put in a notification for a command question (R7: only this, never the command; §3.9.1). */
export const commandSpoken = (kind: TargetKind, label: string): string => `Ember wants to run a command on ${kind === "local" ? "this computer" : label}.`;

/**
 * A sentence that speaks of Ember (the settings window's voice, a connection's error), as the bubble says it: in the
 * first person at the start of a sentence ("Ember can't reach build-01" → "I can't reach build-01"), and without a
 * command to run in brackets (the bubble runs none; settings and the docs say it). Ember named inside a sentence (a
 * permission to allow Ember in an OS setting) stays.
 */
export function firstPerson(text: string): string {
  const start = "(^|[.!?:;]\\s+)";
  const at = (re: string, to: string) => (s: string) => s.replace(new RegExp(`${start}${re}`, "g"), `$1${to}`);
  const steps = [
    at("Ember can't\\b", "I can't"), at("Ember couldn't\\b", "I couldn't"), at("Ember won't\\b", "I won't"), at("Ember doesn't\\b", "I don't"),
    at("Ember isn't\\b", "I'm not"), at("Ember needs\\b", "I need"), at("Ember connects\\b", "I connect"), at("Ember's Copilot runtime\\b", "My Copilot runtime"),
    at("It will try again\\b", "I'll try again"),
  ];
  let s = steps.reduce((t, f) => f(t), text);
  s = s.replace(/\bthe GitHub sign-in Ember found\b/g, "the GitHub sign-in I found");
  return s.replace(/ \((?:sudo|dnf|apt|apt-get|yum|brew|winget|choco)\b[^)]*\)/g, "");
}
