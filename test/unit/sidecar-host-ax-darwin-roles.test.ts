import { describe, expect, it } from "vitest";
import type { RawNode } from "../../app/sidecar-host/provider";
import { axOverlayRole, axRole, type RoleContext } from "../../app/sidecar-host/roles";
import { SECURITY_OWNERS } from "../../app/main/platform/darwin/model";

const node = (platformRole: string, more: Partial<RawNode> = {}): RawNode =>
  ({ handle: 1, key: "1:h1", parent: -1, depth: 1, platformRole, name: "", bounds: null, ...more });
const IN: RoleContext = { depth: 2, inWeb: false, inTerminal: false, parentRole: "panel" };

describe("the AX provider's additions to the AT-SPI roles", () => {
  it("calls a menu item with a check mark a check menu item, and one without a menu item", () => {
    expect(axRole(node("AXMenuItem", { toggle: "on" }), IN)).toBe("check menu item");
    expect(axRole(node("AXMenuItem"), IN)).toBe("menu item");
  });

  it("groups a popover's controls as a panel, and calls a secure text field a password field whatever reports it", () => {
    expect(axRole(node("AXPopover"), IN)).toBe("panel");
    expect(axRole(node("AXSecureTextField"), IN)).toBe("password text");
    expect(axRole(node("AXTextField", { password: true }), IN)).toBe("password text");
  });
});

describe("macOS shell overlays", () => {
  it("calls every credential and consent prompt's window a dialog, by the one owner list perception reads too", () => {
    for (const app of SECURITY_OWNERS) expect(axOverlayRole({ app })).toBe("dialog");
    expect(axOverlayRole({ app: "loginwindow" })).toBe("dialog");
  });

  it("calls the Dock's display-covering windows (Mission Control) an overview, and an app's window nothing", () => {
    expect(axOverlayRole({ app: "Dock" })).toBe("overview");
    for (const app of ["TextEdit", "osascript", "Safari", ""]) expect(axOverlayRole({ app })).toBeNull();
  });
});
