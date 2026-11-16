/** Pure portable path/metadata rules shared only by the disabled Windows copy and broker foundation. */
import { ScopedCodingFileError, type ScopedCodingFileLimits } from "./coding-platform";
import { CodingPrivacyCleanupError } from "./coding-privacy-scanner";
import { projectFileProblem } from "./project";
import { WindowsCodingCleanupError, type WindowsCodingInfo } from "./windows-coding-native";

export const WINDOWS_CODING_CAPS: ScopedCodingFileLimits = Object.freeze({ entries: 10_000, depth: 64, fileBytes: 8 * 1024 * 1024,
  workspaceBytes: 100 * 1024 * 1024, resultBytes: 256 * 1024, searchMatches: 1000 });
export const WINDOWS_CODING_DEFAULTS: ScopedCodingFileLimits = Object.freeze({ ...WINDOWS_CODING_CAPS, entries: 4000, depth: 32, resultBytes: 64 * 1024, searchMatches: 200 });
export const windowsCodingFold = (value: string): string => value.toUpperCase().toLowerCase().normalize("NFC");
export const windowsCodingVirtual = (relative: string): string => relative ? `/work/${relative}` : "/work";
export function windowsCodingLimits(options: Partial<ScopedCodingFileLimits> = {}): Readonly<ScopedCodingFileLimits> {
  const limits = { ...WINDOWS_CODING_DEFAULTS, ...options };
  if (Object.entries(limits).some(([key, value]) => !Object.hasOwn(WINDOWS_CODING_CAPS, key) || !Number.isSafeInteger(value) || value < 1 || value > WINDOWS_CODING_CAPS[key as keyof ScopedCodingFileLimits])) throw new ScopedCodingFileError("limit");
  return Object.freeze(limits);
}
export function windowsCodingRelative(value: string, rootAllowed = true): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || value !== value.normalize("NFC") || Buffer.from(value).toString("utf8") !== value || /[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(value)) throw new ScopedCodingFileError("path");
  const relative = value === "/work" ? "" : value.startsWith("/work/") ? value.slice(6) : value;
  if (!relative && rootAllowed) return "";
  if (!relative || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || Buffer.byteLength(part) > 255 || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new ScopedCodingFileError("path");
  return relative;
}
export function windowsCodingPrivacy(relative: string, directory = false): "hidden" | "sensitive" | "unsupported" | null {
  const parts = relative.split("/");
  const namedDotFile = !directory && parts.length === 1 && [".gitignore", ".gitattributes", ".editorconfig"].includes(relative);
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index], why = projectFileProblem(name);
    const projectDotDirectory = index === 0 && (directory || index < parts.length - 1) && (name === ".github" || (name === ".claude" && ((directory && parts.length === 1) || parts[1] === "rules")));
    if (why === "hidden" && !projectDotDirectory && !namedDotFile) return "hidden";
    if (why === "unsafe" || why === "named" || ["unsafe", "named"].includes(projectFileProblem(`${name}.txt`) ?? "")) return "sensitive";
    if (!directory && index === parts.length - 1 && why === "kind" && !namedDotFile) return "unsupported";
  }
  return null;
}
export function windowsCodingSame(a: WindowsCodingInfo, b: WindowsCodingInfo, metadata = true): boolean {
  return a.id === b.id && a.volume === b.volume && a.kind === b.kind && windowsCodingFold(a.finalPath) === windowsCodingFold(b.finalPath) &&
    (!metadata || (a.attributes === b.attributes && a.links === b.links && a.size === b.size && a.created === b.created && a.written === b.written && a.changed === b.changed));
}
export function windowsCodingWithin(file: string, root: string): boolean {
  const a = windowsCodingFold(file.replace(/\\+$/, "")), b = windowsCodingFold(root.replace(/\\+$/, ""));
  return a === b || a.startsWith(b + "\\");
}
export function windowsCodingSafeError(error: unknown): ScopedCodingFileError | CodingPrivacyCleanupError | WindowsCodingCleanupError {
  if (error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError) return error;
  if (error instanceof ScopedCodingFileError) return new ScopedCodingFileError(error.code);
  const code = (error as { code?: unknown } | null)?.code;
  return new ScopedCodingFileError(code === "cancelled" || code === "stale" ? "cancelled" : code === "limit" ? "limit" : "io");
}
export const windowsCodingYield = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
