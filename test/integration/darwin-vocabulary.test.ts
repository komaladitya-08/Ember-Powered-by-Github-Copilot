/**
 * The macOS vocabularies (design §9.11) against real windows: Terminal is a terminal by the owner name CoreGraphics
 * reports for its window and by its bundle id, the Console log viewer and Calculator are not (by the vocabulary's own
 * rows), System Settings' Privacy & Security pane and the privacy pages that grant apps access carry titles
 * SECURITY_TITLE.darwin knows (they need Screen Recording to be read, which CI grants), an administrator prompt is
 * drawn by an owner SECURITY_APP.darwin knows (only with EMBER_MACSYS_TEST=1: it raises a real password prompt), and
 * through a real Electron, a password manager's concealed copy is recognised by CLIPBOARD_FORMATS.darwin and the text
 * Ember pastes carries org.nspasteboard.TransientType as the pasteboard itself lists it (the G5 check). Each check prints
 * what it saw (owners, titles, types), so a name that differs on macOS 14 or 15 is in the log.
 *
 * Skipped off macOS; with EMBER_MACSYS_TEST=1 it fails instead of skipping when macOS, CoreGraphics, Screen Recording
 * or Electron is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDesktop, type DarwinDesktop } from "../../app/main/platform/darwin/desktop";
import { SECURITY_OWNERS, type CGWindowEntry } from "../../app/main/platform/darwin/model";
import { hasBuiltInShell, isTerminalApp } from "../../app/main/hands/system";
import { TERMINAL_ID_WORDS, TERMINAL_NAME, TERMINALS } from "../../app/main/hands/terminals";
import { isSecurityWindow } from "../../app/main/policy/policy";
import { SECURITY_APP } from "../../app/main/policy/vocabulary";
import { CLIPBOARD_FORMATS } from "../../app/main/agent/clipboard-formats";
import { runClipboardChild } from "./vocabulary-clipboard";

const required = process.env.EMBER_MACSYS_TEST === "1";
const onMac = process.platform === "darwin";
const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const M = "darwin" as const;

/** Runs AppleScript (or JavaScript for Automation with `js`) and gives its output. */
function osa(script: string, js = false): string {
  const r = spawnSync("/usr/bin/osascript", [...(js ? ["-l", "JavaScript"] : []), "-e", script], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`osascript failed (${String(r.status)}): ${r.stderr.trim()}`);
  return r.stdout.trim();
}
const quit = (app: string) => spawnSync("/usr/bin/osascript", ["-e", `tell application "${app}" to quit`], { timeout: 15_000 });
const open = (...args: string[]) => {
  const r = spawnSync("/usr/bin/open", args, { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`open ${args.join(" ")} failed: ${r.stderr.trim()}`);
};

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

describe.skipIf(!onMac && !required)("the macOS vocabularies against real windows", () => {
  let desktop: DarwinDesktop;
  const opened = new Set<string>();
  const windows = (): CGWindowEntry[] => desktop.windows();
  const describeWindows = (ws: CGWindowEntry[]) => JSON.stringify(ws.map(w => ({ owner: w.owner, title: w.title, layer: w.layer, alpha: w.alpha })));

  beforeAll(() => {
    if (!onMac) throw new Error("EMBER_MACSYS_TEST=1, but this isn't macOS");
    const d = openDesktop({ windowCacheMs: 0 });
    if (!d) throw new Error("CoreGraphics didn't open (openDesktop returned null)");
    desktop = d;
  });

  afterAll(() => {
    for (const app of opened) quit(app);
    desktop?.dispose?.();
  });

  /** Opens `app` with LaunchServices and waits for a window of it, by the owner name CoreGraphics reports. */
  const openApp = async (app: string): Promise<CGWindowEntry> => {
    open("-a", app);
    opened.add(app);
    return waitFor(() => windows().find(w => w.owner === app && w.layer === 0), 20_000, `a window of ${app}`);
  };

  it("judges Terminal a terminal by its window's owner name and its bundle id", async () => {
    const win = await openApp("Terminal");
    const id = osa(`id of application "Terminal"`);
    console.log(`Terminal: owner ${JSON.stringify(win.owner)}, bundle id ${JSON.stringify(id)}`);
    expect(isTerminalApp({ id: win.owner, name: win.owner }, M)).toBe(true);
    expect(isTerminalApp({ id, name: win.owner }, M)).toBe(true);
    expect(TERMINALS.darwin.has(win.owner.toLowerCase()) || TERMINAL_NAME.darwin.test(win.owner)).toBe(true);
    quit("Terminal");
  }, 60_000);

  it("doesn't name the Console log viewer or Calculator in the terminal vocabulary", async () => {
    for (const app of ["Console", "Calculator"]) {
      const win = await openApp(app);
      const id = osa(`id of application "${app}"`);
      console.log(`${app}: owner ${JSON.stringify(win.owner)}, bundle id ${JSON.stringify(id)}, isTerminalApp ${String(isTerminalApp({ id, name: win.owner }, M))}`);
      expect(TERMINAL_NAME.darwin.test(win.owner)).toBe(false);
      expect(TERMINALS.darwin.has(win.owner.toLowerCase())).toBe(false);
      expect(hasBuiltInShell({ id, name: win.owner }, M)).toBe(false);
      expect(isSecurityWindow({ app: win.owner, title: win.title }, M)).toBe(false);
      quit(app);
    }
    // hands/system.ts's idIsTerminal still takes any "console" id word for a terminal on every OS (reported);
    // the macOS row says it shouldn't.
    expect(TERMINAL_ID_WORDS.darwin).toEqual([]);
    expect(isTerminalApp({ id: "com.apple.calculator", name: "Calculator" }, M)).toBe(false);
  }, 90_000);

  it("knows the titles of Privacy & Security and the privacy pages that grant apps access", async ctx => {
    if (!desktop.screenAccess()) {
      const why = "Screen Recording isn't granted to the app that started this run, so window titles can't be read";
      if (required) throw new Error(why);
      ctx.skip(why);
    }
    const pages = ["", "Privacy_Accessibility", "Privacy_ScreenCapture", "Privacy_ListenEvent", "Privacy_AllFiles", "Privacy_Automation"];
    const seen: Record<string, string> = {};
    try {
      for (const page of pages) {
        open(`x-apple.systempreferences:com.apple.preference.security${page ? `?${page}` : ""}`);
        opened.add("System Settings");
        await sleep(1500); // the pane's own title replaces the previous one after it loads
        const win = await waitFor(() => windows().find(w => w.layer === 0 && /^System (Settings|Preferences)$/.test(w.owner) && w.title && isSecurityWindow({ app: w.owner, title: w.title }, M)),
          15_000, `a System Settings window on ${page || "Privacy & Security"} with a title SECURITY_TITLE.darwin knows (saw ${describeWindows(windows().filter(w => /^System/.test(w.owner)))})`);
        seen[page || "Privacy & Security"] = win.title;
      }
    } finally {
      console.log(`System Settings titles: ${JSON.stringify(seen)}`);
      quit("System Settings");
    }
    expect(Object.keys(seen)).toHaveLength(pages.length);
  }, 150_000);

  // A real administrator prompt on whoever's screen this is: only where asked for, as CI does.
  it.runIf(required)("draws an administrator prompt with an owner SECURITY_APP.darwin knows", async () => {
    const before = new Set(windows().map(w => w.id));
    const asker = spawn("/usr/bin/osascript", ["-e", `do shell script "true" with administrator privileges`], { stdio: "ignore" });
    let exited = false;
    asker.on("exit", () => { exited = true; });
    try {
      const prompt = await waitFor(() => windows().find(w => !before.has(w.id) && w.alpha > 0 && SECURITY_APP.darwin?.test(w.owner))
        ?? (exited ? "exited" : null), 15_000, `a new window owned by a security agent (new windows: ${describeWindows(windows().filter(w => !before.has(w.id)))})`);
      if (prompt === "exited") {
        console.log("not testable on this runner: the administrator right was granted without a prompt");
        return;
      }
      console.log(`administrator prompt: owner ${JSON.stringify(prompt.owner)} (in port/darwin's SECURITY_OWNERS: ${String(SECURITY_OWNERS.has(prompt.owner))}), new windows ${describeWindows(windows().filter(w => !before.has(w.id)))}`);
      expect(isSecurityWindow({ app: prompt.owner }, M)).toBe(true);
    } finally {
      asker.kill("SIGKILL");
      // The request ends with the process that made it, and the prompt with it; a prompt left up would sit over the
      // next CI steps, so SecurityAgent (launchd starts it again on demand) is stopped if it stays.
      const gone = () => !windows().some(w => !before.has(w.id) && SECURITY_APP.darwin?.test(w.owner));
      await waitFor(gone, 15_000, "the prompt to close").catch(() => {
        console.log("the administrator prompt stayed after its requester ended: stopping SecurityAgent");
        spawnSync("/usr/bin/killall", ["-9", "SecurityAgent"], { timeout: 10_000 });
      });
    }
  }, 60_000);

  describe("the clipboard, through a real Electron", () => {
    /** The general pasteboard as macOS lists it: its types and its text. */
    const nativePasteboard = () => JSON.parse(osa(`ObjC.import("AppKit");
      const pb = $.NSPasteboard.generalPasteboard;
      const text = ObjC.unwrap(pb.stringForType("public.utf8-plain-text"));
      JSON.stringify({ types: ObjC.deepUnwrap(pb.types) || [], text: text === undefined ? null : text });`, true)) as { types: string[]; text: string | null };

    it("recognises a password manager's concealed copy, and marks Ember's own paste text transient", async () => {
      osa(`ObjC.import("AppKit");
        const pb = $.NSPasteboard.generalPasteboard;
        pb.clearContents;
        pb.setStringForType("hunter2", "public.utf8-plain-text");
        pb.setStringForType("", "org.nspasteboard.ConcealedType");
        "ok";`, true);
      console.log(`the pasteboard before: ${JSON.stringify(nativePasteboard())}`);
      const report = await runClipboardChild(root, `Ember paste ${process.pid}`);
      console.log(`Electron's clipboard: ${JSON.stringify(report)}`);
      expect(report.readError ?? report.saveError ?? report.writeError ?? report.readAfterError).toBeUndefined();
      const listed = (report.before ?? []).flat();
      expect(listed.some(t => CLIPBOARD_FORMATS.darwin.passwordMarker(t)), `a password marker among ${JSON.stringify(listed)}`).toBe(true);
      expect(report.password).toBe(true);
      const after = nativePasteboard();
      console.log(`the pasteboard after Ember's paste text: ${JSON.stringify(after)}`);
      expect(after.types).toContain("org.nspasteboard.TransientType");
      expect(after.types).not.toContain("org.nspasteboard.ConcealedType");
      expect(after.text).toBe(`Ember paste ${process.pid}`);
    }, 120_000);
  });
});
