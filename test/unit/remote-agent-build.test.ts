import { beforeAll, describe, expect, it } from "vitest";
import { build, buildSync, type Metafile, type Plugin } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const captureFile = path.join(root, "app/main/perception/capture.ts");
const captureStub = path.join(root, "app/remote/capture-stub.ts");

/** The remote build's capture alias, as scripts/build-app.mjs has it. */
const remoteCaptureStub: Plugin = {
  name: "remote-capture-stub",
  setup(b) {
    b.onResolve({ filter: /(^|[\\/])capture(\.ts)?$/ }, args => {
      if (!args.path.startsWith(".")) return undefined;
      const p = path.resolve(args.resolveDir, args.path);
      return p === captureFile || `${p}.ts` === captureFile ? { path: captureStub } : undefined;
    });
  },
};

/** The agent's bundle's metafile, built as scripts/build-app.mjs builds dist/remote/ember-remote.cjs (nothing written). */
async function remoteMetafile(entry = "app/remote/main.ts"): Promise<Metafile> {
  const r = await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", target: "node24", external: ["koffi"],
    plugins: [remoteCaptureStub], metafile: true, write: false, outfile: "ember-remote.cjs", absWorkingDir: root, logLevel: "silent",
  });
  return r.metafile!;
}

/** Inputs the remote bundle may never hold (§5.2.2, critique integration-2): a path prefix, and the one file allowed in it. */
const BANNED_DIRS: { dir: string; except?: string[]; why: string }[] = [
  // killswitch.ts is the kill switch §5.3.2 reuses (its imports are types only); nothing else of the agent's brain.
  { dir: "app/main/agent/", except: ["app/main/agent/killswitch.ts"], why: "the Copilot agent" },
  { dir: "app/main/desk/", why: "Ember's desk" },
  { dir: "app/main/voice/", why: "voice" },
  { dir: "app/main/platform/win32/", why: "the Windows backend" },
  { dir: "app/main/platform/darwin/", why: "the macOS backend" },
  // launch.ts holds TEST_SWITCHES, which platform/compose.ts imports (critique integration-19).
  { dir: "app/sidecar-host/", except: ["app/sidecar-host/launch.ts"], why: "the Windows/macOS accessibility host" },
  { dir: "app/renderer/", why: "renderer pages" },
  { dir: "app/preload/", why: "preloads" },
];
const BANNED_IMPORTS = ["electron", "sharp", "@github/copilot-sdk", "net", "http", "https", "tls", "dgram"];

/** What the bundle check finds wrong in a metafile ([] when nothing). Reads the metafile only, never code text. */
function bundleProblems(meta: Metafile): string[] {
  const problems: string[] = [];
  for (const [input, info] of Object.entries(meta.inputs)) {
    const nm = input.lastIndexOf("node_modules/");
    if (nm >= 0) {
      const pkg = input.slice(nm + "node_modules/".length).split("/");
      const name = pkg[0].startsWith("@") ? `${pkg[0]}/${pkg[1]}` : pkg[0];
      if (name !== "zod") problems.push(`${input}: a package other than zod (${name})`);
    } else {
      for (const b of BANNED_DIRS) if (input.startsWith(b.dir) && !b.except?.includes(input)) problems.push(`${input}: ${b.why}`);
    }
    for (const imp of info.imports) {
      const bare = imp.path.replace(/^node:/, "");
      if (BANNED_IMPORTS.some(x => bare === x || bare.startsWith(`${x}/`))) problems.push(`${input} imports ${imp.path}`);
    }
  }
  return problems;
}

describe("the remote agent's bundle (§5.2.2, critique integration-2, remote-25)", () => {
  let meta: Metafile;
  beforeAll(async () => { meta = await remoteMetafile(); }, 60_000);

  it("holds nothing but Ember's plain-Node code and zod: no Electron, sharp, Copilot SDK or network module", () => {
    expect(bundleProblems(meta)).toEqual([]);
  });

  it("takes capture-stub.ts in place of perception/capture.ts, so sharp's loader isn't in it at all", () => {
    const inputs = Object.keys(meta.inputs);
    expect(inputs).toContain("app/remote/capture-stub.ts");
    expect(inputs).not.toContain("app/main/perception/capture.ts");
    expect(inputs.some(i => i.includes("sharp"))).toBe(false);
  });

  it("leaves koffi outside the bundle (it ships beside it and loads lazily, through createRequire)", () => {
    expect(Object.keys(meta.inputs).some(i => i.includes("node_modules/koffi"))).toBe(false);
    expect(Object.values(meta.inputs).some(i => i.imports.some(x => x.path === "koffi" && !x.external))).toBe(false);
  });

  it("catches a seeded violation (the check isn't vacuous)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-bundle-check-"));
    try {
      const entry = path.join(dir, "bad.ts");
      fs.writeFileSync(entry, 'import { request } from "node:https";\nimport { app } from "electron";\nexport const x = [request, app];\n');
      const r = buildSync({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", external: ["electron"], metafile: true, write: false, outfile: "x.cjs", logLevel: "silent" });
      expect(bundleProblems(r.metafile!).join("\n")).toMatch(/imports node:https[\s\S]*imports electron/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the same check on the build's own metafile when there is one (dist/remote/meta.json)", () => {
    const file = path.join(root, "dist/remote/meta.json");
    if (!fs.existsSync(file)) return;
    expect(bundleProblems(JSON.parse(fs.readFileSync(file, "utf8")) as Metafile)).toEqual([]);
  });
});
