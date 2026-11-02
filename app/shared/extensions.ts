/**
 * Extensions, plugins and connectors: the contract between main's ExtensionsService (app/main/extensions/) and Home's
 * Extensions section (IPC in app/main/extensions-ipc.ts). Only the user installs, enables, removes, connects or
 * disconnects, and only in Home; Ember's policy decides every call to these tools.
 */

export type Kind = "plugin" | "connector" | "extension";
export interface ToolInfo { name: string; description: string; readOnly: boolean; changed?: boolean }
export interface Installed { id: string; kind: Kind; name: string; publisher?: string; source: string; version?: string;
  enabled: boolean; consented: boolean; status: "ready" | "starting" | "needs-auth" | "failed" | "disabled";
  detail?: string; tools: ToolInfo[] }
export interface MarketplaceEntry { marketplace: string; name: string; description: string; publisher?: string;
  source: string; version?: string; kind: Kind; installed: boolean }
export interface ExtensionsApi {
  allowed(): boolean;                         // admin features.extensions and not LOCKDOWN
  list(): Promise<Installed[]>;
  marketplaces(): Promise<{ name: string; source: string }[]>;
  addMarketplace(source: string): Promise<{ ok: true } | { ok: false; why: string }>;
  removeMarketplace(name: string): Promise<void>;
  browse(marketplace: string): Promise<MarketplaceEntry[]>;
  install(marketplace: string, name: string): Promise<{ ok: true; id: string } | { ok: false; why: string }>; // after Home's consent card
  uninstall(id: string): Promise<void>;
  setEnabled(id: string, on: boolean): Promise<void>;
  connectors(): Promise<MarketplaceEntry[]>;  // GitHub-hosted catalog
  connect(name: string): Promise<{ state: "connected" } | { state: "consent"; url: string } | { state: "pending" } | { ok: false; why: string }>;
  disconnect(id: string): Promise<void>;
  reagree(id: string): Promise<void>;         // after a tool changed (rug pull)
  onChange(fn: () => void): () => void;
}
