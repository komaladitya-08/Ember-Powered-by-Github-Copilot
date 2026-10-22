// What the RPM's License: tag must cover: the licence of every package Ember bundles (its package.json),
// and of the libraries a package declares it bundles inside it (sharp-libvips lists them in its README.md, and so
// do sharp's Windows builds, which carry libvips themselves). The tag is the one list of licences Ember ships under
// on every target: stage.mjs stops before staging anything if one of them is missing from packaging/rpm/ember.spec.

/** The SPDX ids in a licence expression: "(MIT OR Apache-2.0) AND Zlib" → ["MIT", "Apache-2.0", "Zlib"]. */
export const spdxIds = expr => String(expr ?? "").split(/[()\s]+/).filter(t => t && !/^(AND|OR|WITH)$/.test(t));

/** The SPDX ids in a spec file's (first, the main package's) License: tag. */
export const specLicenceIds = spec => spdxIds(/^License:\s*(.+)$/m.exec(spec)?.[1]);

/**
 * Libraries bundled inside a package, as the licensing table in its README.md names them ("| library | terms |"),
 * with the SPDX ids their terms come to. A library the table names that isn't listed here stops staging: an
 * update bundled something new, so check its licence, then add it here and to the spec.
 */
export const BUNDLED_LIBRARIES = [
  {
    // sharp-libvips-<platform> (Linux, macOS) and sharp-win32-<arch> (Windows: no separate libvips package).
    package: /^@img\/sharp-(libvips-|win32-)/,
    // From the "Licensing" table of @img/sharp-libvips-linux-x64's README.md (@img/sharp-win32-x64 0.35.5 has the
    // same table). The LGPLv3 entries are used under the "any later version" clause of LGPLv2/2.1 (so
    // LGPL-3.0-or-later); aom's AOMedia Patent License 1.0 is a patent grant beside its BSD-2-Clause copyright
    // licence; fontconfig's licence is HPND-sell-variant.
    libraries: {
      aom: ["BSD-2-Clause"], cairo: ["MPL-1.1"], cgif: ["MIT"], expat: ["MIT"], fontconfig: ["HPND-sell-variant"],
      freetype: ["FTL"], fribidi: ["LGPL-3.0-or-later"], glib: ["LGPL-3.0-or-later"], harfbuzz: ["MIT"],
      highway: ["BSD-3-Clause"], lcms: ["MIT"], libarchive: ["BSD-2-Clause"], libexif: ["LGPL-3.0-or-later"],
      libffi: ["MIT"], libheif: ["LGPL-3.0-or-later"], libimagequant: ["BSD-2-Clause"], libnsgif: ["MIT"],
      libpng: ["libpng-2.0"], librsvg: ["LGPL-3.0-or-later"], libtiff: ["libtiff"], libultrahdr: ["MIT"],
      libvips: ["LGPL-3.0-or-later"], libwebp: ["BSD-3-Clause"], libxml2: ["MIT"], mozjpeg: ["IJG", "BSD-3-Clause", "Zlib"],
      pango: ["LGPL-3.0-or-later"], pixman: ["MIT"], "proxy-libintl": ["LGPL-3.0-or-later"], "zlib-ng": ["Zlib"],
    },
  },
];

/** The rows of a README's two-column licensing table: [library, terms]. */
export function readmeLibraries(readme) {
  const rows = [];
  for (const line of String(readme ?? "").split("\n")) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!m || /^:?-+:?$/.test(m[1]) || /^library$/i.test(m[1])) continue;
    rows.push([m[1], m[2]]);
  }
  return rows;
}

/**
 * What the spec's License: tag doesn't cover, one line each. `packages`: every bundled package's name, its
 * package.json licence expression and its README.md text (null if it has none); `specIds`: the tag's SPDX ids.
 */
export function uncoveredLicences(packages, specIds) {
  const missing = [];
  for (const p of packages) {
    const ids = spdxIds(p.license);
    for (const id of ids.length ? ids : ["(none)"]) if (!specIds.includes(id)) missing.push(`${p.name} (${id})`);
    const bundled = BUNDLED_LIBRARIES.find(b => b.package.test(p.name));
    if (!bundled) continue;
    const libraries = readmeLibraries(p.readme);
    if (!libraries.length) { missing.push(`${p.name} (no licensing table in its README.md to check the libraries it bundles)`); continue; }
    for (const [library, terms] of libraries) {
      const known = bundled.libraries[library];
      if (!known) { missing.push(`${p.name}'s ${library} ("${terms}": not yet in scripts/package/licences.mjs)`); continue; }
      for (const id of known) if (!specIds.includes(id)) missing.push(`${p.name}'s ${library} (${id})`);
    }
  }
  return missing;
}
