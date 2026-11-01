import { describe, expect, it } from "vitest";
import { HandleRefs, KEEP, Snapshots, firstId, type IdEntry, type ReadRecord } from "../../app/sidecar-host/ids";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, benchDesktop } from "../../app/sidecar-host/providers/fake";
import type { ReadWindowResult } from "../../app/main/perception/sidecar";

const read = {} as ReadRecord;
const entry = (handle: number): IdEntry => ({ handle, read, index: 0 });

describe("where a process's ids start", () => {
  it("continues from the block Ember gives it", () => {
    expect(firstId({ EMBER_ATSPI_ID_BASE: "30000000" })).toBe(30_000_001);
  });

  it("otherwise starts at a random offset, 2^20-aligned and well inside JSON's safe integers", () => {
    for (const env of [{}, { EMBER_ATSPI_ID_BASE: "junk" }, { EMBER_ATSPI_ID_BASE: "-5" }, { EMBER_ATSPI_ID_BASE: String(2 ** 51) }]) {
      const id = firstId(env, () => 0.5);
      expect((id - 1) % 2 ** 20).toBe(0);
      expect(id).toBeGreaterThan(2 ** 20);
      expect(id).toBeLessThan(2 ** 41);
    }
    expect(firstId({}, () => 0)).toBe(2 ** 20 + 1);
    expect(firstId({}, () => 0.999999)).toBeLessThanOrEqual(2 ** 40 + 1);
  });
});

describe("Snapshots", () => {
  it("keeps the last 8 reads; an older read's ids are no longer known", () => {
    const s = new Snapshots(1, new HandleRefs());
    const ids: number[] = [];
    for (let i = 0; i < KEEP + 1; i++) {
      s.begin();
      ids.push(s.add(entry(i + 1)));
      s.end();
    }
    expect(() => s.get(ids[0])).toThrow("'element 1 is no longer known; read the window again'");
    expect(s.get(ids[1]).handle).toBe(2);
    expect(s.get(ids[KEEP]).handle).toBe(KEEP + 1);
  });

  it("puts quick looks in a scratch read that never pushes out the kept ones", () => {
    const s = new Snapshots(1, new HandleRefs());
    s.begin();
    const kept = s.add(entry(1));
    s.end();
    let look = 0;
    for (let i = 0; i < 20; i++) {
      s.begin(false);
      look = s.add(entry(100 + i));
      s.end();
    }
    expect(s.get(kept).handle).toBe(1);
    expect(s.get(look).handle).toBe(119);
    expect(s.find(look - 1)).toBeUndefined();
  });

  it("gives ids handed out after a read to the newest kept read, and never reuses one", () => {
    const s = new Snapshots(10, new HandleRefs());
    s.begin();
    const a = s.add(entry(1));
    s.end();
    s.begin(false);
    s.add(entry(2));
    s.end();
    const later = s.add(entry(3));
    s.begin(false);
    s.end();
    expect(s.get(later).handle).toBe(3);
    expect([a, later]).toEqual([10, 12]);
  });

  it("never takes an id at or below zero (the read's own held handles)", () => {
    const s = new Snapshots(1, new HandleRefs());
    s.begin();
    s.hold(entry(5));
    expect(() => s.get(-1)).toThrow(/no longer known/);
    expect(() => s.get(0)).toThrow(/no longer known/);
  });

  it("gives a handle back once no read holds it", () => {
    const refs = new HandleRefs();
    const s = new Snapshots(1, refs);
    s.begin();
    const id = s.add(entry(7));
    s.hold(entry(8));
    s.end();
    s.begin(false);
    s.add(entry(7));
    s.end();
    expect(refs.take()).toEqual([]);
    s.remove(id); // only from the read going on (the quick look): the kept read still holds 7
    s.clear();
    expect(refs.take().sort()).toEqual([7, 8]);
    expect(refs.size).toBe(0);
  });
});

describe("ids through the host", () => {
  function harness() {
    const fake = new FakeProvider(benchDesktop(), { deadlineMs: 300 });
    const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "20000000" }, settleMs: 0 });
    let n = 1;
    const call = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      const msg = JSON.parse((await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!);
      if (msg.error) throw new Error(msg.error.message);
      return msg.result as T;
    };
    return { fake, host, call };
  }
  const save = (r: ReadWindowResult) => r.nodes.find(x => x.name === "Save")!.id;

  it("numbers elements from the block Ember gave the process", async () => {
    const { call } = harness();
    const r = await call<ReadWindowResult>("read_window", {});
    expect(r.nodes[0].id).toBe(20_000_001);
    expect(new Set(r.nodes.map(x => x.id)).size).toBe(r.nodes.length);
  });

  it("keeps a read's ids through 7 more reads and any number of quick looks", async () => {
    const { call } = harness();
    const first = save(await call<ReadWindowResult>("read_window", {}));
    for (let i = 0; i < KEEP - 1; i++) await call("read_window", {});
    for (let i = 0; i < 12; i++) await call("read_window", { keep: false });
    expect(await call("read_element", { id: first })).toMatchObject({ name: "Save" });
    await call("read_window", {});
    await expect(call("read_element", { id: first })).rejects.toThrow(`'element ${first} is no longer known; read the window again'`);
  });

  it("forgets every read when the provider restarted: an id from before is no longer known, never another element", async () => {
    const { fake, call } = harness();
    const id = save(await call<ReadWindowResult>("read_window", {}));
    fake.restart();
    await expect(call("read_element", { id })).rejects.toThrow(/no longer known/);
    const again = save(await call<ReadWindowResult>("read_window", {}));
    expect(again).toBeGreaterThan(id);
  });

  it("gives back every handle no read holds, at the end of each request", async () => {
    const { fake, call } = harness();
    await call("list_windows", {});
    expect(fake.live).toBe(0);
    const r = await call<ReadWindowResult>("read_window", {});
    // The read holds its listed elements and the containers that clip or choose; the rest went back.
    const held = fake.live;
    expect(held).toBeGreaterThanOrEqual(r.nodes.length);
    expect(held).toBeLessThan(r.nodes.length + 6);
    await call("read_element", { id: save(r) });
    await call("at_point", { pid: 4242, path: "172210", x: 250, y: 360 });
    expect(fake.live).toBe(held);
    // Eight kept reads hold theirs, and no more than that however many reads come: older ones give theirs back.
    for (let i = 0; i < KEEP; i++) await call("read_window", {});
    expect(fake.live).toBe(held * KEEP);
    for (let i = 0; i < 12; i++) await call("read_window", {});
    expect(fake.live).toBe(held * KEEP);
    // A quick look holds its own until the next one replaces it.
    await call("read_window", { keep: false });
    await call("read_window", { keep: false });
    expect(fake.live).toBe(held * (KEEP + 1));
  });
});
