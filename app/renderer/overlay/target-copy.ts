/**
 * The bubble's words for computers and commands (§8.2), as pure functions: the targets runtime and the agent put them
 * in BubbleState (adding the action ids they handle). Ember speaks in the first person here, as in every bubble.
 * Sentence case, British spelling; ui-copy.test.ts pins them. Renderer-safe and pure.
 */

import type { TargetKind } from "../../shared/targets";

/** A bubble's words: its title, its text, and its buttons (the first marked primary, when it is). */
export interface BubbleWords { title: string; text: string; actions: { label: string; primary?: boolean }[] }

/** How a place is said at the start of a sentence: "On build-01", "In Ubuntu (WSL)", "On this computer". */
export function placeWords(kind: TargetKind, label: string): string {
  return kind === "local" ? "On this computer" : kind === "wsl" ? `In ${label}` : `On ${label}`;
}

/** The user's own ssh was seen (R4). */
export const sshSeen = (host: string): BubbleWords => ({
  title: `You're connected to ${host}`,
  text: "Bring Ember there too? It will open its own connection with your SSH settings.",
  actions: [{ label: "Bring Ember", primary: true }, { label: "Not now" }, { label: "Don't offer again" }],
});

/** The user's own ssh was seen in a WSL tab, and connecting through the distro isn't proven (L22). */
export const sshSeenInWsl = (host: string, distro: string): BubbleWords => ({
  title: `You're connected to ${host} from ${distro}`,
  text: "Ember connects with Windows' SSH. Add your key to Windows' ssh-agent, or connect once from PowerShell, then bring Ember there.",
  actions: [{ label: "Not now" }, { label: "Don't offer again" }],
});

/** offer_connect: the user's words named a host Ember isn't connected to. */
export const offerConnect = (host: string): BubbleWords => ({
  title: `Connect to ${host}?`,
  text: `You asked for ${host}. Ember isn't connected to it yet.`,
  actions: [{ label: "Connect", primary: true }, { label: "Not now" }],
});

/** A connection's step, in a few words. Sizes in MB (rounded). */
export type ConnectStep = { step: "checking" | "starting" } | { step: "downloading" | "copying"; doneMB: number; totalMB: number };

/** Connecting, with where it has got to. */
export function connecting(host: string, s: ConnectStep): BubbleWords {
  let text: string;
  if ("doneMB" in s) {
    const of = `(${Math.round(s.doneMB)} of ${Math.round(s.totalMB)} MB)`;
    text = s.step === "downloading" ? `Downloading what Ember needs for ${host} ${of}…` : `Copying Ember's helper to ${host} ${of}…`;
  } else text = s.step === "checking" ? `Checking ${host}…` : `Starting Ember on ${host}…`;
  return { title: `Connecting to ${host}…`, text, actions: [{ label: "Cancel" }] };
}

/** Connected; a host with no desktop gets commands only. */
export const connected = (host: string, headless: boolean): BubbleWords => ({
  title: `Ember is on ${host}`,
  text: headless ? `${host} has no desktop, so I'll run commands there.` : "Ask away: I'll work there. Your voice and your sign-in stay on this computer.",
  actions: [],
});

/** The link has been silent for 5 s: its commands stop when the grace runs out (L10). */
export const stalled = (host: string, graceSeconds: number): BubbleWords => ({
  title: `${host} isn't answering`,
  text: `Its running commands stop in ${Math.max(0, Math.round(graceSeconds))} s unless the link comes back. Nothing new is sent meanwhile.`,
  actions: [{ label: "Disconnect" }],
});

export const lost = (host: string): BubbleWords => ({
  title: `Lost ${host}`,
  text: "The connection dropped, so everything there stopped. I'll try to reconnect.",
  actions: [{ label: "Reconnect" }, { label: "Stop trying" }],
});

export const signInAgain = (host: string): BubbleWords => ({ title: `${host} needs you to sign in again`, text: "Reconnect to sign in.", actions: [{ label: "Reconnect" }] });

export const stoppedFromRemote = (host: string): BubbleWords => ({ title: `Stopped on ${host}`, text: `Someone at ${host} pressed Stop.`, actions: [] });

/** Only the tasks using its desktop stop (§5.3.4 step 8); tasks running only commands there go on. */
export const screenLocked = (host: string): BubbleWords => ({ title: `Stopped on ${host}`, text: `${host}'s screen locked, so I stopped working on its screen.`, actions: [] });

export const sessionInactive = (host: string): BubbleWords => ({ title: `Stopped on ${host}`, text: `${host}'s desktop session isn't active any more, so I stopped working on its screen.`, actions: [] });

export const backHere = (host: string): BubbleWords => ({ title: "Back on this computer", text: `${host} isn't connected any more, so I'll work here.`, actions: [] });

/** A command question: the card itself shows in the command window (R7: never the command in the bubble). */
export const commandQuestion = (kind: TargetKind, label: string): BubbleWords => ({
  title: "May I run a command?",
  text: `${placeWords(kind, label)}. It's shown in full in Ember's command window.`,
  actions: [{ label: "Show the command" }, { label: "Not now" }],
});

/** An announcement (D4.4): `announce` is the flow's words ("Pushing to GitHub, as you asked"). */
export const announcement = (announce: string, kind: TargetKind, label: string, seconds: number): BubbleWords => ({
  title: announce,
  text: `${placeWords(kind, label)}. It starts in ${Math.max(0, Math.round(seconds))} seconds.`,
  actions: [{ label: "Stop" }],
});

/** The commands card is waiting in the prompt window. */
export const commandsCardQuestion = (kind: TargetKind, label: string): BubbleWords => ({
  title: kind === "local" ? "Turn on commands on this computer?" : `Turn on commands on ${label}?`,
  text: "Ember needs your OK first. Read what it means in the window that opened.",
  actions: [{ label: "Read it" }, { label: "Not now" }],
});

export const wslFirstSeen = (): BubbleWords => ({
  title: "Ember can work in WSL",
  text: "It can read and use your Linux apps and run commands there. Turn it on in settings?",
  actions: [{ label: "Open settings" }, { label: "Not now" }],
});

/** What is spoken and put in a notification for a command question (R7: only this, never the command; §3.9.1). */
export const commandSpoken = (kind: TargetKind, label: string): string => `Ember wants to run a command on ${kind === "local" ? "this computer" : label}.`;
