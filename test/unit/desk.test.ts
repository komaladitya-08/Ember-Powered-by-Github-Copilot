import { describe, expect, it } from "vitest";
import { freeDisplay } from "../../app/main/desk/desk";
import { deskRecipe } from "../../app/main/desk/place";
import { keysymFor } from "../../app/main/desk/view";
import { PolicyEngine } from "../../app/main/policy/policy";
import { appEnv, type DesktopApp } from "../../app/main/hands/system";

const app = (id: string, name: string, exec: string): DesktopApp => ({ id, name, exec, file: "", keywords: [] });

describe("desk", () => {
  it("picks the first free display number", () => {
    const taken = new Set(["/tmp/.X90-lock", "/tmp/.X11-unix/X91"]);
    expect(freeDisplay(90, p => taken.has(p))).toBe(92);
  });

  it("starts apps as Ember's own instances", () => {
    expect(deskRecipe(app("firefox", "Firefox", "firefox %u"), { handOff: "/h" }, "/p")).toEqual(["firefox", "--new-instance", "--profile", "/p/firefox"]);
    expect(deskRecipe(app("libreoffice-writer", "LibreOffice Writer", "libreoffice --writer %U"), { handOff: "/h" }, "/p"))
      .toEqual(["libreoffice", "--writer", "-env:UserInstallation=file:///p/libreoffice"]);
    expect(deskRecipe(app("org.gnome.gedit", "Text Editor", "gedit %U"), { handOff: "/h" }, "/p")).toEqual(["gedit"]);
  });

  it("never runs terminals", () => {
    expect(() => deskRecipe(app("org.gnome.Terminal", "Terminal", "gnome-terminal"), { handOff: "/h" }, "/p")).toThrow(/terminals/);
    expect(() => deskRecipe(app("xterm", "XTerm", "xterm"), { handOff: "/h" }, "/p")).toThrow(/terminals/);
  });

  it("maps browser keys to X keysyms", () => {
    const names: Record<string, number> = { Return: 0xff0d, Left: 0xff51, F5: 0xffc2, Control_L: 0xffe3 };
    const lookup = (n: string) => names[n] ?? 0;
    expect(keysymFor("Enter", lookup)).toBe(0xff0d);
    expect(keysymFor("ArrowLeft", lookup)).toBe(0xff51);
    expect(keysymFor("F5", lookup)).toBe(0xffc2);
    expect(keysymFor("a", lookup)).toBe(0x61);
    expect(keysymFor("é", lookup)).toBe(0);
  });

  it("lets Ember use mouse and keys freely on its desk, but still confirms risky buttons and refuses secrets", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({}) });
    expect(e.decide({ taskId: "t", kind: "keys", app: "gedit", window: "w", value: "ctrl+s", onDesk: true }).verdict).toBe("allow");
    expect(e.decide({ taskId: "t", kind: "cursor_click", app: "gedit", window: "w", element: { role: "panel", name: "Canvas" }, onDesk: true }).verdict).toBe("allow");
    expect(e.decide({ taskId: "t", kind: "click", app: "gedit", window: "w", element: { role: "push button", name: "Bold" }, onDesk: true }).verdict).toBe("allow");
    const send = e.decide({ taskId: "t", kind: "click", app: "Mail", window: "w", element: { role: "push button", name: "Send" }, onDesk: true });
    expect(send).toMatchObject({ verdict: "confirm", risky: true });
    expect(send.prompt).toContain("(on my desk)");
    expect(e.decide({ taskId: "t", kind: "text", app: "x", window: "w", element: { role: "password text", name: "" }, value: "x", onDesk: true }).verdict).toBe("deny");
  });
});

describe("appEnv", () => {
  it("removes Electron's markers so launched apps keep their accessibility", () => {
    const env = appEnv({ NO_AT_BRIDGE: "1", CHROME_DESKTOP: "ember.desktop", ELECTRON_RUN_AS_NODE: "1", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME", XDG_CURRENT_DESKTOP: "Unity", HOME: "/home/a" });
    expect(env).toEqual({ XDG_CURRENT_DESKTOP: "GNOME", HOME: "/home/a" });
  });
});
