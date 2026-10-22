/**
 * Fakes for the WSL router's tests (wsl-router, wsl-routed-sidecar, wsl-routed-windows, wsl-privacy): a Windows stack
 * with WSLg's RAIL windows, a WSL service, distro helpers that behave like AtspiSidecar (a process that starts only when
 * its launch's mayStart says so, ids from their own block, never revived), and a clock. OS-neutral: nothing is spawned.
 */

import type { AxNode, AxWindow, ReadWindowResult, SecretFieldsResult, AtPointResult, ActionResult, ElementInfo } from "../../app/main/perception/sidecar";
import type { Logger } from "../../app/main/logger";
import type { SettingsStore } from "../../app/main/settings";
import type { StackedWindow, WindowSystem } from "../../app/main/platform/types";
import type { DistroSidecar, HelperDiag, HelperFactory, HelperProblem } from "../../app/main/wsl/launch-sidecar";
import type { RailProbe } from "../../app/main/wsl/rail";
import type { RouterDeps } from "../../app/main/wsl/router";
import type { WrapForWslOptions } from "../../app/main/wsl/routed-sidecar";
import type { WslDistro, WslFacts, WslService } from "../../app/main/wsl/types";

export const WSLG_MSRDC = "C:\\Program Files\\WSL\\msrdc.exe";
export const RDP_MSRDC = "C:\\Program Files\\Remote Desktop\\msrdc.exe";

export const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; }, file: "" };

/** A stacked window (Windows: id = client = HWND). */
export function stacked(id: number, pid: number, title: string, wmClass: string, inner: { x: number; y: number; width: number; height: number }, more: Partial<StackedWindow> = {}): StackedWindow {
  return { id, client: id, pid, title, wmClass, ...inner, outer: { ...inner }, inner: { ...inner }, overrideRedirect: false, ...more };
}

/** The Windows window system: a stack (bottom to top) and the foreground window. */
export class FakeWindows {
  stack: StackedWindow[] = [];
  foreground = 0;
  activated: number[] = [];
  readonly ws: WindowSystem & { activate(w: number): void; extra: string };

  constructor() {
    const asWindow = (w: StackedWindow | undefined) => (w ? { id: w.id, pid: w.pid, title: w.title, x: w.x, y: w.y, width: w.width, height: w.height, wmClass: w.wmClass, wmClassName: "RAIL_WINDOW" } : null);
    this.ws = {
      kind: "win32", compositorMayChange: false, extra: "I-win's",
      hasCompositor: () => true, pointer: () => null, keysDown: () => null,
      activeWindow: () => asWindow(this.stack.find(w => w.id === this.foreground)),
      focusWindow: () => asWindow(this.stack.find(w => w.id === this.foreground)),
      clientWindows: () => this.stack.filter(w => !w.overrideRedirect).map(w => asWindow(w)!).reverse(),
      stack: () => this.stack.map(w => ({ ...w })),
      capture: () => null, close: () => undefined, windowId: () => 0,
      toDip: r => r, toDipPoint: p => p, screenBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      activate: (w: number) => { this.activated.push(w); },
    };
  }
}

export interface FrameSpec {
  pid: number;
  path: string;
  app: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  children: { x: number; y: number; width: number; height: number }[];
  program?: string;
  argv0?: string;
  argv1?: string;
  comm?: string;
  active?: boolean;
}

/** A helper's process as AtspiSidecar runs one: started on a request when mayStart allows, ids from its own block. */
export class FakeHelper implements DistroSidecar {
  static blocks = 0;
  running = false;
  stopped = 0;
  pid: number | null = null;
  private block = 0;
  private blocksUsed = new Set<number>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  uid = 1000;
  wslg = true;
  pyatspi = true;
  bus: string = "proc";
  /** find_bus answers this once (then `bus`). */
  restartOnce = false;
  frames: FrameSpec[] = [];
  /** Nodes per frame path; their bounds are in the app's pixels. */
  nodes = new Map<string, AxNode[]>();
  secrets: SecretFieldsResult = { fields: [], complete: true, ms: 1 };
  secretsError: Error | null = null;
  chain: AtPointResult = { chain: [], ms: 1 };
  private static pids = 5000;

  constructor(readonly distro: string, readonly mayStart: () => boolean) {}

  private ensure(): void {
    if (this.running) return;
    if (!this.mayStart()) throw new Error("accessibility helper not running");
    this.running = true;
    this.pid = FakeHelper.pids++;
    this.block = ++FakeHelper.blocks;
    this.blocksUsed.add(this.block);
  }

  /** The process dies (a crash, wsl --terminate): no revive. */
  crash(): void {
    this.running = false;
    this.pid = null;
  }

  id(n: number): number {
    return this.block * 10_000_000 + n;
  }

  ownsId(id: number): boolean {
    const b = Math.floor(id / 10_000_000);
    return id > b * 10_000_000 && this.blocksUsed.has(b);
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }
    this.calls.push({ method, params });
    if (method === "status") return Promise.resolve({ version: 3, python: "3.10", toolkitAccessibility: true, apps: 3, uid: this.uid, wslg: this.wslg, bus: "none", pyatspi: this.pyatspi } as T);
    if (method === "find_bus") {
      if (this.restartOnce) {
        this.restartOnce = false;
        return Promise.resolve({ bus: "x11", restart: true } as T);
      }
      return Promise.resolve({ bus: this.bus } as T);
    }
    return Promise.reject(new Error(`unknown method: ${method}`));
  }

  private call<T>(method: string, params: Record<string, unknown>, answer: () => T): Promise<T> {
    try {
      this.ensure();
    } catch (err) {
      return Promise.reject(err);
    }
    this.calls.push({ method, params });
    return Promise.resolve(answer());
  }

  listWindows(params: { ownPid?: number } = {}): Promise<{ windows: AxWindow[] }> {
    return this.call("list_windows", params, () => ({ windows: this.frames.map(f => ({ role: "frame", active: false, ...f })) as unknown as AxWindow[] }));
  }

  readWindow(params: Record<string, unknown> = {}): Promise<ReadWindowResult> {
    return this.call("read_window", params, () => {
      const f = this.frames.find(x => x.pid === params.pid && x.path === params.path);
      if (!f) return { window: null, nodes: [], ms: 1 };
      return { window: { app: f.app, pid: f.pid, path: f.path, name: f.name, role: "frame", active: true, bounds: f.bounds }, nodes: this.nodes.get(f.path) ?? [], ms: 2 };
    });
  }

  atPoint(params: { pid: number; path: string; x: number; y: number }): Promise<AtPointResult> {
    return this.call("at_point", params, () => this.chain);
  }

  secretFields(window: { pid: number; path: string }): Promise<SecretFieldsResult> {
    if (this.secretsError) {
      const e = this.secretsError;
      return this.call("secret_fields", window, () => { throw e; });
    }
    return this.call("secret_fields", window, () => this.secrets);
  }

  markSecret(ids: number[]): Promise<void> {
    return this.call("mark_secret", { ids }, () => undefined);
  }

  private info(id: number): ElementInfo {
    // Only the process that handed an id out knows it.
    if (Math.floor(id / 10_000_000) !== this.block) throw new Error(`unknown element ${id}`);
    for (const nodes of this.nodes.values()) {
      const n = nodes.find(x => x.id === id);
      if (n) return { role: n.role, name: n.name, states: n.states, bounds: n.bounds };
    }
    throw new Error(`unknown element ${id}`);
  }

  readElement(id: number, o: { shown?: boolean; formula?: boolean } = {}): Promise<ElementInfo> {
    return this.call("read_element", { id, ...o }, () => this.info(id));
  }

  canDo(id: number, kind: "click" | "toggle" | "text" | "value", caret = false) {
    return this.call("can_do", { id, kind, caret }, () => ({ tier1: true }));
  }

  private acted(id: number): ActionResult {
    return { ok: true, before: this.info(id), after: this.info(id) };
  }

  doAction(id: number, action = "click"): Promise<ActionResult> { return this.call("do_action", { id, action }, () => this.acted(id)); }
  setText(id: number, text: string, mode: "replace" | "insert" | "append" = "replace"): Promise<ActionResult> { return this.call("set_text", { id, text, mode }, () => this.acted(id)); }
  setValue(id: number, value: number): Promise<ActionResult> { return this.call("set_value", { id, value }, () => this.acted(id)); }
  selectOption(id: number, option: string): Promise<ActionResult> { return this.call("select_option", { id, option }, () => this.acted(id)); }
  listOptions(id: number) { return this.call("list_options", { id }, () => ({ options: ["A", "B"] })); }

  stop(): void {
    this.stopped++;
    this.running = false;
    this.pid = null;
  }
}

/** WSL as WA's service reports it. */
export class FakeWsl {
  distros: WslDistro[] = [];
  wslg = { available: true, disabledByUser: false, version: "1.0.65" };
  runningNowCalls = 0;
  listeners: ((f: WslFacts) => void)[] = [];
  readonly service: WslService;

  constructor() {
    this.service = {
      facts: async () => this.facts(),
      isRunning: n => this.distros.some(d => d.name === n && d.running),
      runningNow: async () => { this.runningNowCalls++; return new Set(this.distros.filter(d => d.running).map(d => d.name)); },
      runner: () => { throw new Error("no runner in these tests"); },
      defaultUid: async () => null,
      windowsContext: () => { throw new Error("unused"); },
      bootIds: async () => [],
      onChange: fn => { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(l => l !== fn); }; },
      doctorRows: async () => [],
      dispose: () => undefined,
    };
  }

  facts(): WslFacts {
    return { installed: true, wslExe: "C:\\Program Files\\WSL\\wsl.exe", distros: this.distros.map(d => ({ ...d })), wslg: { ...this.wslg }, wslVersion: "2.3.26.0" };
  }

  add(name: string, more: Partial<WslDistro> = {}): this {
    this.distros.push({ name, version: 2, isDefault: this.distros.length === 0, defaultUid: null, running: true, needsSetup: false, ...more });
    return this;
  }

  /** A distro stops (wsl --terminate): WA tells its listeners. */
  stop(name: string): void {
    for (const d of this.distros) if (d.name === name) d.running = false;
    for (const l of this.listeners) l(this.facts());
  }
}

/** Everything a router test needs, wired. */
export function harness(o: { os?: "win32" | "linux"; on?: boolean; images?: Record<number, string>; owners?: Record<number, number>; problem?: HelperProblem; diag?: HelperDiag | null } = {}) {
  const windows = new FakeWindows();
  const wsl = new FakeWsl();
  const state = { on: o.on ?? true, consent: 1, service: true, now: 1_000_000, neverLook: [] as string[] };
  const helpers: FakeHelper[] = [];
  const created: string[] = [];
  const tickers: (() => void)[] = [];
  const images: Record<number, string> = { ...o.images };
  const probe: RailProbe = { imagePath: pid => images[pid] ?? null, owner: h => o.owners?.[h] ?? 0 };
  /** Per distro, how its next helper is set up. */
  const setups = new Map<string, (h: FakeHelper) => void>();
  const factory: HelperFactory = {
    present: () => o.problem !== "missing",
    async create(distro, _wslExe, mayStart) {
      created.push(distro);
      if (o.problem) return { problem: o.problem };
      const h = new FakeHelper(distro, mayStart);
      setups.get(distro)?.(h);
      helpers.push(h);
      return h;
    },
    diag: async () => o.diag ?? null,
  };
  const deps: RouterDeps = {
    rail: probe, helpers: factory, now: () => state.now,
    every: fn => { tickers.push(fn); return { stop: () => { const i = tickers.indexOf(fn); if (i >= 0) tickers.splice(i, 1); } }; },
  };
  const settings = {
    get: () => ({ targets: { wsl: { on: state.on, consent: { version: state.consent, at: state.consent ? "2026-10-22T00:00:00Z" : null } } }, privacy: { neverLook: state.neverLook } }),
  } as unknown as SettingsStore;
  const options: WrapForWslOptions = { os: o.os ?? "win32", log: quiet, ws: () => windows.ws, wsl: () => (state.service ? wsl.service : null), settings };
  return { windows, wsl, state, helpers, created, tickers, images, setups, deps, options, helperOf: (d: string) => helpers.filter(h => h.distro === d).at(-1) };
}

/** gedit in Ubuntu at 100 %: RAIL HWND 11 of msrdc 4242, its AT-SPI frame with GTK3's shadow margins. */
export function geditScene(h: ReturnType<typeof harness>, o: { hwnd?: number; pid?: number; inner?: { x: number; y: number; width: number; height: number }; title?: string } = {}) {
  const pid = o.pid ?? 4242;
  h.images[pid] = WSLG_MSRDC;
  const inner = o.inner ?? { x: 100, y: 200, width: 800, height: 600 };
  h.windows.stack.push(stacked(o.hwnd ?? 11, pid, o.title ?? "notes.txt - gedit (Ubuntu)", "msrdc", inner));
  const frame: FrameSpec = {
    pid: 700, path: "/org/a11y/atspi/accessible/1", app: "gedit", name: "notes.txt - gedit", program: "gedit", argv0: "gedit", comm: "gedit",
    bounds: { x: 0, y: 0, width: 852, height: 646 }, children: [{ x: 26, y: 23, width: 800, height: 600 }],
  };
  return { pid, inner, frame };
}
