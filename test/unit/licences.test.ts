/** M9: staging stops unless the RPM's License: tag names every bundled licence (scripts/package/licences.mjs). */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BUNDLED_LIBRARIES, LICENCE_TEXTS, readmeLibraries, specLicenceIds, spdxIds, suppliedLicence, uncoveredLicences } from "../../scripts/package/licences.mjs";
import { layoutFor } from "../../scripts/package/layout.mjs";

const spec = fs.readFileSync(path.resolve("packaging/rpm/ember.spec"), "utf8");
// The package that carries libvips on this machine: sharp-libvips-<platform> on Linux and macOS, sharp-win32-<arch> on
// Windows (null on a machine Ember isn't staged on).
const libvipsPackage = (() => {
  try { return layoutFor(process.platform, process.arch).platformPackages.find(n => BUNDLED_LIBRARIES.some(b => b.package.test(n))) ?? null; } catch { return null; }
})();
const libvipsReadme = libvipsPackage ? path.resolve("node_modules", libvipsPackage, "README.md") : "";
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

  it("checks the libraries sharp's Windows builds carry themselves (there is no sharp-libvips package there)", () => {
    const win = (readme: string | null) => [{ name: "@img/sharp-win32-x64", license: "Apache-2.0 AND LGPL-3.0-or-later", readme }];
    const ids = ["Apache-2.0", "LGPL-3.0-or-later"];
    expect(uncoveredLicences(win(null), ids)).toEqual([expect.stringMatching(/sharp-win32-x64 \(no licensing table/)]);
    expect(uncoveredLicences(win(table([["cairo", "Mozilla Public License 1.1"]])), ids)).toEqual(["@img/sharp-win32-x64's cairo (MPL-1.1)"]);
    expect(uncoveredLicences([{ name: "@img/sharp-win32-arm64", license: "Apache-2.0 AND LGPL-3.0-or-later", readme: table([["libnew", "X"]]) }], ids))
      .toEqual([expect.stringMatching(/sharp-win32-arm64's libnew/)]);
    // sharp's macOS and Linux builds carry no libraries: sharp-libvips does.
    expect(uncoveredLicences([{ name: "@img/sharp-darwin-arm64", license: "Apache-2.0", readme: null }], ids)).toEqual([]);
  });

  it.skipIf(!libvipsReadme || !fs.existsSync(libvipsReadme))("passes for what Ember bundles today (the spec names every library's licence)", () => {
    const readme = fs.readFileSync(libvipsReadme, "utf8");
    const { license } = JSON.parse(fs.readFileSync(path.resolve("node_modules", libvipsPackage!, "package.json"), "utf8")) as { license: string };
    expect(readmeLibraries(readme).length).toBeGreaterThan(20);
    expect(uncoveredLicences([{ name: libvipsPackage!, license, readme }], specLicenceIds(spec))).toEqual([]);
  });
});

describe("licence texts for packages that ship none (review #211)", () => {
  it("supplies the GitHub packages' MIT licence, koffi's own for its platform builds, and sherpa-onnx's with what its WebAssembly holds", () => {
    for (const name of ["@github/copilot-sdk", "@github/copilot-sdk-linux-x64", "@github/copilot-sdk-win32-arm64", "@github/copilot-sdk-darwin-x64"]) {
      expect(suppliedLicence(name, "1.0.21"), name).toEqual({ texts: ["packaging/licences/github-copilot-sdk.txt"] });
    }
    for (const name of ["@koromix/koffi-linux-x64", "@koromix/koffi-win32-x64", "@koromix/koffi-darwin-arm64"]) {
      expect(suppliedLicence(name, "3.2.1"), name).toEqual({ texts: ["node_modules/koffi/LICENSE.txt"] });
    }
    expect(suppliedLicence("sherpa-onnx", "1.13.8")).toEqual({ texts: ["packaging/licences/sherpa-onnx.txt", "packaging/licences/espeak-ng-COPYING.txt"] });
  });

  it("stops staging for any other package without a licence file, and for a sherpa-onnx whose WebAssembly nobody checked", () => {
    expect(suppliedLicence("left-pad", "1.3.0")).toEqual({ error: expect.stringMatching(/left-pad 1\.3\.0 ships no licence file.*scripts\/package\/licences\.mjs/) });
    expect(suppliedLicence("@github/copilot-sdk-extra", "1.0.21")).toHaveProperty("error");
    expect(suppliedLicence("sherpa-onnx", "1.14.0")).toEqual({ error: expect.stringMatching(/sherpa-onnx 1\.14\.0.*1\.13\.8.*WebAssembly/) });
  });

  it("names texts that exist: checked in, or another bundled package's own file", () => {
    for (const t of LICENCE_TEXTS.flatMap(e => e.texts)) expect(fs.existsSync(path.resolve(t)), t).toBe(true);
    expect(fs.readFileSync(path.resolve("packaging/licences/github-copilot-sdk.txt"), "utf8")).toMatch(/^MIT License\n\nCopyright GitHub, Inc\.$/m);
    const sherpa = fs.readFileSync(path.resolve("packaging/licences/sherpa-onnx.txt"), "utf8");
    expect(sherpa).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    expect(sherpa).toMatch(/Copyright \(c\) Microsoft Corporation/);
    expect(sherpa).toMatch(/eSpeak NG .*GPL-3\.0-or-later/);
    expect(fs.readFileSync(path.resolve("packaging/licences/espeak-ng-COPYING.txt"), "utf8")).toMatch(/^\s+GNU GENERAL PUBLIC LICENSE\n\s+Version 3, 29 June 2007/);
  });
});
