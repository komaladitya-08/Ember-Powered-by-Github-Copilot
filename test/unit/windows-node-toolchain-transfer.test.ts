/** Injectable ABI composition only. Synthetic streamed hashes are a crypto-boundary test seam, never runtime trust. */
import { afterEach, expect, it, vi } from "vitest";
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

import { setupWindowsCommandTransfer } from "../fixtures/windows-command-transfer-fake";
import type { WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";

afterEach(() => {
  for (const name of ["node:module", "../../app/main/platform/os", "../../app/main/agent/windows-coding-native"]) vi.doUnmock(name);
  vi.restoreAllMocks(); vi.resetModules();
});

it("the fixed asset use composes with genuine canonical input, stopped snapshot and positive producer retirement", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake"), s = nodeAssetFake({ io: f.s }), owner = await s.prepare();
  const command = await f.create(); let launch: WindowsCommandOutputLaunchRef | undefined;
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "test.cjs"], f.s.options), () => undefined);
  f.s.state.ended = true; const done = await command.completeRootOnly(run, f.s.abort.signal), closed = await owner.finishOutput(done, run, launch!);
  const snapshot = await command.captureStoppedSnapshot(run, done, closed);
  expect(f.producer.readWindowsCommandStoppedSnapshot(snapshot)).toMatchObject({ outcome: "natural-exit", exitCode: 0, outputComplete: true });
  expect(() => f.producer.requireWindowsCommandInputProducerClosed(f.input)).not.toThrow(); await owner.close(); await f.close();
});

it("a later authenticated empty cancellation cannot revive an older real run's canonical snapshot authority", async () => {
  const f = await setupWindowsCommandTransfer(), { nodeAssetFake } = await import("../fixtures/windows-node-toolchain-native-fake"), s = nodeAssetFake({ io: f.s }), owner = await s.prepare();
  const command = await f.create(); let launch: WindowsCommandOutputLaunchRef | undefined;
  const run = await command.launchRootOnlyWithOutput(context => launch = owner.createSuspended(context, ["test.cjs"], f.s.options), () => undefined);
  f.s.state.ended = true; const done = await command.completeRootOnly(run, f.s.abort.signal), closed = await owner.finishOutput(done, run, launch!);
  f.s.state.ended = false; f.s.state.assigned = false; s.state.current = false;
  await expect(command.launchRootOnlyWithOutput(context => owner.createSuspended(context, ["new.cjs"], f.s.options), () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  expect(s.io.state.creates).toBe(1); const queries = f.nativeCalls.length, assetQueries = s.calls.length;
  await expect(command.captureStoppedSnapshot(run, done, closed)).rejects.toMatchObject({ code: "boundary" });
  expect(f.nativeCalls).toHaveLength(queries); expect(s.calls).toHaveLength(assetQueries);
  expect(s.fence.failure).toBeUndefined(); await command.close(); await owner.close(); await f.close();
});
