/** Native Windows file tools for one fresh private copy. Not registered as a production coding adapter. */
import { createHash, randomUUID } from "node:crypto";
import { HOST_PLATFORM } from "../platform/os";
import type { PathFact } from "../commands/types";
import { CodingPrivacyScanner } from "./coding-privacy-scanner";
import { ScopedCodingFileError, type CodingFileBroker, type ScopedCodingWorkspace, type ScopedCodingFileLimits,
  type ScopedCodingListResult, type ScopedCodingTextResult, type ScopedCodingWriteResult, type ScopedCodingSearchResult } from "./coding-platform";
import { WindowsCodingCopy, readWindowsCodingFile, type WindowsCodingTree, type WindowsCodingTreeEntry } from "./windows-coding-copy";
import { windowsCodingLimits, windowsCodingRelative, windowsCodingVirtual, windowsCodingFold, windowsCodingPrivacy, windowsCodingSame, windowsCodingSafeError, windowsCodingExcludedRoot } from "./windows-coding-policy";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const withheld = () => ({ hidden: 0, sensitive: 0, unsupported: 0, binary: 0, secrets: 0 });
export interface WindowsScopedCodingFilesInput {
  copy: WindowsCodingCopy; signal: AbortSignal; current?(): boolean; limits?: Partial<ScopedCodingFileLimits>;
  /** A future command backend supplies its proven stopped-writer lease here; the copy's own lease is also held. */
  workspace?: ScopedCodingWorkspace;
}
export class WindowsScopedCodingFiles implements CodingFileBroker {
  #copy: WindowsCodingCopy; #files: ScopedCodingWorkspace["files"]; #signal: AbortSignal; #inputCurrent?: () => boolean;
  #limits: Readonly<ScopedCodingFileLimits>; #privacy: CodingPrivacyScanner; #closed = false; #revoked = false;
  #closing: Promise<void> | null = null; #active = 0; #idle: (() => void)[] = []; #abort: () => void;
  private constructor(options: WindowsScopedCodingFilesInput, limits: Readonly<ScopedCodingFileLimits>) {
    this.#copy = options.copy; this.#files = (options.workspace ?? options.copy).files.bind(options.workspace ?? options.copy);
    this.#signal = AbortSignal.any([options.signal, options.copy.signal]); this.#inputCurrent = options.current?.bind(options);
    this.#limits = limits; this.#privacy = this.#copy.createPrivacyScanner(this.#signal);
    this.#abort = () => { void this.close().catch(() => undefined); };
    this.#signal.addEventListener("abort", this.#abort, { once: true });
  }
  static async create(options: WindowsScopedCodingFilesInput): Promise<WindowsScopedCodingFiles> {
    if (HOST_PLATFORM !== "win32" || !options || !(options.copy instanceof WindowsCodingCopy) || !(options.signal instanceof AbortSignal) ||
        options.current !== undefined && typeof options.current !== "function") throw new ScopedCodingFileError("unavailable");
    const limits = windowsCodingLimits({ ...options.copy.limits, ...options.limits });
    if (Object.entries(limits).some(([name, value]) => value > options.copy.limits[name as keyof ScopedCodingFileLimits])) throw new ScopedCodingFileError("limit");
    let broker: WindowsScopedCodingFiles | undefined;
    try { broker = new WindowsScopedCodingFiles(options, limits); await broker.#lease(async () => null); broker.#guard(); return broker; }
    catch (error) { if (broker) await broker.close(); throw windowsCodingSafeError(error); }
  }
  #admitted = (): boolean => {
    if (this.#closed || this.#revoked || this.#signal.aborted || !this.#copy.admitted()) return false;
    try { if (!this.#inputCurrent || this.#inputCurrent() === true) return true; } catch { /* Unknown host authority is revoked. */ }
    this.#revoked = true; return false;
  };
  #guard = (): void => { this.#copy.assertCurrent(); if (!this.#admitted()) throw new ScopedCodingFileError("cancelled"); };
  #result<T>(value: T): T { if (Buffer.byteLength(JSON.stringify(value)) > this.#limits.resultBytes) throw new ScopedCodingFileError("limit"); return value; }
  async #lease<T>(operation: (tree: WindowsCodingTree) => Promise<T>): Promise<T> {
    this.#guard();
    try {
      return await this.#files(async root => {
        this.#guard(); if (root !== this.#copy.directory) throw new ScopedCodingFileError("boundary");
        this.#active++;
        try { return await this.#copy.withTree(async tree => {
          this.#guard();
            if (tree.entries.size > this.#limits.entries || [...tree.entries.values()].some(entry => entry.path.split("/").length > this.#limits.depth || entry.info.kind === "file" && entry.info.size > this.#limits.fileBytes) ||
                [...tree.entries.values()].reduce((n, entry) => n + (entry.info.kind === "file" ? entry.info.size : 0), 0) > this.#limits.workspaceBytes) throw new ScopedCodingFileError("limit");
            const result = await operation(tree); tree.check(); this.#guard(); return this.#result(result);
        }); } finally { if (--this.#active === 0) for (const done of this.#idle.splice(0)) done(); }
      });
    } catch (error) { throw windowsCodingSafeError(error); }
  }
  #isExcluded(relative: string): boolean { return windowsCodingExcludedRoot(relative, this.#copy.excludedRoots) !== undefined; }
  #allow(relative: string, directory = false): void { if (this.#isExcluded(relative) || windowsCodingPrivacy(relative, directory)) throw new ScopedCodingFileError("privacy"); }
  #privacyProblem(entry: WindowsCodingTreeEntry, tree: WindowsCodingTree): "hidden" | "sensitive" | "unsupported" | null {
    if (this.#isExcluded(entry.path)) return "unsupported";
    const parts = entry.path.split("/");
    for (let index = 1; index <= parts.length; index++) if ((tree.entries.get(parts.slice(0, index).join("/"))?.info.attributes ?? 0) & 0x6) return "hidden";
    return windowsCodingPrivacy(entry.path, entry.info.kind === "directory");
  }
  #entry(relative: string, tree: WindowsCodingTree): WindowsCodingTreeEntry {
    if (this.#isExcluded(relative)) throw new ScopedCodingFileError("privacy");
    const entry = tree.entries.get(relative); if (!entry) throw new ScopedCodingFileError("missing");
    if (this.#privacyProblem(entry, tree)) throw new ScopedCodingFileError("privacy"); return entry;
  }
  #parent(relative: string, tree: WindowsCodingTree): { directory: bigint; name: string } {
    const parts = relative.split("/"), name = parts.pop()!, parent = parts.join("/");
    if (!parent) return { directory: tree.root, name };
    const entry = this.#entry(parent, tree); if (entry.info.kind !== "directory") throw new ScopedCodingFileError("missing");
    if (!windowsCodingSame(entry.info, tree.api.info(entry.handle))) throw new ScopedCodingFileError("conflict");
    return { directory: entry.handle, name };
  }
  #newPath(relative: string, tree: WindowsCodingTree): void {
    if (relative.split("/").length > this.#limits.depth || !tree.entries.has(relative) && tree.entries.size >= this.#limits.entries) throw new ScopedCodingFileError("limit");
    if ([...tree.entries.keys()].some(name => windowsCodingFold(name) === windowsCodingFold(relative) && name !== relative)) throw new ScopedCodingFileError("unsupported");
  }
  async #scan(text: string): Promise<void> { this.#guard(); const refused = await this.#privacy.refusal(text.replace(/^\ufeff/, ""), { signal: this.#signal, current: this.#admitted }); this.#guard(); if (refused) throw new ScopedCodingFileError("secret"); }
  async #text(entry: WindowsCodingTreeEntry, tree: WindowsCodingTree): Promise<{ text: string; bytes: Buffer; sha256: string }> {
    if (this.#privacyProblem(entry, tree)) throw new ScopedCodingFileError("privacy"); if (entry.info.kind !== "file") throw new ScopedCodingFileError("unsupported");
    const bytes = await readWindowsCodingFile(tree.api, entry.handle, entry.info, this.#limits.fileBytes, () => { tree.check(); this.#guard(); });
    let text: string; try { text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ScopedCodingFileError("binary"); }
    if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, ""))) throw new ScopedCodingFileError("binary");
    await this.#scan(text); this.#guard(); if (!windowsCodingSame(entry.info, tree.api.info(entry.handle))) throw new ScopedCodingFileError("conflict");
    return { text, bytes, sha256: digest(bytes) };
  }
  list(path = "/work"): Promise<ScopedCodingListResult> {
    return this.#lease(async tree => {
      const relative = windowsCodingRelative(path); if (relative && this.#entry(relative, tree).info.kind !== "directory") throw new ScopedCodingFileError("unsupported");
      const result: ScopedCodingListResult = { path: windowsCodingVirtual(relative), scope: "direct-children", entries: [], withheld: withheld(),
        ...(this.#copy.excludedRoots.length ? { excludedRoots: [...this.#copy.excludedRoots] } : {}) };
      for (const entry of [...tree.entries.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
        if (entry.path.split("/").slice(0, -1).join("/") !== relative) continue;
        const why = this.#privacyProblem(entry, tree);
        if (why) result.withheld[why]++; else result.entries.push({ path: windowsCodingVirtual(entry.path), kind: entry.info.kind, ...(entry.info.kind === "file" ? { bytes: entry.info.size } : {}) });
      }
      return result;
    });
  }
  readText(path: string, range: { startLine?: number; endLine?: number } = {}): Promise<ScopedCodingTextResult> {
    range = { ...range };
    return this.#lease(async tree => {
      if (Object.keys(range).some(key => key !== "startLine" && key !== "endLine")) throw new ScopedCodingFileError("path");
      const relative = windowsCodingRelative(path, false), file = await this.#text(this.#entry(relative, tree), tree), lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const start = range.startLine ?? 1, end = range.endLine ?? lines.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > lines.length || (lines.length ? end < start : start !== 1 || end !== 0)) throw new ScopedCodingFileError("path");
      return { path: windowsCodingVirtual(relative), text: lines.slice(start - 1, end).join(""), sha256: file.sha256, bytes: file.bytes.length, totalLines: lines.length, startLine: start, endLine: end };
    });
  }
  writeText(path: string, text: string, options: { createOnly?: boolean; expectedSha256?: string } = {}): Promise<ScopedCodingWriteResult> {
    const captured = { ...options }; return this.#lease(tree => this.#write(windowsCodingRelative(path, false), text, captured, tree));
  }
  replaceText(path: string, oldText: string, newText: string, options: { expectedSha256?: string } = {}): Promise<ScopedCodingWriteResult & { replaced: 1 }> {
    options = { ...options };
    return this.#lease(async tree => {
      const relative = windowsCodingRelative(path, false), before = await this.#text(this.#entry(relative, tree), tree);
      if (typeof oldText !== "string" || typeof newText !== "string" || !oldText || oldText.length > this.#limits.fileBytes || newText.length > this.#limits.fileBytes ||
          before.text.indexOf(oldText) < 0 || before.text.indexOf(oldText) !== before.text.lastIndexOf(oldText)) throw new ScopedCodingFileError("ambiguous");
      return { ...await this.#write(relative, before.text.replace(oldText, () => newText), { ...options, expectedSha256: options.expectedSha256 ?? before.sha256 }, tree), replaced: 1 };
    });
  }
  async #write(relative: string, text: string, options: { createOnly?: boolean; expectedSha256?: string }, tree: WindowsCodingTree): Promise<ScopedCodingWriteResult> {
    this.#allow(relative); this.#newPath(relative, tree);
    if (Object.keys(options).some(key => key !== "createOnly" && key !== "expectedSha256") || options.createOnly !== undefined && typeof options.createOnly !== "boolean" ||
        options.expectedSha256 !== undefined && (typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(options.expectedSha256))) throw new ScopedCodingFileError("path");
    if (typeof text !== "string" || Buffer.byteLength(text) > this.#limits.fileBytes || Buffer.from(text).toString("utf8") !== text) throw new ScopedCodingFileError("limit");
    if (/[\p{Cc}]/u.test(text.replace(/[\t\r\n]/g, ""))) throw new ScopedCodingFileError("binary"); await this.#scan(text);
    const existing = tree.entries.get(relative), bytes = Buffer.from(text);
    if (existing) { if (options.createOnly) throw new ScopedCodingFileError("exists"); const before = await this.#text(existing, tree); if (options.expectedSha256 !== undefined && options.expectedSha256 !== before.sha256) throw new ScopedCodingFileError("conflict"); }
    else if (options.expectedSha256 !== undefined) throw new ScopedCodingFileError("conflict");
    if ([...tree.entries.values()].reduce((n, entry) => n + (entry.info.kind === "file" ? entry.info.size : 0), 0) - (existing?.info.size ?? 0) + bytes.length > this.#limits.workspaceBytes) throw new ScopedCodingFileError("limit");
    const result = this.#result({ path: windowsCodingVirtual(relative), bytes: bytes.length, sha256: digest(bytes), created: !existing }), parent = this.#parent(relative, tree);
    let temp: bigint | undefined, committed = false;
    try {
      this.#guard(); tree.check(); temp = tree.api.create(parent.directory, `.ember-windows-${randomUUID()}.tmp`, "file"); tree.api.assertPrivate(temp);
      tree.api.write(temp, bytes); tree.api.flush(temp);
      const info = tree.api.info(temp), verified = await readWindowsCodingFile(tree.api, temp, info, this.#limits.fileBytes, () => { tree.check(); this.#guard(); });
      if (digest(verified) !== result.sha256 || existing && !windowsCodingSame(existing.info, tree.api.info(existing.handle))) throw new ScopedCodingFileError("conflict");
      this.#guard(); tree.check(); tree.api.replace(temp, parent.directory, parent.name, !!existing); committed = true; tree.noteMutationApplied();
      if (tree.api.info(temp).size !== bytes.length) throw new ScopedCodingFileError("conflict"); return result;
    } finally { if (temp !== undefined) { try { if (!committed) tree.api.remove(temp); } finally { tree.api.close(temp); } } }
  }
  delete(path: string): Promise<{ path: string; kind: "file" | "directory"; deleted: true }> {
    return this.#lease(async tree => {
      const relative = windowsCodingRelative(path, false), entry = this.#entry(relative, tree);
      if (entry.info.kind === "file") await this.#text(entry, tree); else if ([...tree.entries.keys()].some(name => name.startsWith(relative + "/"))) throw new ScopedCodingFileError("not-empty");
      const result = this.#result({ path: windowsCodingVirtual(relative), kind: entry.info.kind, deleted: true as const });
      this.#guard(); tree.check(); if (!windowsCodingSame(entry.info, tree.api.info(entry.handle))) throw new ScopedCodingFileError("conflict");
      tree.api.remove(entry.handle); tree.noteMutationApplied(); tree.release(entry.handle); return result;
    });
  }
  mkdir(path: string): Promise<{ path: string; created: true }> {
    return this.#lease(async tree => {
      const relative = windowsCodingRelative(path, false); this.#allow(relative, true); this.#newPath(relative, tree); if (tree.entries.has(relative)) throw new ScopedCodingFileError("exists");
      const result = this.#result({ path: windowsCodingVirtual(relative), created: true as const }), parent = this.#parent(relative, tree);
      this.#guard(); tree.check(); const directory = tree.api.create(parent.directory, parent.name, "directory"); tree.noteMutationApplied();
      try { tree.api.assertPrivate(directory); return result; } finally { tree.api.close(directory); }
    });
  }
  inspect(paths: readonly string[], cwd = "/work"): Promise<PathFact[]> {
    const captured = Array.isArray(paths) ? [...paths] : [];
    return this.#lease(async tree => {
      if (!Array.isArray(paths) || captured.length > 200) throw new ScopedCodingFileError("limit");
      const folder = windowsCodingRelative(cwd); if (folder && tree.entries.get(folder)?.info.kind !== "directory") throw new ScopedCodingFileError("path");
      return captured.map(value => {
        const unknown: PathFact = { exists: null, real: null };
        try {
          if (typeof value !== "string" || !value) return unknown;
          const relative = windowsCodingRelative(value.startsWith("/") ? value : folder ? `${folder}/${value}` : value);
          if (this.#isExcluded(relative)) return unknown;
          if (!relative) return { exists: true, real: "/work", dir: true };
          const entry = tree.entries.get(relative); if (entry) return this.#privacyProblem(entry, tree) ? unknown : { exists: true, real: windowsCodingVirtual(relative), ...(entry.info.kind === "directory" ? { dir: true } : {}) };
          for (let i = 1, parts = relative.split("/"); i < parts.length; i++) if (tree.entries.get(parts.slice(0, i).join("/"))?.info.kind === "file") return unknown;
          return { exists: false, real: windowsCodingVirtual(relative) };
        } catch { return unknown; }
      });
    });
  }
  searchLiteral(query: string, path = "/work"): Promise<ScopedCodingSearchResult> {
    return this.#lease(async tree => {
      if (typeof query !== "string" || !query || Buffer.byteLength(query) > 1024 || /[\r\n\0]/.test(query)) throw new ScopedCodingFileError("path"); await this.#scan(query);
      const relative = windowsCodingRelative(path), selected = relative ? this.#entry(relative, tree) : null;
      const result: ScopedCodingSearchResult = { path: windowsCodingVirtual(relative), matches: [], files: 0, withheld: withheld(),
        ...(this.#copy.excludedRoots.length ? { excludedRoots: [...this.#copy.excludedRoots] } : {}) };
      for (const entry of [...tree.entries.values()].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
        if (entry.info.kind !== "file" || relative && entry.path !== relative && (selected?.info.kind !== "directory" || !entry.path.startsWith(relative + "/"))) continue;
        const why = this.#privacyProblem(entry, tree); if (why) { result.withheld[why]++; continue; }
        let file: { text: string };
        try { file = await this.#text(entry, tree); } catch (error) { if (error instanceof ScopedCodingFileError && (error.code === "secret" || error.code === "binary")) { result.withheld[error.code === "secret" ? "secrets" : "binary"]++; continue; } throw error; }
        result.files++;
        for (const [line, text] of file.text.split("\n").entries()) if (text.includes(query)) { if (result.matches.length >= this.#limits.searchMatches) throw new ScopedCodingFileError("limit"); result.matches.push({ path: windowsCodingVirtual(entry.path), line: line + 1, text }); this.#result(result); }
      }
      return result;
    });
  }
  close(): Promise<void> {
    this.#closed = true; this.#signal.removeEventListener("abort", this.#abort);
    this.#closing ??= (async () => {
      let problem: unknown; try { await this.#privacy.close(); } catch (error) { problem = error; }
      if (this.#active) await new Promise<void>(resolve => this.#idle.push(resolve));
      if (problem) throw problem;
    })();
    return this.#closing;
  }
}
