import { describe, expect, it } from "vitest";
import { parseWindowsCommandCreatorOwnerReport, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC } from "../fixtures/windows-command-creator-owner-report";
import { parseWindowsCommandCopyReport, WINDOWS_COMMAND_COPY_REPORT_MAGIC } from "../fixtures/windows-command-copy-report";

type Mode = "useful" | "writer" | "revoked" | "acl-host";
const modes: readonly Mode[] = ["useful", "writer", "revoked", "acl-host"];
const numericMode = (mode: Mode) => modes.indexOf(mode) + 1;
const encode = (words: readonly number[]) => {
  const bytes = Buffer.alloc(WINDOWS_COMMAND_CREATOR_OWNER_REPORT_BYTES);
  words.forEach((word, index) => bytes.writeUInt32LE(word >>> 0, index * 4));
  return bytes;
};
const complete = (mode: Mode = "useful") => {
  const numeric = numericMode(mode), words = Array<number>(32).fill(0);
  words.splice(0, 16, WINDOWS_COMMAND_CREATOR_OWNER_REPORT_MAGIC, 2, numeric, 1, mode === "writer" ? 13 : 19,
    mode === "useful" ? 0xfff : mode === "writer" ? 0xf01 : mode === "revoked" ? 0xf07 : 0,
    ...Array<number>(4).fill(mode === "acl-host" ? 0 : 5), ...Array<number>(3).fill(mode === "revoked" ? 5 : 0), 0, mode === "writer" ? 1 : 0, 0);
  if (mode === "useful" || mode === "acl-host") words.splice(16, 10, 3, 15, mode === "acl-host" ? 15 : 0, 15,
    ...Array<number>(4).fill(mode === "useful" ? 5 : 0), 15, 3);
  return words;
};
const mutate = (words: readonly number[], offset: number, value: number) => { const next = [...words]; next[offset] = value; return next; };
const refusal = (words: readonly number[], mode: Mode = "useful") => expect(() => parseWindowsCommandCreatorOwnerReport(encode(words), mode)).toThrow("numeric contract");
const legacyFailure = (mode: "useful" | "writer" | "revoked", operation: number) => {
  const words = complete(mode); if (mode !== "useful" || operation <= 4) words.fill(0, 16);
  words[3] = 2; words[4] = operation; words[13] = 32; words[14] = 0;
  if (operation <= 4) {
    words[5] = 0; words.fill(0, 6, 13);
    for (let probe = 1; probe < operation; probe++) { words[5] |= 0x100 << (probe - 1); words[5 + probe] = 5; }
    if (operation > 0) words[5 + operation] = 32;
  } else {
    words[5] = 0xf00;
    if (mode === "useful") words[5] |= (1 << (operation - 5)) - 1;
    if (mode === "revoked") {
      words.fill(0, 10, 13); words[5] |= (1 << (operation - 16)) - 1;
      for (let probe = 16; probe < operation; probe++) words[probe - 6] = 5;
      words[operation - 6] = 32;
    }
  }
  return words;
};
const aclFailure = (mode: "useful" | "acl-host", operation: number, error = 32, unexpectedGrant = false) => {
  const words = complete(mode); words[3] = 2; words[4] = operation; words[13] = unexpectedGrant ? 13 : error;
  if (mode === "useful") words[5] = 0xf00;
  if (operation === 26 || operation === 27) { words[25] = operation - 26; return words; }
  words.fill(0, 16);
  if (operation === 20 || operation === 21) { words[16] = operation - 20; return words; }
  const index = operation - 22, prefix = (1 << index) - 1, current = 1 << index;
  words[16] = 3; words[17] = prefix | current; words[24] = prefix;
  for (let prior = 0; prior < index; prior++) words[20 + prior] = mode === "useful" ? 5 : 0;
  words[18] = mode === "acl-host" ? prefix : unexpectedGrant ? current : 0; words[19] = words[17];
  words[20 + index] = unexpectedGrant ? 0 : error;
  return words;
};

describe("Closed creator-owner command-copy numeric reports", () => {
  it.each(modes)("decodes the exact completed %s mode without importing legacy magic or schema", mode => {
    const parsed = parseWindowsCommandCreatorOwnerReport(encode(complete(mode)), mode);
    expect(parsed).toMatchObject({ mode: numericMode(mode), status: 1, operation: mode === "writer" ? 13 : 19, failedOperationError: 0 });
    expect(parsed.acl).toEqual(mode === "useful" ? { createdMask: 3, attemptMask: 15, grantedMask: 0, closedMask: 15, errors: [5, 5, 5, 5], validatedMask: 15, removedMask: 3 }
      : mode === "acl-host" ? { createdMask: 3, attemptMask: 15, grantedMask: 15, closedMask: 15, errors: [0, 0, 0, 0], validatedMask: 15, removedMask: 3 }
        : { createdMask: 0, attemptMask: 0, grantedMask: 0, closedMask: 0, errors: [0, 0, 0, 0], validatedMask: 0, removedMask: 0 });
  });

  it.each(["useful", "writer", "revoked"] as const)("preserves the existing decoded facts for completed %s", mode => {
    const words = complete(mode), legacy = encode(words).subarray(0, 64); legacy.writeUInt32LE(WINDOWS_COMMAND_COPY_REPORT_MAGIC, 0); legacy.writeUInt32LE(1, 4);
    const original = parseWindowsCommandCopyReport(legacy, mode), { acl, ...facts } = parseWindowsCommandCreatorOwnerReport(encode(words), mode);
    expect(facts).toEqual(original); expect(acl).toBeDefined();
  });

  it.each(Array.from({ length: 13 }, (_, operation) => operation))("keeps legacy useful failure %i and forbids invented later ACL progress", operation => {
    const words = legacyFailure("useful", operation), parsed = parseWindowsCommandCreatorOwnerReport(encode(words), "useful");
    expect(parsed).toMatchObject({ status: 2, operation, failedOperationError: 32,
      acl: { createdMask: operation <= 4 ? 0 : 3, attemptMask: operation <= 4 ? 0 : 15, validatedMask: operation <= 4 ? 0 : 15, removedMask: operation <= 4 ? 0 : 3 } });
    refusal(mutate(words, 16, 1));
  });

  it.each([...[0, 1, 2, 3, 4, 13].map(operation => ["writer", operation] as const), ...[0, 1, 2, 3, 4, 16, 17, 18].map(operation => ["revoked", operation] as const)])(
    "retains the original %s failure operation %i", (mode, operation) => {
      const words = legacyFailure(mode, operation), legacy = encode(words).subarray(0, 64); legacy.writeUInt32LE(WINDOWS_COMMAND_COPY_REPORT_MAGIC, 0); legacy.writeUInt32LE(1, 4);
      const { acl, ...facts } = parseWindowsCommandCreatorOwnerReport(encode(words), mode);
      expect(facts).toEqual(parseWindowsCommandCopyReport(legacy, mode)); expect(acl.createdMask).toBe(0);
    });

  it.each(["useful", "acl-host"] as const)("reports known creation failures without later permission attempts in %s", mode => {
    for (const operation of [20, 21]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure(mode, operation)), mode);
      expect(parsed).toMatchObject({ status: 2, operation, failedOperationError: 32,
        acl: { createdMask: operation - 20, attemptMask: 0, grantedMask: 0, closedMask: 0, errors: [0, 0, 0, 0], validatedMask: 0, removedMask: 0 } });
    }
  });

  it.each([22, 23, 24, 25])("keeps a useful wrong-error refusal at ACL operation %i, including honest code0", operation => {
    for (const error of [0, 32, 0xffffffff]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure("useful", operation, error)), "useful");
      expect(parsed.failedOperationError).toBe(error); expect(parsed.acl.errors[operation - 22]).toBe(error);
      expect(parsed.acl.grantedMask).toBe(0); expect(parsed.acl.validatedMask).toBe((1 << (operation - 22)) - 1);
    }
  });

  it.each([22, 23, 24, 25])("records an unexpected useful ACL grant only after its known close at operation %i", operation => {
    const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure("useful", operation, 0, true)), "useful"), bit = 1 << (operation - 22);
    expect(parsed.failedOperationError).toBe(13); expect(parsed.acl.grantedMask).toBe(bit); expect(parsed.acl.closedMask).toBe((bit << 1) - 1);
  });

  it.each([22, 23, 24, 25])("records ordinary-host refusal after only the prior validated grants at operation %i", operation => {
    for (const error of [0, 5, 32, 0xffffffff]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure("acl-host", operation, error)), "acl-host"), prefix = (1 << (operation - 22)) - 1;
      expect(parsed.acl).toMatchObject({ grantedMask: prefix, closedMask: (prefix << 1) | 1, validatedMask: prefix });
      expect(parsed.acl.errors[operation - 22]).toBe(error);
    }
  });

  it.each(["useful", "acl-host"] as const)("reports cleanup failures after the complete ACL proof in %s", mode => {
    for (const operation of [26, 27]) {
      const parsed = parseWindowsCommandCreatorOwnerReport(encode(aclFailure(mode, operation, 0)), mode);
      expect(parsed).toMatchObject({ status: 2, operation, failedOperationError: 0, features: mode === "useful" ? 0xf00 : 0,
        acl: { createdMask: 3, attemptMask: 15, closedMask: 15, validatedMask: 15, removedMask: operation - 26 } });
      expect(parsed.acl.errors).toEqual(Array<number>(4).fill(mode === "useful" ? 5 : 0));
    }
  });

  it("counts denied right attempts as finished ownership without claiming four native handle closes", () => {
    const parsed = parseWindowsCommandCreatorOwnerReport(encode(complete()), "useful");
    expect(parsed.acl.grantedMask).toBe(0); expect(parsed.acl.closedMask).toBe(15); expect(parsed.acl.attemptMask).toBe(15);
  });

  it.each([0, 64, 127, 129, 4096])("rejects a nonexact %i-byte report", length => expect(() => parseWindowsCommandCreatorOwnerReport(Buffer.alloc(length), "useful")).toThrow("numeric contract"));

  it("rejects non-Buffer input, unsupported modes and foreign mode/schema/magic", () => {
    expect(() => parseWindowsCommandCreatorOwnerReport(new Uint8Array(128) as Buffer, "useful")).toThrow("numeric contract");
    expect(() => parseWindowsCommandCreatorOwnerReport(encode(complete()), "foreign" as Mode)).toThrow("numeric contract");
    refusal(mutate(complete(), 0, WINDOWS_COMMAND_COPY_REPORT_MAGIC)); refusal(mutate(complete(), 1, 1));
    for (const mode of modes) for (const other of modes) if (mode !== other) refusal(complete(other), mode);
  });

  it.each([15, 26, 27, 28, 29, 30, 31])("rejects nonzero reserved field %i", offset => refusal(mutate(complete(), offset, 1)));

  it.each([[3, 0], [3, 3], [4, 20], [5, 0xffe], [5, 0x1fff], [6, 0], [7, 32], [8, 3], [9, 0], [10, 5], [11, 5], [12, 5], [13, 1], [14, 1]])(
    "rejects contradictory completed legacy fact %i=%i", (offset, value) => refusal(mutate(complete(), offset, value)));

  it.each([[16, 0], [16, 1], [16, 7], [17, 7], [17, 31], [18, 1], [19, 1], [20, 0], [21, 32], [22, 0], [23, 0], [24, 7], [24, 16], [25, 0], [25, 1], [25, 7]])(
    "rejects contradictory completed useful ACL fact %i=%i", (offset, value) => refusal(mutate(complete(), offset, value)));

  it.each([[5, 1], [6, 5], [7, 5], [8, 5], [9, 5], [10, 1], [11, 1], [12, 1], [13, 1], [14, 1], [16, 1], [17, 7], [18, 7], [19, 7], [20, 5], [21, 5], [22, 5], [23, 5], [24, 7], [25, 0], [25, 1], [25, 7]])(
    "rejects a forged completed ordinary ACL control fact %i=%i", (offset, value) => refusal(mutate(complete("acl-host"), offset, value), "acl-host"));

  it.each(["writer", "revoked"] as const)("rejects any ACL progress added to the unchanged %s mode", mode => {
    for (let offset = 16; offset <= 25; offset++) refusal(mutate(complete(mode), offset, 1), mode);
  });

  it.each(["useful", "acl-host"] as const)("rejects impossible creation-failure progress in %s", mode => {
    refusal(mutate(aclFailure(mode, 20), 16, 1), mode); refusal(mutate(aclFailure(mode, 21), 16, 0), mode);
    for (const offset of [17, 18, 19, 20, 21, 22, 23, 24, 25]) refusal(mutate(aclFailure(mode, 21), offset, 1), mode);
  });

  it.each(["useful", "acl-host"] as const)("rejects skipped, repeated and future right-attempt progress in %s", mode => {
    const words = aclFailure(mode, 24);
    for (const [offset, value] of [[16, 1], [17, 3], [17, 15], [17, 16], [24, 1], [24, 7], [24, 2], [23, 32]]) refusal(mutate(words, offset, value), mode);
  });

  it.each(["useful", "acl-host"] as const)("rejects premature or skipped cleanup progress in %s", mode => {
    refusal(mutate(aclFailure(mode, 26), 25, 1), mode); refusal(mutate(aclFailure(mode, 27), 25, 0), mode); refusal(mutate(aclFailure(mode, 27), 25, 3), mode);
    for (const offset of [16, 17, 19, 24]) refusal(mutate(aclFailure(mode, 26), offset, 0), mode);
    refusal(mutate(aclFailure(mode, 24), 25, 1), mode);
  });

  it("keeps native refusal errors consistent and distinguishes an unexpected grant from GetLastError", () => {
    for (const mode of ["useful", "acl-host"] as const) refusal(mutate(aclFailure(mode, 24, 32), 13, 0), mode);
    refusal(mutate(aclFailure("useful", 24, 0, true), 13, 0));
    refusal(mutate(aclFailure("useful", 24, 0, true), 13, 5));
  });

  it("does not label an expected useful denial or successful host grant as the failed current attempt", () => {
    for (const operation of [22, 23, 24, 25]) {
      refusal(aclFailure("useful", operation, 5));
      const words = aclFailure("acl-host", operation, 0), bit = 1 << (operation - 22);
      words[18] |= bit; words[19] |= bit; refusal(words, "acl-host");
    }
  });

  it("rejects unknown close ownership and grants on unattempted or already validated-denied slots", () => {
    const granted = aclFailure("useful", 24, 0, true); refusal(mutate(granted, 19, 0));
    const host = aclFailure("acl-host", 24); refusal(mutate(host, 19, 1), "acl-host");
    const wrong = aclFailure("useful", 24); wrong[18] = 1; wrong[19] = 1; refusal(wrong);
    const future = aclFailure("acl-host", 24); future[18] = 11; future[19] = 11; refusal(future, "acl-host");
  });

  it("preserves raw finite errors without payload and returns a detached deeply frozen observation", () => {
    const bytes = encode(aclFailure("useful", 24, 0xffffffff)), parsed = parseWindowsCommandCreatorOwnerReport(bytes, "useful");
    bytes.fill(0x41); expect(parsed.failedOperationError).toBe(0xffffffff); expect(parsed.acl.errors).toEqual([5, 5, 0xffffffff, 0]);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.acl)).toBe(true); expect(Object.isFrozen(parsed.acl.errors)).toBe(true);
    expect(Reflect.set(parsed.acl.errors, "0", 0)).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("AAAA");
    expect(() => parseWindowsCommandCreatorOwnerReport(Buffer.from("PRIVATE PATH AND CONTENT"), "useful")).toThrow("numeric contract");
  });
});
