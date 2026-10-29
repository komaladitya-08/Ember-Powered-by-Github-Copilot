/**
 * The user and administrator docs (README.md, CHANGELOG.md, docs/*.md) against the code they describe: each case reads
 * the fact from the code or the packaging data and checks the docs say it, so a change on one side shows up here.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { announcement, type BubbleView } from "@ember/bubble";
import { GH_INSTALL } from "../../app/main/agent/github-app";
import { readTimeOf } from "../../app/main/agent/presenter";
import { ANNOUNCE_MS } from "../../app/main/commands/flow";
import { WINDOWS_MIC_FIX } from "../../app/main/environment";
import { logLevel } from "../../app/main/logger";
import { pagePrefs, prefsScript } from "../../app/main/page-prefs";
import * as commandWindow from "../../app/main/commands/window";
import { CHARACTERS, DEFAULT_SETTINGS } from "../../app/main/settings";
import { macVersionFromDarwin } from "../../app/main/platform/darwin/system/permissions";
import type { TargetEntry } from "../../app/main/targets/registry";
import { targetMenu } from "../../app/main/targets/menu";
import * as commandCopy from "../../app/renderer/command/copy";
import { terminalOptions } from "../../app/renderer/command/terminal-options";
import { cardsCorner } from "../../app/renderer/overlay/layout";
import * as targetCopy from "../../app/renderer/overlay/target-copy";
import { wslFirstSeen } from "../../app/renderer/overlay/target-copy";
import * as promptCopy from "../../app/renderer/prompt/copy";
import { MIC_PROBLEM_MENU } from "../../app/shared/mic";
import { ISSUES_URL } from "../../app/shared/support";
import { artifactNames, layoutFor, REMOTE_PARTS_DIR } from "../../scripts/package/layout.mjs";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
const packageVersion = (JSON.parse(read("package.json")) as { version: string }).version;
/** Text with its line breaks and runs of spaces made single spaces, so a phrase can span wrapped lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");
/**
 * One section of a Markdown file: from its heading to the next heading of the same or a higher level (a `#` line in
 * a fenced code block is a shell comment, not a heading).
 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  let fenced = false;
  const level = lines.map(l => {
    if (l.startsWith("```")) fenced = !fenced;
    return !fenced && /^#+\s/.test(l) ? /^#+/.exec(l)![0].length : 0;
  });
  const at = lines.findIndex((l, i) => level[i] > 0 && l.replace(/^#+\s*/, "") === heading);
  if (at < 0) throw new Error(`no section "${heading}"`);
  const end = level.findIndex((n, i) => i > at && n > 0 && n <= level[at]);
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

/**
 * The docs describe the release: fix/docs merged after the other packages' fixes they describe, each known here by its
 * code. On fix/docs alone none of them is here yet, so the lines that need them can't be checked against it; once any
 * is, all must be (merge fix/docs after them all), and each such line is checked against its code, so a fix reverted
 * later fails here instead of leaving the docs wrong.
 */
const homePage = read("app/renderer/home/index.html");
const computersCopy = read("app/renderer/home/computers-copy.ts");
/** The label of the button in Settings › Computers that removes Ember's helper from a computer, for build-01. */
const removeHelper = (/label: (["`])([^"`]+)\1, act: \{ kind: "uninstall"/.exec(computersCopy)?.[2] ?? "").replace("${label}", "build-01");
const RELEASE: { from: string; what: string; here: boolean }[] = [
  { from: "fix/remote", what: "the WSL offer for a distro Settings lists", here: /\.\.\.wslListedNames\(\)\]/.test(read("app/main/targets/runtime.ts")) },
  { from: "fix/ask", what: "Ask Ember… and Stop everything under Comfort & access › Ember on screen", here: /id="p-ask"/.test(homePage) && /id="p-stop"/.test(homePage) },
  { from: "fix/voice", what: "the Voice section's choice of when Ember speaks", here: /<select id="speak">/.test(homePage) },
  { from: "fix/bubble", what: "More time to read and answer", here: /id="more-time"/.test(homePage) },
  { from: "fix/css", what: "Text size", here: /id="text-size"/.test(homePage) },
  { from: "fix/cmdwin", what: "the longer announcement while a screen reader runs", here: "ANNOUNCE_SCREEN_READER_MS" in commandWindow },
  { from: "fix/overlay", what: "the desk's way back, said when you take over", here: fs.existsSync(path.resolve("app/renderer/desk/a11y.ts")) },
  { from: "fix/prompt", what: "the cards' notes on the keyboard and on reading a consent card", here: "KEYBOARD_ELSEWHERE_HINT" in promptCopy },
  { from: "fix/settings", what: "Settings › Computers' Remove helper", here: removeHelper === "Remove helper" },
];
/** Every fix the docs describe is here: the release (on fix/docs alone, none is). */
const released = RELEASE.every(f => f.here);
/** A module of the release, by its path: only a check that runs once `released` loads one (it isn't on fix/docs alone). */
const load = async <T>(rel: string): Promise<T> => (await import(path.resolve(rel))) as T;

describe("the release the docs describe", () => {
  it("has every fix the docs describe, or none of them (fix/docs on its own)", () => {
    if (!RELEASE.some(f => f.here)) return;
    const missing = RELEASE.filter(f => !f.here).map(f => `${f.from}: ${f.what}`);
    expect(missing, "merge fix/docs after these fixes, or take out of the docs what they bring").toEqual([]);
  });
});

describe("docs/DESIGN.md", () => {
  it("names only the places where a character can really be chosen", () => {
    const main = read("app/main/main.ts");
    // The handle menu: showMenu's template, from Menu.buildFromTemplate to the end of its list.
    const start = main.indexOf("const menu = Menu.buildFromTemplate([");
    expect(start).toBeGreaterThan(0);
    const menu = main.slice(start, main.indexOf("]);", start));
    const menuPicks = CHARACTERS.some(c => new RegExp(c, "i").test(menu)) || /character/i.test(menu);
    const chosen = /chosen in ([^.]+)\./.exec(flat(read("docs/DESIGN.md")))?.[1] ?? "";
    expect(chosen).not.toBe("");
    expect(/handle menu/.test(chosen)).toBe(menuPicks);
  });
});

describe("docs/DEVELOPING.md", () => {
  it("§10.5 says what every file Ember stages beside the Windows app is", () => {
    const table = section(read("docs/DEVELOPING.md"), "10.5 Packages");
    const win = layoutFor("win32", "x64");
    // resources\sidecar\uia\ is one entry for the bridge's two files; every other staged file is named on its own.
    const named = [...new Set(win.sidecarFiles.map(f => (f.to.startsWith("sidecar/uia/") ? "sidecar/uia/" : f.to)))];
    for (const rel of [...named, `${REMOTE_PARTS_DIR}/`]) expect(table).toContain(`resources\\${rel.replace(/\//g, "\\")}`);
    for (const l of win.launchers ?? []) expect(table).toContain(l.to);
  });

  it("§5 gives RHEL 8's way to install the GitHub CLI, as sign-in's messages and the README do (cross-review X18)", () => {
    // RHEL 8 (§1–§9's platform) has no gh package: GitHub's own repository comes first.
    const steps = GH_INSTALL.linux.split(", then ");
    expect(steps.length).toBe(2);
    const copilot = section(read("docs/DEVELOPING.md"), "Connecting Copilot");
    for (const step of steps) expect(copilot, step).toContain(step);
    expect(copilot).not.toMatch(/^sudo dnf install -y gh\b/m);
  });

  it("§5 and §7 say how Ember keeps its files, logs and login entry, as the code does", () => {
    const dev = read("docs/DEVELOPING.md");
    const keeps = flat(section(dev, "Where Ember keeps things"));
    // The audit log's default retention, per entry (admin.ts).
    const days = Number(/const DEFAULT_RETENTION_DAYS = (\d+)/.exec(read("app/main/admin.ts"))?.[1]);
    expect(days).toBeGreaterThan(0);
    for (const where of [keeps, flat(section(dev, "10.6 Where Ember keeps things")), flat(section(dev, "11.6 Where Ember keeps things"))]) {
      expect(where).toContain(`with each task's request and result (JSON lines, each entry kept ${days} days`);
    }
    // settings.json's unusable copies and the settle time of a repairable hand edit (settings.ts).
    const settings = read("app/main/settings.ts");
    const keep = Number(/const KEEP_BACKUPS = (\d+)/.exec(settings)?.[1]);
    const settle = Number(/const SETTLE_MS = (\d+)/.exec(settings)?.[1]);
    expect(keeps).toContain(`\`settings.json.bad-<time>\` (the ${["", "", "two", "three", "four"][keep]} newest are kept); one it can repair is tidied once it has stayed the same for ${settle / 1000} s`);
    // EMBER_LOG_LEVEL in any case, anything else info (logger.ts).
    expect(logLevel("DEBUG").level).toBe("debug");
    expect(logLevel("loud")).toEqual({ level: "info", unknown: "loud" });
    expect(keeps).toContain("`debug`, `info`, `warn` or `error`, in any case; anything else means `info`");
    // The login entry Ember made, marked so it never deletes one it didn't make (autostart.ts).
    const marker = /const MANAGED = "([^"]+)"/.exec(read("app/main/autostart.ts"))?.[1] ?? "";
    expect(marker).toBe("X-Ember-Managed=true");
    expect(flat(section(dev, "7. Packages"))).toContain(`\`~/.config/autostart/ember.desktop\` (marked \`${marker}\`); an \`ember.desktop\` you made yourself is left alone`);
  });

  it("§10.9 gives the microphone switch's path on Windows 10 and 11, as the setup check does", () => {
    const paths = [...WINDOWS_MIC_FIX.matchAll(/Settings › [^()]+?microphone/g)].map(m => m[0]);
    expect(paths.length).toBe(2);
    const row = flat(section(read("docs/DEVELOPING.md"), "10.9 Troubleshooting").split("\n").find(l => l.startsWith("| Microphone |")) ?? "");
    for (const p of paths) expect(row, p).toContain(p);
  });

  it("says a failed task card goes on its own after about a minute, as the task list times it (review #147)", () => {
    const ms = Number(/status === "failed" \? this\.d\.failureCardMs \?\? ([\d_]+)/.exec(read("app/main/agent/tasks.ts"))?.[1].replace(/_/g, ""));
    expect(ms).toBe(60_000);
    const asking = flat(section(read("docs/DEVELOPING.md"), "Asking Ember to do things"));
    expect(asking).not.toMatch(/a failed card stays until you close it/);
    expect(asking).toContain("a failed card goes on its own after about a minute (the settings window's Conversation section keeps what went wrong)");
  });

  it("says what More time to read and answer scales, as the presenter and the question's wait do", () => {
    // presenter.ts: every bubble's time times readTimeOf; main.ts: a question's wait, 2 minutes times the same.
    expect(readTimeOf(true)).toBe(10);
    expect(read("app/main/main.ts")).toMatch(/timeoutMs: \(\) => 120_000 \* readTime\(\)/);
    const using = flat(section(read("docs/DEVELOPING.md"), "Using Ember"));
    expect(using).toMatch(/\*\*More time to read and answer\*\* keeps every bubble ten times as long[^.]*, a question waits 20 minutes instead of 2[^.]*an offer to bring Ember to a computer 250 seconds instead of 25/);
  });

  it("§14.4 says when remote.yml runs, and that its macOS job runs on every push", () => {
    const wf = read(".github/workflows/remote.yml");
    const macIf = /\n {2}ssh-macos:\n(?:.*\n)*? {4}if: (.*)\n/.exec(wf)?.[1] ?? "";
    expect(macIf).toMatch(/github\.event_name == 'push'/);
    expect(macIf).not.toMatch(/pull_request/);
    const s144 = flat(section(read("docs/DEVELOPING.md"), "14.4 Tests and CI"));
    expect(s144).not.toMatch(/the macOS job runs only when dispatched and on Mondays/);
    expect(s144).toMatch(/Its macOS job runs on each of those pushes \(release tags included\), when dispatched and on Mondays, but not on pull requests/);
    const row = s144.split("| `ssh-macos` |")[1] ?? "";
    expect(row).toMatch(/^ `macos-15`; every push, dispatch and Mondays \|/);
  });

  it("says how to publish a release: every file the README downloads, and the SHA256SUMS users check them with", () => {
    const publish = section(read("docs/DEVELOPING.md"), "15. Publishing a release");
    // The files a release has (the README's Download and install steps), in §7's spelling with <v> for the version.
    const files = (v: string) => [
      `ember-${v}-1.el8.x86_64.rpm`, `ember-voice-models-${v}-1.el8.noarch.rpm`, `Ember-${v}-x86_64.AppImage`,
      ...[layoutFor("win32", "x64"), layoutFor("darwin", "arm64"), layoutFor("darwin", "x64")].flatMap(l => artifactNames(l, v)),
    ];
    for (const f of files("<v>")) expect(flat(publish), f).toContain(`\`${f}\``);
    // The command that writes SHA256SUMS: "hash  name" lines, which the README's sha256sum -c reads; its patterns
    // take in every file of the release.
    const cmd = /^ *sha256sum ([^\n>]+?) > SHA256SUMS$/m.exec(publish)?.[1] ?? "";
    const globs = cmd.split(/\s+/).filter(Boolean).map(g => new RegExp(`^${g.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`));
    expect(globs.length).toBeGreaterThan(0);
    for (const f of files(packageVersion)) expect(globs.some(g => g.test(f)), f).toBe(true);
    expect(section(read("README.md"), "Download")).toMatch(/^sha256sum -c SHA256SUMS\b/m);
  });
});

describe("docs/COMMANDS-WSL-SSH.md", () => {
  const doc = read("docs/COMMANDS-WSL-SSH.md");

  it("says a Wayland remote is commands only while packaged builds never use its desktop", () => {
    // app/remote/main.ts: a packaged agent never reads a Wayland desktop (only a development run with the test switch).
    const packagedNever = /waylandText: !o\.packaged/.test(read("app/remote/main.ts"));
    const row = section(doc, "1. Choosing where Ember works").split("\n").find(l => /Wayland desktop/.test(l)) ?? "";
    const apps = row.split("|")[2] ?? "";
    expect(apps.trim()).not.toBe("");
    expect(/commands only/.test(apps)).toBe(packagedNever);
    // The release notes and the README say the same.
    if (packagedNever) {
      expect(flat(read("CHANGELOG.md"))).not.toMatch(/On a remote Wayland desktop, reading and using controls only/);
      expect(flat(read("README.md"))).toMatch(/X11 desktop/);
    }
  });

  it("says the commands card comes from the settings switch, as no task is offered commands while they are off", () => {
    // worker.ts offers run_command only when the target's commands aren't "off", and "off" is what a switch that was
    // never turned on gives (local-service.ts), so no task can bring up the first card.
    expect(read("app/main/agent/worker.ts")).toMatch(/c\.capability\(\)\.state === "off"\) return null/);
    expect(read("app/main/targets/local-service.ts")).toMatch(/if \(!o\.setting\?\.on\) return \{ state: "off"/);
    const s21 = flat(section(doc, "2.1 Turning them on"));
    expect(s21).not.toMatch(/or a task needs one/);
    expect(s21).toMatch(/When you turn one on, Ember shows the card/);
  });

  it("says Ember offers WSL when a request names it while WSL is off, not when it first sees WSL", () => {
    const runtime = read("app/main/targets/runtime.ts");
    // offerWsl's one caller is the bind path for a request that names "WSL" (in the release, or a distro Settings
    // lists: fix/remote adds them to the same list) while WSL is off.
    expect(runtime.match(/\bofferWsl\(\)/g)?.length).toBe(2);
    expect(runtime).toMatch(/targetsNamed\(words, \[\{ id: "wsl:WSL", names: \["WSL"\] \}[^\n]*\n(?:[^\n]*\n){0,5}[^\n]*offerWsl\(\)/);
    const s31 = flat(section(doc, "3.1 Turning it on"));
    expect(s31).not.toMatch(/first sees WSL/);
    expect(s31).toMatch(/When you ask for something in WSL/);
  });

  it("§4.1 names the switch that turns the offers off as Settings › Computers has it", () => {
    const offer = /export const OFFER_SWITCH = "([^"]+)"/.exec(computersCopy)?.[1] ?? "";
    expect(offer).toMatch(/SSH$/);
    expect(flat(section(doc, "4.1 Connecting"))).toContain(`Turn the offers off with **${offer}**`);
  });

  it.runIf(released)("says a request that names a distro Settings lists brings the WSL offer too, with the offer's words", () => {
    const s31 = flat(section(doc, "3.1 Turning it on"));
    expect(s31).toMatch(/When you ask for something in WSL or in a distro Settings lists while WSL is off for Ember/);
    expect(s31).toContain(`Ember offers "${wslFirstSeen().title}"`);
  });

  it.runIf(released)("says the commands card's Turn on waits until the whole card has been read, in the card's words", () => {
    const s21 = flat(section(doc, "2.1 Turning them on"));
    expect(s21).toContain(`scroll to its end: "${(promptCopy as { CONSENT_READ_HINT?: string }).CONSENT_READ_HINT}"`);
  });
});

describe("README.md", () => {
  const readme = read("README.md");
  const version = (JSON.parse(read("package.json")) as { version: string }).version;

  it("says where to download every file a release has, and how to check it", () => {
    const download = flat(section(readme, "Download"));
    expect(download).toMatch(/\[Releases page\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\)/);
    expect(download).toContain("SHA256SUMS");
    // Each OS's own section names the files it installs from there.
    const files = [`ember-${version}-1.el8.x86_64.rpm`, `Ember-${version}-x86_64.AppImage`, ...artifactNames(layoutFor("win32", "x64"), version), artifactNames(layoutFor("darwin", "arm64"), version)[1]];
    for (const f of files) expect(readme).toContain(f);
    for (const os of ["Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)", "Install on Windows", "Install on macOS"]) expect(flat(section(readme, os)), os).toMatch(/Releases page/);
  });

  it("says how to remove Ember on every OS, with the folders it leaves behind", () => {
    const linux = flat(section(readme, "Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)"));
    const removes = (text: string) => expect(text.split("To remove Ember")[1] ?? "").toMatch(/turn off \*\*Start Ember when I log in\*\*/);
    removes(linux);
    expect(linux).toContain("sudo dnf remove ember");
    // Where Ember keeps things on Linux (DEVELOPING.md §5): its data folder, and the desk's folder.
    for (const p of ["~/.config/autostart/ember.desktop", "~/.config/ember", "~/Ember"]) expect(linux).toContain(p);
    for (const os of ["Install on Windows", "Install on macOS"]) removes(flat(section(readme, os)));
  });

  it("tells whoever removes Ember to remove its helper from the computers it reached over SSH first", () => {
    // Nothing on this computer can remove the helper once Ember is gone: only "Remove Ember from <computer>" or the
    // uninstall.sh the helper leaves there (app/remote/parts/uninstall.sh).
    expect(fs.existsSync(path.resolve("app/remote/parts/uninstall.sh"))).toBe(true);
    for (const os of ["Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)", "Install on Windows", "Install on macOS"]) {
      const removal = flat(section(readme, os)).split("To remove Ember")[1] ?? "";
      expect(removal, os).toMatch(/computers you added over SSH/);
    }
    const ssh = flat(section(readme, "Commands, WSL and other computers"));
    expect(ssh).toMatch(/\*\*Before you remove Ember from this computer\*\*, press \*\*[^*]+\*\* beside each computer you added in Settings › \*\*Computers\*\*/);
    expect(ssh).toContain("sh ~/.local/share/ember-remote/versions/*/uninstall.sh");
    // The button's name, as Settings › Computers has it in the release (and the release notes, and the guide's §4.7).
    if (released) {
      expect(ssh).toContain(`press **${removeHelper}** beside each computer`);
      expect(flat(read("CHANGELOG.md"))).toContain(`Its **${removeHelper}** in Settings › **Computers** removes the helper again`);
    }
  });

  it("has an accessibility section: screen readers on each OS, a keyboard route for every mouse-only thing, the gaps", () => {
    const a11y = flat(section(readme, "Accessibility"));
    for (const reader of ["Orca", "NVDA", "JAWS", "Narrator", "VoiceOver"]) expect(a11y).toContain(reader);
    // Every item of the handle's menu (pointer only: the handle never takes the keyboard) has a keyboard route here.
    const main = read("app/main/main.ts");
    const start = main.indexOf("const menu = Menu.buildFromTemplate([");
    const menu = main.slice(start, main.indexOf("]);", start));
    for (const item of ["Ask Ember…", "Stop everything", "Read the last answer", "Stay put", "Hide Ember", "Quit Ember", "Mute microphone", "Move to the other side"]) {
      expect(menu, item).toContain(`"${item}"`);
      expect(a11y, item).toContain(item === "Mute microphone" ? "microphone" : item);
    }
    // Move to the other side's keyboard route is the setting it flips (review #75).
    expect(a11y).toContain("**Handle position** for **Move to the other side**");
    expect(read("app/renderer/home/index.html")).toContain('<label class="switch-row"><span>Handle position</span><select id="handle-position">');
    expect(a11y).toContain("**Work on**");
    // The desk's way back from a take-over, as the desk view handles it.
    expect(read("app/renderer/desk/main.ts")).toMatch(/e\.key === "End"[^\n]*e\.ctrlKey && e\.altKey/);
    expect(a11y).toContain("Ctrl+Alt+End");
    for (const words of ["Calm mode", "Text size", "contrast", "**Always in this app**", "Known gaps"]) expect(a11y).toContain(words);
  });

  it("gives the microphone switch's path on Windows 10 and 11, as the setup check does (cross-review X17)", () => {
    // WINDOWS_MIC_FIX: the setup check's and the doctor's words, with each supported Windows' page.
    const paths = [...WINDOWS_MIC_FIX.matchAll(/Settings › [^()]+?microphone/g)].map(m => m[0]);
    expect(paths.length).toBe(2);
    const win = flat(section(readme, "Install on Windows"));
    for (const p of paths) expect(win, p).toContain(p);
  });

  it("says which manual CI run keeps each package artifact, as ci.yml makes them (cross-review X17)", () => {
    const ci = read(".github/workflows/ci.yml");
    // The Intel Mac job runs on a manual run only when intel is ticked too; its upload step is inside it.
    const intelIf = /\n {2}macos-x64:\n(?:.*\n)*? {4}if: >-\n((?: {6}.*\n)+)/.exec(ci)?.[1] ?? "";
    expect(intelIf).toMatch(/workflow_dispatch' && inputs\.intel/);
    const download = flat(section(readme, "Download"));
    expect(download).toMatch(/with \*\*packages\*\* ticked also keeps them for 3 days as artifacts \(`ember-packages`, `ember-windows`, `ember-macos`, and `ember-macos-x64` when \*\*intel\*\* is ticked too\)/);
  });

  it("gives each OS's way to a voice, the update's restart and macOS's permissions as the code words them", () => {
    // NO_VOICE in environment.ts: the Speaking row's fix on each OS.
    const env = read("app/main/environment.ts");
    const fixes = {
      "Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)": /linux: "[^"]*Install one with sudo (dnf install [^,]+), then restart Ember\."/.exec(env)?.[1],
      "Install on Windows": /win32: "[^"]*Add one in ([^,]+), then restart Ember\."/.exec(env)?.[1],
      "Install on macOS": /darwin: "[^"]*Choose one in ([^,]+), then restart Ember\."/.exec(env)?.[1],
    };
    for (const [os, fix] of Object.entries(fixes)) {
      expect(fix, os).toBeTruthy();
      expect(flat(section(readme, os)), os).toContain(fix!);
      expect(flat(section(readme, os)), os).toMatch(/a \*\*Speaking\*\* row and a note under \*\*Speak\*\*/);
    }
    // An RPM update while Ember runs: the question's button (install-watch.ts).
    const restart = /buttons: \["([^"]+)", "Not now"\]/.exec(read("app/main/install-watch.ts"))?.[1] ?? "";
    expect(restart).toBe("Restart Ember");
    expect(flat(section(readme, "Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)"))).toContain(`choose **${restart}** to finish the update`);
    // macOS: without Input Monitoring Ember uses neither the mouse nor the keyboard (INPUT_MONITORING_REASON).
    expect(read("app/main/platform/darwin/input.ts")).toMatch(/INPUT_MONITORING_REASON =\s*"[^"]*won't use the mouse or keyboard without it\."/);
    const mac = section(readme, "Install on macOS");
    expect(mac.split("\n").find(l => l.startsWith("| Input Monitoring |"))).toMatch(/Ember uses neither the mouse nor the keyboard for you/);
    expect(read("app/main/platform/darwin/system/environment.ts")).toMatch(/Reset Ember's permissions/);
    expect(flat(mac)).toContain("the setup check offers **Reset Ember's permissions**");
  });

  it("gives Windows users blocked by Smart App Control the way forward", () => {
    const win = flat(section(readme, "Install on Windows"));
    // What the user sees, where the switch is, what turning it off costs, and who to ask on a managed PC.
    expect(win).toMatch(/"Smart App Control blocked an app that may be unsafe"/);
    expect(win).toContain("**Windows Security › App & browser control › Smart App Control settings**");
    expect(win).toMatch(/reset/i);
    expect(win).toMatch(/managed by your organisation[^.]*administrator/);
  });

  it("covers every macOS from 13 to the newest Ember knows with its first-start steps", () => {
    const mac = flat(section(readme, "Install on macOS"));
    const newest = Number(macVersionFromDarwin("25.0.0").split(".")[0]);
    const covered = new Set<number>();
    for (const m of mac.matchAll(/- macOS (\d+)(?: and (\d+)| and later)?:/g)) {
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : /and later/.test(m[0]) ? newest : from;
      for (let v = from; v <= to; v++) covered.add(v);
    }
    for (let v = 13; v <= newest; v++) expect(covered.has(v), `macOS ${v}`).toBe(true);
  });

  it("says to start Ember again after an RPM update, since it starts at login only when that switch is on", () => {
    // Start Ember when I log in is off unless the user turns it on (settings.ts), and the RPM adds no login entry of
    // its own: after quitting to update, nothing starts Ember again by itself.
    expect(DEFAULT_SETTINGS.startAtLogin).toBe(false);
    const login = /<input type="checkbox" id="login" role="switch"><span>([^<]+)<\/span>/.exec(homePage)?.[1] ?? "";
    expect(login).toBe("Start Ember when I log in");
    const update = flat(section(readme, "Install on RHEL 8 (or Rocky, Alma, Oracle Linux 8)")).split("To update")[1]?.split(". ")[0] ?? "";
    expect(update).toContain(`; then start Ember again (it starts by itself at your next login when **${login}** is on)`);
    expect(flat(readme)).not.toMatch(/; Ember starts again at your next login/);
  });

  it("says where settings show the address to report a problem, in the window's own words", () => {
    // The settings window's About this build section lists the issue tracker's address as text to copy: the window
    // never opens links (home/main.ts).
    const about = /<h2 id="about-h">([^<]+)<\/h2>/.exec(homePage)?.[1] ?? "";
    expect(about).toBe("About this build");
    const row = /\["(Report a problem)", ISSUES_URL\]/.exec(read("app/renderer/home/main.ts"))?.[1] ?? "";
    expect(row).toBe("Report a problem");
    const report = flat(section(readme, "Report a problem"));
    expect(report).toContain(`(${ISSUES_URL})`);
    expect(report).toContain(`Settings' **${about}** shows the same address under **${row}**, to copy, and the setup check's advice points there when only a report can help.`);
    expect(report).not.toMatch(/same link/);
  });
});

describe("README.md's Accessibility section, against the release it describes", () => {
  const raw = section(read("README.md"), "Accessibility");
  const a11y = flat(raw);
  /** The keyboard-route table's row for `to` (its first cell), flattened. */
  const row = (to: string) => flat(raw.split("\n").find(l => l.startsWith(`| ${to} |`)) ?? "");
  const gaps = flat(raw.split("**Known gaps.**")[1] ?? "");
  /** The settings window's section (its h2) that holds `id`. */
  const sectionOf = (id: string) => {
    const at = homePage.indexOf(`id="${id}"`);
    const heads = [...homePage.slice(0, at).matchAll(/<h2 [^>]*>([^<]+)<\/h2>/g)];
    return heads.at(-1)?.[1].replace(/&amp;/g, "&");
  };
  /** A <select>'s options in the settings window. */
  const options = (id: string) => [...(new RegExp(`<select id="${id}">([^]*?)</select>`).exec(homePage)?.[1] ?? "").matchAll(/<option value="(\w+)">([^<]+)<\/option>/g)]
    .map(m => ({ value: m[1], text: m[2] }));

  it.runIf(released)("says speaking follows Settings › Voice's choice, with its default, which a screen reader's user can change", async () => {
    const label = /<label for="speak">([^<]+)<\/label>/.exec(homePage)?.[1] ?? "";
    expect(sectionOf("speak")).toBe("Voice");
    const { speakChoice } = await load<{ speakChoice(s: { speak: boolean; speakWithScreenReader: boolean }): string }>("app/shared/speech.ts");
    const byDefault = speakChoice(DEFAULT_SETTINGS as unknown as { speak: boolean; speakWithScreenReader: boolean });
    const choices = options("speak");
    expect(choices.map(o => o.value)).toContain(byDefault);
    expect(a11y).toContain(`Settings › **Voice** › **${label}**`);
    for (const o of choices) expect(a11y).toContain(`**${o.text}**${o.value === byDefault ? " (the default)" : ""}`);
    // Nothing says only the organisation can stop it, here or in the guide.
    expect(a11y).not.toMatch(/even with \*\*Speak replies|only the organisation's policy/);
    expect(flat(read("docs/DEVELOPING.md"))).not.toMatch(/\*\*Speak replies\*\* on \(or a screen reader running\)/);
  });

  it.runIf(released)("gives the time More time to read and answer gives, as settings says it, and no gap for it", () => {
    const more = /More time to read and answer: messages stay ([^,<]+), and questions wait (\d+) minutes/.exec(homePage);
    expect(more).not.toBeNull();
    expect(sectionOf("more-time")).toBe("Comfort & access");
    expect(a11y).toContain(`**More time to read and answer** (messages stay ${more![1]},`);
    expect(a11y).toMatch(new RegExp(`\\*\\*More time to read and answer\\*\\* \\([^)]*a question waits ${more![2]} minutes`));
    expect(gaps).not.toMatch(/question waits|leaves the bubble/);
  });

  it.runIf(released)("names every button of Comfort & access › Ember on screen where the handle's menu, ask and stop are", () => {
    expect(sectionOf("presence-actions")).toBe("Comfort & access");
    expect(homePage).toMatch(/<h3 class="sub">Ember on screen<\/h3>\s*<div class="group">\s*<p[^>]*id="presence-text"/);
    const buttons = [...(/id="presence-actions">([^]*?)<\/div>/.exec(homePage)?.[1] ?? "").matchAll(/<button [^>]*>([^<]+)<\/button>/g)].map(m => m[1]);
    expect(buttons).toEqual(expect.arrayContaining(["Ask Ember…", "Stop everything"]));
    const menuRow = row("What the handle's menu does");
    expect(menuRow).toContain("Settings › **Comfort & access › Ember on screen**");
    for (const b of buttons) expect(menuRow, b).toContain(`**${b}**`);
    expect(row("Ask Ember")).toContain("**Ask Ember…** in settings, under **Comfort & access › Ember on screen**");
    expect(row("Stop")).toContain("**Stop everything** under **Comfort & access › Ember on screen**");
    // The menu's computer items, and Settings › Computers for them.
    const ssh = { id: "ssh:build-01", kind: "ssh", label: "build-01", state: "connecting", can: "", usable: false, listedOnly: false, names: ["build-01"], host: { id: "h1" } };
    const local = { id: "local", kind: "local", label: "This computer", state: "ready", can: "", usable: true, listedOnly: false, names: [] };
    const labels = targetMenu({ entries: [local, ssh] as unknown as TargetEntry[], active: "local", sshAllowed: true, pick: () => undefined, bring: () => undefined, disconnect: () => undefined })
      .map(i => i.label ?? "");
    expect(labels).toContain("Bring Ember to a computer…");
    expect(labels).toContain("Cancel connecting to build-01");
    expect(menuRow).toContain("**Bring Ember to a computer…**, **Disconnect** and **Cancel connecting**: settings' **Computers**");
  });

  it.runIf(released)("says Shift+Enter adds a line in the ask box", async () => {
    const { enterAction } = await load<{ enterAction(e: { shiftKey: boolean; isComposing: boolean }): string }>("app/renderer/ask/field.ts");
    expect(enterAction({ shiftKey: true, isComposing: false })).toBe("newline");
    expect(row("Ask Ember")).toContain("Enter sends (Shift+Enter adds a line)");
  });

  it.runIf(released)("says a screen reader is told how to hand the desk back, and lists no gap for it", async () => {
    const desk = await load<{ HAND_BACK_KEYS: string; modeNews(control: boolean, was: boolean): string | null }>("app/renderer/desk/a11y.ts");
    expect(desk.modeNews(true, false)).toContain(desk.HAND_BACK_KEYS);
    expect(row("Ember's desk (Linux)")).toContain(`until ${desk.HAND_BACK_KEYS} hands it back. A screen reader is told so when you take over`);
    expect(gaps).not.toMatch(/announced/);
  });

  it.runIf(released)("gives the command window's keys and its screen-reader behaviour as the code has them", async () => {
    const srMs = (commandWindow as { ANNOUNCE_SCREEN_READER_MS?: number }).ANNOUNCE_SCREEN_READER_MS ?? 0;
    expect(srMs).toBeGreaterThan(ANNOUNCE_MS);
    expect(a11y).toContain(`A dangerous command you asked for waits ${srMs / 1000} seconds instead of ${ANNOUNCE_MS / 1000} before it runs`);
    expect(flat(read("CHANGELOG.md"))).toContain(`a ${ANNOUNCE_MS / 1000}-second **Stop** (${srMs / 1000} seconds while a screen reader runs)`);
    // What a command prints reaches a screen reader (xterm's screen-reader mode) while one runs.
    expect(terminalOptions({ interactive: false, cols: 80, rows: 24, screenReader: true } as Parameters<typeof terminalOptions>[0]).screenReaderMode).toBe(true);
    expect(a11y).toContain("The command window reads out what a command prints");
    type Key = { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };
    const { termKeyAction } = await load<{ termKeyAction(e: Key, o: { mac: boolean; hasSelection: boolean }): string }>("app/renderer/command/keys.ts");
    const key = (k: string, m: Partial<Key> = {}): Key => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...m });
    const linux = { mac: false, hasSelection: true };
    expect(termKeyAction(key("Tab"), linux)).toBe("browser");
    expect(termKeyAction(key("Tab", { shiftKey: true }), linux)).toBe("browser");
    expect(termKeyAction(key("i", { ctrlKey: true }), linux)).toBe("terminal");
    expect(termKeyAction(key("C", { ctrlKey: true, shiftKey: true }), linux)).toBe("copy");
    const copyOutput = (commandCopy as { COPY_OUTPUT_LABEL?: string }).COPY_OUTPUT_LABEL;
    expect(row("The command window")).toMatch(/^\| The command window \| Tab and Shift\+Tab move between [^|]*\(Ctrl\+I types a Tab for a program that wants one\); Ctrl\+Shift\+C copies/);
    expect(row("The command window")).toContain(`**${copyOutput}** copies all a command printed`);
  });

  it.runIf(released)("names the text sizes and where they reach as settings does, and the contrast themes and badges", () => {
    const sizes = options("text-size").filter(o => o.value !== "default").map(o => o.text);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sectionOf("text-size")).toBe("Comfort & access");
    expect(a11y).toContain(`**Text size** (${sizes.join(" or ")}, for settings,`);
    const hint = /id="text-size">[^]*?<\/label>\s*<\/div>\s*<p class="hint">([^<]+)<\/p>/.exec(homePage)?.[1] ?? "";
    const reach = /\*\*Text size\*\* \(([^)]*)\)/.exec(a11y)?.[1] ?? "";
    for (const place of ["bubble", "task cards", "handle", "command window", "password and consent cards"]) {
      expect(hint, place).toContain(place);
      expect(reach, place).toContain(place);
    }
    // The Ask box and the desk window's bar take the text size (page-prefs.ts) and their windows grow with it (ask.ts
    // askSize, desk/view.ts deskViewBounds): named with the rest, and nothing says either keeps its size (review #57).
    // Settings' hint leaves the desk out: it is Linux's only.
    for (const page of ["ask", "desk"]) expect(prefsScript(pagePrefs({ reduceMotion: false, textSize: "large" }), page), page).toContain('dataset.textSize = "large"');
    expect(hint).toContain("the Ask box");
    expect(reach).toContain("the Ask box");
    expect(reach).toContain("the desk window's bar on Linux");
    for (const said of [hint, reach]) expect(said).not.toMatch(/keeps? (its|their) size/);
    // Windows' contrast themes (forced colours) and the handle's badges drawn per state.
    expect(read("app/renderer/shared/ember.css")).toMatch(/@media \(forced-colors: active\)/);
    expect(fs.existsSync(path.resolve("app/shared/mic.ts"))).toBe(true);
    expect(a11y).toContain("Windows' contrast themes keep switches, edges, focus and state visible, and the handle's microphone and computer badges change shape as well as colour");
  });

  it.runIf(released)("quotes what the bubble tells a screen reader about answering, as the bubble says it", () => {
    const view = { visible: true, mood: "attention", title: "May I?", thought: "Click “Save”?", streaming: false, step: "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" };
    expect(announcement(view as BubbleView)).toContain("Ctrl+Alt+Y allow; Ctrl+Alt+N not now");
    expect(a11y).toContain("(\"Ctrl+Alt+Y allow; Ctrl+Alt+N not now\")");
    const where = (targetCopy as { panelHint?: (kind: "command" | "consent", os: "linux" | "win32" | "darwin") => string }).panelHint;
    expect(where?.("command", "linux")).toMatch(/: press Alt\+Tab to go there\.$/);
    expect(a11y).toContain("(\"press Alt+Tab to go there\")");
    const route = (targetCopy as { keyboardRoute?: (key: string | null) => string }).keyboardRoute;
    expect(route?.("Ctrl+Alt+E")).toBe("Or press Ctrl+Alt+E and go to Computers.");
    expect(row("Bubble buttons for other computers (**Bring Ember**, **Reconnect**, **Try again**)")).toContain("Settings › **Computers** has the same; the bubble says so");
  });

  it.runIf(released)("says what the sign-in and consent cards say about the keyboard and about reading a consent card", () => {
    const { promptHint, KEYBOARD_ELSEWHERE_HINT, CONSENT_READ_HINT } = promptCopy as unknown as {
      promptHint(o: { consent: boolean; seen: boolean; more: boolean; field: boolean; focused: boolean; sinceShownMs: number }): string;
      KEYBOARD_ELSEWHERE_HINT: string; CONSENT_READ_HINT: string;
    };
    expect(promptHint({ consent: false, seen: true, more: false, field: true, focused: false, sinceShownMs: 60_000 })).toBe(KEYBOARD_ELSEWHERE_HINT);
    expect(promptHint({ consent: true, seen: false, more: true, field: false, focused: true, sinceShownMs: 60_000 })).toBe(CONSENT_READ_HINT);
    const cards = row("Sign-in and consent cards");
    expect(cards).toContain("where the system keeps it in another app, a card you type into says so, and Alt+Tab reaches the card");
    expect(cards).toContain("A consent card's yes counts once you have read all of it");
  });
});

/**
 * Round 2's packages, each known here by its code: a package's lines are checked once it is merged, and skipped
 * before (on fix2/docs2 alone). Once any is here, all must be, as for round 1's RELEASE: so a mark that stops finding
 * its code after the merge (a rename, a reformat) fails here instead of quietly skipping that package's lines.
 */
const ROUND2 = {
  auth2: /\n {2}wake\(\): void \{/.test(read("app/main/agent/auth.ts")),
  lifecycle2: /const CARD_UNSHOWN = "/.test(read("app/main/targets/runtime.ts")),
  perception2: fs.existsSync(path.resolve("app/main/perception/text-warm.ts")),
  css2: fs.existsSync(path.resolve("app/renderer/command/terminal-size.ts")),
  ship2: /export function restartAfterUpdate\(/.test(read("app/main/install-watch.ts")),
  bubble2: /case "killswitch": line = `Stopped with everything else after/.test(read("app/renderer/command/copy.ts")),
  runasnode2: fs.existsSync(path.resolve("app/askpass/in-ember.ts")),
  typeahead2: fs.existsSync(path.resolve("app/main/ask-open.ts")),
};

describe("round 2's docs lines, against the packages' code", () => {
  it("has every round 2 package the docs describe, or none of them (fix2/docs2 on its own)", () => {
    const marks = Object.entries(ROUND2);
    if (!marks.some(([, here]) => here)) return;
    const missing = marks.filter(([, here]) => !here).map(([pkg]) => `fix2/${pkg}`);
    expect(missing, "merge fix2/docs2 after these packages; if they are merged, ROUND2's mark no longer finds their code: point it at the code again").toEqual([]);
  });

  it.runIf(ROUND2.auth2)("auth2: says Ember renews its sign-in by itself, waiting for a quiet moment and on waking", () => {
    // auth.ts renews from an hour before when nothing is under way (idle), forced near the end, and on wake().
    expect(read("app/main/agent/auth.ts")).toMatch(/!this\.d\.idle\(\)/);
    expect(read("app/main/main.ts")).toMatch(/powerMonitor\.on\("resume", \(\) => \{ keeper\.wake\(\)/);
    const signIn = flat(section(read("README.md"), "Sign in to Copilot"));
    expect(signIn).toContain("Ember's own GitHub sign-in lasts eight hours at a time: Ember renews it by itself before it runs out (when it isn't in the middle of something, where it can), and as soon as the computer wakes if it ran out during sleep");
    const notes = flat(read("CHANGELOG.md"));
    expect(notes).toMatch(/\*\*Staying signed in\*\*: Ember renews its GitHub sign-in by itself before it runs out[^]*as soon as the computer wakes[^]*is still used until Ember quits/);
  });
});

describe("round 2's docs lines (lifecycle2)", () => {
  it.runIf(ROUND2.lifecycle2)("lifecycle2: quotes what a card Ember couldn't show says, and names a crashed card window", () => {
    const unshown = /const CARD_UNSHOWN = "([^"]+)"/.exec(read("app/main/targets/runtime.ts"))?.[1] ?? "";
    expect(unshown).toBe("Ember couldn't show the card that asks you first, so nothing changed.");
    const guide = flat(read("docs/COMMANDS-WSL-SSH.md"));
    expect(flat(section(read("docs/COMMANDS-WSL-SSH.md"), "2.1 Turning them on"))).toContain(`nothing changes and it says "${unshown}"`);
    expect(guide).toContain("A sign-in card Ember can't show (no window, its window crashed, or a server's question too long to show)");
    const notes = flat(read("CHANGELOG.md"));
    expect(notes).toContain(`"${unshown}" (when connecting, in the bubble with **Try again**)`);
    expect(notes).toMatch(/An old month that can't be removed[^.]*doesn't stop the other old months being pruned/);
    expect(notes).toMatch(/refuses keys and typing before it brings your window to the front/);
  });
});

describe("round 2's docs lines (perception2)", () => {
  it.runIf(ROUND2.perception2)("perception2: gives the typed text's limits, the policy stop's record and the font cache's marker", () => {
    const policy = read("app/main/policy/policy.ts");
    const shown = Number(/const TYPED_SHOWN = (\d+);/.exec(policy)?.[1]);
    const head = Number(/const TYPED_HEAD = (\d+);/.exec(policy)?.[1]);
    const tail = Number(/const TYPED_TAIL = (\d+);/.exec(policy)?.[1]);
    const notes = flat(read("CHANGELOG.md"));
    expect(notes).toContain(`Text over ${shown} characters shows its first ${head} and last ${tail} characters and its length`);
    // The whole of it shows under the question before Allow works (confirm3, review #116): no longer a limit.
    expect(notes).not.toContain(`A question about typing more than ${shown} characters shows only the start and end of the text and its length`);
    expect(notes).toContain(`its length, and all of it in a box under the question`);
    expect(notes).toContain(`**Allow** works once you have scrolled to its end, or it fits ("${read("packages/bubble/src/whole.ts").match(/WHOLE_READ_HINT = "([^"]+)"/)?.[1]}")`);
    const stopped = /what: "(Everything stopped: your organisation changed Ember's policy)"/.exec(read("app/renderer/home/copy.ts"))?.[1] ?? "";
    expect(stopped).not.toBe("");
    expect(notes).toContain(`**What Ember did** records "${stopped}"`);
    expect(flat(section(read("docs/COMMANDS-WSL-SSH.md"), "6.2 Defaults and what fails closed"))).toContain(`records the stop as "${stopped}"`);
    // The warm-up's marker (main.ts) and its log events (text-warm.ts), in §10.6, §11.6 and the troubleshooting tables.
    expect(read("app/main/main.ts")).toMatch(/marker: path\.join\(userData, "text-warmed"\)/);
    const warm = read("app/main/perception/text-warm.ts");
    const dev = read("docs/DEVELOPING.md");
    for (const s of ["10.6 Where Ember keeps things", "11.6 Where Ember keeps things"]) expect(section(dev, s)).toMatch(/ember[\\/]text-warmed` \|/);
    for (const s of ["10.9 Troubleshooting", "11.8 Troubleshooting"]) {
      for (const ev of ["text_warm.done", "text_warm.failed", "text_warm.marker_failed"]) {
        expect(warm).toContain(`"${ev}"`);
        expect(section(dev, s), `${s} ${ev}`).toContain(`\`${ev}\``);
      }
    }
    expect(flat(section(read("docs/COMMANDS-WSL-SSH.md"), "4.4 build-01's screen"))).toContain("even for a request already under way: it doesn't describe the screen, open apps on it or change its settings");
  });
});

describe("round 2's docs lines (css2)", () => {
  it.runIf(ROUND2.css2)("css2: says the text size reaches the command window's terminal, at its sizes", async () => {
    const { termFontSize } = await load<{ termFontSize(scale: number): number }>("app/renderer/command/terminal-options.ts");
    const px = [1, 1.15, 1.3].map(termFontSize);
    expect(px).toEqual([13, 15, 17]);
    const notes = flat(read("CHANGELOG.md"));
    expect(notes).toContain(`Text size also reaches the command window's terminal (${px[0]}, ${px[1]} or ${px[2]} px, at once when you change it; a running command keeps its columns and rows)`);
    expect(notes).toMatch(/first run's \*\*Start Ember\*\* row stays opaque/);
    expect(flat(section(read("README.md"), "Accessibility"))).toContain("the Ask box, the desk window's bar on Linux, the command window and its terminal, and the password and consent cards");
    expect(flat(section(read("docs/DEVELOPING.md"), "Using Ember"))).toContain("the Ask box, the desk window's bar, the command window and its terminal, and Ember's password and consent cards");
  });
});

describe("round 2's docs lines (ship2)", () => {
  it.runIf(ROUND2.ship2)("ship2: says when a restart starts the AppImage again, and what starts remote.yml", () => {
    // restartOptions (admin-watch.ts): the AppImage only when execPath is inside APPDIR.
    expect(read("app/main/policy/admin-watch.ts")).toMatch(/APPDIR/);
    const s7 = flat(section(read("docs/DEVELOPING.md"), "7. Packages"));
    expect(s7).toContain("starts the AppImage again (`$APPIMAGE`, with the same arguments) only when Ember runs from it, that is when `process.execPath` is inside `$APPDIR`");
    // remote.yml's two paths lists, kept equal by remote-workflow.test.ts.
    expect(fs.existsSync(path.resolve("test/unit/remote-workflow.test.ts"))).toBe(true);
    const s144 = flat(section(read("docs/DEVELOPING.md"), "14.4 Tests and CI"));
    expect(s144).toContain("(its two `paths` lists, which must stay equal; `test/unit/remote-workflow.test.ts` fails and names the file when one is left out, so add a pattern to both lists)");
    const wf = read(".github/workflows/remote.yml");
    for (const v of ["EMBER_SSH_TEST_EXPECT_HELLO: \"0\"", "EMBER_SSH_TEST_EXPECT_HELLO: \"1\""]) expect(wf).toContain(v);
    expect(s144).toContain("`EMBER_SSH_TEST_EXPECT_HELLO` makes `ssh-windows` strict: `1` requires the hello, `0` requires the refusal of a kernel older than 4.18");
  });
});

describe("round 2's docs lines (bubble2)", () => {
  it.runIf(ROUND2.bubble2)("bubble2: gives the waiting bubble's Show, the kill switch's line, Read all at larger text and held keys", () => {
    const guide = read("docs/COMMANDS-WSL-SSH.md");
    const s22 = flat(section(guide, "2.2 Ember's command window"));
    // The bubble a command waiting for typing raises (flow.ts) and the hint under it (command/copy.ts).
    expect(read("app/main/commands/flow.ts")).toMatch(/\{ id: show, label: "Show" \}/);
    expect(read("app/renderer/command/copy.ts")).toContain('"Or press Alt+Tab to go there."');
    expect(s22).toContain(`(Needs you) with **Show**, which brings the command window up with the keyboard in the command, and "Or press Alt+Tab to go there." under it on Linux and Windows`);
    expect(s22).toContain(`A command the kill switch ended says "Stopped with everything else after 2 s. What it already changed stays." It names no chord`);
    expect(flat(section(guide, "2.5 When you asked for exactly that"))).toContain(`neither the bubble nor the command window names it: **Stop** is the way, as the spoken "Press Stop to cancel." says`);
    expect(read("app/voice/spoken.ts")).toContain('"Press Stop to cancel."');
    expect(flat(section(guide, "4.1 Connecting"))).toContain(`An offer to work on another computer that you didn't ask for waits while "Lost build-01" or "Can't connect to build-01" is up`);
    // Read all at the user's text size (presenter.ts) and the routes while a shortcut is held elsewhere (target-copy.ts).
    expect(read("app/main/agent/presenter.ts")).toMatch(/six lines at that size offers Read all/);
    expect(read("app/renderer/overlay/target-copy.ts")).toContain("`Or open Ember's settings and go to ${section}.`");
    const using = flat(section(read("docs/DEVELOPING.md"), "Using Ember"));
    expect(using).toContain("Long answers have **Read all** (counted at the text size you picked)");
    expect(using).toContain(`routes say "Or open Ember's settings…", errors and task results say "in Ember's settings", and an announced command names only its **Stop**`);
    const a11y = flat(section(read("README.md"), "Accessibility"));
    expect(a11y).toContain("At Large and Larger, an answer that needs more than six lines at that size offers **Read all**");
    expect(a11y).toContain("also ones that waited behind another or were covered for a while, and Ember's own notices");
    const notes = flat(read("CHANGELOG.md"));
    expect(notes).toMatch(/the task's bubble says so as \*\*Needs you\*\*, with \*\*Show\*\*/);
    expect(notes).toContain(`A command the kill switch ended says "Stopped with everything else"`);
    expect(notes).toContain("an answer that needs more than six lines at that size offers **Read all**");
  });
});

describe("round 2's docs lines (runasnode2)", () => {
  it.runIf(ROUND2.runasnode2)("runasnode2: says the macOS build refuses node mode, and how its accessibility host and askpass start", async () => {
    // fuses.mjs: RunAsNode off for macOS only; launch.ts's utility process; in-ember.ts's switch; ci.yml's macOS suite.
    const { emberFuses } = await load<{ emberFuses(os: string): Record<string, boolean> }>("scripts/package/fuses.mjs");
    expect(["darwin", "linux", "win32"].map(os => emberFuses(os).RunAsNode)).toEqual([false, true, true]);
    expect(read("app/sidecar-host/launch.ts")).toContain('export const HOST_SERVICE_NAME = "Ember accessibility";');
    expect(read("app/askpass/in-ember.ts")).toContain('export const ASKPASS_SWITCH = "--ember-askpass";');
    expect(read(".github/workflows/ci.yml")).toContain("run: node scripts/run-integration.mjs test/integration/askpass-darwin.test.ts");
    const dev = read("docs/DEVELOPING.md");
    expect(flat(section(dev, "11.2 Running Ember in development, and its permissions"))).toContain("Ember's accessibility host is an Electron utility process of Ember's, started by Ember");
    const s113 = flat(section(dev, "11.3 Integration suites"));
    expect(s113).toContain("EMBER_DARWIN_TEST=1 EMBER_PACKAGED_APP=dist/package/Ember.app node scripts/run-integration.mjs test/integration/askpass-darwin.test.ts");
    expect(s113).toContain("| `askpass-darwin` | `EMBER_DARWIN_TEST`, `EMBER_PACKAGED_APP` | SSH's askpass as Ember runs it");
    expect(flat(section(dev, "11.4 The AX provider"))).toContain("The host is an Electron utility process of Ember's (Ember sends each request as a message on its parent port; it answers on stdout)");
    const s115 = flat(section(dev, "11.5 Packages"));
    expect(s115).toContain("RunAsNode is off, so Ember.app refuses `ELECTRON_RUN_AS_NODE`");
    expect(s115).toContain("SSH's askpass is Ember itself, started with `--ember-askpass`");
    expect(s115).not.toMatch(/RunAsNode stays on/);
    expect(flat(dev)).toContain("on a Mac inside Ember itself, started with `--ember-askpass`, which runs it as a worker thread and shows nothing: `in-ember.ts`");
    expect(flat(read("CHANGELOG.md"))).toContain("**Your Mac's permissions stay Ember's**: Ember.app never runs as a plain Node.js program");
  });
});

describe("round 2's docs lines (typeahead2)", () => {
  it.runIf(ROUND2.typeahead2)("typeahead2: says to wait for the ask box on Windows and macOS, its first five openings' tip, and what the probes print", () => {
    // ask.ts: the tip shows where Ember can't hold the letters, for the first WAIT_TIP_OPENINGS openings; field.ts: its
    // words; ask-open.ts: the box shows before the read where Ember can't hold them; main.ts: the log lines the probes read.
    const ask = read("app/main/ask.ts");
    expect(ask).toContain("export const WAIT_TIP_OPENINGS = 5;");
    expect(ask).toContain("return !holds && opened < WAIT_TIP_OPENINGS;");
    expect(read("app/renderer/ask/field.ts")).toContain('export const WAIT_TIP = "Wait for this box before you type: letters typed sooner go to the app underneath.";');
    expect(read("app/main/ask-open.ts")).toMatch(/o\.show\(\);\n {2}o\.read\(active, /);
    expect(read("app/renderer/ask/main.ts")).toContain("window.emberAsk.onHidden(() => input.select());");
    const main = read("app/main/main.ts");
    expect(main).toContain('log.info("ask.keyboard", { ms: Date.now() - askAsked })');
    expect(main).toContain('log.info("ask.open", { source, ms: Date.now() - asked });');
    const shortcuts = flat(section(read("README.md"), "Shortcuts"));
    expect(shortcuts).toContain("On Windows and macOS, wait for the ask box before you type: letters typed before it appears go to the app underneath. (On Linux, Ember holds them and puts them in the box.) The ask box reminds you the first five times it opens.");
    const box = flat(section(read("CHANGELOG.md"), "The ask box"));
    expect(box).toContain("On Windows and macOS it takes the keyboard sooner: it shows before Ember reads the screen.");
    expect(box).toContain("so the first five times it opens there it says to wait for it before typing");
    expect(box).toContain("what was left in it from last time is selected when it closes, not as it opens");
    // The probes print what typeahead-probe.ts's timeline reads, and expect the tip (ember-win32, ember-darwin).
    expect(read("test/integration/typeahead-probe.ts")).toMatch(/e\.msg === "ask\.keyboard"/);
    for (const suite of ["ember-win32", "ember-darwin"]) expect(read(`test/integration/${suite}.test.ts`), suite).toContain('toBe("Wait for this box before you type: letters typed sooner go to the app underneath.")');
    expect(read("test/integration/ember-win32.test.ts")).toContain("the bench's Name field got ${benchNameLength(benchLog) - nameBefore} of the letters");
    const dev = read("docs/DEVELOPING.md");
    const win = flat(section(dev, "10.3 Integration suites"));
    expect(win).toContain("opened with the real Win+Alt+Space, pressed while the user types in the bench's Name field, printing what the ask box holds");
    expect(win).toContain("when Ember heard the chord, showed the box and had the keyboard, how many letters were typed before then and how many reached the bench's Name field, and expecting the box's \"wait for this box\" tip on these first openings");
    const mac = flat(section(dev, "11.3 Integration suites"));
    expect(mac).toContain("from Ember's log (`ask.open`, `ask.keyboard`), when Ember heard the chord, showed the box and had the keyboard and how many letters were typed before then, and expecting the box's \"wait for this box\" tip on these first openings");
  });
});

describe("CHANGELOG.md", () => {
  const changelog = read("CHANGELOG.md");
  const version = (JSON.parse(read("package.json")) as { version: string }).version;

  it("opens with this version and its date, as the first release of Ember on Linux, Windows and macOS", () => {
    const headings = changelog.split("\n").filter(l => l.startsWith("## "));
    expect(headings[0]).toMatch(new RegExp(`^## ${version.replace(/\./g, "\\.")} \\(\\d{4}-\\d{2}-\\d{2}\\)$`));
    expect(changelog).not.toMatch(/^## Unreleased/m);
    const first = flat(section(changelog, headings[0].slice(3)));
    for (const words of ["first release", "Windows", "macOS", "RHEL 8", "Hey Ember", "Cinder", "Commands, WSL and other computers"]) expect(first).toContain(words);
    // A first release has nothing earlier to have changed from.
    expect(first).not.toMatch(/### Changed/);
  });

  it.runIf(released)("names the settings switches as Settings › Computers has them", () => {
    const offer = /export const OFFER_SWITCH = "([^"]+)"/.exec(computersCopy)?.[1] ?? "";
    expect(offer).not.toBe("");
    expect(changelog).toContain(`**${offer}**`);
  });

  it("calls the check the setup check and quotes the cards' and the menu's words as the code has them", () => {
    const notes = flat(changelog);
    // `ember doctor` prints "Ember <v> setup check" (main.ts), the settings window's name for it (review #229).
    expect(read("app/main/main.ts")).toMatch(/`Ember \$\{app\.getVersion\(\)\} setup check\\n/);
    expect(notes).not.toMatch(/check-up/i);
    expect(notes).toContain(`"Ember ${version} setup check"`);
    // The commands card's line when the words name a place that looks like a computer (flow.ts).
    expect(read("app/main/commands/flow.ts")).toContain("`It looks like you named another computer (${listOf(places)}), but this runs ${here}.`");
    expect(notes).toContain(`"It looks like you named another computer (prod-db), but this runs on this computer."`);
    expect(notes).not.toMatch(/"You named prod-db, but this runs on this computer\."/);
    // A first-use card's hint, a declined remote check's tab, the handle's microphone item.
    expect(notes).toContain(`("${promptCopy.CONSENT_READ_HINT}")`);
    expect(notes).toContain(`"${commandCopy.reaskEndText("no")}"`);
    expect(notes).toContain(`"${MIC_PROBLEM_MENU}"`);
  });

  it("says what the post-merge CI rounds fixed, as the code does it (follow-up F-changelog-ci)", () => {
    const notes = flat(changelog);
    // GitHub refusing the device-code request (auth.ts throws, host.ts words it).
    const refused = /return "(GitHub didn't accept Ember's sign-in request\.[^"]*)"/.exec(read("app/main/agent/host.ts"))?.[1] ?? "";
    expect(refused).not.toBe("");
    expect(notes).toContain(`Ember says so instead of showing a code: "${refused}"`);
    // The UIA bridge reads what shows in full on a long level (ember_uia.cs) and leaves the offscreen rest out.
    expect(read("sidecar/uia/ember_uia.cs")).toMatch(/offscreen/);
    expect(notes).toMatch(/On Windows, Ember reads long lists and pages that are scrolled down: it reads what shows in full and leaves most of what is scrolled away out/);
    // macOS app names are folded without format characters (System Settings' soft hyphen in German).
    expect(read("app/main/platform/darwin/system/apps.ts")).toMatch(/\\p\{Cf\}/);
    expect(notes).toMatch(/System Settings as Systemeinstellungen/);
    // A command window whose page crashed comes back (windows.ts revives it) instead of closing.
    expect(notes).toMatch(/a command window whose page crashes comes back with its commands instead of closing/);
  });

  it("says where the task cards and the desk view go with Handle position, as the code places them (review #75)", () => {
    const notes = flat(changelog);
    // A control's ring under the cards sends them to the other bottom corner, whichever side the handle is on.
    const stack = { x: 1500, y: 800, width: 400, height: 200 }, ring = { x: 1600, y: 900, width: 100, height: 30 };
    expect(cardsCorner(ring, stack, 1920, "right")).toBe("left");
    expect(cardsCorner({ ...ring, x: 220 }, { ...stack, x: 20 }, 1920, "left")).toBe("right");
    expect(notes).toContain("and the task cards move to the other bottom corner.");
    expect(notes).not.toMatch(/task cards move to the bottom-left/);
    // The cards follow the handle; the desk view takes the corner away from it (deskViewStart), as the README says.
    expect(notes).toContain("and the task cards follow it, and on Linux the desk view takes the other corner.");
    expect(flat(read("README.md"))).toContain("The task cards go with it, and on Linux Ember's desk view takes the other corner.");
    expect(flat(read("docs/DEVELOPING.md"))).toContain("bottom-left corner (bottom-right when Ember's handle is in the bottom left)");
  });

  it("uses British spelling and plain words, as the app's own copy does", () => {
    // ui-copy.test.ts's list of American spellings, on the README and the notes outside code, links and the RPM's
    // License tag, and the internal names the copy rules keep out of what users read.
    const prose = (text: string) => text.replace(/```[^]*?```/g, "").replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]");
    const american = /\b(organiz\w*|recogniz\w*|behavior\w*|color\w*|favorite\w*|center\w*|canceled|cancelation|analyz\w*|minimiz\w*|customiz\w*|authoriz\w*|licens(e|es)\b(?! file| tag)|gray)\b/gi;
    const internal = /\b(workers?|job host|brain|sidecars?|tiers?|voice process)\b/gi;
    for (const file of ["README.md", "CHANGELOG.md"]) {
      const text = flat(prose(read(file)));
      expect([...text.matchAll(american)].map(m => m[0]), file).toEqual([]);
      expect([...text.matchAll(internal)].map(m => m[0]), file).toEqual([]);
    }
    // Voice's restart (voice.ts's RESTART_MS), in those words.
    expect(read("app/main/voice.ts")).toMatch(/const RESTART_MS = \[1000, 5000, 30_000\];/);
    expect(flat(changelog)).toContain("Voice starts again by itself when it stops answering or its speech recognition keeps failing (after 1, 5, then 30 seconds).");
  });

  it("names the same best-effort computers as the README", () => {
    const readme = flat(read("README.md"));
    const where = /- \*\*Where it runs\*\*: ([^]*?)(?= - \*\*)/.exec(flat(changelog))?.[1] ?? "";
    expect(where).not.toBe("");
    // Each "(…: best effort…)" of the README's platform list is in the release notes' line, as the same words.
    const efforts = [...readme.matchAll(/\(([^():]+): best effort/g)].map(m => m[1]);
    expect(efforts).toEqual(["Windows on Arm", "Intel Macs and macOS 13"]);
    for (const e of efforts) expect(where).toContain(`(${e}: best effort)`);
  });

  it("says spoken words count for a dangerous command only where Ember can tell the user's voice from the speakers", () => {
    // The owner's decision V1: where speaker rejection doesn't run (Windows, macOS, Linux without parec), a dangerous
    // command asked for by voice asks with the card; typed words still count.
    const notes = flat(changelog);
    expect(notes).not.toMatch(/typed or spoken words count/);
    const rule = /Only your own words count[^]*?asks with the card/.exec(notes)?.[0] ?? "";
    expect(rule).toMatch(/Typed words count everywhere/);
    // In the words the commands guide uses for it (§2.5).
    expect(rule).toMatch(/spoken[^.]*only where Ember can tell your voice from what your speakers play \(Linux with speaker rejection on and parec installed\)/);
    expect(notes).toMatch(/On Windows, on macOS and on Linux without it, a dangerous command you asked for by voice asks/);
  });
});
