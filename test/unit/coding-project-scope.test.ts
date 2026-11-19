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
it("preserves native/default scope bytes and disclosure while validating the closed offline profile", () => {
  const input = manifest(), result = codingProjectManifest(input);
  expect(JSON.stringify(result)).toBe(JSON.stringify(input)); expect(Object.hasOwn(result, "executionProfile")).toBe(false);
  expect(codingProjectScopeDisclosure([], false)).toBe("The complete accepted source tree is copied; unsupported links and oversized trees are refused.");
  expect(codingProjectScopeDisclosure([".git", "node_modules"], false)).toBe("Excluded source roots: .git, node_modules. Those paths are omitted from source captures and review exports. No dependencies are installed or downloaded; excluded dependency contents are unavailable.");
  expect(codingProjectScopeDisclosure([".git", "node_modules"], true)).toBe("Excluded source roots: .git, node_modules. Those paths are omitted from source captures and review exports. A separate fresh dependency copy is available to commands at /work/node_modules, read-only. Dependencies are not automatically archived; copied or derived source outputs can contain dependency bytes and are included in review exports.");
  expect(codingProjectManifest({ ...input, executionProfile: "wsl-offline" }).executionProfile).toBe("wsl-offline");
});
it.each(["online-host", "native", "wsl", "", null, true, { name: "wsl-offline" }])("rejects an unknown execution profile: %j", executionProfile => {
  expect(() => codingProjectManifest({ ...manifest(), executionProfile })).toThrow();
  expect(() => codingProjectScopeDisclosure([".git", "node_modules"], false, executionProfile as never)).toThrow("execution profile");
});
it("describes offline installs without granting access to excluded original dependencies or network downloads", () => {
  const disclosure = codingProjectScopeDisclosure(["node_modules", ".git"], false, "wsl-offline");
  expect(disclosure).toContain("Excluded source roots: .git, node_modules.");
  expect(disclosure).toContain("Excluded dependency contents from the original project are unavailable.");
  expect(disclosure).toContain("Local, offline package installation is available inside the isolated WSL copy.");
  expect(disclosure).toContain("Network access and public package downloads are unavailable.");
  expect(disclosure).not.toContain("No dependencies are installed");
  expect(codingProjectScopeDisclosure(["node_modules"], true, "wsl-offline")).toContain("read-only");
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

it("validates public cache input provenance only in its isolated profile and describes mutable installed contents honestly", () => {
  const receipt = { access: "verified-offline-cache-input", registry: "https://registry.npmjs.org", packageJsonSha256: "a".repeat(64), lockSha256: "b".repeat(64), setSha256: "c".repeat(64), packages: 2, compressedBytes: 1234, expandedBytes: 4567, entries: 12 };
  const input = { ...manifest(), dependencies: null, executionProfile: "wsl-public-lock", publicDependencies: receipt };
  const result = codingProjectManifest(input); receipt.packages = 5; expect(result.publicDependencies?.packages).toBe(2);
  const disclosure = codingProjectScopeDisclosure([".git", "node_modules"], false, "wsl-public-lock");
  expect(disclosure).toContain("normal approval of each exact lockfile package set"); expect(disclosure).toContain("not the later installed contents"); expect(disclosure).toContain("Private registries are unavailable");
  for (const invalid of [{ ...input, executionProfile: "wsl-offline" }, { ...input, dependencies: manifest().dependencies }, { ...input, publicDependencies: { ...receipt, registry: "https://private.example" } },
    { ...input, publicDependencies: { ...receipt, expandedBytes: 128 * 1024 * 1024 + 1 } }]) expect(() => codingProjectManifest(invalid)).toThrow();
});
