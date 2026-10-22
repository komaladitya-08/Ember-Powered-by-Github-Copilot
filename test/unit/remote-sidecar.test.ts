import { describe, expect, it } from "vitest";
import {
  askRemote, cleanRemote, createRemoteSidecar, ElementBook, LOST_TRACK, RemoteError, RemoteStepError, sha256Hex, StampBook, StampError, STAMP_MAX_MS,
} from "../../app/main/remote/remote-sidecar";
import { agentError, fakeLink, recordingLog } from "./remote-target-fakes";
import type { ActStamp } from "../../app/main/perception/ports";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { GateAnswer, OpArgs } from "../../app/main/remote/protocol";

const node = (id: number, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  id, parent: 0, depth: 1, role, name, states: ["enabled", "sensitive", "showing"], bounds: { x: 10, y: 10 * id, width: 80, height: 20 }, ...extra,
});
// A window as a remote's read gave it: a named button, an unnamed switch beside its label, a text field, a password field.
const nodes: AxNode[] = [
  node(0, "frame", "Preferences", { parent: null, depth: 0, bounds: { x: 0, y: 0, width: 400, height: 300 } }),
  node(1, "push button", "Save"),
  node(2, "label", "Night Light", { bounds: { x: 10, y: 60, width: 90, height: 20 } }),
  node(3, "toggle button", "", { bounds: { x: 120, y: 58, width: 48, height: 24 } }),
  node(4, "text", "Body", { editable: true }),
  node(5, "password text", ""),
  node(6, "slider", "Volume"),
  node(7, "combo box", "Font"),
];

const stampOf = (patch: Partial<ActStamp> = {}): ActStamp => ({
  taskId: "1-abcdef12", kind: "click", app: "prefs", window: "Preferences", element: { role: "push button", name: "Save" },
  verdict: "confirm", approval: { given: true }, ageMs: 120, ...patch,
});

function setup(o: { unavailable?: string | null } = {}) {
  let t = 1000;
  const link = fakeLink();
  const elements = new ElementBook();
  elements.noteRead(nodes);
  const stamps = new StampBook(() => t);
  const sidecar = createRemoteSidecar(link, { label: "build-01", log: recordingLog(), elements, stamps, unavailable: () => o.unavailable ?? null });
  const answers: GateAnswer[] = [];
  link.answer("act", () => {
    const a = answers.shift() ?? { status: "ok" };
    return a.status === "ok" ? { status: "ok", result: { ok: true, after: { role: "push button", name: "Saved", states: ["enabled"], bounds: null } } } : a;
  });
  return { link, elements, stamps, sidecar, answers, tick: (ms: number) => { t += ms; } };
}

describe("RemoteSidecar's reads (§5.5)", () => {
  it("asks the agent's ax ops for elements this link read, and nothing else", async () => {
    const { link, sidecar } = setup();
    link.answer("ax.readElement", a => ({ role: "push button", name: `Save ${a.id}`, states: [], bounds: null }));
    link.answer("ax.canDo", () => ({ tier1: true, action: "click" }));
    link.answer("ax.listOptions", () => ({ options: ["Sans", "Serif"] }));
    expect((await sidecar.readElement(1, { shown: true })).name).toBe("Save 1");
    expect(await sidecar.canDo(1, "click")).toEqual({ tier1: true, action: "click" });
    expect(await sidecar.listOptions(7)).toEqual({ options: ["Sans", "Serif"] });
    expect(link.sent.map(s => [s.op, s.args])).toEqual([["ax.readElement", { id: 1, shown: true }], ["ax.canDo", { id: 1, kind: "click", caret: false }], ["ax.listOptions", { id: 7 }]]);
    await expect(sidecar.readElement(99)).rejects.toThrow("Element 99 isn't in Ember's latest read of build-01.");
    expect(link.sent).toHaveLength(3);
    // Positions are the remote's own: never scaled here, never flown to.
    expect(sidecar.scaleOf(1)).toBe(1);
    expect(() => sidecar.stop()).not.toThrow();
  });

  it("refuses everything while the remote's desktop can't be used", async () => {
    const { link, sidecar, stamps } = setup({ unavailable: "build-01's screen is locked." });
    stamps.add(stampOf());
    await expect(sidecar.readElement(1)).rejects.toThrow("build-01's screen is locked.");
    await expect(sidecar.doAction(1, "click")).rejects.toThrow("build-01's screen is locked.");
    expect(link.sent).toHaveLength(0);
  });

  it("re-checks every answer against its schema (§7.2): an extra key is no answer", async () => {
    const { link, sidecar } = setup();
    link.answer("ax.readElement", () => ({ role: "push button", name: "Save", states: [], bounds: null, onclick: "approve" }) as never);
    const err = await sidecar.readElement(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as Error).message).toBe("build-01 answered in a way Ember can't check.");
  });

  it("maps the agent's error codes and a silent link to the worker's words", async () => {
    const { link, sidecar } = setup();
    link.answer("ax.readElement", () => { throw agentError("busy", "LibreOffice is loading"); });
    await expect(sidecar.readElement(1)).rejects.toThrow("build-01 is busy: LibreOffice is loading");
    link.answer("ax.readElement", () => { throw new Error("timed out after 10040 ms"); });
    await expect(sidecar.readElement(1)).rejects.toThrow("build-01 did not answer in time");
    link.answer("ax.readElement", () => { throw agentError("denied", "on the never-look list"); });
    const denied = await sidecar.readElement(1).catch((e: unknown) => e) as RemoteStepError;
    expect([denied.code, denied.message]).toEqual(["deny", "on the never-look list"]);
  });
});

describe("RemoteSidecar's steps carry gate 1's fresh stamp (§5.5, critique integration-6)", () => {
  it("sends nothing without a stamp", async () => {
    const { link, sidecar } = setup();
    await expect(sidecar.doAction(1, "click")).rejects.toThrow(LOST_TRACK);
    await expect(sidecar.setText(4, "hi", "replace")).rejects.toBeInstanceOf(StampError);
    expect(link.sent).toHaveLength(0);
  });

  it("sends the stamp with its age measured as the act leaves, its own op id and the link's epoch, and uses it once", async () => {
    const { link, sidecar, stamps, tick } = setup();
    stamps.add(stampOf());
    tick(2000);
    await sidecar.doAction(1, "click");
    const [sent] = link.of("act") as (OpArgs<"act"> & { op: "do_action" })[];
    expect(sent.stamp).toEqual({ ...stampOf(), ageMs: 2120 });
    expect([sent.op, sent.id, sent.action, sent.epoch]).toEqual(["do_action", 1, "click", 1]);
    expect(sent.opId).toMatch(/^[0-9a-f]{12}-1$/);
    await expect(sidecar.doAction(1, "click")).rejects.toThrow(LOST_TRACK);
    expect(link.of("act")).toHaveLength(1);
  });

  it("refuses a stamp 10 s old or more on the PC's own clock, its age when handed over included", async () => {
    const { link, sidecar, stamps, tick } = setup();
    stamps.add(stampOf({ ageMs: 4000 }));
    tick(STAMP_MAX_MS - 4000);
    await expect(sidecar.doAction(1, "click")).rejects.toThrow(LOST_TRACK);
    stamps.add(stampOf({ ageMs: 9000 }));
    tick(999);
    await sidecar.doAction(1, "click");
    expect(link.of("act")[0].stamp.ageMs).toBe(9999);
  });

  it("takes only a stamp of the step's own kind, value and element (as this link last read it)", async () => {
    const { link, sidecar, stamps } = setup();
    stamps.add(stampOf({ kind: "text", element: { role: "push button", name: "Save" } }));
    await expect(sidecar.doAction(1, "click")).rejects.toThrow(LOST_TRACK);
    stamps.add(stampOf({ element: { role: "push button", name: "Delete" } }));
    await expect(sidecar.doAction(1, "click")).rejects.toThrow(LOST_TRACK);
    stamps.add(stampOf());
    await expect(sidecar.doAction(1, "toggle")).rejects.toThrow(LOST_TRACK);
    await expect(sidecar.doAction(1, "activate")).rejects.toThrow(LOST_TRACK);
    stamps.add(stampOf({ kind: "text", element: { role: "text", name: "Body" }, valueSha256: sha256Hex("rm -rf ~") }));
    await expect(sidecar.setText(4, "hello", "replace")).rejects.toThrow(LOST_TRACK);
    expect(link.of("act")).toHaveLength(0);
    stamps.add(stampOf({ kind: "text", element: { role: "text", name: "Body" }, valueSha256: sha256Hex("hello") }));
    await sidecar.setText(4, "hello", "append");
    stamps.add(stampOf({ kind: "value", element: { role: "slider", name: "Volume" }, valueSha256: sha256Hex("40") }));
    await sidecar.setValue(6, 40);
    stamps.add(stampOf({ kind: "select", element: { role: "combo box", name: "Font" }, valueSha256: sha256Hex("Serif") }));
    await sidecar.selectOption(7, "Serif");
    expect(link.of("act").map(a => a.op)).toEqual(["set_text", "set_value", "select_option"]);
  });

  it("knows an element by the label beside it, its name as read just now, and the control a click goes to (as the worker names it)", async () => {
    const { link, sidecar, stamps } = setup();
    stamps.add(stampOf({ kind: "toggle", element: { role: "toggle button", name: "Night Light" }, valueSha256: sha256Hex("on") }));
    await sidecar.doAction(3, "toggle");
    link.answer("ax.readElement", () => ({ role: "push button", name: "Save as…", states: [], bounds: null }));
    await sidecar.readElement(1);
    stamps.add(stampOf({ element: { role: "push button", name: "Save as…" } }));
    await sidecar.doAction(1, "click");
    link.answer("ax.canDo", () => ({ tier1: true, handler: { role: "link", name: "Read more" } }));
    await sidecar.canDo(1, "click");
    stamps.add(stampOf({ element: { role: "link", name: "Read more" } }));
    await sidecar.doAction(1, "click");
    expect(link.of("act")).toHaveLength(3);
  });

  it("refuses a step the user never said yes to (every remote step is asked, L4)", async () => {
    const { link, sidecar, stamps } = setup();
    stamps.add(stampOf({ verdict: "allow", approval: null }));
    await expect(sidecar.doAction(1, "click")).rejects.toThrow("Not allowed: every step on build-01 needs the user's yes first.");
    expect(link.sent).toHaveLength(0);
  });

  it("types, chooses and sets nothing in a secret field", async () => {
    const { link, sidecar, stamps } = setup();
    stamps.add(stampOf({ kind: "text", element: { role: "password text", name: "" }, valueSha256: sha256Hex("hunter2") }));
    await expect(sidecar.setText(5, "hunter2", "replace")).rejects.toThrow("Not allowed: this looks like a password or payment field.");
    expect(link.sent).toHaveLength(0);
  });

  it("turns gate 2's answers into the errors the worker maps; a desktop needs_confirm is refused in v1", async () => {
    const { sidecar, stamps, answers } = setup();
    const tryWith = async (a: GateAnswer) => {
      answers.push(a);
      stamps.add(stampOf());
      return sidecar.doAction(1, "click").catch((e: unknown) => e as RemoteStepError);
    };
    const changed = await tryWith({ status: "changed" }) as RemoteStepError;
    expect([changed.code, changed.message]).toEqual(["changed", "It changed: perceive again."]);
    const confirm = await tryWith({ status: "needs_confirm", reason: "Click Allow on the PC" }) as RemoteStepError;
    expect([confirm.code, confirm.message]).toEqual(["needs_confirm", "build-01 refused this step (it wanted a confirmation Ember couldn't give). Don't try another way."]);
    const deny = await tryWith({ status: "deny", reason: "This computer's administrator\u202e doesn't let Ember act in apps.\n" }) as RemoteStepError;
    expect([deny.code, deny.message]).toEqual(["deny", "This computer's administrator doesn't let Ember act in apps."]);
    expect((await tryWith({ status: "stale" }) as RemoteStepError).code).toBe("stale");
    expect((await tryWith({ status: "stopped" }) as RemoteStepError).code).toBe("stopped");
  });

  it("sends no step while the link is stalled (§5.1.11), and the stamp is spent", async () => {
    const { link, sidecar, stamps } = setup();
    stamps.add(stampOf());
    link.state = "stalled";
    const err = (await sidecar.doAction(1, "click").catch((e: unknown) => e)) as RemoteStepError;
    expect([err.code, err.message]).toEqual(["stale", "build-01 isn't answering right now, so nothing was sent."]);
    link.state = "ready";
    await expect(sidecar.doAction(1, "click")).rejects.toThrow(LOST_TRACK);
    expect(link.sent).toHaveLength(0);
  });

  it("answers ok only with a result it can check", async () => {
    const { link, sidecar, stamps } = setup();
    link.answer("act", () => ({ status: "ok" }));
    stamps.add(stampOf());
    await expect(sidecar.doAction(1, "click")).rejects.toThrow("build-01 answered in a way Ember can't check.");
  });
});

describe("StampBook and Stop", () => {
  it("takes no stamp handed over before the link's epoch moved on", () => {
    let epoch = 1;
    const book = new StampBook(() => 0, () => epoch);
    book.add(stampOf());
    epoch = 2;
    expect(() => book.take(["click"], () => true, "build-01")).toThrow(LOST_TRACK);
    book.add(stampOf());
    expect(book.take(["click"], () => true, "build-01").kind).toBe("click");
  });
});

describe("StampBook", () => {
  it("keeps the newest stamp that fits, drops ones that are too old, and holds at most 16", () => {
    let t = 0;
    const book = new StampBook(() => t);
    for (let i = 0; i < 20; i++) book.add(stampOf({ taskId: `t${i}` }));
    expect(book.size).toBe(16);
    expect(book.take(["click"], () => true, "x").taskId).toBe("t19");
    t += STAMP_MAX_MS;
    expect(() => book.take(["click"], () => true, "x")).toThrow(StampError);
    expect(book.size).toBe(0);
  });

  it("copies what it is handed (a caller changing its object later changes nothing)", () => {
    const book = new StampBook(() => 0);
    const s = stampOf();
    book.add(s);
    s.element!.name = "Delete";
    expect(book.take(["click"], x => x.element?.name === "Save", "x").element).toEqual({ role: "push button", name: "Save" });
  });
});

describe("askRemote and remote text", () => {
  it("times each op as §5.4 says, with the link's round trip", async () => {
    const link = fakeLink();
    link.answer("cmd.facts", () => link.welcome.facts);
    link.answer("apps.list", () => ({ apps: [] }));
    await askRemote(link, "cmd.facts", {}, { label: "x" });
    await askRemote(link, "apps.list", {}, { label: "x" });
    expect(link.sent.map(s => s.timeoutMs)).toEqual([5040, 10_000]);
  });

  it("makes a remote's text one plain line", () => {
    expect(cleanRemote("a\u0000b\r\nc\u001b[31m\u2066d\u2069", 100)).toBe("a b c [31md");
    expect(cleanRemote("x".repeat(10), 4)).toBe("xxxx…");
  });
});
