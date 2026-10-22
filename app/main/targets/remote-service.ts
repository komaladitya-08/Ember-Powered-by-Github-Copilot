/**
 * A computer reached over SSH, as a target (§2.5, §2.6, §5.5): one live link turned into SC's parts (remote perception,
 * sidecar, apps, runner, gate 1) and a CommandService over the remote's runner. Commands there take the stricter of
 * both machines' `commands.ssh` (§3.8.1), the user's switch for that host and its commands card; an SSH login as root
 * asks before every command (D4.6). What the remote says about itself (its desktop, its policy) only ever narrows what
 * Ember does: a remote can turn its own commands or desktop off, never on. Plain Node.
 */

import { targetIdOf, type TargetId } from "../../shared/targets";
import { adminSummary, combineAdmin, commandMode, type AdminSummary, type LoadedAdminPolicy } from "../admin";
import type { CommandMode, CommandService, CommandWindowPort } from "../commands/types";
import type { Logger } from "../logger";
import type { DesktopState } from "../remote/protocol";
import type { RemoteTargetParts } from "../remote/target";
import type { HostRecord, RemoteLink } from "../remote/types";
import type { SettingsStore } from "../settings";
import type { DesktopAccess, TargetBinding } from "./types";
import { commandCapability, commandsSetting, recordCommandsConsent } from "./local-service";

/** Commands modes from the most to the least strict (§3.8.1). */
const MODE_ORDER: readonly CommandMode[] = ["off", "ask", "on"];

/** The stricter of two commands modes (off < ask < on); anything unknown counts as off. */
export function stricterMode(a: CommandMode, b: CommandMode): CommandMode {
  const i = Math.min(MODE_ORDER.indexOf(a), MODE_ORDER.indexOf(b));
  return i < 0 ? "off" : MODE_ORDER[i];
}

/** Only ever lower: a remote's later report can take desktop access away, never add it (§7.2). */
const ACCESS_ORDER: readonly DesktopAccess[] = ["none", "text", "screen"];
export function lowerAccess(was: DesktopAccess, now: DesktopAccess): DesktopAccess {
  const i = Math.min(ACCESS_ORDER.indexOf(was), ACCESS_ORDER.indexOf(now));
  return i < 0 ? "none" : ACCESS_ORDER[i];
}

/** One connected SSH target: its parts, its commands, and what it reports. */
export interface RemoteTarget {
  readonly id: TargetId;
  readonly hostId: string;
  readonly link: RemoteLink;
  readonly parts: RemoteTargetParts;
  readonly service: CommandService;
  /** The remote's desktop now (the welcome's, lowered by every desktop.changed since). */
  desktop(): DesktopAccess;
  /** Why the desktop is "none" or "text", in the agent's words (untrusted; for the bubble only, quoted by the UI). */
  desktopWhy(): string | undefined;
  /** Both machines' policies combined now. */
  combined(): AdminSummary;
  dispose(): void;
}

/** Builds the target for a link that just came up. Throws when the parts can't be made (the caller disconnects). */
export function createRemoteTarget(o: {
  host: HostRecord;
  link: RemoteLink;
  log: Logger;
  settings: SettingsStore;
  admin: () => LoadedAdminPolicy;
  window: CommandWindowPort;
  makeParts: (link: RemoteLink, o: { log: Logger; settings: SettingsStore; localAdmin: () => LoadedAdminPolicy; hostLabel: string; login: string }) => RemoteTargetParts;
  /** The desktop dropped because the remote's screen locked (the runtime says so in the bubble). */
  onLocked?: () => void;
  /** Someone at the remote pressed Stop on Ember's notice. */
  onConsoleStop?: () => void;
}): RemoteTarget {
  const id = targetIdOf("ssh", o.host.id);
  const label = o.host.id;
  const welcome = o.link.welcome;
  let remoteAdmin: AdminSummary = welcome.remoteAdmin;
  let desktop: DesktopState = welcome.desktop;
  const parts = o.makeParts(o.link, { log: o.log, settings: o.settings, localAdmin: o.admin, hostLabel: label, login: o.host.resolved.user });
  const offs: (() => void)[] = [];
  const listen = (f: () => () => void) => { try { offs.push(f()); } catch (err) { o.log.warn("targets.remote_listen_failed", { err }); } };
  listen(() => o.link.on("policy.changed", s => {
    // The remote's own policy, newly read there: combined with the PC's, it can only make things stricter.
    remoteAdmin = s;
  }));
  listen(() => o.link.on("desktop.changed", d => {
    const was = desktop;
    desktop = { ...d, access: lowerAccess(was.access, d.access) };
    if (was.access !== "none" && desktop.access === "none" && d.session?.locked) o.onLocked?.();
  }));
  listen(() => o.link.on("console.stop", () => o.onConsoleStop?.()));
  const combined = () => combineAdmin(adminSummary(o.admin()), remoteAdmin);
  // The PC's own mode for SSH (R5 with this PC's policy) and the remote's, the stricter wins (§3.8.1).
  const mode = (): CommandMode => stricterMode(commandMode(o.admin(), "ssh"), remoteAdmin.commands?.ssh ?? "off");
  const privileged = () => welcome.uid === 0 || welcome.facts.privileged === true;
  const setting = () => commandsSetting(o.settings, id);
  const binding = (): TargetBinding => parts.binding();
  const service: CommandService = {
    get binding() { return binding(); },
    capability: () => commandCapability({
      kind: "ssh", label, mode: mode(), setting: setting(), privileged: privileged(), tool: false,
      unavailable: o.link.state === "lost" || o.link.state === "closed" ? `The connection to ${label} dropped.` : null,
    }),
    shells: () => (welcome.facts.shells.length ? [...welcome.facts.shells] : ["sh"]),
    runner: parts.runner,
    window: o.window,
    consented: () => recordCommandsConsent(o.settings, id),
    userAskEvery: () => setting()?.askEvery === true,
    mode,
  };
  return {
    id, hostId: o.host.id, link: o.link, parts, service,
    desktop: () => desktop.access,
    desktopWhy: () => desktop.why,
    combined,
    dispose: () => {
      for (const off of offs.splice(0)) { try { off(); } catch { /* already gone with the link */ } }
      try { parts.dispose(); } catch (err) { o.log.warn("targets.remote_parts_dispose_failed", { err }); }
    },
  };
}
