/**
 * The macOS window system and input backends on a real Mac, against TextEdit with a fresh plain-text file in a
 * temporary folder: TextEdit's window is in the stack with its process and app name, activation from this process
 * (which has no UI) brings it to the front from behind Finder (through LaunchServices when macOS declines a
 * background activation), text typed with textKey (whatever the layout) arrives (read back over AX), Command+S
 * pressed by keysym saves it, the pointer follows a move, and nothing stays pressed.
 * Without the Accessibility permission only the checks that need none run; with EMBER_DARWIN_TEST=1 the suite fails
 * instead of skipping (off macOS, without the backends, or without the permission), printing which binary needs the
 * grant so CI learns which client TCC wanted.
 *
 * It also records the evidence the design leaves to CI: the permission answers (Input Monitoring, posting, Screen
 * Recording), the input source, whether secure input can be read, that no security prompt is up at rest, the median
 * cost of a borrow's polling calls, and whether a key another process posts shows in keysDown() (Input Monitoring
 * may gate it: design §8.5, Q10). When TextEdit's window doesn't show up, it prints every window of TextEdit's
 * process (on screen or not, any layer), what AX sees of the app and what is on screen, nudges it (unhide, open the
 * file again, and as a last resort an untitled document, with a warning) and fails with that report after 45 s.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import {
  INPUT_MONITORING_REASON, openDarwinInput, openDarwinWindows, darwinInputError, darwinWindowsError, type DarwinInput,
  type DarwinWindowSystem,
} from "../../app/main/platform/darwin";
import { openCoreFoundation } from "../../app/main/platform/darwin/cf";
import { openCoreGraphics, rectOf, type CGRect } from "../../app/main/platform/darwin/cg";
import { openAX } from "../../app/main/platform/darwin/ax";
import { openDesktop, type DarwinDesktop } from "../../app/main/platform/darwin/desktop";
import { hiToolboxMissing } from "../../app/main/platform/darwin/hitoolbox";
import { SECURITY_OWNERS } from "../../app/main/platform/darwin/model";

const required = process.env.EMBER_DARWIN_TEST === "1";
const onMac = process.platform === "darwin";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TEXT = "Ember 1é";
/** kVK_F13: no system action is bound to it, so a helper may hold it down for a moment. */
const F13 = 0x69;
const TEXTEDIT_APP = "/System/Applications/TextEdit.app";
/** kCGWindowListOptionAll: every window, on screen or not (the backend itself lists on-screen windows only). */
const ALL_WINDOWS = 0;

/** AXIsProcessTrusted() for this process (false off macOS or when AX can't be bound). */
const trusted = (() => {
  const cf = onMac ? openCoreFoundation() : null;
  return !!(cf && openAX(cf)?.trusted());
})();

/** This process and its ancestors (the TCC "responsible process" is one of them), for the grant message. */
function ancestry(): string {
  const chain = [`${process.pid} ${process.execPath}`];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const r = spawnSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout?.trim() ?? "");
    if (!m) break;
    chain.push(`${pid} ${m[2]}`);
    pid = Number(m[1]);
  }
  return chain.join("\n  ");
}

/** Electron's screen, as far as the tests need it, from CoreGraphics' active displays (points). */
function displayScreen(): ScreenLike {
  const cg = openCoreGraphics();
  const bounds: Rect[] = [];
  if (cg) {
    const ids = Buffer.alloc(16 * 4), count = [0];
    if (cg.CGGetActiveDisplayList(16, ids, count) === 0) {
      for (let i = 0; i < count[0]!; i++) {
        const r = rectOf(cg.CGDisplayBounds(ids.readUInt32LE(i * 4)));
        if (r) bounds.push(r);
      }
    }
  }
  const all = bounds.map(b => ({ bounds: b, scaleFactor: 2 }));
  return { getPrimaryDisplay: () => all[0] ?? { bounds: { x: 0, y: 0, width: 0, height: 0 }, scaleFactor: 1 }, getAllDisplays: () => all };
}

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited (and what it found). */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number, what: string | (() => string)): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    await sleep(50);
  }
}

/** The median time of `fn` over `n` calls, in milliseconds, as text for the log. */
function median(fn: () => unknown, n = 41): string {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return `${times[n >> 1]!.toFixed(3)} ms`;
}

/** The pids of every running TextEdit. */
function textEditPids(): number[] {
  const r = spawnSync("/usr/bin/pgrep", ["-x", "TextEdit"], { encoding: "utf8" });
  return (r.stdout ?? "").split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0);
}

/** Every window CoreGraphics knows for `pid`, on screen or not, at any layer (kCGWindowListOptionAll). */
function allWindowsOf(pid: number): Record<string, unknown>[] {
  const cf = openCoreFoundation(), cg = openCoreGraphics();
  if (!cf || !cg) return [];
  return cf.own(cg.CGWindowListCopyWindowInfo(ALL_WINDOWS, 0), list => cf.array(list).flatMap(d => {
    if (cf.number(cf.get(d, "kCGWindowOwnerPID")) !== pid) return [];
    const out: Partial<CGRect> = {};
    const boundsDict = cf.get(d, "kCGWindowBounds");
    const bounds = boundsDict && cg.CGRectMakeWithDictionaryRepresentation(boundsDict, out) ? rectOf(out) : null;
    return [{
      id: cf.number(cf.get(d, "kCGWindowNumber")), owner: cf.string(cf.get(d, "kCGWindowOwnerName")),
      layer: cf.number(cf.get(d, "kCGWindowLayer")), alpha: cf.number(cf.get(d, "kCGWindowAlpha")),
      onScreen: cf.boolean(cf.get(d, "kCGWindowIsOnscreen")), title: cf.string(cf.get(d, "kCGWindowName"), 200), bounds,
    }];
  })) ?? [];
}

/** What AX sees of the app `pid`: whether it is hidden or frontmost, and each window's role, title and state. */
function axReport(pid: number): Record<string, unknown> {
  const cf = openCoreFoundation();
  const ax = cf ? openAX(cf) : null;
  if (!cf || !ax) return { ax: "unavailable" };
  return cf.own(ax.application(pid), app => ({
    hidden: ax.boolean(app, "AXHidden"),
    frontmost: ax.boolean(app, "AXFrontmost"),
    windows: ax.withElements(app, "AXWindows", items => items.map(w => ({
      role: ax.string(w, "AXRole"), subrole: ax.string(w, "AXSubrole"), title: ax.string(w, "AXTitle", 200),
      minimized: ax.boolean(w, "AXMinimized"), frame: ax.frame(w), id: ax.windowId(w),
    }))),
    systemFrontmostPid: cf.own(ax.element(ax.systemWide()!, "AXFocusedApplication"), a => ax.pid(a)),
  })) ?? { ax: "no application element" };
}

/** The AX title of window `id` of the app `pid` ("" when AX can't say). */
function axTitle(pid: number, id: number): string {
  const cf = openCoreFoundation();
  const ax = cf ? openAX(cf) : null;
  if (!cf || !ax) return "";
  return cf.own(ax.application(pid), app => ax.withElements(app, "AXWindows", items =>
    items.filter(w => ax.windowId(w) === id).map(w => ax.string(w, "AXTitle", 200) ?? "")[0] ?? "")) ?? "";
}

/** The focused element as AX sees it system-wide: its text and selection (what TextEdit's text view holds). */
function focusedText(): { value: string | null; selected: { location: number; length: number } | null } {
  const cf = openCoreFoundation();
  const ax = cf ? openAX(cf) : null;
  const system = ax?.systemWide();
  if (!cf || !ax || !system) return { value: null, selected: null };
  return cf.own(ax.element(system, "AXFocusedUIElement"), el => {
    const range = ax.value(el, "AXSelectedTextRange");
    return { value: ax.string(el, "AXValue", 1000), selected: range?.type === "range" ? { location: range.location, length: range.length } : null };
  }) ?? { value: null, selected: null };
}

/** A warning the CI log shows as one (an annotation on GitHub Actions). */
const warn = (text: string) => console.log(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "warning: "}${text}`);

/** Everything that tells why TextEdit's window isn't on screen, for the CI log. */
function textEditReport(ws: DarwinWindowSystem, pid: number, opened: string): string {
  const ps = spawnSync("/bin/ps", ["-o", "pid,stat,etime,command", "-p", String(pid)], { encoding: "utf8" });
  return [
    `open: ${opened}`,
    `process: ${ps.stdout.trim()}`,
    `every TextEdit pid: ${JSON.stringify(textEditPids())}`,
    `CoreGraphics, every window of ${pid} (any layer, on screen or not): ${JSON.stringify(allWindowsOf(pid))}`,
    `AX: ${JSON.stringify(axReport(pid))}`,
    `on screen now, top first: ${JSON.stringify(ws.stack().reverse().slice(0, 20).map(s => ({ id: s.id, pid: s.pid, owner: s.wmClass, layer0: !s.overrideRedirect, x: s.x, y: s.y, width: s.width, height: s.height })))}`,
  ].join("\n  ");
}

/** TextEdit's document window on screen: a drawn layer-0 window of its process. */
const documentWindow = (ws: DarwinWindowSystem, pid: number) => ws.stack().find(s => s.pid === pid && !s.overrideRedirect);

describe.skipIf(!onMac && !required)("the macOS backends on a real desktop", () => {
  let ws: DarwinWindowSystem;
  let x: DarwinInput;
  let screen: ScreenLike;
  let raw: DarwinDesktop;
  const logged: string[] = [];
  const log = { warn: (e: string, f?: unknown) => logged.push(`${e} ${JSON.stringify(f)}`), info: (e: string, f?: unknown) => logged.push(`${e} ${JSON.stringify(f)}`) };

  beforeAll(() => {
    if (!onMac) throw new Error("EMBER_DARWIN_TEST=1, but this isn't macOS");
    console.log(`darwin: AXIsProcessTrusted() = ${trusted}; this process and its parents:\n  ${ancestry()}`);
    screen = displayScreen();
    const opened = openDarwinWindows({ screen, log });
    if (!opened) throw new Error(`the macOS window system didn't open: ${String(darwinWindowsError)}`);
    ws = opened;
    const input = openDarwinInput({ log });
    if (!input) throw new Error(`macOS input didn't open: ${String(darwinInputError)}`);
    x = input;
    // A desktop that never reuses the window list, to measure a real read.
    const uncached = openDesktop({ windowCacheMs: 0 });
    if (!uncached) throw new Error("the macOS desktop didn't open");
    raw = uncached;
    console.log(`darwin: Screen Recording = ${ws.screenRecording()}; Input Monitoring (CGPreflightListenEventAccess) = ${ws.inputMonitoring()}; `
      + `posting (CGPreflightPostEventAccess) = ${raw.postAccess()}; input source is a keyboard layout = ${raw.inputSourceIsLayout()}; `
      + `IsSecureEventInputEnabled = ${raw.secureInput()}; session = ${JSON.stringify(raw.session())}; `
      + `HIToolbox symbols missing = ${JSON.stringify(hiToolboxMissing)}`);
  });

  afterAll(() => {
    x?.close();
    ws?.close();
    raw?.dispose?.();
  });

  it("reads the window list, the pointer and the keys without any permission", () => {
    expect(ws.kind).toBe("darwin");
    const stack = ws.stack();
    expect(stack.length).toBeGreaterThan(0); // at least the menu bar of a logged-in session
    for (let i = 0; i < stack.length; i++) expect(stack[i]!.client).toBe(stack[i]!.id);
    const p = ws.pointer();
    expect(p && Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false, shift: false, command: false });
    expect(x.keysDown()).toEqual([]);
    expect(x.pointerLags).toBe(true);
  });

  it("measures what a borrow's checks cost (they run every 8 ms on Electron's main thread)", () => {
    const loop = () => { for (let k = 0; k < 128; k++) raw.keyDown(k); };
    console.log(`darwin: median cost: keysDown() ${median(() => x.keysDown())} (one GetKeys call: ${!hiToolboxMissing.includes("GetKeys")}), `
      + `128 CGEventSourceKeyState calls ${median(loop)}, windows() uncached ${median(() => raw.windows())}, `
      + `windows() within 30 ms ${median(() => ws.stack())}, focusedWindow() ${median(() => x.focusedWindow(), 21)}, `
      + `on ${raw.windows().length} windows`);
  }, 15_000);

  it("can tell whether secure keyboard entry is on, and sees no security prompt at rest", () => {
    const secure = ws.secureInput();
    console.log(`darwin: secure input = ${JSON.stringify(secure)}`);
    expect(secure.on).not.toBeNull();
    const prompts = raw.windows().filter(e => SECURITY_OWNERS.has(e.owner) && e.alpha > 0);
    // A security owner with a window up at rest would stop every screenshot: name it for the CI log.
    expect(prompts.map(e => ({ owner: e.owner, layer: e.layer, bounds: e.bounds }))).toEqual([]);
    expect(ws.systemDialogOpen()).toBe(secure.on === true);
    expect(logged.filter(l => l.startsWith("platform.secure_input_unknown"))).toEqual([]);
  });

  it("measures the displays in points and knows what is on them", () => {
    const main = screen.getPrimaryDisplay().bounds;
    expect(main.width).toBeGreaterThan(0);
    expect(ws.screenBounds().width).toBeGreaterThanOrEqual(main.width);
    expect(x.screenSize().width).toBeGreaterThan(0);
    expect(x.onScreen(main.x + main.width / 2, main.y + main.height / 2)).toBe(true);
    expect(x.onScreen(-100_000, -100_000)).toBe(false);
  });

  it("captures nothing without a capture function", () => {
    expect(ws.capture(0, 0, 10, 10)).toBeNull();
  });

  it("reads the keyboard layout in use on the main thread", () => {
    const layout = x.layout();
    expect(layout).not.toBeNull();
    expect(layout!.shift).toBe(0x38 + 8);
    expect(x.keycodeOf(x.keysymOf("s"))).toBeGreaterThan(0);
    expect(raw.inputSourceIsLayout()).toBe(true); // the runner types on a keyboard layout, not an input method
  });

  describe.skipIf(!trusted && !required)("with the Accessibility permission", () => {
    beforeAll(() => {
      if (!trusted) {
        throw new Error(`EMBER_DARWIN_TEST=1, but this process isn't trusted for Accessibility (AXIsProcessTrusted() is false). Grant it to the binary that runs the tests, or to the app TCC holds responsible:\n  ${ancestry()}`);
      }
    });

    it("refuses input only for the reason this Mac gives: Input Monitoring, when it is missing", () => {
      expect(x.blockedReason(0)).toBe(ws.inputMonitoring() === false ? INPUT_MONITORING_REASON : null);
    });

    it("sees a key another process holds down, as the user's keyboard brake must (Input Monitoring, design §8.5)", async () => {
      const koffi = createRequire(import.meta.url).resolve("koffi");
      // A separate process with its own event source posts F13 down at the HID tap, reports, and lets go when told
      // (or after 3 s whatever happens).
      const script = `
        const koffi = require(process.argv[1]);
        const fw = n => "/System/Library/Frameworks/" + n + ".framework/" + n;
        const cg = koffi.load(fw("CoreGraphics")), cf = koffi.load(fw("CoreFoundation")), as = koffi.load(fw("ApplicationServices"));
        const source = cg.func("void *CGEventSourceCreate(int32_t state)")(1);
        const create = cg.func("void *CGEventCreateKeyboardEvent(void *source, uint16_t keycode, bool down)");
        const post = cg.func("void CGEventPost(uint32_t tap, void *event)");
        const release = cf.func("void CFRelease(void *cf)");
        let postAccess = null;
        try { postAccess = cg.func("bool CGPreflightPostEventAccess(void)")(); } catch {}
        const key = down => { const e = create(source, ${F13}, down); post(0, e); release(e); };
        key(true);
        console.log(JSON.stringify({ trusted: as.func("bool AXIsProcessTrusted(void)")(), postAccess }));
        let done = false;
        const up = () => { if (done) return; done = true; key(false); setTimeout(() => process.exit(0), 50); };
        process.stdin.on("data", up);
        process.stdin.on("end", up);
        setTimeout(up, 3000);
      `;
      const helper = spawn(process.execPath, ["-e", script, koffi], { stdio: ["pipe", "pipe", "inherit"] });
      try {
        const facts = await new Promise<{ trusted: boolean; postAccess: boolean | null }>((resolve, reject) => {
          let out = "";
          helper.stdout!.on("data", d => { out += String(d); if (out.includes("\n")) resolve(JSON.parse(out.trim()) as { trusted: boolean; postAccess: boolean | null }); });
          helper.on("exit", code => reject(new Error(`the key-posting helper exited (${code}) before posting: ${out}`)));
        });
        let viaKeysDown = false, viaKeyState = false;
        for (let i = 0; i < 20 && !(viaKeysDown && viaKeyState); i++) {
          viaKeysDown ||= x.keysDown().includes(F13 + 8);
          viaKeyState ||= raw.keyDown(F13);
          await sleep(25);
        }
        const listen = ws.inputMonitoring();
        // Without the permission, the answer settles Q10 only when the helper could post and both reads agree.
        const verdict = listen !== false ? ""
          : !facts.trusted ? ": no verdict (the helper wasn't trusted to post)"
          : viaKeysDown && viaKeyState ? ": key-state polling is NOT gated by Input Monitoring"
          : !viaKeysDown && !viaKeyState ? ": key-state polling looks gated by Input Monitoring"
          : ": no verdict (GetKeys and CGEventSourceKeyState disagree)";
        console.log(`darwin: Input Monitoring = ${listen}; F13 held by another process (${JSON.stringify(facts)}) shows in keysDown() = ${viaKeysDown}, `
          + `in CGEventSourceKeyState = ${viaKeyState}${verdict}`);
        // With the permission the brake must work, through the one-call read (GetKeys) as through the per-key one (and
        // the helper, a child of this process, must have been allowed to post at all for that to mean anything).
        if (listen !== false) {
          expect({ helperTrusted: facts.trusted, viaKeysDown, viaKeyState }).toEqual({ helperTrusted: true, viaKeysDown: true, viaKeyState: true });
        }
      } finally {
        helper.stdin!.end();
        await new Promise(r => { if (helper.exitCode !== null) r(null); else helper.on("exit", r); });
      }
      await waitFor(() => !x.keysDown().includes(F13 + 8) && !raw.keyDown(F13), 2_000, "F13 to be up again");
    }, 15_000);

    describe("in TextEdit", () => {
      let dir = "";
      let file = "";
      let pid = 0;
      let win = 0;
      /** The window's AX title ("ember.txt", or "ember" with extensions hidden; "Untitled" for the last resort). */
      let title = "";
      /** The window is the temporary file's (else an untitled document: the last resort, with a warning). */
      let fromFile = true;

      beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "ember-darwin-"));
        file = join(dir, "ember.txt");
        writeFileSync(file, "");
        const before = new Set(textEditPids());
        // A new TextEdit (-n), launched fresh without restored windows (-F), opening the file; plain text read and
        // written as UTF-8, no automatic corrections, and plain-text untitled documents rather than the iCloud open panel.
        const args = ["-n", "-F", "-a", "TextEdit", file, "--args",
          "-ApplePersistenceIgnoreState", "YES", "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO", "-RichText", "NO",
          "-PlainTextEncoding", "4", "-PlainTextEncodingForWrite", "4",
          "-CorrectSpellingAutomatically", "NO", "-NSAutomaticSpellingCorrectionEnabled", "NO", "-SmartQuotes", "NO", "-SmartDashes", "NO",
          "-TextReplacement", "NO"];
        const launched = spawnSync("/usr/bin/open", args, { encoding: "utf8" });
        const opened = `open ${args.join(" ")} → ${launched.status} ${launched.stdout}${launched.stderr}`.trim();
        if (launched.status !== 0) throw new Error(`open -a TextEdit failed: ${opened}`);
        pid = await waitFor(() => textEditPids().find(p => !before.has(p)), 30_000, "a new TextEdit process");
        const started = Date.now();
        let nudged = 0;
        for (;;) {
          const found = documentWindow(ws, pid);
          if (found) {
            if (nudged) console.log(`darwin: TextEdit's window appeared after ${Date.now() - started} ms and ${nudged} nudge(s)`);
            win = found.id;
            title = await waitFor(() => axTitle(pid, win), 5_000, "TextEdit's window title over AX").catch(() => "");
            // Without an AX title, the window is the file's unless the untitled last resort was asked for.
            fromFile = title ? /^ember(\.txt)?$/i.test(title) : nudged < 3;
            if (!fromFile) warn(`TextEdit never showed ${file}; the tests go on in "${title}", and Command+S is checked as Command+A:\n  ${textEditReport(ws, pid, opened)}`);
            break;
          }
          const waited = Date.now() - started;
          if (waited > 45_000) throw new Error(`timed out waiting for TextEdit's window in the stack:\n  ${textEditReport(ws, pid, opened)}`);
          if (nudged === 0 && waited > 8_000) {
            // Log what is there, then unhide it and bring back a minimised window (a launch from a process without
            // UI may leave the app hidden).
            nudged++;
            console.log(`darwin: no TextEdit window after 8 s:\n  ${textEditReport(ws, pid, opened)}`);
            const cf = openCoreFoundation()!, ax = openAX(cf)!;
            cf.own(ax.application(pid), app => {
              if (ax.boolean(app, "AXHidden")) ax.set(app, "AXHidden", cf.kFalse!);
              ax.withElements(app, "AXWindows", items => items.forEach(w => ax.boolean(w, "AXMinimized") && ax.set(w, "AXMinimized", cf.kFalse!)));
            });
          } else if (nudged === 1 && waited > 16_000 && textEditPids().length === 1) {
            // Send the document again (an odoc to the only TextEdit), which opens its window if the first one was lost.
            nudged++;
            const again = spawnSync("/usr/bin/open", ["-a", TEXTEDIT_APP, file], { encoding: "utf8" });
            console.log(`darwin: opened ${file} in TextEdit again: ${again.status} ${again.stderr}`);
          } else if (nudged === 2 && waited > 28_000 && textEditPids().length === 1) {
            // Last resort: reopen TextEdit without a file, which gives an untitled document (the launch said so).
            nudged++;
            const reopen = spawnSync("/usr/bin/open", ["-a", TEXTEDIT_APP], { encoding: "utf8" });
            console.log(`darwin: reopened TextEdit for an untitled document: ${reopen.status} ${reopen.stderr}`);
          }
          await sleep(100);
        }
      }, 120_000);

      afterAll(() => {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        if (dir) rmSync(dir, { recursive: true, force: true });
      });

      it("lists TextEdit's window with its process and app name, and finds it by its title", async () => {
        expect(ws.stack().find(s => s.id === win)).toMatchObject({ pid, wmClass: "TextEdit", overrideRedirect: false });
        expect(ws.clientWindows().some(w => w.id === win && w.pid === pid && w.wmClass === "TextEdit" && w.wmClassName === "TextEdit")).toBe(true);
        // By part of its title, as XInput's rules allow for an app's own windows ("ember" in "ember.txt").
        const wanted = fromFile ? "ember" : title;
        await waitFor(() => x.findWindow(wanted, pid) === win, 10_000, `findWindow to find "${wanted}" over AX (the window's AX title is "${title}")`);
      });

      it("brings TextEdit's window to the front from a process without UI, and reports it as active and focused", async () => {
        // TextEdit, just opened, is already in front, and activate() does nothing for the focused window: put Finder
        // in front first (through LaunchServices, as the user would), so the activation really starts in the background.
        const finder = spawnSync("/usr/bin/open", ["-a", "Finder"], { encoding: "utf8" });
        const away = await waitFor(() => { const f = raw.frontmostPid(); return f !== null && f !== pid ? f : null; }, 5_000, "another app in front")
          .catch(() => null);
        if (away === null) warn(`TextEdit stayed in front after open -a Finder (${finder.status} ${finder.stderr}): the activation wasn't exercised from the background`);
        const fallbacks = logged.filter(l => l.startsWith("platform.activation_fallback")).length;
        x.activate(win);
        await waitFor(() => x.focusedWindow() === win, 10_000, () => `TextEdit's window to have the keyboard (AX: ${JSON.stringify(axReport(pid))})`);
        // Whether macOS declined the background activation and LaunchServices did it (R6-mac): for the CI log.
        console.log(`darwin: activation from the background (${away === null ? "not exercised" : `pid ${away} was in front`}) went through LaunchServices = `
          + `${logged.filter(l => l.startsWith("platform.activation_fallback")).length > fallbacks}`);
        expect(ws.activeWindow()?.id).toBe(win);
        expect(ws.focusWindow()).toMatchObject({ id: win, pid, wmClass: "TextEdit" });
        expect(x.activeWindow()).toBe(win);
      }, 20_000);

      it("would land a click in TextEdit's window: nothing listed above it covers it, and the session isn't locked", async () => {
        const target = ws.stack().find(s => s.id === win);
        expect(target).toBeDefined();
        const at = { x: Math.round(target!.x + target!.width / 2), y: Math.round(target!.y + target!.height / 2) };
        x.move(at.x, at.y);
        await waitFor(() => {
          const p = ws.pointer();
          return p && Math.abs(p.x - at.x) <= 2 && Math.abs(p.y - at.y) <= 2;
        }, 2_000, `the pointer at ${at.x},${at.y}`);
        // A full-screen transparent system window (the Dock's, Notification Center's…) above every app would make every
        // click "covered" and black out every window picture: name any such window for the CI log.
        const stack = ws.stack();
        const above = stack.slice(stack.findIndex(s => s.id === win) + 1)
          .filter(s => at.x >= s.x && at.y >= s.y && at.x < s.x + s.width && at.y < s.y + s.height);
        console.log(`darwin: windows above TextEdit at ${at.x},${at.y}: ${JSON.stringify(above.map(s => ({ owner: s.wmClass, title: s.title, layer: s.overrideRedirect ? "not 0" : 0, x: s.x, y: s.y, width: s.width, height: s.height })))}`);
        expect(above).toEqual([]);
        expect(x.pointerOn(win)).toBe(true);
        expect(x.screenLocked()).toBe(false);
        expect(x.keyboardGrabbed(win)).toBe(false);
      }, 10_000);

      it("types text whatever the layout, and saves it with Command+S pressed by keysym", async () => {
        await waitFor(() => x.focusedWindow() === win || (x.activate(win), false), 10_000, "TextEdit's window to have the keyboard");
        for (const ch of TEXT) {
          expect(x.textKey(ch, true)).toBe(true);
          expect(x.textKey(ch, false)).toBe(true);
          await sleep(30);
        }
        await waitFor(() => focusedText().value === TEXT, 5_000, () => `TextEdit's text to read "${TEXT}" over AX (it reads ${JSON.stringify(focusedText())})`);
        const command = x.keysymOf("Super_L"), letter = x.keysymOf(fromFile ? "s" : "a");
        expect(x.keysym(command, true)).toBe(true);
        expect(x.keysym(letter, true)).toBe(true);
        expect(x.keysym(letter, false)).toBe(true);
        expect(x.keysym(command, false)).toBe(true);
        if (fromFile) {
          await waitFor(() => readFileSync(file, "utf8") === TEXT, 15_000, () => `the file to read "${TEXT}" (it reads ${JSON.stringify(readFileSync(file, "utf8"))})`);
        } else {
          // Command+A selects the whole text: the same Command-and-letter path through the layout as Command+S.
          await waitFor(() => focusedText().selected?.length === TEXT.length, 5_000, () => `Command+A to select the text (${JSON.stringify(focusedText())})`);
        }
      }, 30_000);

      it("moves the pointer where it was asked", async () => {
        const main = screen.getPrimaryDisplay().bounds;
        const to = { x: Math.round(main.x + main.width / 2) + 7, y: Math.round(main.y + main.height / 2) + 5 };
        x.move(to.x, to.y);
        await waitFor(() => {
          const p = ws.pointer();
          return p && Math.abs(p.x - to.x) <= 2 && Math.abs(p.y - to.y) <= 2;
        }, 2_000, `the pointer at ${to.x},${to.y}`);
      });

      it("leaves nothing pressed after releaseAll()", async () => {
        expect(x.keysym(x.keysymOf("Shift_L"), true)).toBe(true);
        await sleep(100);
        // Whether the session's key state shows Ember's own posted keys (the borrow filters them either way): for the CI log.
        console.log(`darwin: a posted Shift shows in keysDown() = ${x.keysDown().includes(0x38 + 8)}, in CGEventSourceKeyState = ${raw.keyDown(0x38)}, in the flags = ${ws.keysDown()?.shift}`);
        x.releaseAll();
        await waitFor(() => x.keysDown().length === 0, 2_000, "no key down");
        expect(ws.keysDown()).toEqual({ control: false, alt: false, space: false, shift: false, command: false });
        expect(ws.pointer()!.mask & 0x1f00).toBe(0);
      });
    });
  });
});
