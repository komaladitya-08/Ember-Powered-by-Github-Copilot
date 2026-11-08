/**
 * Extensions, plugins and connectors: the contract between main's ExtensionsService (app/main/extensions/) and Home's
 * Extensions section (IPC in app/main/extensions-ipc.ts). Only the user installs, enables, removes, connects or
 * disconnects, and only in Home; Ember's policy decides every call to these tools.
 */

export type Kind = "plugin" | "connector" | "extension";
export interface ToolInfo { server?: string; name: string; description: string; readOnly: boolean; changed?: boolean; nameConflict?: boolean }
export interface Installed { id: string; kind: Kind; name: string; publisher?: string; source: string; version?: string;
  enabled: boolean; consented: boolean; status: "ready" | "starting" | "needs-auth" | "failed" | "disabled";
  detail?: string; tools: ToolInfo[];
  /** The exact discovered tools awaiting review, grouped by server; the token binds Home's click to this list. */
  reviewTools?: ToolInfo[]; reviewToken?: string; needsReview?: boolean;
  /** Where it reaches: the commands it runs on this computer and the hosts it calls (runtime addition). */
  reaches?: string[] }
export interface MarketplaceEntry { marketplace: string; name: string; description: string; publisher?: string;
  source: string; version?: string; kind: Kind; installed: boolean;
  /** Where it reaches, when Ember could read it before installing (a plugin kept in the marketplace itself). */
  reaches?: string[];
  /** Tool counts, when known before installing (they are only once a server has been asked: so far never). */
  readOnlyTools?: number; changingTools?: number;
  /** A trust tier the marketplace states (none of today's do). */
  trust?: string }
/**
 * A marketplace the runtime knows: `builtIn` is one Copilot ships with (its isDefault; it can't be removed), `managed`
 * one the organisation's managed settings provide (it can't be removed here either).
 */
export interface Marketplace { name: string; source: string; builtIn?: boolean; managed?: boolean }
/** A connector's connect result. */
export type ConnectResult = { state: "connected" } | { state: "consent"; url: string } | { state: "pending" } | { ok: false; why: string };
export interface ExtensionsApi {
  allowed(): boolean;                         // admin features.extensions and not LOCKDOWN
  /** The user agreed to extensions' first-use card at FEATURE_CONSENT_VERSION.extensions (settings `extensions`). */
  consented(): boolean;
  /** Ember's model connection is up, so the runtime can list marketplaces and run what was added (absent: assumed so). */
  connected?(): boolean;
  /** Records that agreement (and turns extensions on); Home calls it from the card's yes. */
  agree(): Promise<void>;
  list(): Promise<Installed[]>;
  marketplaces(): Promise<Marketplace[]>;
  addMarketplace(source: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Refused, in one sentence, for a marketplace built into Copilot or set by the organisation. */
  removeMarketplace(name: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** What it offers, or why its list couldn't be fetched or read, in one sentence (never an empty list for that). */
  browse(marketplace: string): Promise<MarketplaceEntry[] | { ok: false; why: string }>;
  install(marketplace: string, name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }>; // after Home's consent card
  uninstall(id: string): Promise<void>;
  setEnabled(id: string, on: boolean): Promise<void>;
  connectors(): Promise<MarketplaceEntry[]>;  // GitHub-hosted catalog
  connect(name: string): Promise<ConnectResult>;
  disconnect(id: string): Promise<void>;
  reagree(id: string, reviewToken: string): Promise<void>;         // after a tool changed (rug pull)
  onChange(fn: () => void): () => void;
}
