/** Public npm preparation plans are host-issued data capabilities, never URLs or versions chosen by a fetch tool. */
import { createHash } from "node:crypto";
import { parseBoundedCodingJson } from "./coding-bounded-json";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org" as const;
export const PUBLIC_NPM_LIMITS = Object.freeze({ packageJsonBytes: 256 * 1024, lockBytes: 2 * 1024 * 1024, packages: 512,
  archiveBytes: 16 * 1024 * 1024, compressedBytes: 64 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, entries: 50_000, depth: 64 });
export class PublicNpmPreparationError extends Error {
  constructor() { super("Public dependency preparation requires a supported public npm lockfile and current permission."); this.name = "PublicNpmPreparationError"; }
}
export interface PublicNpmPreparationRequest {
  readonly kind: "baseline" | "changed";
  readonly registry: typeof PUBLIC_NPM_REGISTRY;
  readonly packageJsonSha256: string;
  readonly lockSha256: string;
  readonly setSha256: string;
  readonly packages: readonly Readonly<{ name: string; version: string }>[];
  readonly packageCount: number;
  readonly compressedByteLimit: number;
}
export type PublicNpmPreparationAuthorize = (request: Readonly<PublicNpmPreparationRequest>, signal: AbortSignal) => Promise<boolean>;
export interface PublicNpmPreparationResult { readonly prepared: true; readonly packages: number; readonly lockSha256: string; readonly setSha256: string }
export interface PublicNpmWorkspace { readonly path: string; readonly name: string; readonly version: string }
export interface PublicNpmPackage { readonly name: string; readonly version: string; readonly resolved: string; readonly integrity: string }
export interface PublicNpmInputs { readonly packageJson: Buffer; readonly packageLock: Buffer }
type Plan = { summary: Omit<PublicNpmPreparationRequest, "kind">; packages: readonly PublicNpmPackage[]; workspaces: readonly PublicNpmWorkspace[] };
const plans = new WeakMap<object, Plan>();
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const bad = () => new PublicNpmPreparationError();
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw bad(); return value as Record<string, unknown>; };
const string = (value: unknown, max = 4096): string => { if (typeof value !== "string" || !value || Buffer.byteLength(value) > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw bad(); return value; };
const name = (value: unknown): string => {
  const result = string(value, 214); if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(result)) throw bad(); return result;
};
const version = (value: unknown): string => {
  const result = string(value, 128);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(result)) throw bad(); return result;
};
/** Canonical single SHA-512 only. A digest list, different algorithm or permissive base64 is not a receipt. */
export function publicNpmIntegrity(value: unknown): string {
  const result = string(value, 96);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(result)) throw bad();
  const bytes = Buffer.from(result.slice(7), "base64"); if (bytes.length !== 64 || bytes.toString("base64") !== result.slice(7)) throw bad(); return result;
}
/** Registry identity includes the exact package/version path; no redirect, auth, query, fragment or alternate port. */
export function publicNpmUrl(value: unknown, packageName: string, packageVersion: string): string {
  const result = string(value, 2048), basename = packageName.split("/").at(-1)!;
  if (result !== `${PUBLIC_NPM_REGISTRY}/${packageName}/-/${basename}-${packageVersion}.tgz`) throw bad();
  const url = new URL(result);
  if (url.origin !== PUBLIC_NPM_REGISTRY || url.username || url.password || url.port || url.search || url.hash || url.href !== result) throw bad(); return result;
}
/** Reused at the final network boundary, even for a trusted caller that already holds a parsed plan. */
export function publicNpmPackageIdentity(input: PublicNpmPackage): PublicNpmPackage {
  const actualName = name(input.name), actualVersion = version(input.version);
  return Object.freeze({ name: actualName, version: actualVersion, resolved: publicNpmUrl(input.resolved, actualName, actualVersion), integrity: publicNpmIntegrity(input.integrity) });
}
function relative(value: unknown): string {
  const result = string(value);
  if (result !== result.normalize("NFC") || /[\\:<>"|?*]/u.test(result) || result.split("/").length > PUBLIC_NPM_LIMITS.depth ||
      result.split("/").some(part => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255 || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw bad();
  return result;
}
function json(input: Buffer, maximum: number): Record<string, unknown> {
  if (!Buffer.isBuffer(input) || input.length < 2 || input.length > maximum || typeof SharedArrayBuffer !== "undefined" && input.buffer instanceof SharedArrayBuffer) throw bad();
  const owned = Buffer.from(input), text = owned.toString("utf8"); if (!Buffer.from(text).equals(owned)) throw bad();
  return record(parseBoundedCodingJson(text, { depth: 64, containers: 128_000, keyBytes: 4096 }));
}
function platform(value: unknown, target: string): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 16 || value.some(v => typeof v !== "string" || !/^!?[a-z0-9_-]{1,32}$/.test(v))) throw bad();
  if (value.includes("!" + target)) return false; const positive = value.filter(v => !v.startsWith("!")); return !positive.length || positive.includes(target) || positive.includes("any");
}
function workspacePatterns(root: Record<string, unknown>): string[] {
  if (root.workspaces === undefined) return [];
  const value = Array.isArray(root.workspaces) ? root.workspaces : record(root.workspaces).packages;
  if (!Array.isArray(value) || value.length > 128) throw bad();
  return value.map(item => {
    const pattern = string(item); if (pattern.endsWith("/*")) relative(pattern.slice(0, -2)); else relative(pattern);
    if (pattern.includes("node_modules") || pattern.includes(".git")) throw bad(); return pattern;
  });
}
const matchesWorkspace = (value: string, patterns: string[]) => patterns.some(pattern => pattern.endsWith("/*")
  ? value.startsWith(pattern.slice(0, -1)) && !value.slice(pattern.length - 1).includes("/") : value === pattern);

/** Only this parser mints a live plan; serialised summaries cannot be submitted to the downloader as capabilities. */
export class PublicNpmPlan {
  readonly summary: Readonly<Omit<PublicNpmPreparationRequest, "kind">>;
  private constructor(summary: Plan["summary"]) { this.summary = summary; Object.freeze(this); }
  static create(input: PublicNpmInputs): PublicNpmPlan {
    try {
      for (const [body, maximum] of [[input.packageJson, PUBLIC_NPM_LIMITS.packageJsonBytes], [input.packageLock, PUBLIC_NPM_LIMITS.lockBytes]] as const) {
        if (!Buffer.isBuffer(body) || body.length < 2 || body.length > maximum || typeof SharedArrayBuffer !== "undefined" && body.buffer instanceof SharedArrayBuffer) throw bad();
      }
      const pkgBytes = Buffer.from(input.packageJson), lockBytes = Buffer.from(input.packageLock);
      const pkg = json(pkgBytes, PUBLIC_NPM_LIMITS.packageJsonBytes), lock = json(lockBytes, PUBLIC_NPM_LIMITS.lockBytes);
      if (lock.lockfileVersion !== 3 || lock.dependencies !== undefined) throw bad();
      const table = record(lock.packages), roots = Object.keys(table);
      if (roots.length < 1 || roots.length > PUBLIC_NPM_LIMITS.packages * 4 || !Object.hasOwn(table, "")) throw bad();
      const patterns = workspacePatterns(pkg), workspaces: PublicNpmWorkspace[] = [];
      for (const location of roots) if (location && !location.split("/").includes("node_modules")) {
        const path = relative(location), entry = record(table[location]); if (!matchesWorkspace(path, patterns) || entry.resolved !== undefined || entry.integrity !== undefined || entry.link) throw bad();
        workspaces.push(Object.freeze({ path, name: name(entry.name), version: version(entry.version) }));
      }
      const workspaceMap = new Map(workspaces.map(entry => [entry.path, entry])), packages = new Map<string, PublicNpmPackage>();
      for (const location of roots) {
        if (!location || workspaceMap.has(location)) continue;
        const safe = relative(location), parts = safe.split("/"), at = parts.lastIndexOf("node_modules"), entry = record(table[location]);
        if (at < 0) throw bad();
        let prefix = 0;
        if (parts[0] !== "node_modules") {
          const first = parts.indexOf("node_modules"); if (!workspaceMap.has(parts.slice(0, first).join("/"))) throw bad(); prefix = first;
        }
        while (prefix < parts.length) {
          if (parts[prefix++] !== "node_modules" || !parts[prefix]) throw bad();
          const count = parts[prefix].startsWith("@") ? 2 : 1; name(parts.slice(prefix, prefix + count).join("/")); prefix += count;
        }
        const tail = parts.slice(at + 1), derived = name(tail.join("/"));
        if (entry.link === true) { if (!workspaceMap.has(relative(entry.resolved)) || entry.integrity !== undefined) throw bad(); continue; }
        if (entry.link !== undefined && entry.link !== false || entry.inBundle || entry.hasShrinkwrap) throw bad();
        const actualName = entry.name === undefined ? derived : name(entry.name), actualVersion = version(entry.version);
        const artifact = publicNpmPackageIdentity({ name: actualName, version: actualVersion, resolved: string(entry.resolved), integrity: string(entry.integrity) });
        const os = platform(entry.os, "linux"), cpu = platform(entry.cpu, "x64"), libc = platform(entry.libc, "glibc"), compatible = os && cpu && libc;
        if (!compatible) { if (entry.optional !== true) throw bad(); continue; }
        const key = artifact.resolved + "\0" + artifact.integrity;
        packages.set(key, artifact); if (packages.size > PUBLIC_NPM_LIMITS.packages) throw bad();
      }
      // The Windows host and Linux guest must hash the same order regardless of their locale/ICU version.
      const list = Object.freeze([...packages.values()].sort((a, b) => a.resolved < b.resolved ? -1 : a.resolved > b.resolved ? 1 : 0)), packageList = Object.freeze(list.map(p => Object.freeze({ name: p.name, version: p.version })));
      const summary = Object.freeze({ registry: PUBLIC_NPM_REGISTRY, packageJsonSha256: digest(pkgBytes), lockSha256: digest(lockBytes),
        setSha256: digest(JSON.stringify(list)), packages: packageList, packageCount: list.length, compressedByteLimit: PUBLIC_NPM_LIMITS.compressedBytes });
      const plan = new PublicNpmPlan(summary); plans.set(plan, Object.freeze({ summary, packages: list, workspaces: Object.freeze(workspaces) })); return plan;
    } catch { throw bad(); }
  }
}
/** Trusted host/guest ports may inspect an issued plan; this is never a model/renderer interface. */
export function publicNpmPlanData(plan: PublicNpmPlan): Readonly<Plan> { const value = plans.get(plan); if (!value) throw bad(); return value; }
