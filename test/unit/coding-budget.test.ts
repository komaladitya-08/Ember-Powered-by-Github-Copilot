import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingBudget } from "../../app/main/agent/coding-budget";

afterEach(() => vi.useRealTimers());

describe("the host's native coding budget", () => {
  it("permits at most 150 tools even when calls arrive together", async () => {
    const exceeded = vi.fn(), budget = new CodingBudget(exceeded);
    try {
      const admitted = await Promise.all(Array.from({ length: 152 }, async () => budget.tool()));
      expect(admitted.filter(Boolean)).toHaveLength(150);
      expect(exceeded).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("150 tool calls"));
      expect(budget.tool()).toBe(false);
    } finally { budget.stop(); }
  });

  it("stops after 20 minutes and rejects any further tools", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const exceeded = vi.fn(), budget = new CodingBudget(exceeded);
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(exceeded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exceeded).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("20 minutes"));
    expect(budget.tool()).toBe(false);
  });

  it("pauses for overlapping human questions and resumes with the remaining time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const exceeded = vi.fn(), budget = new CodingBudget(exceeded);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    let a!: () => void, b!: () => void;
    const first = budget.waiting(() => new Promise<void>(resolve => { a = resolve; }));
    const second = budget.waiting(() => new Promise<void>(resolve => { b = resolve; }));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    a(); await first;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(exceeded).not.toHaveBeenCalled();
    b(); await second;
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(exceeded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exceeded).toHaveBeenCalledOnce();
  });

  it("never restarts a stopped clock when a late answer arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const exceeded = vi.fn(), budget = new CodingBudget(exceeded);
    let answer!: () => void;
    const waiting = budget.waiting(() => new Promise<void>(resolve => { answer = resolve; }));
    budget.stop();
    answer(); await waiting;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(exceeded).not.toHaveBeenCalled();
    expect(budget.tool()).toBe(false);
  });
});
