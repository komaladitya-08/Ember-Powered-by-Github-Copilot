/**
 * The vault's two methods on the Windows and macOS accessibility host (app/sidecar-host/actions.ts; the slice's
 * decision 6): vault_fill, the one method that writes into a password or secret field, which says nothing of what it
 * wrote, and page_address, which reads where a field's page is from the document itself.
 */

import { describe, expect, it } from "vitest";
import { Host } from "../../app/sidecar-host/host";
import { FakeProvider, type FakeElementSpec, type FakeWindowSpec } from "../../app/sidecar-host/providers/fake";
import type { ReadWindowResult } from "../../app/main/perception/sidecar";

const CANARY = "s3cret-CANARY-9f";
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const app = (children: FakeElementSpec[], more: Partial<FakeWindowSpec> = {}): FakeWindowSpec[] =>
  [{ role: "Window", name: "App", pid: 30, app: "app", native: 300, active: true, bounds: at(0, 0, 600, 500), children, ...more }];
const password: FakeElementSpec = { role: "Edit", name: "Password", password: true, editable: true, bounds: at(10, 10, 100, 20), actions: ["setValue"] };
const email: FakeElementSpec = { role: "Edit", name: "Email", value: "", editable: true, bounds: at(10, 40, 100, 20), actions: ["setValue"] };

function harness(windows: FakeWindowSpec[], vocabulary: "uia" | "ax" = "uia") {
  const fake = new FakeProvider(windows, { deadlineMs: 300, vocabulary });
  const notes: string[] = [];
  const host = new Host(fake, { env: { EMBER_ATSPI_ID_BASE: "10000000" }, settleMs: 0, note: (event: string, fields?: unknown) => { notes.push(JSON.stringify([event, fields])); } });
  let n = 1;
  const lines: string[] = [];
  const call = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const line = (await host.handle(JSON.stringify({ jsonrpc: "2.0", id: n++, method, params })))!;
    lines.push(line);
    const msg = JSON.parse(line);
    if (msg.error) throw new Error(msg.error.message);
    return msg.result as T;
  };
  const fails = (method: string, params: Record<string, unknown> = {}) => call(method, params).then(() => "resolved", (e: Error) => e.message);
  const read = () => call<ReadWindowResult>("read_window", {});
  const id = async (name: string) => {
    const node = (await read()).nodes.find(x => x.name === name && x.role !== "label");
    if (!node) throw new Error(`no node "${name}"`);
    return node.id;
  };
  return { fake, call, fails, read, id, lines, notes };
}

describe("vault_fill on the accessibility host (vault-2)", () => {
  it("writes into a password field, the one method that does, and says nothing of what it wrote", async () => {
    const { fake, call, fails, id, lines, notes } = harness(app([password, email]));
    const field = await id("Password");
    const r = await call<{ ok: boolean; took?: boolean; keys: unknown[] }>("vault_fill", { id: field, text: CANARY });
    expect(r.ok).toBe(true);
    expect(r.took).toBeUndefined();
    expect(r.keys).toHaveLength(1);
    expect(fake.filled.get(fake.el("Password"))).toBe(CANARY);
    expect(fake.log).toEqual([{ op: "fillValue", name: "Password", role: "Edit" }]);
    // Ordinary typing is refused exactly as before.
    expect(await fails("set_text", { id: field, text: "x" })).toBe("password fields are off limits to Ember; the user must fill them in");
    expect([...lines, ...notes, JSON.stringify(fake.log)].join("\n")).not.toContain(CANARY);
  });

  it("makes a field it filled secret from then on: nothing reads what it holds, and typing there is refused", async () => {
    const { call, fails, read, id, lines } = harness(app([password, email]));
    const field = await id("Email");
    const r = await call<{ ok: boolean; took?: boolean }>("vault_fill", { id: field, text: "ada@canary.example" });
    expect(r).toMatchObject({ ok: true, took: true });
    const after = (await read()).nodes.find(n => n.name === "Email")!;
    expect(after.secret).toBe(true);
    expect(after.text).toBeUndefined();
    expect(await fails("set_text", { id: field, text: "x" })).toBe("this looks like a password or payment field; the user must fill it in");
    expect(lines.join("\n")).not.toContain("canary.example");
  });

  it("fills only a usable password or plain text field", async () => {
    const { fake, fails, id } = harness(app([
      password, email,
      { role: "Button", name: "Sign in", bounds: at(10, 70, 60, 24), actions: ["invoke"] },
      { role: "Edit", name: "Fixed", value: "x", bounds: at(10, 100, 100, 20) },
      { role: "ComboBox", name: "Country", value: "", editable: true, bounds: at(10, 130, 100, 20), actions: ["setValue", "expand", "collapse"] },
    ]));
    expect(await fails("vault_fill", { id: await id("Sign in"), text: CANARY })).toMatch(/^background_unavailable: this element is no field the vault can fill/);
    expect(await fails("vault_fill", { id: await id("Country"), text: CANARY })).toMatch(/^background_unavailable/);
    expect(await fails("vault_fill", { id: await id("Fixed"), text: CANARY })).toMatch(/^background_unavailable: this element's text can't be edited directly/);
    const field = await id("Password");
    for (const text of ["", undefined, 7, null]) expect(await fails("vault_fill", { id: field, text })).toBe("nothing to fill");
    fake.el("Password").spec.enabled = false;
    expect(await fails("vault_fill", { id: field, text: CANARY })).toMatch(/disabled right now/);
    fake.el("Password").spec.enabled = true;
    fake.el("Password").spec.offscreen = true;
    expect(await fails("vault_fill", { id: field, text: CANARY })).toMatch(/no longer on screen/);
    fake.remove(fake.el("Password"));
    expect(await fails("vault_fill", { id: field, text: CANARY })).toMatch(/is gone/);
    expect(fake.filled.size).toBe(0);
    expect(fake.log).toEqual([]);
  });

  it("says only that the app didn't answer or refused, never the platform's own words", async () => {
    const { fake, fails, id, lines } = harness(app([password]));
    const field = await id("Password");
    fake.perform = async () => { throw new Error(`SetValue failed for '${CANARY}'`); };
    expect(await fails("vault_fill", { id: field, text: CANARY })).toBe("the app refused the text");
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  it("says when an ordinary field didn't take all of it", async () => {
    const { fake, call, id } = harness(app([email]));
    const field = await id("Email");
    const perform = fake.perform.bind(fake);
    fake.perform = async (h, op, value) => perform(h, op, String(value).slice(0, 3));
    expect((await call<{ took?: boolean }>("vault_fill", { id: field, text: "ada@canary.example" })).took).toBe(false);
  });
});

describe("page_address on the accessibility host (vault-2)", () => {
  const page = (url: string | undefined, children: FakeElementSpec[], name = "A page"): FakeElementSpec =>
    ({ role: "Document", framework: "Chrome", name, bounds: at(0, 40, 600, 460), ...(url !== undefined ? { value: url } : {}), children });

  it("reads the documents around a field from the documents themselves, the nearest first", async () => {
    const { call, id } = harness(app([
      { role: "Edit", name: "Address and search bar", value: "https://evil.example/", editable: true, bounds: at(0, 0, 600, 30), actions: ["setValue"] },
      page("https://shop.example/checkout", [{ role: "Pane", name: "https://bank.example", bounds: at(0, 60, 600, 300), children: [page("https://pay.example/frame", [password], "Pay")] }]),
    ]));
    expect(await call("page_address", { id: await id("Password") })).toEqual({ urls: ["https://pay.example/frame", "https://shop.example/checkout"] });
    // The browser's own field is in no page.
    expect(await call("page_address", { id: await id("Address and search bar") })).toEqual({ urls: [] });
  });

  it("reads the address as it is now, not as it was when the window was read", async () => {
    const { fake, call, id } = harness(app([page("https://github.com/login", [password])]));
    const field = await id("Password");
    fake.el("A page").spec.value = "https://evil.example/login";
    expect(await call("page_address", { id: field })).toEqual({ urls: ["https://evil.example/login"] });
  });

  it("answers \"\" for a document that reports no address, and fails when a document is gone", async () => {
    const { fake, call, fails, id } = harness(app([page(undefined, [password])]));
    const field = await id("Password");
    expect(await call("page_address", { id: field })).toEqual({ urls: [""] });
    fake.remove(fake.el("A page"));
    expect(await fails("page_address", { id: field })).toMatch(/is gone/);
  });

  it("reports no address on macOS, where the host doesn't read one: Ember then fills nothing in a page there", async () => {
    const { call, id } = harness([{ role: "AXWindow", name: "App", pid: 30, app: "Safari", native: 300, active: true, bounds: at(0, 0, 600, 500), children: [
      { role: "AXWebArea", name: "A page", value: "https://github.com/login", bounds: at(0, 40, 600, 460), children: [
        { role: "AXTextField", subrole: "AXSecureTextField", name: "Password", password: true, editable: true, bounds: at(10, 60, 100, 20) }] }] }], "ax");
    expect(await call("page_address", { id: await id("Password") })).toEqual({ urls: [""] });
  });
});
