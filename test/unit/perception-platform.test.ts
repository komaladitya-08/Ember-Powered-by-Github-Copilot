import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureRect, imageToScreen } from "../../app/main/perception/capture";
import { Perception, type PerceptionOptions } from "../../app/main/perception";
import { isSecurityWindow } from "../../app/main/policy/policy";
import { PLATFORM_WORDS } from "../../app/shared/words";
import type { AtspiSidecar, AxNode, AxWindow, Bounds, ShellOverlay } from "../../app/main/perception/sidecar";
import type { PerceptionWindows, StackedWindow, X11Image, X11Window } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";

type Win = X11Window & { wmClass: string; wmClassName?: string };

/** A logger that keeps its warnings (the event names only). */
function recordingLog(): { log: Logger; warnings: string[]; infos: [string, unknown][] } {
  const warnings: string[] = [];
  const infos: [string, unknown][] = [];
  const log = { debug() {}, info(event: string, fields?: unknown) { infos.push([event, fields]); }, warn(event: string) { warnings.push(event); }, error() {}, child() { return log; } } as unknown as Logger;
  return { log, warnings, infos };
}

const top = (id: number, pid: number | null, r: Bounds, title = "", wmClass = "app"): StackedWindow =>
  ({ id, client: id, pid, title, wmClass, ...r, outer: r, inner: r, overrideRedirect: false });
const win = (id: number, pid: number | null, title: string, wmClass: string, wmClassName?: string): Win =>
  ({ id, pid, title, wmClass, x: 0, y: 0, width: 100, height: 100, ...(wmClassName ? { wmClassName } : {}) });
const axWin = (app: string, pid: number | null, name: string, bounds: Bounds | null = { x: 0, y: 0, width: 100, height: 100 }): AxWindow =>
  ({ app, pid, name, role: "frame", active: true, bounds });

const later = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The screen as a window system's capture sees it: a grey picture of `screen` (which may start left of or above 0,0),
 * clipped to it as every backend's capture is.
 */
function greyImage(screen: Bounds, x: number, y: number, width: number, height: number): X11Image | null {
  const x0 = Math.max(screen.x, x), y0 = Math.max(screen.y, y);
  const x1 = Math.min(screen.x + screen.width, x + width), y1 = Math.min(screen.y + screen.height, y + height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, bgra: Buffer.alloc((x1 - x0) * (y1 - y0) * 4, 200) };
}

async function pixel(data: Buffer, x: number, y: number): Promise<number[]> {
  const { data: raw, info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [raw[i], raw[i + 1], raw[i + 2]];
}

const isBlack = (p: number[]) => p.every(c => c < 40);
const isGrey = (p: number[]) => p.every(c => c > 160 && c < 240);

/**
 * A pretend desktop behind the platform contract: the accessibility sidecar's answers, and a window system with an
 * optional systemDialogOpen (absent, as on Linux, unless given).
 */
function desktop(o: {
  window?: AxWindow | null; nodes?: AxNode[]; listed?: AxWindow[];
  shell?: { overlays: ShellOverlay[]; complete?: boolean } | Error;
  stack?: StackedWindow[]; active?: Win | null; focus?: Win | null; clients?: Win[];
  capture?: PerceptionWindows["capture"]; systemDialogOpen?: () => boolean;
  screen?: Bounds; neverLook?: string[];
  screenRecording?: () => boolean;
  secretFields?: (w: { pid: number; path: string }) => { fields: { id: number; bounds: Bounds }[]; complete: boolean; busy?: boolean };
} & Pick<PerceptionOptions, "words" | "isSecurityWindow" | "hideOverlay" | "onNoScreenAccess">) {
  const screen = o.screen ?? { x: 0, y: 0, width: 300, height: 200 };
  const captures: number[][] = [];
  let shellAsked = 0;
  const sidecar = {
    readWindow: async () => ({ window: o.window ?? null, nodes: o.window ? o.nodes ?? [] : [], ms: 1 }),
    listWindows: async () => ({ windows: o.listed ?? [] }),
    scaleElements: () => undefined,
    markSecret: async () => undefined,
    readElement: async (id: number) => ({ role: "text", name: "", states: [], bounds: o.nodes?.find(n => n.id === id)?.bounds ?? null }),
    shellOverlays: async () => {
      shellAsked++;
      if (o.shell instanceof Error) throw o.shell;
      return o.shell ?? { overlays: [] };
    },
    secretFields: async (w: { pid: number; path: string }) => ({ ms: 1, ...(o.secretFields ? o.secretFields(w) : { fields: [], complete: true }) }),
  } as unknown as AtspiSidecar;
  const ws: NonNullable<PerceptionOptions["x11"]> = {
    stack: () => o.stack ?? [],
    activeWindow: () => o.active ?? null,
    focusWindow: () => o.focus ?? null,
    clientWindows: () => o.clients ?? [],
    ...(o.screenRecording ? { screenRecording: o.screenRecording } : {}),
    capture: (x, y, width, height) => {
      captures.push([x, y, width, height]);
      return (o.capture ?? ((cx, cy, cw, ch) => greyImage(screen, cx, cy, cw, ch)))(x, y, width, height);
    },
    ...(o.systemDialogOpen ? { systemDialogOpen: o.systemDialogOpen } : {}),
  };
  const { log, warnings, infos } = recordingLog();
  const perception = new Perception({
    sidecar, x11: ws, log, neverLook: () => o.neverLook ?? [], screenBounds: () => screen, ownPid: 999,
    ...(o.words ? { words: o.words } : {}), ...(o.isSecurityWindow ? { isSecurityWindow: o.isSecurityWindow } : {}),
    ...(o.hideOverlay ? { hideOverlay: o.hideOverlay } : {}), ...(o.onNoScreenAccess ? { onNoScreenAccess: o.onNoScreenAccess } : {}),
  });
  return { perception, captures, warnings, infos, shellAsked: () => shellAsked };
}

const gedit = axWin("gedit", 42, "notes.txt", { x: 10, y: 10, width: 100, height: 100 });
const NO_DIALOG = "(No screenshot: a system dialog is open, so Ember looks away until it's done.)";

describe("captureRect with an asynchronous capture (macOS desktopCapturer)", () => {
  it("keeps Ember hidden until the pixels are in, and shows it again right after", async () => {
    const events: string[] = [];
    let hidden = false;
    const c = await captureRect({
      capture: async (x, y, w, h) => {
        events.push(hidden ? "capture while hidden" : "capture while shown");
        await later(30);
        events.push(hidden ? "pixels while hidden" : "pixels while shown");
        return greyImage({ x: 0, y: 0, width: 100, height: 100 }, x, y, w, h);
      },
    }, { x: 0, y: 0, width: 50, height: 50 }, {
      hideOverlay: async () => { hidden = true; events.push("hidden"); return () => { hidden = false; events.push("shown"); }; },
    });
    expect(c?.rect).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(events).toEqual(["hidden", "capture while hidden", "pixels while hidden", "shown"]);
  });

  it("shows Ember again when the capture fails, and passes the failure on", async () => {
    let shows = 0;
    const failing = captureRect({ capture: () => Promise.reject(new Error("capture failed")) }, { x: 0, y: 0, width: 10, height: 10 }, {
      hideOverlay: async () => () => { shows++; },
    });
    await expect(failing).rejects.toThrow("capture failed");
    expect(shows).toBe(1);
  });

  it("gives nothing when the capture has no picture, with Ember shown again", async () => {
    let shows = 0;
    const c = await captureRect({ capture: async () => null }, { x: 0, y: 0, width: 10, height: 10 }, { hideOverlay: async () => () => { shows++; } });
    expect(c).toBeNull();
    expect(shows).toBe(1);
  });

  it("asks what else to black out only once Ember shows again and the pixels are in", async () => {
    const events: string[] = [];
    await captureRect({
      capture: async (x, y, w, h) => { await later(10); events.push("pixels"); return greyImage({ x: 0, y: 0, width: 100, height: 100 }, x, y, w, h); },
    }, { x: 0, y: 0, width: 20, height: 20 }, {
      hideOverlay: async () => () => { events.push("shown"); },
      maskAfter: async () => { events.push("mask after"); return []; },
    });
    expect(events).toEqual(["pixels", "shown", "mask after"]);
  });

  it("doesn't wait on a synchronous capture (X11, GDI): Ember shows again before anything else queued runs", async () => {
    const events: string[] = [];
    await captureRect({
      capture: (x, y, w, h) => {
        queueMicrotask(() => events.push("queued work"));
        events.push("pixels");
        return greyImage({ x: 0, y: 0, width: 100, height: 100 }, x, y, w, h);
      },
    }, { x: 0, y: 0, width: 20, height: 20 }, { hideOverlay: async () => () => { events.push("shown"); } });
    expect(events).toEqual(["pixels", "shown", "queued work"]);
  });

  it("keeps a picture that starts left of and above the primary display where it is, masks included", async () => {
    // A monitor left of and above the primary one (Windows, macOS): the virtual screen starts at -200,-100.
    const screen = { x: -200, y: -100, width: 500, height: 300 };
    const c = await captureRect({ capture: async (x, y, w, h) => { await later(5); return greyImage(screen, x, y, w, h); } },
      { x: -250, y: -100, width: 300, height: 200 }, {
        format: "png",
        mask: [{ x: -150, y: -50, width: 20, height: 20 }],
        maskAfter: async () => [{ x: 0, y: 0, width: 10, height: 10 }],
      });
    // Clipped to the virtual screen, which starts at -200: the origin stays negative.
    expect(c?.rect).toEqual({ x: -200, y: -100, width: 250, height: 200 });
    expect(c!.rect.x).toBeLessThan(0);
    // Screen -150,-50 is image 50,50; screen 0,0 is image 200,100.
    expect(await pixel(c!.data, 50, 50)).toEqual([0, 0, 0]);
    expect(await pixel(c!.data, 69, 69)).toEqual([0, 0, 0]);
    expect(await pixel(c!.data, 205, 105)).toEqual([0, 0, 0]);
    expect(await pixel(c!.data, 49, 49)).toEqual([200, 200, 200]);
    expect(await pixel(c!.data, 70, 70)).toEqual([200, 200, 200]);
    expect(await pixel(c!.data, 0, 0)).toEqual([200, 200, 200]);
    // And back: an image point maps to the negative screen point it shows.
    expect(imageToScreen(c!, { x: 50, y: 50 })).toEqual({ x: -150, y: -50 });
  });
});

describe("Perception's screenshots with an asynchronous capture", () => {
  it("keeps Ember hidden until the capture resolves", async () => {
    let hidden = false;
    const seen: boolean[] = [];
    const screen = { x: 0, y: 0, width: 300, height: 200 };
    const { perception } = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"),
      capture: async (x, y, w, h) => { seen.push(hidden); await later(30); seen.push(hidden); return greyImage(screen, x, y, w, h); },
      hideOverlay: async () => { hidden = true; return () => { hidden = false; }; },
    });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).not.toBeNull();
    expect(seen).toEqual([true, true]);
    expect(hidden).toBe(false);
  });

  /** One scene (a sign-in window, a never-look window, a password field and a button), moved by `dx`, `dy`. */
  const scene = (dx: number, dy: number) => {
    const at = (b: Bounds): Bounds => ({ ...b, x: b.x + dx, y: b.y + dy });
    const screen = at({ x: -400, y: -100, width: 800, height: 300 });
    const nodes: AxNode[] = [
      { id: 1, parent: null, depth: 0, role: "password text", name: "Password", states: ["enabled"], bounds: at({ x: -200, y: -50, width: 30, height: 10 }), secret: true },
      { id: 2, parent: null, depth: 0, role: "push button", name: "Sign in", states: ["enabled"], bounds: at({ x: 100, y: 120, width: 60, height: 20 }) },
    ];
    const frame = at({ x: -300, y: -90, width: 600, height: 280 });
    return desktop({
      screen, window: axWin("Bank", 42, "Sign in", frame), nodes, active: win(5, 42, "Sign in", "bank"), neverLook: ["keepassxc"],
      stack: [top(5, 42, frame, "Sign in", "bank"), top(6, 7, at({ x: -390, y: -80, width: 40, height: 40 }), "vault", "keepassxc")],
      capture: async (x, y, w, h) => { await later(5); return greyImage(screen, x, y, w, h); },
    });
  };

  it("captures a virtual screen with a negative origin, and blacks out private windows and secret fields where they are", async () => {
    const { perception, captures } = scene(0, 0);
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(captures).toEqual([[-400, -100, 800, 300]]);
    expect(p.capture?.rect).toEqual({ x: -400, y: -100, width: 800, height: 300 });
    expect(p.capture!.scale).toBe(1);
    const at = (x: number, y: number) => pixel(p.capture!.data, x + 400, y + 100);
    // The never-look window (screen -390,-80, 40 px) and the padded password field (screen -203,-53 to -167,-37).
    expect(isBlack(await at(-370, -60))).toBe(true);
    expect(isBlack(await at(-185, -45))).toBe(true);
    expect(isGrey(await at(-330, -60))).toBe(true);
    expect(isGrey(await at(-185, -20))).toBe(true);
    expect(p.text).toContain("[2]");
  });

  it("draws the same picture, masks and marks included, as for the same screen at a positive origin", async () => {
    const negative = await scene(0, 0).perception.perceive({ image: true, scope: "screen" });
    const positive = await scene(400, 100).perception.perceive({ image: true, scope: "screen" });
    expect(positive.capture?.rect).toEqual({ x: 0, y: 0, width: 800, height: 300 });
    expect(negative.capture!.data.equals(positive.capture!.data)).toBe(true);
    // The button's mark is in it: its orange label sits right above the button (screen 100,106 to 113,120).
    const { data: raw, info } = await sharp(negative.capture!.data).raw().toBuffer({ resolveWithObject: true });
    let orange = 0;
    for (let y = 206; y < 220; y++) for (let x = 500; x < 513; x++) {
      const i = (y * info.width + x) * info.channels;
      if (raw[i] > 200 && raw[i + 2] < 120) orange++;
    }
    expect(orange).toBeGreaterThan(20);
  });
});

describe("Perception and the window system's system-dialog check (fails closed)", () => {
  it("takes no screenshot while the window system reports a system dialog", async () => {
    const { perception, captures } = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), systemDialogOpen: () => true });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).toBeNull();
    expect(p.text).toContain(NO_DIALOG);
    expect(captures).toEqual([]);
  });

  it("takes no screenshot when the check itself fails, and says so in the log", async () => {
    const { perception, captures, warnings } = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"), systemDialogOpen: () => { throw new Error("OpenInputDesktop failed"); },
    });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(p.capture).toBeNull();
    expect(p.text).toContain(NO_DIALOG);
    expect(captures).toEqual([]);
    expect(warnings).toContain("perception.system_dialog_check_failed");
  });

  it("sends no picture when a system dialog comes up while it is taken, and shows Ember again", async () => {
    let dialog = false, shows = 0;
    const screen = { x: 0, y: 0, width: 300, height: 200 };
    const { perception, captures } = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"), systemDialogOpen: () => dialog,
      capture: async (x, y, w, h) => { await later(10); dialog = true; return greyImage(screen, x, y, w, h); },
      hideOverlay: async () => () => { shows++; },
    });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(captures).toHaveLength(1);
    expect(p.capture).toBeNull();
    expect(p.text).toContain(NO_DIALOG);
    expect(shows).toBe(1);
  });

  it("sends no picture when the check fails once the picture is taken", async () => {
    let asked = 0;
    const { perception, captures, warnings } = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"),
      systemDialogOpen: () => { if (++asked > 1) throw new Error("CGWindowListCopyWindowInfo failed"); return false; },
    });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(captures).toHaveLength(1);
    expect(p.capture).toBeNull();
    expect(p.text).toContain(NO_DIALOG);
    expect(warnings).toContain("perception.system_dialog_check_failed");
  });

  it("takes the screenshot when the window system reports no dialog, or has no such check (Linux)", async () => {
    const clear = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), systemDialogOpen: () => false });
    expect((await clear.perception.perceive({ image: true, scope: "screen" })).capture).not.toBeNull();
    const linux = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit") });
    expect((await linux.perception.perceive({ image: true, scope: "screen" })).capture).not.toBeNull();
    expect(linux.warnings).toEqual([]);
  });

  it("counts the window system's dialog and GNOME Shell's alike when asked whether one is open", async () => {
    const dialog: ShellOverlay = { role: "dialog", name: "Authentication required", text: "", bounds: null };
    expect(await desktop({}).perception.systemDialogOpen()).toBe(false);
    expect(await desktop({ systemDialogOpen: () => false }).perception.systemDialogOpen()).toBe(false);
    expect(await desktop({ systemDialogOpen: () => true }).perception.systemDialogOpen()).toBe(true);
    expect(await desktop({ shell: { overlays: [dialog] }, systemDialogOpen: () => false }).perception.systemDialogOpen()).toBe(true);
    expect(await desktop({ shell: { overlays: [], complete: false } }).perception.systemDialogOpen()).toBe(true);
    const failing = desktop({ systemDialogOpen: () => { throw new Error("gone"); } });
    expect(await failing.perception.systemDialogOpen()).toBe(true);
    expect(failing.warnings).toContain("perception.system_dialog_check_failed");
    // GNOME Shell's check stays best effort, as before; the window system's answer still counts.
    expect(await desktop({ shell: new Error("no shell"), systemDialogOpen: () => false }).perception.systemDialogOpen()).toBe(false);
    expect(await desktop({ shell: new Error("no shell"), systemDialogOpen: () => true }).perception.systemDialogOpen()).toBe(true);
  });
});

describe("Perception's words for each OS", () => {
  const unchecked = { overlays: [], complete: false };
  const overview = { overlays: [{ role: "overview", name: "", text: "", bounds: null }] };
  const shot = async (shell: { overlays: ShellOverlay[]; complete?: boolean }, words?: PerceptionOptions["words"]) =>
    (await desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), shell, words }).perception.perceive({ image: true, scope: "screen" })).text;

  it("keeps today's GNOME words by default", async () => {
    expect(await shot(unchecked)).toContain("(No screenshot: GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment.)");
    expect(await shot(overview)).toContain("(No screenshot: the Activities overview or the window switcher is open (it shows every window), so Ember looks away until it's closed.)");
  });

  it("names Windows' and macOS's own surfaces there", async () => {
    for (const os of ["win32", "darwin"] as const) {
      const text = await shot(unchecked, PLATFORM_WORDS[os]);
      expect(text).toContain(`(No screenshot: ${PLATFORM_WORDS[os].shellUnchecked}.)`);
      expect(text).not.toContain("GNOME");
      expect(await shot(overview, PLATFORM_WORDS[os])).toContain(`(No screenshot: ${PLATFORM_WORDS[os].overviewOpen}.)`);
    }
    expect(await shot(overview, PLATFORM_WORDS.win32)).toContain("Task View");
    expect(await shot(overview, PLATFORM_WORDS.darwin)).toContain("Mission Control");
  });
});

describe("Perception with the OS's security-window check", () => {
  /** Windows' vocabulary as a fake: none of it is a Linux security window. */
  const windowsSecurity = (w: { app?: string; title?: string; name?: string }) =>
    /^(credentialuibroker|consent|credential dialog xaml host)$/i.test((w.app ?? "").trim()) || /^windows security$/i.test((w.title ?? w.name ?? "").trim());

  it("uses a vocabulary the Linux check doesn't know (so these cases prove the injected one is asked)", () => {
    for (const w of [{ app: "CredentialUIBroker" }, { app: "consent" }, { app: "Credential Dialog Xaml Host" }, { title: "Windows Security" }]) {
      expect(isSecurityWindow(w)).toBe(false);
      expect(windowsSecurity(w)).toBe(true);
    }
  });

  it("looks away from a credential prompt it is asked to read (isPrivate)", async () => {
    const prompt = axWin("CredentialUIBroker", 42, "Sign in to your account");
    const injected = await desktop({ window: prompt, isSecurityWindow: windowsSecurity }).perception.read({ pid: 42 });
    expect(injected.blocked).toBe(true);
    expect(injected.window?.name).toBe("");
    expect((await desktop({ window: prompt }).perception.read({ pid: 42 })).blocked).toBe(false);
    // Known by its window system's program name too, when accessibility names another app.
    const consent = { window: axWin("explorer", 43, "User Account Control"), active: win(9, 43, "User Account Control", "consent") };
    expect((await desktop({ ...consent, isSecurityWindow: windowsSecurity }).perception.focused()).blocked).toBe(true);
    expect((await desktop(consent).perception.focused()).blocked).toBe(false);
  });

  const quick = async (clients: Win[], check?: PerceptionOptions["isSecurityWindow"]) =>
    (await desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit gedit"), clients, isSecurityWindow: check }).perception.quickContext())!.text;

  it("leaves a security window out of the open-window lines, by its program and title", async () => {
    const clients = [win(5, 42, "notes.txt", "gedit gedit"), win(6, 50, "Windows Security", "explorer")];
    expect(await quick(clients, windowsSecurity)).not.toContain("Windows Security");
    expect(await quick(clients, windowsSecurity)).toContain("notes.txt");
    expect(await quick(clients)).toContain("Windows Security");
  });

  it("leaves a security window out of the open-window lines, by its window class alone", async () => {
    const clients = [win(5, 42, "notes.txt", "gedit gedit"), win(7, 51, "Sign in", "explorer", "Credential Dialog Xaml Host")];
    expect(await quick(clients, windowsSecurity)).not.toContain("Sign in");
    expect(await quick(clients)).toContain("Sign in");
  });

  it("takes no screenshot while a security window has the keyboard", async () => {
    const o = { window: gedit, active: win(5, 42, "notes.txt", "gedit"), focus: win(8, 60, "", "credentialuibroker") };
    const injected = await desktop({ ...o, isSecurityWindow: windowsSecurity }).perception.perceive({ image: true, scope: "screen", target: { pid: 42 } });
    expect(injected.capture).toBeNull();
    expect(injected.text).toContain("(No screenshot: a password prompt is open, so Ember looks away until it's done.)");
    expect((await desktop(o).perception.perceive({ image: true, scope: "screen", target: { pid: 42 } })).capture).not.toBeNull();
  });

  it("leaves security windows out of the window list, by their accessible app or their window's program", async () => {
    const b = { x: 300, y: 0, width: 200, height: 150 };
    const listed = [axWin("CredentialUIBroker", 7, "Windows Security"), axWin("explorer", 8, "User Account Control", b), axWin("gedit", 42, "notes.txt", { x: 0, y: 200, width: 300, height: 100 })];
    const stack = [top(3, 8, b, "User Account Control", "consent")];
    const injected = await desktop({ listed, stack, isSecurityWindow: windowsSecurity }).perception.windows();
    expect(injected.map(w => w.name)).toEqual(["notes.txt"]);
    expect((await desktop({ listed, stack }).perception.windows()).map(w => w.name)).toEqual(["Windows Security", "User Account Control", "notes.txt"]);
  });
});

describe("Perception's window screenshots when the window can't be found", () => {
  // review #5: the window asked for has closed, never matched, or its app is hung (the read has no window). Its picture
  // must not become a picture of the whole screen, which no secret-field check has looked through.
  it("takes no picture at all, not one of the whole screen", async () => {
    const { perception, captures, shellAsked } = desktop({ window: null, stack: [top(5, 42, { x: 10, y: 10, width: 100, height: 100 }, "notes.txt", "gedit")] });
    const p = await perception.perceive({ image: true, scope: "window", target: { pid: 42, title: "gone" } });
    expect(p.capture).toBeNull();
    expect(captures).toEqual([]);
    expect(shellAsked()).toBe(0);
    // One plain sentence: nothing says "use the screenshot" or "the focused window" (a window was named).
    expect(p.text).toBe("That window can't be found (it may have closed, or its app isn't answering).");
  });

  it("says the app is busy when it is, and Ember's own window when the user is in one", async () => {
    const busy = desktop({ window: null, stack: [top(5, 42, { x: 10, y: 10, width: 100, height: 100 }, "notes.txt", "gedit")] });
    const seen = { window: null, x11Window: null, nodes: [], blocked: false, busy: true, truncated: null, others: [], ms: 1, axScale: 1 };
    busy.perception.read = async () => seen;
    const b = await busy.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(b.capture).toBeNull();
    expect(b.text).toBe("The app is busy and didn't answer (it may be loading something). Try again in a moment.\n(No screenshot: the app isn't answering.)");
    busy.perception.read = async () => ({ ...seen, busy: false, ember: true });
    const own = await busy.perception.perceive({ image: true, scope: "window", target: { pid: 42 } });
    expect(own.text).toContain("(No screenshot: Ember takes no pictures of its own windows.)");
    expect(busy.captures).toEqual([]);
  });

  it("still takes a picture of the whole screen when that is what was asked for", async () => {
    const { perception, captures } = desktop({ window: null });
    const p = await perception.perceive({ image: true, scope: "screen", target: { pid: 42 } });
    expect(p.capture).not.toBeNull();
    expect(captures).toEqual([[0, 0, 300, 200]]);
  });

  it("takes a window's picture as before when the window system knows the window the user is in", async () => {
    // No accessibility, but the window system's active window: its picture is still a window's.
    const active = win(5, 42, "notes.txt", "gedit");
    const { perception, captures } = desktop({ window: null, active, stack: [top(5, 42, { x: 10, y: 10, width: 100, height: 100 }, "notes.txt", "gedit")] });
    const p = await perception.perceive({ image: true, scope: "window" });
    expect(p.capture?.rect).toEqual({ x: 10, y: 10, width: 100, height: 100 });
    expect(captures).toEqual([[10, 10, 100, 100]]);
  });
});

describe("Perception without the screen-capture permission (macOS Screen Recording)", () => {
  // reviews #96, #237: macOS gives no picture without Screen Recording; the note must say so, not "off screen".
  const NO_ACCESS = `(No screenshot: ${PLATFORM_WORDS.darwin.noScreenAccess}.)`;

  it("says the permission is missing, names where to allow it, and captures nothing", async () => {
    const { perception, captures } = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), stack: [top(5, 42, gedit.bounds!, "notes.txt", "gedit")], screenRecording: () => false, words: PLATFORM_WORDS.darwin });
    for (const scope of ["window", "screen"] as const) {
      const p = await perception.perceive({ image: true, scope });
      expect(p.capture).toBeNull();
      expect(p.text).toContain(NO_ACCESS);
      expect(p.text).not.toContain("off screen");
    }
    expect(captures).toEqual([]);
    expect(PLATFORM_WORDS.darwin.noScreenAccess).toContain("System Settings › Privacy & Security › Screen Recording");
  });

  it("says so when the permission goes while the picture is taken", async () => {
    let allowed = true;
    const { perception, captures } = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"), screenRecording: () => allowed, words: PLATFORM_WORDS.darwin,
      capture: () => { allowed = false; return null; },
    });
    const p = await perception.perceive({ image: true, scope: "screen" });
    expect(captures).toHaveLength(1);
    expect(p.text).toContain(NO_ACCESS);
  });

  it("captures as before when the permission is there, or the window system has no such permission (Linux, Windows)", async () => {
    const mac = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), screenRecording: () => true, words: PLATFORM_WORDS.darwin });
    expect((await mac.perception.perceive({ image: true, scope: "screen" })).capture).not.toBeNull();
    const linux = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit") });
    expect((await linux.perception.perceive({ image: true, scope: "screen" })).capture).not.toBeNull();
    // A failed capture elsewhere keeps today's words.
    const off = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), capture: () => null });
    expect((await off.perception.perceive({ image: true, scope: "screen" })).text).toContain("(No screenshot: the window is off screen, or the screen couldn't be captured safely.)");
  });

  it("tells Ember the first time a run, so it can offer the setting (refused before the picture or while it was taken)", async () => {
    let told = 0;
    let allowed = false;
    const { perception } = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"), screenRecording: () => allowed, words: PLATFORM_WORDS.darwin,
      capture: () => { allowed = false; return null; }, onNoScreenAccess: () => { told++; },
    });
    await perception.perceive({ image: true, scope: "screen" });
    expect(told).toBe(1);
    allowed = true; // taken back while the picture is taken: said in the text, but Ember was told already
    expect((await perception.perceive({ image: true, scope: "screen" })).text).toContain(NO_ACCESS);
    expect(told).toBe(1);
    // Taken back while the picture is taken, first in a run; a failing notice changes nothing.
    let once = 0;
    allowed = true;
    const late = desktop({
      window: gedit, active: win(5, 42, "notes.txt", "gedit"), screenRecording: () => allowed, words: PLATFORM_WORDS.darwin,
      capture: () => { allowed = false; return null; }, onNoScreenAccess: () => { once++; throw new Error("no overlay"); },
    });
    expect((await late.perception.perceive({ image: true, scope: "screen" })).text).toContain(NO_ACCESS);
    expect(once).toBe(1);
    // A capture that fails with the permission there tells nothing.
    let never = 0;
    const off = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), screenRecording: () => true, capture: () => null, onNoScreenAccess: () => { never++; } });
    await off.perception.perceive({ image: true, scope: "screen" });
    expect(never).toBe(0);
  });

  it("captures when the permission check itself fails: the capture asks again and fails closed", async () => {
    const { perception, captures } = desktop({ window: gedit, active: win(5, 42, "notes.txt", "gedit"), screenRecording: () => { throw new Error("gone"); }, words: PLATFORM_WORDS.darwin });
    await perception.perceive({ image: true, scope: "screen" });
    expect(captures).toHaveLength(1);
  });
});

describe("Perception's read of a page the browser hasn't handed over yet (review #6)", () => {
  // The sidecar says "loading" when a web document shows with neither contents nor size: the read must not pass for a
  // complete window that has only a menu bar.
  it("says the page is still loading, not that the window is complete or nested too deeply", async () => {
    const nodes: AxNode[] = [
      { id: 1, parent: null, depth: 0, role: "frame", name: "Big page - Browser", states: ["active"], bounds: { x: 10, y: 10, width: 100, height: 100 } },
      { id: 2, parent: 1, depth: 1, role: "menu bar", name: "", states: [], bounds: { x: 10, y: 10, width: 100, height: 20 } },
    ];
    const sidecar = {
      readWindow: async () => ({ window: gedit, nodes, truncated: true, cut: ["loading"], ms: 1 }),
      listWindows: async () => ({ windows: [] }),
      scaleElements: () => undefined,
      markSecret: async () => undefined,
      shellOverlays: async () => ({ overlays: [] }),
    } as unknown as AtspiSidecar;
    const p = new Perception({ sidecar, x11: null, log: recordingLog().log, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 300, height: 200 }), ownPid: 999 });
    const seen = await p.read({ pid: 42 });
    expect(seen.truncated).toBe("loading");
    const text = (await p.perceive({ image: false, scope: "window", target: { pid: 42 } })).text;
    expect(text).toContain("(The page is still loading, so its content isn't listed yet. Try again in a moment.)");
    expect(text).not.toContain("nested too deeply");
    expect(await p.describe()).toContain("(The page is still loading");
  });
});

describe("the app's own popups in its window's picture (review #7)", () => {
  // Menus, lists, completion and autofill panels are popups of the app (override-redirect): they are part of what a
  // window's picture shows, so the secret fields in them are blacked out like the window's own.
  const frame = { x: 10, y: 10, width: 200, height: 150 };
  const popupAt = { x: 50, y: 50, width: 120, height: 80 };
  const popup: StackedWindow = { ...top(6, 42, popupAt, ""), overrideRedirect: true };
  const window = { ...axWin("gedit", 42, "notes.txt", frame), path: "/w/1" };
  const popupWin = { ...axWin("gedit", 42, "", popupAt), role: "window", path: "/w/2", active: false };
  const card = { id: 9, bounds: { x: 60, y: 60, width: 100, height: 20 } };
  const shot = async (o: Parameters<typeof desktop>[0]) => {
    const d = desktop({ window, active: win(5, 42, "notes.txt", "gedit"), stack: [top(5, 42, frame, "notes.txt", "gedit"), popup], ...o });
    const p = await d.perception.perceive({ image: true, scope: "window" });
    return { p, at: async (x: number, y: number) => pixel(p.capture!.data, x - frame.x, y - frame.y) };
  };

  it("blacks out a secret field in a popup over the window, and shows the rest of it", async () => {
    const { p, at } = await shot({ listed: [window, popupWin], secretFields: w => ({ fields: w.path === "/w/2" ? [card] : [], complete: true }) });
    expect(p.capture).not.toBeNull();
    expect(isBlack(await at(110, 70))).toBe(true);
    expect(isGrey(await at(110, 120))).toBe(true);
    expect(isGrey(await at(30, 30))).toBe(true);
  });

  it("blacks out the whole popup when it can't be looked through, and says so", async () => {
    for (const fields of [() => ({ fields: [], complete: false }), () => { throw new Error("gone"); }]) {
      const { p, at } = await shot({ listed: [window, popupWin], secretFields: w => (w.path === "/w/2" ? fields() : { fields: [], complete: true }) });
      expect(isBlack(await at(110, 120))).toBe(true);
      expect(isGrey(await at(30, 30))).toBe(true);
      expect(p.text).toContain("(Screenshot: a popup Ember couldn't check for password fields is hidden.)");
    }
  });

  it("leaves a popup accessibility doesn't list as a window as it was (a menu on macOS, a shadow on Windows)", async () => {
    const { p, at } = await shot({ listed: [window] });
    expect(isGrey(await at(110, 120))).toBe(true);
    expect(p.text).not.toContain("popup");
  });

  it("logs such a popup, once a run for each app and size, so CI and the field show which popups go unscanned", async () => {
    const d = desktop({ window, active: win(5, 42, "notes.txt", "gedit"), stack: [top(5, 42, frame, "notes.txt", "gedit"), { ...popup, wmClass: "gedit" }], listed: [window] });
    await d.perception.perceive({ image: true, scope: "window" });
    await d.perception.perceive({ image: true, scope: "window" });
    // With the OS: the field's logs come from all three, and each OS lists different popups as windows.
    expect(d.infos.filter(([e]) => e === "perception.popup_unmatched")).toEqual([["perception.popup_unmatched", { app: "gedit", width: 120, height: 80, os: process.platform }]]);
    // A popup that was looked through isn't.
    const listed = desktop({ window, active: win(5, 42, "notes.txt", "gedit"), stack: [top(5, 42, frame, "notes.txt", "gedit"), popup], listed: [window, popupWin] });
    await listed.perception.perceive({ image: true, scope: "window" });
    expect(listed.infos.some(([e]) => e === "perception.popup_unmatched")).toBe(false);
  });
});
