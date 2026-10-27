/**
 * Ember's own GitHub App, for the device-flow sign-in ("Sign in with GitHub"), and what every sign-in message says
 * while there is none.
 *
 * GITHUB_CLIENT_ID is the one checked-in place for the app's public client id: the build bundles this file into
 * main.cjs, so filling it in is a one-line change. EMBER_GITHUB_CLIENT_ID overrides it at run time (any build). While
 * both are empty there is no device flow: Ember signs in through the GitHub CLI, and every message, the doctor row and
 * the README say that this needs a GitHub account with Copilot and the GitHub CLI, and how to install it on this OS.
 * Pure (no Electron), so the doctor and the unit tests use it too.
 */

import type { OS } from "../../shared/shortcuts";
import type { SignInProgress } from "../../shared/ipc";

/** Ember's GitHub App's public client id (not a secret). Empty until the app is registered (PLAN.md §7). */
export const GITHUB_CLIENT_ID = "";

/** How a client id looks (GitHub's are "Iv1.…", "Iv23…" or "Ov23…"): anything else is ignored rather than sent to GitHub. */
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The client id the device flow uses: EMBER_GITHUB_CLIENT_ID, else the built-in one (also when the variable holds
 * something that isn't a client id); null when neither is usable.
 */
export function githubClientId(env: NodeJS.ProcessEnv = process.env, builtIn: string = GITHUB_CLIENT_ID): string | null {
  return [(env.EMBER_GITHUB_CLIENT_ID ?? "").trim(), builtIn.trim()].find(id => CLIENT_ID.test(id)) ?? null;
}

/** How sign-in works in this build: Ember's own GitHub App (device flow), or the GitHub CLI's sign-in. */
export type SignInWith = "github" | "github-cli";

/** How to install the GitHub CLI on each OS, as it follows "install it:" (RHEL 8 needs GitHub's own repository). */
export const GH_INSTALL: Readonly<Record<OS, string>> = {
  linux: "sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo, then sudo dnf install gh",
  win32: "winget install --id GitHub.cli in PowerShell, or the installer from cli.github.com",
  darwin: "brew install gh, or the installer from cli.github.com",
};

/** Where to get the GitHub CLI: the Copilot section's Open button shows it while Ember waits and gh is missing. */
export const GH_CLI_PAGE = "https://cli.github.com/";

/** The pages the sign-in's Open button may show: GitHub's own (the device code page), and the GitHub CLI's download page. */
export function mayOpenSignInPage(url: string | null): boolean {
  return !!url && (/^https:\/\/github\.com\//.test(url) || url === GH_CLI_PAGE);
}

/** The requirement, in one sentence: a GitHub account with Copilot and the GitHub CLI, and how to install it here. */
export function cliSignInNeeds(os: OS): string {
  return `Signing in needs a GitHub account with Copilot and the GitHub CLI (install it: ${GH_INSTALL[os]}).`;
}

/** The first steps of a GitHub CLI sign-in: install gh when it is missing, then `gh auth login` in a terminal. */
export function cliSteps(os: OS, ghInstalled: boolean): string {
  return ghInstalled
    ? `Signing in needs a GitHub account with Copilot and the GitHub CLI. In a terminal, run “gh auth login”.`
    : `The GitHub CLI isn't installed on this computer. Signing in needs it and a GitHub account with Copilot: install it (${GH_INSTALL[os]}), then run “gh auth login” in a terminal.`;
}

/** What the Copilot section says while Ember waits for a GitHub CLI sign-in (no restart is needed). */
export function cliWaitingMessage(os: OS, ghInstalled: boolean): string {
  return `${cliSteps(os, ghInstalled)} Ember will notice within a few seconds and connect; no restart needed.`;
}

/**
 * How the wait for a GitHub CLI sign-in starts: what the Copilot section says and, while gh is missing, an Open button
 * for its download page (`page`: the one page that button may open; null with gh installed).
 */
export function cliWaitStart(os: OS, ghInstalled: boolean): { progress: SignInProgress; page: string | null } {
  const message = cliWaitingMessage(os, ghInstalled);
  return ghInstalled
    ? { progress: { state: "waiting", message }, page: null }
    : { progress: { state: "waiting", message, link: "Open cli.github.com" }, page: GH_CLI_PAGE };
}

/** What it says when the wait for a GitHub CLI sign-in ran out. */
export function cliTimedOutMessage(os: OS, ghInstalled: boolean): string {
  return `Ember didn't see a new GitHub sign-in. ${cliSteps(os, ghInstalled)} Then press Check again.`;
}

/** "Check again" found no sign-in: what to do, for how this build signs in. */
export function noSignInMessage(o: { os: OS; with: SignInWith; ghInstalled: boolean }): string {
  if (o.with === "github") return "No GitHub sign-in found on this computer. Press Sign in with GitHub, or run “gh auth login” in a terminal and press Check again.";
  return `No GitHub sign-in found on this computer. ${cliSteps(o.os, o.ghInstalled)} Then press Check again.`;
}
