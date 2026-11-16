import { expect, it } from "vitest";
import { bindWindowsChildPolicyJob } from "../fixtures/windows-child-process-policy-job";
const setup = (fault = "") => {
  let current = Buffer.alloc(144), calls = 0; current.writeUInt32LE(0x2000, 16);
  const api = bindWindowsChildPolicyJob({ sizeof: () => 8 }, () => ({ func: signature => (...args: unknown[]) => {
    calls++;
    if (fault === "throw") throw new Error("private native detail");
    if (signature.includes("SetInformation")) { current = Buffer.from(args[2] as Buffer); return fault === "set-false" ? 0 : 1; }
    if (args[1] === 4) { (args[2] as Buffer).writeUInt32LE(fault === "ui" ? 1 : 0); return 1; }
    const output = args[2] as Buffer; current.copy(output);
    if (fault === "one-process") output.writeUInt32LE(1, 40);
    if (fault === "breakaway") output.writeUInt32LE(output.readUInt32LE(16) | 0x800, 16);
    return fault === "query-false" ? 0 : 1;
  } }));
  return { api, current: () => current, calls: () => calls };
};
it("sets and reads back exactly two active processes without adding breakaway or UI restrictions", () => {
  const value = setup(); value.api.setTwo(123n);
  expect(value.current().readUInt32LE(16)).toBe(0x2008); expect(value.current().readUInt32LE(40)).toBe(2);
});
it.each(["throw", "set-false", "query-false", "one-process", "breakaway", "ui"])("terminally refuses a job that could mask or escape the child-policy test: %s", fault => {
  const value = setup(fault); expect(() => value.api.setTwo(123n)).toThrow("cleanup");
  const before = value.calls(); expect(() => value.api.setTwo(123n)).toThrow("cleanup"); expect(value.calls()).toBe(before);
});
