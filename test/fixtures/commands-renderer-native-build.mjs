/** Stage only the unchanged Commands renderer for a required Windows native CI experiment. Never builds the app. */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SOURCES = ["visible", "copy", "keys", "model", "terminal", "terminal-options", "terminal-size", "main"].map(name => "app/renderer/command/" + name + ".ts");
const SHARED_SOURCES = ["shortcuts", "targets", "visible-text"].map(name => "app/shared/" + name + ".ts");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const refused = () => new Error("The synthetic Commands renderer could not be staged.");
/** Fixed host input only; required Win32 CI owns the empty stage and the public, observed failed-assertion TAP bytes. */
export async function stageCommandsRenderer({ repository, stage, tap }) {
  // Do not even load esbuild or touch a stage in portable/default registration.
  if (process.platform !== "win32" || process.env.EMBER_COMMANDS_RENDERER_NATIVE_TEST !== "1") throw refused();
  try {
    if (typeof repository !== "string" || typeof stage !== "string" || !path.isAbsolute(repository) || !path.isAbsolute(stage) || !Buffer.isBuffer(tap) || tap.length < 1 || tap.length > 65536 ||
      !Buffer.from(tap.toString("utf8")).equals(tap) || !tap.includes(Buffer.from("ERR_ASSERTION"))) throw refused();
    tap = Buffer.from(tap);
    for (const directory of [repository, stage]) {
      const info = await fs.lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory) throw refused();
    }
    if ((await fs.readdir(stage)).length || stage === repository || stage.startsWith(repository + path.sep)) throw refused();
    const rootPackage = JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")), load = createRequire(path.join(repository, "package.json"));
    for (const name of ["esbuild", "@xterm/xterm"]) {
      const pkg = load.resolve(name + "/package.json"), installed = JSON.parse(await fs.readFile(pkg, "utf8"));
      const declared = rootPackage.devDependencies?.[name] ?? rootPackage.dependencies?.[name];
      if (typeof declared !== "string" || !/^\d+\.\d+\.\d+$/.test(declared) || installed.version !== declared) throw refused();
    }
    const sources = new Map();
    for (const source of [...SOURCES, ...SHARED_SOURCES]) {
      const file = path.join(repository, source);
      sources.set(file, await fs.readFile(file, "utf8"));
    }
    // Older auxiliary checkouts have the genuine legacy eight-module renderer. Current observed renderers must bind the ninth module too.
    const observer = path.join(repository, "app/shared/command-card-observation.ts");
    const observed = sources.get(path.join(repository, "app/renderer/command/main.ts")).includes("../../shared/command-card-observation");
    if (observed) sources.set(observer, await fs.readFile(observer, "utf8"));
    const rendererSources = observed ? 9 : 8;
    const app = path.join(stage, "app"); await fs.mkdir(app);
    const manifest = []; let total = 0;
    const write = async (relative, bytes) => {
      if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..") || manifest.some(file => file.path === relative)) throw refused();
      total += bytes.length; if (manifest.length >= 128 || bytes.length > 4 * 1024 * 1024 || total > 8 * 1024 * 1024) throw refused();
      const target = path.join(app, ...relative.split("/")); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      const copied = await fs.readFile(target), info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !copied.equals(bytes)) throw refused();
      manifest.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    };
    const copy = async (source, relative) => {
      const info = await fs.lstat(source); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw refused();
      await write(relative, await fs.readFile(source));
    };
    const tree = async (folder, relative) => {
      const info = await fs.lstat(folder); if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(folder) !== folder) throw refused();
      for (const name of (await fs.readdir(folder)).sort()) {
        const source = path.join(folder, name), next = relative + "/" + name, item = await fs.lstat(source);
        if (item.isDirectory() && !item.isSymbolicLink()) await tree(source, next); else await copy(source, next);
      }
    };
    for (const name of ["package.json", "main.cjs", "preload.cjs"]) await copy(path.join(repository, "test/fixtures/commands-renderer-native-app", name), name);
    for (const name of ["index.html", "styles.css"]) await copy(path.join(repository, "app/renderer/command", name), "renderer/command/" + name);
    await tree(path.join(repository, "app/renderer/shared"), "renderer/shared");
    await tree(path.join(repository, "assets/fonts"), "renderer/fonts");
    await copy(path.join(repository, "node_modules/@xterm/xterm/css/xterm.css"), "renderer/command/xterm.css");
    const outfile = path.join(app, "renderer/command/main.js");
    const { build } = await import("esbuild");
    const result = await build({ absWorkingDir: repository, entryPoints: ["app/renderer/command/main.ts"], outfile,
      bundle: true, sourcemap: true, platform: "browser", format: "iife", target: "chrome140", write: false, logLevel: "silent" });
    if (!Array.isArray(result.outputFiles) || result.outputFiles.length !== 2) throw refused();
    const javascript = result.outputFiles.find(file => file.path === outfile), mapping = result.outputFiles.find(file => file.path === outfile + ".map");
    if (!javascript || !mapping) throw refused();
    const map = JSON.parse(Buffer.from(mapping.contents).toString("utf8"));
    if (!Array.isArray(map.sources) || map.sources.length > 512 || !Array.isArray(map.sourcesContent) || map.sources.length !== map.sourcesContent.length) throw refused();
    for (const [index, name] of map.sources.entries()) {
      if (typeof name !== "string") throw refused();
      // esbuild incorporates the pinned xterm package's embedded webpack source map.
      if (name.startsWith("webpack://@xterm/xterm/")) continue;
      const source = name.startsWith("file:") ? fileURLToPath(name) : path.resolve(path.dirname(outfile), name);
      const content = sources.get(source);
      if (content === undefined || map.sourcesContent[index] !== content || await fs.readFile(source, "utf8") !== content) throw refused();
      sources.delete(source);
    }
    if (sources.size) throw refused();
    await write("renderer/command/main.js", Buffer.from(javascript.contents)); await write("renderer/command/main.js.map", Buffer.from(mapping.contents));
    await fs.writeFile(path.join(app, "fixture-data.json"), JSON.stringify({ schema: 1, rendererSources, files: manifest, tap: { bytes: tap.length, sha256: hash(tap), base64: tap.toString("base64") } }), { flag: "wx", mode: 0o600 });
    return { app, assetsVerified: true, rendererSources };
  } catch { throw refused(); }
}
