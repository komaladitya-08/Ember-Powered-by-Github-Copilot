import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { codingNodeCandidates, discoverCodingToolchain } from "../../app/main/agent/coding-toolchain";
import { trustedCodingTestNodeOrSkip } from "../fixtures/coding/trusted-node";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function privateRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-node-discovery-")); roots.push(root); fs.chmodSync(root, 0o700); return root; }

describe.skipIf(process.platform !== "linux")("coding Node candidate selection", () => {
  it("considers the real non-Electron executable and only fixed trusted PATH prefixes", () => {
    const actual = "/opt/codex/runtimes/test/bin/node";
    const found = codingNodeCandidates({ execPath: actual, isElectron: false, env: { PATH: "/tmp/project/node_modules/.bin:.:/usr/local/bin:/opt/hostedtoolcache/node/22.12.0/x64/bin:/opt/codex/runtimes/test/bin:/opt/hostedtoolcache-evil/bin" } });
    expect(found).toContain(actual);
    expect(found).toContain("/usr/local/bin/node");
    expect(found).toContain("/opt/hostedtoolcache/node/22.12.0/x64/bin/node");
    expect(found).toContain("/opt/codex/runtimes/test/bin/node");
    expect(found.some(file => file.startsWith("/tmp/") || file.includes("node_modules") || file.includes("hostedtoolcache-evil"))).toBe(false);
    expect(codingNodeCandidates({ execPath: "/workspace/user-node/bin/node", isElectron: false, env: {} })).not.toContain("/workspace/user-node/bin/node");
  });

  it("never treats the app's Electron executable as Node or invents an Electron-as-Node launch mode", () => {
    const electron = createRequire(import.meta.url)("electron") as unknown as string;
    const found = codingNodeCandidates({ execPath: electron, isElectron: true, env: {} });
    expect(found).not.toContain(electron);
    expect(found.every(file => /\/(node|nodejs)$/i.test(file))).toBe(true);
    const actualNode = fs.realpathSync(process.execPath);
    expect(codingNodeCandidates({ execPath: actualNode, isElectron: true, env: {} })).toEqual(found);
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("real Linux coding toolchain discovery", () => {
  it("discovers and verifies an independently selected trusted Node asset in a copied, empty namespace", async ctx => {
    const asset = await trustedCodingTestNodeOrSkip(ctx), root = privateRoot(), actual = asset.nodePath;
    const before = { size: fs.statSync(actual).size, mtimeMs: fs.statSync(actual).mtimeMs };
    const result = await discoverCodingToolchain({ env: { PATH: path.dirname(actual), NODE_OPTIONS: "--require /never-load-this-file" }, execPath: actual, isElectron: false, protectedPaths: [root] });
    expect(result, result.message).toMatchObject({ available: true, nodePath: actual, version: asset.version });
    expect({ size: fs.statSync(actual).size, mtimeMs: fs.statSync(actual).mtimeMs }).toEqual(before);
    expect(fs.readdirSync(root)).toEqual([]);
  }, 30_000);

  it("reports unavailable when required trusted binaries would reach protected data", async () => {
    const result = await discoverCodingToolchain({ env: {}, execPath: process.execPath, isElectron: true, protectedPaths: ["/usr", "/opt", "/bin"] });
    expect(result).toMatchObject({ available: false, nodePath: null, version: null });
    expect(result.message).toContain("Bubblewrap");
  });

  it("does not start discovery after Stop and does not accept unverified protected roots", async () => {
    const root = privateRoot(), stop = new AbortController(); stop.abort();
    await expect(discoverCodingToolchain({ env: {}, execPath: process.execPath, isElectron: false, protectedPaths: [root], signal: stop.signal })).rejects.toThrow();
    expect(await discoverCodingToolchain({ env: {}, execPath: process.execPath, isElectron: false, protectedPaths: [path.join(root, "missing")] })).toMatchObject({ available: false, nodePath: null });
    expect(await discoverCodingToolchain({ env: {}, execPath: process.execPath, isElectron: false, protectedPaths: [] })).toMatchObject({ available: false, nodePath: null });
  });
});
