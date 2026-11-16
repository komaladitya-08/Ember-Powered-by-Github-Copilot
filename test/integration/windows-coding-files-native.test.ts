/** Real NTFS foundation checks; Windows configuration failures are failures, never environment opt-in skips. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WindowsCodingCopy } from "../../app/main/agent/windows-coding-copy";
import { WindowsScopedCodingFiles } from "../../app/main/agent/windows-scoped-coding-files";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import { CodingPrivacyScanner, retireCodingPrivacyScanners } from "../../app/main/agent/coding-privacy-scanner";
import * as native from "../../app/main/agent/windows-coding-native";

const SECRET = "ghp_" + "A".repeat(36), ORIGINAL = "export const answer = 41;\n";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
/** Emit one fixed, path-free native receipt before the host's public error sanitizer removes its cause. */
function captureNativeRenameFailure(): void {
  const load = native.loadWindowsCodingNative; let remaining = 1;
  vi.spyOn(native, "loadWindowsCodingNative").mockImplementation(() => {
    const api = load(), replace = api.replace;
    api.replace = (...args) => {
      try { return replace.apply(api, args); }
      catch (error) {
        if (remaining-- > 0) {
          const cause = (error as { cause?: { operation?: unknown; status?: unknown } } | null)?.cause;
          const allowed = ["NtSetInformationFile(rename)", "NtCreateFile", "GetFileInformationByHandle", "GetFinalPathNameByHandleW", "GetSecurityInfo"];
          const operation = typeof cause?.operation === "string" && allowed.includes(cause.operation) ? cause.operation : "unavailable";
          const status = typeof cause?.status === "number" && Number.isInteger(cause.status) && cause.status >= 0 && cause.status <= 0xffffffff
            ? `0x${cause.status.toString(16).padStart(8, "0")}` : "unavailable";
          console.error(`Native rename failure: ${JSON.stringify({ operation, status })}`);
        }
        throw error;
      }
    };
    return api;
  });
}
describe.skipIf(process.platform !== "win32")("native Windows private coding-copy foundation", () => {
  let root: string, source: string, base: string, protectedRoot: string, signal: AbortController, current: boolean;
  let copies: WindowsCodingCopy[], brokers: WindowsScopedCodingFiles[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-native-files-")); source = path.join(root, "source"); base = path.join(root, "copies"); protectedRoot = path.join(root, "protected");
    for (const folder of [source, base, protectedRoot, path.join(source, "src")]) fs.mkdirSync(folder);
    fs.writeFileSync(path.join(source, "src", "app.ts"), ORIGINAL); fs.writeFileSync(path.join(source, "README.md"), "public first line\nsecond line\n");
    fs.writeFileSync(path.join(protectedRoot, "auth.txt"), "protected-host-canary"); signal = new AbortController(); current = true; copies = []; brokers = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks(); const errors: unknown[] = [];
    for (const broker of brokers.reverse()) { try { await broker.close(); } catch (error) { errors.push(error); } }
    for (const copy of copies.reverse()) { try { await copy.close(); } catch (error) { errors.push(error); } }
    if (!errors.length) fs.rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Native fixture cleanup was not verified; synthetic scratch retained.");
  });
  async function copy(limits?: Parameters<typeof WindowsCodingCopy.create>[0]["limits"]) {
    const value = await WindowsCodingCopy.create({ source, privateBase: base, protectedPaths: [protectedRoot], signal: signal.signal, current: () => current, limits }); copies.push(value); return value;
  }
  async function open() { const workspace = await copy(); const broker = await WindowsScopedCodingFiles.create({ copy: workspace, signal: signal.signal }); brokers.push(broker); return { workspace, broker }; }

  it("opens a pinned fixed-NTFS source directory before attempting any copy", () => {
    const api = native.loadWindowsCodingNative(); let pinned: native.WindowsCodingPin | undefined;
    try { pinned = api.pin(source, "read"); expect(api.info(pinned.handle).kind).toBe("directory"); }
    catch (error) {
      const cause = (error as { cause?: { operation?: unknown; status?: unknown } } | null)?.cause;
      const operation = typeof cause?.operation === "string" && /^[A-Za-z0-9 ()-]{1,64}$/.test(cause.operation) ? cause.operation : "unavailable";
      const status = typeof cause?.status === "number" && Number.isInteger(cause.status) ? `0x${(cause.status >>> 0).toString(16)}` : "unavailable";
      throw new Error(`Native directory bootstrap failed: operation=${operation}; status=${status}`, { cause: error });
    } finally { if (pinned) for (const handle of pinned.handles.slice().reverse()) api.close(handle); }
  });

  it("copies fresh NTFS identities, preserves the selected source, and exposes only structural /work results", async () => {
    const { workspace, broker } = await open(), api = native.loadWindowsCodingNative(), pinned = api.pin(source, "read");
    try {
      const folder = api.open(pinned.handle, "src", "directory", "source"), file = api.open(folder, "app.ts", "file", "source");
      try {
        const original = api.info(file), copied = await workspace.withTree(async tree => tree.entries.get("src/app.ts")!.info);
        expect(copied.volume).toBe(original.volume); expect(copied.id).not.toBe(original.id); expect(copied.links).toBe(1);
        expect(() => api.write(file, Buffer.from("forbidden"))).toThrow(ScopedCodingFileError);
        expect(() => api.remove(file)).toThrow(ScopedCodingFileError);
        expect(() => api.create(pinned.handle, "not-allowed", "file")).toThrow(ScopedCodingFileError);
      } finally { api.close(file); api.close(folder); }
    } finally { for (const handle of pinned.handles.slice().reverse()) api.close(handle); }
    const detail = await broker.readText("src/app.ts"); expect(detail.text).toBe(ORIGINAL); expect(detail.path).toBe("/work/src/app.ts");
    const listed = await broker.list(); expect(listed.entries.map(entry => entry.path)).toEqual(["/work/README.md", "/work/src"]);
    expect(JSON.stringify(listed)).not.toContain(root); expect(await broker.inspect(["src/app.ts", "missing.ts", "C:\\Windows\\win.ini"])).toEqual([
      { exists: true, real: "/work/src/app.ts" }, { exists: false, real: "/work/missing.ts" }, { exists: null, real: null },
    ]);
    expect(fs.readFileSync(path.join(source, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
  });

  it("keeps selected-source directory pins closed to delete sharing", () => {
    const api = native.loadWindowsCodingNative(), pinned = api.pin(source, "read"), moved = path.join(root, "moved-source");
    try {
      expect(() => fs.renameSync(source, moved)).toThrow();
      expect(fs.readFileSync(path.join(source, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
      expect(() => api.remove(pinned.handle)).toThrow(ScopedCodingFileError);
    } finally { for (const handle of pinned.handles.slice().reverse()) api.close(handle); }
    fs.renameSync(source, moved); fs.renameSync(moved, source); // Positive control: only the held pin forbids the actor's rename.
  });

  it("retains the private root identity and rejects a replacement namespace before admitting file tools", async () => {
    const workspace = await copy(), original = workspace.directory, moved = path.join(base, "moved-private-copy");
    let invoked = false, relocated = false, replacement = false;
    try {
      fs.renameSync(original, moved); relocated = true;
      fs.mkdirSync(original); replacement = true; fs.writeFileSync(path.join(original, "canary.txt"), "replacement-must-stay-untouched");
      await expect(workspace.withTree(async tree => { invoked = true; tree.api.create(tree.root, "must-not-exist.ts", "file"); })).rejects.toMatchObject({ code: "boundary" });
      expect(invoked).toBe(false); expect(fs.readdirSync(original)).toEqual(["canary.txt"]);
      expect(fs.readFileSync(path.join(original, "canary.txt"), "utf8")).toBe("replacement-must-stay-untouched");
    } finally {
      if (replacement) fs.rmSync(original, { recursive: true, force: true });
      if (relocated) fs.renameSync(moved, original);
    }
    expect(await workspace.withTree(async tree => tree.entries.size)).toBe(3);
    expect(fs.readFileSync(path.join(source, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("performs create, literal replacement, atomic overwrite, search, mkdir and exact deletion inside the copy", async () => {
    captureNativeRenameFailure();
    const { workspace, broker } = await open();
    const before = await broker.readText("src/app.ts");
    await expect(broker.writeText("src/app.ts", "bad", { expectedSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    expect((await broker.readText("src/app.ts")).text).toBe(ORIGINAL);
    const changed = await broker.replaceText("src/app.ts", "41", "42", { expectedSha256: before.sha256 }); expect(changed.replaced).toBe(1);
    expect((await broker.readText("src/app.ts")).text).toBe("export const answer = 42;\n");
    await expect(broker.replaceText("README.md", "line", "changed")).rejects.toMatchObject({ code: "ambiguous" });
    await broker.mkdir("tests"); await broker.writeText("tests/check.ts", "answer is 42\n", { createOnly: true });
    await expect(broker.writeText("tests/check.ts", "overwrite", { createOnly: true })).rejects.toMatchObject({ code: "exists" });
    expect((await broker.searchLiteral("42")).matches.map(match => match.path)).toEqual(["/work/src/app.ts", "/work/tests/check.ts"]);
    await expect(broker.delete("tests")).rejects.toMatchObject({ code: "not-empty" });
    await broker.delete("tests/check.ts"); await broker.delete("tests");
    expect(fs.readFileSync(path.join(source, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
    expect(fs.existsSync(path.join(source, "tests"))).toBe(false);
    expect(fs.readdirSync(workspace.directory).some(name => name.startsWith(".ember-windows-"))).toBe(false);
  });

  it("validates real atomic replacement while the old exact native target remains open, and rejects expired handle tokens", async () => {
    captureNativeRenameFailure();
    const workspace = await copy(); let stale: { api: native.WindowsCodingNative; handle: bigint } | undefined;
    await workspace.withTree(async tree => {
      const before = tree.entries.get("README.md")!, temporary = tree.api.create(tree.root, ".atomic-fixture.tmp", "file");
      try {
        tree.api.write(temporary, Buffer.from("replacement\n")); tree.api.flush(temporary);
        tree.api.replace(temporary, tree.root, "README.md", true);
        expect(tree.api.read(before.handle, 0, 128).toString()).toBe("public first line\nsecond line\n");
        expect(tree.api.read(temporary, 0, 128).toString()).toBe("replacement\n");
        expect(() => tree.api.write(temporary, Buffer.from("not a new temporary"))).toThrow(ScopedCodingFileError);
        stale = { api: tree.api, handle: before.handle };
      } finally { tree.api.close(temporary); }
    });
    expect(() => stale!.api.read(stale!.handle, 0, 1)).toThrow(ScopedCodingFileError);
    const broker = await WindowsScopedCodingFiles.create({ copy: workspace, signal: signal.signal }); brokers.push(broker);
    expect((await broker.readText("README.md")).text).toBe("replacement\n");
  });

  it("refuses real hardlinks, junction escapes and protected-root aliases without reading or writing protected bodies", async () => {
    fs.linkSync(path.join(protectedRoot, "auth.txt"), path.join(source, "linked.ts"));
    await expect(copy()).rejects.toBeInstanceOf(ScopedCodingFileError); fs.unlinkSync(path.join(source, "linked.ts"));
    fs.symlinkSync(protectedRoot, path.join(source, "outside"), "junction");
    await expect(copy()).rejects.toBeInstanceOf(ScopedCodingFileError); fs.unlinkSync(path.join(source, "outside"));
    await expect(WindowsCodingCopy.create({ source: protectedRoot, privateBase: base, protectedPaths: [protectedRoot], signal: signal.signal, current: () => true })).rejects.toMatchObject({ code: "boundary" });
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary"); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("allows fresh private storage beneath a protected app-data parent without exposing that parent as source", async () => {
    fs.writeFileSync(path.join(base, "auth-canary.txt"), "private-host-only");
    const workspace = await WindowsCodingCopy.create({ source, privateBase: base, protectedPaths: [base, protectedRoot], signal: signal.signal, current: () => current }); copies.push(workspace);
    const broker = await WindowsScopedCodingFiles.create({ copy: workspace, signal: signal.signal }); brokers.push(broker);
    expect((await broker.readText("src/app.ts")).text).toBe(ORIGINAL);
    expect((await broker.list()).entries.map(entry => entry.path)).toEqual(["/work/README.md", "/work/src"]);
    expect(fs.readFileSync(path.join(base, "auth-canary.txt"), "utf8")).toBe("private-host-only");
    await expect(WindowsCodingCopy.create({ source: base, privateBase: source, protectedPaths: [base, protectedRoot], signal: signal.signal, current: () => true })).rejects.toMatchObject({ code: "boundary" });
  });

  it("detects a real source replacement between native enumeration and open", async () => {
    const api = native.loadWindowsCodingNative(); let changed = false;
    vi.spyOn(native, "loadWindowsCodingNative").mockReturnValue({ ...api, list(handle, maximum) {
      const rows = api.list(handle, maximum);
      if (!changed && rows.some(entry => entry.name === "README.md")) {
        changed = true; fs.renameSync(path.join(source, "README.md"), path.join(source, "old-readme.txt")); fs.writeFileSync(path.join(source, "README.md"), "replacement actor\n");
      }
      return rows;
    } });
    await expect(copy()).rejects.toMatchObject({ code: "conflict" }); expect(changed).toBe(true); expect(fs.readdirSync(base)).toEqual([]);
    expect(fs.readFileSync(path.join(protectedRoot, "auth.txt"), "utf8")).toBe("protected-host-canary");
  });

  it("fails capture when an actual preexisting writable source handle prevents an immutable read", async () => {
    const writer = fs.openSync(path.join(source, "README.md"), "r+");
    try { await expect(copy()).rejects.toMatchObject({ code: "conflict" }); }
    finally { fs.closeSync(writer); }
    expect(fs.readFileSync(path.join(source, "README.md"), "utf8")).toBe("public first line\nsecond line\n"); expect(fs.readdirSync(base)).toEqual([]);
  });

  it("scans full text before copying, ranges, replacement or search and never returns a recognized secret", async () => {
    fs.writeFileSync(path.join(source, "notes.ts"), "safe\n"); const { workspace, broker } = await open();
    fs.writeFileSync(path.join(workspace.directory, "notes.ts"), "public line\n" + "x".repeat(200_000) + "\n" + SECRET + "\n");
    await expect(broker.readText("notes.ts", { startLine: 1, endLine: 1 })).rejects.toMatchObject({ code: "secret" });
    await expect(broker.writeText("src/new.ts", `value=${SECRET}\n`)).rejects.toMatchObject({ code: "secret" });
    await expect(broker.replaceText("notes.ts", "public", "edited")).rejects.toMatchObject({ code: "secret" });
    const result = await broker.searchLiteral("public"); expect(result.withheld.secrets).toBe(1); expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(source, "notes.ts"), "utf8")).toBe("safe\n");
  }, 45_000);

  it("refuses credential-named and full-text secret source trees instead of silently omitting them", async () => {
    fs.writeFileSync(path.join(source, ".env"), "innocent bytes\n"); await expect(copy()).rejects.toMatchObject({ code: "secret" }); fs.unlinkSync(path.join(source, ".env"));
    fs.writeFileSync(path.join(source, "ordinary.ts"), "first safe line\n" + "x".repeat(100_000) + "\n" + SECRET); await expect(copy()).rejects.toMatchObject({ code: "secret" });
    expect(fs.readdirSync(base)).toEqual([]);
  }, 45_000);

  it.each(["../escape.ts", "/outside.ts", "C:\\Windows\\win.ini", "src/app.ts:token", "CON.txt", "COM¹", "src/trailing.", "src//bad.ts", "src/../bad.ts"])("refuses ambiguous or foreign logical paths: %s", async requested => {
    const { broker } = await open(); await expect(broker.writeText(requested, "safe")).rejects.toBeInstanceOf(ScopedCodingFileError);
  });

  it("refuses portable case aliases and explicit size/tree limits", async () => {
    const { broker } = await open(); await expect(broker.writeText("SRC/app.ts", "wrong alias")).rejects.toMatchObject({ code: "unsupported" });
    await expect(broker.mkdir("Src")).rejects.toMatchObject({ code: "unsupported" });
    await expect(broker.readText("SRC/app.ts")).rejects.toMatchObject({ code: "missing" });
    await expect(copy({ entries: 1 })).rejects.toMatchObject({ code: "limit" });
    await expect(copy({ fileBytes: 4 })).rejects.toMatchObject({ code: "limit" });
  });

  it("removes only its own bounded partial snapshot after depth, entry, file or total-size refusal", async () => {
    for (const limits of [{ depth: 1 }, { entries: 1 }, { fileBytes: 4 }, { workspaceBytes: 4 }]) {
      await expect(copy(limits)).rejects.toMatchObject({ code: "limit" }); expect(fs.readdirSync(base)).toEqual([]);
    }
    expect(fs.readFileSync(path.join(source, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("revokes queued operations synchronously on Stop, drains the existing lease, and never revives after current false→true", async () => {
    const { workspace, broker } = await open(), entered = deferred<void>(), release = deferred<void>();
    const held = workspace.files(async () => { entered.resolve(); await release.promise; }).catch(error => error); await entered.promise;
    const writing = broker.writeText("README.md", "must not commit\n").catch(error => error), stopped = workspace.stop(); let settled = false; void stopped.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); release.resolve(); await held; expect(await writing).toMatchObject({ code: "cancelled" }); await stopped;
    current = false; expect(workspace.admitted()).toBe(false); current = true;
    await expect(broker.readText("README.md")).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.readFileSync(path.join(workspace.directory, "README.md"), "utf8")).toBe("public first line\nsecond line\n");
  });

  it("refuses a detached callback carrying an expired native file-lease context", async () => {
    const workspace = await copy(), release = deferred<void>(); let detached!: Promise<unknown>;
    await workspace.files(async () => {
      detached = (async () => { await release.promise; return workspace.withTree(async tree => tree.entries.size); })().catch(error => error);
    });
    release.resolve(); expect(await detached).toMatchObject({ code: "cancelled" });
    expect(await workspace.withTree(async tree => tree.entries.size)).toBe(3);
  });

  it("drains an admitted native tree audit when closing the broker", async () => {
    const { workspace, broker } = await open(), entered = deferred<void>(), release = deferred<void>(), privacyClosed = deferred<void>();
    const originalClose = CodingPrivacyScanner.prototype.close;
    vi.spyOn(CodingPrivacyScanner.prototype, "close").mockImplementation(async function (this: CodingPrivacyScanner) {
      await originalClose.call(this); privacyClosed.resolve();
    });
    const originalTree = workspace.withTree.bind(workspace);
    vi.spyOn(workspace, "withTree").mockImplementation(operation => originalTree(async tree => { entered.resolve(); await release.promise; return operation(tree); }));
    const reading = broker.readText("README.md").catch(error => error); await entered.promise;
    const closing = broker.close(); let settled = false;
    void closing.then(() => { settled = true; }); await privacyClosed.promise; expect(settled).toBe(false);
    release.resolve(); expect(await reading).toMatchObject({ code: "cancelled" }); await closing;
    expect(await originalTree(async tree => tree.entries.size)).toBe(3);
  });

  it("closes before an unrelated queued lease and rejects that callback before opening native handles", async () => {
    const { workspace, broker } = await open(), entered = deferred<void>(), release = deferred<void>();
    const held = workspace.files(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const reading = broker.readText("README.md").catch(error => error); await broker.close();
    release.resolve(); await held; expect(await reading).toMatchObject({ code: "cancelled" });
    expect(await workspace.withTree(async tree => tree.entries.size)).toBe(3);
  });

  it("never erases native hidden attributes during source capture or bypasses them through direct file tools", async () => {
    const attrib = path.join(process.env.SystemRoot!, "System32", "attrib.exe"), original = path.join(source, "README.md");
    execFileSync(attrib, ["+H", original], { timeout: 10_000, windowsHide: true });
    try { await expect(copy()).rejects.toMatchObject({ code: "privacy" }); expect(fs.readdirSync(base)).toEqual([]); }
    finally { execFileSync(attrib, ["-H", original], { timeout: 10_000, windowsHide: true }); }
    const { workspace, broker } = await open(), copied = path.join(workspace.directory, "README.md");
    execFileSync(attrib, ["+H", copied], { timeout: 10_000, windowsHide: true });
    try {
      expect((await broker.list()).withheld.hidden).toBe(1);
      await expect(broker.readText("README.md")).rejects.toMatchObject({ code: "privacy" });
      await expect(broker.writeText("README.md", "must not overwrite")).rejects.toMatchObject({ code: "privacy" });
      expect(await broker.inspect(["README.md"])).toEqual([{ exists: null, real: null }]);
    } finally { execFileSync(attrib, ["-H", copied], { timeout: 10_000, windowsHide: true }); }
  });

  it("cancels real capture between native chunks and cleans its own fresh partial copy", async () => {
    fs.writeFileSync(path.join(source, "large.ts"), "x".repeat(2 * 1024 * 1024));
    const pending = copy().catch(error => error); setImmediate(() => signal.abort()); expect(await pending).toMatchObject({ code: "cancelled" });
    expect(fs.readdirSync(base)).toEqual([]); expect(fs.statSync(path.join(source, "large.ts")).size).toBe(2 * 1024 * 1024);
  }, 45_000);

  it("rejects widened copy ACLs and allows safe cleanup only after the synthetic tamper is restored", async () => {
    const { workspace, broker } = await open(), target = path.join(workspace.directory, "README.md"), icacls = path.join(process.env.SystemRoot!, "System32", "icacls.exe");
    execFileSync(icacls, [target, "/grant", "*S-1-1-0:(R)"], { timeout: 10_000, windowsHide: true });
    try { await expect(broker.readText("README.md")).rejects.toMatchObject({ code: "boundary" }); }
    finally { execFileSync(icacls, [target, "/remove:g", "*S-1-1-0"], { timeout: 10_000, windowsHide: true }); }
    expect((await broker.readText("README.md")).text).toBe("public first line\nsecond line\n");
  });

  it("revokes even metadata/native-file leases across global privacy retirement and retains terminal close completion", async () => {
    const { workspace, broker } = await open(); await retireCodingPrivacyScanners();
    await expect(broker.list()).rejects.toMatchObject({ code: "cancelled" });
    const closing = workspace.close(); expect(workspace.close()).toBe(closing); await closing;
    await expect(workspace.files(async () => true)).rejects.toMatchObject({ code: "cancelled" });
  });
});
