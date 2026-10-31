/**
 * Remote-desktop and virtual-machine viewers on Linux and macOS (review #118): Remmina, virt-manager, virt-viewer, GNOME
 * Boxes, VNC and RDP viewers, Screen Sharing, UTM, Parallels, VMware, VirtualBox and the like show another machine's
 * screen as pixels, so a terminal or a password prompt inside one passes every check by name. As on Windows, Ember acts
 * in none of them and blacks them out of screenshots; reading the title and launching the viewer stay as they were.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { REMOTE_SURFACE_REASON, isRemoteSurface, remoteSurfaceCheck } from "../../app/main/policy/remote-surface";

const engine = (os: "linux" | "darwin", app: string) => new PolicyEngine({ neverLook: () => [], grants: () => ({ [app.toLowerCase()]: "act" }), keys: KEYS[os], os, rateLimit: 1e6 });
const click = (app: string, window = "build-server"): ActionRequest => ({ taskId: "t", kind: "click", app, window, element: { role: "push button", name: "OK" } });

const LINUX = ["remmina", "org.remmina.Remmina", "Remmina", "virt-manager", "Virt-manager", "virt-viewer", "remote-viewer", "gnome-boxes", "org.gnome.Boxes",
  "vinagre", "gnome-connections", "org.gnome.Connections", "krdc", "vncviewer", "Vncviewer", "xtightvncviewer", "xfreerdp", "wlfreerdp", "rdesktop", "x2goclient",
  "anydesk", "TeamViewer", "nxplayer.bin", "spicy", "VirtualBox Machine", "VirtualBoxVM", "vmware", "vmplayer", "qemu-system-x86_64", "Wfica"];
const MAC = ["Screen Sharing", "Bildschirmfreigabe", "Partage d’écran", "画面共有", "com.apple.ScreenSharing", "Remote Desktop", "Microsoft Remote Desktop", "Windows App",
  "UTM", "Parallels Desktop", "prl_client_app", "VMware Fusion", "VirtualBox", "VirtualBoxVM", "TeamViewer", "AnyDesk", "VNC Viewer", "Jump Desktop", "Citrix Viewer"];

describe("remote-desktop and virtual-machine viewers on Linux and macOS", () => {
  it.each([["linux", LINUX], ["darwin", MAC]] as const)("%s: every action in one is refused, whatever the grant", (os, apps) => {
    for (const app of apps) {
      expect(isRemoteSurface(app, os), app).toBe(true);
      expect(engine(os, app).decide(click(app)), app).toMatchObject({ tier: "never", verdict: "deny", reason: REMOTE_SURFACE_REASON });
      expect(engine(os, app).decide({ ...click(app), kind: "read" }).verdict).toBe("allow");
      expect(engine(os, app).decide({ taskId: "t", kind: "open_app", app, window: "", value: app }).verdict).toBe("allow");
    }
    expect(remoteSurfaceCheck(os)?.(apps[0])).toBe(true);
  });

  it("says why in plain words, naming virtual machines too", () => {
    expect(REMOTE_SURFACE_REASON).toMatch(/remote desktop, a virtual machine/);
  });

  it("takes no ordinary app for one, nor a name that only contains one", () => {
    for (const app of ["gedit", "firefox", "Terminal", "remminaplugin-notes", "boxer", "Keynote", "Screenshot", "System Settings", "Finder", "vmstat"]) {
      expect(isRemoteSurface(app, "linux") || isRemoteSurface(app, "darwin"), app).toBe(false);
    }
  });
});
