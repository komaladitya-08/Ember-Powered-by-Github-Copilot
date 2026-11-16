import { expect, it } from "vitest";
// @ts-expect-error -- portable bounded assembly observations and strict schema2 parser, outside the application TypeScript build
import { inspectWindowsUvSpawnEmission, parseWindowsUvSpawnEmission, emissionRefusalReasons as reasons } from "../../scripts/experimental/windows-uv-spawn-emission.mjs";

const symbols = ["ember_uv_spawn_CreateNamedPipeA", "ember_uv_spawn_CreateFileA", "ember_uv_spawn_ConnectNamedPipe", "ember_uv_spawn_CreateIoCompletionPort", "ember_uv_spawn_CreateProcessW", "ember_uv_spawn_translate_sys_error"];
const delegates = ["__imp_CreateNamedPipeA", "__imp_CreateFileA", "__imp_ConnectNamedPipe", "__imp_CreateIoCompletionPort", "__imp_CreateProcessW", "uv_translate_sys_error"];
const marker = "private_external_canary";
function listing(prefix = "", transform: (body: string, index: number) => string = value => value, omit: number[] = [], between = "") {
  return `${prefix}\n; C:\\${marker}\\public-source.asm\n_TEXT SEGMENT\n` + symbols.map((name, index) => omit.includes(index) ? "" :
    `${name} PROC ; COMDAT\n${transform(` mov rbx, rcx\n call ${index === 5 ? "" : "QWORD PTR "}${delegates[index]}\n mov DWORD PTR [rcx], eax\n ret 0`, index)}\n${name} ENDP\n`).join(between) + "_TEXT ENDS\nEND\n";
}
const counts = symbols.map((_, index) => ({ functionId: index + 1, delegateId: index + 1, delegateCalls: 1, callCount: 1, postDelegateCalls: 0, unknownCalls: 0, callMask: 1 << index }));
const inspect = (text: string) => inspectWindowsUvSpawnEmission(Buffer.from(text));
const parse = (value: unknown) => parseWindowsUvSpawnEmission(Buffer.from(JSON.stringify(value)));
function closed(report: ReturnType<typeof inspect>) {
  expect(Object.keys(report).sort()).toEqual(["functions", "issuer", "listing", "refusal", "review", "schema", "status"]);
  expect(report.schema).toBe(2); expect(report.review).toBe("not-reviewed"); expect(parse(report)).toEqual(report);
  expect(JSON.stringify(report)).not.toContain(marker); expect(JSON.stringify(report)).not.toMatch(/EXTRN|EXTERN|__imp_|CreateNamedPipe|CreateProcess|public-source\.asm|QWORD|rawLine|operand|native|admission/i);
  return report;
}
function candidate(text: string) {
  const report = closed(inspect(text)); expect(report.status).toBe("candidate"); expect(report.refusal).toBeNull(); expect(report.functions).toEqual(counts); return report;
}
function refused(text: string, expected: object) {
  const report = closed(inspect(text)); expect(report.status).toBe("refused"); expect(report.refusal).toMatchObject({ schema: 1, ...expected }); return report;
}

it.each(["EXTRN", "EXTERN"])("accepts only a declaration, without opening a body or adding calls: %s", keyword => {
  const original = candidate(listing());
  const report = candidate(listing(`${keyword} ${marker}:PROC`));
  expect(report.functions).toEqual(original.functions); expect(report.listing.bytes).toBeGreaterThan(original.listing.bytes);
});

it.each([
  "EXTRN private_external_canary : PROC", "\tEXTRN\tprivate_external_canary\t:\tPROC\t", "EXTERN  private_external_canary: PROC",
  "EXTRN __imp_CreateNamedPipeA:PROC", "EXTERN uv_translate_sys_error:PROC", "EXTRN ?private_external_canary@@YAHH@Z:PROC",
  "EXTERN @private_external_canary$1:PROC", "EXTRN .private_external_canary:PROC", "EXTERN _private_external_canary1:PROC",
])("recognises the fixed single-symbol whitespace/identifier subset: %s", declaration => {
  candidate(listing(declaration));
});

it("keeps comments, repeated declarations and declarations between complete bodies outside the body/call ledger", () => {
  const declaration = `EXTRN ${marker}:PROC ; ${marker} tail comment`;
  candidate(listing(declaration + "\n" + declaration, undefined, [], declaration + "\n") + declaration + "\n");
  candidate(listing(symbols.map(name => `EXTERN ${name}:PROC`).join("\n")));
});

it("does not promote ordinary external data declarations into procedure bodies or calls", () => {
  candidate(listing(`EXTRN _tls_index:DWORD\nEXTRN ${marker}:QWORD`));
  refused(`EXTRN ${symbols[0]}:DWORD\n`, { phase: 4, reason: reasons.missingWrappers, functionId: 1, count: 6, mask: 63 });
});

it("cannot replace any required fixed PROC/ENDP body with an external declaration", () => {
  const declarations = symbols.map(name => `EXTRN ${name}:PROC`).join("\n");
  const allMissing = refused(declarations, { phase: 4, reason: reasons.missingWrappers, functionId: 1, count: 6, mask: 63 });
  expect(allMissing.functions.every((item: { delegateId: number; callCount: number }) => item.delegateId === 0 && item.callCount === 0)).toBe(true);
  refused(listing(`EXTERN ${symbols[5]}:PROC`, undefined, [5]), { phase: 4, reason: reasons.missingWrappers, functionId: 6, count: 1, mask: 32 });
});

it("does not authorize an unknown called helper merely because it has a supported external declaration", () => {
  const report = refused(listing(`EXTRN ${marker}:PROC`, (body, index) => index ? body : body + `\n call ${marker}`),
    { phase: 6, reason: reasons.callContract, functionId: 1, count: 2, mask: 28 });
  expect(report.functions[0]).toMatchObject({ delegateId: 0, callCount: 2, delegateCalls: 1, unknownCalls: 1, postDelegateCalls: 1 });
});

it("uses the same declaration rule while reporting later transfer failures without weakening those checks", () => {
  refused(listing(`EXTERN ${marker}:PROC`, (body, index) => index === 1 ? body + `\n jmp ${marker}` : body),
    { phase: 5, reason: reasons.externalTransfer, functionId: 2, count: 0 });
  refused(listing(`EXTRN ${marker}:PROC`, (body, index) => index === 1 ? body + `\n label: call ${marker}` : body),
    { phase: 5, reason: reasons.callSyntax, functionId: 2, count: 0 });
});

it.each([
  "EXTRN C private_external_canary:PROC", "EXTERN STDCALL private_external_canary:PROC", "EXTRN private_external_canary(alt):PROC",
  "EXTRN first:PROC, second:PROC", "EXTERN first:PROC,second:DWORD", "EXTRN private_external_canary:PROC PUBLIC",
  "EXTERN private_external_canary:PROC FRAME", "EXTRN private_external_canary:PROC [rax]", "EXTRN D:\\private_external_canary\\file:PROC",
  "EXTRN [rax]:PROC", "EXTERN private_external_canary::PROC", "EXTRN :PROC", "EXTERN private_external_canary PROC",
  "EXTERNDEF private_external_canary:PROC", "extrn private_external_canary:PROC", "Extern private_external_canary:PROC",
  "EXTRNprivate_external_canary:PROC", "EXTRN 9private_external_canary:PROC", "EXTERN private-external-canary:PROC",
  "call private_external_canary:PROC", "JMP private_external_canary:PROC",
])("keeps unsupported single-line PROC forms refused without a generic PROC-line skip: %s", declaration => {
  const report = refused(listing(declaration), { phase: 4, reason: reasons.boundarySyntax, functionId: 0, count: 0, mask: 0 });
  expect(report.functions.every((item: { delegateId: number; callCount: number }) => item.delegateId === 0 && item.callCount === 0)).toBe(true);
});

it("does not let a declaration suppress an actual nested PROC boundary", () => {
  refused(listing(`EXTRN ${marker}:PROC`, (body, index) => index ? body : body + "\n private_nested PROC"),
    { phase: 4, reason: reasons.nestedProc, functionId: 1, count: 0, mask: 0 });
});
