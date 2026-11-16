/** The PR registration lane must never install a kernel collector automatically. */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWindowsLpacChildAccessWitness } from "../fixtures/windows-lpac-child-access-witness";
import { ChildAccessAssetError } from "../fixtures/windows-lpac-child-access-assets";

const workflow = fs.readFileSync(new URL("../../.github/workflows/experimental-windows-lpac-child-access-witness.yml", import.meta.url), "utf8");
const portable = workflow.slice(workflow.indexOf("  portable:"), workflow.indexOf("  witness:"));
const native = workflow.slice(workflow.indexOf("  witness:"));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("manual child-access witness registration", () => {
  it("refuses the actual witness entry on a PR event before any collector download or host preparation", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true"); vi.stubEnv("GITHUB_EVENT_NAME", "pull_request");
    vi.stubEnv("GITHUB_SHA", "a".repeat(40)); vi.stubEnv("EMBER_LPAC_CHILD_ACCESS_TEST", "1");
    vi.stubEnv("EMBER_LPAC_CHILD_ACCESS_RUNNER", "windows-2022");
    const download = vi.spyOn(globalThis, "fetch"), allocation = vi.spyOn(fs, "mkdtempSync");
    await expect(runWindowsLpacChildAccessWitness()).rejects.toBeInstanceOf(ChildAccessAssetError);
    expect(download).not.toHaveBeenCalled(); expect(allocation).not.toHaveBeenCalled();
  });
  it("limits automatic PR runs to portable injected contracts and gates the entire Windows job to manual dispatch", () => {
    expect(workflow).toContain("  pull_request:"); expect(workflow).toContain("  workflow_dispatch:");
    expect(native).toContain("    if: ${{ github.event_name == 'workflow_dispatch' }}\n    needs: portable");
    expect(portable).toContain("runs-on: ubuntu-22.04"); expect(portable).toContain("npm test -- test/unit/");
    expect(portable).not.toMatch(/run-integration|\.ps1|Invoke-WebRequest|curl|wget|AcceptEula|BackingFile|EMBER_LPAC_CHILD_ACCESS_TEST/);
    expect(native).toContain("os: [windows-2022, windows-2025]"); expect(native).toContain("EMBER_LPAC_CHILD_ACCESS_TEST: \"1\"");
  });
  it("uses immutable action references, read-only GitHub permissions and no raw artifact upload", () => {
    expect(workflow).toContain("permissions:\n  contents: read"); expect(workflow).toContain("cancel-in-progress: false");
    expect([...workflow.matchAll(/uses: ([^\n]+)/g)].every(match => /@[0-9a-f]{40}(?: #|$)/.test(match[1]))).toBe(true);
    expect(workflow).not.toMatch(/upload-artifact|actions\/upload|contents: write|persist-credentials: true/);
  });
  it("adds no trigger path used by the unsafe historical automatic trace workflow", () => {
    const paths = [...workflow.matchAll(/^ {6}- "([^"]+)"$/gm)].map(match => match[1]);
    expect(paths.length).toBe(5);
    expect(paths).not.toContain(".github/workflows/experimental-windows-lpac-trace.yml");
    expect(paths.some(value => value.startsWith("scripts/experimental/windows-lpac-"))).toBe(false);
    expect(paths).not.toContain("test/fixtures/experimental-windows-lpac.c");
    expect(paths).not.toContain("test/integration/experimental-windows-lpac-native.test.ts");
  });
});
