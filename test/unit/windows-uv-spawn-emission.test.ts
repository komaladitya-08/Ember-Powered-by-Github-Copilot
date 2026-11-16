import { expect, it } from "vitest";
// @ts-expect-error -- portable closed public-source assembly observations, no application/native dependency
import { inspectWindowsUvSpawnEmission, parseWindowsUvSpawnEmission, emissionLimits } from "../../scripts/experimental/windows-uv-spawn-emission.mjs";

const symbols = ["ember_uv_spawn_CreateNamedPipeA", "ember_uv_spawn_CreateFileA", "ember_uv_spawn_ConnectNamedPipe",
  "ember_uv_spawn_CreateIoCompletionPort", "ember_uv_spawn_CreateProcessW", "ember_uv_spawn_translate_sys_error"];
const delegates = ["__imp_CreateNamedPipeA", "__imp_CreateFileA", "__imp_ConnectNamedPipe", "__imp_CreateIoCompletionPort", "__imp_CreateProcessW", "uv_translate_sys_error"];
function listing(transform: (body: string, index: number) => string = value => value) {
  return "; Unpublished C:\\Users\\private-owner\\project\\observer.c\r\n_TEXT SEGMENT\r\n" + symbols.map((name, index) => {
    const body = ` mov QWORD PTR [rsp+8], rbx\n call ${index === 5 ? "" : "QWORD PTR "}${delegates[index]}\n mov DWORD PTR [rcx+4], eax\n ret 0`;
    return `${name} PROC ; COMDAT\n${transform(body, index)}\n${name} ENDP\n`;
  }).join("") + "_TEXT ENDS\nEND\n";
}
const inspect = (text: string) => inspectWindowsUvSpawnEmission(Buffer.from(text));
const parse = (value: unknown) => parseWindowsUvSpawnEmission(Buffer.from(JSON.stringify(value)));

it("emits only fixed IDs, counts, masks, size/hash and explicitly pending review for recognised syntax", () => {
  const value = inspect(listing()); expect(value.status).toBe("candidate"); expect(value.review).toBe("not-reviewed");
  expect(value.functions).toEqual(symbols.map((_, index) => ({ functionId: index + 1, delegateId: index + 1, delegateCalls: 1, callCount: 1,
    postDelegateCalls: 0, unknownCalls: 0, callMask: 1 << index })));
  expect(value.listing.bytes).toBe(Buffer.byteLength(listing())); expect(value.listing.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(parse(value)).toEqual(value); expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.functions[0])).toBe(true);
  const output = JSON.stringify(value); expect(output).not.toMatch(/private-owner|project|observer\.c|CreateFile|CreateProcess|__imp|rsp|rcx|QWORD|native|admi/i);
});

it("recognises local labels and branches, ignoring comments and unrelated well-formed functions", () => {
  const text = listing((body, index) => index ? body : `$LN1@wrapper:\n${body.replace(" ret 0", " jmp SHORT $LN2@wrapper\n$LN2@wrapper:\n ret 0")} ; call private-helper\n`);
  expect(inspect("unrelated PROC\n ret 0\nunrelated ENDP\n" + text).status).toBe("candidate");
});

it.each(["GetLastError", "SetLastError", "__security_check_cookie", "private_helper", "rax", "QWORD PTR [rax]"])("refuses unexpected post-delegate calls without publishing the target: %s", target => {
  const value = inspect(listing((body, index) => index ? body : body.replace(" ret 0", ` call ${target}\n ret 0`)));
  expect(value.status).toBe("refused"); expect(value.functions[0]).toMatchObject({ delegateId: 0, delegateCalls: 1, callCount: 2, postDelegateCalls: 1, unknownCalls: 1 });
  expect(JSON.stringify(value)).not.toContain(target); expect(parse(value)).toEqual(value);
});

it("refuses pre-delegate helpers, repeated delegates and another known API target", () => {
  const pre = inspect(listing((body, index) => index ? body : ` call __chkstk\n${body}`));
  expect(pre.status).toBe("refused"); expect(pre.functions[0]).toMatchObject({ delegateId: 0, callCount: 2, postDelegateCalls: 0, unknownCalls: 1 });
  const repeated = inspect(listing((body, index) => index ? body : body.replace(" ret 0", " call QWORD PTR __imp_CreateNamedPipeA\n ret 0")));
  expect(repeated.status).toBe("refused"); expect(repeated.functions[0]).toMatchObject({ delegateId: 0, delegateCalls: 2, postDelegateCalls: 1 });
  const changed = inspect(listing().replace("call QWORD PTR __imp_CreateNamedPipeA", "call QWORD PTR __imp_CreateFileA"));
  expect(changed.status).toBe("refused"); expect(changed.functions[0]).toMatchObject({ delegateId: 0, delegateCalls: 0, callCount: 1, callMask: 2 });
});

it.each(["jmp private_target", "jmp QWORD PTR [rax]", "je private_target", "$LN1: call private_target"])("refuses unrecognised or external control transfers: %s", instruction => {
  const value = inspect(listing((body, index) => index ? body : body.replace(" ret 0", ` ${instruction}\n ret 0`)));
  expect(value.status).toBe("refused"); expect(value.functions.every((item: { delegateId: number }) => item.delegateId === 0)).toBe(true);
  expect(JSON.stringify(value)).not.toContain("private_target");
});

it("requires exactly one matching pair for every fixed wrapper and refuses malformed boundaries", () => {
  for (const text of [listing().replace(`${symbols[0]} ENDP`, "wrong ENDP"), listing().replace(`${symbols[0]} PROC`, "foreign PROC"),
    listing() + `${symbols[0]} PROC\n ret\n${symbols[0]} ENDP`, listing().replace(`${symbols[0]} ENDP`, ""),
    listing().replace(`${symbols[0]} PROC`, `nested PROC\n${symbols[0]} PROC`), listing().replace(` call QWORD PTR ${delegates[0]}`, " nop")]) {
    const value = inspect(text); expect(value.status).toBe("refused"); expect(parse(value)).toEqual(value);
  }
});

it("refuses invalid types and oversized input before parsing or inventing a listing fingerprint", () => {
  for (const bytes of [null, "private-source", Buffer.alloc(0), Buffer.alloc(emissionLimits.bytes + 1)]) {
    const value = inspectWindowsUvSpawnEmission(bytes); expect(value).toMatchObject({ status: "refused", listing: null }); expect(parse(value)).toEqual(value);
  }
});

it("enforces line, encoding and control-byte bounds and keeps refusal diagnostics closed", () => {
  for (const text of [listing() + "\n".repeat(emissionLimits.lines), listing() + "x".repeat(emissionLimits.lineBytes + 1),
    listing() + "\0", listing() + "\rprivate", listing() + "\u0080"]) {
    const value = inspect(text); expect(value.status).toBe("refused"); expect(parse(value)).toEqual(value);
  }
  expect(inspectWindowsUvSpawnEmission(Buffer.from([0xff])).status).toBe("refused");
});

it("rejects foreign or expanded artifacts, candidate claims from refused syntax, and unbounded counts", () => {
  const good = inspect(listing());
  const clone = () => JSON.parse(JSON.stringify(good));
  for (const mutate of [
    (value: ReturnType<typeof clone>) => { value.issuer = "foreign"; }, (value: ReturnType<typeof clone>) => { value.review = "approved"; },
    (value: ReturnType<typeof clone>) => { value.nativeAdmission = true; }, (value: ReturnType<typeof clone>) => { value.functions[0].symbol = "private"; },
    (value: ReturnType<typeof clone>) => { value.functions.reverse(); }, (value: ReturnType<typeof clone>) => { value.functions[0].callCount = emissionLimits.lines + 1; },
    (value: ReturnType<typeof clone>) => { value.functions[0].delegateId = 0; }, (value: ReturnType<typeof clone>) => { value.functions[0].callMask = 64; },
    (value: ReturnType<typeof clone>) => { value.listing.bytes = emissionLimits.bytes + 1; }, (value: ReturnType<typeof clone>) => { value.listing = null; },
    (value: ReturnType<typeof clone>) => { value.status = "refused"; },
  ]) { const value = clone(); mutate(value); expect(() => parse(value)).toThrow("fixed observer emission metadata was refused"); }
  for (const bytes of [Buffer.from("private malformed data"), Buffer.from([0xff]), Buffer.alloc(emissionLimits.artifactBytes + 1)]) {
    expect(() => parseWindowsUvSpawnEmission(bytes)).toThrow("fixed observer emission metadata was refused");
  }
});
