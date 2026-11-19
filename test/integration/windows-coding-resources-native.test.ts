/** Actual Windows project file-only resources: NTFS ownership, drive paths, publication and closed cleanup. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsProjectCodingResources } from "../../app/main/agent/windows-coding-resources";
import type { ProjectCodingResourcesOptions } from "../../app/main/agent/coding-resources";
import type { WindowsFileOnlyWorkspace } from "../../app/main/agent/windows-file-only-workspace";
import type { TaskSpec } from "../../app/main/agent/worker";
import { decodeCodingReviewExport, type CodingExportTree } from "../../app/main/agent/coding-result-export";

const required = process.env.EMBER_WINDOWS_CODING_RESOURCES_TEST === "1";
const OWNER = "a".repeat(64), PROJECT = "11111111-1111-4111-8111-111111111111";
const ORIGINAL = "export const answer = 41;\n", PROPOSED = "export const answer = 42;\n";
const checks = { ran: 0, passed: 0, failed: 0 };
const text = (tree: CodingExportTree | undefined, name: string): string | undefined => {
  const entry = tree?.entries.find(value => value.path === name); return entry?.kind === "file" ? entry.bytes.toString("utf8") : undefined;
};

describe.skipIf(process.platform !== "win32" && !required)("native Windows project file-only resources", () => {
  let root: string, source: string, common: string, destination: string, userData: string, protectedFile: string;
  let options: ProjectCodingResourcesOptions, resources: WindowsProjectCodingResources[], retained: Set<WindowsProjectCodingResources>;
  beforeEach(() => {
    expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
    // Outside Vitest's recursively removed run-temp directory; uncertain native ownership must be retained.
    root = fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), "ember-native-project-resources-"));
    source = path.join(root, "source"); common = path.join(root, "private"); destination = path.join(root, "destination");
    userData = path.join(root, "userdata"); protectedFile = path.join(root, "application.bin");
    for (const directory of [source, destination, userData]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(source, "app.ts"), ORIGINAL); fs.writeFileSync(path.join(userData, "account.txt"), "protected-account-canary");
    fs.writeFileSync(protectedFile, "protected-application-canary"); resources = []; retained = new Set();
    options = { userData, protectedPaths: [protectedFile], currentOwner: () => OWNER, projectExists: id => id === PROJECT,
      env: {}, execPath: process.execPath, isElectron: false, storage: Object.freeze({ common, protectedPaths: Object.freeze([common]) }) };
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const resource of resources.slice().reverse()) {
      try { await resource.close(); if (retained.has(resource)) errors.push(new Error("A prior unowned namespace was unexpectedly removed.")); }
      catch (error) { if (!retained.has(resource)) errors.push(error); }
    }
    if (!errors.length && !retained.size && root) fs.rmSync(root, { recursive: true, force: true });
    if (retained.size) console.info("Synthetic prior Windows coding namespace retained; no recovery or forced cleanup was attempted.");
    if (errors.length) throw new AggregateError(errors, "Native project cleanup was not verified; synthetic scratch retained.");
  });
  async function open() { const resource = await WindowsProjectCodingResources.create(options); resources.push(resource); return resource; }
  async function bind(resource: WindowsProjectCodingResources) {
    const folder = await resource.validateSource({ path: source, current: () => true });
    expect(folder.path).toMatch(/^[A-Za-z]:\\/); expect(folder.path).not.toMatch(/^\\\\/);
    resource.folders.bind(PROJECT, folder, resource.folders.ownerCurrent(PROJECT));
  }
  function task(resource: WindowsProjectCodingResources): TaskSpec {
    const codingWorkspace = resource.workspace(PROJECT); expect(codingWorkspace).not.toBeNull();
    return { id: randomUUID(), goal: "Change the copied answer", target: {}, codingWorkspace: codingWorkspace! };
  }

  it("edits a fresh copy, publishes its exact stopped review, exports and forgets, then removes its fresh common root", async () => {
    const resource = await open();
    expect(resource.availability()).toMatchObject({ available: true, mode: "files-only", canContinue: true });
    expect(resource.availability()).not.toHaveProperty("nodePath");
    expect(resource.reviewBase).toMatch(/^[A-Za-z]:\\/); await bind(resource);
    const spec = task(resource), signal = new AbortController();
    const workspace = await resource.createWorkspace(spec, signal.signal, () => true) as WindowsFileOnlyWorkspace;
    expect(workspace).not.toHaveProperty("run"); expect(workspace).not.toHaveProperty("nodeAvailable");
    const broker = await workspace.filesBroker(signal.signal), before = await broker.readText("app.ts");
    await broker.replaceText("app.ts", "41", "42", { expectedSha256: before.sha256 });
    await broker.close(); await workspace.stop(); await workspace.sealForReview(); signal.abort();
    // This fixture attests only to this host file-broker seam, never to SDK/controller shutdown.
    const output = await workspace.exportReview(resource.reviewBase);
    expect(output.cleanup).toBe("complete"); expect(fs.readdirSync(path.join(path.dirname(resource.reviewBase), "copies"))).toEqual([]);
    const result = await resource.publish(spec, output, "stopped", checks), results = await resource.results();
    expect(await results.review(result.id)).toMatchObject({ status: "stopped", files: 1, checks });
    await expect(resource.publish(spec, output, "done", checks)).rejects.toThrow();
    const exported = await results.export(result.id, destination, () => true); expect(exported.ok).toBe(true);
    const decoded = decodeCodingReviewExport(fs.readFileSync(path.join(exported.directory!, "review.json")), output.review.binding);
    expect(text(decoded.baseline, "app.ts")).toBe(ORIGINAL); expect(text(decoded.proposed, "app.ts")).toBe(PROPOSED);
    expect(text(decoded.current, "app.ts")).toBe(ORIGINAL); expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.readFileSync(path.join(userData, "account.txt"), "utf8")).toBe("protected-account-canary");
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("protected-application-canary");
    await results.forgetResult(result.id); expect(results.state(PROJECT)).toEqual([]); expect(fs.readdirSync(resource.reviewBase)).toEqual([]);
    expect(fs.readdirSync(exported.directory!)).toEqual(["changes.patch", "review.json"]); await workspace.close(); await resource.close();
    expect(fs.existsSync(common)).toBe(false);
    const next = await open(); expect(next.availability().available).toBe(true); await next.close(); expect(fs.existsSync(common)).toBe(false);
  });

  it("refuses native protected roots, their ancestors and private storage as source folders", async () => {
    const resource = await open(); expect(resource.availability().available).toBe(true);
    for (const selected of [root, userData, common, path.dirname(resource.reviewBase), resource.reviewBase])
      await expect(resource.validateSource({ path: selected, current: () => true })).rejects.toThrow();
    await bind(resource); expect(resource.workspace(PROJECT)?.path).toBe(fs.realpathSync.native(source));
    await resource.close(); expect(fs.existsSync(common)).toBe(false);
  });

  it("continues the prior proposal in a fresh native copy, keeps the cumulative baseline and survives predecessor Forget", async () => {
    const resource = await open(); expect(resource.availability().available).toBe(true); await bind(resource);
    const firstTask = task(resource), signal = new AbortController();
    const first = await resource.createWorkspace(firstTask, signal.signal, () => true) as WindowsFileOnlyWorkspace;
    const firstBroker = await first.filesBroker(signal.signal); await firstBroker.writeText("app.ts", PROPOSED);
    await firstBroker.close(); await first.stop(); await first.sealForReview();
    const firstOutput = await first.exportReview(resource.reviewBase), previous = await resource.publish(firstTask, firstOutput, "stopped", checks);
    await first.close();
    const continuation = resource.captureContinuation(previous.id, PROJECT); expect(continuation).not.toBeNull();
    const nextTask = task(resource); nextTask.codingWorkspace = { ...nextTask.codingWorkspace!, continuation: continuation! };
    const next = await resource.createWorkspace(nextTask, signal.signal, () => true) as WindowsFileOnlyWorkspace;
    const nextBroker = await next.filesBroker(signal.signal); expect((await nextBroker.readText("app.ts")).text).toBe(PROPOSED);
    const results = await resource.results(); await results.forgetResult(previous.id);
    expect(resource.continuationCurrent(continuation!, PROJECT)).toBe(false);
    await nextBroker.replaceText("app.ts", "42", "43"); await nextBroker.close(); await next.stop(); await next.sealForReview();
    const nextOutput = await next.exportReview(resource.reviewBase), continued = await resource.publish(nextTask, nextOutput, "done", checks);
    const exported = await results.export(continued.id, destination, () => true); expect(exported.ok).toBe(true);
    const decoded = decodeCodingReviewExport(fs.readFileSync(path.join(exported.directory!, "review.json")), nextOutput.review.binding);
    expect(text(decoded.baseline, "app.ts")).toBe(ORIGINAL); expect(text(decoded.proposed, "app.ts")).toBe("export const answer = 43;\n");
    expect(text(decoded.current, "app.ts")).toBe(ORIGINAL); expect(results.state(PROJECT).map(result => result.id)).toEqual([continued.id]);
    expect(fs.readFileSync(path.join(source, "app.ts"), "utf8")).toBe(ORIGINAL);
    await results.forgetResult(continued.id); await next.close(); await resource.close(); expect(fs.existsSync(common)).toBe(false);
  });

  it.each([false, true])("retains a pre-existing common root without adopting or modifying it (contains data: %s)", async data => {
    fs.mkdirSync(common); const identity = fs.statSync(common, { bigint: true }).ino;
    if (data) fs.writeFileSync(path.join(common, "prior.txt"), "prior-private-canary");
    const resource = await open(); retained.add(resource);
    expect(resource.availability().available).toBe(false); expect(resource.availability().message).toContain("retained");
    expect(fs.statSync(common, { bigint: true }).ino).toBe(identity);
    expect(fs.readdirSync(common)).toEqual(data ? ["prior.txt"] : []);
    if (data) expect(fs.readFileSync(path.join(common, "prior.txt"), "utf8")).toBe("prior-private-canary");
    await expect(resource.invalidate()).rejects.toThrow(); await expect(resource.close()).rejects.toThrow();
    expect(fs.statSync(common, { bigint: true }).ino).toBe(identity); expect(fs.readdirSync(common)).toEqual(data ? ["prior.txt"] : []);
  });
});
