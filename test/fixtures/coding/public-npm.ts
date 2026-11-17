/** Small authenticated data-only npm fixtures; none is executed by a host test. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PublicNpmPackage } from "../../../app/main/agent/public-npm-lock";

export interface NpmTarMember { path: string; body?: string; type?: string; size?: number; mode?: number }
export function npmTar(members: NpmTarMember[]): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    const body = Buffer.from(member.body ?? ""), header = Buffer.alloc(512);
    header.write(member.path, 0, 100, "utf8"); header.write((member.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii"); header.write("0000000\0", 116, 8, "ascii");
    header.write((member.size ?? body.length).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii"); header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156); header[156] = (member.type ?? "0").charCodeAt(0); header.write("ustar\0", 257, 6, "ascii");
    let sum = 0; for (const byte of header) sum += byte; header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}
export function npmFixture(extra: NpmTarMember[] = []) {
  const name = "tiny-public-fixture", version = "1.0.0";
  const bytes = npmTar([{ path: "package/package.json", body: JSON.stringify({ name, version }) }, { path: "package/index.js", body: "module.exports=42;\n" }, ...extra]);
  const artifact: PublicNpmPackage = { name, version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  const pkg = { name: "fixture-project", private: true, version: "1.0.0", dependencies: { [name]: version } };
  const lock: { name: string; version: string; lockfileVersion: number; packages: Record<string, Record<string, unknown>> } = {
    name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": pkg, [`node_modules/${name}`]: { ...artifact, resolved: artifact.resolved } } };
  return { bytes, artifact, pkg, lock, inputs: { packageJson: Buffer.from(JSON.stringify(pkg)), packageLock: Buffer.from(JSON.stringify(lock)) } };
}
