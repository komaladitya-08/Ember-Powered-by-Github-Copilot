import { describe, expect, it } from "vitest";
import { processIdentity, readProcessIdentity, signalProcess } from "../../app/main/platform/linux/process-identity";

const stat = (pid = 123, start = "456", group = 123) => `${pid} (a tricky (name)) S 1 ${group} ${Array(16).fill("0").join(" ")} ${start} 0`;

describe("Linux process identities", () => {
  it("reads the start time and group even when the process name holds parentheses", () => {
    expect(processIdentity(stat())).toEqual({ pid: 123, start: 456, group: 123 });
    expect(readProcessIdentity(123, () => stat())).toEqual({ pid: 123, start: 456, group: 123 });
  });

  it("fails closed on missing, mismatched or malformed process identities", () => {
    for (const text of ["", "123 (missing fields) S 1", stat(1), stat(123, "NaN"), stat(123, "-1"), stat(123, "99999999999999999999")]) expect(processIdentity(text), text).toBeNull();
    expect(readProcessIdentity(124, () => stat())).toBeNull();
    expect(readProcessIdentity(123, () => { throw new Error("not readable"); })).toBeNull();
  });

  it("never signals a recycled pid or process group, and rechecks before every signal", () => {
    const identity = processIdentity(stat())!;
    const calls: number[] = [];
    let current = stat();
    const deps = { read: () => current, kill: (pid: number) => { calls.push(pid); } };
    expect(signalProcess(identity, "SIGTERM", { ...deps, group: true })).toBe(true);
    current = stat(123, "789");
    expect(signalProcess(identity, "SIGKILL", { ...deps, group: true })).toBe(false);
    expect(signalProcess(identity, "SIGKILL", deps)).toBe(false);
    current = stat(123, "456", 555);
    expect(signalProcess(identity, "SIGKILL", deps)).toBe(false);
    current = "";
    expect(signalProcess(identity, "SIGKILL", deps)).toBe(false);
    expect(calls).toEqual([-123]);
  });

  it("signals a group only for its leader, and survives a process ending between the check and signal", () => {
    const identity = processIdentity(stat(123, "456", 555))!;
    expect(signalProcess(identity, "SIGTERM", { group: true, read: () => stat(123, "456", 555), kill: () => { throw new Error("must not call"); } })).toBe(false);
    expect(signalProcess(identity, "SIGTERM", { read: () => stat(123, "456", 555), kill: () => { throw new Error("gone"); } })).toBe(false);
  });
});
