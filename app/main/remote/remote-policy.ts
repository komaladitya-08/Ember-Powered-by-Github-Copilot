/**
 * Gate 1 for one SSH remote (§2.6's SSH column) and what the PC decides about that remote's desktop (§2.5). The PC's
 * worker decides every remote step with a PolicyEngine of its own for that connection: the remote OS's vocabulary
 * (keys, security windows, terminals judged with the remote's app catalogue), both machines' administrator policies
 * combined (the stricter wins, `combineAdmin`), a never-look list that joins the user's, both administrators' and the
 * remote OS's defaults, every action confirmed (no view of the remote screen: L4), and no "Always" grants. The remote's
 * gate 2 checks again under its own policy (§5.3.7); neither gate can loosen the other. Plain Node.
 */

import { NEVER_LOOK_DEFAULTS } from "../../shared/never-look";
import { KEYS, type OS } from "../../shared/shortcuts";
import { adminSummary, combineAdmin, type AdminSummary, type LoadedAdminPolicy } from "../admin";
import { isSecurityWindow, PolicyEngine, type PolicyInputs } from "../policy/policy";
import type { SettingsStore } from "../settings";
import type { DesktopAccess } from "../targets/types";
import type { DesktopState, Welcome } from "./protocol";

/** Both machines' policies for what Ember does on the remote: each value the stricter of the two. */
export function combinedAdmin(local: LoadedAdminPolicy, remote: AdminSummary): AdminSummary {
  return combineAdmin(adminSummary(local), remote);
}

/** What the never-look list of a remote is made of. */
export interface NeverLookSources {
  os: OS;
  settings: Pick<SettingsStore, "get">;
  localAdmin: () => LoadedAdminPolicy;
  remoteAdmin: () => AdminSummary;
}

/**
 * The never-look list on a remote (§2.6): the user's list (with the PC administrator's, as the settings in force hold
 * it), the PC administrator's, the remote administrator's and the remote OS's defaults, each entry once (case aside).
 */
export function remoteNeverLook(o: NeverLookSources): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (list: readonly string[]) => {
    for (const item of list) {
      const key = item.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item.trim());
    }
  };
  add(o.settings.get().privacy.neverLook);
  add(o.localAdmin().policy.neverLook);
  add(o.remoteAdmin().neverLook);
  add(NEVER_LOOK_DEFAULTS[o.os]);
  return out;
}

/** What createRemotePolicy needs. */
export interface RemotePolicyOptions extends NeverLookSources {
  /** Is the app whose windows report this name a terminal or an app with a shell built in (the remote's catalogue)? */
  isTerminalApp: (name: string) => boolean;
  /** The clock the rate limit counts with (tests). */
  now?: () => number;
}

/**
 * Gate 1 for one remote (§2.6): a new PolicyEngine per connection. Acting at all needs both administrators' yes (and a
 * readable policy on each side); the rate limit is the lower of both, read again at every step (a remote's policy can
 * change while connected: `policy.changed`); Ember's own process is never on a remote (`ownPid` -1).
 */
export function createRemotePolicy(o: RemotePolicyOptions): PolicyEngine {
  const combined = () => combinedAdmin(o.localAdmin(), o.remoteAdmin());
  const inputs: PolicyInputs = {
    neverLook: () => remoteNeverLook(o),
    // No "Always" on a remote (L4): every step is asked, so no grant is ever read.
    grants: () => ({}),
    allowGrants: () => false,
    confirmEveryAction: () => true,
    actionsAllowed: () => {
      const c = combined();
      return c.error === undefined && c.features.actions !== false && c.features.ssh !== false;
    },
    isTerminalApp: o.isTerminalApp,
    ownPid: -1,
    keys: KEYS[o.os],
    os: o.os,
    isSecurityWindow: w => isSecurityWindow(w, o.os),
    // PolicyEngine reads its inputs at every decision, so the lower limit of the two policies in force then applies.
    get rateLimit() { return combined().maxActionsPerMinute; },
    ...(o.now ? { now: o.now } : {}),
  };
  return new PolicyEngine(inputs);
}

// ---------------------------------------------------------------------------------------------------------------------
// The remote's desktop as the PC lets Ember use it (§2.5's SSH row).

/** How much of the remote's desktop Ember uses now, in Ember's own words (never the remote's: they reach the model). */
export interface RemoteDesktop {
  desktop: DesktopAccess;
  /** Why it is "none" or "text" (TargetBinding.desktopWhy), one sentence. */
  why?: string;
  /** For "text": why a worker's picture isn't taken, as "(No screenshot: <noShot>.)" says it. */
  noShot?: string;
}

const ORDER: readonly DesktopAccess[] = ["none", "text", "screen"];
/** Is `a` less than `b` ("none" < "text" < "screen")? */
export const lowerAccess = (a: DesktopAccess, b: DesktopAccess) => ORDER.indexOf(a) < ORDER.indexOf(b);

/**
 * The remote's desktop as Ember may use it: the agent's report (`welcome.desktop`, then `desktop.changed` and
 * `desktop.state`), lowered by what the PC knows itself: v1 uses only a Linux remote's desktop (L6, L23), never as
 * root (L17), never where either administrator said no (`ssh.desktop`) or a policy couldn't be read, never in a
 * session that isn't active or whose notice couldn't be shown (§2.5); screenshots only from an X11 session while both
 * administrators allow them, else text. Every word here is Ember's own; the remote's `why` is never used.
 */
export function remoteDesktop(o: {
  welcome: Pick<Welcome, "os" | "isWsl" | "uid">;
  state: DesktopState;
  combined: AdminSummary;
  label: string;
  login: string;
}): RemoteDesktop {
  const { welcome: w, state, combined: c, label } = o;
  const none = (why: string): RemoteDesktop => ({ desktop: "none", why });
  // The words are §5.3.4's and §5.3.5's where the design gives them (§8.7 "desktop none").
  if (w.os === "darwin") return none("Ember can't use a Mac's screen over SSH yet; it can run commands there.");
  if (w.os !== "linux") return none(`Ember can't use ${label}'s desktop yet: it runs commands only.`);
  if (w.isWsl) return none(`${label} is WSL on another PC: its Linux apps show on that PC's screen, so Ember will run commands only.`);
  if (w.uid === 0) return none("Ember doesn't use a desktop as root.");
  if (c.error !== undefined) return none(`An administrator's policy couldn't be read, so Ember doesn't use ${label}'s desktop.`);
  if (c.features.ssh === false || c.ssh.desktop === false) return none(`An administrator turned off Ember's use of ${label}'s desktop.`);
  if (state.session?.locked) return none(`${label}'s screen is locked.`);
  // Only the login's own active session, and only while its notice (with its Stop) can show there (§2.5, §5.3.4,
  // §5.3.9): whatever access the agent reports, the PC lowers it from these fields as well.
  if (state.access === "none" || state.session?.active === false || state.notice === "failed") return none(`${label} has no desktop session Ember can use for ${o.login}.`);
  // A Wayland session gives no screenshots (L5), whatever access the agent reports.
  const wayland = state.session?.type === "wayland";
  if (state.access === "screen" && !wayland && c.features.screenImages !== false) return { desktop: "screen" };
  if (c.features.screenImages === false) {
    return { desktop: "text", why: `An administrator turned off screenshots, so Ember reads ${label}'s apps as text.`, noShot: "an administrator turned off screenshots" };
  }
  if (wayland) {
    return { desktop: "text", why: `${label}'s desktop is a Wayland session: Ember reads its apps as text, without screenshots.`, noShot: `${label}'s Wayland session gives Ember no screenshots` };
  }
  return { desktop: "text", why: `Ember reads ${label}'s apps as text, without screenshots.`, noShot: `${label} gives Ember no screenshots` };
}
