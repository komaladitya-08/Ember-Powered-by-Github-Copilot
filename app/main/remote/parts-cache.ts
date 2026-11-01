/**
 * What this Ember can send to a remote (§5.2.2, §5.2.4): the "parts" (Ember's helper, one archive per target) that ship
 * inside every installer as resources/remote-parts/ with remote-parts.json, and the Node runtime policy
 * (remote-runtime.json, SB). Read from the packaged resources first, then, in an unpackaged build, from dist/ beside
 * the app (and the repository's scripts/package/ for the runtime policy). Each archive is checked against its
 * recorded size and SHA-256 before it is sent; a missing or broken manifest means "missing from this install".
 */

import { z } from "zod";
import type { Archive, PlanLocal, RemoteTarget } from "./plan";
import { RuntimeManifestSchema, sha256File, type RuntimeFs, type RuntimeManifest } from "./runtime-download";

const PartsFile = z.object({
  file: z.string().regex(/^[A-Za-z0-9._+-]{1,200}\.tar\.gz$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(1).max(64 * 1024 * 1024),
}).passthrough();

/** remote-parts.json (SB): `{ partsId, targets: { <target>: { file, sha256, bytes } } }`. */
export const PartsManifestSchema = z.object({
  partsId: z.string().regex(/^[A-Za-z0-9._+-]{1,100}$/),
  targets: z.partialRecord(z.enum(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]), PartsFile),
}).passthrough();

export type PartsManifest = z.infer<typeof PartsManifestSchema>;

/** Where the manifests are, found once per connect. */
export interface Shipped {
  parts: { dir: string; manifest: PartsManifest } | null;
  runtime: RuntimeManifest | null;
}

/** The folders that may hold remote-parts/ and remote-runtime.json, in order (packaged, then unpackaged). */
export function shippedCandidates(o: { resourcesPath: string; appDir: string; join: (...p: string[]) => string }): { parts: string[]; runtime: string[] } {
  const packaged = o.join(o.resourcesPath, "remote-parts");
  const dist = o.join(o.appDir, "..", "remote-parts");
  return {
    parts: [packaged, dist],
    runtime: [o.join(packaged, "remote-runtime.json"), o.join(dist, "remote-runtime.json"), o.join(o.appDir, "..", "..", "scripts", "package", "remote-runtime.json")],
  };
}

/** Reads the first manifest that parses; null when none does. */
export async function loadShipped(o: { candidates: { parts: string[]; runtime: string[] }; readFile: (p: string) => Promise<string>; join: (...p: string[]) => string }): Promise<Shipped> {
  let parts: Shipped["parts"] = null;
  for (const dir of o.candidates.parts) {
    const text = await o.readFile(o.join(dir, "remote-parts.json")).catch(() => null);
    if (text === null) continue;
    const parsed = (() => { try { return PartsManifestSchema.safeParse(JSON.parse(text)); } catch { return null; } })();
    if (parsed?.success) { parts = { dir, manifest: parsed.data }; break; }
  }
  let runtime: RuntimeManifest | null = null;
  for (const file of o.candidates.runtime) {
    const text = await o.readFile(file).catch(() => null);
    if (text === null) continue;
    const parsed = (() => { try { return RuntimeManifestSchema.safeParse(JSON.parse(text)); } catch { return null; } })();
    if (parsed?.success) { runtime = parsed.data; break; }
  }
  return { parts, runtime };
}

/** The manifests in planInstall's shape. */
export function planShipped(s: Shipped): Pick<PlanLocal, "parts" | "runtime"> {
  return {
    parts: s.parts ? { partsId: s.parts.manifest.partsId, targets: Object.fromEntries(Object.entries(s.parts.manifest.targets).map(([t, f]) => [t, { bytes: f.bytes, sha256: f.sha256 }])) } : null,
    runtime: s.runtime ? {
      minimum: s.runtime.minimum,
      pinned: s.runtime.pinned,
      targets: Object.fromEntries(Object.entries(s.runtime.targets).map(([t, v]) => [t, {
        ...(v.xz ? { xz: { bytes: v.xz.bytes, sha256: v.xz.sha256 } } : {}),
        ...(v.gz ? { gz: { bytes: v.gz.bytes, sha256: v.gz.sha256 } } : {}),
      }])),
    } : null,
  };
}

/**
 * The parts archive for `target`, checked (§5.2.4 step 1): its path when its size and SHA-256 match the manifest;
 * null when it is missing or differs (then nothing is sent).
 */
export async function partsArchive(s: Shipped, target: RemoteTarget, o: { fs: Pick<RuntimeFs, "stat" | "createReadStream">; join: (...p: string[]) => string }): Promise<(Archive & { path: string }) | null> {
  const entry = s.parts?.manifest.targets[target];
  if (!s.parts || !entry) return null;
  const path = o.join(s.parts.dir, entry.file);
  const st = await o.fs.stat(path).catch(() => null);
  if (!st || st.size !== entry.bytes) return null;
  if ((await sha256File(o.fs, path).catch(() => "")) !== entry.sha256) return null;
  return { id: s.parts.manifest.partsId, bytes: entry.bytes, sha256: entry.sha256, format: "gz", path };
}
