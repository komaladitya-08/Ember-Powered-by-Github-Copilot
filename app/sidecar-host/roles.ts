/**
 * The AT-SPI vocabulary Ember's TypeScript side keys on (role names like "push button", state names like "sensitive"),
 * and how Windows UI Automation's control types and macOS AX roles map onto it. Ember's policy, labels, secret checks,
 * marks and routing match these strings literally (sidecar-consumers spec §6): a field given another role silently
 * loses its secret check and its labels, a button its risky-word check. So fields are only ever "text", "entry",
 * "password text", "spin button" or "combo box" (never "search"), buttons "push button" (never "button"), console text
 * "terminal", web pages "document web", and every enabled element says both "enabled" and "sensitive".
 *
 * The role sets mirror ember_atspi.py's (keep them in step): the host applies the same rules to them.
 */

import type { RawNode } from "./provider";

/** Containers that only group or decorate: not listed unless named (their children are). */
export const SKIP_ROLES = new Set(["filler", "panel", "section", "redundant object", "glass pane", "layered pane", "root pane",
  "scroll pane", "viewport", "split pane", "internal frame", "option pane", "unknown"]);
export const MENU_ITEM_ROLES = new Set(["menu item", "check menu item", "radio menu item"]);
/** The only states that reach Ember, in this order. */
export const INTERESTING_STATES = ["focused", "checked", "selected", "expanded", "collapsed", "pressed", "editable",
  "multi line", "sensitive", "enabled", "focusable", "active"] as const;
/** Controls worth listing actions for. Keep in step with INTERACTIVE in elements.ts. */
export const INTERACTIVE_ROLES = new Set(["push button", "toggle button", "check box", "radio button", "combo box", "text", "entry",
  "password text", "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "table cell", "check menu item",
  "radio menu item", "tree item", "switch", "icon", "table column header", "column header", "table row header", "row header",
  "terminal", "document text", "paragraph"]);
/** Rows and cells (hundreds of them): their actions are looked up when one is used, not listed. */
export const LAZY_ACTION_ROLES = new Set(["list item", "table cell", "tree item", "table column header", "column header",
  "table row header", "row header"]);
export const TEXT_ROLES = new Set(["text", "entry", "password text", "terminal", "paragraph", "document text", "spin button", "combo box"]);
/** Text blocks that say what they hold only as text when unnamed (outside web pages). */
export const UNNAMED_TEXT_ROLES = new Set(["heading", "block quote"]);
export const VALUE_ROLES = new Set(["slider", "spin button", "scroll bar", "progress bar", "level bar", "dial"]);
/** Input fields, whose name or label can make their contents secret. Keep in step with FIELD_ROLES in elements.ts. */
export const FIELD_ROLES = new Set(["text", "entry", "password text", "spin button", "combo box"]);
/** Text that labels a control. Keep in step with LABEL_ROLES in elements.ts. */
export const LABEL_ROLES = new Set(["label", "static", "caption"]);
/** The window itself: where looking up from an element stops. */
export const WINDOW_ROLES = new Set(["frame", "window", "dialog", "alert", "file chooser", "desktop frame", "application"]);
/** Web pages and documents: what is in one shows inside it. */
export const DOCUMENT_ROLES = new Set(["document web", "document frame"]);
/**
 * Containers whose bounds bound what their children show. AT-SPI's scroll panes and viewports; and lists, trees and
 * tables, which UI Automation reports at the size of their view (a row scrolled half out of a list reports all of its
 * own rectangle). AX reports a list at the size of its contents, inside a scroll area, where clipping changes nothing.
 */
export const CLIP_ROLES = new Set(["scroll pane", "viewport", "list", "list box", "tree", "tree table", "table"]);
/** Containers that only group: an empty one at a point tells nothing about what shows there. */
export const GENERIC_ROLES = new Set(["panel", "filler", "unknown", "redundant object"]);
/** Lists of rows whose rows are their options (select_option chooses a row by its words). */
export const ROW_LIST_ROLES = new Set(["table", "tree table", "tree"]);
/**
 * Items whose own action may open them where a single click only selects them (Explorer's files, a file dialog's
 * rows, GTK's cells): a click on one selects it instead (see actions.ts insteadOfAction).
 */
export const ROW_CELL_ROLES = new Set(["table cell", "tree item"]);
export const ITEM_ROLES = new Set(["list item", "icon"]);
/** A control's own actions, as opposed to one handed on to an ancestor or its context menu. */
export const OWN_ACTIONS = new Set(["click", "press", "activate", "jump", "open", "select", "toggle", "check", "uncheck", "expand or contract"]);
/** Actions that hand a click on to an ancestor (Chromium's "clickAncestor"; a default action on what isn't a control). */
export const PASSES_CLICK = new Set(["clickancestor", "dodefault"]);
/** What a click acts on itself: a click on what is inside one of these goes to it. */
export const CLICK_CONTROLS = new Set([...INTERACTIVE_ROLES].filter(r => !TEXT_ROLES.has(r) && r !== "terminal"));
/** Where looking for the control around an element stops: its page or window. */
export const HANDLER_STOP = new Set(["document web", "document frame", "frame", "window", "dialog", "alert", "file chooser",
  "application", "desktop frame"]);

/** Where an element sits, which some roles depend on (a static text inside a web page is "static", elsewhere "label"). */
export interface RoleContext {
  /** 0: a top-level window. */
  depth: number;
  /** Inside a web page (a "document web"). */
  inWeb: boolean;
  /** Inside a console or terminal window (its text is "terminal"). */
  inTerminal: boolean;
  /** The parent's role in AT-SPI's words ("" for none). */
  parentRole: string;
}

/** The context of a top-level window, or of an element whose surroundings aren't known. */
export const TOP: RoleContext = { depth: 0, inWeb: false, inTerminal: false, parentRole: "" };

/** UI frameworks whose documents are web pages (Chromium, Edge, Electron apps; Firefox). */
const WEB_FRAMEWORKS = new Set(["chrome", "gecko"]);
/**
 * Window classes of consoles and terminals (conhost, Windows Terminal, the pseudo console, mintty, PuTTY, ConEmu):
 * text in them is "terminal", which the policy never types into.
 */
const TERMINAL_CLASSES = new Set(["consolewindowclass", "cascadia_hosting_window_class", "termcontrol", "pseudoconsolewindow",
  "mintty", "putty", "virtualconsoleclass"]);
/** Win32's dialog box class (MessageBox, property sheets). */
const DIALOG_CLASS = "#32770";

/** Is this element (by its class) a console or terminal, inside which text is "terminal"? */
export const isTerminalClass = (n: Pick<RawNode, "className">) => !!n.className && TERMINAL_CLASSES.has(n.className.toLowerCase());

const has = (n: RawNode, action: string) => !!n.actions?.includes(action);

/** A UI Automation element's role in AT-SPI's words. */
export function uiaRole(n: RawNode, ctx: RoleContext): string {
  const cls = (n.className ?? "").toLowerCase();
  if (ctx.depth === 0) {
    // Top-level: the window the protocol reads (Chromium's main window is a Pane), or a popup of its own.
    switch (n.platformRole) {
      case "Window": return n.modal || cls === DIALOG_CLASS ? "dialog" : "frame";
      case "Pane": return "frame";
      case "Menu": return "menu";
      case "ToolTip": return "tool tip";
      default: return "window";
    }
  }
  // Whatever its control type (a custom control, a combo box's edit), a password field is one: its text is never read,
  // it is never typed into, and it is masked in pictures.
  if (n.password) return "password text";
  switch (n.platformRole) {
    case "Window": return n.modal || cls === DIALOG_CLASS ? "dialog" : "internal frame";
    case "Pane": return "panel";
    case "Button":
      if (cls.includes("toggleswitch")) return "switch";
      return n.toggle !== undefined || has(n, "toggle") ? "toggle button" : "push button";
    case "SplitButton": return "push button";
    case "CheckBox": return cls.includes("toggleswitch") ? "switch" : "check box";
    case "RadioButton": return "radio button";
    case "ComboBox": return "combo box";
    case "Edit":
      if (ctx.inTerminal || isTerminalClass(n)) return "terminal";
      return n.multiLine ? "text" : "entry";
    case "Document":
      if (ctx.inTerminal || isTerminalClass(n)) return "terminal";
      if (ctx.inWeb || WEB_FRAMEWORKS.has((n.framework ?? "").toLowerCase())) return "document web";
      return n.editable ? "document text" : "document frame";
    case "Text":
      if (ctx.inTerminal && n.hasText) return "terminal";
      if (ctx.inWeb) return (n.platformSubrole ?? "").toLowerCase() === "heading" ? "heading" : "static";
      return "label";
    case "Hyperlink": return "link";
    case "Image": return "image";
    case "List": return "list";
    case "ListItem": return "list item";
    case "Menu": return "menu";
    case "MenuBar": return "menu bar";
    case "MenuItem":
      // One that opens a submenu is a menu, as GTK's are (its `open` says whether its items show).
      if (n.expanded === true || n.expanded === false) return "menu";
      if (n.toggle !== undefined) return "check menu item";
      if (n.selected !== undefined) return "radio menu item";
      return "menu item";
    case "ProgressBar": return "progress bar";
    case "ScrollBar": return "scroll bar";
    case "Slider": return "slider";
    case "Spinner": return "spin button";
    case "StatusBar": return "status bar";
    case "Tab": return "page tab list";
    case "TabItem": return "page tab";
    case "Table": case "DataGrid": return "table";
    case "DataItem": return "table cell";
    case "Tree": return "tree";
    case "TreeItem": return "tree item";
    case "ToolBar": case "AppBar": return "tool bar";
    case "ToolTip": return "tool tip";
    case "TitleBar": return "title bar";
    case "Separator": return "separator";
    case "Group": return ctx.inWeb ? "section" : "panel";
    case "Header": case "SemanticZoom": return "panel";
    case "HeaderItem": return "table column header";
    case "Calendar": return "calendar";
    case "Custom":
      // A control drawn by its app: what it does says what it is.
      if (has(n, "toggle")) return "toggle button";
      if (has(n, "invoke")) return "push button";
      return "unknown";
    default: return "unknown";
  }
}

/** An AX element's role in AT-SPI's words. */
export function axRole(n: RawNode, ctx: RoleContext): string {
  const sub = n.platformSubrole ?? "";
  switch (n.platformRole) {
    case "AXWindow":
      if (sub === "AXDialog" || sub === "AXSystemDialog" || n.modal) return "dialog";
      if (sub === "AXFloatingWindow" || sub === "AXSystemFloatingWindow") return "window";
      return ctx.depth === 0 ? "frame" : "internal frame";
    case "AXSheet": return "dialog";
    case "AXApplication": return "application";
    case "AXButton": return sub === "AXSwitch" ? "switch" : sub === "AXToggle" ? "toggle button" : "push button";
    case "AXMenuButton": case "AXColorWell": return "push button";
    case "AXCheckBox": return sub === "AXSwitch" ? "switch" : sub === "AXToggle" ? "toggle button" : "check box";
    case "AXDisclosureTriangle": return "toggle button";
    case "AXRadioButton": return ctx.parentRole === "page tab list" ? "page tab" : "radio button";
    case "AXPopUpButton": case "AXComboBox": return "combo box";
    case "AXTextField": return sub === "AXSecureTextField" || n.password ? "password text" : "entry";
    case "AXSearchField": return "entry";
    case "AXTextArea":
      if (n.password) return "password text";
      if (ctx.inTerminal || isTerminalClass(n)) return "terminal";
      return "text";
    case "AXStaticText": return ctx.inWeb ? "static" : "label";
    case "AXHeading": return "heading";
    case "AXLink": return "link";
    case "AXImage": return "image";
    case "AXWebArea": return "document web";
    case "AXList": return "list";
    case "AXTable": case "AXGrid": return "table";
    case "AXOutline": return "tree";
    case "AXRow": return ctx.parentRole === "tree" || sub === "AXOutlineRow" ? "tree item" : "list item";
    case "AXCell": return "table cell";
    case "AXMenuBar": return "menu bar";
    case "AXMenuBarItem": case "AXMenu": return "menu";
    case "AXMenuItem": return "menu item";
    case "AXTabGroup": return "page tab list";
    case "AXSlider": return "slider";
    case "AXIncrementor": case "AXStepper": return "spin button";
    case "AXProgressIndicator": case "AXBusyIndicator": return "progress bar";
    case "AXLevelIndicator": case "AXRelevanceIndicator": return "level bar";
    case "AXScrollBar": return "scroll bar";
    case "AXScrollArea": return "scroll pane";
    case "AXSplitGroup": return "split pane";
    case "AXSplitter": return "separator";
    case "AXToolbar": return "tool bar";
    case "AXHelpTag": return "tool tip";
    case "AXGroup": return ctx.inWeb ? "section" : "panel";
    case "AXLayoutArea": case "AXDrawer": case "AXBrowser": case "AXRadioGroup": return "panel";
    case "AXDateField": case "AXTimeField": return "entry";
    default: return "unknown";
  }
}

/** An element's role in AT-SPI's words, by its provider's vocabulary. */
export const atspiRole = (vocabulary: "uia" | "ax", n: RawNode, ctx: RoleContext): string =>
  vocabulary === "ax" ? axRole(n, ctx) : uiaRole(n, ctx);

/** The context of an element's children (`role`: the element's own). */
export function childContext(ctx: RoleContext, n: RawNode, role: string): RoleContext {
  return {
    depth: ctx.depth + 1,
    inWeb: ctx.inWeb || role === "document web",
    inTerminal: ctx.inTerminal || isTerminalClass(n),
    parentRole: role,
  };
}

/**
 * An element's states in AT-SPI's words (only those Ember uses, in their order). An enabled element says "sensitive"
 * and "enabled" both: Ember counts one with neither as disabled and refuses to act on it. `active`: the window the user
 * is in (said on the window itself).
 */
export function statesOf(n: RawNode, role: string, active = false): string[] {
  const radio = role === "radio button" || role === "radio menu item";
  const toggles = role === "toggle button";
  const on = n.toggle === "on" || (radio && n.selected === true);
  const has = new Set<string>();
  if (n.focused) has.add("focused");
  if (on) has.add("checked");
  if (n.selected && !radio) has.add("selected");
  if (n.expanded === true) has.add("expanded");
  if (n.expanded === false) has.add("collapsed");
  if (toggles && on) has.add("pressed");
  if (n.editable) has.add("editable");
  if (n.multiLine || role === "document text") has.add("multi line");
  if (n.enabled !== false) { has.add("sensitive"); has.add("enabled"); }
  if (n.focusable) has.add("focusable");
  if (active) has.add("active");
  return INTERESTING_STATES.filter(s => has.has(s));
}

/** Is the element checked or on (a check box, switch, toggle button, radio button), as one-way actions are judged? */
export const isChecked = (n: RawNode, role: string) => statesOf(n, role).includes("checked");

/**
 * The element's actions as AT-SPI names them, in the order a click looks for them: "click" (UIA Invoke, AX press),
 * "toggle", "select" (one-way: never used on what is chosen already), "expand or contract", and "dodefault" (UIA's
 * LegacyIAccessible default action: the app's own verb, which may hand the click on to an ancestor).
 */
export function actionNames(n: RawNode): string[] {
  const out: string[] = [];
  if (has(n, "invoke")) out.push("click");
  if (has(n, "toggle")) out.push("toggle");
  if (has(n, "select")) out.push("select");
  if (has(n, "expand") || has(n, "collapse")) out.push("expand or contract");
  if (has(n, "legacy")) out.push("dodefault");
  return out;
}
