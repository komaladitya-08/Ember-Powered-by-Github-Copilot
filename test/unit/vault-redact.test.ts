/**
 * The vault's redactor (owner decision of 2026-11-12; PLAN.md §2 "Approvals", "The vault"; the slice's decision 7):
 * a value the vault filled is replaced wherever text leaves main for a model, the audit log or the logs, in whatever
 * form an app hands it back. Pure: no Electron, no runtime.
 */

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VAULT_REDACTED, VaultRedactor } from "../../app/main/vault/redact";
import { redactingClient } from "../../app/main/agent/redacting-client";
import { createLogger } from "../../app/main/logger";
import { AuditLog } from "../../app/main/policy/audit";
import { VaultService } from "../../app/main/vault/service";
import type { Logger } from "../../app/main/logger";

const PASSWORD = "Tr0ub4dor&\"CANARY\"<3";
const EMAIL = "Ada.Canary@Example.org";
const CARD = "4111111111111111";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vault-redact-")); dirs.push(d); return d; };

describe("VaultRedactor (vault-3)", () => {
  it("changes nothing until a value has been filled", () => {
    const r = new VaultRedactor();
    const o = { a: ["x", { b: "y" }] };
    expect(r.active).toBe(false);
    expect(r.text(`the password is ${PASSWORD}`)).toBe(`the password is ${PASSWORD}`);
    expect(r.deep(o)).toBe(o);
    expect(r.holds(PASSWORD)).toBe(false);
  });

  it("replaces a password wherever it stands, exactly as filled and as an address, a JSON line or markup escapes it", () => {
    const r = new VaultRedactor();
    r.note("password", PASSWORD);
    for (const text of [PASSWORD, `x${PASSWORD}y`, `https://example.org/?p=${encodeURIComponent(PASSWORD)}&n=1`, JSON.stringify({ p: PASSWORD }),
      `<input value="${PASSWORD.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}">`]) {
      expect(r.holds(text), text).toBe(true);
      const out = r.text(text);
      expect(out, text).toContain(VAULT_REDACTED);
      expect(out, text).not.toContain("CANARY");
    }
    // Its letter case is part of a password: another case is another text.
    expect(r.holds(PASSWORD.toLowerCase())).toBe(false);
    // What stands for it says nothing of its kind or length.
    expect(VAULT_REDACTED).not.toMatch(/password|\d/i);
    expect(r.text(`a ${PASSWORD} b ${PASSWORD}${PASSWORD} c`)).toBe(`a ${VAULT_REDACTED} b ${VAULT_REDACTED} c`);
  });

  it("replaces a card number with spaces or dashes between its digits, and a security code wherever it stands", () => {
    const r = new VaultRedactor();
    r.note("cardNumber", CARD);
    r.note("securityCode", "737");
    for (const text of ["4111 1111 1111 1111", "4111-1111-1111-1111", "card 4111111111111111.", "4111 1111 1111 1111"]) expect(r.text(text), text).not.toMatch(/1111/);
    expect(r.text("code 737 ok")).toBe(`code ${VAULT_REDACTED} ok`);
    expect(r.text("ref 97371")).toBe(`ref 9${VAULT_REDACTED}1`);
    expect(r.text("ending 1111")).toBe("ending 1111");
  });

  it("replaces a user name, an email or an address in any letter case and across white space, but only where it stands alone", () => {
    const r = new VaultRedactor();
    r.note("email", EMAIL);
    r.note("user", "ada");
    r.note("address", "1 Canary Row\nLondon");
    r.note("expiry", "12/27");
    expect(r.text("Signed in as ada.canary@example.org.")).toBe(`Signed in as ${VAULT_REDACTED}.`);
    expect(r.text("mailto:ADA.CANARY@EXAMPLE.ORG?subject=x")).toBe(`mailto:${VAULT_REDACTED}?subject=x`);
    expect(r.text("Hello Ada!")).toBe(`Hello ${VAULT_REDACTED}!`);
    expect(r.text("an adamant canada")).toBe("an adamant canada");
    expect(r.text("Ship to: 1 Canary Row,  London")).toBe(`Ship to: ${VAULT_REDACTED}`); // its lines joined by a comma
    expect(r.text("1 Canary Lane Row London")).toBe("1 Canary Lane Row London"); // other words between: not the value
    expect(r.text("Ship to: 1 canary row   london.")).toBe(`Ship to: ${VAULT_REDACTED}.`);
    expect(r.text("valid 12/27")).toBe(`valid ${VAULT_REDACTED}`);
    expect(r.text("on 12/2712")).toBe("on 12/2712");
    expect(r.shown).toBe(true);
    expect(new VaultRedactor().shown).toBe(false);
  });

  it("finds a value with any punctuation in it, in every form (found by the canary test: a hyphen made every pattern of a value invalid, and it was let through)", () => {
    const r = new VaultRedactor();
    const odd = "a-b.c*d+e?f^g$h{i}j(k)l|m[n]o\\p/q-";
    r.note("password", odd);
    r.note("email", "ada.contact-canary@example.org");
    r.note("phone", "+44 20 7946 0958");
    expect(r.text(`x${odd}y`)).toBe(`x${VAULT_REDACTED}y`);
    expect(r.text(JSON.stringify({ p: odd }))).not.toContain("a-b.c");
    expect(r.text(`?p=${encodeURIComponent(odd)}`)).toBe(`?p=${VAULT_REDACTED}`);
    expect(r.text("to ada.contact-canary@example.org")).toBe(`to ${VAULT_REDACTED}`);
    expect(r.text("call +44 20 7946 0958 now")).toBe(`call ${VAULT_REDACTED} now`);
  });

  it("never looks for one value inside the words that stand for another", () => {
    const r = new VaultRedactor();
    r.note("email", EMAIL);
    for (const word of ["hidden", "filled", "from", "Ember", "vault"]) r.note("user", word);
    expect(r.text(`to ${EMAIL} now`)).toBe(`to ${VAULT_REDACTED} now`);
  });

  it("goes through arrays and plain objects, keys too, and leaves what it is told to skip and what isn't text", () => {
    const r = new VaultRedactor();
    r.note("password", PASSWORD);
    const buf = Buffer.from(PASSWORD);
    const same = { a: 1, b: ["x"], c: buf };
    expect(r.deep(same)).toBe(same);
    const out = r.deep({ [PASSWORD]: [`is ${PASSWORD}`, { data: PASSWORD, mimeType: "image/jpeg" }], n: 3, buf }, (k, parent) => k === "data" && "mimeType" in parent);
    expect(Object.keys(out)).toEqual([VAULT_REDACTED, "n", "buf"]);
    expect((out as unknown as Record<string, unknown[]>)[VAULT_REDACTED]).toEqual([`is ${VAULT_REDACTED}`, { data: PASSWORD, mimeType: "image/jpeg" }]);
    expect(out.buf).toBe(buf);
  });
});

describe("redactingClient: where text leaves for a model (vault-3)", () => {
  function client() {
    const sent: unknown[] = [];
    const configs: Record<string, unknown>[] = [];
    const session = { id: "s1", send: async (o: unknown) => { sent.push(o); return "m1"; }, sendAndWait: async (o: unknown, ms?: number) => { sent.push([o, ms]); return { data: { content: "ok" } }; },
      who() { return this.id; }, rpc: { tools: {} } };
    const raw = {
      started: 0, start() { this.started++; return Promise.resolve(); },
      createSession: async (config: Record<string, unknown>) => { configs.push(config); return session; },
      resumeSession: async (_id: string, config: Record<string, unknown>) => { configs.push(config); return session; },
    };
    return { raw, sent, configs, session };
  }

  it("redacts every prompt, system message, tool result, tool error and hook answer of every session it makes, and leaves pictures as they are", async () => {
    const r = new VaultRedactor();
    const { raw, sent, configs } = client();
    const c = redactingClient(raw, r);
    await c.start();
    expect(raw.started).toBe(1);
    const tools = [
      { name: "read", description: "d", handler: async () => `the field says ${EMAIL}` },
      { name: "look", handler: async () => ({ textResultForLlm: `<screen>${PASSWORD}</screen>`, resultType: "success", binaryResultsForLlm: [{ type: "image", mimeType: "image/jpeg", data: "ada", description: `of ${EMAIL}` }] }) },
      { name: "boom", handler: async () => { throw new Error(`the app said: bad password ${PASSWORD}`); } },
      { name: "plain", handler: () => ({ n: 1 }) },
    ];
    const config = { tools, systemMessage: { mode: "replace", content: `You help ${EMAIL}.` }, hooks: { onPostToolUse: async () => ({ additionalContext: `saw ${PASSWORD}` }) }, onPermissionRequest: () => ({ kind: "denied", message: PASSWORD }) };
    // Before anything is filled: everything passes as it is.
    const before = await c.createSession(config as never) as unknown as { send(o: unknown): Promise<string>; sendAndWait(o: unknown, ms?: number): Promise<unknown>; who(): string };
    expect(await (configs[0].tools as typeof tools)[0].handler()).toBe(`the field says ${EMAIL}`);
    expect(before.who()).toBe("s1");
    r.note("password", PASSWORD);
    r.note("email", EMAIL);
    r.note("user", "ada");
    // A session made before the fill is covered from the fill on, and one made after it too.
    const after = await c.resumeSession("s1", config as never) as unknown as typeof before;
    for (const made of configs) {
      const t = made.tools as typeof tools;
      expect(await t[0].handler()).toBe(`the field says ${VAULT_REDACTED}`);
      expect(await t[1].handler()).toEqual({ textResultForLlm: `<screen>${VAULT_REDACTED}</screen>`, resultType: "success",
        binaryResultsForLlm: [{ type: "image", mimeType: "image/jpeg", data: "ada", description: `of ${VAULT_REDACTED}` }] });
      await expect(t[2].handler()).rejects.toThrow(`the app said: bad password ${VAULT_REDACTED}`);
      expect(await t[3].handler()).toEqual({ n: 1 });
      expect(t[0].name).toBe("read");
      expect(await (made.hooks as { onPostToolUse(): Promise<unknown> }).onPostToolUse()).toEqual({ additionalContext: `saw ${VAULT_REDACTED}` });
      expect((made.onPermissionRequest as () => unknown)()).toEqual({ kind: "denied", message: VAULT_REDACTED });
    }
    expect(configs[0].systemMessage).toEqual(config.systemMessage);
    expect(configs[1].systemMessage).toEqual({ mode: "replace", content: `You help ${VAULT_REDACTED}.` });
    expect(await before.send({ prompt: `<task_result>${EMAIL}</task_result>`, mode: "immediate" })).toBe("m1");
    await after.sendAndWait({ prompt: `Is “${PASSWORD}” in the user's words?`, attachments: [{ type: "blob", data: "ada", mimeType: "image/png" }] }, 5000);
    expect(sent).toEqual([{ prompt: `<task_result>${VAULT_REDACTED}</task_result>`, mode: "immediate" },
      [{ prompt: `Is “${VAULT_REDACTED}” in the user's words?`, attachments: [{ type: "blob", data: "ada", mimeType: "image/png" }] }, 5000]]);
    expect(JSON.stringify(sent)).not.toMatch(/CANARY|canary/);
  });

  it("is what AgentHost wraps the runtime client in, with main's own redactor, before any session exists", () => {
    const host = fs.readFileSync(path.join(__dirname, "../../app/main/agent/host.ts"), "utf8");
    expect(host).toContain("client = this.o.redact ? redactingClient(runtime, this.o.redact) : runtime;");
    expect(host.match(/new CopilotClient\(/g)).toHaveLength(1);
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toContain("const vaultRedactor = new VaultRedactor();");
    expect(main).toContain("redact: vaultRedactor,");
    expect(main).toContain("redact: text => vaultRedactor.text(text),");
    expect(main).toContain("entry => vaultRedactor.deep(entry));");
    expect(main).toContain("filling: (part, value) => vaultRedactor.note(part, value),");
    expect(main).toContain("holdsVaultValue: text => vaultRedactor.holds(text), vaultShown: () => vaultRedactor.shown,");
  });
});

describe("the logs and the audit log after a fill (vault-3)", () => {
  it("never write a value the vault filled, whatever field, key or error holds it", () => {
    const r = new VaultRedactor();
    const dir = tmp();
    const log = createLogger({ dir: path.join(dir, "logs"), level: "debug", redact: t => r.text(t) });
    const audit = new AuditLog(path.join(dir, "audit"), undefined, undefined, undefined, e => r.deep(e));
    log.debug("sidecar.stderr", { line: `before ${EMAIL}` });
    r.note("password", PASSWORD);
    r.note("email", EMAIL);
    log.debug("sidecar.stderr", { line: `set_text failed: ${PASSWORD}`, [EMAIL]: 1 });
    log.child("task-1").warn("worker.failed", { err: new Error(`title was ${EMAIL.toLowerCase()} - Inbox`), nested: [{ deep: PASSWORD }] });
    audit.write({ event: "action", task: "t1", kind: "click", app: "firefox", window: `Inbox - ${EMAIL} - Mail`, element: { role: "link", name: EMAIL }, ok: true } as never);
    const logged = fs.readFileSync(log.file, "utf8").split("\n").filter(Boolean);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toContain(EMAIL); // what was written before the fill is as it was
    expect(logged.slice(1).join("\n")).not.toMatch(/CANARY|canary/i);
    expect(logged[1]).toContain(JSON.stringify(`set_text failed: ${VAULT_REDACTED}`));
    for (const line of logged) expect(() => JSON.parse(line)).not.toThrow();
    const audited = fs.readFileSync(audit.file, "utf8");
    expect(audited).not.toMatch(/canary/i);
    expect(JSON.parse(audited.trim())).toMatchObject({ event: "action", window: `Inbox - ${VAULT_REDACTED} - Mail`, element: { role: "link", name: VAULT_REDACTED } });
    expect(JSON.stringify(audit.recent(5))).not.toMatch(/canary/i);
  });
});

describe("VaultService.use and the redactor (vault-3)", () => {
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as unknown as Logger;
  const service = (filling: (part: string, value: string) => void) => new VaultService({
    store: { list: () => [], find: () => ({ id: "e1", kind: "login", dest: { site: "https://github.com" }, savedAt: 1 }), forget: () => true, forgetAll: () => true, canPersist: async () => true,
      add: async () => ({ ok: false, why: "full" }), open: async () => ({ meta: { id: "e1", kind: "login", dest: { site: "https://github.com" }, savedAt: 1 }, values: { user: EMAIL, password: PASSWORD } }) } as never,
    form: { ask: async () => "cancelled", stop: () => {} }, allowed: () => true, consented: () => true, autopilot: () => true, appName: k => k, log, filling: filling as never,
  });

  it("notes a value with the redactor before it is put anywhere", async () => {
    const r = new VaultRedactor();
    let known: boolean | null = null;
    const used = await service((part, value) => r.note(part as never, value)).use("login", "password", { site: "https://github.com" }, async value => { known = r.holds(`x${value}`); return "put"; });
    expect(used).toEqual({ ok: true, result: "put" });
    expect(known).toBe(true);
  });

  it("fills nothing when the value can't be noted", async () => {
    let put = 0;
    const used = await service(() => { throw new Error("no"); }).use("login", "password", { site: "https://github.com" }, async () => { put++; return "put"; });
    expect(used).toEqual({ ok: false, why: "off" });
    expect(put).toBe(0);
  });
});
