/**
 * Ember's askpass helper on a Windows PC (§5.1.6, L15): `ember-askpass.exe`, compiled at first use from the shipped
 * source resources/ssh/ember_askpass.cs by Windows PowerShell 5.1's Add-Type (the toolchain the UI Automation bridge
 * already uses; no new dependency) into <userData>\ssh\. The build is checked by SHA-256 against the one Ember recorded
 * before every use, and rebuilt when the source changes (an Ember update). Constrained Language Mode (AppLocker, WDAC)
 * blocks Add-Type: then there is no askpass on this PC, and connections use keys and the ssh-agent only (§8.7's
 * advice). The PowerShell text is fixed; the two paths reach it through the environment, never inside the script.
 */

import { createHash, randomBytes } from "node:crypto";
import win32 from "node:path/win32";
import type { Logger } from "../logger";

/** The helper's file name in <userData>\ssh. */
export const ASKPASS_EXE = "ember-askpass.exe";
/** What Ember recorded about its build (source and executable hashes). */
export const ASKPASS_RECORD = "ember-askpass.json";

/**
 * The fixed script Windows PowerShell 5.1 reads from stdin (`-Command -`, one statement per line): refuse outside
 * FullLanguage, compile the source to a console program, say so.
 */
export const COMPILE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Write-Output 'EMBER-CLM'; exit 3 }",
  "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:EMBER_ASKPASS_SRC)) -OutputAssembly $env:EMBER_ASKPASS_OUT -OutputType ConsoleApplication -ReferencedAssemblies System.Core",
  "Write-Output 'EMBER-OK'",
  "exit 0",
  "",
].join("\r\n");

/** What compiling needs (injected in tests: a fake PowerShell and file system). */
export interface AskpassWinDeps {
  userData: string;
  /** The shipped source (<resources>\ssh\ember_askpass.cs; askpassSourceCandidates). */
  source: string;
  /** Windows PowerShell 5.1's absolute path (%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe). */
  powershell: string;
  run(argv: string[], o: { stdin: string; env: Record<string, string>; timeoutMs: number }): Promise<{ code: number | null; stdout: string }>;
  fs: {
    readFile(p: string): Promise<Buffer>;
    writeFile(p: string, data: string | Buffer): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    rm(p: string): Promise<void>;
    mkdir(p: string): Promise<unknown>;
  };
  /** The environment the compile runs in (the user's; the two paths are added). */
  env: Record<string, string>;
  log?: Logger;
}

/** The helper is ready, or why not. */
export type AskpassWinResult = { exe: string } | { error: "clm" | "compile" | "source" | "write"; detail?: string };

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Where the shipped source may be: the packaged resources, then (unpackaged) the repository beside dist/app. */
export function askpassSourceCandidates(o: { resourcesPath: string; appDir: string }): string[] {
  return [win32.join(o.resourcesPath, "ssh", "ember_askpass.cs"), win32.join(o.appDir, "..", "..", "resources", "ssh", "ember_askpass.cs")];
}

/**
 * The compiled helper, built if needed (§5.1.6): kept when the recorded source hash equals the shipped source's and the
 * executable's bytes still hash to the recorded value; compiled again otherwise.
 */
export async function ensureAskpassHelper(d: AskpassWinDeps): Promise<AskpassWinResult> {
  const dir = win32.join(d.userData, "ssh");
  const exe = win32.join(dir, ASKPASS_EXE);
  const recordFile = win32.join(dir, ASKPASS_RECORD);
  const srcPath = d.source;
  let source: Buffer;
  try {
    source = await d.fs.readFile(srcPath);
  } catch {
    return { error: "source" };
  }
  const srcHash = sha256(source);
  const record = await d.fs.readFile(recordFile).then(b => JSON.parse(b.toString("utf8")) as { source?: unknown; exe?: unknown }).catch(() => null);
  if (record && record.source === srcHash && typeof record.exe === "string") {
    const bytes = await d.fs.readFile(exe).catch(() => null);
    if (bytes && sha256(bytes) === record.exe) return { exe };
    d.log?.warn("remote.askpass_helper_changed", {});
  }
  await d.fs.mkdir(dir).catch(() => undefined);
  const tmp = win32.join(dir, `ember-askpass-${randomBytes(6).toString("hex")}.tmp.exe`);
  const out = await d.run([d.powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    stdin: COMPILE_SCRIPT,
    env: { ...d.env, EMBER_ASKPASS_SRC: srcPath, EMBER_ASKPASS_OUT: tmp },
    timeoutMs: 60_000,
  }).catch(() => ({ code: null, stdout: "" }));
  if (/EMBER-CLM/.test(out.stdout)) return { error: "clm" };
  const built = out.code === 0 && /EMBER-OK/.test(out.stdout) ? await d.fs.readFile(tmp).catch(() => null) : null;
  if (!built || built.length === 0) {
    await d.fs.rm(tmp).catch(() => undefined);
    return { error: "compile", detail: `exit ${out.code}` };
  }
  try {
    await d.fs.rename(tmp, exe);
    await d.fs.writeFile(recordFile, JSON.stringify({ source: srcHash, exe: sha256(built) }));
  } catch (err) {
    await d.fs.rm(tmp).catch(() => undefined);
    return { error: "write", detail: String((err as Error).message ?? err).slice(0, 200) };
  }
  return { exe };
}

/** Windows PowerShell 5.1 by absolute path (never from PATH). */
export function powershellPath(systemRoot: string | undefined): string {
  const root = systemRoot && /^[A-Za-z]:\\/.test(systemRoot) ? systemRoot.replace(/\\+$/, "") : "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}
