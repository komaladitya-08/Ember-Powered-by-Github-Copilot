/**
 * The policy's rule for other targets' windows (design §4.5, L7; critique integration-17): the borrowed mouse and
 * keyboard (tier 3) are refused in a WSLg app's identified window ("wsl:<distro>:<app>") on Windows, and nothing else
 * changes. targetRules only ever refuses (the seam runs it before every never-rule).
 */

import { describe, expect, it } from "vitest";
import { KEYS, type OS } from "../../app/shared/shortcuts";
import { PolicyEngine, plainQuestion, type ActionKind, type ActionRequest } from "../../app/main/policy/policy";
import { isWslApp, targetRules, WSL_TIER3_REASON } from "../../app/main/policy/target-rules";

const KINDS: ActionKind[] = ["read", "click", "toggle", "text", "select", "value", "setting", "open_app", "cursor_click", "cursor_text", "keys", "scroll"];
const TIER3: ActionKind[] = ["cursor_click", "cursor_text", "keys", "scroll"];

const req = (kind: ActionKind, app: string, more: Partial<ActionRequest> = {}): ActionRequest => ({
  taskId: "t", kind, app, window: "notes.txt - gedit",
  element: kind === "text" || kind === "cursor_text" ? { role: "text", name: "Notes" } : { role: "push button", name: "Save" },
  ...(kind === "text" || kind === "cursor_text" ? { value: "hello", mode: "replace" as const } : {}),
  ...(kind === "keys" ? { value: "ctrl+s" } : {}), ...(kind === "scroll" ? { value: "down" } : {}),
  ...(kind === "value" ? { value: "5" } : {}), ...(kind === "select" ? { value: "Large" } : {}),
  ...more,
});

const engine = (os: OS, grants: Record<string, "observe" | "act"> = {}) =>
  new PolicyEngine({ neverLook: () => [], grants: () => grants, keys: KEYS[os], os });

describe("which apps are WSLg windows", () => {
  it("knows the router's names, and nothing else", () => {
    for (const a of ["wsl:Ubuntu:gedit", "wsl:ubuntu:gnome-terminal-server", " WSL:Debian-12:xeyes "]) expect(isWslApp(a), a).toBe(true);
    for (const a of ["", "wsl:", "wsl:Ubuntu", "wsl:Ubuntu:", "wsl::gedit", "msrdc", "gedit", "wslg", "xwsl:Ubuntu:gedit", undefined, null]) expect(isWslApp(a as string), String(a)).toBe(false);
  });
});

describe("targetRules", () => {
  it("refuses every tier-3 kind in a WSLg app's window on Windows, as a never with the request's own question", () => {
    for (const kind of TIER3) {
      const r = req(kind, "wsl:Ubuntu:gedit");
      expect(targetRules(r, "win32"), kind).toEqual({ tier: "never", verdict: "deny", reason: WSL_TIER3_REASON, prompt: plainQuestion(r, KEYS.win32) });
    }
  });

  it("leaves accessibility actions, reading and opening apps in WSLg apps to the usual rules", () => {
    for (const kind of KINDS.filter(k => !TIER3.includes(k))) expect(targetRules(req(kind, "wsl:Ubuntu:gedit"), "win32"), kind).toBeNull();
  });

  it("decides nothing for any other window, nor on Linux and macOS, nor for a malformed request", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      for (const kind of KINDS) {
        for (const app of ["gedit", "msrdc", "notepad", "Terminal", ""]) expect(targetRules(req(kind, app), os), `${os} ${kind} ${app}`).toBeNull();
        if (os !== "win32") expect(targetRules(req(kind, "wsl:Ubuntu:gedit"), os), `${os} ${kind}`).toBeNull();
      }
    }
    expect(targetRules({} as ActionRequest, "win32")).toBeNull();
    expect(targetRules(null as unknown as ActionRequest, "win32")).toBeNull();
  });

  it("only ever refuses", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      for (const kind of KINDS) {
        for (const app of ["wsl:Ubuntu:gedit", "wsl:Debian:keepassxc", "gedit", "msrdc"]) {
          const d = targetRules(req(kind, app), os);
          if (d) expect(d).toMatchObject({ tier: "never", verdict: "deny" });
        }
      }
    }
  });
});

describe("through the policy on Windows", () => {
  it("refuses the borrowed mouse and keyboard in a WSLg app whatever the grant", () => {
    for (const kind of TIER3) {
      expect(engine("win32", { "wsl:ubuntu:gedit": "act" }).decide(req(kind, "wsl:Ubuntu:gedit")), kind).toMatchObject({ tier: "never", verdict: "deny", reason: WSL_TIER3_REASON });
    }
  });

  it("decides a click in a WSLg app as in any app (the remote-surface refusal is msrdc's alone)", () => {
    const wsl = engine("win32").decide(req("click", "wsl:Ubuntu:gedit"));
    expect(wsl.verdict).not.toBe("deny");
    expect(wsl.reason).not.toBe(WSL_TIER3_REASON);
    expect(engine("win32").decide(req("click", "msrdc"))).toMatchObject({ tier: "never", verdict: "deny" });
  });

  it("still lets the borrowed mouse ask everywhere else on Windows and Linux", () => {
    for (const os of ["linux", "win32"] as const) expect(engine(os).decide(req("cursor_click", "gedit")).verdict).toBe("confirm");
  });
});
