/**
 * The settings window's Extensions section, as pure functions: what each installed item, marketplace, catalog entry and
 * connector says and offers, the consent card shown before anything is added, and every message and error sentence.
 * The page (extensions.ts) draws exactly this; ui-copy.test.ts and home-extensions.test.ts pin the words. Main uses
 * the error sentences too (extensions-ipc.ts), so no raw runtime text ever reaches the page. Kept apart from copy.ts,
 * as computers-copy.ts is. Sentence case, British spelling, curly quotes around names. Renderer-safe.
 */

import type { Installed, Kind, Marketplace, MarketplaceEntry, ToolInfo } from "../../shared/extensions";

export const EXTENSIONS_HEADING = "Extensions";
export const EXTENSIONS_INTRO = "Extensions give Ember more tools through plugins from marketplaces you add. Only you can add them, here.";

/** Why the section shows nothing to use. */
export const EXTENSIONS_UNAVAILABLE = "Extensions aren't available in this version of Ember yet.";
export const EXTENSIONS_MANAGED = "Your organisation has turned off extensions.";
export const EXTENSIONS_LOCKDOWN = "Extensions are off while Ember is locked down by your organisation's policy.";
export const EXTENSIONS_LOADING = "Loading…";

/** The line that says why nothing can be added: unavailable, locked down or turned off; null when extensions may be used. */
export function extensionsBlocked(s: { available: boolean; allowed: boolean; lockdown: boolean }): string | null {
  if (!s.available) return EXTENSIONS_UNAVAILABLE;
  if (s.lockdown) return EXTENSIONS_LOCKDOWN;
  return s.allowed ? null : EXTENSIONS_MANAGED;
}

// ───── Errors: one plain sentence, never the runtime's own text ─────

export const EXTENSIONS_FAILED = "That didn't work. Try again in a moment.";
export const EXTENSIONS_BAD_REQUEST = "Ember couldn't do that: something in the request wasn't right.";
export const EXTENSIONS_OFFLINE = "Ember couldn't reach that address. Check the network, then try again.";
export const EXTENSIONS_NOT_FOUND = "Ember couldn't find anything there. Check the address, then try again.";
export const EXTENSIONS_TIMED_OUT = "That took too long. Try again in a moment.";
export const EXTENSIONS_REFUSED_URL = "GitHub's page didn't come back as a GitHub address, so Ember didn't open it.";

/**
 * Said when an item was turned off or removed but Ember's list of extensions couldn't be written (a full disk, a data
 * folder that can't be written): it is off either way, and Home never says “Removed” for one the list still holds
 * (integrations-r9-4). `kept`: a mark beside the list did get written, so it is off at the next start too.
 */
export function extensionUnsaved(what: "removed" | "off", kept: boolean): string {
  if (!kept) return "Ember turned it off for now but couldn't save that, so it may be back when Ember starts again. Check that the disk isn't full, then try again.";
  return what === "removed"
    ? "Ember turned it off but couldn't save the removal, so it is still listed. Check that the disk isn't full, then remove it again."
    : "Ember turned it off, but couldn't save its list of extensions. Check that the disk isn't full.";
}
/** Said when turning an item on couldn't be saved: it is left off (integrations-r9-4). */
export const EXTENSION_ON_UNSAVED = "Ember couldn't save that, so it left it off. Check that the disk isn't full, then try again.";

/** Words that mark text as an error's own (a code, a stack, a type), not a sentence for a person. */
const RAW = /\b(?:[A-Z][a-z]+Error|Exception|ECONN\w*|ENOTFOUND|ENOENT|EACCES|EAI_AGAIN|ETIMEDOUT|stack|undefined|null|at \S+ \(|HTTP\/\d|status code)\b|[{}<>[\]\\`]|\n/;

/** One plain sentence for a thrown error or a refusal: what it says when that is a sentence, else what it means. */
export function extensionsError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const m = text.replace(/^Error invoking remote method '[^']+': /, "");
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|getaddrinfo|socket hang up|offline/i.test(m)) return EXTENSIONS_OFFLINE;
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(m)) return EXTENSIONS_TIMED_OUT;
  if (/\b404\b|not found/i.test(m)) return EXTENSIONS_NOT_FOUND;
  const s = m.replace(/\s+/g, " ").trim();
  if (s.length >= 8 && s.length <= 200 && /^[A-Z“"]/.test(s) && /[.!?]$/.test(s) && !RAW.test(s)) return s;
  return EXTENSIONS_FAILED;
}

// ───── Words for kinds, states and tools ─────

const KIND: Readonly<Record<Kind, string>> = { plugin: "Plugin", connector: "Connector", extension: "Extension" };
/** "Plugin", "Connector", "Extension". */
export const kindLabel = (k: Kind): string => KIND[k] ?? "Extension";

/** A tool's badge: its words and its tint (a class in styles.css). */
export interface ToolBadge { label: string; tone: "ok" | "ask" | "no" }
export function toolBadge(t: ToolInfo): ToolBadge {
  if (t.nameConflict) return { label: "Name conflict", tone: "no" };
  if (t.changed) return { label: "Changed", tone: "no" };
  return t.readOnly ? { label: "Read-only", tone: "ok" } : { label: "Can change things", tone: "ask" };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "2 read-only tools, 1 that can change things", "No tools". */
export function toolCounts(tools: readonly ToolInfo[]): string {
  const read = tools.filter(t => t.readOnly).length;
  const change = tools.length - read;
  if (!tools.length) return "No tools";
  const parts = [...(read ? [plural(read, "read-only tool", "read-only tools")] : []), ...(change ? [`${plural(change, "tool", "tools")} that can change things`] : [])];
  return parts.join(", ");
}

/**
 * An installed item's status, as words beside its symbol (never colour alone). `on`: the section's Use extensions
 * switch; while it is off nothing added runs (integrations-11).
 */
export function installedStatus(i: Installed, on = true, connected = true): { text: string; tone: "ok" | "wait" | "fail" | "off" } {
  if (i.needsReview || i.tools.some(t => t.changed)) return { text: "Changed since you agreed", tone: "fail" };
  if (!i.consented) return { text: "Waiting for you to agree", tone: "wait" };
  if (!i.enabled || i.status === "disabled") return { text: "Off", tone: "off" };
  if (!on) return { text: "Off: extensions are off", tone: "off" };
  // Nothing runs before Ember is connected: "Ready" then said it did (integrations-v2).
  if (!connected && i.status === "ready") return { text: "Ready once Ember connects", tone: "wait" };
  switch (i.status) {
    case "ready": return { text: i.kind === "connector" ? "Connected" : "Ready", tone: "ok" };
    case "starting": return { text: "Starting…", tone: "wait" };
    case "needs-auth": return { text: "Needs you to sign in again", tone: "fail" };
    default: return { text: "Didn't start", tone: "fail" };
  }
}

/** One button on an installed item. */
export interface ItemAction { act: "reagree" | "uninstall" | "disconnect" | "connect"; label: string; ariaLabel: string; confirm?: string; danger?: boolean }

/** An installed item as its row shows it. */
export interface InstalledRow {
  id: string;
  name: string;
  /** "Plugin · by Octo Labs · octo/tools · 1.2.0" */
  meta: string;
  status: { text: string; tone: "ok" | "wait" | "fail" | "off" };
  /** What to do next, under the status (a changed tool, a failed start, a sign-in). */
  note: string | null;
  toggle: { checked: boolean; disabled: boolean; ariaLabel: string };
  tools: { name: string; description: string; badge: ToolBadge }[];
  toolSummary: string;
  actions: ItemAction[];
}

/** What a failed item's detail may say: a plain sentence only (extensionsError's rule), else nothing. */
const detailLine = (d: string | undefined): string | null => {
  if (!d) return null;
  const s = extensionsError(d);
  return s === EXTENSIONS_FAILED ? null : s;
};

export function installedRow(i: Installed, on = true, connected = true): InstalledRow {
  const status = installedStatus(i, on, connected);
  const changed = i.needsReview || i.tools.some(t => t.changed);
  const meta = [kindLabel(i.kind), ...(i.publisher ? [`by ${i.publisher}`] : []), i.source, ...(i.version ? [i.version] : [])].join(" · ");
  const note = changed ? "Its tools changed since you agreed, so Ember stopped using the ones that changed. Check what they do now, then agree again."
    : !i.consented ? "Ember uses none of its tools until you agree."
    : i.status === "needs-auth" ? i.kind === "connector" ? `Connect “${i.name}” again to sign in on GitHub's page.`
      : "Check this plugin's authentication setup with its provider, then remove it and add it again."
    : i.status === "failed" && i.enabled ? detailLine(i.detail) ?? "Turn it off and on again, or remove it and add it again."
    : i.enabled && i.tools.some(t => t.nameConflict) ? "Some tool names clash in Copilot. Ember leaves those tools off."
    : null;
  const actions: ItemAction[] = [];
  if (changed || !i.consented) actions.push({ act: "reagree", label: i.consented ? "Review tools" : "Review and agree", ariaLabel: `Review tools: ${i.name}` });
  if (i.kind === "connector" && i.status === "needs-auth") actions.push({ act: "connect", label: "Connect again", ariaLabel: `Connect again: ${i.name}` });
  actions.push(i.kind === "connector"
    ? { act: "disconnect", label: "Disconnect", ariaLabel: `Disconnect ${i.name}`, confirm: disconnectQuestion(i.name), danger: true }
    : { act: "uninstall", label: "Remove", ariaLabel: `Remove ${i.name}`, confirm: removeQuestion(i.name), danger: true });
  return {
    id: i.id, name: i.name, meta, status, note,
    // Not on until agreed: a switch shown on beside "Waiting for you to agree" said it ran (integrations-11).
    toggle: { checked: i.enabled && i.consented, disabled: !i.consented, ariaLabel: `Use ${i.name}` },
    tools: i.tools.map(t => ({ name: t.name, description: t.description, badge: toolBadge(t) })),
    toolSummary: toolCounts(i.tools),
    actions,
  };
}

export const removeQuestion = (name: string) => `Remove “${name}”? Ember stops using its tools at once.`;
export const disconnectQuestion = (name: string) => `Disconnect “${name}”? Ember stops using its tools at once.`;

export const INSTALLED_HEADING = "Added";
export const INSTALLED_EMPTY = "Nothing added yet. Browse a marketplace below.";

/** The section's own switch, shown once extensions are agreed to: off stops every server and uses no tool. */
export const EXTENSIONS_ON_LABEL = "Use extensions";
export function extensionsOnHint(on: boolean): string {
  return on ? "Ember may use the tools you agreed to. Turn this off to stop them all: what you added stays here."
    : "Off: Ember uses no extension's tools and runs nothing you added. What you added stays here.";
}

// ───── Marketplaces ─────

export const MARKETPLACES_HEADING = "Marketplaces";
export const MARKETPLACES_EMPTY = "No marketplaces yet. Add one by its GitHub repository or its address.";
/** While Ember isn't connected the runtime can't list marketplaces (Copilot's own included), nor add one. */
export const MARKETPLACES_NOT_CONNECTED = "Marketplaces appear once Ember is connected to Copilot or your model provider.";
/** Short enough to show whole in a narrow window (the field is labelled for screen readers). */
export const MARKETPLACE_PLACEHOLDER = "owner/repo or https://…";
export const MARKETPLACE_FIELD_LABEL = "Marketplace's GitHub repository or address";
export const MARKETPLACE_ADD = "Add";
export const MARKETPLACE_INVALID = "Type a GitHub repository as owner/repo, or an address that starts with https://.";
export const MARKETPLACES_HINT = "Browse fetches a marketplace's list: from GitHub for one built into Copilot, else from the address you added. Nothing from it runs until you add an item and agree.";
/** Why Remove was refused: Copilot keeps its own, and the organisation's managed settings keep theirs (integrations-4). */
export const MARKETPLACE_BUILT_IN_KEPT = "Copilot's built-in marketplace can't be removed. Nothing from it runs unless you add an item and agree.";
export const MARKETPLACE_MANAGED_KEPT = "Your organisation set this marketplace, so it can't be removed here.";
/** A marketplace's row: where it is from, and whether Remove is offered (never for Copilot's own or the organisation's). */
export function marketplaceRow(m: Marketplace): { name: string; meta: string; removable: boolean } {
  const whose = m.builtIn ? "Built into Copilot" : m.managed ? "Set by your organisation" : null;
  return { name: m.name, meta: whose ? `${whose} · ${m.source}` : m.source, removable: !m.builtIn && !m.managed };
}
export const removedMarketplace = (name: string) => `Removed the marketplace “${name}”.`;
export const addingMarketplace = (source: string) => `Adding ${source}…`;
export const addedMarketplace = (source: string) => `Added ${source}.`;
export const removeMarketplaceQuestion = (name: string) => `Remove the marketplace “${name}”? What you added from it stays until you remove it.`;
export const browseLabel = (name: string) => `Browse ${name}`;
export const removeMarketplaceLabel = (name: string) => `Remove the marketplace ${name}`;

/** The browsing panel's heading, and what it says while loading or when empty. */
export const browsingHeading = (name: string) => `In “${name}”`;
export const browsingLoading = (name: string) => `Loading “${name}”…`;
export const BROWSE_EMPTY = "This marketplace lists nothing yet.";
/**
 * Why a marketplace's list couldn't be shown (integrations-r2), never as an empty list: the runtime couldn't reach it
 * (`offline`) or fetch it (`fetch`), or its catalogue couldn't be found or read on this computer (`read`).
 */
export function browseFailed(name: string, why: "offline" | "fetch" | "read"): string {
  if (why === "offline") return `Ember couldn't reach “${name}”. Check the network, then press Browse again.`;
  return why === "fetch" ? `Ember couldn't fetch “${name}”'s list. Press Browse again in a moment.` : `Ember couldn't read “${name}”'s list. Press Browse again in a moment.`;
}
/**
 * Why a marketplace couldn't be added (integrations-r2-3), with the address the person typed: the runtime couldn't
 * reach it (`offline`), or reached it but got no marketplace from it (`fetch`: a private repository, not a marketplace).
 */
export function addMarketplaceFailed(address: string, why: "offline" | "fetch"): string {
  return why === "offline" ? `Ember couldn't reach “${address}”. Check the address and the network, then press Add again.`
    : `Ember couldn't fetch a marketplace from “${address}”. Check that it's a marketplace repository you can open, then press Add again.`;
}
export const BROWSE_AGAIN = "Browse again";
export const BROWSE_DONE = "Done";

/** A catalog entry as its card shows it. */
export interface EntryCard {
  key: string;
  name: string;
  kind: string;
  description: string;
  /** "By Octo Labs · octo/tools · 1.2.0" */
  meta: string;
  installed: boolean;
  /** The card's button: Add (a plugin or extension) or Connect; none once added. */
  action: { label: string; ariaLabel: string } | null;
}

/** Descriptions come from the marketplace: kept to a few lines, whole words. */
export const DESCRIPTION_MAX = 240;
export function shortDescription(d: string): string {
  const s = d.replace(/\s+/g, " ").trim();
  if (s.length <= DESCRIPTION_MAX) return s;
  const cut = s.slice(0, DESCRIPTION_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), DESCRIPTION_MAX - 20)).replace(/[\s,;:.]+$/, "")}…`;
}

export function entryCard(e: MarketplaceEntry): EntryCard {
  const meta = [...(e.publisher ? [`By ${e.publisher}`] : []), e.source, ...(e.version ? [e.version] : [])].join(" · ");
  const connector = e.kind === "connector";
  return {
    key: `${e.marketplace}\u0000${e.name}`,
    name: e.name, kind: kindLabel(e.kind), description: shortDescription(e.description), meta, installed: e.installed,
    action: e.installed ? null : connector ? { label: "Connect", ariaLabel: `Connect ${e.name}` } : { label: "Add", ariaLabel: `Add ${e.name}` },
  };
}
export const INSTALLED_TAG = "Added";

// ───── Connectors ─────

export const CONNECTORS_HEADING = "Connectors";
export const CONNECTORS_EMPTY = "GitHub-hosted connectors aren't available in Ember yet.";
export const CONNECTORS_HINT = "To use an MCP server, add its plugin's marketplace above. Ember loads the plugin's MCP tools and asks before tools that can change things.";

/** A connector's row: its state and its one button. */
export interface ConnectorRow {
  name: string;
  description: string;
  state: "off" | "pending" | "connected" | "needs-auth" | "failed";
  status: string;
  /** The installed item's id, once there is one (Disconnect needs it). */
  id: string | null;
  action: ItemAction | null;
}

/** A catalog connector with what is installed and which ones wait for the user in the browser. */
export function connectorRow(e: MarketplaceEntry, installed: readonly Installed[], pending: ReadonlySet<string>): ConnectorRow {
  const i = installed.find(x => x.kind === "connector" && x.name === e.name);
  const base = { name: e.name, description: shortDescription(e.description), id: i?.id ?? null };
  const connect = (label = "Connect"): ItemAction => ({ act: "connect", label, ariaLabel: `${label} ${e.name}` });
  if (i && i.status === "ready" && i.enabled) {
    return { ...base, state: "connected", status: "Connected", action: { act: "disconnect", label: "Disconnect", ariaLabel: `Disconnect ${e.name}`, confirm: disconnectQuestion(e.name), danger: true } };
  }
  if (pending.has(e.name)) return { ...base, state: "pending", status: "Waiting for you to finish in your browser", action: connect("Check again") };
  if (i && i.status === "needs-auth") return { ...base, state: "needs-auth", status: "Needs you to sign in again", action: connect("Connect again") };
  if (i && i.status === "failed") return { ...base, state: "failed", status: "Didn't connect", action: connect("Try again") };
  if (i) return { ...base, state: "connected", status: installedStatus(i).text, action: null };
  return { ...base, state: "off", status: "Not connected", action: connect() };
}

export const connectOpened = (name: string) => `Finish connecting “${name}” on GitHub's page, in your browser. Then come back here.`;
export const connectPending = (name: string) => `Waiting for GitHub to finish connecting “${name}”…`;
export const connected = (name: string) => `Connected “${name}”.`;
export const added = (name: string) => `Added “${name}”. Turn it off here any time.`;
export const removed = (name: string) => `Removed “${name}”.`;
export const disconnected = (name: string) => `Disconnected “${name}”.`;
export const agreedAgain = (name: string) => `Ember uses “${name}” again.`;
/** The first agreement to an item's tools (it was never used before), not "again" (integrations-8). */
export const agreedFirst = (name: string) => `Ember can use “${name}” now.`;
/** What agreeing to an item's tools says: the first time, or again after its tools changed. */
export const agreedTo = (i: Pick<Installed, "name" | "consented">) => (i.consented ? agreedAgain(i.name) : agreedFirst(i.name));

// ───── The consent card, before anything is added or connected ─────

/** Bump FEATURE_CONSENT_VERSION.extensions with any change to these words (CLAUDE.md "Consent"). */
export interface ConsentCard { title: string; lines: string[]; tools?: ToolInfo[]; yes: string; no: string }

/**
 * The card shown before each add or connect: what Ember will and won't do with the item, and where it reaches. The
 * marketplace's own description isn't in it (it is the publisher's text, not Ember's promise).
 */
export function consentCard(e: Pick<MarketplaceEntry, "name" | "kind" | "source" | "marketplace" | "reaches"> & { builtIn?: boolean }): ConsentCard {
  const connector = e.kind === "connector";
  // A marketplace built into Copilot wasn't added by the user, so the card never says it was (integrations-4).
  const reach = connector
    ? `It connects to “${e.name}” through GitHub's Copilot service. You sign in to it on GitHub's page, in your browser, and what its tools send and receive goes through GitHub.`
    : e.builtIn ? `It comes from ${e.source}, listed in “${e.marketplace}”, a marketplace built into Copilot. Its tools may run on this computer and reach the internet.`
    : `It comes from ${e.source}, listed in the marketplace “${e.marketplace}” you added. Its tools may run on this computer and reach the internet.`;
  return {
    title: connector ? `Before you connect “${e.name}”` : `Before you add “${e.name}”`,
    lines: [
      "Only you add, turn off and remove extensions, here in settings. Ember never adds one by itself.",
      connector ? "Once you agree, Ember may use its read-only tools when they help with what you ask. It asks you every time before a tool that changes or sends anything." : "Adding it runs its servers to find their tools. Ember shows you that list next, and uses none until you review it and agree.",
      "What its tools return is treated as information, never as instructions, and every use is in What Ember did.",
      "If its tools change later, Ember stops using them until you agree again.",
      reach,
      ...(e.reaches ?? []),
    ],
    yes: connector ? "Agree and connect" : "Agree and add",
    no: "Not now",
  };
}

/** The re-agree card for an item whose tools changed: the same promises, and the tools as they are now. */
export function reagreeCard(i: Installed): ConsentCard {
  return {
    title: i.consented ? `Agree again to “${i.name}”` : `Review the tools in “${i.name}”`,
    tools: i.reviewTools ?? i.tools,
    lines: [
      `Tools to review: ${toolCounts(i.reviewTools ?? i.tools)}.`,
      ...(i.reaches ?? []),
      "Only you add, turn off and remove extensions, here in settings. Ember never adds one by itself.",
      "Once you agree, Ember may use these read-only tools when they help with what you ask. It asks you every time before a tool that changes or sends anything.",
      "What its tools return is treated as information, never as instructions, and every use is in What Ember did.",
      "If its tools change later, Ember stops using them until you agree again.",
    ],
    yes: i.consented ? "Agree again" : "Agree and use tools",
    no: "Not now",
  };
}
