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
  // A Stop moves the link's epoch on: stamps handed over before it are void (§5.1.11).
  const stamps = new StampBook(undefined, () => link.epoch);
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
  // Pictures only once the remote has the never-look list in force here: it masks those windows before a pixel leaves
  // (the PC can't mask what it never sees), so a list it hasn't confirmed means no picture (syncPolicy, below).
  const neverLookSynced = (): Promise<boolean> => syncPolicy();
  const perception = createRemotePerception(link, { label, os, targetId: id, log, neverLook, desktop, elements, neverLookSynced });
  const sidecar = createRemoteSidecar(link, { label, log, elements, stamps, unavailable });
  const runner = createRemoteRunner(link, { target: id, label, os, log, facts: welcome.facts });
  const system = remoteWorkerSystem(os, apps);

  const binding = (): TargetBinding => {
    const d = desktop();
    return { id, kind: "ssh", label, login: o.login, screenOs: os, shellOs: os, desktop: d.desktop, ...(d.why ? { desktopWhy: d.why } : {}) };
  };

  /** What the desktop would be with the remote's report `s`. */
  const desktopWith = (s: DesktopState) => remoteDesktop({ welcome, state: s, combined: combinedAdmin(o.localAdmin(), remoteAdmin), label, login: o.login }).desktop;
  /** Reports taken from events so far (an answer asked for before the latest one may be older than it). */
  let reported = 0;
  /**
   * A desktop the PC asked about (its own request): taken as the remote says, raising access included, unless the remote
   * reported less since the question went out (then only an answer that gives no more is taken).
   */
  let asking: Promise<TargetBinding> | null = null;
  const refreshDesktop = (): Promise<TargetBinding> => {
    if (asking) return asking;
    const asked = reported;
    // A person at the remote's screen has two minutes to allow it where its administrator asks for that (§5.3.9).
    const consoleMs = combinedAdmin(o.localAdmin(), remoteAdmin).ssh.requireConsoleConsent === true ? 120_000 : 0;
    asking = askRemote(link, "desktop.state", {}, { label, extraMs: consoleMs }).then(s => {
      if (!disposed && (asked === reported || !lowerAccess(desktop().desktop, desktopWith(s)))) state = s;
      return binding();
    }, (err: unknown) => {
      log.warn("remote.desktop_state_failed", { err: err instanceof Error ? err.name : "error" });
      return binding();
    }).finally(() => { asking = null; });
    return asking;
  };

  // The remote's own report of its desktop lowers access at once; a report that would give Ember more (more access, or
  // a screen no longer locked) is only taken from a request the PC makes itself (§7.2 item 7), so it is asked for.
  const reportedState = (next: DesktopState): void => {
    const before = desktop().desktop;
    const after = desktopWith(next);
    if (lowerAccess(state.access, next.access) || lowerAccess(before, after)) {
      void refreshDesktop();
      return;
    }
    state = next;
    reported++;
    // Steps given for a desktop that has gone can't go out any more.
    if (after === "none" && before !== "none") stamps.clear();
  };
  subscriptions.push(link.on("desktop.changed", d => {
    const checked = EV_SCHEMAS["desktop.changed"].safeParse(d);
    if (disposed || !checked.success) return;
    reportedState(checked.data);
  }));
  // The notice on the remote's screen (its Stop) couldn't be shown, or shows again: the same as a report of the desktop
  // with that notice (a notice that failed means no desktop, §2.5; one that shows again gives more only when asked).
  subscriptions.push(link.on("notice", d => {
    const checked = EV_SCHEMAS.notice.safeParse(d);
    if (disposed || !checked.success) return;
    reportedState({ ...state, notice: checked.data.state });
  }));
  // Someone at the remote pressed the notice's Stop: no step the user said yes to before it goes out after it.
  subscriptions.push(link.on("console.stop", () => {
    if (!disposed) stamps.clear();
  }));
  // The remote's administrator changed its policy: gate 1 combines the new one (the PC's own still binds whatever it says).
  subscriptions.push(link.on("policy.changed", d => {
    const checked = EV_SCHEMAS["policy.changed"].safeParse(d);
    if (disposed || !checked.success) return;
    remoteAdmin = checked.data;
  }));
  // The never-look list in force here goes to the remote too (its gate 2 adds its own administrator's): sent now,
  // whenever it changes and when a stalled link answers again, so a window the user just hid isn't read or pictured
  // there either (§5.4: hello.neverLook, policy.sync). `acked`: the list the remote confirmed it has.
  let acked = "";
  let syncing: { key: string; done: Promise<boolean> } | null = null;
  const syncPolicy = (): Promise<boolean> => {
    if (disposed || link.state !== "ready") return Promise.resolve(false);
    const local = o.localAdmin();
    const args = { neverLook: syncedNeverLook(o.settings, local), localAdmin: adminSummary(local) };
    const key = JSON.stringify(args);
    if (key === acked) return Promise.resolve(true);
    if (syncing?.key === key) return syncing.done;
    if (!OP_SCHEMAS["policy.sync"].args.safeParse(args).success) {
      log.warn("remote.policy_sync_unchecked", {});
      return Promise.resolve(false);
    }
    const done = askRemote(link, "policy.sync", args, { label }).then(() => {
      acked = key;
      return true;
    }, (err: unknown) => {
      log.warn("remote.policy_sync_failed", { err: err instanceof Error ? err.name : "error" });
      return false;
    }).finally(() => {
      if (syncing?.done === done) syncing = null;
    });
    syncing = { key, done };
    return done;
  };
  subscriptions.push(link.onState(s => {
    if (s === "lost" || s === "closed") {
      stamps.clear();
      elements.clear();
    } else if (s === "ready") {
      void syncPolicy();
    }
  }));
  subscriptions.push(o.settings.onChange(() => { void syncPolicy(); }));
  void syncPolicy();
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
