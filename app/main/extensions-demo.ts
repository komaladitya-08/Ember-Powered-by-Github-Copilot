/**
 * A pretend ExtensionsApi for development and the render checks (`EMBER_TEST_EXTENSIONS`, read through devEnv, so an
 * installed Ember ignores it): Home's Extensions section with made-up marketplaces, plugins and connectors, kept in
 * memory only. It reaches no network and runs nothing. "demo" is populated (a tool changed since the user agreed, a
 * connector that needs signing in again), "empty" has nothing added, and "managed" is turned off by the organisation.
 */

import type { ExtensionsApi, Installed, MarketplaceEntry } from "../shared/extensions";

export type DemoVariant = "demo" | "empty" | "managed";

/** The variant `EMBER_TEST_EXTENSIONS` names, or null for none. */
export function demoVariant(v: string | undefined): DemoVariant | null {
  return v === "demo" || v === "empty" || v === "managed" ? v : v === "1" ? "demo" : null;
}

const MARKETPLACES = [
  { name: "Copilot plugins", source: "github/copilot-plugins" },
  { name: "Octo Labs", source: "https://plugins.octolabs.example/marketplace.json" },
];

const CATALOG: Omit<MarketplaceEntry, "installed">[] = [
  { marketplace: "Copilot plugins", name: "Release notes", description: "Drafts release notes from the merged pull requests since the last tag.", publisher: "GitHub", source: "github/copilot-plugins", version: "1.4.0", kind: "plugin" },
  { marketplace: "Copilot plugins", name: "Issue triage", description: "Reads new issues and suggests labels, owners and duplicates. It never changes an issue without asking.", publisher: "GitHub", source: "github/copilot-plugins", version: "0.9.2", kind: "plugin" },
  { marketplace: "Copilot plugins", name: "Calendar helper", description: "Finds free time across your calendars and drafts invitations for you to send.", publisher: "Octo Labs", source: "octolabs/calendar-helper", version: "2.0.1", kind: "extension" },
  { marketplace: "Octo Labs", name: "Spreadsheet tools", description: "Reads, sums and charts the spreadsheets you point it at, and writes new sheets beside them when you ask.", publisher: "Octo Labs", source: "octolabs/sheet-tools", version: "3.1.0", kind: "plugin" },
];

const CONNECTORS: Omit<MarketplaceEntry, "installed">[] = [
  { marketplace: "GitHub", name: "Slack", description: "Read channels and threads, and post messages when you ask.", publisher: "Slack", source: "GitHub connectors", kind: "connector" },
  { marketplace: "GitHub", name: "Notion", description: "Search and read your pages, and add to them when you ask.", publisher: "Notion", source: "GitHub connectors", kind: "connector" },
  { marketplace: "GitHub", name: "Linear", description: "Find issues and projects, and file new issues.", publisher: "Linear", source: "GitHub connectors", kind: "connector" },
  { marketplace: "GitHub", name: "Figma", description: "Read files, frames and comments.", publisher: "Figma", source: "GitHub connectors", kind: "connector" },
];

const INSTALLED: Installed[] = [
  {
    id: "plugin:release-notes", kind: "plugin", name: "Release notes", publisher: "GitHub", source: "github/copilot-plugins", version: "1.4.0",
    enabled: true, consented: true, status: "ready",
    tools: [
      { name: "list_merged_pulls", description: "Lists the pull requests merged since a tag.", readOnly: true },
      { name: "draft_notes", description: "Writes a draft of the release notes.", readOnly: true },
      { name: "publish_release", description: "Publishes a release on GitHub.", readOnly: false },
    ],
  },
  {
    id: "plugin:sheet-tools", kind: "plugin", name: "Spreadsheet tools", publisher: "Octo Labs", source: "octolabs/sheet-tools", version: "3.1.0",
    enabled: true, consented: false, status: "ready",
    tools: [
      { name: "read_sheet", description: "Reads the cells of a sheet.", readOnly: true },
      { name: "write_sheet", description: "Writes cells, and now also emails the sheet to an address.", readOnly: false, changed: true },
    ],
  },
  {
    id: "connector:slack", kind: "connector", name: "Slack", publisher: "Slack", source: "GitHub connectors", enabled: true, consented: true, status: "ready",
    tools: [
      { name: "search_messages", description: "Searches messages.", readOnly: true },
      { name: "post_message", description: "Posts a message to a channel.", readOnly: false },
    ],
  },
  {
    id: "connector:notion", kind: "connector", name: "Notion", publisher: "Notion", source: "GitHub connectors", enabled: true, consented: true, status: "needs-auth",
    tools: [{ name: "search_pages", description: "Searches pages.", readOnly: true }],
  },
];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The pretend runtime for `variant`. */
export function demoExtensionsApi(variant: DemoVariant): ExtensionsApi {
  const populated = variant !== "empty";
  let marketplaces = populated ? clone(MARKETPLACES) : [];
  let installed: Installed[] = populated ? clone(INSTALLED) : [];
  const asked = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const fn of listeners) fn(); };
  const has = (name: string) => installed.some(i => i.name === name);
  const entry = (e: Omit<MarketplaceEntry, "installed">): MarketplaceEntry => ({ ...e, installed: has(e.name) });
  return {
    allowed: () => variant !== "managed",
    list: async () => clone(installed),
    marketplaces: async () => clone(marketplaces),
    addMarketplace: async source => {
      await wait(300);
      if (/fail/.test(source)) return { ok: false, why: "Ember couldn't find a marketplace list there." };
      marketplaces = [...marketplaces, { name: source.replace(/^https:\/\//, "").split("/").slice(-1)[0] || source, source }];
      changed();
      return { ok: true };
    },
    removeMarketplace: async name => { marketplaces = marketplaces.filter(m => m.name !== name); changed(); },
    browse: async marketplace => { await wait(300); return CATALOG.filter(e => e.marketplace === marketplace || marketplace === "*").map(entry); },
    install: async (marketplace, name) => {
      const e = CATALOG.find(x => x.marketplace === marketplace && x.name === name);
      if (!e) return { ok: false, why: "That marketplace doesn't list it any more." };
      const id = `${e.kind}:${name.toLowerCase().replace(/\W+/g, "-")}`;
      installed = [...installed, { id, kind: e.kind, name, publisher: e.publisher, source: e.source, version: e.version, enabled: true, consented: true, status: "ready", tools: [{ name: "read", description: "Reads.", readOnly: true }] }];
      changed();
      return { ok: true, id };
    },
    uninstall: async id => { installed = installed.filter(i => i.id !== id); changed(); },
    setEnabled: async (id, on) => { installed = installed.map(i => (i.id === id ? { ...i, enabled: on, status: on ? "ready" : "disabled" } : i)); changed(); },
    connectors: async () => { await wait(200); return CONNECTORS.map(entry); },
    connect: async name => {
      const e = CONNECTORS.find(c => c.name === name);
      if (!e) return { ok: false, why: "GitHub doesn't offer that connector to your account." };
      // The first press opens GitHub's page; once "finished" there, the next press connects.
      if (!asked.has(name)) { asked.add(name); return name === "Figma" ? { state: "pending" } : { state: "consent", url: `https://github.com/settings/connections/${encodeURIComponent(name.toLowerCase())}` }; }
      const id = `connector:${name.toLowerCase()}`;
      installed = [...installed.filter(i => i.id !== id), { id, kind: "connector", name, publisher: e.publisher, source: e.source, enabled: true, consented: true, status: "ready", tools: [{ name: "search", description: "Searches.", readOnly: true }] }];
      changed();
      return { state: "connected" };
    },
    disconnect: async id => { installed = installed.filter(i => i.id !== id); changed(); },
    reagree: async id => { installed = installed.map(i => (i.id === id ? { ...i, consented: true, tools: i.tools.map(t => ({ ...t, changed: false })) } : i)); changed(); },
    onChange: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
