/**
 * The user and administrator docs (README.md, CHANGELOG.md, docs/*.md) against the code they describe: each case reads
 * the fact from the code or the packaging data and checks the docs say it, so a change on one side shows up here.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTERS } from "../../app/main/settings";
import { layoutFor, REMOTE_PARTS_DIR } from "../../scripts/package/layout.mjs";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
/** Text with its line breaks and runs of spaces made single spaces, so a phrase can span wrapped lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");
/** One section of a Markdown file: from its heading to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex(l => l.startsWith("#") && l.replace(/^#+\s*/, "") === heading);
  if (at < 0) throw new Error(`no section "${heading}"`);
  const level = /^#+/.exec(lines[at])![0].length;
  const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= level);
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
});
