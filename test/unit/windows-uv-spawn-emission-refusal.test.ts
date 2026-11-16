import { expect, it } from "vitest";
// @ts-expect-error -- bounded closed assembly observations and strict artifact parser, outside the application TypeScript build
import { inspectWindowsUvSpawnEmission, parseWindowsUvSpawnEmission, emissionLimits, emissionRefusalReasons as reasons } from "../../scripts/experimental/windows-uv-spawn-emission.mjs";

const symbols = ["ember_uv_spawn_CreateNamedPipeA", "ember_uv_spawn_CreateFileA", "ember_uv_spawn_ConnectNamedPipe", "ember_uv_spawn_CreateIoCompletionPort", "ember_uv_spawn_CreateProcessW", "ember_uv_spawn_translate_sys_error"];
const delegates = ["__imp_CreateNamedPipeA", "__imp_CreateFileA", "__imp_ConnectNamedPipe", "__imp_CreateIoCompletionPort", "__imp_CreateProcessW", "uv_translate_sys_error"];
const marker = "private-owner-path-and-operand";
function listing(transform: (body: string, index: number) => string = value => value, omitted: number[] = []) {
  return `; C:\\${marker}\\observer.asm\n_TEXT SEGMENT\n` + symbols.map((name, index) => omitted.includes(index) ? "" :
    `${name} PROC ; COMDAT\n${transform(` mov rbx, rcx\n call ${index === 5 ? "" : "QWORD PTR "}${delegates[index]}\n mov DWORD PTR [rcx], eax\n ret 0`, index)}\n${name} ENDP\n`).join("") + "_TEXT ENDS\nEND\n";
}
type Refusal = { schema: number; phase: number; reason: number; functionId: number; count: number; mask: number };
const bytes = (value: unknown) => typeof value === "string" ? Buffer.from(value) : value;
const parse = (value: unknown) => parseWindowsUvSpawnEmission(Buffer.from(JSON.stringify(value)));
function refused(value: unknown, expected: Partial<Refusal>) {
  const report = inspectWindowsUvSpawnEmission(bytes(value));
  expect(report).toMatchObject({ schema: 2, status: "refused", review: "not-reviewed" });
  const refusal = report.refusal as Refusal;
  expect(Object.keys(refusal).sort()).toEqual(["count", "functionId", "mask", "phase", "reason", "schema"]);
  expect(refusal.schema).toBe(1); expect(Number.isInteger(refusal.phase) && refusal.phase >= 0 && refusal.phase <= 6).toBe(true);
  expect(Number.isInteger(refusal.reason) && refusal.reason >= 0 && refusal.reason <= 17).toBe(true); expect(Number.isInteger(refusal.functionId) && refusal.functionId >= 0 && refusal.functionId <= 6).toBe(true);
  expect(Number.isInteger(refusal.count) && refusal.count >= 0 && refusal.count <= 10_000).toBe(true); expect(Number.isInteger(refusal.mask) && refusal.mask >= 0 && refusal.mask <= 63).toBe(true);
  expect(refusal).toMatchObject(expected); expect(parse(report)).toEqual(report); expect(Object.isFrozen(refusal)).toBe(true);
  expect(JSON.stringify(report)).not.toContain(marker); expect(JSON.stringify(report)).not.toMatch(/__imp_|CreateNamedPipe|CreateProcess|QWORD|observer\.asm|message|stack|operand/i);
  return report;
}

it("keeps the closed refusal vocabulary fixed without turning candidate syntax into admission", () => {
  expect(Object.values(reasons)).toEqual(Array.from({ length: 18 }, (_, index) => index)); expect(Object.isFrozen(reasons)).toBe(true);
  const text = listing(), report = inspectWindowsUvSpawnEmission(Buffer.from(text));
  expect(report).toMatchObject({ schema: 2, status: "candidate", review: "not-reviewed", refusal: null, listing: { bytes: Buffer.byteLength(text) } });
  expect(report.functions).toEqual(symbols.map((_, index) => ({ functionId: index + 1, delegateId: index + 1, delegateCalls: 1, callCount: 1, postDelegateCalls: 0, unknownCalls: 0, callMask: 1 << index })));
  expect(parse(report)).toEqual(report); expect(JSON.stringify(report)).not.toMatch(/native|admission|preserved/i);
});

it("reports input-type and byte-bound refusal without attempting content inspection", () => {
  for (const value of [undefined, null, marker, 7, Symbol(marker)]) {
    const raw = value === marker ? { private: marker } : value;
    refused(raw, { phase: 1, reason: reasons.inputType, functionId: 0, count: 0, mask: 0 });
  }
  for (const value of [Buffer.alloc(0), Buffer.alloc(emissionLimits.bytes + 1)]) refused(value, { phase: 1, reason: reasons.inputBytes, functionId: 0, count: 0, mask: 0 });
});

it("separates invalid UTF8, disallowed byte classes and lone carriage returns without exporting bytes", () => {
  refused(Buffer.from([0xff]), { phase: 2, reason: reasons.utf8, functionId: 0, count: 0, mask: 0 });
  refused("\f" + listing(), { phase: 2, reason: reasons.byteClass, functionId: 0, count: 1, mask: 2 });
  refused("é" + listing(), { phase: 2, reason: reasons.byteClass, functionId: 0, mask: 1 });
  refused("\f" + "é" + listing(), { phase: 2, reason: reasons.byteClass, functionId: 0, mask: 3 });
  refused("\r" + listing(), { phase: 2, reason: reasons.loneCarriage, functionId: 0, count: 1, mask: 0 });
});

it("projects only fixed BOM-prefix bits while leaving the legacy encoding refusal unchanged", () => {
  refused(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(listing())]), { phase: 2, reason: reasons.byteClass, mask: 5 });
  refused(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xff]), Buffer.from(listing())]), { phase: 2, reason: reasons.utf8, count: 0, mask: 4 });
  refused(Buffer.from([0xff, 0xfe, 0x41, 0]), { phase: 2, reason: reasons.utf8, count: 0, mask: 8 });
  refused(Buffer.from([0xfe, 0xff, 0, 0x41]), { phase: 2, reason: reasons.utf8, count: 0, mask: 16 });
});

it("preserves encoding-before-line and line-count-before-line-bytes first-refusal order, with capped counts", () => {
  refused("\f" + "x".repeat(emissionLimits.lineBytes + 1) + "\n".repeat(emissionLimits.lines + 1), { phase: 2, reason: reasons.byteClass, count: 1, mask: 2 });
  refused("x".repeat(emissionLimits.lineBytes + 1) + "\n".repeat(emissionLimits.lines + 1), { phase: 3, reason: reasons.lineCount, count: 10_000, mask: 0 });
  refused("x".repeat(20_000), { phase: 3, reason: reasons.lineBytes, count: 10_000, mask: 0 });
  refused("\f".repeat(10_001), { phase: 2, reason: reasons.byteClass, count: 10_000, mask: 2 });
  refused("\r".repeat(10_001), { phase: 2, reason: reasons.loneCarriage, count: 10_000, mask: 0 });
});

it("distinguishes nested, duplicate, unmatched, malformed and unterminated PROC boundaries", () => {
  refused(listing((body, index) => index ? body : `${marker.replaceAll("-", "_")} PROC\n${body}`), { phase: 4, reason: reasons.nestedProc, count: 0 });
  refused(listing() + `${symbols[0]} PROC\n ret\n${symbols[0]} ENDP\n`, { phase: 4, reason: reasons.duplicateProc, functionId: 1, count: 0 });
  refused(listing().replace(`${symbols[0]} ENDP`, `${symbols[1]} ENDP`), { phase: 4, reason: reasons.unmatchedEnd, count: 0 });
  refused(`${marker} PROC!\n` + listing(), { phase: 4, reason: reasons.boundarySyntax, functionId: 0, count: 0 });
  refused(listing().replace(`${symbols[5]} ENDP`, ""), { phase: 4, reason: reasons.unterminatedProc, count: 0 });
});

it("reports exact missing-wrapper bits and count rather than pretending missing wrappers made zero calls", () => {
  const report = refused(listing(undefined, [5]), { phase: 4, reason: reasons.missingWrappers, functionId: 6, count: 1, mask: 32 });
  expect(report.functions.every((item: { delegateId: number; callCount: number }) => item.delegateId === 0 && item.callCount === 0)).toBe(true);
  refused("; " + marker, { phase: 4, reason: reasons.missingWrappers, functionId: 1, count: 6, mask: 63 });
});

it("distinguishes unsupported call syntax from unknown or external control transfer", () => {
  refused(listing((body, index) => index ? body : `${body}\n label: call ${marker}`), { phase: 5, reason: reasons.callSyntax, functionId: 1, count: 0 });
  refused(listing((body, index) => index ? body : `${body}\n jmp ${marker}`), { phase: 5, reason: reasons.externalTransfer, functionId: 1, count: 0 });
  refused(listing((body, index) => index ? body : `${body}\n jmp QWORD PTR [rax]`), { phase: 5, reason: reasons.externalTransfer, functionId: 1, count: 0 });
});

it("keeps all transfer refusals ahead of the final call-contract gate across later functions", () => {
  for (const [instruction, reason] of [[`label: call ${marker}`, reasons.callSyntax], [`jmp ${marker}`, reasons.externalTransfer]] as const) {
    const text = listing((body, index) => index === 0 ? body.replace(` call QWORD PTR ${delegates[0]}`, " nop") : index === 1 ? `${body}\n ${instruction}` : body);
    const report = refused(text, { phase: 5, reason, functionId: 2, count: 0 });
    expect(report.functions.every((item: { delegateId: number; callCount: number }) => item.delegateId === 0 && item.callCount === 0)).toBe(true);
  }
});

it.each([
  ["missing", 0, 37], ["repeat", 2, 14], ["post-helper", 2, 28], ["wrong-known", 1, 33], ["unknown-only", 1, 49],
] as const)("projects the existing call-contract failure without changing the legacy records: %s", (mode, count, mask) => {
  const text = listing((body, index) => {
    if (index) return body;
    if (mode === "missing") return body.replace(` call QWORD PTR ${delegates[0]}`, " nop");
    if (mode === "repeat") return body + `\n call QWORD PTR ${delegates[0]}`;
    if (mode === "post-helper") return body + `\n call ${marker}`;
    return body.replace(`call QWORD PTR ${delegates[0]}`, `call ${mode === "wrong-known" ? "QWORD PTR " + delegates[1] : marker}`);
  });
  const report = refused(text, { phase: 6, reason: reasons.callContract, functionId: 1, count, mask });
  expect(report.functions[0].callCount).toBe(count); expect(report.functions.slice(1).every((item: { delegateCalls: number }) => item.delegateCalls === 1)).toBe(true);
});

it("contains exceptional Buffer decoding as a fixed internal/unknown reason without inspecting the thrown object", () => {
  let reads = 0; const trap = () => { reads++; throw new Error(marker); };
  const foreign = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  const input = Buffer.from(listing()); Object.defineProperty(input, "toString", { value() { throw foreign; } });
  refused(input, { phase: 0, reason: reasons.internal, functionId: 0, count: 0, mask: 0 }); expect(reads).toBe(0);
});

it("keeps a refused unknown sentinel parser-valid while never making it a candidate", () => {
  const report = refused(Buffer.from([0xff]), { phase: 2, reason: reasons.utf8 });
  const value = JSON.parse(JSON.stringify(report)); value.refusal = { schema: 1, phase: 0, reason: reasons.unknown, functionId: 0, count: 0, mask: 0 };
  expect(parse(value)).toEqual(value); expect(parse(value).status).toBe("refused");
});

it("rejects legacy schemas, expanded/private fields and malformed refusal counter/mask/phase projections", () => {
  const report = refused("\f" + listing(), { phase: 2, reason: reasons.byteClass });
  const clone = () => JSON.parse(JSON.stringify(report));
  for (const mutate of [
    (value: ReturnType<typeof clone>) => { value.schema = 1; delete value.refusal; }, (value: ReturnType<typeof clone>) => { value.refusal = null; },
    (value: ReturnType<typeof clone>) => { value.refusal.schema = 2; }, (value: ReturnType<typeof clone>) => { value.refusal.private = marker; },
    (value: ReturnType<typeof clone>) => { value.refusal.phase = 1; }, (value: ReturnType<typeof clone>) => { value.refusal.reason = 18; },
    (value: ReturnType<typeof clone>) => { value.refusal.functionId = 7; }, (value: ReturnType<typeof clone>) => { value.refusal.count = 10_001; },
    (value: ReturnType<typeof clone>) => { value.refusal.count = -1; }, (value: ReturnType<typeof clone>) => { value.refusal.count = 0.5; },
    (value: ReturnType<typeof clone>) => { value.refusal.mask = 64; }, (value: ReturnType<typeof clone>) => { value.refusal.mask = 32; },
    (value: ReturnType<typeof clone>) => { value.refusal.mask = marker; },
  ]) { const value = clone(); mutate(value); expect(() => parse(value)).toThrow("fixed observer emission metadata was refused"); }
  const input = refused(Buffer.alloc(0), { phase: 1, reason: reasons.inputBytes });
  const changed = JSON.parse(JSON.stringify(input)); changed.refusal.count = 1;
  expect(() => parse(changed)).toThrow("fixed observer emission metadata was refused");
  const utf8 = refused(Buffer.from([0xff]), { phase: 2, reason: reasons.utf8 });
  const badMask = JSON.parse(JSON.stringify(utf8)); badMask.refusal.mask = 1; expect(() => parse(badMask)).toThrow("fixed observer emission metadata was refused");
  const candidate = inspectWindowsUvSpawnEmission(Buffer.from(listing())), altered = JSON.parse(JSON.stringify(candidate)); altered.refusal = report.refusal;
  expect(() => parse(altered)).toThrow("fixed observer emission metadata was refused");
});

it("refuses diagnostic facts that contradict the preserved legacy records or missing-wrapper mask", () => {
  const contract = refused(listing((body, index) => index ? body : body + `\n call ${marker}`), { phase: 6, reason: reasons.callContract, functionId: 1, count: 2, mask: 28 });
  for (const mutate of [
    (value: typeof contract) => { value.refusal.count = 1; }, (value: typeof contract) => { value.refusal.mask = 4; },
    (value: typeof contract) => { value.refusal.functionId = 2; }, (value: typeof contract) => { value.functions[0].callCount = 1; },
  ]) { const value = JSON.parse(JSON.stringify(contract)); mutate(value); expect(() => parse(value)).toThrow("fixed observer emission metadata was refused"); }
  const missing = refused(listing(undefined, [5]), { phase: 4, reason: reasons.missingWrappers });
  for (const patch of [{ count: 2 }, { mask: 16 }, { functionId: 1 }, { mask: 0, count: 0, functionId: 0 }]) {
    const value = JSON.parse(JSON.stringify(missing)); Object.assign(value.refusal, patch); expect(() => parse(value)).toThrow("fixed observer emission metadata was refused");
  }
  const early = refused(Buffer.from([0xff]), { phase: 2, reason: reasons.utf8 });
  const value = JSON.parse(JSON.stringify(early)); value.functions[0].callCount = value.functions[0].unknownCalls = 1;
  expect(() => parse(value)).toThrow("fixed observer emission metadata was refused");
});

it("requires observed byte and line-bound counters to fit the listing byte count", () => {
  for (const [input, reason, count] of [["\f", reasons.byteClass, 1], ["\r", reasons.loneCarriage, 1], ["x".repeat(1025), reasons.lineBytes, 1025]] as const) {
    const report = refused(input, { reason, count });
    expect(report.listing.bytes).toBe(count);
    const overCount = JSON.parse(JSON.stringify(report)); overCount.refusal.count = report.listing.bytes + 1;
    expect(() => parse(overCount)).toThrow("fixed observer emission metadata was refused");
    const underBytes = JSON.parse(JSON.stringify(report)); underBytes.listing.bytes = report.refusal.count - 1;
    expect(() => parse(underBytes)).toThrow("fixed observer emission metadata was refused");
  }
  const capped = refused("\n".repeat(10_000), { phase: 3, reason: reasons.lineCount, count: 10_000 });
  expect(capped.listing.bytes).toBe(10_000);
  const impossible = JSON.parse(JSON.stringify(capped)); impossible.listing.bytes = 9999;
  expect(() => parse(impossible)).toThrow("fixed observer emission metadata was refused");
});

it("requires boundary and known-function IDs to agree with the closed completed-wrapper mask", () => {
  const boundary = refused(`${marker} PROC!\n` + listing(), { phase: 4, reason: reasons.boundarySyntax, functionId: 0 });
  for (const functionId of [1, 6]) {
    const value = JSON.parse(JSON.stringify(boundary)); value.refusal.functionId = functionId;
    expect(() => parse(value)).toThrow("fixed observer emission metadata was refused");
  }
  const duplicate = refused(listing() + `${symbols[0]} PROC\n ret\n${symbols[0]} ENDP\n`, { phase: 4, reason: reasons.duplicateProc, functionId: 1, mask: 63 });
  const noClosedDuplicate = JSON.parse(JSON.stringify(duplicate)); noClosedDuplicate.refusal.mask = 62;
  expect(() => parse(noClosedDuplicate)).toThrow("fixed observer emission metadata was refused");
  const nested = refused(listing((body, index) => index ? body : `private_source PROC\n${body}`), { phase: 4, reason: reasons.nestedProc, functionId: 1, mask: 0 });
  const activeAlreadyClosed = JSON.parse(JSON.stringify(nested)); activeAlreadyClosed.refusal.mask = 1;
  expect(() => parse(activeAlreadyClosed)).toThrow("fixed observer emission metadata was refused");
  const unterminated = refused(listing().replace(`${symbols[5]} ENDP`, ""), { phase: 4, reason: reasons.unterminatedProc, functionId: 6, mask: 31 });
  const unfinishedAlreadyClosed = JSON.parse(JSON.stringify(unterminated)); unfinishedAlreadyClosed.refusal.mask = 63;
  expect(() => parse(unfinishedAlreadyClosed)).toThrow("fixed observer emission metadata was refused");
  refused(`private_source PROC\n ret\nprivate_source ENDP\nprivate_source PROC\n ret\nprivate_source ENDP\n` + listing(),
    { phase: 4, reason: reasons.duplicateProc, functionId: 0, mask: 0 });
});

it("requires enough bytes for a known BOM prefix and an invalid following byte when UTF8 itself failed", () => {
  const utf8 = refused(Buffer.from([0xef, 0xbb, 0xbf, 0xff]), { phase: 2, reason: reasons.utf8, mask: 4 });
  expect(utf8.listing.bytes).toBe(4);
  for (const byteCount of [1, 2, 3]) {
    const value = JSON.parse(JSON.stringify(utf8)); value.listing.bytes = byteCount;
    expect(() => parse(value)).toThrow("fixed observer emission metadata was refused");
  }
  for (const [prefix, mask] of [[[0xff, 0xfe], 8], [[0xfe, 0xff], 16]] as const) {
    const report = refused(Buffer.from(prefix), { phase: 2, reason: reasons.utf8, mask }); expect(report.listing.bytes).toBe(2);
    const value = JSON.parse(JSON.stringify(report)); value.listing.bytes = 1;
    expect(() => parse(value)).toThrow("fixed observer emission metadata was refused");
  }
});

it("keeps DEL in the original byte-above126 class and requires a separate bad control byte beyond a UTF8 BOM", () => {
  refused(Buffer.from([127]), { phase: 2, reason: reasons.byteClass, count: 1, mask: 1 });
  const mixedClasses = refused(Buffer.from([127, 12]), { phase: 2, reason: reasons.byteClass, count: 2, mask: 3 });
  const missingSecondByte = JSON.parse(JSON.stringify(mixedClasses)); missingSecondByte.refusal.count = 1;
  expect(() => parse(missingSecondByte)).toThrow("fixed observer emission metadata was refused");
  const bomAndControl = refused(Buffer.from([0xef, 0xbb, 0xbf, 12]), { phase: 2, reason: reasons.byteClass, count: 4, mask: 7 });
  const impossible = JSON.parse(JSON.stringify(bomAndControl)); impossible.refusal.count = 3;
  expect(() => parse(impossible)).toThrow("fixed observer emission metadata was refused");
});
