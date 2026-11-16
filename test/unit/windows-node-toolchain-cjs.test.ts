/** Injectable ABI composition only. Synthetic streamed hashes are a crypto-boundary test seam, never runtime trust. */
import { expect, it, vi } from "vitest";
import type * as Crypto from "node:crypto";

const hashing = vi.hoisted(() => ({ completed: [] as { marker: number; bytes: number; exact: boolean }[] }));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof Crypto>();
  const fixed = new Map([
    [78, { bytes: 120219136, sha256: "d95bc2f8d456eb84306f54aa798c17ee21e5fd22591f943fc13c6adc8fd115db" }],
    [76, { bytes: 145485, sha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4" }],
    [82, { bytes: 6035, sha256: "f50e4859309b72dde505b99cd4c8edd926f2c55dc4aa74f035712d0d5323c9ad" }],
  ]);
  const chunks = new Map([...fixed.keys()].map(marker => [marker, Buffer.alloc(65536, marker)]));
  return { ...actual, createHash(algorithm: string) {
    if (algorithm !== "sha256") return actual.createHash(algorithm);
    let marker: number | undefined, bytes = 0, exact = true, fallback: ReturnType<typeof actual.createHash> | undefined;
    const result = {
      update(data: string | Uint8Array, encoding?: BufferEncoding) {
        const b = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        if (!bytes && b.length && fixed.has(b[0])) marker = b[0];
        if (marker === undefined) (fallback ??= actual.createHash(algorithm)).update(b);
        else exact &&= b.length <= 65536 && b.equals(chunks.get(marker)!.subarray(0, b.length));
        bytes += b.length; return result;
      },
      digest(encoding: "hex") {
        if (marker === undefined) return (fallback ??= actual.createHash(algorithm)).digest(encoding);
        hashing.completed.push({ marker, bytes, exact }); const pin = fixed.get(marker)!;
        return exact && bytes === pin.bytes ? pin.sha256 : "0".repeat(64);
      },
    };
    return result;
  } };
});

import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import path from "node:path";
import * as crypto from "node:crypto";

it.each(["creator", "attestation"] as const)("the emitted CommonJS graph preserves genuine singleton cancellation provenance during %s", async phase => {
  const emitted = await build({ stdin: { contents: `
    import { nodeAssetFake } from "./test/fixtures/windows-node-toolchain-native-fake";
    import { closeWindowsCommandCreatorProfile } from "./app/main/agent/windows-command-creator-profile";
    import { requireWindowsCommandRootOnlyCompleted } from "./app/main/agent/windows-command-copy";
    import { requireWindowsCommandOutputClosed } from "./app/main/agent/windows-command-output";
    import { consumeWindowsCommandLaunchCancellation } from "./app/main/agent/windows-command-launch-cancel";
    export function rejectsForeign(proofs) {
      let completed=false, output=false;
      try { requireWindowsCommandRootOnlyCompleted(proofs.completed, proofs.run); } catch { completed=true; }
      try { requireWindowsCommandOutputClosed(proofs.closed, proofs.output, proofs.run); } catch { output=true; }
      return { completed, output, claim:consumeWindowsCommandLaunchCancellation(proofs.claim, {})===false };
    }
    export async function probe(phase) {
      const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let output, claim, run, done, closed;
      if (phase === "attestation") s.state.onCall = name => { if (name === "GetProcessId") s.state.current = false; };
      let cancelled = false, outcome, reason;
      try {
        run = await copy.launchRootOnlyWithOutput(context => {
          if (phase === "creator") s.state.current = false;
          try { return output = owner.createSuspended(context, ["test.cjs"], s.io.options); }
          catch (error) { claim=error; throw error; }
        }, () => undefined);
        done = await copy.completeRootOnly(run, s.io.abort.signal);
        outcome = requireWindowsCommandRootOnlyCompleted(done, run);
        closed = await owner.finishOutput(done, run, output);
        reason = requireWindowsCommandOutputClosed(closed, output, run);
      } catch (error) { if (phase !== "creator" || error.code !== "cancelled") throw error; cancelled = true; }
      await copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
      return { cancelled, outcome, reason, creates:s.io.state.creates, resumed:s.io.events.includes("resume"),
        stopped:s.io.events.includes("stop-job"), fences:[s.fence,s.io.stopFence,s.io.copyFence,s.io.fence].some(f=>f.failure),
        allAssetsClosed:s.handles.size===0 && s.assets().every(row=>row.removed), proofs:{claim,run,completed:done,output,closed} };
    }`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "cjs", target: "node22",
    write: false, metafile: true, logLevel: "silent", plugins: [{ name: "abi-fixture-vi-function-only", setup(b) {
      b.onResolve({ filter: /^vitest$/ }, () => ({ path: "vi", namespace: "abi-fixture" }));
      b.onLoad({ filter: /.*/, namespace: "abi-fixture" }, () => ({ contents: "export const vi={fn:f=>f};", loader: "js" }));
    } }] });
  // Every production module, including the new cycle, is bundled once with its real private WeakMaps intact.
  for (const name of ["windows-command-launch-cancel", "windows-command-copy", "windows-command-stop", "windows-command-output", "windows-node-toolchain-native"])
    expect(Object.keys(emitted.metafile!.inputs).filter(input => input.endsWith(`/agent/${name}.ts`))).toHaveLength(1);
  const require = createRequire(import.meta.url), load = () => {
    const module = { exports: {} as { probe(phase: string): Promise<Record<string, unknown>>; rejectsForeign(proofs: unknown): unknown } };
    runInNewContext(emitted.outputFiles[0].text, { module, exports: module.exports,
      require: (name: string) => name === "node:crypto" ? crypto : require(name), __filename: path.resolve("dist/app/asset-owner-provenance.cjs"),
      Buffer, process, console, performance, AbortSignal, AbortController, setImmediate, setTimeout, clearTimeout, TextEncoder, TextDecoder });
    return module.exports;
  };
  const ownerGraph = load(), foreignGraph = load(), facts = await ownerGraph.probe(phase);
  expect(facts).toMatchObject({ cancelled: phase === "creator", creates: phase === "creator" ? 0 : 1, resumed: false, stopped: true, fences: false, allAssetsClosed: true });
  const proofs = facts.proofs as Record<string, unknown>;
  if (phase === "attestation") {
    expect(facts).toMatchObject({ outcome: { outcome: "cancelled", exitCode: null }, reason: { complete: false, reason: "cancelled" } });
    for (const name of ["run", "completed", "output", "closed"]) { expect(proofs[name]).not.toBeNull(); expect(typeof proofs[name]).toBe("object"); }
  } else { expect(proofs.claim).not.toBeNull(); expect(typeof proofs.claim).toBe("object"); }
  expect(foreignGraph.rejectsForeign(facts.proofs)).toEqual({ completed: true, output: true, claim: true });
});
