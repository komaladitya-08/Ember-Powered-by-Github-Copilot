/**
 * The user and administrator docs (README.md, CHANGELOG.md, docs/*.md) against the code they describe: each case reads
 * the fact from the code or the packaging data and checks the docs say it, so a change on one side shows up here.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTERS } from "../../app/main/settings";
import { macVersionFromDarwin } from "../../app/main/platform/darwin/system/permissions";
import { artifactNames, layoutFor, REMOTE_PARTS_DIR } from "../../scripts/package/layout.mjs";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
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
    // offerWsl's one caller is the bind path for a request that said "WSL" while it is off.
    expect(runtime.match(/\bofferWsl\(\)/g)?.length).toBe(2);
    expect(runtime).toMatch(/targetsNamed\(words, \[\{ id: "wsl:WSL", names: \["WSL"\] \}\][^\n]*\n(?:[^\n]*\n){0,4}[^\n]*offerWsl\(\)/);
    const s31 = flat(section(doc, "3.1 Turning it on"));
    expect(s31).not.toMatch(/first sees WSL/);
    expect(s31).toMatch(/When you ask for something in WSL while WSL is off for Ember/);
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
    expect(ssh).toContain("**Remove Ember from build-01**");
    expect(ssh).toContain("sh ~/.local/share/ember-remote/versions/*/uninstall.sh");
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
});
