/**
 * Publishing a release (docs/DEVELOPING.md §15, scripts/package/release.mjs and ci.yml's release job): the files the
 * README downloads and nothing else, the version's notes from CHANGELOG.md with links that work on a release page,
 * and a job that runs only on v* tags, after every normal job, with the only write permission in the workflow.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_BODY_LIMIT, notesProblems, readmeProblems, releaseFiles, releaseNotes, releaseProblems, unwrap } from "../../scripts/package/release.mjs";

const read = (p: string) => fs.readFileSync(p, "utf8");
const version = JSON.parse(read("package.json")).version as string;
const flat = (s: string) => s.replace(/\s*\n\s*/g, " ");
const section15 = () => read("docs/DEVELOPING.md").split("## 15. Publishing a release")[1].split("\n## ")[0];
// Review ids as the audit writes them: install-docs-r11-1, modes-y9-y2-1, wslio-y-2, docs-3-x-1, "(critique wsl-17)",
// review #116, a round's own (y10-1), and an area's own number (vault-12, memory-r10, r10-memory-4). Bare word-number
// tokens are Ember's own words too (x86-64, build-01, phi-3, iso-8859-1), so a plain id counts only under an area the
// audit uses (r11-notes-x11-3).
const AUDIT_AREAS = "memory|commands|integrations?|integ|safety|voice|vault|home|install|first-run|tasks|companion|reliability|modes|cifix|rp|accessibility|remote|wslio|wsl|product|security|evalfix|stop|docs|slice\\d+";
const REVIEW_IDS = new RegExp([
  String.raw`review #\d+`, String.raw`\bcritique [a-z][a-z0-9-]*\d\b`,
  String.raw`\b[a-z][a-z0-9]*(?:-[a-z]+)*(?:-[a-z]\d+)+-\d+\b`, String.raw`\b[a-z]+-\d+-[a-z]-\d+\b`,
  String.raw`\b[a-z]+(?:-[a-z]+)*-[a-z]-\d+\b`, String.raw`\b[xyz]-\d+\b(?=[),;])`, String.raw`\b[xyz](?:[1-9]|1\d)-\d{1,2}\b`,
  String.raw`\b(?:r\d+-)?(?:${AUDIT_AREAS})(?:-[a-z]+)*-[a-z]?\d+(?:-\d+)?\b`,
].map(p => `${p}(?!\\.\\d)`).join("|"), "g");

describe("release.mjs", () => {
  it("names the eight files the README downloads and the three of the GPL source", () => {
    const files = releaseFiles(version);
    expect(files).toHaveLength(11);
    const readme = read("README.md");
    // The README spells these out; the Mac zips and the Intel Mac's files it names as "(or the .zip; mac-x64 …)".
    for (const f of [`ember-${version}-1.el8.x86_64.rpm`, `Ember-${version}-win-x64.zip`, `Ember-${version}-mac-arm64.dmg`, `Ember-voice-models-${version}.zip`]) {
      expect(files, f).toContain(f);
      expect(readme, f).toContain(f);
    }
    for (const arch of ["arm64", "x64"]) for (const ext of ["zip", "dmg"]) expect(files).toContain(`Ember-${version}-mac-${arch}.${ext}`);
    expect(files).toContain(`Ember-${version}-x86_64.AppImage`);
  });

  it("finds missing files and ones that don't belong", () => {
    const files = releaseFiles("1.2.3");
    expect(releaseProblems(files, "1.2.3")).toEqual([]);
    expect(releaseProblems([...files.slice(1), "ember-1.2.3-2.el8.x86_64.rpm"], "1.2.3")).toEqual([
      "missing ember-1.2.3-1.el8.x86_64.rpm", "not part of the release: ember-1.2.3-2.el8.x86_64.rpm",
    ]);
  });

  it("takes the version's section of the changelog, its relative links made absolute at the tag", () => {
    const log = "# Release notes\n\n## 1.2.3 (2026-11-01)\n\nSee [README.md](README.md), [§7](docs/DEVELOPING.md#7-x), [x](https://e.org) and [y](#a).\n\n## 1.2.2 (2026-10-01)\n\nOld.\n";
    expect(releaseNotes(log, "1.2.3", { repo: "o/r", ref: "v1.2.3" })).toBe(
      "See [README.md](https://github.com/o/r/blob/v1.2.3/README.md), [§7](https://github.com/o/r/blob/v1.2.3/docs/DEVELOPING.md#7-x), [x](https://e.org) and [y](#a).\n",
    );
    expect(() => releaseNotes(log, "9.9.9", { repo: "o/r", ref: "v9.9.9" })).toThrow(/no "## 9.9.9 \(" section/);
  });

  it("joins wrapped lines, which a release page would show as line breaks, and keeps code, tables and lists", () => {
    expect(unwrap([
      "A paragraph", "wrapped here.", "", "- An item", "  wrapped too.", "  - A nested item", "### Heading", "Text",
      "```bash", "a", "  b", "```", "| a | b |", "|---|---|", "> quote", "  more",
    ])).toEqual([
      "A paragraph wrapped here.", "", "- An item wrapped too.", "  - A nested item", "### Heading", "Text",
      "```bash", "a", "  b", "```", "| a | b |", "|---|---|", "> quote more",
    ]);
  });

  it("refuses a tagged README that still says this version isn't out, since the notes and See what's new… lead there (install-docs-c1-1)", () => {
    const repo = "https://github.com/o/r";
    const before = [
      "# Ember", "", "## Download", "",
      "This README describes 1.2.3, which isn't published yet. Until it is,",
      `[1.2.2 remains the downloadable beta](${repo}/releases/tag/v1.2.2):`,
      `install it with [1.2.2's own README](${repo}/blob/v1.2.2/README.md), not the steps below.`, "",
      "### From npm (beta)", "",
      "The npm launcher is new in 1.2.3: `ember-copilot` isn't on npm until 1.2.3 is published.", "",
      "## Install on RHEL 8", "",
      `Older notes: [1.0.0](${repo}/releases/tag/v1.0.0).`, "",
    ].join("\n");
    expect(readmeProblems(before, "1.2.3")).toEqual([
      "README.md's Download section still says 1.2.3 isn't published yet",
      "README.md's Download section sends readers to v1.2.2 instead of 1.2.3",
      "README.md's From npm still says ember-copilot isn't on npm until 1.2.3 is published",
    ]);
    // As §15 step 1 says the tagged commit has it: the README describes this version. Links outside Download stay.
    const after = before
      .replace(/This README describes 1\.2\.3[^]*?not the steps below\./, "This README describes Ember 1.2.3.")
      .replace(/The npm launcher is new in 1\.2\.3: [^\n]+/, "The npm launcher is new in 1.2.3.");
    expect(readmeProblems(after, "1.2.3")).toEqual([]);
    expect(readmeProblems("# Ember\n", "1.2.3")).toEqual(["README.md has no Download section"]);
    // The release job checks it before it writes the notes, and the tag's checks job at once, so a tag moved after
    // the fix is all it takes (§15).
    const script = read("scripts/package/release.mjs");
    const whole = script.slice(script.indexOf("const [dir, tag, repo, notesFile]"));
    expect(whole.indexOf("readme();")).toBeGreaterThan(0);
    expect(whole.indexOf("readme();")).toBeLessThan(whole.indexOf("notes(repo, tag)"));
    // The check on its own, as the tag's checks job runs it: it fails exactly when this README has problems (and,
    // once it has none, when the notes are too long: r10-install-x10-1).
    const run = spawnSync(process.execPath, ["scripts/package/release.mjs", "--readme", `v${version}`, "o/r"], { encoding: "utf8" });
    const wrong = readmeProblems(read("README.md"), version);
    const long = notesProblems(releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` }));
    expect(run.status, run.stderr).toBe(wrong.length || long.length ? 1 : 0);
    for (const w of wrong.length ? wrong : long) expect(run.stderr).toContain(w);
    expect(spawnSync(process.execPath, ["scripts/package/release.mjs", "--readme", "v9.9.9", "o/r"], { encoding: "utf8" }).stderr).toContain(`isn't v${version}`);
    const checks = read(".github/workflows/ci.yml").split("\n  checks:\n")[1].split(/\n {2}[\w-]+:\n {4}name:/)[0];
    expect(checks).toMatch(/if: startsWith\(github\.ref, 'refs\/tags\/v'\)\n {8}run: node scripts\/package\/release\.mjs --readme "\$GITHUB_REF_NAME"/);
    expect(flat(section15())).toContain("In the commit you tag, replace that line");
  });

  it("refuses notes over GitHub's 125,000 limit counted in characters or in UTF-8 bytes, since which one GitHub counts isn't documented (install-docs-r10-2)", () => {
    expect(RELEASE_BODY_LIMIT).toBe(125_000);
    expect(notesProblems("a".repeat(124_999))).toEqual([]);
    // 0.1.1's notes were 124,577 characters and 126,844 bytes: its curly quotes, ellipses and › take 3 bytes each.
    const quoted = "\u201c".repeat(1_000) + "a".repeat(123_000);
    expect(quoted.length).toBe(124_000);
    expect(notesProblems(quoted)).toEqual(["the notes are 126,000 bytes; GitHub takes a release body under 125,000"]);
    expect(notesProblems("a".repeat(125_000))).toEqual([
      "the notes are 125,000 characters; GitHub takes a release body under 125,000",
      "the notes are 125,000 bytes; GitHub takes a release body under 125,000",
    ]);
    // The release job refuses them before `gh release create`, which would fail only after every other job passed.
    const script = read("scripts/package/release.mjs");
    const check = script.slice(script.indexOf("const notes = ("));
    expect(check.indexOf("notesProblems(")).toBeGreaterThan(0);
    expect(check.indexOf("notesProblems(")).toBeLessThan(check.indexOf("return text;"));
    expect(script).toContain("fs.writeFileSync(notesFile, notes(repo, tag));");
  });

  it("has notes for this version in CHANGELOG.md", () => {
    const notes = releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` });
    expect(notes.length).toBeGreaterThan(1000);
    expect(notes).not.toMatch(/^## /m);
    expect(notes).not.toMatch(/\]\((?!https:|#)/);
  });

  it("refuses notes GitHub would refuse in the tag's first check, not only in the release job at the run's end (r10-install-x10-1)", () => {
    // The checks job's early step runs `--readme`; the release job needs every other job, so a refusal there comes
    // only after the whole tag's run. A tree whose README is ready, with notes over the limit in bytes alone.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-release-"));
    try {
      fs.mkdirSync(path.join(dir, "scripts/package"), { recursive: true });
      for (const f of ["release.mjs", "layout.mjs", "gpl-source.mjs"]) fs.copyFileSync(`scripts/package/${f}`, path.join(dir, "scripts/package", f));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
      fs.writeFileSync(path.join(dir, "README.md"), `# Ember\n\n## Download\n\nThis README describes Ember ${version}.\n`);
      const log = (body: string) => fs.writeFileSync(path.join(dir, "CHANGELOG.md"), `# Release notes\n\n## ${version} (2026-11-14)\n\n${body}\n`);
      const run = () => spawnSync(process.execPath, [path.join(dir, "scripts/package/release.mjs"), "--readme", `v${version}`, "o/r"], { encoding: "utf8" });
      log("\u201c".repeat(1_000) + "a".repeat(123_000));
      const long = run();
      expect(long.status, long.stdout).toBe(1);
      expect(long.stderr).toContain(`CHANGELOG.md's ${version} section is too long for a release`);
      expect(long.stderr).toContain("bytes; GitHub takes a release body under 125,000");
      // Reached through a link to its folder (as on macOS, whose temporary folder is one), it still checks.
      const link = `${dir}-link`;
      fs.symlinkSync(dir, link, "junction");
      try {
        const linked = spawnSync(process.execPath, [path.join(link, "scripts/package/release.mjs"), "--readme", `v${version}`, "o/r"], { encoding: "utf8" });
        expect(linked.status, linked.stdout).toBe(1);
      } finally {
        fs.rmSync(link, { force: true });
      }
      log("Short notes.");
      const short = run();
      expect(short.status, short.stderr).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // The tag's checks job gives it the repository, whose name is part of every absolute link in the notes.
    const checks = read(".github/workflows/ci.yml").split("\n  checks:\n")[1].split(/\n {2}[\w-]+:\n {4}name:/)[0];
    expect(checks).toContain('run: node scripts/package/release.mjs --readme "$GITHUB_REF_NAME" "$GITHUB_REPOSITORY"');
  });

  it("keeps this version's notes, as releaseNotes builds them, under GitHub's 125,000 limit for a release body, in characters and in bytes (install-docs-r10-2, r10-install-x10-1)", () => {
    // GitHub refuses a release body of 125,000 or more, so the release job and the tag's first check would refuse
    // them. The notes are measured as the job writes them: links made absolute for the repository Ember's releases
    // come from.
    const repo = /const REPO = "([^"]+)"/.exec(read("app/main/updates.ts"))?.[1] ?? "";
    expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    const notes = releaseNotes(read("CHANGELOG.md"), version, { repo, ref: `v${version}` });
    expect(notes.length).toBeLessThan(RELEASE_BODY_LIMIT);
    expect(notesProblems(notes)).toEqual([]);
  });

  it("keeps this version's notes to what users and administrators need, with room for the next change (install-docs-r11-1)", () => {
    // 0.1.1's notes had 456 bytes left under the limit, 71 % of them audit notes: one more bullet failed the gate,
    // and See what's new… opened a 122,000-character page. The audit's record (review ids, who found what, how it was
    // fixed) is PLAN.md §10's; the notes say what changed, grouped by feature. Rewritten they are under 70,000
    // bytes; this keeps a fifth of the limit free, so a later bullet has room and audit notes can't creep back.
    const repo = /const REPO = "([^"]+)"/.exec(read("app/main/updates.ts"))?.[1] ?? "";
    const notes = releaseNotes(read("CHANGELOG.md"), version, { repo, ref: `v${version}` });
    const bytes = Buffer.byteLength(notes, "utf8");
    expect(bytes, `${(RELEASE_BODY_LIMIT - bytes).toLocaleString("en-GB")} bytes left under GitHub's limit`).toBeLessThanOrEqual(RELEASE_BODY_LIMIT - 25_000);
    const headings = notes.split("\n").filter(l => /^#{2,4} /.test(l));
    expect(headings.filter(h => /audit|review fixes|follow-up| on \d{1,2} (October|November)\b/i.test(h))).toEqual([]);
    expect(notes.match(REVIEW_IDS) ?? []).toEqual([]);
  });

  it("tells someone updating from 0.1.0 only of cards it showed them before as asked again (r11-notes-x11-1)", () => {
    // 0.1.0 had the first-run agreement and the commands, WSL and SSH cards (FEATURE_CONSENT_VERSION { wsl: 1, ssh: 1,
    // commands: 1 } at v0.1.0); memory, your own provider, extensions and the approval modes came after it, so their
    // cards are met for the first time, never "again".
    const notes = flat(releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` }));
    const again = notes.split(/(?<=\.) (?=[A-Z*])|(?=- \*\*)/).filter(s => /\bagain\b/.test(s) && /\b(asks?|asked|agree)\b/.test(s));
    for (const s of again) expect(s).not.toMatch(/Interactive's card|Memory's note|provider's card|extension's card|Assisted's|Autopilot's/);
    expect(notes).toContain("If you already use Ember, your settings stay and only Interactive is offered.");
  });

  it("says the commands card is agreed again on every computer, and that without a keyring extensions ask at every start (integ-x-6)", () => {
    // FEATURE_CONSENT_VERSION.commands 2 → 3 withdraws every target's agreement (targets/consent.ts consentCurrent), and
    // extensions/seal.ts seals nothing where safeStorage's backend is basic_text.
    const notes = flat(releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` }));
    expect(notes).toContain("everyone who uses commands agrees to it again, on every computer");
    expect(notes).toContain("On a computer without a keyring Ember can use, nothing is sealed, so an agreement lasts only until Ember quits and each extension asks again at every start.");
  });

  it("says Ember ends what it finds a WSL run left running, not that it always can (r11-notes-x11-2)", () => {
    // app/main/wsl/runner.ts sweeps only when it could read the running distros; one it can't tell about is never swept.
    const notes = flat(releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` }));
    expect(notes).not.toContain("Ember ends whatever the run left running");
    expect(notes).toContain("Ember ends whatever it finds the run left running");
  });

  it("still warns that a one-word yes said as a question can be taken as a yes (r11-notes-y11-1)", () => {
    // docs/DEVELOPING.md (V2-S5): the recognizer writes "?" from the words, not the voice, so a lone "Okay?" said
    // with a rising voice mostly comes out as "Okay." and allows; the notes must not imply that no question-yes counts.
    const notes = flat(releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` }));
    const limits = notes.slice(notes.lastIndexOf("Known issues and limits"));
    expect(limits).toContain("a one-word yes said as a question (“Okay?”) can still be taken as a yes");
  });

  it("lists routines among what is new since 0.1.0 with its own note (r11-notes-y11-2)", () => {
    // ROUTINES_CONSENT_TEXT, FEATURE_CONSENT_VERSION.routines: routines default off with consent version 0.
    const notes = flat(releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` }));
    expect(notes).toMatch(/What is new since 0\.1\.0 \([^)]*routines and lasting reminders[^)]*\) shows its own card or note/);
  });

  it("knows the audit's ids from Ember's own product words (r11-notes-x11-3)", () => {
    for (const id of ["install-docs-r11-1", "wslio-y-2", "docs-3-x-1", "(critique wsl-17)", "review #116", "memory-x9-3", "modes-y9-y2-1", "vault-12;", "slice3-2", "r10-memory-4", "commands-remote-c10-2)", "(y10-1)", "x10-4"]) {
      expect(id.match(REVIEW_IDS), id).not.toBeNull();
    }
    const words = "GNOME on Xorg (x86-64, glibc 2.28), hosts build-01, db-01; utf-8, iso-8859-1, phi-3, gemma-2, claude-3-5, llama-3-1, mistral-7b, all-MiniLM-L6-v2, Win+Alt+Y, ember-0.1.1-1.el8.x86_64.rpm, Ember-0.1.1-mac-arm64.dmg, CVE-2024-3094, SHA-256, H-1, Ember-0.1.1-win-x64.zip, mac-x64, Ember-voice-models-0.1.1.zip.";
    expect(words.match(REVIEW_IDS) ?? []).toEqual([]);
  });
});

describe("ci.yml's release job", () => {
  const ci = read(".github/workflows/ci.yml");
  const job = ci.slice(ci.indexOf("\n  release:\n"));

  it("runs only on v* tags, after every normal job, and is the only job that can write", () => {
    expect(job).toMatch(/\n {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\)\n/);
    // This one explicit manual experiment cannot run on a tag push, so making it a prerequisite would skip release.
    // Exempt no other job; even this exact name is allowed only with its complete fixed read-only caller block.
    const diagnostic = ci.match(/\n {2}windows-uia-focus-order:\n(?: {4}[^\n]*\n|\n)*/)?.[0];
    if (diagnostic !== undefined) expect(diagnostic).toBe([
      "", "  windows-uia-focus-order:", "    name: Windows UIA focus diagnostic",
      "    if: github.event_name == 'workflow_dispatch' && inputs.only == 'focus'",
      "    permissions:", "      contents: read", "    uses: ./.github/workflows/windows-uia-focus-order.yml", "", "",
    ].join("\n"));
    expect(ci.match(/^ {2}windows-uia-focus-order:/gm) ?? []).toHaveLength(diagnostic === undefined ? 0 : 1);
    const others = [...ci.matchAll(/^ {2}([\w-]+):\n {4}name:/gm)].map(m => m[1]).filter(n => n !== "release" && n !== "windows-uia-focus-order");
    const needs = /\n {4}needs: \[([^\]]+)\]/.exec(job)?.[1].split(/,\s*/) ?? [];
    expect(needs).not.toContain("windows-uia-focus-order");
    expect(needs.sort()).toEqual(others.sort());
    expect(ci.match(/contents: write/g)).toHaveLength(1);
    expect(job).toMatch(/permissions:\n {6}contents: write/);
    expect(ci).toMatch(/^permissions:\n {2}contents: read/m);
  });

  it("gets the tested Windows product ZIP and the other three platform artifacts", () => {
    for (const name of ["ember-packages", "ember-macos", "ember-macos-x64"]) {
      expect(job, name).toContain(`name: ${name}\n          path: dist/release`);
      const upload = ci.slice(0, ci.indexOf("\n  release:\n")).split("- uses: actions/upload-artifact").find(s => s.includes(`name: ${name}\n`)) ?? "";
      expect(upload, name).toMatch(/if: \(github\.event_name == 'workflow_dispatch' && inputs\.packages\) \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    }
    expect(job).toContain("name: ember-windows-node-product-windows-2022\n          path: dist/release");
    expect(job).not.toContain("name: ember-windows\n");
    expect(job).toMatch(/needs: \[[^\]\n]*\bwindows-node-product\b/);
    expect(ci).toContain("uses: ./.github/workflows/windows-node-product.yml");
    const product = read(".github/workflows/windows-node-product.yml");
    const upload = product.split("- name: Retain only the exact ZIP which passed the packaged product journey")[1].split("\n  required:\n")[0];
    expect(upload).toContain("if: matrix.journey == 'packaged'");
    expect(upload).toContain("name: ember-windows-node-product-${{ matrix.image }}");
    expect(upload).toContain("path: ${{ steps.proof.outputs.zip }}");
    expect(upload).toContain("if-no-files-found: error");
    const required = product.split("\n  required:\n")[1];
    expect(required).toContain("if: always()");
    expect(required).toContain("needs: [product]");
    expect(required).toContain('results.product?.result !== "success"');
  });

  it("checks the files and writes SHA256SUMS with §15's command before publishing them", () => {
    const publish = read("docs/DEVELOPING.md").split("## 15. Publishing a release")[1].split("\n## ")[0];
    const cmd = /^ *(sha256sum [^\n>]+? > SHA256SUMS)$/m.exec(publish)?.[1];
    expect(cmd).toBeTruthy();
    expect(job).toContain(cmd!);
    const order = ["scripts/package/release.mjs", cmd!, "sha256sum -c SHA256SUMS", "gh release create"].map(s => job.indexOf(s));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(job).toContain("--verify-tag");
  });
});
