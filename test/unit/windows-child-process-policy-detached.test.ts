/** A fixed root-flag adapter and run identity; no native code, arbitrary flags or compilation authority. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WINDOWS_CHILD_PROCESS_POLICY_IO_FUNCTIONS } from "../fixtures/windows-child-process-policy-io";
import { windowsChildPolicyDetachedRootLoader } from "../fixtures/windows-child-process-policy-detached-io";
import { WINDOWS_CHILD_POLICY_DETACHED_VARIANT as variant } from "../fixtures/windows-child-process-policy-detached-variant";

const prototype = WINDOWS_CHILD_PROCESS_POLICY_IO_FUNCTIONS.kernel32.find(value => value.startsWith("int __stdcall CreateProcessW("))!;
const argumentsFor = () => ["fixed public image", Buffer.alloc(2), null, null, 1, variant.originalRootCreateFlags, Buffer.alloc(4), "fixed directory", Buffer.alloc(112), Buffer.alloc(24)];
const setup = () => {
  const native = vi.fn((..._args: unknown[]) => 1), bind = vi.fn((_prototype: string) => native), load = vi.fn((_library: string) => ({ func: bind }));
  const wrapper = windowsChildPolicyDetachedRootLoader(load);
  return { native, bind, load, wrapper };
};

it("keeps compilation provenance separate from the frozen root-only run variant", () => {
  expect(variant).toEqual({ schema: 1, issuer: "ember-experimental-windows-child-policy-detached-root-fixed-probe", compiledIssuer: "ember-experimental-windows-child-process-policy-fixed-probe",
    kind: "detached-roots-only", originalRootCreateFlags: 0x08080404, rootCreateFlags: 0x0008040c, caseIds: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
  expect(Object.isFrozen(variant)).toBe(true); expect(Object.isFrozen(variant.caseIds)).toBe(true);
  expect(variant.originalRootCreateFlags ^ variant.rootCreateFlags).toBe(0x08000008);
});

it.each([
  ["test/fixtures/windows-child-process-policy.c", "523824da9b4fc8f46371889b167fe999914949de215624e3309a30c12bd198fc"],
  ["scripts/experimental/build-windows-child-process-policy.mjs", "e6411e07fe43d7448085dd8699b604fd84597ca054e2799c884a5e8fa0757a44"],
  ["scripts/experimental/windows-child-process-policy-pin.json", "e8d185e1cacb79b23f58d379204d54771f91b68a7a600f6d36c82cb000018b13"],
])("keeps the reviewed original compile input byte-identical: %s", (file, expected) => {
  expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(expected);
});

it("rewrites only the exact native flag slot and forwards the same other argument objects once", () => {
  const s = setup(), args = argumentsFor(), call = s.wrapper("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  expect(call(...args)).toBe(1); expect(s.native).toHaveBeenCalledTimes(1);
  expect(args[5]).toBe(variant.originalRootCreateFlags);
  for (let i = 0; i < args.length; i++) expect(s.native.mock.calls[0][i]).toBe(i === 5 ? variant.rootCreateFlags : args[i]);
  expect(s.load).toHaveBeenCalledExactlyOnceWith("kernel32.dll"); expect(s.bind).toHaveBeenCalledExactlyOnceWith(prototype);
});

it.each([undefined, null, "134743044", false, NaN, 0, 8, variant.rootCreateFlags, variant.originalRootCreateFlags | 8, variant.originalRootCreateFlags ^ 4, variant.originalRootCreateFlags ^ 0x400])(
  "refuses changed or combined flags before invoking any native creation: %s", flags => {
    const s = setup(), args: unknown[] = argumentsFor(), call = s.wrapper("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
    args[5] = flags; expect(() => call(...args)).toThrow("changed native creation contract"); expect(s.native).not.toHaveBeenCalled();
  });
it.each([9, 11])("refuses a changed %s-argument native call before creation", count => {
  const s = setup(), args: unknown[] = argumentsFor(), call = s.wrapper("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  args.length = count; expect(() => call(...args)).toThrow(); expect(s.native).not.toHaveBeenCalled();
});
it.each([["kernel32.dll", "uint32_t __stdcall GetLastError()"], ["advapi32.dll", prototype], ["kernel32.dll", prototype + " "]])(
  "leaves other library/prototype bindings unmodified: %s", (library, signature) => {
    const s = setup(); expect(s.wrapper(library).func(signature)).toBe(s.native); expect(s.native).not.toHaveBeenCalled();
  });
it("does not hide a malformed FFI binding from the original constructor's strict checks", () => {
  const wrapper = windowsChildPolicyDetachedRootLoader(() => ({ func: () => undefined }));
  expect(wrapper("kernel32.dll").func(prototype)).toBeUndefined();
});

it("runs only the dedicated native matrix and leaves original portables/manual dispatch available", () => {
  const original = fs.readFileSync(".github/workflows/experimental-windows-child-process-policy.yml", "utf8");
  expect(original).toContain("if: github.event_name == 'workflow_dispatch' || github.head_ref != 'ember-improve/20261116-child-policy-detached-root'");
  const workflow = fs.readFileSync(".github/workflows/experimental-windows-child-process-policy-detached-root.yml", "utf8");
  expect(workflow).toContain('EMBER_CHILD_POLICY_DETACHED_PROBE: "1"');
  expect(workflow).toContain("test/integration/windows-child-process-policy-detached-native.test.ts");
  expect(workflow).toContain("scripts/experimental/build-windows-child-process-policy.mjs");
  expect(workflow).not.toContain('EMBER_CHILD_POLICY_PROBE: "1"');
  const guard = (text: string, name: string) => {
    const expression = text.split(`  ${name}:\n`)[1]?.split("\n").find(line => line.startsWith("    if: "))?.slice(8);
    const parsed = /^github\.event_name == 'workflow_dispatch' \|\| github\.head_ref (==|!=) '([^']+)'$/.exec(expression ?? "");
    expect(parsed, name).not.toBeNull();
    return (event: string, head: string) => event === "workflow_dispatch" || (parsed![1] === "==" ? head === parsed![2] : head !== parsed![2]);
  };
  const originalRuns = guard(original, "fixed-child-process-policy-prerequisite"), detachedRuns = guard(workflow, "fixed-detached-root-child-policy-prerequisite");
  const head = "ember-improve/20261116-child-policy-detached-root";
  for (const branch of [head, "another-policy-pr", ""]) {
    expect([originalRuns("pull_request", branch), detachedRuns("pull_request", branch)]).toEqual(branch === head ? [false, true] : [true, false]);
    expect(originalRuns("workflow_dispatch", branch)).toBe(true); expect(detachedRuns("workflow_dispatch", branch)).toBe(true);
  }
});
