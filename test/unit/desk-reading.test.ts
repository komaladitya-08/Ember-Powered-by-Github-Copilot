/** Read-only desk semantics omit secrets, descendants and misleading mirrored values and have bounded output. */
import { describe, expect, it } from "vitest";
import { deskReading } from "../../app/main/desk/reading";
import type { Seen } from "../../app/main/perception";
import type { AxNode } from "../../app/main/perception/sidecar";

const node = (id: number, extra: Partial<AxNode> = {}): AxNode => ({ id, parent: null, depth: 0, role: "text", name: "", states: ["enabled"], bounds: null, ...extra });
const seen = (nodes: AxNode[], extra: Partial<Seen> = {}): Seen => ({ nodes, window: { app: "Text Editor", name: "Draft", pid: 2, role: "frame", active: true, bounds: null },
  x11Window: null, blocked: false, busy: false, truncated: null, others: [], ms: 2, axScale: 1, ...extra });

describe("read-only desk content (UX14)", () => {
  it("provides names, states and selected text as inert data rather than app actions", () => {
    const read = deskReading(seen([node(1, { role: "button", name: "Save", states: ["enabled", "focused"], actions: ["click"] }),
      node(2, { text: "<script>app text</script>", selection: "selected sentence" })]), 10);
    expect(read.title).toBe("Draft");
    expect(read.rows[0]).toEqual({ role: "button", name: "Save", text: "focused" });
    expect(read.rows[1].text).toContain("Selected: selected sentence");
    expect(read.rows[1].text).toContain("<script>");
    expect(read.rows.some(r => "id" in r || "actions" in r)).toBe(false);
  });

  it("omits secret fields and children, leaked copies of their values, and reader-withheld elements", () => {
    const secret = "1234567890123456";
    const read = deskReading(seen([node(1, { role: "password text", name: "Password", secret: true, text: secret }),
      node(2, { parent: 1, name: "private child", text: secret }), node(3, { role: "button", name: secret }),
      node(4, { name: "Secret mirror", text: "hidden", withheld: true }), node(5, { name: "Document", text: "Public content" })]));
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(JSON.stringify(read)).not.toContain("private child");
    expect(JSON.stringify(read)).not.toContain("hidden");
    expect(read.rows.some(r => r.text === "Public content")).toBe(true);
  });

  it("doesn't expose titles or nodes for a private, own or missing window", () => {
    for (const state of [{ blocked: true }, { ember: true }, { window: null }]) {
      const read = deskReading(seen([node(1, { text: "private words" })], state));
      expect(read.rows).toEqual([]); expect(read.title).toBe("");
      expect(JSON.stringify(read)).not.toContain("private words");
    }
  });

  it("bounds large reads and marks partial snapshots honestly", () => {
    const read = deskReading(seen(Array.from({ length: 5000 }, (_, id) => node(id, { name: `Control ${id}`, text: "x".repeat(3000) }))));
    expect(read.rows.length).toBeLessThanOrEqual(100);
    expect(read.rows.reduce((sum, r) => sum + r.name.length + r.text.length, 0)).toBeLessThanOrEqual(24_000);
    expect(read.message).toContain("Partial text");
    expect(deskReading(seen([node(1, { name: "Visible" })], { busy: true })).message).toContain("Partial text");
  });
});
