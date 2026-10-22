// Builds the remote agent's parts (design §5.2.2): for each target a deterministic
// ember-remote-parts-<partsId>-<target>.tar.gz in dist/remote-parts/, and remote-parts.json ({ partsId, targets:
// { <target>: { file, sha256, bytes } } }) whose hashes the PC checks before it sends one. A part holds the agent's
// bundle (dist/remote/ember-remote.cjs, from `npm run build`), koffi beside it on Linux (node_modules/koffi and
// node_modules/@koromix/koffi-linux-<arch>, each fetched with `npm pack` and checked against package-lock.json's
// integrity before use; never a musl build), the AT-SPI sidecar and the notice (Linux), uninstall.sh, README.txt,
// LICENSE, THIRD_PARTY_NOTICES and manifest.sha256 (every other file's SHA-256, `sha256sum -c` format).
// partsId = Ember's version + "-" + the first 12 hex digits of the SHA-256 of every target's manifest, concatenated in
// target order. Every Linux koffi.node is checked against glibc 2.28 (GLIBC_2.28, GLIBCXX_3.4.25, CXXABI_1.3.11) by
// reading its ELF version needs here, aarch64 too, so the check runs on every OS that stages. The same inputs give the
// same bytes on every run (tar-writer.mjs).
// usage: node scripts/package/remote-parts.mjs [--out <dir>] [--cache <dir>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { gzip, readTar, tarArchive } from "./tar-writer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The targets an agent runs on in v1 (Windows remotes are SX's). */
export const PARTS_TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];

/** The newest symbol versions a Linux binary in the parts may need (RHEL 8's glibc 2.28 and libstdc++). */
export const GLIBC_FLOOR = { GLIBC: "2.28", GLIBCXX: "3.4.25", CXXABI: "1.3.11" };

/** The koffi runtime files the agent loads (koffi's sources, docs and build tools stay behind). */
const KOFFI_FILES = ["package.json", "index.cjs", "LICENSE.txt", "src/koffi/index.cjs", "src/koffi/src/static.cjs"];

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Compares dotted version numbers ("2.28" < "2.30"). */
function newer(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The symbol versions a 64-bit little-endian ELF file needs (its SHT_GNU_verneed entries), e.g. ["GLIBC_2.17",
 * "GLIBCXX_3.4.22"]. Throws when it isn't such a file or its tables run past its end.
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function elfVersionNeeds(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46) throw new Error("not an ELF file");
  if (b[4] !== 2 || b[5] !== 1) throw new Error("not a 64-bit little-endian ELF file");
  const shoff = Number(b.readBigUInt64LE(0x28)), shentsize = b.readUInt16LE(0x3a), shnum = b.readUInt16LE(0x3c);
  if (shentsize < 64 || shoff + shnum * shentsize > b.length) throw new Error("the ELF section table runs past the file");
  const section = i => {
    const at = shoff + i * shentsize;
    return { type: b.readUInt32LE(at + 4), offset: Number(b.readBigUInt64LE(at + 24)), size: Number(b.readBigUInt64LE(at + 32)), link: b.readUInt32LE(at + 40), info: b.readUInt32LE(at + 44) };
  };
  const out = new Set();
  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    if (s.type !== 0x6ffffffe) continue; // SHT_GNU_verneed
    const strtab = section(s.link);
    const str = off => {
      const start = strtab.offset + off;
      const end = b.indexOf(0, start);
      if (start >= b.length || end < 0 || end > strtab.offset + strtab.size) throw new Error("an ELF string runs past its table");
      return b.toString("latin1", start, end);
    };
    let at = s.offset;
    for (let n = 0; n < s.info; n++) {
      if (at + 16 > b.length) throw new Error("an ELF version table runs past the file");
      const cnt = b.readUInt16LE(at + 2), aux = b.readUInt32LE(at + 8), next = b.readUInt32LE(at + 12);
      let a = at + aux;
      for (let k = 0; k < cnt; k++) {
        if (a + 16 > b.length) throw new Error("an ELF version entry runs past the file");
        out.add(str(b.readUInt32LE(a + 8)));
        const an = b.readUInt32LE(a + 12);
        if (!an) break;
        a += an;
      }
      if (!next) break;
      at += next;
    }
  }
  return [...out].sort();
}

/**
 * The needs of `bytes` newer than GLIBC_FLOOR ([] when it runs on RHEL 8).
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function tooNew(bytes) {
  return elfVersionNeeds(bytes).filter(v => {
    const m = /^(GLIBCXX|CXXABI|GLIBC)_([0-9.]+)$/.exec(v);
    return m ? newer(m[2], GLIBC_FLOOR[m[1]]) : false;
  });
}

/**
 * Is `bytes` exactly what a lockfile `integrity` ("sha512-<base64>", possibly several, space-separated) names?
 * @param {Uint8Array} bytes
 * @param {string} integrity
 */
export function matchesIntegrity(bytes, integrity) {
  return integrity.split(/\s+/).filter(Boolean).some(entry => {
    const m = /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/.exec(entry);
    return !!m && createHash(m[1]).update(bytes).digest("base64") === m[2];
  });
}

/**
 * manifest.sha256's text for `files` (`sha256sum -c` format, sorted by path).
 * @param {{ path: string; data: Uint8Array }[]} files
 */
export function manifestText(files) {
  return [...files]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map(f => `${sha256(f.data)}  ${f.path}\n`)
    .join("");
}

/**
 * The parts id: Ember's version, "-", and the first 12 hex digits of the SHA-256 of every target's manifest in order.
 * @param {string} version
 * @param {string[]} manifests
 */
export function partsIdOf(version, manifests) {
  if (!/^[0-9A-Za-z.+-]{1,60}$/.test(version)) throw new Error(`not a version: ${version}`);
  return `${version}-${sha256(manifests.join("")).slice(0, 12)}`;
}

/** The folders every file of `paths` sits in (each listed once). */
function foldersOf(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs];
}

/** A file's mode in a part: programs (the runtime's own aren't here) 0755, everything else 0644. */
const modeOf = p => (p.endsWith(".node") || p.endsWith(".sh") ? 0o755 : 0o644);

/**
 * Every target's part from its inputs (pure): the archives' bytes, the parts id and remote-parts.json's content.
 * `koffi[target]` holds the koffi files for a Linux target (paths under node_modules/), absent for macOS.
 * @param {{ version: string; bundle: Uint8Array; atspi: Uint8Array; notice: Uint8Array; uninstall: Uint8Array; readme: Uint8Array; license: Uint8Array; notices: (target: string) => Uint8Array; koffi: Record<string, { path: string; data: Uint8Array }[]> }} i
 */
export function buildParts(i) {
  const filesOf = target => {
    const linux = target.startsWith("linux-");
    const files = [
      { path: "ember-remote.cjs", data: i.bundle },
      { path: "uninstall.sh", data: i.uninstall },
      { path: "README.txt", data: i.readme },
      { path: "LICENSE", data: i.license },
      { path: "THIRD_PARTY_NOTICES", data: i.notices(target) },
    ];
    if (linux) {
      const k = i.koffi[target];
      if (!k?.length) throw new Error(`no koffi files for ${target}`);
      files.push({ path: "sidecar/atspi/ember_atspi.py", data: i.atspi }, { path: "sidecar/notice/ember_notice.py", data: i.notice }, ...k);
    }
    return files;
  };
  const perTarget = PARTS_TARGETS.map(target => {
    const files = filesOf(target);
    return { target, files, manifest: manifestText(files) };
  });
  const partsId = partsIdOf(i.version, perTarget.map(t => t.manifest));
  const archives = perTarget.map(({ target, files, manifest }) => {
    const all = [...files, { path: "manifest.sha256", data: Buffer.from(manifest, "utf8") }];
    const entries = [
      ...foldersOf(all.map(f => f.path)).map(d => ({ path: d, mode: 0o755, dir: true })),
      ...all.map(f => ({ path: f.path, mode: modeOf(f.path), data: f.data })),
    ];
    const bytes = gzip(tarArchive(entries));
    return { target, file: `ember-remote-parts-${partsId}-${target}.tar.gz`, bytes };
  });
  const json = {
    partsId,
    targets: Object.fromEntries(archives.map(a => [a.target, { file: a.file, sha256: sha256(a.bytes), bytes: a.bytes.length }])),
  };
  return { partsId, archives, json };
}

/** THIRD_PARTY_NOTICES for a target: zod (bundled in ember-remote.cjs) everywhere, koffi on Linux. */
function noticesFor(target, zodLicense, koffiLicense) {
  const section = (name, licence, text) => `${name} (${licence})\n${"-".repeat(name.length + licence.length + 3)}\n${text.trim()}\n`;
  const parts = [section("zod", "MIT", zodLicense)];
  if (target.startsWith("linux-")) parts.push(section("koffi and @koromix/koffi-*", "MIT", koffiLicense));
  return Buffer.from(`Third-party software in Ember's remote helper.\n\n${parts.join("\n")}`, "utf8");
}

/** A package's tarball, from the cache or `npm pack`, checked against the lockfile before it is used. */
function packageTarball(name, lock, cache) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version || !entry.integrity) throw new Error(`package-lock.json doesn't pin ${name}`);
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, `${name.replace(/^@/, "").replace("/", "-")}-${entry.version}.tgz`);
  if (!fs.existsSync(file) || !matchesIntegrity(fs.readFileSync(file), entry.integrity)) {
    const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", `${name}@${entry.version}`, "--json", "--pack-destination", cache], {
      cwd: cache, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"],
    });
    const packed = JSON.parse(out)[0]?.filename;
    if (!packed) throw new Error(`npm pack ${name}@${entry.version} gave no file`);
    if (path.join(cache, packed) !== file) fs.renameSync(path.join(cache, packed), file);
  }
  const bytes = fs.readFileSync(file);
  if (!matchesIntegrity(bytes, entry.integrity)) throw new Error(`${name}@${entry.version} doesn't match package-lock.json's integrity`);
  // npm's tarballs put everything under package/.
  return readTar(gunzipSync(bytes)).filter(e => !e.dir && e.path.startsWith("package/")).map(e => ({ path: e.path.slice("package/".length), data: e.data }));
}

/** The koffi files a Linux target's agent loads, under node_modules/. */
function koffiFiles(target, lock, cache) {
  const arch = target.slice("linux-".length);
  const core = packageTarball("koffi", lock, cache);
  const platformName = `@koromix/koffi-${target}`;
  const native = packageTarball(platformName, lock, cache);
  const pick = (files, want, prefix) => want.map(p => {
    const f = files.find(x => x.path === p);
    if (!f) throw new Error(`${prefix} has no ${p}`);
    return { path: `node_modules/${prefix}/${p}`, data: f.data };
  });
  const out = [...pick(core, KOFFI_FILES, "koffi"), ...pick(native, ["package.json", "index.js", `linux_${arch}/koffi.node`], platformName)];
  const node = out.find(f => f.path.endsWith(".node"));
  const bad = tooNew(node.data);
  if (bad.length) throw new Error(`${platformName}'s koffi.node needs ${bad.join(", ")}, newer than RHEL 8 has`);
  return out;
}

/** Builds every part into `out` (default dist/remote-parts), replacing what is there. */
export function main(argv = process.argv.slice(2)) {
  const arg = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = path.resolve(root, arg("--out") ?? "dist/remote-parts");
  const cache = path.resolve(root, arg("--cache") ?? ".cache/remote-parts");
  const bundleFile = path.join(root, "dist/remote/ember-remote.cjs");
  if (!fs.existsSync(bundleFile)) throw new Error("dist/remote/ember-remote.cjs is missing: run npm run build first");
  const read = p => fs.readFileSync(path.join(root, p));
  const pkg = JSON.parse(read("package.json").toString("utf8"));
  const lock = JSON.parse(read("package-lock.json").toString("utf8"));
  const zodLicense = read("node_modules/zod/LICENSE").toString("utf8");
  const koffi = {};
  for (const t of PARTS_TARGETS.filter(t => t.startsWith("linux-"))) koffi[t] = koffiFiles(t, lock, cache);
  const koffiLicense = Buffer.from(koffi["linux-x64"].find(f => f.path === "node_modules/koffi/LICENSE.txt").data).toString("utf8");
  const built = buildParts({
    version: pkg.version,
    bundle: fs.readFileSync(bundleFile),
    atspi: read("sidecar/atspi/ember_atspi.py"),
    notice: read("sidecar/notice/ember_notice.py"),
    uninstall: read("app/remote/parts/uninstall.sh"),
    readme: read("app/remote/parts/README.txt"),
    license: read("LICENSE"),
    notices: t => noticesFor(t, zodLicense, koffiLicense),
    koffi,
  });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const a of built.archives) fs.writeFileSync(path.join(out, a.file), a.bytes);
  fs.writeFileSync(path.join(out, "remote-parts.json"), `${JSON.stringify(built.json, null, 2)}\n`);
  console.log(`remote parts ${built.partsId}: ${built.archives.map(a => `${a.target} ${(a.bytes.length / 1024).toFixed(0)} KiB`).join(", ")}`);
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`remote-parts: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
