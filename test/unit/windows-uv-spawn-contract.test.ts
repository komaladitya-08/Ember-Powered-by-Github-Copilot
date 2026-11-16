/** Cross-language and workflow ownership contracts for the held first-emission producer. */
import fs from "node:fs";
import { expect, it } from "vitest";
import { experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { windowsUvSpawnEnvironment } from "../fixtures/windows-uv-spawn-proof";

const workflow = fs.readFileSync(new URL("../../.github/workflows/experimental-windows-uv-spawn.yml", import.meta.url), "utf8");
const branch = "ember-improve/20261116-uv-spawn-probe";
it.each([
  ["pull_request", branch, true], ["pull_request", "ember-improve/future-source", false], ["pull_request", "", false],
  ["workflow_dispatch", branch, true], ["workflow_dispatch", "", true],
])("owns only its exact PR head or an explicit dispatch (%s/%s)", (event, head, expected) => {
  const expressions = [...workflow.matchAll(/^ {4}if: (.+)$/gm)].map(match => match[1]); expect(expressions).toHaveLength(2);
  for (const expression of expressions) {
    expect(expression).toBe(`github.event_name == 'workflow_dispatch' || github.head_ref == '${branch}'`);
    const observed = event === "workflow_dispatch" || head === branch; expect(observed).toBe(expected);
  }
});
it("keeps the first Windows candidate compile-only regardless of metadata and uploads no private listing/object", () => {
  expect(workflow).toContain("runs-on: windows-2022");
  expect(workflow).not.toMatch(/run-integration|EMBER_UV_SPAWN_PROBE:|windows-uv-spawn-native\.test\.ts\s*$/m);
  expect(workflow).toContain("/observer-emission.json"); expect(workflow).not.toMatch(/\/observer\.asm|\.obj\s*$/m);
  const native = fs.readFileSync(new URL("../integration/windows-uv-spawn-native.test.ts", import.meta.url), "utf8");
  expect(native).toContain("const nativeEmissionReviewed = false;");
});
it("passes exactly the canonical root environment and its two finite controls through the C child whitelist", () => {
  const base = experimentalWindowsEnvironment({ root: "C:\\Native", tools: "C:\\Native\\tools", work: "C:\\Native\\work", state: "C:\\Native\\state", program: "C:\\Native\\tools\\probe.exe" }, "C:\\Windows", "C:\\Profile");
  const environment = windowsUvSpawnEnvironment(base, { canary: "C:\\Native\\canary.bin", parentPid: 123 });
  const keys = environment.toString("utf16le").split("\0").filter(Boolean).map(entry => entry.slice(0, entry.indexOf("=")).toUpperCase());
  const source = fs.readFileSync(new URL("../fixtures/windows-uv-spawn-probe.c", import.meta.url), "utf8");
  const whitelist = /static const WCHAR\* env_names\[\] = \{([^}]+)\}/.exec(source)![1];
  const child = [...whitelist.matchAll(/L"([A-Z_]+)"/g)].map(match => match[1]);
  expect(child).toHaveLength(11); expect(child.slice().sort()).toEqual(keys.slice().sort());
});
it.each(["extra", "duplicate", "invalid-pid", "relative-canary"])("refuses %s launch metadata instead of copying ambient variables", fault => {
  let base = experimentalWindowsEnvironment({ root: "C:\\Native", tools: "C:\\Native\\tools", work: "C:\\Native\\work", state: "C:\\Native\\state", program: "C:\\Native\\tools\\probe.exe" }, "C:\\Windows", "C:\\Profile");
  if (fault === "extra" || fault === "duplicate") base = Buffer.from(base.toString("utf16le").slice(0, -1) + (fault === "extra" ? "PRIVATE_TOKEN=C:\\secret" : "PATH=C:\\other") + "\0\0", "utf16le");
  expect(() => windowsUvSpawnEnvironment(base, { canary: fault === "relative-canary" ? "relative" : "C:\\Native\\canary.bin", parentPid: fault === "invalid-pid" ? 0 : 123 })).toThrow();
});
