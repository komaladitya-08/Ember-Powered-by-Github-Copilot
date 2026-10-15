/** M9: staging stops unless the RPM's License: tag names every bundled licence (scripts/package/licences.mjs). */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readmeLibraries, specLicenceIds, spdxIds, uncoveredLicences } from "../../scripts/package/licences.mjs";

const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
const libvipsReadme = path.resolve("node_modules/@img/sharp-libvips-linux-x64/README.md");
const table = (rows: [string, string][]) => ["## Licensing", "", "| Library | Used under the terms of |", "|---|---|", ...rows.map(([l, t]) => `| ${l} | ${t} |`)].join("\n");

describe("the licence check before staging", () => {
  it("reads SPDX expressions and the spec's tag", () => {
    expect(spdxIds("(MIT OR Apache-2.0) AND Zlib")).toEqual(["MIT", "Apache-2.0", "Zlib"]);
    expect(spdxIds(undefined)).toEqual([]);
    expect(specLicenceIds("Name: x\nLicense:        MIT AND BSD-2-Clause\n")).toEqual(["MIT", "BSD-2-Clause"]);
  });

  it("fails on a package whose licence the spec doesn't name, or that names none", () => {
    expect(uncoveredLicences([{ name: "left-pad", license: "WTFPL", readme: null }], ["MIT"])).toEqual(["left-pad (WTFPL)"]);
    expect(uncoveredLicences([{ name: "mystery", license: "", readme: null }], ["MIT"])).toEqual(["mystery ((none))"]);
    expect(uncoveredLicences([{ name: "ok", license: "MIT OR Apache-2.0", readme: null }], ["MIT", "Apache-2.0"])).toEqual([]);
  });

  it("checks the libraries sharp-libvips says it bundles, and stops on one it doesn't know", () => {
    const pkg = (readme: string | null) => [{ name: "@img/sharp-libvips-linux-x64", license: "LGPL-3.0-or-later", readme }];
    expect(readmeLibraries(table([["cairo", "Mozilla Public License 1.1"]]))).toEqual([["cairo", "Mozilla Public License 1.1"]]);
    expect(uncoveredLicences(pkg(table([["cairo", "Mozilla Public License 1.1"]])), ["LGPL-3.0-or-later"])).toEqual(["@img/sharp-libvips-linux-x64's cairo (MPL-1.1)"]);
    expect(uncoveredLicences(pkg(table([["cairo", "Mozilla Public License 1.1"]])), ["LGPL-3.0-or-later", "MPL-1.1"])).toEqual([]);
    expect(uncoveredLicences(pkg(table([["libnew", "Some Licence"]])), ["LGPL-3.0-or-later"])).toEqual([expect.stringMatching(/libnew .*not yet in scripts\/package\/licences\.mjs/)]);
    expect(uncoveredLicences(pkg(null), ["LGPL-3.0-or-later"])).toEqual([expect.stringMatching(/no licensing table/)]);
  });

  it.skipIf(!fs.existsSync(libvipsReadme))("passes for what Ember bundles today (the spec names every library's licence)", () => {
    const readme = fs.readFileSync(libvipsReadme, "utf8");
    expect(readmeLibraries(readme).length).toBeGreaterThan(20);
    expect(uncoveredLicences([{ name: "@img/sharp-libvips-linux-x64", license: "LGPL-3.0-or-later", readme }], specLicenceIds(spec))).toEqual([]);
  });
});
