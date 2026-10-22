import { describe, expect, it } from "vitest";
import type { RawNode } from "../../app/sidecar-host/provider";
import { TOP, actionNames, axRole, childContext, statesOf, uiaRole, type RoleContext } from "../../app/sidecar-host/roles";

const node = (platformRole: string, more: Partial<RawNode> = {}): RawNode =>
  ({ handle: 1, key: "1:1", parent: -1, depth: 1, platformRole, name: "", bounds: null, ...more });
const IN: RoleContext = { depth: 2, inWeb: false, inTerminal: false, parentRole: "panel" };
const WEB: RoleContext = { ...IN, inWeb: true };
const TERM: RoleContext = { ...IN, inTerminal: true };

/** Every role Ember's TypeScript side knows (sidecar-consumers §6.1), plus decoration AT-SPI has. */
const KNOWN = new Set(["push button", "toggle button", "check box", "radio button", "switch", "text", "entry", "password text",
  "spin button", "combo box", "terminal", "document web", "document frame", "document text", "paragraph", "section", "heading",
  "label", "static", "menu item", "check menu item", "radio menu item", "menu", "menu bar", "link", "page tab", "page tab list",
  "list item", "tree item", "table cell", "icon", "table", "scroll bar", "list", "tree", "tree table", "tool bar", "status bar",
  "panel", "unknown", "scroll pane", "split pane", "internal frame", "frame", "window", "dialog", "application", "image",
  "separator", "tool tip", "title bar", "slider", "progress bar", "level bar", "table column header", "calendar"]);

describe("UI Automation roles in AT-SPI's words", () => {
  it("names top-level windows as frames, dialogs and popups", () => {
    expect(uiaRole(node("Window", { depth: 0 }), TOP)).toBe("frame");
    expect(uiaRole(node("Window", { depth: 0, modal: true }), TOP)).toBe("dialog");
    expect(uiaRole(node("Window", { depth: 0, className: "#32770" }), TOP)).toBe("dialog");
    // Chromium's main window is a Pane.
    expect(uiaRole(node("Pane", { depth: 0, className: "Chrome_WidgetWin_1" }), TOP)).toBe("frame");
    expect(uiaRole(node("Menu", { depth: 0, className: "#32768" }), TOP)).toBe("menu");
    expect(uiaRole(node("List", { depth: 0, className: "ComboLBox" }), TOP)).toBe("window");
  });

  it("says push button, never button; toggles and switches by what they do", () => {
    expect(uiaRole(node("Button", { actions: ["invoke"] }), IN)).toBe("push button");
    expect(uiaRole(node("SplitButton"), IN)).toBe("push button");
    expect(uiaRole(node("Button", { toggle: "off", actions: ["toggle"] }), IN)).toBe("toggle button");
    expect(uiaRole(node("Button", { className: "ToggleSwitch", toggle: "on" }), IN)).toBe("switch");
    expect(uiaRole(node("CheckBox", { className: "ToggleSwitch" }), IN)).toBe("switch");
    expect(uiaRole(node("CheckBox"), IN)).toBe("check box");
    expect(uiaRole(node("RadioButton"), IN)).toBe("radio button");
  });

  it("names fields so their secret checks and labels apply: entry (never search), text, password text, terminal", () => {
    expect(uiaRole(node("Edit"), IN)).toBe("entry");
    expect(uiaRole(node("Edit", { name: "Search" }), IN)).toBe("entry");
    expect(uiaRole(node("Edit", { multiLine: true }), IN)).toBe("text");
    expect(uiaRole(node("Edit", { password: true }), IN)).toBe("password text");
    // Whatever control type a password field has (a custom control, one in a console): it is one.
    for (const type of ["Custom", "Document", "Pane", "Text"]) expect(uiaRole(node(type, { password: true }), IN)).toBe("password text");
    expect(uiaRole(node("Edit", { password: true }), TERM)).toBe("password text");
    expect(uiaRole(node("Edit"), TERM)).toBe("terminal");
    expect(uiaRole(node("Document", { className: "ConsoleWindowClass" }), IN)).toBe("terminal");
    expect(uiaRole(node("Text", { hasText: true }), TERM)).toBe("terminal");
    expect(uiaRole(node("ComboBox"), IN)).toBe("combo box");
    expect(uiaRole(node("Spinner"), IN)).toBe("spin button");
  });

  it("says document web for a web page, document text for an editor, static for a page's text", () => {
    expect(uiaRole(node("Document", { framework: "Chrome" }), IN)).toBe("document web");
    expect(uiaRole(node("Document", { framework: "Gecko" }), IN)).toBe("document web");
    expect(uiaRole(node("Document"), WEB)).toBe("document web");
    expect(uiaRole(node("Document", { editable: true }), IN)).toBe("document text");
    expect(uiaRole(node("Document"), IN)).toBe("document frame");
    expect(uiaRole(node("Text"), IN)).toBe("label");
    expect(uiaRole(node("Text"), WEB)).toBe("static");
    expect(uiaRole(node("Text", { platformSubrole: "heading" }), WEB)).toBe("heading");
    expect(uiaRole(node("Group"), WEB)).toBe("section");
    expect(uiaRole(node("Group"), IN)).toBe("panel");
  });

  it("names menus, tabs, lists, trees and tables as AT-SPI does", () => {
    expect(uiaRole(node("MenuItem"), IN)).toBe("menu item");
    expect(uiaRole(node("MenuItem", { expanded: false }), IN)).toBe("menu");
    expect(uiaRole(node("MenuItem", { toggle: "on" }), IN)).toBe("check menu item");
    expect(uiaRole(node("MenuItem", { selected: true }), IN)).toBe("radio menu item");
    expect(uiaRole(node("MenuBar"), IN)).toBe("menu bar");
    expect(uiaRole(node("Tab"), IN)).toBe("page tab list");
    expect(uiaRole(node("TabItem"), IN)).toBe("page tab");
    expect(uiaRole(node("ListItem"), IN)).toBe("list item");
    expect(uiaRole(node("TreeItem"), IN)).toBe("tree item");
    expect(uiaRole(node("DataGrid"), IN)).toBe("table");
    expect(uiaRole(node("DataItem"), IN)).toBe("table cell");
    expect(uiaRole(node("HeaderItem"), IN)).toBe("table column header");
    expect(uiaRole(node("Hyperlink"), IN)).toBe("link");
    expect(uiaRole(node("Custom", { actions: ["invoke"] }), IN)).toBe("push button");
    expect(uiaRole(node("Custom"), IN)).toBe("unknown");
  });

  it("only ever says roles Ember knows", () => {
    const types = ["Window", "Pane", "Button", "SplitButton", "CheckBox", "RadioButton", "ComboBox", "Edit", "Document", "Text",
      "Hyperlink", "Image", "List", "ListItem", "Menu", "MenuBar", "MenuItem", "ProgressBar", "ScrollBar", "Slider", "Spinner",
      "StatusBar", "Tab", "TabItem", "Table", "DataGrid", "DataItem", "Tree", "TreeItem", "ToolBar", "AppBar", "ToolTip",
      "TitleBar", "Separator", "Group", "Header", "HeaderItem", "Calendar", "Custom", "Thumb", "SemanticZoom", "Nonsense"];
    for (const t of types) for (const ctx of [TOP, IN, WEB, TERM]) {
      const role = uiaRole(node(t, { depth: ctx.depth }), ctx);
      expect(KNOWN.has(role), `${t} → ${role}`).toBe(true);
      expect(["button", "search", "search box"]).not.toContain(role);
    }
  });
});

describe("AX roles in AT-SPI's words", () => {
  it("maps macOS controls onto the same vocabulary", () => {
    expect(axRole(node("AXWindow", { platformSubrole: "AXStandardWindow", depth: 0 }), TOP)).toBe("frame");
    expect(axRole(node("AXWindow", { platformSubrole: "AXDialog", depth: 0 }), TOP)).toBe("dialog");
    expect(axRole(node("AXSheet"), IN)).toBe("dialog");
    expect(axRole(node("AXButton"), IN)).toBe("push button");
    expect(axRole(node("AXCheckBox", { platformSubrole: "AXSwitch" }), IN)).toBe("switch");
    expect(axRole(node("AXCheckBox", { platformSubrole: "AXToggle" }), IN)).toBe("toggle button");
    expect(axRole(node("AXTextField", { platformSubrole: "AXSecureTextField" }), IN)).toBe("password text");
    expect(axRole(node("AXSearchField"), IN)).toBe("entry");
    expect(axRole(node("AXTextArea"), IN)).toBe("text");
    expect(axRole(node("AXTextArea"), TERM)).toBe("terminal");
    expect(axRole(node("AXStaticText"), IN)).toBe("label");
    expect(axRole(node("AXStaticText"), WEB)).toBe("static");
    expect(axRole(node("AXWebArea"), IN)).toBe("document web");
    expect(axRole(node("AXPopUpButton"), IN)).toBe("combo box");
    expect(axRole(node("AXRadioButton"), { ...IN, parentRole: "page tab list" })).toBe("page tab");
    expect(axRole(node("AXRadioButton"), IN)).toBe("radio button");
    expect(axRole(node("AXRow"), { ...IN, parentRole: "tree" })).toBe("tree item");
    expect(axRole(node("AXRow"), IN)).toBe("list item");
    expect(axRole(node("AXScrollArea"), IN)).toBe("scroll pane");
    expect(axRole(node("AXMenuBarItem"), IN)).toBe("menu");
  });

  it("only ever says roles Ember knows", () => {
    const roles = ["AXWindow", "AXSheet", "AXApplication", "AXButton", "AXMenuButton", "AXCheckBox", "AXDisclosureTriangle",
      "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXTextField", "AXSearchField", "AXTextArea", "AXStaticText", "AXHeading",
      "AXLink", "AXImage", "AXWebArea", "AXList", "AXTable", "AXOutline", "AXRow", "AXCell", "AXMenuBar", "AXMenu", "AXMenuItem",
      "AXTabGroup", "AXSlider", "AXIncrementor", "AXProgressIndicator", "AXLevelIndicator", "AXScrollBar", "AXScrollArea",
      "AXSplitGroup", "AXSplitter", "AXToolbar", "AXHelpTag", "AXGroup", "AXLayoutArea", "AXUnknown"];
    for (const r of roles) for (const ctx of [TOP, IN, WEB, TERM]) {
      const role = axRole(node(r), ctx);
      expect(KNOWN.has(role), `${r} → ${role}`).toBe(true);
    }
  });
});

describe("states in AT-SPI's words", () => {
  it("says sensitive and enabled for every enabled element, and neither for a disabled one", () => {
    expect(statesOf(node("Button"), "push button")).toEqual(["sensitive", "enabled"]);
    expect(statesOf(node("Button", { enabled: true }), "push button")).toEqual(["sensitive", "enabled"]);
    expect(statesOf(node("Button", { enabled: false }), "push button")).toEqual([]);
  });

  it("says checked for a ticked box, switch or chosen radio button, and pressed too for a toggle button", () => {
    expect(statesOf(node("CheckBox", { toggle: "on" }), "check box")).toContain("checked");
    expect(statesOf(node("CheckBox", { toggle: "mixed" }), "check box")).not.toContain("checked");
    expect(statesOf(node("Button", { toggle: "on" }), "toggle button")).toEqual(expect.arrayContaining(["checked", "pressed"]));
    const radio = statesOf(node("RadioButton", { selected: true }), "radio button");
    expect(radio).toContain("checked");
    expect(radio).not.toContain("selected");
    expect(statesOf(node("ListItem", { selected: true }), "list item")).toContain("selected");
  });

  it("says focused, focusable, editable, multi line, expanded, collapsed and active where they hold, in Ember's order", () => {
    expect(statesOf(node("Edit", { focused: true, focusable: true, editable: true }), "entry")).toEqual(["focused", "editable", "sensitive", "enabled", "focusable"]);
    expect(statesOf(node("Document", { editable: true }), "document text")).toEqual(["editable", "multi line", "sensitive", "enabled"]);
    expect(statesOf(node("ComboBox", { expanded: true }), "combo box")).toContain("expanded");
    expect(statesOf(node("ComboBox", { expanded: false }), "combo box")).toContain("collapsed");
    expect(statesOf(node("TreeItem", { expanded: null }), "tree item")).toEqual(["sensitive", "enabled"]);
    expect(statesOf(node("Window", { depth: 0 }), "frame", true)).toEqual(["sensitive", "enabled", "active"]);
  });
});

describe("action names", () => {
  it("names a platform's actions as AT-SPI does, in the order a click looks for them", () => {
    expect(actionNames(node("Button", { actions: ["focus", "legacy", "invoke"] }))).toEqual(["click", "dodefault"]);
    expect(actionNames(node("CheckBox", { actions: ["toggle"] }))).toEqual(["toggle"]);
    expect(actionNames(node("ListItem", { actions: ["select", "expand", "collapse"] }))).toEqual(["select", "expand or contract"]);
    expect(actionNames(node("Edit", { actions: ["setValue", "focus"] }))).toEqual([]);
  });

  it("carries where an element sits to its children", () => {
    const doc = node("Document", { framework: "Chrome" });
    const inside = childContext(IN, doc, uiaRole(doc, IN));
    expect(inside).toMatchObject({ depth: 3, inWeb: true, parentRole: "document web" });
    const con = node("Window", { className: "ConsoleWindowClass" });
    expect(childContext(TOP, con, "frame").inTerminal).toBe(true);
  });
});
