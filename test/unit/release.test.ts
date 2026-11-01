/**
 * Publishing a release (docs/DEVELOPING.md §15, scripts/package/release.mjs and ci.yml's release job): the files the
 * README downloads and nothing else, the version's notes from CHANGELOG.md with links that work on a release page,
 * and a job that runs only on v* tags, after every other job, with the only write permission in the workflow.
 */

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseFiles, releaseNotes, releaseProblems, unwrap } from "../../scripts/package/release.mjs";

const read = (p: string) => fs.readFileSync(p, "utf8");
const version = JSON.parse(read("package.json")).version as string;

describe("release.mjs", () => {
  it("names the eight files the README downloads", () => {
    const files = releaseFiles(version);
    expect(files).toHaveLength(8);
    const readme = read("README.md");
    // The README spells these out; the Mac zips and the Intel Mac's files it names as "(or the .zip; mac-x64 …)".
    for (const f of [`ember-${version}-1.el8.x86_64.rpm`, `ember-voice-models-${version}-1.el8.noarch.rpm`, `Ember-${version}-win-x64.zip`, `Ember-${version}-mac-arm64.dmg`]) {
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

  it("has notes for this version in CHANGELOG.md", () => {
    const notes = releaseNotes(read("CHANGELOG.md"), version, { repo: "o/r", ref: `v${version}` });
    expect(notes.length).toBeGreaterThan(1000);
    expect(notes).not.toMatch(/^## /m);
    expect(notes).not.toMatch(/\]\((?!https:|#)/);
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
