/** Parse only a naturally completed fixed ordinary-host ABI control's numeric report; no runtime or LPAC admission is conveyed. */
import { abiPin } from "./windows-uv-observer-abi-pin.mjs";
export { abiPin };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function parseWindowsUvObserverAbiReport(bytes) {
  const fail = () => { throw new Error("The fixed observer ABI report was refused."); };
  try {
  if (!Buffer.isBuffer(bytes) || bytes.length !== abiPin.reportBytes) fail();
  const words = Array.from({ length: 64 }, (_, index) => bytes.readUInt32LE(index * 4));
  const header = [0x31494241, 1, 1, 0, 96, 96, 96, 96, 127, 0, 0, 0, 0, 0, 0, 0];
  if (!header.every((value, index) => words[index] === value)) fail();
  const functions = [];
  for (let index = 0; index < 6; index++) {
    const row = words.slice(16 + index * 8, 24 + index * 8), expected = [index + 1, 16, 16, 32, 32, 32, 32, 8];
    if (!expected.every((value, field) => row[field] === value)) fail();
    functions.push({ functionId: index + 1, baselineCalls: row[1], wrappedCalls: row[2], argumentAndOutputChecks: row[3],
      entryErrorChecks: row[4], returnChecks: row[5], afterErrorChecks: row[6], ledgerChecks: row[7] });
  }
  return freeze({ schema: 1, issuer: abiPin.issuer, cases: abiPin.cases, checks: abiPin.checks, functions });
  } catch { fail(); }
}
