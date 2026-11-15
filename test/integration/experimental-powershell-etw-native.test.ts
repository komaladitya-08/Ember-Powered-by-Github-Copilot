/** Explicit source-built toolchain experiment. An unconfigured main CI does not select this optional build. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { measureWindowsPowerShellToolchain, prepareWindowsPowerShellProof } from "../../app/main/agent/isolated-windows-command-assets";
import { loadExperimentalWindowsLpacApi, type WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const configured = !!process.env.EMBER_EXPERIMENTAL_PS7_ROOT || process.env.EMBER_EXPERIMENTAL_PS7_REQUIRED === "1";
const providerProbe = `$p=[System.Diagnostics.Eventing.EventProvider]::new([Guid]'F90714A8-5509-434A-BF6D-B1624C8A19A2');
$w=$p.WriteMessageEvent('synthetic Ember experimental provider observation');
$r='{"registrationStatus":'+$p.RegistrationStatus+',"available":'+$p.IsRegistrationAvailable.ToString().ToLowerInvariant()+',"write":'+$w.ToString().ToLowerInvariant()+',"lastWriteError":'+[int][System.Diagnostics.Eventing.EventProvider]::GetLastWriteEventError()+'}';
$p.Dispose();`;
const script = `$ErrorActionPreference='Stop';
${providerProbe}
[IO.File]::WriteAllText([IO.Path]::Combine($env:EMBER_LPAC_STATE,'provider.json'),$r);
try {
  $items=@(Get-ChildItem -LiteralPath $env:EMBER_LPAC_WORK -Force -ErrorAction Stop);
  [IO.File]::WriteAllText([IO.Path]::Combine($env:EMBER_LPAC_STATE,'command.json'),'{"ok":true,"entries":'+$items.Count+'}'); exit 0;
} catch { [IO.File]::WriteAllText([IO.Path]::Combine($env:EMBER_LPAC_STATE,'failure.txt'),$_.Exception.ToString()); exit 41; }`;
function text(file: string): string | null {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024) throw new Error("Unbounded experimental result."); return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
const literal = (value: string) => value.replace(/'/g, "''");

describe.skipIf(process.platform !== "win32" || !configured)("pinned source PowerShell ETW compatibility experiment", () => {
  it("retains normal host ETW, explicitly reports denied LPAC ETW, and attempts a normal cmdlet without changing WDAC or capability policy", async () => {
    const root = process.env.EMBER_EXPERIMENTAL_PS7_ROOT;
    if (!root || process.arch !== "x64") throw new Error("The configured experiment requires its built Windows x64 toolchain.");
    const pin = JSON.parse(fs.readFileSync(path.resolve("scripts/experimental/powershell-lpac-etw.json"), "utf8"));
    const provenance = JSON.parse(fs.readFileSync(path.join(root, "..", "build-provenance.json"), "utf8").replace(/^\uFEFF/, ""));
    expect(provenance).toMatchObject({ experimental: true, productEnabled: false, sourceCommit: pin.sourceCommit, archiveSha256: pin.archiveSha256, patchSha256: pin.patchSha256 });
    expect(createHash("sha256").update(fs.readFileSync(path.join(root, "Microsoft.PowerShell.CoreCLR.Eventing.dll"))).digest("hex")).toBe(provenance.builtEventingSha256);
    const api = loadExperimentalWindowsLpacApi(), executable = path.join(root, "pwsh.exe");
    const hostEnv: NodeJS.ProcessEnv = { SystemRoot: api.windowsDirectory(), WINDIR: api.windowsDirectory(), TEMP: os.tmpdir(), TMP: os.tmpdir(),
      PATH: path.join(api.windowsDirectory(), "System32"), PSModulePath: path.join(root, "Modules"), POWERSHELL_TELEMETRY_OPTOUT: "1" };
    const host = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`${providerProbe}\n[Console]::WriteLine($r);`, "utf16le").toString("base64")],
      { env: hostEnv, timeout: 20_000, maxBuffer: 32 * 1024, windowsHide: true, encoding: "utf8" });
    const normal = JSON.parse(host.trim());
    expect(normal).toEqual({ registrationStatus: 0, available: true, write: true, lastWriteError: 0 });
    console.info("Experimental host audit: normal ETW provider retained", JSON.stringify(normal));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ember-source-ps7-"));
    let staged: Awaited<ReturnType<typeof prepareWindowsPowerShellProof>> | undefined, error: unknown, cleanupSafe = true;
    try {
      const utility = literal(path.join(root, "Modules", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1"));
      const hookOutput = path.join(parent, "hook.dll");
      execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Import-Module -Name '${utility}' -ErrorAction Stop; Microsoft.PowerShell.Utility\\Add-Type -Path '${literal(path.resolve("test/fixtures/isolated-windows-command-startup-hook.cs"))}' -OutputAssembly '${literal(hookOutput)}' -OutputType Library -ErrorAction Stop;`],
        { env: hostEnv, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
      const hook = fs.readFileSync(hookOutput); if (hook.length > 1024 * 1024 || hook.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid fixed startup hook.");
      let readSecurity = "";
      const diagnosticApi: WindowsLpacApi = { ...api,
        writeNewFile(file, bytes, sddl) { api.writeNewFile(file, bytes, sddl); if (file.endsWith("\\tools\\fixture.exe")) readSecurity = sddl; },
        createSuspended(profile, program, command, cwd, environment) {
          const value = environment.toString("utf16le"); if (!value.endsWith("\0\0")) throw new Error("Incomplete clean fixture environment.");
          const entries = value.slice(0, -2).split("\0");
          if (entries.some(item => /^(?:DOTNET_STARTUP_HOOKS|POWERSHELL_TELEMETRY_OPTOUT)=/i.test(item))) throw new Error("Unexpected ambient fixture option.");
          entries.push(`DOTNET_STARTUP_HOOKS=${path.join(path.dirname(program), "ember-startup-hook.dll")}`, "POWERSHELL_TELEMETRY_OPTOUT=1");
          entries.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase(), "en"));
          return api.createSuspended(profile, program, command, cwd, Buffer.from(entries.join("\0") + "\0\0", "utf16le"));
        },
      };
      const manifest = measureWindowsPowerShellToolchain(root);
      staged = await prepareWindowsPowerShellProof(parent, { assetRoot: root, manifestSha256: manifest.sha256 }, diagnosticApi);
      if (!readSecurity) throw new Error("No exact package read ACL for the fixed diagnostic.");
      api.writeNewFile(path.join(staged.fixture.paths.tools, "ember-startup-hook.dll"), hook, readSecurity);
      await staged.fixture.launch(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
      await staged.fixture.waitRootExited(60_000); (await staged.fixture.waitStopped(15_000)).requireStopped();
      const provider = text(path.join(staged.fixture.paths.state, "provider.json")), command = text(path.join(staged.fixture.paths.state, "command.json"));
      const startup = text(path.join(staged.fixture.paths.state, "startup-exception.txt")), failure = text(path.join(staged.fixture.paths.state, "failure.txt"));
      console.info("Experimental host audit: stopped LPAC runtime", JSON.stringify({ sourceCommit: pin.sourceCommit, patchSha256: pin.patchSha256, manifest, provider, command, startup, failure, exit: staged.fixture.exitCode() }));
      if (provider === null) throw new Error(`Source-built PowerShell did not complete ETW observation: exit=0x${staged.fixture.exitCode().toString(16)}, startup=${startup ?? "absent"}.`);
      expect(JSON.parse(provider)).toEqual({ registrationStatus: 5, available: false, write: false, lastWriteError: 3 });
      if (staged.fixture.exitCode() !== 0 || command === null) throw new Error(`ETW denial was observed, but normal PowerShell commands remain incompatible: ${failure ?? startup ?? "no command report"}`);
      expect(JSON.parse(command)).toEqual({ ok: true, entries: 0 });
      expect(startup).toBeNull();
    } catch (cause) { error = cause; }
    if (staged) { try { await staged.close(); } catch (cause) { cleanupSafe = false; error = new AggregateError([error, cause].filter(Boolean), "Experimental LPAC shutdown could not be verified."); } }
    if (cleanupSafe) fs.rmSync(parent, { recursive: true, force: true });
    if (error) throw error;
  }, 180_000);
});
