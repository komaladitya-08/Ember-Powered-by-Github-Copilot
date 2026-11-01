import { describe, expect, it } from "vitest";
import { cut, plain, wireActionResult, wireApp, wireCanDo, wireElementInfo, wirePoint, wireSeen, wireWindow } from "../../app/remote/wire";
import { CAPS, OP_SCHEMAS } from "../../app/main/remote/protocol";
import type { Seen } from "../../app/main/perception";
import type { AxNode } from "../../app/main/perception/sidecar";

const long = (n: number) => "w".repeat(n);

/** A read as Perception hands it out, with more than the wire carries and more than CAPS allows. */
function hugeSeen(): Seen {
  const node = (id: number): AxNode => ({
    id, parent: id ? id - 1 : null, depth: id, role: long(100), name: long(2000), states: Array.from({ length: 60 }, () => "focused-and-more-than-thirty-two-characters"),
    bounds: { x: 1e9, y: -1e9, width: NaN, height: 5 }, text: long(9000), value: Infinity, shown: { x: 1, y: 2, width: 3, height: 4 },
  });
  return {
    window: { app: long(300), pid: 42, path: "/org/a11y/atspi/accessible/1", name: long(3000), role: "frame", active: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, busy: true },
    x11Window: Object.assign({ id: 77, pid: 42, title: long(2000), x: 0, y: 0, width: 800, height: 600, wmClass: "gedit Gedit" }, { wmClassName: "Gedit" }),
    nodes: Array.from({ length: CAPS.nodes + 50 }, (_, i) => node(i)),
    blocked: false, busy: false, truncated: "nodes",
    others: [{ name: "Open", role: "dialog", active: true, modal: true }],
    ms: 12, axScale: 2,
  };
}

describe("the wire forms of what the agent reads", () => {
  it("fit perceive.read's strict schema however much the read held", () => {
    const wired = wireSeen(hugeSeen());
    const ok = OP_SCHEMAS["perceive.read"].result.safeParse(wired);
    expect(ok.success).toBe(true);
    expect(wired.nodes).toHaveLength(CAPS.nodes);
    expect(wired.nodes[1].bounds).toBeNull();
    expect(wired.nodes[1].value).toBeUndefined();
    expect(wired.nodes[1].states).toHaveLength(CAPS.states);
    expect(wired.x11Window).not.toHaveProperty("wmClassName");
  });

  it("fit the window list, element, can-do, action and point schemas", () => {
    const w = wireWindow({ app: "gedit", pid: 1, name: long(5000), role: "frame", active: false, bounds: null });
    expect(OP_SCHEMAS["perceive.windows"].result.safeParse({ windows: [w] }).success).toBe(true);
    const e = wireElementInfo({ role: "push button", name: long(5000), states: [], bounds: null, formula: long(5000) });
    expect(OP_SCHEMAS["ax.readElement"].result.safeParse(e).success).toBe(true);
    const c = wireCanDo({ tier1: false, why: long(900), handler: { role: "link", name: long(2000) } });
    expect(OP_SCHEMAS["ax.canDo"].result.safeParse(c).success).toBe(true);
    const r = wireActionResult({ ok: true, after: null, before: e, unchecked: 3.7 });
    expect(OP_SCHEMAS.act.result.safeParse({ status: "ok", result: r }).success).toBe(true);
    const p = wirePoint({ role: "text", name: "Body", bounds: { x: 1, y: 2, width: 3, height: 4 }, secret: true });
    expect(OP_SCHEMAS["perceive.atPoint"].result.safeParse({ chain: [p] }).success).toBe(true);
  });

  it("gives an app's launch argv and Terminal= so the PC can judge wrappers, and drops ids it can't name", () => {
    const app = wireApp({ id: "org.gnome.gedit", name: "Text Editor", file: "/usr/share/applications/org.gnome.gedit.desktop", keywords: ["text"], exec: "gedit %U", categories: ["GNOME", "TextEditor"] });
    expect(app).toEqual({ id: "org.gnome.gedit", name: "Text Editor", keywords: ["text"], categories: ["GNOME", "TextEditor"], argv: ["gedit"] });
    expect(wireApp({ id: "x\u0007y", name: "x", file: "", keywords: [], terminal: true })).toBeNull();
    const term = wireApp({ id: "xterm", name: "XTerm", file: "", keywords: [], exec: "xterm", terminal: true });
    expect(OP_SCHEMAS["apps.list"].result.safeParse({ apps: [term] }).success).toBe(true);
    expect(term?.terminal).toBe(true);
  });

  it("never cuts between a surrogate pair, and drops control characters where asked", () => {
    expect(cut("ab😀", 3)).toBe("ab");
    expect(cut("abc", 3)).toBe("abc");
    expect(plain("a\nb\u0000c", 10)).toBe("abc");
  });
});
