import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodingResultRegistry, CodingResultRegistryError, type CodingResultRegistration } from "../../app/main/agent/coding-result-registry";
import { createCodingReviewExport, type CodingExportTree, type CodingReviewExport } from "../../app/main/agent/coding-result-export";

const A = "a".repeat(64), B = "b".repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe.skipIf(process.platform !== "linux")("the host-only coding result registry", () => {
  let temp: string, base: string, source: string, destination: string;
  let owner: string | null, project: boolean, current: boolean;
  let registry: CodingResultRegistry;
  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "ember-result-registry-"));
    base = path.join(temp, "reviews"); source = path.join(temp, "source"); destination = path.join(temp, "destination");
    for (const directory of [base, source, destination]) await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(source, "app.ts"), "original\n", { mode: 0o600 });
    owner = A; project = true; current = true;
    registry = await CodingResultRegistry.create({ privateBase: base, currentOwner: () => owner, projectExists: id => project && ["project-one", "project-two"].includes(id) });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.close().catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true });
  });
  function review(text = "proposed\n", owner = A): CodingReviewExport {
    const binding = { owner, session: randomUUID(), snapshot: randomUUID() };
    const tree = (value: string): CodingExportTree => ({ binding, entries: [{ path: "app.ts", kind: "file", bytes: Buffer.from(value), executable: false }] });
    return createCodingReviewExport({ binding, baseline: tree("original\n"), proposed: tree(text), current: tree("original\n") }).review;
  }
  async function registration(value = review(), patch: Partial<CodingResultRegistration> = {}): Promise<CodingResultRegistration> {
    const directory = await fs.mkdtemp(path.join(base, "ember-coding-review-"));
    await fs.writeFile(path.join(directory, "review.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(directory, "changes.patch"), value.textPatch, { mode: 0o600 });
    return { expectedOwner: A, projectId: "project-one", taskId: "task-one", title: "Fix copied app", sourcePath: source,
      status: "done", checks: { ran: 1, passed: 1, failed: 0 }, current: () => current,
      output: { directory, review: value, cleanup: "complete" }, ...patch };
  }

  it("mints opaque ids, snapshots bounded metadata, and returns no retained file bodies/base64 over review", async () => {
    const input = await registration(), result = await registry.put(input);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.id).not.toBe(input.taskId);
    expect(result).toMatchObject({ projectId: "project-one", taskId: "task-one", sourcePath: source, files: 1, conflicts: 0, patchComplete: true, checks: { ran: 1, passed: 1, failed: 0 } });
    input.title = "mutated"; input.checks.passed = 0; input.output.review.textPatch = "mutated";
    const state = registry.state("project-one"); state[0].title = "caller mutation";
    const detail = await registry.review(result.id);
    expect(detail).toMatchObject({ title: "Fix copied app", sourcePath: source, changes: [{ path: "app.ts", kind: "modify" }] });
    expect(detail?.textPatch).toContain("+proposed");
    expect(detail?.previewMessage).toContain("including unchanged files");
    expect(JSON.stringify(detail)).not.toContain("base64");
    expect(detail).not.toHaveProperty("baseline"); expect(detail).not.toHaveProperty("proposed");
    expect(await registry.review(input.taskId)).toBeNull();
    expect(registry.state("other-project")).toEqual([]);
  });

  it("adopts only an exact stopped two-file artifact for failed-publication cleanup", async () => {
    const input = await registration();
    await registry.discard(input.output.directory);
    await expect(fs.lstat(input.output.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await registry.discard(input.output.directory);
    const retained = await registration(), result = await registry.put(retained);
    await expect(registry.discard(retained.output.directory)).rejects.toMatchObject({ code: "invalid" });
    expect(await registry.review(result.id)).not.toBeNull();
    const unsafe = await registration(); await fs.writeFile(path.join(unsafe.output.directory, "unknown.txt"), "keep");
    await expect(registry.discard(unsafe.output.directory)).rejects.toBeInstanceOf(CodingResultRegistryError);
    expect(await fs.readFile(path.join(unsafe.output.directory, "unknown.txt"), "utf8")).toBe("keep");
    await expect(registry.discard(source)).rejects.toMatchObject({ code: "invalid" });
  });

  it("retains adopted discard receipts through partial cleanup and retries without trusting new contents", async () => {
    const input = await registration(), unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("temporary failure"));
    await expect(registry.discard(input.output.directory)).rejects.toMatchObject({ code: "cleanup" });
    unlink.mockRestore(); await registry.reset();
    await expect(fs.lstat(input.output.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports exact verified files to a fresh private user directory without overwriting existing data", async () => {
    const input = await registration(), result = await registry.put(input);
    await fs.writeFile(path.join(destination, "review.json"), "keep-existing\n");
    const exported = await registry.export(result.id, destination, () => true);
    expect(exported.ok).toBe(true); expect(exported.directory).toBeDefined();
    expect(path.dirname(exported.directory!)).toBe(destination);
    expect(await fs.readFile(path.join(destination, "review.json"), "utf8")).toBe("keep-existing\n");
    for (const name of ["review.json", "changes.patch"]) {
      expect(await fs.readFile(path.join(exported.directory!, name))).toEqual(await fs.readFile(path.join(input.output.directory, name)));
      expect((await fs.stat(path.join(exported.directory!, name))).mode & 0o777).toBe(0o600);
    }
    expect((await fs.stat(exported.directory!)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(path.join(source, "app.ts"), "utf8")).toBe("original\n");
    await registry.reset();
    expect(await fs.readdir(base)).toEqual([]); expect(registry.state("project-one")).toEqual([]);
    expect(await fs.readdir(exported.directory!)).toEqual(["changes.patch", "review.json"]);
    expect(exported.message).toContain("including unchanged files");
  });

  it("omits oversized patch previews explicitly and copies multichunk artifacts whole", async () => {
    const input = await registration(review("x".repeat(300 * 1024) + "\n")), result = await registry.put(input);
    const detail = await registry.review(result.id);
    expect(detail?.textPatch).toBeNull(); expect(detail?.previewMessage).toContain("too large");
    const exported = await registry.export(result.id, destination, () => true);
    expect(exported.ok).toBe(true);
    for (const name of ["review.json", "changes.patch"]) expect((await fs.readFile(path.join(exported.directory!, name))).equals(await fs.readFile(path.join(input.output.directory, name)))).toBe(true);
  });

  it("forgets one private result immediately, preserving other results, original files and completed exports", async () => {
    const first = await registration(), a = await registry.put(first);
    const b = await registry.put(await registration(review("second\n")));
    const c = await registry.put(await registration(review("other project\n"), { projectId: "project-two" }));
    const exported = await registry.export(a.id, destination, () => true);
    expect(exported.ok).toBe(true);
    const forgetting = registry.forgetResult(a.id);
    expect(registry.state("project-one")).toEqual([b]);
    expect(await registry.review(a.id)).toBeNull();
    await forgetting;
    expect(await fs.readdir(base)).toHaveLength(2);
    expect(await registry.review(b.id)).not.toBeNull(); expect(await registry.review(c.id)).not.toBeNull();
    expect(await fs.readdir(exported.directory!)).toEqual(["changes.patch", "review.json"]);
    expect(await fs.readFile(path.join(source, "app.ts"), "utf8")).toBe("original\n");
    await expect(registry.forgetResult(a.id)).rejects.toMatchObject({ code: "stale" });
    await expect(registry.forgetResult(source)).rejects.toMatchObject({ code: "stale" });
    expect(registry.state("project-one")).toEqual([b]);
  });

  it("revokes an in-flight review by record identity without retiring another result or a pending publication", async () => {
    const first = await registration(), a = await registry.put(first);
    const next = await registration(review("second\n"));
    const entered = deferred<void>(), resume = deferred<void>(), realOpen = fs.open.bind(fs); let held = false;
    vi.spyOn(fs, "open").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      const handle = await Reflect.apply(realOpen, fs, [file, ...args]);
      if (!held && typeof file === "string" && file.endsWith("/" + path.basename(first.output.directory))) {
        held = true; const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => { await close(); entered.resolve(); await resume.promise; });
      }
      return handle;
    }) as typeof fs.open);
    const reading = registry.review(a.id); await entered.promise;
    const publishing = registry.put(next), forgetting = registry.forgetResult(a.id);
    expect(registry.state("project-one")).toEqual([]);
    resume.resolve();
    expect(await reading).toBeNull(); const b = await publishing; await forgetting;
    expect(registry.state("project-one")).toEqual([b]); expect(await registry.review(b.id)).not.toBeNull();
  });

  it("cancels an export at its first write when that exact result is forgotten and removes the partial export", async () => {
    const a = await registry.put(await registration()), b = await registry.put(await registration(review("keep\n")));
    const entered = deferred<void>(), resume = deferred<void>(), realOpen = fs.open.bind(fs); let held = false;
    vi.spyOn(fs, "open").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      const handle = await Reflect.apply(realOpen, fs, [file, ...args]);
      if (!held && typeof file === "string" && file.endsWith("/changes.patch") && typeof args[0] === "number" && (args[0] & 1)) {
        held = true; const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation((async (...input: unknown[]) => {
          const reply = await Reflect.apply(write, handle, input); entered.resolve(); await resume.promise; return reply;
        }) as typeof handle.writeFile);
      }
      return handle;
    }) as typeof fs.open);
    const exporting = registry.export(a.id, destination, () => true); await entered.promise;
    const forgetting = registry.forgetResult(a.id); resume.resolve();
    expect((await exporting).ok).toBe(false); await forgetting;
    expect(await fs.readdir(destination)).toEqual([]); expect(registry.state("project-one")).toEqual([b]);
  });

  it("retains failed per-result cleanup receipts and retries all unretained artifacts on a later Forget", async () => {
    const a = await registry.put(await registration()), b = await registry.put(await registration(review("second\n")));
    const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("private path must not escape"));
    await expect(registry.forgetResult(a.id)).rejects.toMatchObject({ code: "cleanup" });
    expect(registry.state("project-one")).toEqual([b]); expect(await fs.readdir(base)).toHaveLength(2);
    unlink.mockRestore(); await registry.forgetResult(b.id);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it("reports every omitted change explicitly rather than silently cutting paths or diagnostics", async () => {
    const binding = { owner: A, session: randomUUID(), snapshot: randomUUID() }, empty: CodingExportTree = { binding, entries: [] };
    const proposed: CodingExportTree = { binding, entries: Array.from({ length: 250 }, (_, i) => ({ path: `file-${i}.ts`, kind: "file", bytes: Buffer.from("value\n"), executable: false })) };
    const input = await registration(createCodingReviewExport({ binding, baseline: empty, proposed, current: empty }).review);
    const result = await registry.put(input), detail = await registry.review(result.id);
    expect(result.files).toBe(250); expect(detail?.changes).toHaveLength(200);
    expect(detail?.previewMessage).toContain("omits 50 changed paths");
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(512 * 1024);
  });

  it("retains truthful partial status, conflict paths and host-observed check counts", async () => {
    const value = review(); value.changes[0].conflicts = ["The original project differs from the baseline."];
    value.patchComplete = false; value.textPatch = "";
    const input = await registration(value, { status: "stopped", checks: { ran: 3, passed: 1, failed: 1 } }); input.output.cleanup = "retained";
    const result = await registry.put(input);
    expect(result).toMatchObject({ status: "stopped", conflicts: 1, patchComplete: false, checks: { ran: 3, passed: 1, failed: 1 } });
    expect(result.message).toContain("Partial coding result"); expect(result.message).toContain("retained");
    expect((await registry.review(result.id))?.changes[0].conflicts).toHaveLength(1);
  });

  it("fences owner, provider and project moves and never resurfaces old results after A to B to A", async () => {
    const result = await registry.put(await registration());
    owner = B;
    expect(registry.state("project-one")).toEqual([]); expect(await registry.review(result.id)).toBeNull();
    await registry.reset(); owner = A; await registry.reset();
    expect(registry.state("project-one")).toEqual([]); expect(await registry.review(result.id)).toBeNull();
    const next = await registry.put(await registration()); project = false;
    expect(registry.state("project-one")).toEqual([]); expect(await registry.review(next.id)).toBeNull();
    expect((await registry.export(next.id, destination, () => true)).ok).toBe(false);
    project = true;
    expect(registry.state("project-one")).toEqual([]); expect(await registry.review(next.id)).toBeNull();
  });

  it("rejects a stale intake capability while reclaiming its valid stopped private artifact", async () => {
    current = false; const input = await registration();
    await expect(registry.put(input)).rejects.toMatchObject({ code: "stale" });
    expect(await fs.readdir(base)).toEqual([]); expect(registry.state("project-one")).toEqual([]);
  });

  it("allows inert partial results after Stop when the owner capability remains valid", async () => {
    const input = await registration(review(), { status: "stopped" });
    const result = await registry.put(input);
    expect((await registry.review(result.id))?.status).toBe("stopped");
  });

  it("fences publication across reset and an owner ABA while verification is awaiting filesystem I/O", async () => {
    const input = await registration(), waiting = deferred<void>(), entered = deferred<void>();
    const realRead = fs.readFile.bind(fs); let first = true;
    vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      if (first && typeof file === "string" && file.startsWith("/proc/self/fdinfo/")) { first = false; entered.resolve(); await waiting.promise; }
      return Reflect.apply(realRead, fs, [file, ...args]);
    }) as typeof fs.readFile);
    const putting = registry.put(input).catch(error => error);
    await entered.promise; owner = B; const reset = registry.reset(); owner = A; current = false;
    waiting.resolve(); expect(await putting).toMatchObject({ code: "stale" }); await reset;
    expect(registry.state("project-one")).toEqual([]); expect(await fs.readdir(base)).toEqual([]);
  });

  it("forgets one project's pending result without cancelling another project's independent publication", async () => {
    const first = await registration(), second = await registration(review(), { projectId: "project-two", taskId: "task-two" });
    const waiting = deferred<void>(), entered = deferred<void>(), realRead = fs.readFile.bind(fs); let held = false;
    vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      if (!held && typeof file === "string" && file.startsWith("/proc/self/fdinfo/")) { held = true; entered.resolve(); await waiting.promise; }
      return Reflect.apply(realRead, fs, [file, ...args]);
    }) as typeof fs.readFile);
    const puttingFirst = registry.put(first).catch(error => error); await entered.promise;
    const puttingSecond = registry.put(second), forgotten = registry.forgetProject("project-one");
    waiting.resolve(); expect(await puttingFirst).toMatchObject({ code: "stale" });
    const published = await puttingSecond; await forgotten;
    expect(registry.state("project-one")).toEqual([]); expect(registry.state("project-two")).toEqual([published]);
    expect(await registry.review(published.id)).not.toBeNull();
  });

  it("verifies actual artifact bytes against the host-rendered review before publication", async () => {
    const input = await registration();
    await fs.appendFile(path.join(input.output.directory, "review.json"), " ");
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    expect(registry.state("project-one")).toEqual([]); expect(await fs.readdir(base)).toEqual([]);
  });

  it.each(["review.json", "changes.patch"])("withholds modified %s before preview or user export", async name => {
    const input = await registration(), result = await registry.put(input);
    await fs.appendFile(path.join(input.output.directory, name), "modified\n");
    expect(await registry.review(result.id)).toBeNull();
    expect((await registry.export(result.id, destination, () => true)).ok).toBe(false);
    expect(await fs.readdir(destination)).toEqual([]);
    await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
    expect(await fs.readFile(path.join(input.output.directory, name), "utf8")).toContain("modified");
  });

  it("rejects hardlinks, symlink artifacts and extra files without deleting unverified objects", async () => {
    const linked = await registration();
    await fs.link(path.join(linked.output.directory, "review.json"), path.join(temp, "outside-link.json"));
    await expect(registry.put(linked)).rejects.toMatchObject({ code: "artifact" });
    expect(await fs.readFile(path.join(temp, "outside-link.json"), "utf8")).toContain("review-only");
    const extra = await registration(); await fs.writeFile(path.join(extra.output.directory, "unknown.txt"), "keep\n");
    await expect(registry.put(extra)).rejects.toMatchObject({ code: "artifact" });
    expect(await fs.readFile(path.join(extra.output.directory, "unknown.txt"), "utf8")).toBe("keep\n");
    const alias = path.join(base, "alias"); await fs.symlink(source, alias, "dir");
    const input = await registration(); input.output.directory = alias;
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    expect(await fs.readFile(path.join(source, "app.ts"), "utf8")).toBe("original\n");
  });

  it("requires a private, pinned base and refuses its replacement", async () => {
    const input = await registration(), result = await registry.put(input);
    const moved = base + "-old"; await fs.rename(base, moved); await fs.mkdir(base, { mode: 0o700 });
    expect(await registry.review(result.id)).toBeNull();
    await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
    expect(await fs.readdir(moved)).toContain(path.basename(input.output.directory));
    await fs.chmod(base, 0o755);
    await expect(CodingResultRegistry.create({ privateBase: base, currentOwner: () => A, projectExists: () => true })).rejects.toMatchObject({ code: "artifact" });
  });

  it("never adopts or exports artifacts outside its private base or overlapping the source", async () => {
    const input = await registration(); input.output.directory = source;
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    const overlap = await registration(); overlap.sourcePath = temp;
    await expect(registry.put(overlap)).rejects.toMatchObject({ code: "invalid" });
    const valid = await registry.put(await registration());
    for (const target of [source, path.join(source, "nested"), base]) expect((await registry.export(valid.id, target, () => true)).ok).toBe(false);
    await fs.symlink(source, path.join(temp, "source-alias"), "dir");
    expect((await registry.export(valid.id, path.join(temp, "source-alias"), () => true)).ok).toBe(false);
    expect(await fs.readFile(path.join(source, "app.ts"), "utf8")).toBe("original\n");
  });

  it("rejects native identity evidence of a private-base alias even when the source device differs", async () => {
    const alias = path.join(temp, "native-alias"); await fs.mkdir(alias, { mode: 0o700 });
    const baseStat = await fs.stat(base, { bigint: true }), realOpen = fs.open.bind(fs);
    // Fault injection models the kernel facts for a source on another device and a bind alias of the private base.
    vi.spyOn(fs, "open").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      const handle = await Reflect.apply(realOpen, fs, [file, ...args]), physical = fsSync.readlinkSync(`/proc/self/fd/${handle.fd}`);
      if (physical === source || physical === alias) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation((async (...options: unknown[]) => {
          const value = await Reflect.apply(stat, handle, options) as fsSync.Stats | fsSync.BigIntStats;
          if (physical === source) Object.assign(value, { dev: typeof value.dev === "bigint" ? baseStat.dev + 1n : Number(baseStat.dev) + 1 });
          else Object.assign(value, { dev: baseStat.dev, ino: baseStat.ino });
          return value;
        }) as typeof handle.stat);
      }
      return handle;
    }) as typeof fs.open);
    const result = await registry.put(await registration());
    expect((await registry.export(result.id, alias, () => true)).ok).toBe(false);
    expect(await fs.readdir(alias)).toEqual([]); expect(registry.state("project-one")).toHaveLength(1);
  });

  it("keeps previews when the source disappears but refuses an unverifiable source boundary for export", async () => {
    const result = await registry.put(await registration());
    await fs.rename(source, source + "-moved");
    expect(await registry.review(result.id)).not.toBeNull();
    expect((await registry.export(result.id, destination, () => true)).ok).toBe(false);
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it("rejects oversized on-disk frames before reading their contents and never parses file JSON", async () => {
    const input = await registration();
    await fs.truncate(path.join(input.output.directory, "changes.patch"), 64 * 1024 * 1024 + 1);
    await expect(registry.put(input)).rejects.toMatchObject({ code: "artifact" });
    expect(registry.state("project-one")).toEqual([]);
    expect((await fs.stat(path.join(input.output.directory, "changes.patch"))).size).toBe(64 * 1024 * 1024 + 1);
  });

  it("refuses beyond 32 published results explicitly and reclaims the refused stopped artifact", async () => {
    for (let i = 0; i < 32; i++) await registry.put(await registration(review(), { taskId: `task-${i}` }));
    const refused = await registration();
    await expect(registry.put(refused)).rejects.toMatchObject({ code: "limit" });
    expect(registry.state("project-one")).toHaveLength(32); expect(await fs.readdir(base)).toHaveLength(32);
    await registry.forgetResult(registry.state("project-one")[0].id);
    await registry.put(await registration());
    expect(registry.state("project-one")).toHaveLength(32); expect(await fs.readdir(base)).toHaveLength(32);
  }, 15_000);

  it("clears visible ids immediately and retains failed cleanup tracking for a successful retry", async () => {
    const input = await registration(), result = await registry.put(input);
    const remove = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("untrusted path or credential detail"));
    const resetting = registry.reset(); expect(registry.state("project-one")).toEqual([]);
    await expect(resetting).rejects.toMatchObject({ code: "cleanup" });
    expect(await registry.review(result.id)).toBeNull(); expect(await fs.readdir(base)).toHaveLength(1);
    remove.mockRestore(); await registry.reset(); expect(await fs.readdir(base)).toEqual([]);
  });

  it("cancels an export after its first write and cleans only its own incomplete files", async () => {
    const result = await registry.put(await registration(review("x".repeat(100_000) + "\n")));
    const realOpen = fs.open.bind(fs); let allowed = true, changed = false;
    vi.spyOn(fs, "open").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      const handle = await Reflect.apply(realOpen, fs, [file, ...args]);
      if (!changed && typeof file === "string" && file.endsWith("/changes.patch") && typeof args[0] === "number" && (args[0] & 1)) {
        changed = true; const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation((async (...input: unknown[]) => { const result = await Reflect.apply(write, handle, input); allowed = false; return result; }) as typeof handle.writeFile);
      }
      return handle;
    }) as typeof fs.open);
    const exported = await registry.export(result.id, destination, () => allowed);
    expect(changed).toBe(true); expect(exported.ok).toBe(false); expect(await fs.readdir(destination)).toEqual([]);
    expect(await fs.readFile(path.join(source, "app.ts"), "utf8")).toBe("original\n");
  });

  it("quarantines a created directory immediately when its first identity read fails", async () => {
    const result = await registry.put(await registration()), realStat = fs.lstat.bind(fs); let injected = false;
    vi.spyOn(fs, "lstat").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      if (!injected && typeof file === "string" && /\/ember-coding-review-[0-9a-f-]{36}$/.test(file)) { injected = true; throw new Error("identity unavailable"); }
      return Reflect.apply(realStat, fs, [file, ...args]);
    }) as typeof fs.lstat);
    const exported = await registry.export(result.id, destination, () => true);
    expect(injected).toBe(true); expect(exported.ok).toBe(false); expect(exported.directory).toBeDefined();
    expect(await fs.readdir(exported.directory!)).toEqual([]);
    await fs.writeFile(path.join(exported.directory!, "user.txt"), "keep unknown data\n");
    await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
    await expect(registry.reset()).rejects.toMatchObject({ code: "cleanup" });
    expect(await fs.readFile(path.join(exported.directory!, "user.txt"), "utf8")).toBe("keep unknown data\n");
  });

  it("removes a fresh empty directory after an open failure when its original inode was already captured", async () => {
    const result = await registry.put(await registration()), realOpen = fs.open.bind(fs); let injected = false;
    vi.spyOn(fs, "open").mockImplementation((async (file: unknown, ...args: unknown[]) => {
      if (!injected && typeof file === "string" && /\/ember-coding-review-[0-9a-f-]{36}$/.test(file)) { injected = true; throw new Error("open failed"); }
      return Reflect.apply(realOpen, fs, [file, ...args]);
    }) as typeof fs.open);
    expect((await registry.export(result.id, destination, () => true)).ok).toBe(false);
    expect(injected).toBe(true); expect(await fs.readdir(destination)).toEqual([]);
    await registry.reset();
  });

  it.each([
    { expectedOwner: B }, { title: "" }, { sourcePath: "relative" }, { status: "running" },
    { checks: { ran: 0, passed: 1, failed: 0 } }, { checks: { ran: Infinity, passed: 0, failed: 0 } },
    { checks: { ran: 1, passed: 1 } },
  ])("rejects invalid host registrations without exposing paths or bytes: %j", async patch => {
    const input = await registration(review(), patch as Partial<CodingResultRegistration>);
    const error = await registry.put(input).catch(error => error);
    expect(error).toBeInstanceOf(CodingResultRegistryError); expect(String(error)).not.toContain(temp); expect(registry.state("project-one")).toEqual([]);
  });
});
