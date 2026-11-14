/**
 * Publishing a release (docs/DEVELOPING.md §15, scripts/package/release.mjs and ci.yml's release job): the files the
 * README downloads and nothing else, the version's notes from CHANGELOG.md with links that work on a release page,
 * and a job that runs only on v* tags, after every other job, with the only write permission in the workflow.
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

  it("knows this version's notes are under GitHub's limit in characters but over it in bytes, until CHANGELOG.md's section is trimmed (install-docs-r10-2, r10-install-x10-1)", () => {
    // GitHub refuses a release body of 125,000 or more, so the release job refuses these notes, and so does the tag's
    // first check. This pins today's state honestly: it turns red when the trim lands (then it must say `[]`) and when
    // the notes pass the limit in characters too. The notes are measured as the job writes them: links made absolute
    // for the repository Ember's releases come from.
    const repo = /const REPO = "([^"]+)"/.exec(read("app/main/updates.ts"))?.[1] ?? "";
    expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    const notes = releaseNotes(read("CHANGELOG.md"), version, { repo, ref: `v${version}` });
    expect(notes.length).toBeLessThan(RELEASE_BODY_LIMIT);
    expect(notesProblems(notes)).toEqual([expect.stringMatching(/^the notes are [\d,]+ bytes; GitHub takes a release body under 125,000$/)]);
  });
});

describe("ci.yml's release job", () => {
  const ci = read(".github/workflows/ci.yml");
  const job = ci.slice(ci.indexOf("\n  release:\n"));

  it("runs only on v* tags, after every other job, and is the only job that can write", () => {
    expect(job).toMatch(/\n {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\)\n/);
    const others = [...ci.matchAll(/^ {2}([\w-]+):\n {4}name:/gm)].map(m => m[1]).filter(n => n !== "release");
    const needs = /\n {4}needs: \[([^\]]+)\]/.exec(job)?.[1].split(/,\s*/) ?? [];
    expect(needs.sort()).toEqual(others.sort());
    expect(ci.match(/contents: write/g)).toHaveLength(1);
    expect(job).toMatch(/permissions:\n {6}contents: write/);
    expect(ci).toMatch(/^permissions:\n {2}contents: read/m);
  });

  it("gets the four package artifacts, which each platform uploads on tags", () => {
    for (const name of ["ember-packages", "ember-windows", "ember-macos", "ember-macos-x64"]) {
      expect(job, name).toContain(`name: ${name}\n          path: dist/release`);
      const upload = ci.slice(0, ci.indexOf("\n  release:\n")).split("- uses: actions/upload-artifact").find(s => s.includes(`name: ${name}\n`)) ?? "";
      expect(upload, name).toMatch(/if: \(github\.event_name == 'workflow_dispatch' && inputs\.packages\) \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    }
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
