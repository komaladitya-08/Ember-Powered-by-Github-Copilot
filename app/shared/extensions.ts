/**
 * The contract between Ember's extensions runtime (app/main/extensions/, main) and Home's Extensions section (the
 * renderer, through its preload): what is installed, what a marketplace offers, and what Home may ask for. Pure
 * types, no Electron, so both sides and their tests import them.
 *
 * Only the user installs, enables, removes, connects or disconnects, and only in Home: the model never gets a
 * management tool (PLAN.md §2 "Connectors", docs/DEVELOPING.md "Extensions").
 */

/** What an item is. Ember loads only the MCP servers of a plugin; "connector" and "extension" are off (see the docs). */
export type ExtensionKind = "plugin" | "connector" | "extension";
/** The brief's name for ExtensionKind. */
export type Kind = ExtensionKind;

/** One tool an item offers, as Ember pinned it when the user agreed. */
export interface ToolInfo {
  /** The tool's own name (the server's, not the model-facing one). */
  name: string;
  description: string;
  /** The server marked it read-only (`readOnlyHint`) and not destructive: such calls run without asking once agreed. */
  readOnly: boolean;
  /** Its name, description, schema or hints changed since the user agreed: it is off until they agree again (reagree). */
  changed?: boolean;
}

/** An installed item and its state. */
export interface Installed {
  id: string;
  kind: ExtensionKind;
  name: string;
  publisher?: string;
  /** Where it came from: "<plugin>@<marketplace>". */
  source: string;
  version?: string;
  enabled: boolean;
  consented: boolean;
  status: "ready" | "starting" | "needs-auth" | "failed" | "disabled";
  /** One plain sentence about the status (why it failed, what it needs). */
  detail?: string;
  tools: ToolInfo[];
  /** Where it reaches: the commands it runs on this computer and the web addresses it calls (for the consent card). */
  reaches?: string[];
}

/** One item a marketplace (or the connectors catalog) offers. */
export interface MarketplaceEntry {
  marketplace: string;
  name: string;
  description: string;
  publisher?: string;
  /** Where its files come from: a folder in the marketplace, or "owner/repo" on GitHub. */
  source: string;
  version?: string;
  kind: ExtensionKind;
  installed: boolean;
  /** Where it reaches, when Ember could read it before installing (a plugin kept in the marketplace itself). */
  reaches?: string[];
}

/** A connector's connect result. */
export type ConnectResult = { state: "connected" } | { state: "consent"; url: string } | { state: "pending" } | { ok: false; why: string };

/** What Home may call (main implements it in ExtensionsService). */
export interface ExtensionsApi {
  /** The administrator's `features.extensions` isn't false and Ember isn't locked down. */
  allowed(): boolean;
  list(): Promise<Installed[]>;
  marketplaces(): Promise<{ name: string; source: string }[]>;
  addMarketplace(source: string): Promise<{ ok: true } | { ok: false; why: string }>;
  removeMarketplace(name: string): Promise<void>;
  browse(marketplace: string): Promise<MarketplaceEntry[]>;
  /** Installs (after Home's consent card): the user's agreement is recorded with the tools as they are now. */
  install(marketplace: string, name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  uninstall(id: string): Promise<void>;
  setEnabled(id: string, on: boolean): Promise<void>;
  /** The GitHub-hosted connectors catalog (empty while connectors are off). */
  connectors(): Promise<MarketplaceEntry[]>;
  connect(name: string): Promise<ConnectResult>;
  disconnect(id: string): Promise<void>;
  /** The user agreed again after a tool changed (a rug pull): the tools are pinned as they are now. */
  reagree(id: string): Promise<void>;
  onChange(fn: () => void): () => void;
}

/** Plain-sentence limits Home can rely on when it checks arguments. */
export const EXTENSION_LIMITS = { source: 500, name: 100, id: 120 } as const;
