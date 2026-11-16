import { expect, it } from "vitest";
import { codingProjectManifest, codingProjectScopeDisclosure } from "../../app/main/agent/coding-project-scope";

const manifest = () => ({ version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [{ path: ".git", kind: "directory" }], byteLimit: 10 * 1024 * 1024 },
  dependencies: { access: "copied-read-only", mount: "/work/node_modules", files: 2, bytes: 100, sha256: "a".repeat(64), materializedLinks: [{ path: ".bin/tool", target: "pkg/main.js" }] } });
it("validates and clones an explicit source/dependency scope without retaining host source paths", () => {
  const input = manifest(), result = codingProjectManifest(input); input.source.excludedRoots.pop(); input.dependencies.materializedLinks[0].target = "changed.js";
  expect(result.source.excludedRoots).toEqual([".git", "node_modules"]); expect(result.dependencies?.materializedLinks[0].target).toBe("pkg/main.js");
  expect(codingProjectScopeDisclosure(result.source.excludedRoots, true)).toContain("read-only");
  expect(codingProjectScopeDisclosure(result.source.excludedRoots, false)).toContain("unavailable");
});
it.each([
  { ...manifest(), source: { excludedRoots: ["dist"], omitted: [], byteLimit: 1 } },
  { ...manifest(), source: { excludedRoots: [".git", ".git"], omitted: [], byteLimit: 1 } },
  { ...manifest(), source: { excludedRoots: [".git"], omitted: [], byteLimit: 1 } },
  { ...manifest(), dependencies: { ...manifest().dependencies, materializedLinks: [{ path: "pkg/x", target: "../outside" }] } },
  { ...manifest(), dependencies: { ...manifest().dependencies, materializedLinks: [{ path: "pkg/x", target: "a/".repeat(64) + "x" }] } },
  { ...manifest(), dependencies: { ...manifest().dependencies, materializedLinks: [{ path: "pkg/x", target: "\ud800" }] } },
  { ...manifest(), dependencies: { ...manifest().dependencies, bytes: 129 * 1024 * 1024 } },
  { ...manifest(), hostSource: "/ungranted/private" },
])("rejects an inconsistent, escaping or oversized manifest %#", input => {
  expect(() => codingProjectManifest(input)).toThrow();
});
