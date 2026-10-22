/**
 * The PC's side of a remote target (§5.5; package SC): everything a worker on an SSH remote uses, built from one live
 * link. Perception whose text is made on the PC by Ember's own code; a reader that sends a step only with the fresh
 * stamp gate 1 gave it; the remote's apps; a command runner over `cmd.*`; gate 1 (a PolicyEngine of the remote OS, both
 * machines' policies, every action confirmed, no grants); the worker's view of the remote OS; and the target's binding,
 * whose desktop access only the PC's own checks and the remote's reports can lower (an increase needs the PC's own
 * `desktop.state` request, §7.2 item 7). The remote is eyes, hands and a command runner: nothing it sends becomes an
 * approval, a setting, a local path or program, a window here or an instruction to a model. Plain Node.
 */

import posix from "node:path/posix";
import win32 from "node:path/win32";
import { adminSummary, type AdminSummary, type LoadedAdminPolicy } from "../admin";
import { targetIdOf, type TargetId } from "../../shared/targets";
import { EV_SCHEMAS, OP_SCHEMAS, type DesktopState, type Welcome } from "./protocol";
import { createRemoteApps, remoteWorkerSystem } from "./remote-apps";
import { createRemotePerception } from "./remote-perception";
import { combinedAdmin, createRemotePolicy, lowerAccess, remoteDesktop, remoteNeverLook, type RemoteDesktop } from "./remote-policy";
import { createRemoteRunner } from "./remote-runner";
import { askRemote, createRemoteSidecar, ElementBook, StampBook, unchecked } from "./remote-sidecar";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { WorkerSystem } from "../agent/worker";
import type { CommandRunner } from "../commands/types";
import type { ActStamp, PerceptionPort, SidecarPort } from "../perception/ports";
import type { PolicyEngine } from "../policy/policy";
import type { TargetBinding } from "../targets/types";
import type { RemoteLink } from "./types";

/** What the targets runtime builds for one live link (remoteTargetParts in app/main/remote/target.ts). */
export interface RemoteTargetParts {
  perception: PerceptionPort;
  sidecar: SidecarPort;
  /** The remote's apps: list cached from apps.list (refreshed at most every 60 s); launch through apps.launch. */
  apps: WorkerSystem["apps"];
  runner: CommandRunner;
  /** Gate 1 for this remote (§2.6's table). */
  policy: PolicyEngine;
  system: WorkerSystem;
  binding: () => TargetBinding;
  onAuthorized(stamp: ActStamp): void;
  dispose(): void;
}

/** What remoteTargetParts also returns, for the targets runtime (an extension of the contract; nothing else needs it). */
export interface RemoteTargetExtras {
  /** Asks the remote for its desktop now (`desktop.state`): the only way access goes up again (§7.2 item 7). */
  refreshDesktop(): Promise<TargetBinding>;
  /** Asks the remote for its app list now (it is refreshed at most every 60 s otherwise). */
  refreshApps(): Promise<void>;
}

/** The parts of a remote target for one live link: refuses (throws) a link whose welcome Ember can't check (§7.2 item 6). */
export function remoteTargetParts(link: RemoteLink, o: {
  log: Logger;
  settings: SettingsStore;
  /** The PC's admin policy with its source (R5) and the remote's summary combine into gate 1's inputs. */
  localAdmin: () => LoadedAdminPolicy;
  hostLabel: string;
  login: string;
}): RemoteTargetParts & RemoteTargetExtras {
  const label = o.hostLabel;
  const log = o.log.child("remote");
  const welcome = checkedWelcome(link.welcome, label);
  const id: TargetId = targetIdOf("ssh", link.hostId);
  const os = welcome.os;

  let remoteAdmin: AdminSummary = welcome.remoteAdmin;
  let state: DesktopState = welcome.desktop;
  const elements = new ElementBook();
  const stamps = new StampBook();
  const subscriptions: (() => void)[] = [];
  let disposed = false;

  const sources = { os, settings: o.settings, localAdmin: o.localAdmin, remoteAdmin: () => remoteAdmin };
  const desktop = (): RemoteDesktop => remoteDesktop({ welcome, state, combined: combinedAdmin(o.localAdmin(), remoteAdmin), label, login: o.login });
  const unavailable = (): string | null => {
    if (disposed || link.state === "closed" || link.state === "lost") return `The connection to ${label} is closed.`;
    const d = desktop();
    return d.desktop === "none" ? d.why ?? `Ember can't use ${label}'s desktop.` : null;
  };

  const apps = createRemoteApps(link, { os, label, log, stamps, unavailable });
  const policy = createRemotePolicy({ ...sources, isTerminalApp: name => apps.terminalByName(name) });
  const neverLook = () => remoteNeverLook(sources);
  const perception = createRemotePerception(link, { label, os, targetId: id, log, neverLook, desktop, elements });
  const sidecar = createRemoteSidecar(link, { label, log, elements, stamps, unavailable });
  const runner = createRemoteRunner(link, { target: id, label, os, log, facts: welcome.facts });
  const system = remoteWorkerSystem(os, apps);

  const binding = (): TargetBinding => {
    const d = desktop();
    return { id, kind: "ssh", label, login: o.login, screenOs: os, shellOs: os, desktop: d.desktop, ...(d.why ? { desktopWhy: d.why } : {}) };
  };

  /** A desktop the PC asked about (its own request): taken as the remote says, raising access included. */
  let asking: Promise<TargetBinding> | null = null;
  const refreshDesktop = (): Promise<TargetBinding> => {
    if (asking) return asking;
    asking = askRemote(link, "desktop.state", {}, { label }).then(s => {
      if (!disposed) state = s;
      return binding();
    }, (err: unknown) => {
      log.warn("remote.desktop_state_failed", { err: err instanceof Error ? err.name : "error" });
      return binding();
    }).finally(() => { asking = null; });
    return asking;
  };

  // The remote's own report of its desktop lowers access at once; a report of more is only taken from a request the
  // PC makes itself (§7.2 item 7), so it is asked for.
  subscriptions.push(link.on("desktop.changed", d => {
    const checked = EV_SCHEMAS["desktop.changed"].safeParse(d);
    if (disposed || !checked.success) return;
    const next = checked.data;
    if (lowerAccess(state.access, next.access)) {
      void refreshDesktop();
      return;
    }
    const before = binding().desktop;
    state = next;
    // Steps given for a desktop that has gone can't go out any more.
    if (binding().desktop === "none" && before !== "none") stamps.clear();
  }));
  // The remote's administrator changed its policy: gate 1 combines the new one (the PC's own still binds whatever it says).
  subscriptions.push(link.on("policy.changed", d => {
    const checked = EV_SCHEMAS["policy.changed"].safeParse(d);
    if (disposed || !checked.success) return;
    remoteAdmin = checked.data;
  }));
  subscriptions.push(link.onState(s => {
    if (s === "lost" || s === "closed") {
      stamps.clear();
      elements.clear();
    }
  }));

  // The never-look list in force here goes to the remote too (its gate 2 adds its own administrator's): sent now and
  // whenever it changes, so a window the user just hid isn't read there either (§5.4: hello.neverLook, policy.sync).
  let synced = "";
  const syncPolicy = (): void => {
    if (disposed || link.state !== "ready") return;
    const local = o.localAdmin();
    const args = { neverLook: syncedNeverLook(o.settings, local), localAdmin: adminSummary(local) };
    const key = JSON.stringify(args);
    if (key === synced) return;
    if (!OP_SCHEMAS["policy.sync"].args.safeParse(args).success) {
      log.warn("remote.policy_sync_unchecked", {});
      return;
    }
    synced = key;
    askRemote(link, "policy.sync", args, { label }).catch((err: unknown) => {
      synced = "";
      log.warn("remote.policy_sync_failed", { err: err instanceof Error ? err.name : "error" });
    });
  };
  subscriptions.push(o.settings.onChange(() => syncPolicy()));
  syncPolicy();
  if (desktop().desktop !== "none") void apps.refresh();

  return {
    perception, sidecar, apps, runner, policy, system, binding,
    onAuthorized: stamp => {
      if (!disposed) stamps.add(stamp);
    },
    refreshDesktop,
    refreshApps: () => apps.refresh(),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of subscriptions.splice(0)) {
        try { off(); } catch { /* the link is gone already */ }
      }
      stamps.clear();
      elements.clear();
      apps.dispose();
      runner.dispose();
    },
  };
}

/** The never-look list sent to the remote: the user's and the PC administrator's (CAPS.neverLook entries of ≤ 200 characters). */
function syncedNeverLook(settings: Pick<SettingsStore, "get">, local: LoadedAdminPolicy): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...settings.get().privacy.neverLook, ...local.policy.neverLook]) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key) || item.length > 200) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out.slice(0, 300);
}

/**
 * The remote's welcome as the PC accepts it (§7.2 item 6): a supported OS and architecture, its runner's facts on the
 * same OS, absolute homes by that OS's rules, a whole uid. Anything else: refused ("build-01 answered in a way Ember
 * can't check."). The link checked it against its schema already; it is checked again here.
 */
export function checkedWelcome(w: Welcome, label: string): Welcome {
  const checked = OP_SCHEMAS.hello.result.safeParse(w);
  if (!checked.success) throw new Error(unchecked(label));
  const v = checked.data;
  const abs = (p: string) => (v.os === "win32" ? win32 : posix).isAbsolute(p);
  if (v.facts.os !== v.os || !abs(v.home) || !abs(v.facts.home) || !Number.isSafeInteger(v.uid) || v.uid < 0) throw new Error(unchecked(label));
  return v;
}
