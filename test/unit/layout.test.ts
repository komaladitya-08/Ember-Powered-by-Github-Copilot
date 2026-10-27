/** The staged layout of every target (scripts/package/layout.mjs) and the archives made from it (archive.mjs), checked on any OS. */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_FAMILIES, TARGETS, artifactNames, layoutFor, npmInvocation, packageNameOf, prodPackageDirs, selectPackages } from "../../scripts/package/layout.mjs";
import { archivePlan } from "../../scripts/package/archive.mjs";
import { askpassSourceCandidates } from "../../app/main/remote/askpass-win";

const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8")) as { packages: Record<string, { dev?: boolean; os?: string[]; cpu?: string[]; libc?: string[] }> };
/** The production packages in the lockfile (every platform's), as npm ls would print them under a root. */
const lockedProd = (root: string, sep = "/") => Object.entries(lock.packages).filter(([k, v]) => k && !v.dev).map(([k]) => [root, ...k.split("/")].join(sep));

describe("the Linux layout", () => {
  const linux = layoutFor("linux", "x64");
  it("is today's: an ember folder with the renamed binary, its fuses and the AT-SPI sidecar", () => {
    expect(linux).toMatchObject({
      appDir: "ember", exe: "ember", renames: [["electron", "ember"]], electronSource: ".", electronExe: "electron",
      resourcesDir: "resources", noticesDir: ".", electronNotices: [], fuseFile: "ember", remove: ["resources/default_app.asar"],
      sidecarFiles: [{ from: "sidecar/atspi/ember_atspi.py", to: "sidecar/atspi/ember_atspi.py" }],
      icon: null, exeResources: false, signing: null, voiceModels: "beside",
    });
    expect(linux.requiredDist.slice(0, 2)).toEqual(["main.cjs", "desk-agent.cjs"]);
    expect(linux.requiredDist).toEqual(expect.arrayContaining(["renderer/shared/ember.css", "renderer/fonts/InterVariable.woff2", "renderer/fonts/LICENSE.txt", "preload/", "renderer/"]));
    expect(linux.sidecarDist).toEqual([]);
  });

  it("keeps the glibc x64 builds and prunes what the old stage.mjs pruned", () => {
    expect(linux.platformPackages).toEqual(["@github/copilot-sdk-linux-x64", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@koromix/koffi-linux-x64"]);
    expect(linux.prune).toEqual(["@koromix/koffi-linux-x64/musl_x64", ...["ripgrep", "tgrep", "plugins", "builtin-skills"].map(d => `@github/copilot-sdk-linux-x64/${d}`)]);
  });

  it("leaves out the Windows and macOS accessibility host, so the RPM doesn't change when it is built", () => {
    expect(linux.excludeDist).toEqual(["ax-sidecar.cjs"]);
    expect(linux.requiredDist).not.toContain("ax-sidecar.cjs");
  });

  it("bundles exactly what the old skip list bundled", () => {
    const OLD_SKIP = [/linuxmusl/, /@img[\\/]sharp-wasm32/, /@emnapi/, /node_modules[\\/]tslib$/];
    // What npm installs on Linux x64 glibc: packages with no os/cpu, or with linux and x64 (musl builds too).
    const installed = Object.entries(lock.packages).filter(([k, v]) => k && !v.dev && (!v.os || v.os.includes("linux")) && (!v.cpu || v.cpu.includes("x64"))).map(([k]) => `/r/${k}`);
    const old = installed.filter(p => !OLD_SKIP.some(r => r.test(p)));
    const now = selectPackages(installed, linux);
    expect(now.bundle).toEqual(old);
    expect(now.missing).toEqual([]);
  });
});

describe("the Windows layout", () => {
  for (const arch of ["x64", "arm64"]) {
    const win = layoutFor("win32", arch);
    it(`stages Ember\\Ember.exe with its fuses and the UI Automation bridge (${arch})`, () => {
      expect(win).toMatchObject({
        label: `win-${arch}`, appDir: "Ember", exe: "Ember.exe", renames: [["electron.exe", "Ember.exe"]], electronSource: ".",
        electronExe: "electron.exe", fuseFile: "Ember.exe", resourcesDir: "resources", noticesDir: ".", electronNotices: [],
        remove: ["resources/default_app.asar"], signing: null, voiceModels: "inside", icon: { kind: "ico", file: "resources/ember.ico" },
        // Ember.exe gets Ember's version resource and that icon (exe-resources.mjs).
        exeResources: true,
      });
      expect(win.sidecarFiles.map(s => s.to)).toEqual(["sidecar/uia/ember_uia.ps1", "sidecar/uia/ember_uia.cs", "sidecar/atspi/ember_atspi.py", "ssh/ember_askpass.cs"]);
      expect(win.sidecarFiles.filter(s => s.to.startsWith("sidecar/")).every(s => s.from === s.to)).toBe(true);
      // SSH's askpass source lands where the packaged Ember compiles it from (askpass-win.ts's first candidate).
      const askpass = win.sidecarFiles.find(s => s.to === "ssh/ember_askpass.cs")!;
      expect(fs.existsSync(path.resolve(askpass.from))).toBe(true);
      expect(path.win32.join("C:\\Ember\\resources", ...askpass.to.split("/"))).toBe(askpassSourceCandidates({ resourcesPath: "C:\\Ember\\resources", appDir: "C:\\Ember\\resources\\app\\dist\\app" })[0]);
      // The doctor for a console, beside Ember.exe (cmd.exe waits for it and keeps its exit code).
      expect(win.launchers).toEqual([{ from: "packaging/windows/ember-doctor.cmd", to: "ember-doctor.cmd" }]);
    });

    it(`needs the accessibility host, tolerates its absence only by flag, and leaves the desk helper out (${arch})`, () => {
      expect(win.requiredDist).toContain("ax-sidecar.cjs");
      expect(win.sidecarDist).toEqual(["ax-sidecar.cjs"]);
      expect(win.requiredDist).not.toContain("desk-agent.cjs");
      expect(win.excludeDist).toEqual(["desk-agent.cjs"]);
    });

    it(`keeps sharp's own Windows build, which carries libvips (${arch})`, () => {
      expect(win.platformPackages).toEqual([`@github/copilot-sdk-win32-${arch}`, `@img/sharp-win32-${arch}`, `@koromix/koffi-win32-${arch}`]);
      expect(win.prune).toEqual(expect.arrayContaining([`@koromix/koffi-win32-${arch}/win32_${arch}/koffi.lib`, `@github/copilot-sdk-win32-${arch}/ripgrep`]));
      expect(win.prune.some(p => p.endsWith("koffi.node"))).toBe(false);
    });
  }
});

describe("the macOS layout", () => {
  for (const arch of ["arm64", "x64"]) {
    const mac = layoutFor("darwin", arch);
    it(`copies the whole Electron.app as Ember.app with its executable renamed, so app.isPackaged is true (${arch})`, () => {
      expect(mac).toMatchObject({
        label: `mac-${arch}`, appDir: "Ember.app", electronSource: "Electron.app", electronExe: "Electron.app/Contents/MacOS/Electron",
        exe: "Contents/MacOS/Ember", renames: [["Contents/MacOS/Electron", "Contents/MacOS/Ember"]], resourcesDir: "Contents/Resources",
        remove: ["Contents/Resources/default_app.asar"],
      });
      // Electron's app.isPackaged is false for an executable named "electron" (any case), on every OS.
      for (const l of [mac, layoutFor("win32", arch), layoutFor("linux", "x64")]) {
        expect(path.posix.basename(l.exe).replace(/\.exe$/i, "").toLowerCase(), l.target).not.toBe("electron");
      }
      // The helper apps keep Electron's names (Electron looks for "Electron Helper*.app" first): nothing else is renamed.
      expect(mac.renames.flat().some(p => p.includes("Helper"))).toBe(false);
    });

    it(`flips the fuses in the Electron Framework and signs the bundle ad hoc (${arch})`, () => {
      expect(mac.fuseFile).toBe("Contents/Frameworks/Electron Framework.framework/Electron Framework");
      expect(mac.electronFuseFile).toBe(`Electron.app/${mac.fuseFile}`);
      expect(mac.signing).toBe("adhoc");
      expect(mac.icon).toEqual({ kind: "icns", file: "Contents/Resources/ember.icns", replaces: "Contents/Resources/electron.icns" });
      // Info.plist names the bundle; there is no PE resource to rewrite.
      expect(mac.exeResources).toBe(false);
    });

    it(`puts the notices and Electron's licences inside the bundle (${arch})`, () => {
      expect(mac.noticesDir).toBe("Contents/Resources");
      expect(mac.electronNotices).toEqual(["LICENSE", "LICENSES.chromium.html", "version"]);
    });

    it(`ships no sidecar files besides the accessibility host in dist/app (${arch})`, () => {
      expect(mac.sidecarFiles).toEqual([]);
      expect(mac.sidecarDist).toEqual(["ax-sidecar.cjs"]);
      expect(mac.excludeDist).toEqual(["desk-agent.cjs"]);
      expect(mac.platformPackages).toEqual([`@github/copilot-sdk-darwin-${arch}`, `@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`, `@koromix/koffi-darwin-${arch}`]);
    });
  }
});

describe("every target", () => {
  const layouts = TARGETS.map(t => layoutFor(t.split("-")[0], t.split("-")[1]));

  it("refuses a target Ember isn't staged for", () => {
    for (const [p, a] of [["linux", "arm64"], ["win32", "ia32"], ["darwin", "universal"], ["freebsd", "x64"]]) expect(() => layoutFor(p, a)).toThrow(/isn't staged for/);
  });

  it("uses forward-slash relative paths only (joined with path.join on the staging OS)", () => {
    for (const l of layouts) {
      const paths = [l.electronSource, l.electronExe, l.electronFuseFile, l.appDir, l.exe, l.resourcesDir, l.noticesDir, l.fuseFile, ...l.remove, ...l.prune,
        ...l.requiredDist, ...l.excludeDist, ...l.sidecarFiles.flatMap(s => [s.from, s.to]), ...l.renames.flat(), ...(l.icon ? [l.icon.file] : [])];
      for (const p of paths) expect(p, `${l.target}: ${p}`).not.toMatch(/\\|^\/|\.\.|^[A-Za-z]:/);
    }
  });

  it("finds each target's platform builds in the lockfile, so npm ci on that OS installs them", () => {
    for (const l of layouts) {
      for (const name of l.platformPackages) {
        const entry = lock.packages[`node_modules/${name}`];
        expect(entry, `${l.target}: ${name}`).toBeDefined();
        expect(entry.os, name).toEqual([l.platform]);
        expect(entry.cpu, name).toEqual([l.arch]);
        expect(entry.libc ?? ["glibc"], name).toContain("glibc");
      }
      const { bundle, missing } = selectPackages(lockedProd("/repo"), l);
      expect(missing, l.target).toEqual([]);
      // Nothing of another platform's goes in.
      const families = bundle.map(packageNameOf).filter(n => PLATFORM_FAMILIES.some(f => n!.startsWith(f)));
      expect(families.sort(), l.target).toEqual([...l.platformPackages].sort());
      expect(bundle.map(packageNameOf)).toEqual(expect.arrayContaining(["@github/copilot-sdk", "koffi", "sharp", "sherpa-onnx", "zod"]));
      expect(bundle.map(packageNameOf)).not.toEqual(expect.arrayContaining(["tslib"]));
    }
  });

  it("names the archives by version, OS and architecture", () => {
    expect(artifactNames(layoutFor("win32", "x64"), "0.1.0")).toEqual(["Ember-0.1.0-win-x64.zip"]);
    expect(artifactNames(layoutFor("win32", "arm64"), "1.2.3")).toEqual(["Ember-1.2.3-win-arm64.zip"]);
    expect(artifactNames(layoutFor("darwin", "arm64"), "0.1.0")).toEqual(["Ember-0.1.0-mac-arm64.zip", "Ember-0.1.0-mac-arm64.dmg"]);
    expect(artifactNames(layoutFor("linux", "x64"), "0.1.0")).toEqual([]);
  });
});

describe("choosing the packages to bundle", () => {
  it("reads package names from either kind of path", () => {
    expect(packageNameOf("/r/node_modules/sharp")).toBe("sharp");
    expect(packageNameOf("/r/node_modules/@img/sharp-linux-x64")).toBe("@img/sharp-linux-x64");
    expect(packageNameOf("C:\\a\\r\\node_modules\\@img\\sharp-win32-x64")).toBe("@img/sharp-win32-x64");
    expect(packageNameOf("/r/node_modules/a/node_modules/@s/b")).toBe("@s/b");
    expect(packageNameOf("/r/node_modules/@scope")).toBeNull();
    expect(packageNameOf("/r/lib")).toBeNull();
  });

  it("keeps the target's builds, drops other platforms' and the wasm fallback's, and says what is missing", () => {
    const win = layoutFor("win32", "x64");
    const dirs = ["sharp", "@img/sharp-win32-x64", "@img/sharp-wasm32", "@emnapi/runtime", "tslib", "@koromix/koffi-win32-x64", "@github/copilot-sdk", "@img/colour"]
      .map(n => `C:\\r\\node_modules\\${n.replace("/", "\\")}`);
    const { bundle, skipped, missing } = selectPackages(dirs, win);
    expect(bundle.map(packageNameOf)).toEqual(["sharp", "@img/sharp-win32-x64", "@koromix/koffi-win32-x64", "@github/copilot-sdk", "@img/colour"]);
    expect(skipped.map(s => s.name)).toEqual(["@img/sharp-wasm32", "@emnapi/runtime", "tslib"]);
    expect(missing).toEqual(["@github/copilot-sdk-win32-x64"]);
    // A Linux build in a Windows stage is another platform's.
    expect(selectPackages(["/r/node_modules/@img/sharp-linux-x64"], win).skipped[0].why).toMatch(/not win32-x64's build/);
  });

  it("takes npm's paths relative to the root npm printed, so masking, drive-letter case and CRLF don't matter", () => {
    // npm masks anything shaped like a token in its output, a UUID in a folder name among them.
    const masked = "/tmp/***/repo\n/tmp/***/repo/node_modules/sharp\n/tmp/***/repo/node_modules/@img/sharp-linux-x64\n";
    expect(prodPackageDirs(masked, "/tmp/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/repo", path.posix)).toEqual([
      "/tmp/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/repo/node_modules/sharp",
      "/tmp/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/repo/node_modules/@img/sharp-linux-x64",
    ]);
    const windows = "c:\\a\\ember\\ember\r\nc:\\a\\ember\\ember\\node_modules\\koffi\r\n";
    expect(prodPackageDirs(windows, "C:\\a\\ember\\ember", path.win32)).toEqual(["C:\\a\\ember\\ember\\node_modules\\koffi"]);
    expect(prodPackageDirs("/r\n/r\n", "/r", path.posix)).toEqual([]);
    expect(prodPackageDirs("", "/r", path.posix)).toEqual([]);
  });

  it("runs npm without a shell where it can (Windows's npm.cmd needs one, or npm's own script)", () => {
    const args = ["ls", "--omit=dev", "--all", "--parseable"];
    expect(npmInvocation({ platform: "linux", execPath: "/usr/bin/node" }, args)).toEqual({ file: "npm", args, shell: false });
    expect(npmInvocation({ platform: "darwin", execPath: "/n", npmExecPath: "/x/npm-cli.js" }, args)).toEqual({ file: "npm", args, shell: false });
    expect(npmInvocation({ platform: "win32", execPath: "C:\\node\\node.exe", npmExecPath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js" }, args))
      .toEqual({ file: "C:\\node\\node.exe", args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", ...args], shell: false });
    // Started by something else (pnpm, a shell): the user's npm, through cmd.exe, with a fixed command line.
    expect(npmInvocation({ platform: "win32", execPath: "C:\\node\\node.exe", npmExecPath: "C:\\pnpm\\pnpm.cjs" }, args))
      .toEqual({ file: "npm ls --omit=dev --all --parseable", args: [], shell: true });
    expect(npmInvocation({ platform: "win32", execPath: "C:\\node\\node.exe" }, args).shell).toBe(true);
    expect(() => npmInvocation({ platform: "win32", execPath: "n" }, ["ls", "& calc"])).toThrow(/through the shell/);
    // remote-parts.mjs packs scoped packages by version (CI run 133): @ and / pass, cmd.exe's own characters don't.
    expect(npmInvocation({ platform: "win32", execPath: "n" }, ["pack", "@koromix/koffi-linux-x64@2.15.3", "--json"]))
      .toEqual({ file: "npm pack @koromix/koffi-linux-x64@2.15.3 --json", args: [], shell: true });
    for (const bad of ["a%PATH%", "a^b", "a|b", "a>b", "(a)", "a!b", "a b", "a\"b"]) {
      expect(() => npmInvocation({ platform: "win32", execPath: "n" }, ["pack", bad]), bad).toThrow(/through the shell/);
    }
  });
});

describe("the archives", () => {
  it("zips the Windows folder with System32's tar.exe and checks what went in", () => {
    const plan = archivePlan(layoutFor("win32", "x64"), { version: "0.1.0", out: "/r/dist/package", systemRoot: "D:\\Windows" });
    expect(plan.archives).toEqual([path.join("/r/dist/package", "Ember-0.1.0-win-x64.zip")]);
    expect(plan.steps[0]).toMatchObject({ file: "D:\\Windows\\System32\\tar.exe", args: ["-a", "-c", "-f", plan.archives[0], "-C", "/r/dist/package", "Ember"] });
    expect(plan.steps[1].args).toEqual(["-t", "-f", plan.archives[0]]);
    expect(plan.steps[1].expect).toEqual(["Ember/Ember.exe", "Ember/resources/app/package.json", "Ember/THIRD_PARTY_NOTICES"]);
    expect(archivePlan(layoutFor("win32", "arm64"), { version: "0.1.0", out: "/o" }).steps[0].file).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("makes the macOS zip with ditto and the disk image with hdiutil, retrying it, then verifies both", () => {
    const plan = archivePlan(layoutFor("darwin", "arm64"), { version: "0.1.0", out: "/r/dist/package" });
    const [zip, dmg] = plan.archives;
    expect(plan.steps.map(s => s.file)).toEqual(["ditto", "zipinfo", "hdiutil", "hdiutil"]);
    expect(plan.steps[0].args).toEqual(["-c", "-k", "--sequesterRsrc", "--keepParent", path.join("/r/dist/package", "Ember.app"), zip]);
    expect(plan.steps[1].expect).toEqual(expect.arrayContaining(["Ember.app/Contents/MacOS/Ember", "Ember.app/Contents/_CodeSignature/CodeResources", "Ember.app/Contents/Resources/app/package.json"]));
    expect(plan.steps[2]).toMatchObject({ args: ["create", "-volname", "Ember", "-srcfolder", plan.dmgRoot, "-ov", "-format", "UDZO", dmg], retries: 3 });
    expect(plan.steps[3].args).toEqual(["verify", dmg]);
  });

  it("leaves Linux to rpm.sh and appimage.sh", () => {
    expect(() => archivePlan(layoutFor("linux", "x64"), { version: "0.1.0", out: "/o" })).toThrow(/rpm\.sh and appimage\.sh/);
  });
});
