import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(fileURLToPath(new URL("../../" + file, import.meta.url)), "utf8");
const contract = "test/unit/experimental-compatibility-workflows.test.ts";
const lifecycle = ["experimental-windows-lpac", "experimental-windows-lpac-api"];
// The native job bodies at fb88ec25, excluding only the moved Node portable step and the corrected stale comment.
// Scheduling headers are checked separately. These literals preserve the native steps, pins, matrices and bounds.
const specifications = [
  { file: "coding-boundary", native: "windows-boundary", units: [...lifecycle, "isolated-windows-command-assets"],
    nativeSha256: "3ccb6ded7a4cb641cd68810d17595e060f711217ed973df42f7482d0e0701a05" },
  { file: "experimental-windows-node-lpac", native: "node-lpac",
    units: ["windows-node-lpac-startup", "windows-node-lpac-events", "windows-node-lpac-io", "windows-node-lpac-fatal"],
    nativeSha256: "a50f84694f39771891ad4738596009f4831cbee209af71bd3aede6097e338ed2" },
  { file: "experimental-powershell-etw", native: "source-compatibility", units: [...lifecycle, "isolated-windows-command-assets"],
    nativeSha256: "f4b914bba372333da1f263527fb342dacd04b919a679de69df383ae44e9cd19a" },
  { file: "experimental-windows-lpac-trace", native: "trace", units: lifecycle,
    nativeSha256: "49f6a2c60e5158a8e64eacb103dff00ae26ee1c3f79c94c2c122ab0bd7e0ff1f" },
] as const;
type Specification = typeof specifications[number];

function jobs(source: string): Map<string, string> {
  const body = source.slice(source.indexOf("\njobs:\n") + 7), matches = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  return new Map(matches.map((match, index) => [match[1], body.slice(match.index, matches[index + 1]?.index)]));
}
function pathMatches(pattern: string, file: string): boolean {
  return new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$").test(file);
}
function check(source: string, specification: Specification): void {
  const refuse: () => never = () => { throw new Error("The compatibility workflow contract changed."); };
  const event = source.slice(source.indexOf("\non:\n"), source.indexOf("\npermissions:"));
  const paths = [...event.matchAll(/^ {6}- "([^"]+)"$/gm)].map(match => match[1]);
  if (!/^ {2}workflow_dispatch:\s*$/m.test(event) || !/^ {2}pull_request:\n {4}paths:\n/m.test(event) ||
      ![".github/workflows/" + specification.file + ".yml", contract, "docs/DEVELOPING.md", ...specification.units.map(name => "test/unit/" + name + ".test.ts")]
        .every(file => paths.some(pattern => pathMatches(pattern, file)))) refuse();
  const selected = jobs(source), portable = selected.get("portable"), native = selected.get(specification.native);
  if (selected.size !== 2 || !portable || !native) refuse();
  const portableHeader = portable.slice(0, portable.indexOf("    steps:\n"));
  const nativeHeader = native.slice(0, native.indexOf("    steps:\n"));
  if (/^ {4}(?:if|needs):/m.test(portableHeader) || !portableHeader.includes("    runs-on: ubuntu-24.04\n") ||
      !nativeHeader.includes("    if: github.event_name == 'workflow_dispatch'\n") || !nativeHeader.includes("    needs: portable\n")) refuse();
  const commands = [...portable.matchAll(/^ {6}- run: (.+)$|^ {8}run: (.+)$/gm)].map(match => match[1] ?? match[2]);
  const suite = [...specification.units.map(name => "test/unit/" + name + ".test.ts"), contract].join(" ");
  if (JSON.stringify(commands) !== JSON.stringify(["npm install -g npm@11.6.2", "npm ci", "npm test -- " + suite + " --maxWorkers=1"]) ||
      !portable.includes("          ELECTRON_SKIP_BINARY_DOWNLOAD: \"1\"\n") ||
      /continue-on-error|pull_request_target|EMBER_INTEGRATION|workflow_call:/.test(source)) refuse();
  const original = native.replace("    if: github.event_name == 'workflow_dispatch'\n", "").replace("    needs: portable\n", "");
  if (createHash("sha256").update(original).digest("hex") !== specification.nativeSha256) refuse();
}

for (const specification of specifications) describe(specification.file, () => {
  const source = read(".github/workflows/" + specification.file + ".yml");
  it("runs portable contracts automatically and keeps the exact native experiment behind explicit manual dispatch", () => {
    expect(() => check(source, specification)).not.toThrow();
  });
  it.each([
    ["automatic native execution", (value: string) => value.replace("if: github.event_name == 'workflow_dispatch'", "if: true")],
    ["native admission without portable success", (value: string) => value.replace("    needs: portable\n", "")],
    ["conditional portable execution", (value: string) => value.replace("  portable:\n", "  portable:\n    if: false\n")],
    ["missing portable contract", (value: string) => value.replace(" " + contract + " --maxWorkers=1", " --maxWorkers=1")],
    ["single-star PR path that cannot cover a nested unit", (value: string) => value.replace('      - "' + contract + '"', '      - "test/*"')],
    ["missing PR coverage", (value: string) => value.replace("  pull_request:\n", "  push:\n")],
    ["relaxed native deadline", (value: string) => {
      const marker = "  " + specification.native + ":\n", start = value.indexOf(marker);
      return value.slice(0, start) + value.slice(start).replace(/timeout-minutes: \d+/, "timeout-minutes: 99");
    }],
  ] as const)("refuses %s", (_name, change) => {
    expect(() => check(change(source), specification)).toThrow("The compatibility workflow contract changed.");
  });
});

it("retains the positive child/PowerShell contracts and failure publication rather than treating refusals as passes", () => {
  const child = read("test/integration/experimental-windows-lpac-native.test.ts");
  expect(child).toContain("expect(observed[9]).toBeGreaterThan(0)");
  expect(child).toContain("await expect(fixture.waitStopped(100)).rejects.toThrow(/descendants|root process/)");
  expect(child).toContain("const lease = await fixture.stop()");
  const powershell = read("test/integration/isolated-windows-command-powershell-native.test.ts");
  expect(powershell).toContain("No ACL/capability/AppContainer fallback is permitted");
  expect(powershell).toContain("if (exitCode !== 0 || runtime === null || command === null)");
  expect(powershell).toContain("expect(JSON.parse(command)).toEqual({ ok: true, entries: 0 })");
  const etw = read("test/integration/experimental-powershell-etw-native.test.ts");
  expect(etw).toContain("expect(JSON.parse(provider)).toEqual({ registrationStatus: 5, available: false, write: false, lastWriteError: 3 })");
  expect(etw).toContain("if (staged.fixture.exitCode() !== 0 || command === null)");
  const node = read("test/integration/isolated-windows-command-node-native.test.ts");
  expect(node).toContain("expect((await startupOutcomes()).lpacExit).toBe(0)");
  expect(node).toContain("expect((await ioStartupOutcomes()).lpacExit).toBe(0)");
  expect(node).toContain("for (const result of [report.read, report.write, report.network]) { expect(result.denied).toBe(true)");
  const trace = read("scripts/experimental/windows-lpac-access-trace.ps1");
  expect(trace).toContain("if ($cleanupFailed) { throw 'Diagnostic cleanup was incomplete; raw data was not uploaded.' }");
  expect(trace).toContain("if ($testExit -ne 0) { throw 'The native fixture failed; only filtered diagnostic evidence was published.' }");
  expect(trace).not.toContain("upload-artifact");
});
