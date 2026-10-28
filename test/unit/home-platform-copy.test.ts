/**
 * The settings window's OS words (§4.21): without an OS in the status the page keeps today's Linux markup, Linux's status
 * changes nothing, and a Windows or macOS status fills in that OS's chords, folders and consent sentences. The page is
 * read from home/index.html and the patches are applied the way home/main.ts applies them, so ids and markup are checked
 * together; there is no DOM in these tests, only a small parser for the page's own well-formed markup.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LINUX_ENTRY_WORDS, NEVER_LOOK_DEFAULTS, auditCopySegments, auditDirLabel, chordSegments, describeEntry, emptyConversationText, entryWords, homePatches,
  keyLabel, MANAGED_ROW, micOffText, missingDefaults, rereadsStatusOnFocus, tagline, type HomePatch, type Segment,
} from "../../app/renderer/home/copy";
import type { StatusPlatform } from "../../app/shared/ipc";
import { SHORTCUTS, type OS, type ShortcutId } from "../../app/shared/shortcuts";
import { PLATFORM_WORDS } from "../../app/shared/words";
import { NEVER_LOOK_DEFAULTS as NEVER_LOOK_BY_OS } from "../../app/shared/never-look";
import { consentPanel } from "../../app/main/remote/prompt-window";
import { keyHintText, statusLine } from "../../app/renderer/command/copy";

// ───── A small model of the page: elements, attributes and text, as home/index.html writes them ─────
interface El { tag: string; attrs: Record<string, string>; children: Node[] }
type Node = El | string;
const VOID = new Set(["meta", "link", "input", "br", "img"]);
const decode = (t: string) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"");

function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const token = /<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/giy;
  let at = 0;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    at = token.lastIndex;
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) top.children.push(decode(m[4]));
    else if (m[1]) {
      if (top.tag !== m[1].toLowerCase()) throw new Error(`</${m[1]}> closes <${top.tag}>`);
      stack.pop();
    } else if (m[2]) {
      const attrs = Object.fromEntries([...m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)].map(a => [a[1].toLowerCase(), decode(a[2] ?? "")]));
      const el: El = { tag: m[2].toLowerCase(), attrs, children: [] };
      top.children.push(el);
      if (!VOID.has(el.tag)) stack.push(el);
    }
  }
  // Everything was read and every element closed: the model is the whole page.
  if (at !== html.length || stack.length !== 1) throw new Error(`unparsed markup at ${at}`);
  return root;
}

const elements = (n: Node): El[] => (typeof n === "string" ? [] : [n, ...n.children.flatMap(elements)]);
/** home/main.ts's two selector forms: `#id` and `[data-shortcut="…"]`. */
function select(root: El, selector: string): El[] {
  const id = /^#([\w-]+)$/.exec(selector);
  const chord = /^\[data-shortcut="([\w-]+)"\]$/.exec(selector);
  if (!id && !chord) throw new Error(`unexpected selector ${selector}`);
  return elements(root).filter(e => (id ? e.attrs.id === id[1] : e.attrs["data-shortcut"] === chord![1]));
}
const byId = (root: El, id: string) => {
  const found = select(root, `#${id}`);
  expect(found, id).toHaveLength(1);
  return found[0];
};
/** As home/main.ts's applyPatch: content replaces the children (<kbd>, <code> or text); hidden sets or clears the attribute; attrs are set. */
function apply(root: El, patches: HomePatch[]): El {
  for (const p of patches) {
    const found = select(root, p.selector);
    expect(found.length, p.selector).toBeGreaterThan(0);
    for (const el of found) {
      if (p.content) el.children = p.content.map((s: Segment): Node => (typeof s === "string" ? s : "kbd" in s ? { tag: "kbd", attrs: {}, children: [s.kbd] } : { tag: "code", attrs: {}, children: [s.code] }));
      if (p.hidden === true) el.attrs.hidden = "";
      if (p.hidden === false) delete el.attrs.hidden;
      Object.assign(el.attrs, p.attrs);
    }
  }
  return root;
}
/** Markup with adjacent text joined, so a patched tree compares equal to the page it reproduces. */
const markup = (n: Node): string => (typeof n === "string" ? n
  : `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v}"`)).join("")}>${n.children.map(markup).join("")}</${n.tag}>`);
/** What a person reads in an element: hidden descendants left out, white space collapsed as the browser does. */
const shown = (n: Node): string => (typeof n === "string" ? n : "hidden" in n.attrs ? "" : n.children.map(shown).join(""));
const visible = (el: El) => shown(el).replace(/\s+/g, " ").trim();

const PAGE = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
const STYLES = readFileSync(new URL("../../app/renderer/home/styles.css", import.meta.url), "utf8");
const page = () => parse(PAGE);
/** The paragraph or list item an id sits in (the sentence a person reads around it). */
const around = (root: El, id: string): El => {
  const path = (n: El, trail: El[]): El[] | null => {
    if (n.attrs.id === id) return trail;
    for (const c of n.children) if (typeof c !== "string") { const p = path(c, [...trail, c]); if (p) return p; }
    return null;
  };
  const trail = path(root, [])!;
  return [...trail].reverse().find(e => e.tag === "p" || e.tag === "li")!;
};

// ───── Statuses as main builds them on each OS (§4.1 item 12) ─────
const shortcuts = (os: OS) => Object.fromEntries(Object.entries(SHORTCUTS[os]).map(([id, d]) => [id, { label: d.label, keys: d.keys }])) as StatusPlatform["shortcuts"];
const LINUX: StatusPlatform = {
  os: "linux", shortcuts: shortcuts("linux"), dataDir: "~/.config/ember", settingsFile: "~/.config/ember/settings.json",
  auditCopy: "the system journal (journalctl -t ember-audit)", micIndicator: PLATFORM_WORDS.linux.micIndicator, permissionsNote: PLATFORM_WORDS.linux.permissionsNote,
  speakerRejection: true, fixLabels: { "enable-accessibility": "Turn on" }, desk: true, autostartNote: null,
};
const WINDOWS: StatusPlatform = {
  os: "win32", shortcuts: shortcuts("win32"), dataDir: "%LOCALAPPDATA%\\ember", settingsFile: "%LOCALAPPDATA%\\ember\\settings.json",
  auditCopy: null, micIndicator: PLATFORM_WORDS.win32.micIndicator, permissionsNote: PLATFORM_WORDS.win32.permissionsNote,
  speakerRejection: false, fixLabels: { "open-microphone-settings": "Open Settings", "unblock-helper": "Unblock it" }, desk: false, autostartNote: null,
};
const MAC: StatusPlatform = {
  os: "darwin", shortcuts: shortcuts("darwin"), dataDir: "~/Library/Application Support/ember", settingsFile: "~/Library/Application Support/ember/settings.json",
  auditCopy: null, micIndicator: PLATFORM_WORDS.darwin.micIndicator, permissionsNote: PLATFORM_WORDS.darwin.permissionsNote,
  speakerRejection: false, fixLabels: { "open-accessibility-settings": "Open System Settings" }, desk: false,
  autostartNote: "Ember can start when you log in once you allow it in System Settings › General › Login Items.",
};

/** Today's sentences around everything the OS changes (before the port, verbatim). */
const TODAY = {
  "permissions-note": "It reads the window you're working in through the desktop's accessibility service, and for tasks it may take a screenshot of it. Windows on your never-look list and password prompts are never read.",
  // What the audit log keeps of each task (its request and how it went) is said, not denied (review #87).
  "data-dir": "On this computer it keeps your settings, logs and a record of every task and action it took, including what you asked for and how it went (kept 30 days), in ~/.config/ember. The rest of your conversation with Ember is kept only while it runs. It sends no usage statistics.",
  "mic-indicator": "Ember will keep the microphone open while it runs, listening only for “Hey Ember” and “Ember, stop”. That listening happens on this computer: no audio leaves it, and nothing is recorded. After you say “Hey Ember”, what you say next is turned into text on this computer, and only that text is sent to Copilot. After Ember answers, you have 8 seconds to follow up without saying “Hey Ember” again. To tell its own voice and your speakers apart from you, Ember also listens to what your speakers play (on this computer only), which keeps the sound output from going idle while Ember listens. GNOME shows a microphone icon while Ember listens. Ctrl+Alt+M turns the microphone off and on.",
  "audit-dir": "Every decision and action is also in ~/.config/ember/audit/ and in the system journal (journalctl -t ember-audit).",
} as const;
const CHORD_SENTENCES: Record<ShortcutId, string> = {
  stop: "It asks before acting in an app, and always before anything hard to undo. It never types passwords. Ctrl+Alt+X stops everything at once.",
  settings: "Press Ctrl+Alt+E any time to come back here, or click Ember's handle in the bottom-right corner.",
  ask: "Ask Ember anything with Ctrl+Alt+Space.",
  mute: TODAY["mic-indicator"],
  allow: "When Ember asks “May I?”, press Ctrl+Alt+Y to allow or Ctrl+Alt+N for not now; you don't need the mouse. With a screen reader running, Ember also speaks its questions and results, unless you turn that off under Voice.",
  deny: "When Ember asks “May I?”, press Ctrl+Alt+Y to allow or Ctrl+Alt+N for not now; you don't need the mouse. With a screen reader running, Ember also speaks its questions and results, unless you turn that off under Voice.",
};
const IDS: ShortcutId[] = ["ask", "stop", "settings", "mute", "allow", "deny"];
const t = "2026-10-22T09:00:00.000Z";

describe("the settings window before a status names an OS", () => {
  it("keeps today's Linux sentences around everything an OS changes", () => {
    const root = page();
    for (const [id, text] of Object.entries(TODAY)) expect(visible(around(root, id)), id).toBe(text);
    expect(byId(root, "autostart-note").attrs).toHaveProperty("hidden");
    expect(visible(byId(root, "autostart-note"))).toBe("");
  });

  it("keeps the empty conversation's hint in the list's data-empty, as the style sheet says it today", () => {
    expect(byId(page(), "conversation").attrs["data-empty"]).toBe(emptyConversationText());
    // The style sheet writes Linux's hint itself until it shows the attribute instead.
    const content = /\.conversation:empty::before \{ content: ([^;]+);/.exec(STYLES)![1];
    expect([JSON.stringify(emptyConversationText()), "attr(data-empty)"]).toContain(content);
  });

  it("marks every chord chip with its shortcut, each holding today's Linux key caps", () => {
    const root = page();
    const chips = elements(root).filter(e => e.attrs.class === "chord");
    expect(chips).toHaveLength(6);
    expect(chips.map(c => c.attrs["data-shortcut"]).sort()).toEqual([...IDS].sort());
    for (const chip of chips) {
      const id = chip.attrs["data-shortcut"] as ShortcutId;
      expect(chip.children.map(markup).join(""), id).toBe(SHORTCUTS.linux[id].keys.map(k => `<kbd>${k}</kbd>`).join("+"));
    }
    // The sentence each chip sits in reads as it did.
    const sentenceOf = (chip: El) => {
      const all = elements(root).filter(e => (e.tag === "p" || e.tag === "li") && elements(e).includes(chip));
      return visible(all[all.length - 1]);
    };
    for (const chip of chips) expect(sentenceOf(chip)).toBe(CHORD_SENTENCES[chip.attrs["data-shortcut"] as ShortcutId]);
  });

  it("writes today's strings when no OS is given", () => {
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline(base)).toBe("Ember is beside your cursor. Press Ctrl+Alt+Space to ask it anything.");
    expect(micOffText()).toBe("Microphone off (Ctrl+Alt+M to turn on)");
    expect(emptyConversationText()).toBe("Nothing yet. Press Ctrl+Alt+Space and ask Ember something.");
    expect(describeEntry({ t, event: "stop", source: "hotkey" })?.what).toBe("Everything stopped (Ctrl+Alt+X)");
    expect(describeEntry({ t, event: "stop", source: "voice" })?.what).toBe("Everything stopped (“Ember, stop”)");
    expect(entryWords(undefined)).toBe(LINUX_ENTRY_WORDS);
    expect([...NEVER_LOOK_DEFAULTS]).toEqual(["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"]);
    expect(missingDefaults(["Bitwarden"])).toEqual(["keepassxc", "seahorse", "passwords and keys", "1password", "polkit"]);
  });
});

describe("the settings window with Linux's status", () => {
  it("leaves the page exactly as it was (chords, folders, journal hint, consent, login note)", () => {
    expect(markup(apply(page(), homePatches(LINUX)))).toBe(markup(page()));
  });

  it("hides only the journal hint where nothing copies the audit log to the journal", () => {
    const root = apply(page(), homePatches({ ...LINUX, auditCopy: null }));
    expect(visible(around(root, "audit-dir"))).toBe("Every decision and action is also in ~/.config/ember/audit/.");
    const expected = page();
    byId(expected, "journal-hint").attrs.hidden = "";
    expect(markup(root)).toBe(markup(expected));
  });

  it("writes the same lines, tagline and voice text as without an OS", () => {
    const words = entryWords(LINUX);
    expect(words).toEqual(LINUX_ENTRY_WORDS);
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline(base, LINUX.shortcuts.ask.label)).toBe(tagline(base));
    expect(micOffText(LINUX.shortcuts.mute.label)).toBe(micOffText());
    for (const e of [{ t, event: "stop", source: "hotkey" }, { t, event: "action", kind: "keys", ok: true, value: "super+ctrl+alt+shift+Return", app: "mousepad" }]) {
      expect(describeEntry(e, words)).toEqual(describeEntry(e));
    }
  });
});

describe("the settings window with a Windows or macOS status", () => {
  it("shows Windows' chords, data folder and microphone icon, without the journal or the speakers", () => {
    const root = apply(page(), homePatches(WINDOWS));
    expect(visible(around(root, "data-dir"))).toBe(TODAY["data-dir"].replace("~/.config/ember", "%LOCALAPPDATA%\\ember"));
    expect(visible(around(root, "audit-dir"))).toBe("Every decision and action is also in %LOCALAPPDATA%\\ember\\audit\\.");
    expect(visible(around(root, "mic-indicator"))).toBe("Ember will keep the microphone open while it runs, listening only for “Hey Ember” and “Ember, stop”. That listening happens on this computer: no audio leaves it, and nothing is recorded. After you say “Hey Ember”, what you say next is turned into text on this computer, and only that text is sent to Copilot. After Ember answers, you have 8 seconds to follow up without saying “Hey Ember” again. Windows shows a microphone icon in the taskbar while Ember listens. Win+Alt+M turns the microphone off and on.");
    expect(visible(around(root, "permissions-note"))).toBe(TODAY["permissions-note"]);
    for (const id of IDS) for (const chip of select(root, `[data-shortcut="${id}"]`)) expect(chip.children.map(markup).join("")).toBe(`<kbd>Win</kbd>+<kbd>Alt</kbd>+<kbd>${SHORTCUTS.win32[id].keys[2]}</kbd>`);
    expect(visible(around(root, "journal-hint"))).not.toMatch(/journal/);
    expect(byId(root, "speaker-note").attrs).toHaveProperty("hidden");
    expect(byId(root, "autostart-note").attrs).toHaveProperty("hidden");
  });

  it("shows the Mac's chords, folder, permissions and orange dot, and the login note when there is one", () => {
    const root = apply(page(), homePatches(MAC));
    const chip = select(root, "[data-shortcut=\"stop\"]")[0];
    expect(chip.children.map(markup).join("")).toBe("<kbd>Control</kbd>+<kbd>Shift</kbd>+<kbd>Command</kbd>+<kbd>X</kbd>");
    expect(visible(around(root, "permissions-note"))).toBe(`${TODAY["permissions-note"]} macOS will ask you to allow Accessibility, Screen Recording and Input Monitoring for Ember.`);
    expect(visible(around(root, "data-dir"))).toContain("in ~/Library/Application Support/ember. The rest of your conversation");
    expect(visible(around(root, "audit-dir"))).toBe("Every decision and action is also in ~/Library/Application Support/ember/audit/.");
    expect(visible(around(root, "mic-indicator"))).toMatch(/again\. macOS shows an orange dot in the menu bar while Ember listens\. Control\+Shift\+Command\+M turns the microphone off and on\.$/);
    expect(visible(byId(root, "autostart-note"))).toBe(MAC.autostartNote);
    expect(byId(root, "autostart-note").attrs).not.toHaveProperty("hidden");
    // Applied again (the window refreshes its status when it comes back), the page is the same.
    expect(markup(apply(root, homePatches(MAC)))).toBe(markup(apply(page(), homePatches(MAC))));
    // The note goes once macOS has the login item.
    expect(byId(apply(root, homePatches({ ...MAC, autostartNote: null })), "autostart-note").attrs).toHaveProperty("hidden");
  });

  it("finds an element for every patch on every OS (the page and the patches name the same ids)", () => {
    for (const p of [LINUX, WINDOWS, MAC, { ...LINUX, auditCopy: null }]) {
      const root = page();
      for (const patch of homePatches(p)) expect(select(root, patch.selector).length, patch.selector).toBeGreaterThan(0);
    }
    for (const id of IDS) expect(select(page(), `[data-shortcut="${id}"]`), id).toHaveLength(1);
  });

  it("writes the OS's shortcuts in the tagline, the stop line and the voice line", () => {
    const base = { failing: 0, onboarded: true, phase: "ready", hidden: false, overlay: true };
    expect(tagline(base, WINDOWS.shortcuts.ask.label)).toBe("Ember is beside your cursor. Press Win+Alt+Space to ask it anything.");
    expect(tagline(base, MAC.shortcuts.ask.label)).toBe("Ember is beside your cursor. Press Control+Shift+Command+Space to ask it anything.");
    expect(micOffText(WINDOWS.shortcuts.mute.label)).toBe("Microphone off (Win+Alt+M to turn on)");
    expect(byId(apply(page(), homePatches(MAC)), "conversation").attrs["data-empty"]).toBe("Nothing yet. Press Control+Shift+Command+Space and ask Ember something.");
    expect(describeEntry({ t, event: "stop", source: "hotkey" }, entryWords(WINDOWS))?.what).toBe("Everything stopped (Win+Alt+X)");
    expect(describeEntry({ t, event: "stop", source: "hotkey" }, entryWords(MAC))?.what).toBe("Everything stopped (Control+Shift+Command+X)");
  });

  it("names keys the way each OS does", () => {
    expect(keyLabel("super+e", "win32")).toBe("Win+E");
    expect(keyLabel("ctrl+shift+Escape", "win32")).toBe("Ctrl+Shift+Esc");
    expect(keyLabel("cmd+s", "darwin")).toBe("Cmd+S");
    expect(keyLabel("ctrl+alt+shift+cmd+Return", "darwin")).toBe("Control+Option+Shift+Cmd+Enter");
    expect(describeEntry({ t, event: "action", kind: "keys", ok: true, value: "cmd+s", app: "TextEdit" }, entryWords(MAC))?.what).toBe("Press Cmd+S in TextEdit");
  });

  it("reads every spelling of a modifier as the OS names it (keys are logged as the model wrote them)", () => {
    expect(keyLabel("control+a", "darwin")).toBe(keyLabel("ctrl+a", "darwin"));
    expect(keyLabel("control+a", "darwin")).toBe("Control+A");
    expect(keyLabel("command+option+s", "darwin")).toBe("Cmd+Option+S");
    expect(keyLabel("opt+left", "darwin")).toBe("Option+Left");
    expect(keyLabel("super+space", "darwin")).toBe("Cmd+Space");
    expect(keyLabel("meta+e", "win32")).toBe("Win+E");
    expect(keyLabel("Control+Escape", "win32")).toBe("Ctrl+Esc");
  });

  it("reads the status again when the window comes back only off Linux (§9.8; Linux's read runs gsettings)", () => {
    expect(rereadsStatusOnFocus(undefined)).toBe(false);
    expect(rereadsStatusOnFocus(LINUX)).toBe(false);
    expect(rereadsStatusOnFocus(WINDOWS)).toBe(true);
    expect(rereadsStatusOnFocus(MAC)).toBe(true);
  });

  it("restores each OS's own never-look defaults", () => {
    for (const os of ["linux", "win32", "darwin"] as const) {
      expect(missingDefaults([], os)).toEqual([...NEVER_LOOK_BY_OS[os]]);
      expect(missingDefaults(NEVER_LOOK_BY_OS[os].map(x => x.toUpperCase()), os)).toEqual([]);
    }
  });
});

describe("keyLabel on Linux", () => {
  /** Today's KEY_NAMES (copy.ts before the port), verbatim: every "What Ember did" key line depends on them. */
  const TODAY_NAMES: Record<string, string> = {
    ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", meta: "Super", return: "Enter", enter: "Enter",
    escape: "Esc", esc: "Esc", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space", up: "Up", down: "Down",
    left: "Left", right: "Right", home: "Home", end: "End", pageup: "Page Up", page_up: "Page Up", prior: "Page Up",
    pagedown: "Page Down", page_down: "Page Down", next: "Page Down", insert: "Insert",
  };

  it("names every key as before, with or without the OS given", () => {
    expect(Object.keys(TODAY_NAMES)).toHaveLength(27);
    for (const [key, name] of Object.entries(TODAY_NAMES)) {
      for (const spelling of [key, key.toUpperCase(), key[0].toUpperCase() + key.slice(1)]) {
        expect(keyLabel(spelling), spelling).toBe(name);
        expect(keyLabel(spelling, "linux"), spelling).toBe(name);
      }
    }
    const all = Object.keys(TODAY_NAMES).join("+");
    expect(keyLabel(all, "linux")).toBe(Object.values(TODAY_NAMES).join("+"));
    expect(keyLabel("ctrl+alt+s")).toBe("Ctrl+Alt+S");
    expect(keyLabel("shift+F10", "linux")).toBe("Shift+F10");
    expect(keyLabel("Super_L+cmd", "linux")).toBe("Super_L+cmd");
  });

  it("keeps the non-modifier names on every OS", () => {
    const modifiers = new Set(["ctrl", "control", "alt", "shift", "super", "meta"]);
    for (const os of ["win32", "darwin"] as const) {
      for (const [key, name] of Object.entries(TODAY_NAMES)) if (!modifiers.has(key)) expect(keyLabel(key, os), `${os} ${key}`).toBe(name);
    }
  });
});

describe("the pieces of the OS's markup", () => {
  it("writes a chord's key caps with plus signs between them", () => {
    expect(chordSegments(["Ctrl", "Alt", "X"])).toEqual([{ kbd: "Ctrl" }, "+", { kbd: "Alt" }, "+", { kbd: "X" }]);
    expect(chordSegments(["F1"])).toEqual([{ kbd: "F1" }]);
  });

  it("puts the audit folder inside the data folder with the OS's separator", () => {
    expect(auditDirLabel({ os: "linux", dataDir: "~/.config/ember" })).toBe("~/.config/ember/audit/");
    expect(auditDirLabel({ os: "win32", dataDir: "D:\\Profiles\\ana\\ember\\" })).toBe("D:\\Profiles\\ana\\ember\\audit\\");
    expect(auditDirLabel({ os: "darwin", dataDir: "~/Library/Application Support/ember/" })).toBe("~/Library/Application Support/ember/audit/");
  });

  it("shows a command in brackets at the end of the journal hint as code", () => {
    expect(auditCopySegments("the system journal (journalctl -t ember-audit)")).toEqual([" and in the system journal (", { code: "journalctl -t ember-audit" }, ")"]);
    expect(auditCopySegments("the event log")).toEqual([" and in the event log"]);
  });
});

// ───── SSH, WSL and commands: each OS's stop chord in the new words (critique integration-22) ─────

describe("the stop chord in the SSH, WSL and commands words, per OS", () => {
  const OSES: OS[] = ["linux", "win32", "darwin"];

  it("writes each OS's own chord into the commands and SSH consent cards before they are hashed", () => {
    const hashes = new Set<string>();
    for (const os of OSES) {
      const stop = SHORTCUTS[os].stop.label;
      const commands = consentPanel({ feature: "commands", os, target: "local", targetLabel: "This computer" });
      expect(commands.body.at(-1)).toBe(`${stop} stops everything at once. What a command already changed stays changed.`);
      const ssh = consentPanel({ feature: "ssh", os, target: "ssh:build-01", targetLabel: "build-01", ssh: { login: "deploy", hostname: "build-01", port: 22, jump: [], desktop: "headless" } });
      expect(ssh.body[1]).toContain(`stops when you disconnect, quit Ember or press ${stop}. If the connection drops`);
      for (const other of OSES.filter(o => o !== os)) expect(JSON.stringify([commands, ssh])).not.toContain(SHORTCUTS[other].stop.label);
      hashes.add(commands.sha256);
    }
    // Each OS's card is its own text, so its own hash.
    expect(hashes.size).toBe(3);
    expect(consentPanel({ feature: "wsl", os: "win32", target: "wsl:Ubuntu", targetLabel: "Ubuntu (WSL)" }).body.join(" ")).not.toMatch(/\+X/);
  });

  it("writes each OS's approve keys in the command card's key hint", () => {
    expect(keyHintText("linux")).toBe("Ctrl+Alt+Y allow · Ctrl+Alt+N not now");
    expect(keyHintText("win32")).toBe("Win+Alt+Y allow · Win+Alt+N not now");
    expect(keyHintText("darwin")).toBe("Control+Shift+Command+Y allow · Control+Shift+Command+N not now");
  });

  it("names each OS's chord when the kill switch stopped a command", () => {
    for (const os of OSES) {
      expect(statusLine({ code: null, signal: null, ended: "killswitch", ms: 2000 }, { label: "build-01", os }))
        .toBe(`Stopped by ${SHORTCUTS[os].stop.label} after 2 s. What it already changed stays.`);
    }
  });
});

describe("Computers and Commands before the targets runtime answers", () => {
  it("keep both sections and their links hidden, so the window looks as it did", () => {
    const root = page();
    for (const id of ["computers", "commands", "jump-computers", "jump-commands"]) expect(byId(root, id).attrs, id).toHaveProperty("hidden");
    expect(byId(root, "computers-h").attrs.tabindex).toBe("-1");
    expect(byId(root, "commands-h").attrs.tabindex).toBe("-1");
    // The onboarding line sits in "Before Ember starts" (new users only), with no chord for the OS patches to change.
    const plug = elements(byId(root, "welcome")).filter(e => e.attrs["data-icon"] === "plug");
    expect(plug).toHaveLength(1);
    expect(visible(plug[0])).toBe("Other computers and commands are off until you turn them on: Ember can work in WSL, on computers you reach over SSH, and run commands in its own window. Each asks you first.");
    expect(elements(plug[0]).some(e => e.attrs.class === "chord")).toBe(false);
  });
});

describe("a voice control the organisation manages", () => {
  /** Element.closest for MANAGED_ROW's forms (a tag, or a class), on the page model: the element itself, then up. */
  const closest = (root: El, id: string, selector: string): El | null => {
    const trail = (n: El, up: El[]): El[] | null => {
      if (n.attrs.id === id) return [...up, n];
      for (const c of n.children) if (typeof c !== "string") { const t = trail(c, [...up, n]); if (t) return t; }
      return null;
    };
    const is = (e: El, one: string) => (one.startsWith(".") ? (e.attrs.class ?? "").split(/\s+/).includes(one.slice(1)) : e.tag === one);
    return [...trail(root, [])!].reverse().find(e => selector.split(",").some(one => is(e, one.trim()))) ?? null;
  };

  it.each([["wake", "Listen for “Hey Ember”"], ["speak", "Speak replies, questions and results out loud"]])(
    "dims its whole row, its words included: %s (review #55)", (id, words) => {
      const row = closest(page(), id, MANAGED_ROW);
      expect(row && visible(row)).toContain(words);
    });
});
