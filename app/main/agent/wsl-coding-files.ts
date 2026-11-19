/** Remote file tools over the owned helper; every reply remains bounded logical /work data. */
import { z } from "zod";
import { WslCodingConnection } from "./wsl-coding-connection";
import type { CodingFileBroker } from "./coding-platform";
import { ScopedCodingFileError } from "./coding-platform";
import type { WslCodingMethod } from "./wsl-coding-protocol";

const logical = z.string().max(4096).refine(p => (p === "/work" || p.startsWith("/work/")) && !/[\\\p{Cc}\p{Cf}]/u.test(p) && p.split("/").slice(1).every(p => p && p !== "." && p !== ".."));
const number = z.number().int().min(0).max(100 * 1024 * 1024), hash = z.string().regex(/^[0-9a-f]{64}$/);
const withheld = z.object({ hidden: number, sensitive: number, unsupported: number, binary: number, secrets: number }).strict();
const write = z.object({ path: logical, bytes: number, sha256: hash, created: z.boolean() }).strict();
const list = z.object({ path: logical, scope: z.literal("direct-children"), entries: z.array(z.object({ path: logical, kind: z.enum(["file", "directory"]), bytes: number.optional() }).strict()).max(10_000),
  withheld, excludedRoots: z.array(z.enum([".git", "node_modules"])).max(2).optional() }).strict();
const read = z.object({ path: logical, text: z.string().max(256 * 1024), sha256: hash, bytes: number, totalLines: number, startLine: number, endLine: number }).strict();
const search = z.object({ path: logical, matches: z.array(z.object({ path: logical, line: number, text: z.string().max(256 * 1024) }).strict()).max(1000), files: number, withheld,
  excludedRoots: z.array(z.enum([".git", "node_modules"])).max(2).optional() }).strict();
const facts = z.array(z.object({ exists: z.boolean().nullable(), real: logical.nullable(), dir: z.boolean().optional() }).strict()).max(64);

export class WslCodingFiles implements CodingFileBroker {
  #connection: WslCodingConnection; #current: () => boolean; #closed = false; #closing?: Promise<void>;
  constructor(connection: WslCodingConnection, current: () => boolean) { this.#connection = connection; this.#current = current; }
  #check(): void {
    let current = false; try { current = this.#current() === true; } catch { /* A lost owner carries no file authority. */ }
    if (this.#closed || !current) { this.#closed = true; throw new ScopedCodingFileError("cancelled"); }
  }
  async #call<T>(method: WslCodingMethod, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    this.#check(); const value = await this.#connection.call(method, params); this.#check();
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new ScopedCodingFileError("limit");
    try { return schema.parse(value); } catch { throw new ScopedCodingFileError("boundary"); }
  }
  list(path?: string) { return this.#call("list", { ...(path !== undefined ? { path } : {}) }, list); }
  readText(path: string, range?: { startLine?: number; endLine?: number }) { return this.#call("readText", { path, ...(range ? { range } : {}) }, read); }
  writeText(path: string, text: string, options?: { createOnly?: boolean; expectedSha256?: string }) { return this.#call("writeText", { path, text, ...(options ? { options } : {}) }, write); }
  replaceText(path: string, oldText: string, newText: string, options?: { expectedSha256?: string }) {
    return this.#call("replaceText", { path, oldText, newText, ...(options ? { options } : {}) }, write.extend({ replaced: z.literal(1) }));
  }
  delete(path: string) { return this.#call("delete", { path }, z.object({ path: logical, kind: z.enum(["file", "directory"]), deleted: z.literal(true) }).strict()); }
  mkdir(path: string) { return this.#call("mkdir", { path }, z.object({ path: logical, created: z.literal(true) }).strict()); }
  searchLiteral(query: string, path?: string) { return this.#call("searchLiteral", { query, ...(path !== undefined ? { path } : {}) }, search); }
  async inspect(paths: readonly string[], cwd = "/work") {
    const found = await this.#call("inspect", { paths: [...paths], cwd }, facts); if (found.length !== paths.length) throw new ScopedCodingFileError("boundary"); return found;
  }
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#connection.call("sealFiles").then(value => {
      if (!value || typeof value !== "object" || Object.keys(value).join(",") !== "sealed" || (value as { sealed?: unknown }).sealed !== true) throw new ScopedCodingFileError("boundary");
    }); return this.#closing;
  }
}
