/**
 * The Electron child the Windows and macOS vocabulary suites share (test/integration/win32-vocabulary.test.ts and
 * darwin-vocabulary.test.ts): inside a real Electron it lists what the clipboard holds (each item's types as Electron
 * names them), saves it through agent/clipboard.ts with this OS's CLIPBOARD_FORMATS row (did the row see a password
 * manager's marker?), then puts text on it the way Ember does before a paste (writeText with the row's own-text
 * markers) and lists the types again. The suites set the clipboard natively before (a password manager's copy) and
 * read it natively after (did Windows or macOS get Ember's marker?), which is what design §9.11 asks CI to verify.
 * Not a test file: it has no tests of its own.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";

/** What the child reports. */
export interface ClipboardReport {
  /** Each item's types before Ember touched the clipboard, as Electron lists them. */
  before?: string[][];
  /** Did saving it find the OS's password marker (agent/clipboard.ts ClipboardSnapshot.password)? */
  password?: boolean;
  /** The types after Ember's writeText, and the text then. */
  after?: string[][];
  afterText?: string;
  /** What threw, at each step. */
  readError?: string;
  saveError?: string;
  writeError?: string;
  readAfterError?: string;
}

const CHILD = `
import { app, clipboard, ClipboardItem } from "electron";
import { electronClipboard } from "./app/main/agent/clipboard";
import { CLIPBOARD_FORMATS } from "./app/main/agent/clipboard-formats";

const text = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const out: Record<string, unknown> = {};
  const formats = CLIPBOARD_FORMATS[process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"];
  try { out.before = (await clipboard.read()).map(i => [...i.types]); } catch (err) { out.readError = String(err); }
  const paste = electronClipboard(clipboard, ClipboardItem, 3000, formats);
  try { out.password = (await paste.save()).password === true; } catch (err) { out.saveError = String(err); }
  try { await paste.writeText(text); } catch (err) { out.writeError = String(err); }
  try {
    out.after = (await clipboard.read()).map(i => [...i.types]);
    out.afterText = await clipboard.readText();
  } catch (err) {
    out.readAfterError = String(err);
  }
  process.stdout.write("EMBER_RESULT " + JSON.stringify(out) + "\\n");
  app.exit(0);
});
`;

/** The Electron binary the electron package installed (its main export is the path). */
export const electronBinary = (): string => createRequire(import.meta.url)("electron") as unknown as string;

/** Builds the child into .cache/test under `root` and runs it under Electron with `text` as Ember's paste text. */
export async function runClipboardChild(root: string, text: string): Promise<ClipboardReport> {
  const dir = path.join(root, ".cache", "test", "vocabulary-clipboard-electron");
  fs.mkdirSync(dir, { recursive: true });
  buildSync({
    stdin: { contents: CHILD, loader: "ts", resolveDir: root, sourcefile: "vocabulary-clipboard-child.ts" },
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], outfile: path.join(dir, "main.cjs"), logLevel: "silent",
  });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ember-vocabulary-clipboard-test", main: "main.cjs" }));
  const electron = electronBinary();
  if (!fs.existsSync(electron)) throw new Error(`no Electron binary at ${electron} (npx install-electron)`);
  return new Promise<ClipboardReport>((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE from the caller would start a plain Node instead of the app.
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [dir, text], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Electron didn't report within 60 s\n${stderr}`)); }, 60_000);
    child.on("exit", code => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find(l => l.startsWith("EMBER_RESULT "));
      if (!line) return reject(new Error(`Electron exited ${code} without a report\n${stderr}`));
      resolve(JSON.parse(line.slice("EMBER_RESULT ".length)) as ClipboardReport);
    });
  });
}
