/** A bounded public-registry data downloader. It never runs npm, reads credentials or offers a generic fetch/proxy RPC. */
import https from "node:https";
import tls from "node:tls";
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { PublicNpmPlan, publicNpmPlanData, publicNpmPackageIdentity, PUBLIC_NPM_LIMITS, PublicNpmPreparationError, type PublicNpmPackage } from "./public-npm-lock";
import { verifyPublicNpmArchive, type PublicNpmArchiveReceipt } from "./public-npm-archive";

export interface PublicNpmArchive { readonly artifact: PublicNpmPackage; readonly bytes: Buffer; readonly receipt: PublicNpmArchiveReceipt }
export interface PublicNpmBatchReceipt { readonly setSha256: string; readonly packages: number; readonly compressedBytes: number; readonly expandedBytes: number; readonly entries: number }
export interface PublicNpmDownloadPort {
  read(artifact: PublicNpmPackage, signal: AbortSignal, current: () => void, maximumBytes: number): Promise<Buffer>;
}
const batches = new WeakMap<object, { archives: readonly PublicNpmArchive[]; receipt: PublicNpmBatchReceipt; closed: boolean }>();
const bad = () => new PublicNpmPreparationError();

/** Owned bytes are wiped on close; a serialised receipt cannot recover or mint a transferable batch. */
export class PublicNpmBatch {
  readonly receipt: PublicNpmBatchReceipt;
  private constructor(receipt: PublicNpmBatchReceipt) { this.receipt = receipt; Object.freeze(this); }
  static async download(plan: PublicNpmPlan, input: { signal: AbortSignal; current(): boolean; port?: PublicNpmDownloadPort }): Promise<PublicNpmBatch> {
    const data = publicNpmPlanData(plan), signal = AbortSignal.any([input.signal, AbortSignal.timeout(180_000)]);
    const checkCurrent = input.current.bind(input), port = input.port ?? publicNpmHttpsPort;
    const read = port.read.bind(port);
    let live = true;
    const current = () => { try { live = live && !signal.aborted && checkCurrent() === true; } catch { live = false; } if (!live) throw bad(); };
    const archives: PublicNpmArchive[] = []; let compressedBytes = 0, expandedBytes = 0, entries = 0;
    try {
      current();
      for (const artifact of data.packages) {
        current(); const remaining = Math.min(PUBLIC_NPM_LIMITS.archiveBytes, PUBLIC_NPM_LIMITS.compressedBytes - compressedBytes);
        if (remaining < 32) throw bad();
        let incoming: Buffer | undefined, bytes: Buffer | undefined;
        try {
          incoming = await read(artifact, signal, current, remaining); current();
          if (!Buffer.isBuffer(incoming) || incoming.length > remaining ||
              typeof SharedArrayBuffer !== "undefined" && incoming.buffer instanceof SharedArrayBuffer) throw bad();
          bytes = Buffer.from(incoming);
          if ((compressedBytes += bytes.length) > PUBLIC_NPM_LIMITS.compressedBytes) throw bad();
          const receipt = await verifyPublicNpmArchive(artifact, bytes, { signal, current, maximumExpandedBytes: PUBLIC_NPM_LIMITS.expandedBytes - expandedBytes }); current();
          if ((expandedBytes += receipt.expandedBytes) > PUBLIC_NPM_LIMITS.expandedBytes || (entries += receipt.entries) > PUBLIC_NPM_LIMITS.entries) throw bad();
          archives.push(Object.freeze({ artifact, bytes, receipt }));
        } catch { bytes?.fill(0); throw bad(); }
        finally { incoming?.fill(0); }
      }
      current(); const receipt = Object.freeze({ setSha256: data.summary.setSha256, packages: archives.length, compressedBytes, expandedBytes, entries });
      const batch = new PublicNpmBatch(receipt); batches.set(batch, { archives: Object.freeze(archives), receipt, closed: false }); return batch;
    } catch { for (const archive of archives) archive.bytes.fill(0); throw bad(); }
  }
  close(): void { const value = batches.get(this); if (!value || value.closed) return; value.closed = true; for (const archive of value.archives) archive.bytes.fill(0); }
}
/** A trusted transfer port borrows these bytes only while the issued batch remains live. */
export function publicNpmBatchData(batch: PublicNpmBatch): readonly PublicNpmArchive[] {
  const value = batches.get(batch); if (!value || value.closed) throw bad(); return value.archives;
}
/** No redirects, cookies, auth or npm config. System transport settings never cross into the guest. */
export const publicNpmHttpsPort: PublicNpmDownloadPort = Object.freeze({
  async read(input: PublicNpmPackage, signal: AbortSignal, current: () => void, maximumBytes: number): Promise<Buffer> {
    const artifact = publicNpmPackageIdentity(input);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 32 || maximumBytes > PUBLIC_NPM_LIMITS.archiveBytes) throw bad();
    let trust: string[] | undefined;
    try { trust = [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]; } catch { /* Node's own trust remains when the system store cannot be read. */ }
    const agent = new https.Agent({ proxyEnv: process.env, ca: trust }), abort = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let response: IncomingMessage | undefined, bytes: Buffer | undefined, success = false;
    try {
      current(); response = await new Promise<IncomingMessage>((resolve, reject) => https.get(artifact.resolved,
        { agent, signal: abort, headers: { accept: "application/octet-stream", "user-agent": "Ember-public-dependencies" } }, resolve).on("error", reject));
      current(); const raw = response.headers["content-length"], size = typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
      if (response.statusCode !== 200 || response.headers["content-encoding"] || !Number.isSafeInteger(size) || size < 32 || size > maximumBytes) throw bad();
      bytes = Buffer.alloc(size); let offset = 0;
      for await (const part of response) { current(); if (offset + part.length > size) throw bad(); bytes.set(part, offset); offset += part.length; }
      current();
      if (offset !== size || "sha512-" + createHash("sha512").update(bytes).digest("base64") !== artifact.integrity) throw bad();
      success = true; return bytes;
    } catch { throw bad(); }
    finally { response?.destroy(); agent.destroy(); if (!success) bytes?.fill(0); }
  },
});
