/**
 * One accessibility reader over Windows' UIA and each WSL distro's AT-SPI helper (§4.4; owned by package WB). UIA sees
 * a WSLg window as a frame with nothing in it, named "msrdc"; the distro's helper sees the Linux app inside. This
 * reader sends each call where it belongs: a WSL window's path, or an identified RAIL window's pid and title, to its
 * distro's helper (by the Linux pid and path the router matched, never a Windows pid), an element id to the helper that
 * handed it out (AtspiSidecar.ownsId), everything else to UIA. Every position a helper reports is mapped onto the screen
 * with its window's transform before it leaves (match.ts), so the rest of Ember sees physical pixels at scale 1; a
 * window identified by title only gives no positions at all. Off Windows, or with WSL off, it is UIA's sidecar itself.
 */

import { NEVER_LOOK_DEFAULTS } from "../../shared/never-look";
import type { OS } from "../../shared/shortcuts";
import type { JobHostRef } from "../commands/types";
import type { Logger } from "../logger";
import type { PerceptionSidecar, SidecarPort } from "../perception/ports";
import type {
  ActionResult, AtPointResult, AtspiSidecar, AxNode, AxWindow, Bounds, CanDo, ElementInfo, ReadWindowResult, SecretFieldsResult,
} from "../perception/sidecar";
import type { PerceptionWindows } from "../platform/types";
import type { SettingsStore } from "../settings";
import { mapBounds, unmapPoint, type Transform } from "./match";
import { dropRouter, parseWslPath, routerFor, type RouterDeps, type WslRouter, type WslWindow } from "./router";
import type { WslService } from "./types";

export interface WrapForWslOptions {
  os: OS;
  log: Logger;
  /** The Windows window system (its stack: HWND, pid, title, bounds, owner). */
  ws: () => PerceptionWindows | null;
  wsl: () => WslService | null;
  settings: SettingsStore;
  /**
   * (WB's extension; optional.) Where the helper comes from: ember_atspi.py on the PC (null: not in this install), the
   * job host, and the environment helpers start from. Default: the packaged resources' script (else the source tree's),
   * the job host beside main.cjs on Windows, and this process's environment.
   */
  helper?: { script?: string | null; jobHost?: JobHostRef | null; env?: NodeJS.ProcessEnv };
}

/** What a call for an id no helper (and not UIA) handed out says. */
const unknownId = (id: number) => new Error(`Element ${id} is no longer known: call perceive_window again.`);

/** A mapped rectangle, or none without a transform (a window identified by title only has no positions). */
const placed = (t: Transform | null, b: Bounds | null | undefined): Bounds | null => (t && b ? mapBounds(t, b) : null);

/** An element's bounds (and the part that shows) on screen, or none. */
function placeInfo<T extends ElementInfo | undefined>(t: Transform | null, e: T): T {
  if (!e) return e;
  const { shown, ...rest } = e;
  const s = placed(t, shown);
  return { ...rest, bounds: placed(t, e.bounds), ...(s ? { shown: s } : {}) } as T;
}

function placeNode(t: Transform | null, n: AxNode): AxNode {
  const { shown, ...rest } = n;
  const s = placed(t, shown);
  return { ...rest, bounds: placed(t, n.bounds), ...(s ? { shown: s } : {}) };
}

/** The routed reader (exported for tests: wrapForWsl is what main uses). */
export class RoutedSidecar implements PerceptionSidecar, SidecarPort {
  constructor(private base: AtspiSidecar, private router: WslRouter) {}

  /** The window element `id` came from, refreshed (positions come from a transform at most 2 s old). */
  private async windowOfId(id: number): Promise<WslWindow | null> {
    const path = this.router.pathOfId(id);
    return path ? this.router.windowAt(path) : null;
  }

  /** The distro whose helper handed `id` out (ownsId), or null for UIA's own; an id neither knows is an error. */
  private owner(id: number): { distro: string } | null {
    const distro = this.router.distroOfId(id);
    if (distro) {
      if (!this.router.active()) throw unknownId(id);
      return { distro };
    }
    if (this.base.ownsId(id)) return null;
    throw unknownId(id);
  }

  async listWindows(params: { ownPid?: number } = {}): Promise<{ windows: AxWindow[] }> {
    if (!this.router.active()) return this.base.listWindows(params);
    const [uia, snap] = await Promise.all([this.base.listWindows(params), this.router.refresh().catch(() => null)]);
    if (!snap || !snap.rails.size) return uia;
    const keep = uia.windows.filter(w => !this.router.covers(w, snap));
    const wsl: AxWindow[] = [...snap.windows.values()].map(w => ({
      app: w.app, pid: w.pid, path: w.path, name: w.frame.name, role: w.frame.role || "frame", active: w.hwnd === snap.foreground, bounds: { ...w.inner },
    }));
    return { windows: [...keep, ...wsl] };
  }

  async readWindow(params: Parameters<AtspiSidecar["readWindow"]>[0] = {}): Promise<ReadWindowResult> {
    if (!this.router.active()) return this.base.readWindow(params);
    const t0 = Date.now();
    const target = await this.router.target(params).catch(() => "base" as const);
    if (target === "base") return this.base.readWindow(params);
    if (target === "gone") return { window: null, nodes: [], ms: Date.now() - t0 };
    const { neverLook, maxDepth, maxNodes, keep, cells } = params;
    const { res, owns } = await this.router.withHelper(target.distro, async sc => ({
      res: await sc.readWindow({
        pid: target.frame.pid!, path: target.frame.path,
        // Never a Windows pid: the distro's own never-look processes, and the Linux defaults beside the user's list.
        neverLook: [...(neverLook ?? []), ...NEVER_LOOK_DEFAULTS.linux], skipPids: this.router.skipPids(target.distro, neverLook ?? []),
        ...(maxDepth !== undefined ? { maxDepth } : {}), ...(maxNodes !== undefined ? { maxNodes } : {}),
        ...(keep !== undefined ? { keep } : {}), ...(cells ? { cells } : {}),
      }),
      owns: (id: unknown) => typeof id === "number" && sc.ownsId(id),
    }));
    // Only ids this helper handed out: a distro naming another sidecar's id (UIA's, another distro's) would have an
    // action judged as one in this Linux app carried out on that element instead.
    const all: AxNode[] = Array.isArray(res.nodes) ? res.nodes : [];
    const mine = all.filter(n => !!n && typeof n === "object" && owns(n.id));
    if (mine.length !== all.length) this.router.o.log.warn("wsl.foreign_ids", { distro: target.distro, dropped: all.length - mine.length });
    const nodes = mine.map(n => placeNode(target.transform, n.parent === null || owns(n.parent) ? n : { ...n, parent: null }));
    this.router.rememberIds(nodes.map(n => n.id), target.path);
    const window: AxWindow | null = res.window ? { ...res.window, app: target.app, pid: target.pid, path: target.path, bounds: { ...target.inner } } : null;
    return { ...res, window, nodes };
  }

  async atPoint(params: Parameters<AtspiSidecar["atPoint"]>[0]): Promise<AtPointResult> {
    if (!this.router.active() || !params.path.startsWith("wsl:")) return this.base.atPoint(params);
    const w = await this.router.windowAt(params.path);
    const linux = parseWslPath(params.path);
    // No transform (identified by title only), or gone: nothing can be placed at a point (§4.9 step 6).
    if (!w || !w.transform || !linux) return { chain: [], found: false, ms: 0 };
    const tr = w.transform;
    const p = unmapPoint(tr, { x: params.x, y: params.y });
    const res = await this.router.withHelper(w.distro, sc => sc.atPoint({
      pid: linux.pid, path: linux.path, x: p.x, y: p.y, neverLook: [...(params.neverLook ?? []), ...NEVER_LOOK_DEFAULTS.linux],
      skipPids: this.router.skipPids(w.distro, params.neverLook ?? []), ...(params.menus === false ? { menus: false } : {}),
    }));
    return { ...res, chain: (res.chain ?? []).map(n => ({ ...n, bounds: placed(tr, n.bounds) })) };
  }

  /**
   * A WSL window's secret fields, mapped. Without a transform their places can't be told: one field the size of the
   * whole window stands for them when there is any (or the helper can't tell), so the window is blacked out (§4.7).
   */
  async secretFields(window: { pid: number; path: string }): Promise<SecretFieldsResult> {
    if (!this.router.active() || !window.path.startsWith("wsl:")) return this.base.secretFields(window);
    const w = await this.router.windowAt(window.path);
    const linux = parseWslPath(window.path);
    if (!w || !linux) return { fields: [], complete: false, ms: 0 };
    let res: SecretFieldsResult | null;
    try {
      res = await this.router.withHelper(w.distro, sc => sc.secretFields({ pid: linux.pid, path: linux.path }));
    } catch (err) {
      if (w.transform) throw err;
      res = null;
    }
    if (w.transform) return { ...res!, fields: res!.fields.map(f => ({ ...f, bounds: mapBounds(w.transform!, f.bounds) })) };
    const whole = { id: res?.fields[0]?.id ?? 0, role: "password text", bounds: { ...w.inner } };
    return !res || !res.complete || res.fields.length ? { fields: [whole], complete: true, ms: res?.ms ?? 0 } : { fields: [], complete: true, ms: res.ms };
  }

  async markSecret(ids: number[]): Promise<void> {
    if (!this.router.active()) return this.base.markSecret(ids);
    const byDistro = new Map<string, number[]>();
    const rest: number[] = [];
    for (const id of ids) {
      const d = this.router.distroOfId(id);
      if (d) byDistro.set(d, [...byDistro.get(d) ?? [], id]); else rest.push(id);
    }
    await Promise.all([
      ...(rest.length ? [this.base.markSecret(rest)] : []),
      ...[...byDistro].map(([d, list]) => this.router.withHelper(d, sc => sc.markSecret(list))),
    ]);
  }

  shellOverlays(): ReturnType<AtspiSidecar["shellOverlays"]> {
    // WSLg has no GNOME Shell: only UIA's (none).
    return this.base.shellOverlays();
  }

  scaleElements(ids: number[], k: number, keep = true): void {
    // A helper's ids are mapped already (scale 1); only UIA's are scaled.
    this.base.scaleElements(ids.filter(id => !this.router.distroOfId(id)), k, keep);
  }

  scaleOf(id: number): number {
    return this.router.distroOfId(id) ? 1 : this.base.scaleOf(id);
  }

  async readElement(id: number, o: { shown?: boolean; formula?: boolean } = {}): Promise<ElementInfo> {
    const who = this.owner(id);
    if (!who) return this.base.readElement(id, o);
    const [info, w] = await Promise.all([this.router.withHelper(who.distro, sc => sc.readElement(id, o)), this.windowOfId(id)]);
    return placeInfo(w?.transform ?? null, info);
  }

  async canDo(id: number, kind: "click" | "toggle" | "text" | "value", caret = false): Promise<CanDo> {
    const who = this.owner(id);
    return !who ? this.base.canDo(id, kind, caret) : this.router.withHelper(who.distro, sc => sc.canDo(id, kind, caret));
  }

  private async act(id: number, run: (sc: Pick<AtspiSidecar, "doAction" | "setText" | "setValue" | "selectOption">) => Promise<ActionResult>): Promise<ActionResult> {
    const who = this.owner(id);
    if (!who) return run(this.base);
    const res = await this.router.withHelper(who.distro, run);
    const t = (await this.windowOfId(id))?.transform ?? null;
    return { ...res, before: placeInfo(t, res.before), after: res.after && placeInfo(t, res.after) };
  }

  doAction(id: number, action = "click"): Promise<ActionResult> { return this.act(id, sc => sc.doAction(id, action)); }
  setText(id: number, text: string, mode: "replace" | "insert" | "append" = "replace"): Promise<ActionResult> { return this.act(id, sc => sc.setText(id, text, mode)); }
  setValue(id: number, value: number): Promise<ActionResult> { return this.act(id, sc => sc.setValue(id, value)); }
  selectOption(id: number, option: string): Promise<ActionResult> { return this.act(id, sc => sc.selectOption(id, option)); }

  async listOptions(id: number): Promise<{ options: string[]; left?: number }> {
    const who = this.owner(id);
    return !who ? this.base.listOptions(id) : this.router.withHelper(who.distro, sc => sc.listOptions(id));
  }

  /** Ember quits: UIA's helper and every distro's stop. */
  stop(): void {
    this.base.stop();
    dropRouter(this.router);
  }
}

/** UIA's sidecar, or one that also reads WSLg windows through each distro's sidecar. */
export function wrapForWsl(base: AtspiSidecar, o: WrapForWslOptions): PerceptionSidecar & SidecarPort {
  return wrapWith(base, o);
}

/** wrapForWsl with the router's parts given (tests). */
export function wrapWith(base: AtspiSidecar, o: WrapForWslOptions, deps?: RouterDeps): PerceptionSidecar & SidecarPort {
  // Off Windows nothing is ever a WSLg window: UIA's (or AT-SPI's) sidecar itself, untouched.
  if (o?.os !== "win32") return base;
  return new RoutedSidecar(base, routerFor(o, deps));
}
