import { describe, expect, it } from "vitest";
import { latestOnly } from "../../app/shared/provider";

/** A read the test settles by hand, so the order of replies is the test's, not a timer's. */
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("latestOnly (the provider state read is fenced: a superseded reply is never applied)", () => {
  function setup() {
    const reads: ReturnType<typeof deferred<string>>[] = [];
    const applied: string[] = [];
    const refresh = latestOnly(() => { const d = deferred<string>(); reads.push(d); return d.promise; }, r => applied.push(r.ok ? r.value : "failed"));
    return { reads, applied, refresh };
  }
  it("keeps a newer success when an older read fails afterwards", async () => {
    const { reads, applied, refresh } = setup();
    const a = refresh(); const b = refresh();
    reads[1]!.resolve("new"); await b;
    reads[0]!.reject(new Error("late")); await a;
    expect(applied).toEqual(["new"]);
  });
  it("ignores an older success that arrives after a newer one", async () => {
    const { reads, applied, refresh } = setup();
    const a = refresh(); const b = refresh();
    reads[1]!.resolve("new"); await b;
    reads[0]!.resolve("old"); await a;
    expect(applied).toEqual(["new"]);
  });
  it("applies a newest failure, and an older success arriving after it doesn't undo it", async () => {
    const { reads, applied, refresh } = setup();
    const a = refresh(); const b = refresh();
    reads[1]!.reject(new Error("x")); await b;
    reads[0]!.resolve("old"); await a;
    expect(applied).toEqual(["failed"]);
  });
});
