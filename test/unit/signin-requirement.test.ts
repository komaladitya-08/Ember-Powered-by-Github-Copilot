/**
 * Sign-in while Ember has no GitHub App of its own (review #93, #136, #199, #213; owner decision S1): one checked-in
 * place for the client id, EMBER_GITHUB_CLIENT_ID overriding it, and every sign-in message, the doctor row and the
 * settings window saying that signing in needs a GitHub account with Copilot and the GitHub CLI (and how to install it).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import type { Logger } from "../../app/main/logger";
import { GH_INSTALL, GITHUB_CLIENT_ID, cliSignInNeeds, cliTimedOutMessage, cliWaitingMessage, githubClientId, noSignInMessage } from "../../app/main/agent/github-app";
import { doctorChecks, type DoctorProbes } from "../../app/main/doctor";
import { inspectEnvironment } from "../../app/main/environment";
import { AdminPolicySchema } from "../../app/main/admin";
import { retryMessage, signInLabel } from "../../app/renderer/home/copy";
import { SHORTCUTS } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe("the GitHub App's client id", () => {
  it("is checked in empty until the app is registered, so a build without it has no device flow", () => {
    expect(GITHUB_CLIENT_ID).toBe("");
    expect(githubClientId({})).toBeNull();
  });

  it("is the built-in one once it is filled in, and EMBER_GITHUB_CLIENT_ID overrides it at run time", () => {
    expect(githubClientId({}, "Iv1.0123456789abcdef")).toBe("Iv1.0123456789abcdef");
    expect(githubClientId({ EMBER_GITHUB_CLIENT_ID: " Ov23liABCDEF " }, "Iv1.0123456789abcdef")).toBe("Ov23liABCDEF");
    expect(githubClientId({ EMBER_GITHUB_CLIENT_ID: "" }, "Iv1.0123456789abcdef")).toBe("Iv1.0123456789abcdef");
  });

  it("ignores something that isn't a client id rather than sending it to GitHub", () => {
    expect(githubClientId({ EMBER_GITHUB_CLIENT_ID: "a b&scope=repo" })).toBeNull();
  });
});

describe("what sign-in says without Ember's own GitHub App", () => {
  it("names the account, Copilot and the GitHub CLI, with this OS's way to install it", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      const needs = cliSignInNeeds(os);
      expect(needs).toMatch(/GitHub account with Copilot/);
      expect(needs).toMatch(/GitHub CLI/);
      expect(needs).toContain(GH_INSTALL[os]);
    }
    expect(GH_INSTALL.win32).toMatch(/winget install --id GitHub\.cli/);
    expect(GH_INSTALL.darwin).toMatch(/brew install gh/);
    expect(GH_INSTALL.linux).toMatch(/sudo dnf install gh/);
  });

  it("says the GitHub CLI isn't installed, and how to get it, when it is missing", () => {
    const waiting = cliWaitingMessage("win32", false);
    expect(waiting).toMatch(/GitHub CLI isn't installed/);
    expect(waiting).toContain("winget install --id GitHub.cli");
    expect(waiting).toMatch(/gh auth login/);
    expect(waiting).toMatch(/no restart needed/);
    // Installed: only the sign-in step (and still the requirement).
    expect(cliWaitingMessage("darwin", true)).toMatch(/GitHub account with Copilot and the GitHub CLI\. In a terminal, run “gh auth login”/);
    expect(cliWaitingMessage("darwin", true)).not.toMatch(/isn't installed/);
    expect(cliTimedOutMessage("linux", false)).toMatch(/isn't installed[\s\S]*sudo dnf install gh[\s\S]*Check again/);
  });

  it("Check again that finds nothing says the same (and a build with the app points to its button)", () => {
    expect(noSignInMessage({ os: "darwin", with: "github-cli", ghInstalled: false })).toMatch(/No GitHub sign-in found[\s\S]*isn't installed[\s\S]*brew install gh/);
    expect(noSignInMessage({ os: "linux", with: "github", ghInstalled: true })).toMatch(/Press Sign in with GitHub/);
  });

  it("the settings window shows the message main sends with Check again's answer", () => {
    const hint = noSignInMessage({ os: "win32", with: "github-cli", ghInstalled: false });
    expect(retryMessage({ found: false, source: null, hint })).toBe(hint);
    // A main that sends none: as before.
    expect(retryMessage({ found: false, source: null })).toMatch(/No GitHub sign-in found/);
  });
});

describe("the doctor's Copilot row without Ember's own GitHub App", () => {
  const versions = { electron: "44.5.0", chrome: "152", node: "24" };
  const env = inspectEnvironment({ env: {}, osRelease: null, glibc: null, versions, platform: "win32", arch: "x64",
    windows: { build: 22631, elevated: false, session: "console", powershell: "full", dpiMixed: false } });
  const probes = (over: Partial<DoctorProbes>): DoctorProbes => ({
    os: "win32", env, compositor: true, xtest: true, speechDispatcher: true, microphones: null, voiceModels: "bundled", runtime: true,
    auth: null, admin: { policy: AdminPolicySchema.parse({}), source: null }, desk: null, sandbox: null,
    shortcuts: SHORTCUTS.win32, words: PLATFORM_WORDS.win32, extra: [], ...over,
  });
  const copilot = (over: Partial<DoctorProbes>) => doctorChecks(probes(over)).find(c => c.id === "copilot");

  it("says sign-in needs a GitHub account with Copilot and the GitHub CLI, with the install command", () => {
    const row = copilot({ signIn: { with: "github-cli", ghInstalled: false } });
    expect(row?.status).toBe("warn");
    expect(row?.fix).toMatch(/GitHub account with Copilot/);
    expect(row?.fix).toContain("winget install --id GitHub.cli");
    expect(row?.fix).toMatch(/gh auth login/);
    expect(row?.fix).not.toMatch(/Sign in with GitHub/);
  });

  it("with gh installed, only the sign-in step", () => {
    expect(copilot({ signIn: { with: "github-cli", ghInstalled: true } })?.fix).toMatch(/^Signing in needs a GitHub account with Copilot and the GitHub CLI\. In a terminal, run “gh auth login”/);
  });

  it("with the app built in, offers its button as before", () => {
    expect(copilot({ signIn: { with: "github", ghInstalled: false } })?.fix).toBe("Open Ember's settings (Win+Alt+E) and choose “Sign in with GitHub”, or run “gh auth login”.");
  });
});

describe("the Copilot section without Ember's own GitHub App", () => {
  it("labels the button for the GitHub CLI, not a browser sign-in", () => {
    expect(signInLabel("github-cli")).toBe("Connect with GitHub CLI");
    expect(signInLabel("github")).toBe("Sign in with GitHub");
    expect(signInLabel(undefined)).toBe("Sign in with GitHub");
  });

  it("the signed-out line says what signing in needs, and the status says how this build signs in", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-signin-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const make = (signInWith?: "github" | "github-cli") => new AgentHost({
      userData: dir, runtimePath: "/nowhere", settings, log: quiet, setState: () => undefined, onStatus: () => undefined, ...(signInWith ? { signInWith } : {}),
    });
    const cli = make("github-cli");
    expect(cli.getStatus()).toMatchObject({ phase: "signed-out", signInWith: "github-cli" });
    expect(cli.getStatus().detail).toMatch(/GitHub account with Copilot and the GitHub CLI/);
    expect(await cli.start(null)).toBe("signed-out");
    expect(cli.getStatus().detail).toMatch(/GitHub CLI/);
    // A build with the app (and a host told nothing): as before.
    expect(make("github").getStatus().detail).toBe("Not connected to Copilot: sign in with GitHub below.");
    expect(make().getStatus().detail).toBe("Not connected to Copilot: sign in with GitHub below.");
  });
});
