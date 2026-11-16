import { expect, it } from "vitest";
import { brandWindowsChildPolicyFailure, preserveWindowsChildPolicyFailure, windowsChildPolicyFailure } from "../fixtures/windows-child-process-policy-diagnostic";
const context = { phase: 2, operation: 3, predicate: 7 };
it("brands the same authoritative error with frozen closed facts and reads no error properties", () => {
  let reads = 0;
  const error = new Proxy({}, { get() { reads++; throw new Error("private native object"); } });
  expect(brandWindowsChildPolicyFailure(error, context, 0)).toBe(error);
  const receipt = windowsChildPolicyFailure(error);
  expect(receipt).toEqual({ schema: 1, ...context, domain: 1, returnedBool: 0 });
  expect(Object.isFrozen(receipt)).toBe(true); expect(reads).toBe(0);
});
it.each([0, 1, false, true])("publishes only an already captured validated BOOL: %s", value => {
  const error = brandWindowsChildPolicyFailure(new Error("private path and native exception"), context, value);
  expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 1, returnedBool: value === 0 || value === false ? 0 : 1 });
});
it.each([undefined, null, -1, 2, NaN, Infinity, "0", "private native path", 5n, {}])("omits a malformed or unavailable BOOL without forwarding it: %s", value => {
  const error = brandWindowsChildPolicyFailure(new Error(), context, value);
  expect(windowsChildPolicyFailure(error)).toEqual({ schema: 1, ...context, domain: 0 });
});
it.each([{ ...context, phase: -1 }, { ...context, phase: 7 }, { ...context, operation: 16 }, { ...context, predicate: 12 }, { ...context, predicate: 0.5 }])("rejects out-of-domain branding: %j", invalid => {
  const error = new Error(); expect(brandWindowsChildPolicyFailure(error, invalid, 0)).toBe(error); expect(windowsChildPolicyFailure(error)).toBeUndefined();
});
it("preserves the first facts through later-branded wrappers without replacing their identities", () => {
  const first = brandWindowsChildPolicyFailure(new Error("first private value"), context, 0);
  const original = windowsChildPolicyFailure(first);
  brandWindowsChildPolicyFailure(first, { phase: 6, operation: 14, predicate: 11 }, 1);
  const later = brandWindowsChildPolicyFailure(new TypeError("later private cleanup"), { phase: 6, operation: 14, predicate: 11 });
  expect(preserveWindowsChildPolicyFailure(first, later)).toBe(later);
  expect(windowsChildPolicyFailure(later)).toBe(original); expect(windowsChildPolicyFailure(first)).toBe(original);
  const final = new Error("fixed terminal error"); expect(preserveWindowsChildPolicyFailure(later, final)).toBe(final);
  expect(windowsChildPolicyFailure(final)).toBe(original);
});
it("does not accept forged, inherited or merely similar error receipts", () => {
  const error = brandWindowsChildPolicyFailure(new Error(), context, 0), receipt = windowsChildPolicyFailure(error)!;
  for (const forged of [null, undefined, "private", 1, { ...receipt }, Object.assign(new Error(), { failure: receipt }), Object.create(error)])
    expect(windowsChildPolicyFailure(forged)).toBeUndefined();
  const target = new Error(); expect(preserveWindowsChildPolicyFailure({ failure: receipt }, target)).toBe(target); expect(windowsChildPolicyFailure(target)).toBeUndefined();
});
