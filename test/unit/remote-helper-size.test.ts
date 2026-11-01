/**
 * What the SSH card and the docs say about the helper Ember copies to a computer (how much it downloads and sends, how
 * big it is unpacked, and where it goes) against what the bootstrap really sends and unpacks: remote-runtime.json's
 * pinned Node.js archives plus Ember's own parts (about 0.8 MB), unpacked without Node's headers and npm.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_SH } from "../../app/main/remote/bootstrap";
import { sshConsent } from "../../app/main/targets/consent";
import { consentText } from "../../app/renderer/prompt/copy";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

interface RuntimeFile { bytes: number }
const runtime = JSON.parse(read("scripts/package/remote-runtime.json")) as { targets: Record<string, { xz: RuntimeFile; gz: RuntimeFile }> };
/** Ember's own parts, compressed (ember-remote-parts-*.tar.gz is about 0.8 MB). */
const PARTS_MB = 1;
const mb = (bytes: number) => bytes / 1e6;
/** The most a remote downloads with xz (every Linux Ember supports has it) and without it (gz: most Macs). */
const withXz = Math.max(...Object.values(runtime.targets).map(t => mb(t.xz.bytes))) + PARTS_MB;
const withoutXz = Math.max(...Object.values(runtime.targets).map(t => mb(t.gz.bytes))) + PARTS_MB;
/**
 * Unpacked, measured from the pinned archives as the bootstrap unpacks them (2026-10-27, Node 24.21.0): linux-x64
 * 128 MB and darwin-arm64 123 MB without include/ and lib/node_modules (201 MB and 197 MB whole), plus 3 MB of parts.
 */
const UNPACKED_MB = 130;

/** The card's size sentence: "about 33 MB (up to about 60 MB …), unpacked to about 130 MB in …". */
const SIZES = /about (\d+) MB \(up to about (\d+) MB where that computer can't unpack the smaller download, as is usual on a Mac\), unpacked to about (\d+) MB in its own folder \(~\/\.local\/share\/ember-remote, or ~\/Library\/Application Support\/Ember Remote on a Mac\)/;

function cardSizes(text: string): [number, number, number] {
  const m = SIZES.exec(text);
  expect(m, text).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

describe("the helper's size", () => {
  const facts = { label: "build-01", resolved: { user: "deploy", hostname: "build-01.example.com", port: 22, jump: [] }, desktopOff: false, graceSeconds: 20 };
  const card = sshConsent({ os: "linux", target: "ssh:build-01", facts }).body.join(" ");
  const renderer = consentText({ feature: "ssh", os: "linux", target: "ssh:build-01", targetLabel: "build-01", ssh: { login: "deploy", hostname: "build-01.example.com", port: 22, jump: [], desktop: "screen" } }).body.join(" ");

  it("is what the card says, with and without xz on the other computer, and on a Linux computer or a Mac", () => {
    const [download, most, unpacked] = cardSizes(card);
    expect(Math.abs(download - withXz)).toBeLessThanOrEqual(1);
    expect(most).toBeGreaterThanOrEqual(withoutXz);
    expect(most - withoutXz).toBeLessThanOrEqual(2);
    expect(unpacked).toBe(UNPACKED_MB);
    // The prompt window's own copy of the card says the same.
    expect(cardSizes(renderer)).toEqual([download, most, unpacked]);
    // In words a person clicking Connect knows: no tool's name, and "there" once.
    for (const text of [card, renderer]) {
      const sentence = /It copies a helper there[^]*?\)\./.exec(text)?.[0] ?? "";
      expect(sentence).not.toMatch(/\bxz\b/);
      expect(sentence.match(/\bthere\b/g)).toHaveLength(1);
    }
  });

  it("leaves Node's headers and npm out when the bootstrap unpacks the runtime, from either archive", () => {
    const lines = BOOTSTRAP_SH.split("\n").filter(l => /tar -x[Jz]f "\$ember_stage\/runtime\.archive"/.test(l));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain(`--strip-components=1 --exclude='*/include' --exclude='*/lib/node_modules' || ember_fail unpack runtime`);
  });

  it("is what README.md, CHANGELOG.md and docs/COMMANDS-WSL-SSH.md say", () => {
    const [download, most, unpacked] = cardSizes(card);
    const docs = { readme: flat(read("README.md")), changelog: flat(read("CHANGELOG.md")), commands: flat(read("docs/COMMANDS-WSL-SSH.md")) };
    for (const [name, text] of Object.entries(docs)) {
      expect(text, name).toContain(`about ${download} MB`);
      expect(text, name).not.toMatch(/about 31 MB|125 MB/);
    }
    expect(docs.commands).toContain(`about ${download} MB in all (up to about ${most} MB on a Mac or other computer without xz), unpacked to about ${unpacked} MB`);
  });
});
