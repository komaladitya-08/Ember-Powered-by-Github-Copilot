/**
 * The desktop child (`ember-remote.cjs desktop`, §5.3.1): started by serve with the session's environment once desktop
 * discovery found a desktop it may use, it is Ember's eyes and hands on that screen: Perception with the PNG capture
 * (png.ts) over the X11 window system sized from the X root (screen.ts), or with no window system on Wayland (text
 * only, L5); the AT-SPI sidecar; installed apps; the visible notice (notice.ts); and gate 2's step checks (§5.3.7),
 * which need the fresh facts only it has. It verifies the desktop before anything is read (X opens, the X screensaver
 * is off, the sidecar answers with apps and accessibility on, the notice shows, the console allowed it where required)
 * and stops on its stdin's end. It talks only to serve, over its stdio (desktop-ipc.ts). Plain Node; koffi loads lazily
 * inside the X11 code.
 */

import { spawn } from "node:child_process";
import { Perception } from "../main/perception";
import { AtspiSidecar, pickPython, type AxWindow } from "../main/perception/sidecar";
import { isNeverLook } from "../main/perception/elements";
import { isSecurityWindow, PolicyEngine, type TextMode } from "../main/policy/policy";
import { isTerminalApp, launchApp, listApps, type DesktopApp } from "../main/hands/system";
import { openXInput, type XInput } from "../main/hands/input";
import { openLinuxWindows } from "../main/platform/linux/window-system";
import type { WindowSystem } from "../main/platform/types";
import { friendlyApp } from "../shared/apps";
import type { Logger } from "../main/logger";
import { CAPS, OP_SCHEMAS, type OpArgs } from "../main/remote/protocol";
import type { AuditEntry } from "../main/policy/audit";
import { ChildPolicySchema, InitArgsSchema, IpcError, lineRpc, type ChildPolicy, type InitArgs, type InitResult, type LineRpc } from "./desktop-ipc";
import { gateStep, sha256Hex } from "./gate";
import { noticeText, startNotice, type Notice } from "./notice";
import { remoteCapture } from "./png";
import { ignoreXErrors, rootScreen, rootSize } from "./screen";
import { cut, targetOf, wireApp, wireCanDo, wireElementInfo, wirePoint, wireSeen, wireWindow, wireActionResult } from "./wire";


/** How long the sidecar's first status may take (python and AT-SPI starting on a busy desktop). */
const STATUS_MS = 20_000;
/** Element ids remembered with the window they were read in (the newest reads'). */
const IDS_KEPT = 20_000;

/** What the desktop child keeps while it runs. */
interface ChildState {
  init: InitArgs;
  policy: ChildPolicy;
  ws: WindowSystem | null;
  xinput: XInput | null;
  sidecar: AtspiSidecar;
  perception: Perception;
  engine: PolicyEngine;
  notice: Notice;
  /** Element id → the window it was read in (pid and accessible path), for gate 2's "same window" check. */
  ids: Map<number, { pid: number | null; path?: string }>;
  paused: boolean;
}

/** A window's facts now: its app and title as the sidecar lists it (never-look windows included: the policy judges). */
async function windowNow(s: ChildState, at: { pid: number | null; path?: string }): Promise<{ app: string; title: string } | null> {
  const { windows } = await s.sidecar.listWindows({ ownPid: process.pid });
  const w = windows.find(x => x.pid === at.pid && (at.path === undefined || x.path === at.path));
  return w ? { app: w.app, title: w.name } : null;
}

/** Remembers which window each element of a read belongs to. */
function remember(s: ChildState, window: AxWindow | null, ids: number[]): void {
  if (!window) return;
  for (const id of ids) {
    s.ids.delete(id);
    s.ids.set(id, { pid: window.pid, ...(window.path !== undefined ? { path: window.path } : {}) });
  }
  while (s.ids.size > IDS_KEPT) s.ids.delete(s.ids.keys().next().value as number);
}

/**
 * The engine gate 2 judges steps with: this computer's policy, Linux's vocabulary, no grants (§5.3.7 step 4). The rate
 * limit is fixed when it is made (a policy that changes it makes a new engine).
 */
function engineFor(policy: () => ChildPolicy, rateLimit: number | undefined): PolicyEngine {
  return new PolicyEngine({
    neverLook: () => policy().neverLook,
    grants: () => ({}),
    allowGrants: () => false,
    actionsAllowed: () => policy().actionsAllowed,
    confirmEveryAction: () => policy().confirmEveryAction,
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    isTerminalApp: name => isTerminalApp({ id: name, name }),
    ownPid: process.pid,
    os: "linux",
  });
}

/** The screen is locked as X tells it (screensaver on or the display powered down); unreadable counts as locked. */
function xLocked(s: Pick<ChildState, "xinput" | "init">): boolean {
  if (s.init.type !== "x11") return false;
  try {
    return !s.xinput?.screenLocked || s.xinput.screenLocked();
  } catch {
    return true;
  }
}

/** Verifies the desktop and starts everything (§5.3.4 step 6, §5.3.9); none with why when anything fails. */
async function start(init: InitArgs, log: Logger, onStop: () => void, onGone: (why: string) => void): Promise<{ state: ChildState | null; result: InitResult }> {
  const env = process.env;
  const none = (why: string, notice: InitResult["notice"] = "off"): { state: null; result: InitResult } => ({ state: null, result: { access: "none", why, notice } });
  let ws: WindowSystem | null = null;
  let xinput: XInput | null = null;
  if (init.type === "x11") {
    // Before the first X call: a window that closes between two calls must not end the helper (review #4).
    if (!ignoreXErrors()) log.warn("remote.x_error_handler_failed", {});
    const size = env.DISPLAY ? rootSize(env.DISPLAY) : null;
    ws = size ? openLinuxWindows({ screen: rootScreen(size), env }) : null;
    if (!ws) return none(`Ember can't open ${init.host}'s display.`);
    xinput = openXInput(env.DISPLAY);
    if (xLocked({ xinput, init })) {
      ws.close();
      xinput?.close();
      return none(`${init.host}'s screen is locked.`);
    }
  }
  const python = pickPython(env);
  const sidecar = new AtspiSidecar(init.atspi, log.child("sidecar"), python, env);
  const fail = (why: string, notice: InitResult["notice"] = "off") => {
    sidecar.stop();
    ws?.close();
    xinput?.close();
    return none(why, notice);
  };
  let status;
  try {
    status = await Promise.race([sidecar.status(), new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("timeout")), STATUS_MS))]);
  } catch {
    return fail(`Ember can't read apps on ${init.host}: its accessibility helper didn't start (python3 with pyatspi is needed there).`);
  }
  if (status.toolkitAccessibility === false || !(status.apps > 0)) {
    return fail(`Turn on accessibility on ${init.host}: run gsettings set org.gnome.desktop.interface toolkit-accessibility true there, then restart its apps.`);
  }
  // The notice: a window on X11 or Xwayland (GTK can't keep a native Wayland window on top), else a notification.
  const notification = init.type === "wayland" && !env.DISPLAY;
  const noticeEnv = { ...env, ...(init.type === "wayland" && env.DISPLAY ? { GDK_BACKEND: "x11" } : {}) };
  const notice = startNotice({ python, script: init.notice, env: noticeEnv, notification, log: log.child("notice"), spawn });
  const words = noticeText(init.pc);
  if (init.consent && !(await notice.ask(words.asking))) {
    notice.close();
    return fail(`Nobody at ${init.host}'s screen allowed Ember to use it.`, "off");
  }
  if (!(await notice.show(words.using))) {
    notice.close();
    return fail(`Ember couldn't show its notice on ${init.host}'s screen, so it won't use it.`, "failed");
  }
  notice.onStop(onStop);
  notice.onGone(onGone);
  // The engine and Perception read the policy in force at each call (serve sends a new one on a change).
  const state: ChildState = {
    init, policy: init.policy, ws, xinput, sidecar, notice, ids: new Map(), paused: false,
    engine: engineFor(() => state.policy, init.policy.maxActionsPerMinute),
    perception: new Perception({
      sidecar,
      x11: ws,
      neverLook: () => state.policy.neverLook,
      screenBounds: () => (ws ? ws.screenBounds() : { x: 0, y: 0, width: 1, height: 1 }),
      log: log.child("perception"),
      ownPid: process.pid,
      capture: remoteCapture,
    }),
  };
  return { state, result: { access: init.access, notice: "shown" } };
}

/** "(No screenshot: why.)" at the end of a perceive's text, as the protocol's noShot. */
function noShotOf(text: string): string | undefined {
  const m = /\(No screenshot: ([^\n]*)\.\)$/.exec(text);
  return m ? cut(m[1], CAPS.str.reason) : undefined;
}

/** The open windows as plain lines (§5.4 perceive.openWindows): X11's list where there is one, else the sidecar's. */
async function openWindows(s: ChildState): Promise<{ lines: { app: string; title: string; active: boolean; busy?: boolean }[] }> {
  if (s.ws) {
    const active = s.ws.activeWindow()?.id;
    const list = s.policy.neverLook;
    const lines = s.ws.clientWindows()
      .filter(w => w.pid !== process.pid && !isNeverLook({ app: w.wmClass, name: w.title }, list)
        && !w.wmClass.split(/\s+/).concat(w.wmClassName ?? []).some(part => part && isSecurityWindow({ app: part }))
        && !isSecurityWindow({ app: w.wmClass, title: w.title }))
      .map(w => {
        const cls = w.wmClassName ?? w.wmClass.split(/\s+/).filter(Boolean).at(-1) ?? "";
        return { app: cut(friendlyApp(cls) || "unknown app", CAPS.str.app), title: cut(w.title, CAPS.str.title), active: w.id === active };
      });
    return { lines: lines.slice(0, CAPS.lines) };
  }
  const wins = await s.perception.windows();
  return { lines: wins.slice(0, CAPS.lines).map(w => ({ app: cut(w.app, CAPS.str.app), title: cut(w.name, CAPS.str.title), active: w.active, ...(w.busy ? { busy: true } : {}) })) };
}

/** What an `act` carries as text (for its value hash and the policy) and its typing mode. */
function valueOf(a: OpArgs<"act">): { value?: string; mode?: TextMode } {
  if (a.op === "set_text") return { value: a.text, mode: a.mode };
  if (a.op === "set_value") return { value: String(a.value) };
  if (a.op === "select_option") return { value: a.option };
  return {};
}

/** Answers serve's requests. */
async function handle(s: ChildState, rpc: LineRpc, op: string, raw: unknown): Promise<unknown> {
  if (op === "pause") {
    s.paused = true;
    s.sidecar.stop();
    s.notice.paused(noticeText(s.init.pc).paused);
    return {};
  }
  if (op === "resume") {
    if (xLocked(s)) throw new IpcError("denied", `${s.init.host}'s screen is locked.`);
    s.paused = false;
    if (!(await s.notice.show(noticeText(s.init.pc).using))) throw new IpcError("denied", `Ember couldn't show its notice on ${s.init.host}'s screen, so it won't use it.`);
    return {};
  }
  if (op === "policy") {
    const next = ChildPolicySchema.parse(raw);
    if (next.maxActionsPerMinute !== s.policy.maxActionsPerMinute) s.engine = engineFor(() => s.policy, next.maxActionsPerMinute);
    s.policy = next;
    return {};
  }
  if (s.paused) throw new IpcError("not_ready", "Ember stopped using this screen while the connection was silent.");
  const schema = (OP_SCHEMAS as Record<string, { args: { parse: (v: unknown) => unknown } }>)[op];
  if (!schema) throw new IpcError("unknown_op", `the desktop helper has no ${op}`);
  const a = schema.args.parse(raw) as never;
  switch (op) {
    case "perceive.read": {
      const r = a as OpArgs<"perceive.read">;
      const seen = await s.perception.read(targetOf(r.target), null, undefined, { ...(r.keep !== undefined ? { keep: r.keep } : {}), ...(r.cells ? { cells: r.cells } : {}) });
      remember(s, seen.window, seen.nodes.map(n => n.id));
      return wireSeen(seen);
    }
    case "perceive.focused": {
      const seen = await s.perception.focused();
      remember(s, seen.window, seen.nodes.map(n => n.id));
      return wireSeen(seen);
    }
    case "perceive.perceive": {
      const r = a as OpArgs<"perceive.perceive">;
      const image = r.image && s.policy.screenImages && !!s.ws;
      const p = await s.perception.perceive({ image, scope: r.scope, ...(r.target ? { target: targetOf(r.target) } : {}) });
      remember(s, p.window, p.nodes.map(n => n.id));
      const noShot = r.image && !image
        ? (s.ws ? "this computer's administrator doesn't allow pictures of its screen" : "screenshots aren't available on this display")
        : r.image && !p.capture ? noShotOf(p.text) ?? "Ember couldn't take a safe screenshot" : undefined;
      const c = p.capture;
      return {
        seen: wireSeen(p),
        image: c ? { png: c.data.toString("base64"), width: c.width, height: c.height, rect: c.rect, scale: c.scale } : null,
        ...(noShot ? { noShot } : {}),
      };
    }
    case "perceive.atPoint": {
      const r = a as OpArgs<"perceive.atPoint">;
      const chain = await s.perception.atPoint(targetOf(r.target), { x: r.x, y: r.y }, r.k);
      return { chain: chain ? chain.slice(0, CAPS.chain).map(wirePoint) : null };
    }
    case "perceive.windows":
      return { windows: (await s.perception.windows()).slice(0, CAPS.windows).map(wireWindow) };
    case "perceive.openWindows":
      return openWindows(s);
    case "perceive.systemDialog":
      return { open: await s.perception.systemDialogOpen() };
    case "ax.readElement": {
      const r = a as OpArgs<"ax.readElement">;
      return wireElementInfo(await s.sidecar.readElement(r.id, { ...(r.shown !== undefined ? { shown: r.shown } : {}), ...(r.formula !== undefined ? { formula: r.formula } : {}) }));
    }
    case "ax.canDo": {
      const r = a as OpArgs<"ax.canDo">;
      return wireCanDo(await s.sidecar.canDo(r.id, r.kind, r.caret));
    }
    case "ax.listOptions": {
      const r = a as OpArgs<"ax.listOptions">;
      const o = await s.sidecar.listOptions(r.id);
      return { options: o.options.slice(0, CAPS.options).map(x => cut(x, CAPS.str.name)), ...(typeof o.left === "number" ? { left: Math.max(0, Math.trunc(o.left)) } : {}) };
    }
    case "act":
      return act(s, rpc, a as OpArgs<"act">);
    case "apps.list":
      return { apps: listApps(process.env).flatMap(x => { const w = wireApp(x); return w ? [w] : []; }).slice(0, CAPS.nodes) };
    case "apps.launch":
      return launch(s, rpc, a as OpArgs<"apps.launch">);
    default:
      throw new IpcError("unknown_op", `the desktop helper has no ${op}`);
  }
}

/** Asks serve to write the step's audit entry (write-ahead), which also re-checks the link's epoch and freshness. */
async function audited(rpc: LineRpc, entry: AuditEntry, epoch: number): Promise<{ status: "ok" } | { status: "stopped" | "stale" } | { status: "deny"; reason: string }> {
  try {
    await rpc.request("audit", { entry, epoch }, 5000);
    return { status: "ok" };
  } catch (err) {
    if (err instanceof IpcError && (err.code === "stopped" || err.code === "stale")) return { status: err.code };
    return { status: "deny", reason: "This computer couldn't record the step, so Ember won't do it." };
  }
}

/** An accessibility action through gate 2 (§5.3.7). */
async function act(s: ChildState, rpc: LineRpc, a: OpArgs<"act">): Promise<unknown> {
  if (xLocked(s)) return { status: "deny", reason: `${s.init.host}'s screen is locked.` };
  const where = s.ids.get(a.id);
  const [element, window] = await Promise.all([
    s.sidecar.readElement(a.id).catch(() => null),
    where ? windowNow(s, where).catch(() => null) : Promise.resolve(null),
  ]);
  const { value, mode } = valueOf(a);
  const g = gateStep({
    stamp: a.stamp, op: a.op, ...(value !== undefined ? { value } : {}), ...(mode ? { mode } : {}),
    element, window: where ? window : null, actionsAllowed: s.policy.actionsAllowed, decide: r => s.engine.decide(r),
  });
  const base = { event: "action" as const, task: a.stamp.taskId, op: a.opId, kind: a.stamp.kind, app: window?.app ?? a.stamp.app, window: window?.title ?? a.stamp.window, element: a.stamp.element };
  if (g.status !== "ok") {
    rpc.request("audit", { entry: { ...base, event: "decision", verdict: g.status, ...("reason" in g ? { reason: g.reason } : {}) }, epoch: a.epoch }, 5000).catch(() => undefined);
    return g;
  }
  const w = await audited(rpc, { ...base, phase: "start", ...(value !== undefined ? { valueSha256: sha256Hex(value) } : {}) }, a.epoch);
  if (w.status !== "ok") return w;
  let result;
  try {
    if (a.op === "do_action") result = await s.sidecar.doAction(a.id, a.action);
    else if (a.op === "set_text") result = await s.sidecar.setText(a.id, a.text, a.mode);
    else if (a.op === "set_value") result = await s.sidecar.setValue(a.id, a.value);
    else result = await s.sidecar.selectOption(a.id, a.option);
  } catch (err) {
    rpc.request("audit", { entry: { ...base, phase: "end", ok: false, error: cut((err as Error).message, 300) }, epoch: a.epoch }, 5000).catch(() => undefined);
    throw new IpcError("internal", cut((err as Error).message, CAPS.str.reason));
  }
  rpc.request("audit", { entry: { ...base, phase: "end", ok: result.ok }, epoch: a.epoch }, 5000).catch(() => undefined);
  return { status: "ok", result: wireActionResult(result) };
}

/** Launching an app through gate 2: never a terminal, whatever the PC said. */
async function launch(s: ChildState, rpc: LineRpc, a: OpArgs<"apps.launch">): Promise<unknown> {
  if (xLocked(s)) return { status: "deny", reason: `${s.init.host}'s screen is locked.` };
  const app: DesktopApp | undefined = listApps(process.env).find(x => x.id === a.appId);
  if (!app) return { status: "changed" };
  if (isTerminalApp(app)) return { status: "deny", reason: "Ember doesn't open terminals or apps that run commands." };
  const g = gateStep({ stamp: a.stamp, op: "open_app", value: app.name, element: null, window: null, actionsAllowed: s.policy.actionsAllowed, decide: r => s.engine.decide(r) });
  const base = { event: "action" as const, task: a.stamp.taskId, kind: "open_app", app: app.name, value: app.id };
  if (g.status !== "ok") return g;
  const w = await audited(rpc, { ...base, phase: "start" }, a.epoch);
  if (w.status !== "ok") return w;
  try {
    launchApp(app);
  } catch (err) {
    return { status: "deny", reason: cut((err as Error).message, CAPS.str.reason) };
  }
  return { status: "ok" };
}

/** Runs the desktop child on this process's stdio until its stdin ends. */
export function runDesktopChild(log: Logger): void {
  let state: ChildState | null = null;
  let rpc: LineRpc | null = null;
  const stopAll = () => {
    state?.notice.close();
    state?.sidecar.stop();
    state?.ws?.close();
    state?.xinput?.close();
    state = null;
  };
  rpc = lineRpc({
    input: process.stdin,
    output: process.stdout,
    log,
    onEvent: () => { /* serve sends no events */ },
    onClose: why => {
      log.info("remote.desktop_child_closing", { why });
      stopAll();
      // Its children (the sidecar, the notice) see their stdin end and go too.
      setTimeout(() => process.exit(0), 50);
    },
    onRequest: async (op, a) => {
      if (op === "init") {
        if (state) throw new IpcError("bad_request", "already started");
        const r = await start(InitArgsSchema.parse(a), log, () => rpc?.event("stop", {}), why => rpc?.event("gone", { why }));
        state = r.state;
        return r.result;
      }
      if (!state) throw new IpcError("not_ready", "the desktop helper hasn't started");
      return handle(state, rpc!, op, a);
    },
  });
  // A broken pipe to serve means serve is gone.
  process.stdout.on("error", () => rpc?.close("serve went away"));
}
