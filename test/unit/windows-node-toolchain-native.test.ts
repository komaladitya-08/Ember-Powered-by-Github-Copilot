/** Injectable ABI composition only. Synthetic streamed hashes are a crypto-boundary test seam, never runtime trust. */
import { expect, it, vi } from "vitest";
import type * as Crypto from "node:crypto";

const hashing = vi.hoisted(() => ({ completed: [] as { marker: number; bytes: number; exact: boolean }[] }));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof Crypto>();
  const fixed = new Map([
    [78, { bytes: 120220672, sha256: "a4ed4d41331cd7886a67aedf1ecc1e8b389f8a48b5f862464eabd123c62ca8d1" }],
    [76, { bytes: 145485, sha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4" }],
    [82, { bytes: 7669, sha256: "cb5f649e1f17a1d025cf98ccc99f65a28e1068934cb1c9c59171341e20584916" }],
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

import { nodeAssetFake } from "../fixtures/windows-node-toolchain-native-fake";
import { WindowsNodeToolchainCleanupError, probeWindowsNodeToolchainReturnedCancellation, type WindowsNodeToolchainFence } from "../../app/main/agent/windows-node-toolchain-native";
import { closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import type { WindowsCommandRootOnlyCompletedRef, WindowsCommandRootOnlyRunRef } from "../../app/main/agent/windows-command-copy";
import type { WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import { requireWindowsCommandOutputLaunch, requireWindowsCommandOutputClosed } from "../../app/main/agent/windows-command-output";
import { requireWindowsCommandRootOnlyCompleted, requireWindowsCommandRootOnlyLaunchMetadata } from "../../app/main/agent/windows-command-copy";
import { issueWindowsCommandLaunchCancellation, consumeWindowsCommandLaunchCancellation } from "../../app/main/agent/windows-command-launch-cancel";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyReturned, requireWindowsCommandRootOnlyUnconsumedCreatorStopped, windowsCommandRootOnlyReturnedForRoot,
  type WindowsCommandRootOnlyCancellationPhaseRef, type WindowsCommandRootOnlyReturnedRef } from "../../app/main/agent/windows-command-stop";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import { WindowsCodingCleanupError } from "../../app/main/agent/windows-coding-native";

async function refused(action: () => unknown) { try { await action(); } catch (error) { expect(String(error)).not.toContain("PRIVATE"); return error; } throw Error("The native boundary must refuse."); }

it("streams the fixed 120 MB image into only a fresh RX/Low owner and closes an unused owner without touching packaged originals", async () => {
  const s = nodeAssetFake(), source = [...s.nodes.values()].filter(row => row.name.includes("\\resources\\coding\\")), before = source.map(row => ({ row, size: row.size, written: row.written, security: { ...row.security } }));
  let yielded = false; setImmediate(() => { yielded = true; }); const owner = await s.prepare();
  expect(yielded).toBe(true); expect(s.state.maximumRead).toBe(65536); expect(s.state.maximumWrite).toBe(65536); expect(s.state.copiedBytes).toBe(120220672);
  expect(hashing.completed.some(value => value.marker === 78 && value.bytes === 120220672 && value.exact)).toBe(true);
  expect(s.opened.filter(open => open.fresh)).toHaveLength(2); expect(s.assets()).toHaveLength(2);
  for (const row of s.assets()) { expect(row.security).toMatchObject({ rx: true, ownerRights: true, ownerMask: 0x20000, packageMask: 0x1200a9, low: true }); }
  expect(s.opened.filter(open => open.row.kind === "file" && open.row.name.includes("\\resources\\")).every(open => open.access === 0x120089 && open.share === 1)).toBe(true);
  expect([...s.handles.values()].filter(handle => handle.row?.security.rx).every(handle => (handle.access & 0xd0116) === 0)).toBe(true);
  expect(() => closeWindowsCommandCreatorProfile(s.io.profile)).toThrow();
  await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
  expect(s.assets().every(row => row.removed)).toBe(true); expect(s.handles.size).toBe(0);
  for (const value of before) expect({ size: value.row.size, written: value.row.written, security: value.row.security }).toEqual({ size: value.size, written: value.written, security: value.security });
});

it("rejects a Low borrowed parent before creating assets or relabelling any existing object", async () => {
  const s = nodeAssetFake(), parent = s.nodes.get("C:\\scratch\\tools")!; parent.security.low = true; const before = { ...parent.security };
  await refused(() => s.prepare()); expect(s.opened.filter(open => open.fresh)).toHaveLength(0); expect(s.io.events).not.toContain("native-create");
  expect(parent.security).toEqual(before); expect(parent.removed).toBe(false);
});

it.each(["explicit", "absent", "empty"] as const)("accepts a %s Medium/default parent label without changing borrowed ACLs", async sacl => {
  const s = nodeAssetFake(), parent = s.nodes.get("C:\\scratch\\tools")!; parent.security.sacl = sacl; const before = { ...parent.security };
  const owner = await s.prepare(); expect(parent.security.low).toBe(false); expect(parent.security).toEqual(before);
  expect(s.calls.some(call => call.name === "GetSecurityDescriptorSacl")).toBe(true);
  await owner.close(); expect(parent.security).toEqual(before); expect(parent.removed).toBe(false); closeWindowsCommandCreatorProfile(s.io.profile);
});

it("refuses a borrowed parent changed to Low before attestation without correcting its ACL", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), parent = s.nodes.get("C:\\scratch\\tools")!; parent.security.low = true; const before = { ...parent.security };
  await refused(() => s.launch(owner)); expect(s.io.events).not.toContain("resume"); expect(parent.security).toEqual(before); expect(parent.removed).toBe(false);
});

it("authenticates the actual held image and both token contexts before Resume, without rescanning 120 MB", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), reads = s.state.readCalls, value = await s.launch(owner, ["--preserve-symlinks", "--preserve-symlinks-main", "literal & | ; $() \\\"", ""]);
  expect(s.io.events).toContain("resume"); expect(s.state.readCalls).toBe(reads); expect(s.state.nativeReadsAfterCreate).toBe(0);
  const duplicate = s.calls.find(call => call.name === "DuplicateTokenEx")!; expect(duplicate.args.slice(1, 5)).toEqual([8, null, 2, 2]);
  const checks = s.calls.filter(call => call.name === "AccessCheck"); expect(checks.map(call => call.args[2])).toEqual([0x1200a9, 0x40000, 0x80000, 0x1200a9, 0x40000, 0x80000, 1, 1]);
  const duplicateRaw = (duplicate.args[5] as unknown[])[0]; expect(checks.every(call => call.args[1] === duplicateRaw && call.args[1] !== duplicate.args[0])).toBe(true);
  const primary = s.calls.find(call => call.name === "OpenProcessToken" && call.args[0] === s.io.state.returnedProcess)!;
  expect(primary.args[1]).toBe(10); expect((primary.args[2] as unknown[])[0]).toBe(duplicate.args[0]);
  expect(s.calls.filter(call => call.name === "GetTokenInformation" && call.args[1] === 11)).toHaveLength(2);
  const probes = s.calls.filter(call => call.name === "ConvertStringSecurityDescriptorToSecurityDescriptorW" && String(call.args[0]).startsWith("O:SYG:SYD:P"));
  expect(probes).toHaveLength(2); expect(String(probes[1].args[0])).toContain(";;;S-1-15-2-1)");
  for (const probe of probes) { const raw = (probe.args[2] as unknown[])[0];
    expect(s.calls.some(call => call.name === "GetSecurityDescriptorLength" && call.args[0] === raw)).toBe(true);
    expect(s.calls.filter(call => call.name === "LocalFree" && call.args[0] === raw)).toHaveLength(1);
  }
  const image = s.io.calls.find(call => call.name === "CreateProcessW")!; expect(String(image.args[0])).toContain("\\ember-node-");
  await refused(() => owner.close()); const finished = await s.finish(owner, value); expect(finished.facts.complete).toBe(true);
});

it("ordinary AppContainer behaviour fails the AAP witness after passing all six asset checks", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(); s.state.ordinaryAppContainer = true;
  await refused(() => s.launch(owner));
  expect(s.calls.filter(call => call.name === "AccessCheck").map(call => call.args[2])).toEqual([0x1200a9, 0x40000, 0x80000, 0x1200a9, 0x40000, 0x80000, 1, 1]);
  expect(s.io.events).not.toContain("resume"); expect(s.fence.retained.length).toBeGreaterThan(0);
});

it.each(["closed", "live"] as const)("shared assets use the genuine %s PI lifetime during a different fake profile's preparation", async phase => {
  // Separate real profile factories intentionally use synthetic equal SID values. This tests PI lifetime, not native SID isolation.
  const fence: WindowsNodeToolchainFence = { retained: [] }, first = nodeAssetFake({ fence }), owner = await first.prepare(), value = await first.launch(owner);
  let completed: WindowsCommandRootOnlyCompletedRef | undefined;
  if (phase === "closed") { first.io.state.holdEOF = true; first.io.state.ended = true; completed = await value.copy.completeRootOnly(value.run, first.io.abort.signal); }
  const facts = requireWindowsCommandOutputLaunch(value.ref); expect(facts.heldPiHandles).toEqual(phase === "closed" ? [] : [50001n, 50002n]);
  const peer = nodeAssetFake({ fence, handleBase: 50001n }); expect(peer.io.profile).not.toBe(first.io.profile);
  if (phase === "live") {
    await refused(() => peer.prepare()); expect(fence.failure).toBeInstanceOf(WindowsNodeToolchainCleanupError);
    expect(peer.calls.some(call => call.name === "CloseHandle" && call.args[0] === 50001n)).toBe(false);
  } else {
    const peerOwner = await peer.prepare(); expect(fence.failure).toBeUndefined();
    expect(first.io.state.holdEOF).toBe(true); expect(first.io.events).toContain("root-close");
    await peerOwner.close(); closeWindowsCommandCreatorProfile(peer.io.profile);
    first.io.state.holdEOF = false; await owner.finishOutput(completed!, value.run, value.ref); await value.copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(first.io.profile);
  }
});

it("rejects accessor output options without invoking their getters or creating a process", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let reads = 0;
  const options = { get signal() { reads++; return s.io.abort.signal; }, timeoutMs: 30000, output() {} };
  await refused(() => copy.launchRootOnlyWithOutput(context => owner.createSuspended(context, ["test.cjs"], options), () => undefined));
  expect(reads).toBe(0); expect(s.io.state.creates).toBe(0); expect(s.fence.failure).toBeUndefined();
});

it.each(["options-close", "argv-create", "native-create"] as const)("a swallowed %s reentry retains the first owner and never overwrites a PI", async phase => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let first: unknown, returnedPi: bigint[] | undefined;
  await refused(() => copy.launchRootOnlyWithOutput(context => {
    const reenter = (close: boolean) => { try {
      if (close) void owner.close().catch(error => { first ??= error; }); else owner.createSuspended(context, ["nested.cjs"], s.io.options);
    } catch (error) { first ??= error; } };
    const options = phase === "options-close" ? new Proxy(s.io.options, { getOwnPropertyDescriptor(target, key) { reenter(true); return Reflect.getOwnPropertyDescriptor(target, key); } }) : s.io.options;
    const argv = phase === "argv-create" ? Object.defineProperty(["test.cjs"], "0", { get() { reenter(false); return "test.cjs"; } }) : ["test.cjs"];
    if (phase === "native-create") {
      s.io.state.onNative = name => { if (name === "CreateProcessW") reenter(false); };
      s.io.state.afterNative = (name, args, result) => { if (name === "CreateProcessW") { const pi = args[9] as Buffer; returnedPi = [pi.readBigUInt64LE(0), pi.readBigUInt64LE(8)]; } return result; };
    }
    return owner.createSuspended(context, argv, options);
  }, () => undefined));
  expect(first).toBeInstanceOf(WindowsNodeToolchainCleanupError); expect(s.fence.failure).toBe(first); expect(s.io.events).not.toContain("resume");
  expect(s.io.state.creates).toBe(phase === "native-create" ? 1 : 0);
  if (phase === "native-create") { const creates = s.io.calls.filter(call => call.name === "CreateProcessW"); expect(creates).toHaveLength(1);
    expect(returnedPi).toEqual([50001n, 50002n]);
    expect(s.io.calls.find(call => call.name === "TerminateProcess")?.args[0]).toBe(returnedPi![0]);
    expect(s.io.events.filter(event => event === "producer-terminate")).toHaveLength(1); expect(s.io.fence.retained.length).toBeGreaterThan(0);
  }
  const before = s.calls.length; s.fence.failure = undefined; expect(await refused(() => owner.close())).toBe(first); expect(s.calls).toHaveLength(before);
});

it("reuses the same assets across two closed Copy generations while old completion cannot finish the newer use", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), first = await s.launch(owner); s.io.state.ended = true;
  const done = await first.copy.completeRootOnly(first.run, s.io.abort.signal); await owner.finishOutput(done, first.run, first.ref); await first.copy.close();
  expect(s.assets().every(row => !row.removed)).toBe(true); expect(() => closeWindowsCommandCreatorProfile(s.io.profile)).toThrow();
  const second = await s.launch(owner), before = s.calls.length;
  await refused(() => owner.finishOutput(done, second.run, second.ref)); await refused(() => owner.finishOutput(done, first.run, first.ref));
  expect(s.calls).toHaveLength(before); await refused(() => owner.close());
  const final = await s.finish(owner, second); expect(final.facts.complete).toBe(true); expect(s.assets().every(row => row.removed)).toBe(true);
});

it.each(["sourceTamper", "writeTamper"] as const)("a %s cannot produce ready assets or a resumed process", async field => {
  const s = nodeAssetFake(); s.state[field] = true;
  await refused(() => s.prepare()); expect(s.io.events).not.toContain("resume"); expect(s.fence.retained.length).toBeGreaterThan(0);
});

it.each(["image", "root"] as const)("a different object opened during %s metadata handover cannot replace the retained original", async kind => {
  const s = nodeAssetFake(); s.state.replaceHandover = kind;
  await refused(() => s.prepare()); expect(s.replacements).toHaveLength(1);
  const { original, replacement } = s.replacements[0], originalOpen = s.opened.find(open => open.fresh && open.row === original)!;
  expect(original.name).toBe(replacement.name); expect(original.id).not.toBe(replacement.id);
  expect(s.nodes.get(original.name)).toBe(replacement); expect(s.handles.get(originalOpen.raw)?.row).toBe(original);
  expect(s.calls.some(call => call.name === "CloseHandle" && call.args[0] === originalOpen.raw)).toBe(false);
  expect(s.opened.some(open => !open.fresh && open.row === replacement && open.access === (kind === "image" ? 0x120080 : 0x1200a0))).toBe(true);
  expect(s.io.events).not.toContain("native-create"); expect(s.io.events).not.toContain("resume");
  expect(() => closeWindowsCommandCreatorProfile(s.io.profile)).toThrow(); expect(s.fence.retained.length).toBeGreaterThan(0);
});

it("hashes the exact runtime pin after a same-identity byte mutation at readonly acquisition", async () => {
  const s = nodeAssetFake(); let mutated = false, readsAtMutation = 0;
  let metadata: { id: bigint; size: number; written: bigint; changed: bigint } | undefined;
  s.state.afterCall = (name, args, result) => {
    if (!mutated && name === "NtCreateFile" && args[1] === 0x120089 && args[6] === 1) {
      const raw = (args[0] as unknown[])[0] as bigint, row = s.handles.get(raw)?.row;
      if (row?.kind === "file" && row.security.rx) {
        const original = s.opened.find(open => open.fresh && open.row === row)!;
        expect(s.handles.has(original.raw)).toBe(false); metadata = { id: row.id, size: row.size, written: row.written, changed: row.changed };
        readsAtMutation = s.state.readCalls; mutated = true; row.damaged = true;
      }
    }
    return result;
  };
  await refused(() => s.prepare()); expect(mutated).toBe(true); expect(s.state.copiedBytes).toBe(120220672); expect(s.state.readCalls).toBeGreaterThan(readsAtMutation);
  const image = s.assets().find(row => row.kind === "file")!;
  expect({ id: image.id, size: image.size, written: image.written, changed: image.changed }).toEqual(metadata);
  expect(image.damaged).toBe(true); expect(s.io.events).not.toContain("native-create"); expect(s.io.events).not.toContain("resume");
  expect(s.fence.retained.length).toBeGreaterThan(0); expect(() => closeWindowsCommandCreatorProfile(s.io.profile)).toThrow();
});

it.each(["size", "over-cap", "hardlink", "reparse", "extra-file"])("a packaged source %s cannot be admitted as executable assets", async fault => {
  const s = nodeAssetFake(), image = [...s.nodes.values()].find(row => row.name.endsWith("\\resources\\coding\\windows-node-x64\\node.exe"))!;
  if (fault === "size") image.size--;
  if (fault === "over-cap") image.size = 128 * 1024 * 1024 + 1;
  if (fault === "hardlink") image.links = 2;
  if (fault === "reparse") image.attributes |= 0x400;
  if (fault === "extra-file") s.add("C:\\Ember\\resources\\coding\\windows-node-x64\\extra.dll", "file", 1, 65);
  await refused(() => s.prepare()); expect(s.state.writes).toBe(0); expect(s.io.events).not.toContain("native-create");
});

it("an abort during bounded preparation yields before launch and releases only known owners", async () => {
  const s = nodeAssetFake(); let observed = false;
  s.state.onCall = name => { if (name === "NtReadFile" && !observed) { observed = true; setImmediate(() => s.io.abort.abort()); } };
  await refused(() => s.prepare()); expect(observed).toBe(true); expect(s.io.events).not.toContain("native-create");
  expect(s.fence.failure).toBeUndefined(); expect(s.handles.size).toBe(0); closeWindowsCommandCreatorProfile(s.io.profile);
});

it.each(["ownerRights", "ownerMask", "packageMask", "low"] as const)("refuses altered %s readback on host-owned executable assets", async field => {
  const s = nodeAssetFake(); if (field === "ownerRights" || field === "low") s.state[field] = false; else s.state[field] = 0x1f01ff;
  await refused(() => s.prepare()); expect(s.io.events).not.toContain("resume"); expect(s.fence.retained.length).toBeGreaterThan(0);
});

it.each(["allowWriteDac", "allowWriteOwner"] as const)("a real AccessCheck granting %s blocks Resume for the user-owner case", async field => {
  const s = nodeAssetFake(), owner = await s.prepare(); s.state[field] = true;
  await refused(() => s.launch(owner)); expect(s.io.events).not.toContain("resume"); expect(s.fence.retained.length).toBeGreaterThan(0);
});

it.each(["not-container", "capability", "foreign-package", "foreign-user", "medium", "primary-duplicate", "bad-impersonation", "duplicate-restricting", "duplicate-restricting-attributes", "duplicate-integrity-attributes", "disabled-integrity", "no-write-up-policy"])("rejects malformed source/duplicate token fact %s before Resume", async fault => {
  const s = nodeAssetFake(), owner = await s.prepare(); s.state.tokenFault = fault;
  await refused(() => s.launch(owner)); expect(s.io.events).not.toContain("resume");
});

it("an empty restricting-SID set is accepted as readback but its actual user-owner WRITE_DAC grant still refuses", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(); s.state.tokenFault = "unrestricted";
  await refused(() => s.launch(owner)); expect(s.calls.some(call => call.name === "AccessCheck" && call.args[2] === 0x40000)).toBe(true);
  expect(s.io.events).not.toContain("resume");
});

it.each(["host", "primary", "duplicate"] as const)("token %s rights are verified from native granted-access readback", async role => {
  const s = nodeAssetFake(); let changed = false;
  s.state.afterCall = (name, args, result) => { if (!changed && name === "NtQueryObject" && s.handles.get(args[0] as bigint)?.role === role) {
    changed = true; (args[2] as Buffer).writeUInt32LE(0x1f01ff, 4);
  } return result; };
  if (role === "host") await refused(() => s.prepare());
  else { const owner = await s.prepare(); await refused(() => s.launch(owner)); }
  expect(changed).toBe(true); expect(s.io.events).not.toContain("resume");
});

it("known cancellation releases asset usage only after genuine Stop/revoke and incomplete closed output", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), value = await s.launch(owner); s.io.abort.abort();
  const deadline = performance.now() + 3000;
  while (!s.io.events.includes("stop-root") || !s.io.events.includes("stop-job")) { if (performance.now() > deadline) throw Error("The actual Stop was not observed."); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
  await refused(() => owner.close());
  const done = await value.copy.completeRootOnly(value.run, s.io.abort.signal), closed = await owner.finishOutput(done, value.run, value.ref);
  const { requireWindowsCommandOutputClosed } = await import("../../app/main/agent/windows-command-output");
  expect(requireWindowsCommandOutputClosed(closed, value.ref, value.run)).toMatchObject({ complete: false, reason: "cancelled" });
  await value.copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
});

it.each(["creator", "attestation"] as const)("known asset-only cancellation during %s obtains actual Stop/revoke without poisoning ownership", async phase => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let reached = false, launch: WindowsCommandOutputLaunchRef | undefined;
  if (phase === "attestation") s.state.onCall = name => { if (name === "GetProcessId") { reached = true; s.state.current = false; } };
  const before = s.calls.length;
  const pending = copy.launchRootOnlyWithOutput(context => {
    if (phase === "creator") { reached = true; s.state.current = false; }
    return launch = owner.createSuspended(context, ["--preserve-symlinks", "--preserve-symlinks-main", "test.cjs"], s.io.options);
  }, () => undefined);
  if (phase === "creator") {
    expect(await refused(() => pending)).toMatchObject({ code: "cancelled" });
    expect(s.calls).toHaveLength(before); expect(s.io.events).not.toContain("stop-root");
  } else {
    const run = await pending;
    // The already issued root is reachable only after the real Stop and grant revocation finished.
    expect(s.io.events).toContain("stop-root"); expect(s.io.events).toContain("root-close");
    const completed = await copy.completeRootOnly(run, s.io.abort.signal);
    expect(requireWindowsCommandRootOnlyCompleted(completed, run)).toEqual({ outcome: "cancelled", exitCode: null });
    const closed = await owner.finishOutput(completed, run, launch!);
    expect(requireWindowsCommandOutputClosed(closed, launch!, run)).toMatchObject({ complete: false, reason: "cancelled" });
  }
  expect(reached).toBe(true); expect(s.io.source.control.current).toBe(true); expect(s.io.state.creates).toBe(phase === "creator" ? 0 : 1);
  expect(s.io.events).not.toContain("resume"); expect(s.io.events).toContain("stop-job");
  expect(s.fence.failure).toBeUndefined(); expect(s.io.stopFence.failure).toBeUndefined(); expect(s.io.copyFence.failure).toBeUndefined(); expect(s.io.fence.failure).toBeUndefined();
  await copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
  expect(s.handles.size).toBe(0); expect(s.assets().every(row => row.removed)).toBe(true);
});

it("arbitrary keys and serialised cancellation claims have no issuer or Stop authority", async () => {
  const key = Object.freeze({}), phase = Object.freeze({ scope: "root-only-cancellation-phase" }) as WindowsCommandRootOnlyCancellationPhaseRef;
  expect(() => issueWindowsCommandLaunchCancellation(key)).toThrow();
  expect(consumeWindowsCommandLaunchCancellation({ scope: "root-only-known-cancellation" }, phase)).toBe(false);
  const s = nodeAssetFake(), copy = await s.io.prepare();
  await refused(() => copy.launchRootOnlyWithOutput(() => { throw { scope: "root-only-known-cancellation" }; }, () => undefined));
  expect(s.io.state.creates).toBe(0); expect(s.io.events).not.toContain("resume"); expect(s.io.stopFence.failure).toBeDefined();
});

it("forged returned-root and unconsumed-creator Stop records cannot enter native cancellation or query a property getter", () => {
  const s = nodeAssetFake(); let getters = 0;
  for (const ref of [{}, { scope: "root-only-returned" }, { scope: "root-only-stopped" }, new Proxy({}, { get() { getters++; throw Error("PRIVATE getter"); } })]) {
    expect(() => requireWindowsCommandRootOnlyReturned(ref as WindowsCommandRootOnlyReturnedRef)).toThrow();
    expect(() => probeWindowsNodeToolchainReturnedCancellation(ref as WindowsCommandRootOnlyReturnedRef)).toThrow();
    expect(() => requireWindowsCommandRootOnlyUnconsumedCreatorStopped(ref, {}, s.io.profile)).toThrow();
  }
  expect(getters).toBe(0); expect(s.calls).toEqual([]); expect(s.io.calls).toEqual([]); closeWindowsCommandCreatorProfile(s.io.profile);
});

it("a genuine normally resumed root's closed Stop cannot authorise prepared-before-capture revocation", async () => {
  const s = nodeAssetFake(), binding = Object.freeze({}); let assigned = false, ended = false;
  const api = { createJob: () => 60000n, assign() { assigned = true; }, resume() {}, terminateProcess() { ended = true; }, terminateJob() { ended = true; } };
  const native = { configure() {}, assertLimits() {}, state: () => ({ total: assigned ? 1 : 0, active: assigned && !ended ? 1 : 0, pids: assigned && !ended ? [60003] : [] }),
    processId: () => 60003, threadProcessId: () => 60003, member: () => assigned, wait: (): 0 | 258 => ended ? 0 : 258, close() {} };
  const stop = createWindowsCommandRootOnlyStopOwner(binding, api, native, () => 100, { retained: [] });
  await stop.launch(() => ({ process: 60001n, thread: 60002n, pid: 60003 }), () => undefined, () => true);
  const stopped = await stop.stop(); expect(() => requireWindowsCommandRootOnlyUnconsumedCreatorStopped(stopped, binding, s.io.profile)).toThrow();
  expect(s.calls).toEqual([]); expect(s.io.calls).toEqual([]); closeWindowsCommandCreatorProfile(s.io.profile);
});

it("the returned-root lookup accepts only the exact held object and binding during its live cleanup phase", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare();
  let binding: object | undefined, held: Parameters<typeof windowsCommandRootOnlyReturnedForRoot>[0] | undefined, returned: WindowsCommandRootOnlyReturnedRef | undefined, launch: WindowsCommandOutputLaunchRef | undefined;
  const run = await copy.launchRootOnlyWithOutput(context => { binding = requireWindowsCommandRootOnlyLaunchMetadata(context).binding; return launch = owner.createSuspended(context, ["test.cjs"], s.io.options); }, root => {
    held = root; returned = windowsCommandRootOnlyReturnedForRoot(root, binding!); expect(returned).toBeDefined(); expect(requireWindowsCommandRootOnlyReturned(returned!).root).toBe(root);
    const queries = s.calls.length; expect(windowsCommandRootOnlyReturnedForRoot({ ...root }, binding!)).toBeUndefined();
    expect(() => windowsCommandRootOnlyReturnedForRoot(root, {})).toThrow(); expect(probeWindowsNodeToolchainReturnedCancellation(returned!)).toBeUndefined();
    expect(s.calls).toHaveLength(queries); expect(s.io.events).not.toContain("resume");
  });
  const queries = s.calls.length; expect(() => windowsCommandRootOnlyReturnedForRoot(held!, binding!)).toThrow(); expect(() => requireWindowsCommandRootOnlyReturned(returned!)).toThrow();
  expect(() => probeWindowsNodeToolchainReturnedCancellation(returned!)).toThrow(); expect(s.calls).toHaveLength(queries); expect(s.io.events).toContain("resume");
  s.io.state.ended = true; const done = await copy.completeRootOnly(run, s.io.abort.signal); await owner.finishOutput(done, run, launch!); await copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
});

it("a consumed genuine cancellation cannot be consumed by a forged phase or replayed into a foreign Stop owner", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let claim: unknown;
  await refused(() => copy.launchRootOnlyWithOutput(context => {
    s.state.current = false;
    try { return owner.createSuspended(context, ["test.cjs"], s.io.options); } catch (error) { claim = error; throw error; }
  }, () => undefined));
  expect(claim).toMatchObject({ scope: "root-only-known-cancellation" });
  expect(() => consumeWindowsCommandLaunchCancellation(claim, {} as WindowsCommandRootOnlyCancellationPhaseRef)).toThrow();
  expect(s.io.stopFence.failure).toBeUndefined(); await copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
  const peer = nodeAssetFake(), foreign = await peer.io.prepare();
  await refused(() => foreign.launchRootOnlyWithOutput(() => { throw claim; }, () => undefined));
  expect(peer.io.stopFence.failure).toBeDefined(); expect(peer.io.copyFence.failure).toBeDefined(); expect(peer.io.state.creates).toBe(0); expect(peer.io.events).not.toContain("resume");
});

it("a swallowed genuine claim cannot assign or resume a later returned suspended PI", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let claim: unknown;
  await refused(() => copy.launchRootOnlyWithOutput(context => {
    s.state.current = false;
    try { owner.createSuspended(context, ["test.cjs"], s.io.options); } catch (error) { claim = error; }
    return s.io.owner().createSuspended(context, "C:\\trusted\\node.exe", s.io.command);
  }, () => undefined));
  expect(claim).toMatchObject({ scope: "root-only-known-cancellation" }); expect(s.io.state.creates).toBe(1);
  expect(s.io.events).not.toContain("assign"); expect(s.io.events).not.toContain("resume"); expect(s.io.events).toContain("stop-root");
  expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined(); expect(s.io.fence.retained.length).toBeGreaterThan(0);
});

it("a swallowed first claim cannot issue a second claim for the same retired asset attempt", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare(); let claim: unknown;
  await refused(() => copy.launchRootOnlyWithOutput(context => {
    s.state.current = false;
    try { owner.createSuspended(context, ["test.cjs"], s.io.options); } catch (error) { claim = error; }
    return owner.createSuspended(context, ["second.cjs"], s.io.options);
  }, () => undefined));
  expect(claim).toMatchObject({ scope: "root-only-known-cancellation" }); expect(s.fence.failure).toBeInstanceOf(WindowsNodeToolchainCleanupError);
  expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.state.creates).toBe(0); expect(s.io.events).not.toContain("resume");
});

it.each(["GetProcessId", "LocalFree", "CloseHandle"] as const)("known task loss cannot mask an uncertain %s during actual attestation", async name => {
  const s = nodeAssetFake(), owner = await s.prepare();
  s.state.onCall = current => { if (current === name) { s.state.current = false; s.state.fault = name; } };
  await refused(() => s.launch(owner));
  expect(s.fence.failure).toBeInstanceOf(WindowsNodeToolchainCleanupError); expect(s.io.stopFence.failure).toBeDefined();
  expect(s.io.copyFence.failure).toBeDefined(); expect(s.io.events).not.toContain("resume");
  expect(s.assets().every(row => !row.removed)).toBe(true);
});

it("a Resume attempt which consumes its operation and throws cancellation-shaped failure stays terminal", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), push = s.io.events.push.bind(s.io.events);
  s.io.events.push = (...events: string[]) => {
    const length = push(...events);
    if (events.includes("resume")) { s.state.current = false; throw new ScopedCodingFileError("cancelled"); }
    return length;
  };
  await refused(() => s.launch(owner));
  expect(s.io.events.filter(event => event === "resume")).toHaveLength(1); expect(s.io.events).toContain("stop-root");
  expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined(); expect(s.io.fence.failure).toBeDefined();
  await refused(() => owner.close()); expect(s.assets().every(row => !row.removed)).toBe(true);
});

it("asset task loss cannot turn output activation uncertainty into a clean cancelled run", async () => {
  const s = nodeAssetFake(), owner = await s.prepare();
  s.io.state.onNative = name => { if (name === "ReadFile" && s.io.state.creates) { s.state.current = false; s.io.state.fault = name; } };
  await refused(() => s.launch(owner));
  expect(s.io.events).not.toContain("resume"); expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined();
  expect(s.io.fence.failure).toBeDefined(); await refused(() => owner.close()); expect(s.assets().every(row => !row.removed)).toBe(true);
});

it.each(["created", "first-read"] as const)("shared admission loss during %s obtains real stopped output without resuming", async point => {
  const s = nodeAssetFake(), owner = await s.prepare(), before = s.calls.length; let aborted = false;
  s.io.state.onNative = name => {
    if (point === "created" && name === "CreateProcessW" || point === "first-read" && name === "ReadFile" && s.io.state.creates) {
      aborted = true; s.io.source.control.current = false; s.io.abort.abort();
    }
  };
  const value = await s.launch(owner);
  expect(aborted).toBe(true); expect(s.io.events).not.toContain("resume"); expect(s.io.events.includes("assign")).toBe(point === "first-read");
  expect(s.io.events).toContain("stop-root"); expect(s.io.events).toContain("stop-job"); expect(s.io.events.filter(event => event === "root-close")).toHaveLength(3);
  expect(s.calls).toHaveLength(before); expect(s.fence.failure).toBeUndefined(); expect(s.io.stopFence.failure).toBeUndefined(); expect(s.io.copyFence.failure).toBeUndefined();
  const completed = await value.copy.completeRootOnly(value.run, s.io.abort.signal);
  expect(requireWindowsCommandRootOnlyCompleted(completed, value.run)).toEqual({ outcome: "cancelled", exitCode: null });
  const closed = await owner.finishOutput(completed, value.run, value.ref);
  expect(requireWindowsCommandOutputClosed(closed, value.ref, value.run)).toMatchObject({ complete: false, reason: "cancelled" });
  expect(s.io.pipes.every(pipe => !pipe.pending)).toBe(true); expect(s.io.output).toEqual([]);
  for (const pipe of s.io.pipes) expect(s.io.calls.some(call => call.name === "ReadFile" && call.args[0] === pipe.server)).toBe(true);
  await value.copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
});

it("task loss cannot hide an uncertain native operation after the factory writes a positive PI", async () => {
  const s = nodeAssetFake(), owner = await s.prepare();
  s.io.state.onNative = name => { if (name === "CreateProcessW") { s.io.source.control.current = false; s.io.abort.abort(); s.io.state.fault = "DeleteProcThreadAttributeList"; } };
  await refused(() => s.launch(owner));
  expect(s.io.state.creates).toBe(1); expect(s.io.events).not.toContain("assign"); expect(s.io.events).not.toContain("resume"); expect(s.io.events).not.toContain("root-close");
  expect(s.io.calls.some(call => call.name === "TerminateProcess" && call.args[0] === 50001n)).toBe(true);
  expect(s.fence.failure).toBeDefined(); expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined(); expect(s.io.fence.failure).toBeDefined();
  await refused(() => owner.close()); expect(s.assets().every(row => !row.removed)).toBe(true);
});

it("task loss cannot bypass held process/thread identity checks before the returned cleanup capability", async () => {
  const s = nodeAssetFake(), owner = await s.prepare();
  s.io.state.afterNative = (name, _args, result) => { if (name === "CreateProcessW") {
    s.io.state.returnedPid++; s.io.source.control.current = false; s.io.abort.abort();
  } return result; };
  await refused(() => s.launch(owner));
  expect(s.io.state.creates).toBe(1); expect(s.io.events).not.toContain("assign"); expect(s.io.events).not.toContain("resume"); expect(s.io.events).not.toContain("root-close");
  expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined(); await refused(() => owner.close());
});

it("a different genuine output PI cannot substitute for the registered Node asset use during cancellation", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), copy = await s.io.prepare();
  s.io.state.onNative = name => { if (name === "CreateProcessW" && s.io.state.creates === 1) { s.io.source.control.current = false; s.io.abort.abort(); } };
  await refused(() => copy.launchRootOnlyWithOutput(context => {
    owner.createSuspended(context, ["original.cjs"], s.io.options);
    s.io.state.profilePointer = 0x20010000n; s.io.state.profileFrees = 0;
    s.io.state.returnedProcess = 50011n; s.io.state.returnedThread = 50012n; s.io.state.returnedPid = 50013;
    return s.io.owner().createSuspended(context, "C:\\trusted\\node.exe", s.io.command);
  }, () => undefined));
  expect(s.io.state.creates).toBe(2); expect(s.io.events).not.toContain("assign"); expect(s.io.events).not.toContain("resume"); expect(s.io.events).not.toContain("root-close");
  expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined(); expect(s.io.fence.failure).toBeDefined();
  const terminated = s.io.calls.filter(call => call.name === "TerminateProcess").map(call => call.args[0]);
  expect(terminated).toEqual(expect.arrayContaining([50001n, 50011n])); await refused(() => owner.close());
});

it.each(["preentry-base", "preentry-subclass", "returned-base", "returned-subclass"] as const)("a genuine %s admission cleanup error is retained and cannot mint known cancellation", async phase => {
  const failure = phase.endsWith("subclass") ? new WindowsNodeToolchainCleanupError() : new WindowsCodingCleanupError(); let unsafe = false, mutations: number | undefined;
  const s = nodeAssetFake({ current: () => { if (unsafe) throw failure; return true; } }), owner = await s.prepare(), copy = await s.io.prepare();
  if (phase.startsWith("returned")) s.io.state.onNative = name => { if (name === "CreateProcessW") { mutations = s.io.source.sets(); unsafe = true; } };
  await refused(() => copy.launchRootOnlyWithOutput(context => {
    if (phase.startsWith("preentry")) { mutations = s.io.source.sets(); unsafe = true; }
    return owner.createSuspended(context, ["test.cjs"], s.io.options);
  }, () => undefined));
  expect(mutations).toBeDefined(); expect(s.io.source.sets()).toBe(mutations); expect(s.io.state.creates).toBe(phase.startsWith("returned") ? 1 : 0);
  expect(s.io.events).not.toContain("assign"); expect(s.io.events).not.toContain("resume"); expect(s.io.events).not.toContain("root-close");
  expect(s.fence.failure).toBeDefined(); expect(s.io.stopFence.failure).toBeDefined(); expect(s.io.copyFence.failure).toBeDefined();
  if (phase.startsWith("returned")) { expect(s.io.events).toContain("stop-root"); expect(s.io.calls.some(call => call.name === "TerminateProcess" && call.args[0] === 50001n)).toBe(true); }
  const queries = s.calls.length; await refused(() => owner.close()); expect(s.calls).toHaveLength(queries); expect(s.assets().every(row => !row.removed)).toBe(true);
});

it("ordinary task admission failure after a returned PI remains a known cancellation control", async () => {
  let retired = false; const s = nodeAssetFake({ current: () => { if (retired) throw Error("PRIVATE task admission failure"); return true; } }), owner = await s.prepare();
  s.io.state.onNative = name => { if (name === "CreateProcessW") retired = true; };
  const value = await s.launch(owner); expect(s.io.events).not.toContain("assign"); expect(s.io.events).not.toContain("resume"); expect(s.io.stopFence.failure).toBeUndefined(); expect(s.fence.failure).toBeUndefined();
  const completed = await value.copy.completeRootOnly(value.run, s.io.abort.signal), closed = await owner.finishOutput(completed, value.run, value.ref);
  expect(requireWindowsCommandRootOnlyCompleted(completed, value.run)).toEqual({ outcome: "cancelled", exitCode: null }); expect(requireWindowsCommandOutputClosed(closed, value.ref, value.run).complete).toBe(false);
  await value.copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(s.io.profile);
});

it.each(["before-launch", "staging", "grant"] as const)("a genuine Copy admission cleanup error during %s retains owners without an empty-job recovery", async phase => {
  const s = nodeAssetFake(), failure = new WindowsCodingCleanupError(); let unsafe = false, failedAt: number | undefined, setsAt: number | undefined, entered = false;
  const input = s.io.source.input;
  s.io.source.input = () => ({ ...input(), current: () => {
    if (unsafe) { failedAt ??= s.io.source.calls.length; setsAt ??= s.io.source.sets(); throw failure; }
    return true;
  } });
  if (phase === "staging") {
    const create = s.io.source.handlers.NtCreateFile;
    s.io.source.handlers.NtCreateFile = (...args) => { const result = create(...args); unsafe = true; return result; };
    await refused(() => s.io.prepare());
  } else {
    const copy = await s.io.prepare();
    if (phase === "before-launch") unsafe = true;
    else {
      const grant = s.io.source.handlers.SetSecurityInfo;
      s.io.source.handlers.SetSecurityInfo = (...args) => { const result = grant(...args); unsafe = true; return result; };
    }
    await refused(() => copy.launchRootOnly(() => { entered = true; throw Error("The test creator must remain unentered."); }, () => undefined));
    const queries = s.io.source.calls.length; await refused(() => copy.close()); expect(s.io.source.calls).toHaveLength(queries);
  }
  expect(failedAt).toBeDefined(); expect(setsAt).toBeDefined(); expect(s.io.source.sets()).toBe(setsAt); expect(entered).toBe(false);
  expect(s.io.copyFence.failure).toBeDefined(); expect(s.io.copyFence.retained.length).toBeGreaterThan(0); if (phase !== "before-launch") expect(s.io.source.fence.failure).toBeDefined();
  expect(s.io.source.handles.size).toBeGreaterThan(0); expect(s.io.source.calls.slice(failedAt!).some(call => ["CloseHandle", "NtSetSecurityObject", "SetSecurityInfo", "NtSetInformationFile"].includes(call.name))).toBe(false);
  expect(s.io.events).not.toContain("root-close"); expect(s.io.state.creates).toBe(0); expect(s.io.events).not.toContain("resume");
  const queries = s.io.source.calls.length; s.io.copyFence.failure = undefined; unsafe = false; await refused(() => s.io.prepare()); expect(s.io.source.calls).toHaveLength(queries);
});

it.each(["before-launch", "staging", "grant"] as const)("an ordinary Copy admission exception during %s remains cancellable with positive known cleanup", async phase => {
  const s = nodeAssetFake(); let retired = false, entered = false;
  const input = s.io.source.input; s.io.source.input = () => ({ ...input(), current: () => { if (retired) throw Error("PRIVATE task admission"); return true; } });
  if (phase === "staging") {
    const create = s.io.source.handlers.NtCreateFile;
    s.io.source.handlers.NtCreateFile = (...args) => { const result = create(...args); retired = true; return result; };
    expect(await refused(() => s.io.prepare())).toMatchObject({ code: "cancelled" });
  } else {
    const copy = await s.io.prepare();
    if (phase === "before-launch") retired = true;
    else {
      const grant = s.io.source.handlers.SetSecurityInfo;
      s.io.source.handlers.SetSecurityInfo = (...args) => { const result = grant(...args); retired = true; return result; };
    }
    expect(await refused(() => copy.launchRootOnly(() => { entered = true; throw Error("The test creator must remain unentered."); }, () => undefined))).toMatchObject({ code: "cancelled" });
    await copy.close();
  }
  expect(entered).toBe(false); expect(s.io.copyFence.failure).toBeUndefined(); expect(s.io.source.fence.failure).toBeUndefined(); expect(s.io.source.handles.size).toBe(0);
  expect(s.io.state.creates).toBe(0); expect(s.io.events).not.toContain("resume"); closeWindowsCommandCreatorProfile(s.io.profile);
});

it.each([1, 11, 25, 31])("bounded token class %s rejects an out-of-buffer SID before converting it", async kind => {
  const s = nodeAssetFake(), owner = await s.prepare(); let changed = false;
  s.state.afterCall = (name, args, result) => { if (!changed && name === "GetTokenInformation" && args[1] === kind) {
    changed = true; const b = args[2] as Buffer, offset = kind === 11 ? 8 : 0; b.writeBigUInt64LE(s.native.address(b) + BigInt(b.length), offset);
  } return result; };
  await refused(() => s.launch(owner)); expect(changed).toBe(true); expect(s.io.events).not.toContain("resume");
});

it.each([50000n, 50001n, 50002n])("a native token alias of a held Stop handle %# cannot be closed by the asset owner", async raw => {
  const s = nodeAssetFake(), owner = await s.prepare(); let changed = false;
  s.state.onCall = (name, args) => { if (!changed && name === "OpenProcessToken" && args[0] === s.io.state.returnedProcess) { changed = true; s.state.nextHandleAlias = raw; } };
  await refused(() => s.launch(owner)); expect(changed).toBe(true); expect(s.io.events).not.toContain("resume");
  expect(s.calls.some(call => call.name === "CloseHandle" && call.args[0] === raw)).toBe(false);
});

it("a swallowed native reentry during attestation retains the exact first error and prevents Resume", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(); let first: unknown;
  s.state.onCall = name => { if (name === "AccessCheck" && first === undefined) { try { void owner.close().catch(error => { first = error; }); } catch (error) { first = error; } } };
  await refused(() => s.launch(owner)); expect(first).toBeInstanceOf(WindowsNodeToolchainCleanupError); expect(s.fence.failure).toBe(first);
  const before = s.calls.length; s.fence.failure = undefined;
  expect(await refused(() => s.prepare())).toBe(first); expect(s.calls).toHaveLength(before); expect(s.io.events).not.toContain("resume");
});

it("a swallowed native reentry during preparation poisons the shared owner without a second native query", async () => {
  const s = nodeAssetFake(); let nested: Promise<unknown> | undefined, first: unknown;
  s.state.onCall = name => { if (name === "GetSecurityInfo" && !nested) nested = s.prepare().catch(error => { first = error; }); };
  const outer = await refused(() => s.prepare()); await nested;
  expect(first).toBe(outer); expect(first).toBeInstanceOf(WindowsNodeToolchainCleanupError);
  expect(s.calls.filter(call => call.name === "GetSecurityInfo")).toHaveLength(1); expect(s.io.events).not.toContain("native-create");
});

it("a native converted SID pointer inside a live descriptor allocation is retained instead of separately freed", async () => {
  const s = nodeAssetFake(); let alias: bigint | undefined;
  s.state.afterCall = (name, args, result) => { if (name === "ConvertSidToStringSidW" && s.descriptorRows.size) {
    alias = [...s.descriptorRows.keys()].at(-1)! + 32n; (args[1] as unknown[])[0] = alias;
  } return result; };
  await refused(() => s.prepare()); expect(alias).toBeDefined();
  expect(s.calls.some(call => call.name === "LocalFree" && call.args[0] === alias)).toBe(false);
});

it.each(["profile", "descriptor"] as const)("a returned string starting before a live %s cannot gain ownership of an overlapping span", async target => {
  const s = nodeAssetFake(); s.state.textBefore = target;
  await refused(() => s.prepare()); expect(s.overlappingAllocations).toHaveLength(1);
  const span = s.overlappingAllocations[0]; expect(span.raw).toBeLessThan(span.target); expect(span.raw + BigInt(span.bytes)).toBeGreaterThan(span.target);
  expect(s.calls.some(call => call.name === "LocalFree" && call.args[0] === span.raw)).toBe(false);
  expect(s.io.events).not.toContain("native-create"); expect(s.fence.retained.length).toBeGreaterThan(0);
});

it.each(["short-read", "extra-eof", "eof-status", "listing-status"])("refuses inconsistent bounded stream/completion fact %s", async fault => {
  const s = nodeAssetFake(); let changed = false;
  s.state.afterCall = (name, args, result) => {
    if (!changed && name === "NtReadFile" && fault === "short-read" && Number(args[6]) > 1) { changed = true; (args[4] as Buffer).writeBigUInt64LE(BigInt(Number(args[6]) - 1), 8); }
    else if (!changed && name === "NtReadFile" && Number(args[6]) === 1 && (fault === "extra-eof" || fault === "eof-status")) { changed = true;
      const info = args[4] as Buffer; info.writeUInt32LE(0); if (fault === "extra-eof") { info.writeBigUInt64LE(1n, 8); return 0; }
    } else if (!changed && name === "NtQueryDirectoryFile" && result === 0x80000006 && fault === "listing-status") { changed = true; (args[4] as Buffer).writeUInt32LE(0); }
    return result;
  };
  await refused(() => s.prepare()); expect(changed).toBe(true); expect(s.io.events).not.toContain("native-create");
});

it("a source-file identity differing from its directory listing cannot become a copied asset", async () => {
  const s = nodeAssetFake(); let changed = false;
  s.state.onCall = (name, args) => { const row = s.handles.get(args[0] as bigint)?.row;
    if (!changed && name === "GetFileInformationByHandle" && row?.kind === "file" && row.name.includes("\\resources\\")) { changed = true; row.id += 1000n; }
  };
  await refused(() => s.prepare()); expect(changed).toBe(true); expect(s.state.writes).toBe(0);
});

it("a foreign image cannot pass its held PI's image attestation", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(); s.state.imageMismatch = true;
  await refused(() => s.launch(owner)); expect(s.io.events).not.toContain("resume");
});

it("callback-shaped completion and structurally cloned receipts cannot release usage", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(), value = await s.launch(owner), before = s.calls.length;
  for (const fake of [{ scope: "root-only-completed" }, () => undefined]) await refused(() => owner.finishOutput(fake as WindowsCommandRootOnlyCompletedRef, value.run, value.ref));
  await refused(() => owner.finishOutput({} as WindowsCommandRootOnlyCompletedRef, {} as WindowsCommandRootOnlyRunRef, {} as WindowsCommandOutputLaunchRef));
  expect(s.calls).toHaveLength(before); await refused(() => owner.close()); await s.finish(owner, value);
});

it.each(["NtCreateFile", "NtReadFile", "NtWriteFile", "GetSecurityInfo", "LocalFree"])("unknown %s preparation retains the first failure and cannot be restored by clearing its public fence", async name => {
  const s = nodeAssetFake(); s.state.fault = name;
  const first = await refused(() => s.prepare()); expect(first).toBeInstanceOf(WindowsNodeToolchainCleanupError); expect(s.fence.retained.length).toBeGreaterThan(0);
  const before = s.calls.length; s.state.fault = ""; s.fence.failure = undefined;
  expect(await refused(() => s.prepare())).toBe(first); expect(s.calls).toHaveLength(before);
});

it("a returned file handle alias cannot be closed as a newly owned asset", async () => {
  const s = nodeAssetFake(); let armed = false;
  s.state.onCall = name => { if (!armed && name === "NtCreateFile" && s.handles.size) { armed = true; s.state.nextHandleAlias = s.handles.keys().next().value; } };
  await refused(() => s.prepare()); expect(armed).toBe(true); expect(s.state.closeCalls).toBe(1); // The independent initial host-token close only.
});

it("unknown final CloseHandle never retries, disposes another owner or permits profile deletion", async () => {
  const s = nodeAssetFake(), owner = await s.prepare(); s.state.fault = "CloseHandle";
  const first = await refused(() => owner.close()), before = s.calls.length; s.state.fault = ""; s.fence.failure = undefined;
  expect(await refused(() => owner.close())).toBe(first); expect(s.calls).toHaveLength(before); expect(() => closeWindowsCommandCreatorProfile(s.io.profile)).toThrow();
});
