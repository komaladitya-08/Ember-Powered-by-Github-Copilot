/**
 * The hands a worker on each target gets (§2.6's table): this screen's for "local" and for a WSL distro (WSLg windows
 * are on this screen, so their window leases are this screen's own keys: a local task and a WSL task acting in the same
 * window must exclude each other, critique wsl-13), and a remote's parts for an SSH target (gate 1 per connection, no
 * borrowed mouse, no flight to remote coordinates, never the remote person's window as the task's start). Without a
 * window system this computer still takes commands: its hands then read and act on nothing (ports that refuse every
 * call). Plain Node.
 */

import type { OS } from "../../shared/shortcuts";
import { targetIdOf } from "../../shared/targets";
import type { Hands } from "../agent/host";
import type { WorkerSystem } from "../agent/worker";
import type { CommandService } from "../commands/types";
import type { PerceptionPort, SidecarPort } from "../perception/ports";
import type { RemoteTargetParts } from "../remote/target";
import type { HostRecord } from "../remote/types";
import type { WslDistro } from "../wsl/types";
import type { TargetBinding, TargetHands } from "./types";
import { LOCAL_LABEL, distroLabel } from "./registry";
import { isToolDistro } from "./wsl-service";

/** A perception port for a target with no desktop: every read refuses, saying why. */
export function refusingPerception(why: string): PerceptionPort {
  const no = (): Promise<never> => Promise.reject(new Error(why));
  return { focused: no, read: no, atPoint: no, quickContext: no, describe: no, perceive: no, systemDialogOpen: no, windows: no };
}

/** A sidecar port for a target with no desktop: every read and action refuses; stop does nothing (nothing runs). */
export function refusingSidecar(why: string): SidecarPort {
  const no = (): Promise<never> => Promise.reject(new Error(why));
  return {
    readElement: no, canDo: no, doAction: no, setText: no, setValue: no, selectOption: no, listOptions: no,
    scaleOf: () => 1,
    stop: () => undefined,
  };
}

/** This computer's binding: its screen when a window system opened, else commands only (§2.6). */
export function localBinding(os: OS, desktop: boolean): TargetBinding {
  return {
    id: "local", kind: "local", label: LOCAL_LABEL, screenOs: os, shellOs: os, desktop: desktop ? "screen" : "none",
    ...(desktop ? {} : { desktopWhy: "Ember can't use this computer's screen here." }),
  };
}

/**
 * A distro's binding: the Windows screen judges its windows, commands run in Linux. WSL 1 and a tool's distro have no
 * Linux apps of the user's, so they are commands only (§1.3, §2.2).
 */
export function wslBinding(d: Pick<WslDistro, "name" | "version" | "tool">, screen: boolean): TargetBinding {
  const label = distroLabel(d.name);
  const why = !screen ? "Ember can't use this computer's screen here."
    : d.version === 1 ? `${d.name} runs WSL 1, which shows no Linux apps.`
      : isToolDistro(d) ? `${d.name} belongs to Podman: Ember only runs commands there.` : null;
  return {
    id: targetIdOf("wsl", d.name), kind: "wsl", label, screenOs: "win32", shellOs: "linux",
    desktop: why ? "none" : "screen", ...(why ? { desktopWhy: why } : {}),
  };
}

/** A host's binding before it is connected (bind() names it; handsFor refuses it until it is). */
export function hostBinding(h: Pick<HostRecord, "id" | "resolved">): TargetBinding {
  return {
    id: targetIdOf("ssh", h.id), kind: "ssh", label: h.id, login: h.resolved.user, screenOs: "linux", shellOs: "linux",
    desktop: "none", desktopWhy: `${h.id} isn't connected.`,
  };
}

/** What every target's hands share from main when this screen has none (no window system): audit, Confirmer, policy. */
export interface HandsBase { audit: Hands["audit"]; confirmer: Hands["confirmer"]; policy: Hands["policy"] }

/**
 * Hands on this screen (local and WSL: same perception, sidecar, policy, mouse; lease keys unchanged) or, without a
 * window system, hands that only carry commands.
 */
export function screenHands(o: { hands: Hands | null; base: HandsBase | null; binding: TargetBinding; system: WorkerSystem; commands: CommandService | null }): TargetHands | null {
  const keys = { grantKey: (app: string) => app.toLowerCase(), leaseKey: (k: string) => k };
  if (o.hands) return { ...o.hands, binding: o.binding, system: o.system, commands: o.commands, ...keys };
  if (!o.base) return null;
  const why = `There is no desktop to work in on ${o.binding.label === LOCAL_LABEL ? "this computer" : o.binding.label}: work only through run_command.`;
  return {
    perception: refusingPerception(why), sidecar: refusingSidecar(why), policy: o.base.policy, audit: o.base.audit, confirmer: o.base.confirmer,
    flyTo: () => undefined, currentWindow: () => null,
    binding: o.binding, system: o.system, commands: o.commands, ...keys,
  };
}

/** A perception port whose every read waits for `ready` first (it must never reject: a failed wait still reads). */
export function waitingPerception(p: PerceptionPort, ready: () => Promise<unknown>): PerceptionPort {
  const after = <T>(f: () => Promise<T>): Promise<T> => ready().then(f, f);
  return {
    focused: (...a) => after(() => p.focused(...a)),
    read: (...a) => after(() => p.read(...a)),
    atPoint: (...a) => after(() => p.atPoint(...a)),
    quickContext: () => after(() => p.quickContext()),
    describe: () => after(() => p.describe()),
    perceive: (...a) => after(() => p.perceive(...a)),
    systemDialogOpen: () => after(() => p.systemDialogOpen()),
    windows: () => after(() => p.windows()),
  };
}

/** A sidecar port whose every read and action waits for `ready` first; scaleOf and stop answer at once. */
export function waitingSidecar(s: SidecarPort, ready: () => Promise<unknown>): SidecarPort {
  const after = <T>(f: () => Promise<T>): Promise<T> => ready().then(f, f);
  return {
    readElement: (...a) => after(() => s.readElement(...a)),
    canDo: (...a) => after(() => s.canDo(...a)),
    doAction: (...a) => after(() => s.doAction(...a)),
    setText: (...a) => after(() => s.setText(...a)),
    setValue: (...a) => after(() => s.setValue(...a)),
    selectOption: (...a) => after(() => s.selectOption(...a)),
    listOptions: (...a) => after(() => s.listOptions(...a)),
    scaleOf: id => s.scaleOf(id),
    stop: () => s.stop(),
  };
}

/**
 * Hands on a remote (§2.6's SSH column): its perception, sidecar and gate 1; main's audit and Confirmer (the remote keeps
 * its own audit too); no flight, no window of the remote person's as a start, no borrowed mouse, clipboard or desk (L4);
 * grants and leases keyed by the target. `ready`: the remote's desktop as the PC asked for it before this task
 * (desktop.state, §5.3.4 step 8, which starts the desktop helper and its notice there): reads and steps wait for it.
 */
export function remoteHands(o: { hostId: string; parts: RemoteTargetParts; base: Pick<HandsBase, "audit" | "confirmer">; commands: CommandService | null; ready?: () => Promise<unknown> }): TargetHands {
  const id = targetIdOf("ssh", o.hostId);
  const ready = o.ready;
  return {
    perception: ready ? waitingPerception(o.parts.perception, ready) : o.parts.perception,
    sidecar: ready ? waitingSidecar(o.parts.sidecar, ready) : o.parts.sidecar,
    policy: o.parts.policy, audit: o.base.audit, confirmer: o.base.confirmer,
    flyTo: () => undefined, currentWindow: () => null,
    binding: o.parts.binding(), system: o.parts.system, commands: o.commands,
    grantKey: app => `${id}:${app.toLowerCase()}`,
    leaseKey: k => `${id}|${k}`,
    onAuthorized: stamp => o.parts.onAuthorized(stamp),
  };
}
