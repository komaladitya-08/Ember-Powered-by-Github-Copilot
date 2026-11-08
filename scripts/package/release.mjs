// What a GitHub release of Ember holds, and its notes (docs/DEVELOPING.md §15). CI's release job runs it on a v* tag,
// in the folder holding the four package artifacts, before it writes SHA256SUMS and publishes:
//   node scripts/package/release.mjs <folder> <tag> <owner/repo> <notes.md>
//   node scripts/package/release.mjs --readme <tag>    (only the README's check, which the tag's checks job runs first)
// It refuses a tag that isn't v<package.json's version>, a folder missing one of the release's files or holding one
// more, a version CHANGELOG.md has no "## <version> (" section for, and a README whose Download section still says the
// version isn't out: the notes link the README at the tag, so it is what everyone reads (install-docs-c1-1). The notes
// are that section, its relative links made absolute at the tag (a release page resolves them elsewhere) and its
// wrapped lines joined.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GPL_SOURCES } from "./gpl-source.mjs";
import { artifactNames, layoutFor } from "./layout.mjs";

/**
 * Every file a release attaches besides SHA256SUMS: the README's downloads, in §7's spelling, and the GPL source.
 * @param {string} version
 */
export function releaseFiles(version) {
  return [
    `ember-${version}-1.el8.x86_64.rpm`,
    `Ember-${version}-x86_64.AppImage`,
    `Ember-voice-models-${version}.zip`,
    ...[layoutFor("win32", "x64"), layoutFor("darwin", "arm64"), layoutFor("darwin", "x64")].flatMap(l => artifactNames(l, version)),
    ...GPL_SOURCES.map(s => s.file),
  ];
}

/**
 * The release notes for `version`: CHANGELOG.md's "## <version> (date)" section without its heading, up to the next
 * "## " heading. Relative Markdown links point at `https://github.com/<repo>/blob/<ref>/…`. Throws when there is none.
 * @param {string} changelog
 * @param {string} version
 * @param {{ repo: string; ref: string }} o
 */
export function releaseNotes(changelog, version, o) {
  const lines = changelog.split("\n");
  const start = lines.findIndex(l => l.startsWith(`## ${version} (`));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version} (" section`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = unwrap(lines.slice(start + 1, end)).join("\n").trim();
  if (!body) throw new Error(`CHANGELOG.md's ${version} section is empty`);
  const base = `https://github.com/${o.repo}/blob/${o.ref}/`;
  // [text](target): a target with no scheme, not an anchor and not site-absolute is a file in the repository.
  return `${body.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, (_m, target) => `](${base}${target})`)}\n`;
}

/**
 * Lines wrapped at the changelog's width joined again: a release page shows every line break as one. A line that
 * continues a paragraph or a list item (not blank, a heading, a list item, a table row, a quote or a code fence, and
 * after a line that can be continued) is put after the previous one with a space; code blocks stay as they are.
 * @param {string[]} lines
 */
export function unwrap(lines) {
  const out = [];
  let fence = false;
  const starts = (/** @type {string} */ l) => /^\s*$|^#|^\s*([-*+]|\d+\.)\s|^\s*\||^\s*>|^\s*```/.test(l);
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; out.push(line); continue; }
    const prev = out[out.length - 1];
    if (!fence && prev !== undefined && !starts(line) && !/^\s*$|^#|^\s*\||^\s*```/.test(prev)) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

/**
 * What's wrong with a release folder's files (empty when nothing): missing ones and ones that don't belong.
 * @param {string[]} present
 * @param {string} version
 */
export function releaseProblems(present, version) {
  const want = releaseFiles(version);
  return [
    ...want.filter(f => !present.includes(f)).map(f => `missing ${f}`),
    ...present.filter(f => !want.includes(f)).map(f => `not part of the release: ${f}`),
  ];
}

/**
 * What's wrong with README.md for a release of `version` (empty when nothing): its **Download** section (up to the
 * next "## " heading, From npm included) still says this version isn't published, sends readers to another
 * version's release or README, or says the npm launcher isn't on npm yet. §15 step 1 has that text replaced in the
 * commit that is tagged, because the release's notes, and See what's new… with them, link the README at the tag.
 * @param {string} readme
 * @param {string} version
 */
export function readmeProblems(readme, version) {
  const lines = readme.split("\n");
  const start = lines.findIndex(l => /^## Download\s*$/.test(l));
  if (start < 0) return ["README.md has no Download section"];
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const download = lines.slice(start + 1, end).join(" ").replace(/\s+/g, " ");
  const problems = [];
  if (/isn't published yet/.test(download)) problems.push(`README.md's Download section still says ${version} isn't published yet`);
  const others = new Set([...download.matchAll(/\/(?:releases\/tag|blob)\/v(\d+\.\d+\.\d+)\b/g)].map(m => m[1]).filter(v => v !== version));
  for (const v of others) problems.push(`README.md's Download section sends readers to v${v} instead of ${version}`);
  if (/isn't on npm until/.test(download)) problems.push(`README.md's From npm still says ember-copilot isn't on npm until ${version} is published`);
  return problems;
}

/** The README's check alone, or the whole release's. */
function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const readme = () => {
    const wrong = readmeProblems(fs.readFileSync(path.join(root, "README.md"), "utf8"), version);
    if (wrong.length) throw new Error(`README.md isn't ready for ${version}'s release (docs/DEVELOPING.md §15 step 1):\n  ${wrong.join("\n  ")}`);
  };
  if (process.argv[2] === "--readme") {
    const tag = process.argv[3];
    if (!tag) throw new Error("usage: node scripts/package/release.mjs --readme <tag>");
    if (tag !== `v${version}`) throw new Error(`the tag ${tag} isn't v${version}, package.json's version`);
    readme();
    console.log(`release ${tag}: README.md describes ${version}`);
    return;
  }
  const [dir, tag, repo, notesFile] = process.argv.slice(2);
  if (!dir || !tag || !repo || !notesFile) throw new Error("usage: node scripts/package/release.mjs <folder> <tag> <owner/repo> <notes.md>");
  if (tag !== `v${version}`) throw new Error(`the tag ${tag} isn't v${version}, package.json's version`);
  readme();
  const problems = releaseProblems(fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile()), version);
  if (problems.length) throw new Error(`the release folder isn't what the README downloads:\n  ${problems.join("\n  ")}`);
  fs.writeFileSync(notesFile, releaseNotes(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version, { repo, ref: tag }));
  console.log(`release ${tag}: ${releaseFiles(version).length} files, notes in ${notesFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`release.mjs: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
