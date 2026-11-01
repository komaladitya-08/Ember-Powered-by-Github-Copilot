/**
 * The policy on each OS (design §2.4, §4.11): macOS shortcuts with ⌘ are judged like Ctrl ones on Linux, each OS's
 * system keys and Ember's own shortcut families are refused, the key tables and every exported key helper give Linux
 * exactly today's answers (frozen copies of them), and the per-OS vocabulary's Linux rows are the old expressions.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import {
  PolicyEngine, canonicalKeys, isActivatingKey, isSecurityWindow, isSystemKey, keyLabel, keyTables, normalizeKeys, plainQuestion,
  refusesTyping, replacesSelection, typedChar, typesCharacter, type ActionRequest,
} from "../../app/main/policy/policy";
import {
  FILE_PATH_WORDS, OFFICE_APP, RISKY_EXTRA, RUN_FILE_DIALOG_EXTRA, RUNS_PROGRAM_EXTRA, SECURITY_APP, SECURITY_CLASS, SECURITY_TITLE, TABBED_APP,
  TERMINAL_REQUEST, TYPING_REFUSED, WEB_APP,
} from "../../app/main/policy/vocabulary";

const engine = (o: Partial<ConstructorParameters<typeof PolicyEngine>[0]> = {}) => new PolicyEngine({ neverLook: () => [], grants: () => ({}), ...o });
const keys = (value: string, extra: Partial<ActionRequest> = {}): ActionRequest => ({ taskId: "t", kind: "keys", app: "TextEdit", window: "notes.txt", value, ...extra });

describe("the Linux key tables and helpers stay as they were", () => {
  it("builds the Linux tables from the \"mod\" templates equal to today's lists (frozen copies)", () => {
    const t = keyTables(KEYS.linux);
    expect([...t.safe]).toEqual(["ctrl+a", "ctrl+c", "ctrl+x", "ctrl+v", "ctrl+z", "ctrl+y", "ctrl+shift+z", "ctrl+b", "ctrl+i", "ctrl+u", "ctrl+f", "ctrl+g",
      "ctrl+h", "ctrl+s", "ctrl+shift+s", "ctrl+n", "ctrl+t", "ctrl+l", "ctrl+o", "ctrl+home", "ctrl+end", "ctrl+left", "ctrl+right", "ctrl+up",
      "ctrl+down", "ctrl+shift+left", "ctrl+shift+right", "ctrl+shift+home", "ctrl+shift+end", "ctrl+backspace", "ctrl+plus", "ctrl+minus",
      "ctrl+equal", "ctrl+0", "ctrl+tab", "ctrl+shift+tab", "ctrl+prior", "ctrl+next"]);
    expect([...t.destructive]).toEqual(["delete", "shift+delete", "ctrl+delete", "ctrl+shift+delete", "ctrl+return", "alt+return",
      "ctrl+shift+return", "alt+f4", "ctrl+q", "ctrl+w", "ctrl+shift+w", "ctrl+shift+q"]);
    expect([...t.paste]).toEqual(["ctrl+v", "ctrl+shift+v", "shift+insert"]);
    expect(t.removes.source).toBe(/^((shift|ctrl|ctrl\+shift)\+)?(delete|backspace)$|^ctrl\+x$/.source);
    expect(t.cut).toBe("ctrl+x");
    expect(keyTables()).toBe(t);
  });

  it("gives today's answers from every exported key helper, with and without the Linux conventions (frozen copies)", () => {
    // [keys, canonicalKeys, isSystemKey(canonical), typedChar, typesCharacter, replacesSelection, keyLabel, isActivatingKey],
    // from the code before the port.
    const frozen: [string, string | null, boolean | null, string | null, boolean, boolean, string | null, boolean][] = [
    ["ctrl+s","ctrl+s",false,null,false,false,"Ctrl+S",false],
    ["Ctrl+Shift+T","ctrl+shift+t",false,null,false,false,"Ctrl+Shift+T",false],
    ["alt+F4","alt+f4",false,null,false,false,"Alt+F4",false],
    ["ctrl+alt+t","ctrl+alt+t",true,null,false,false,"Ctrl+Alt+T",false],
    ["ctrl+alt+delete","ctrl+alt+delete",true,null,false,false,"Ctrl+Alt+Delete",false],
    ["ctrl+alt+f2","ctrl+alt+f2",true,null,false,false,"Ctrl+Alt+F2",false],
    ["alt+f2","alt+f2",true,null,false,false,"Alt+F2",false],
    ["alt+f1","alt+f1",true,null,false,false,"Alt+F1",false],
    ["super","super_l",true,null,false,false,"Super L",false],
    ["Super_L","super_l",true,null,false,false,"Super L",false],
    ["win+r","super+r",true,null,false,false,"Super+R",false],
    ["cmd+space","super+space",true,null,false,false,"Super+Space",false],
    ["cmd+s","super+s",true,null,false,false,"Super+S",false],
    ["mod+s",null,null,null,true,false,null,false],
    ["primary+a",null,null,null,true,false,null,false],
    ["cmdorctrl+v",null,null,null,true,false,null,false],
    ["ctrl+alt+y","ctrl+alt+y",true,null,false,false,"Ctrl+Alt+Y",false],
    ["ctrl+alt+shift+y","ctrl+alt+shift+y",true,null,false,false,"Ctrl+Alt+Shift+Y",false],
    ["ctrl+alt+space","ctrl+alt+space",true,null,false,false,"Ctrl+Alt+Space",false],
    ["ctrl+alt+x","ctrl+alt+x",true,null,false,false,"Ctrl+Alt+X",false],
    ["ctrl+alt+e","ctrl+alt+e",true,null,false,false,"Ctrl+Alt+E",false],
    ["ctrl+alt+m","ctrl+alt+m",true,null,false,false,"Ctrl+Alt+M",false],
    ["ctrl+alt+n","ctrl+alt+n",true,null,false,false,"Ctrl+Alt+N",false],
    ["ctrl+alt+end","ctrl+alt+end",true,null,false,false,"Ctrl+Alt+End",false],
    ["ctrl+alt+a","ctrl+alt+a",true,null,false,false,"Ctrl+Alt+A",false],
    ["ctrl+alt+l","ctrl+alt+l",true,null,false,false,"Ctrl+Alt+L",false],
    ["ctrl+alt+left","ctrl+alt+left",true,null,false,false,"Ctrl+Alt+Left",false],
    ["ctrl+alt+tab","ctrl+alt+tab",true,null,false,false,"Ctrl+Alt+Tab",false],
    ["ctrl+alt+backspace","ctrl+alt+backspace",true,null,false,false,"Ctrl+Alt+Backspace",false],
    ["Print","print",true,null,false,false,"Print",false],
    ["XF86AudioMute","xf86audiomute",true,null,false,false,"Xf86audiomute",false],
    ["sys_req","sys_req",true,null,false,false,"Sys Req",false],
    ["meta+e","super+e",true,null,false,false,"Super+E",false],
    ["hyper+x",null,null,null,true,false,null,false],
    ["mod4+l","super+l",true,null,false,false,"Super+L",false],
    ["logo+d","super+d",true,null,false,false,"Super+D",false],
    ["command+q","super+q",true,null,false,false,"Super+Q",false],
    ["windows+e","super+e",true,null,false,false,"Super+E",false],
    ["shift+super+s","shift+super+s",true,null,false,false,"Shift+Super+S",false],
    ["ctrl+escape","ctrl+escape",false,null,false,false,"Ctrl+Esc",false],
    ["ctrl+shift+escape","ctrl+shift+escape",false,null,false,false,"Ctrl+Shift+Esc",false],
    ["alt+tab","alt+tab",false,null,false,false,"Alt+Tab",false],
    ["alt+space","alt+space",false,null,false,false,"Alt+Space",true],
    ["alt+escape","alt+escape",false,null,false,false,"Alt+Esc",false],
    ["ctrl+q","ctrl+q",false,null,false,false,"Ctrl+Q",false],
    ["ctrl+w","ctrl+w",false,null,false,false,"Ctrl+W",false],
    ["Return","return",false,null,false,true,"Enter",true],
    ["space","space",false," ",true,true,"Space",true],
    ["shift+Return","shift+return",false,null,false,true,"Shift+Enter",true],
    ["ctrl+m","ctrl+m",false,null,false,false,"Ctrl+M",true],
    ["ctrl+j","ctrl+j",false,null,false,false,"Ctrl+J",true],
    ["KP_Enter","kp_enter",false,null,false,true,"keypad Enter",true],
    ["a","a",false,"a",true,true,"A",false],
    ["shift+a","shift+a",false,"a",true,true,"Shift+A",false],
    ["1","1",false,"1",true,true,"1",false],
    ["ctrl+a","ctrl+a",false,null,false,false,"Ctrl+A",false],
    ["ctrl+v","ctrl+v",false,null,false,true,"Ctrl+V",false],
    ["shift+insert","shift+insert",false,null,false,true,"Shift+Insert",false],
    ["ctrl+x","ctrl+x",false,null,false,true,"Ctrl+X",false],
    ["ctrl+BackSpace","ctrl+backspace",false,null,false,true,"Ctrl+Backspace",false],
    ["shift+Delete","shift+delete",false,null,false,true,"Shift+Delete",false],
    ["Delete","delete",false,null,false,true,"Delete",false],
    ["BackSpace","backspace",false,null,false,true,"Backspace",false],
    ["Tab","tab",false,null,false,true,"Tab",false],
    ["ctrl+End","ctrl+end",false,null,false,false,"Ctrl+End",false],
    ["ctrl+Home","ctrl+home",false,null,false,false,"Ctrl+Home",false],
    ["ctrl+shift+F5","ctrl+shift+f5",false,null,false,false,"Ctrl+Shift+F5",false],
    ["F5","f5",false,null,false,false,"F5",false],
    ["Escape","escape",false,null,false,false,"Esc",false],
    ["ctrl+plus","ctrl+plus",false,null,false,false,"Ctrl++",false],
    ["ctrl++","ctrl+plus",false,null,false,false,"Ctrl++",false],
    ["alt+shift+x","alt+shift+x",false,null,false,false,"Alt+Shift+X",false],
    ["0x74",null,null,null,true,false,null,false],
    ["U+0074",null,null,null,true,false,null,false],
    ["ctrl+alt+shift+cmd+y","ctrl+alt+shift+super+y",true,null,false,false,"Ctrl+Alt+Shift+Super+Y",false],
    ["ctrl+shift+cmd+z","ctrl+shift+super+z",true,null,false,false,"Ctrl+Shift+Super+Z",false],
    ["ctrl+shift+super+y","ctrl+shift+super+y",true,null,false,false,"Ctrl+Shift+Super+Y",false],
    ["ctrl+shift+meta+comma","ctrl+shift+super+comma",true,null,false,false,"Ctrl+Shift+Super+,",false],
    ["option+left",null,null,null,true,false,null,false],
    ["opt+a",null,null,null,true,false,null,false],
    ["shift+cmd+3","shift+super+3",true,null,false,false,"Shift+Super+3",false],
    ["alt+cmd+escape","alt+super+escape",true,null,false,false,"Alt+Super+Esc",false],
    ["kp_delete","kp_delete",false,null,false,true,"keypad Delete",false],
    ["shift+kp_delete","shift+kp_delete",false,null,false,true,"Shift+keypad Delete",false],
    ["ctrl+KP_Enter","ctrl+kp_enter",false,null,false,false,"Ctrl+keypad Enter",true],
    ["comma","comma",false,null,true,true,",",false],
    ["ctrl+,","ctrl+comma",false,null,false,false,"Ctrl+,",false],
    ["exclam","exclam",false,null,true,true,"!",false],
    ["Menu","menu",false,null,false,false,"Menu",false],
    ["Super_R","super_r",true,null,false,false,"Super R",false],
    ["ctrl+super+d","ctrl+super+d",true,null,false,false,"Ctrl+Super+D",false],
    ["alt+f4 ","alt+f4",false,null,false,false,"Alt+F4",false],
    [" ctrl + s ","ctrl+s",false,null,false,false,"Ctrl+S",false],
    ];
    for (const [k, canonical, system, typed, typesChar, replaces, label, activating] of frozen) {
      for (const kc of [undefined, KEYS.linux]) {
        const c = canonicalKeys(k, kc);
        expect(c, k).toBe(canonical);
        if (c !== null) expect(isSystemKey(c, kc), k).toBe(system);
        expect(typedChar(k, kc), k).toBe(typed);
        expect(typesCharacter(k, kc), k).toBe(typesChar);
        expect(replacesSelection(k, kc), k).toBe(replaces);
        expect(keyLabel(k, kc), k).toBe(label);
        expect(isActivatingKey(k, kc), k).toBe(activating);
        expect(normalizeKeys(k, kc), k).toBe(canonical ?? k.toLowerCase().replace(/\s+/g, ""));
      }
    }
  });

  it("a Linux engine (no conventions given) still reads cmd+s as the logo key and refuses \"mod\"", () => {
    const e = engine();
    expect(e.decide(keys("cmd+s"))).toMatchObject({ verdict: "deny", tier: "never" });
    expect(e.decide(keys("mod+s")).reason).toBe("Ember's keyboard doesn't know that key combination");
    expect(e.decide(keys("ctrl+s")).prompt).toBe("Borrow your keyboard to press Ctrl+S in TextEdit?");
  });
});

describe("macOS keys in the policy", () => {
  const mac = engine({ keys: KEYS.darwin, os: "darwin" });
  const onDesk = (value: string) => mac.decide(keys(value, { onDesk: true }));

  it("allows ⌘ shortcuts, naming them as a Mac does, and asks every time on the user's screen", () => {
    expect(mac.decide(keys("cmd+s"))).toMatchObject({ verdict: "confirm", prompt: "Borrow your keyboard to press Command+S in TextEdit?" });
    expect(mac.decide(keys("option+left")).prompt).toBe("Borrow your keyboard to press Option+Left in TextEdit?");
    expect(plainQuestion(keys("cmd+shift+z"), KEYS.darwin)).toBe("Borrow your keyboard to press Shift+Command+Z in TextEdit?");
  });

  it("judges ⌘ by the \"mod\" tables: safe ones go without a question where nothing is borrowed, destructive and unknown ones are asked", () => {
    for (const k of ["cmd+s", "cmd+c", "cmd+z", "cmd+shift+z", "cmd+a", "option+left", "cmd+down", "cmd+shift+up"]) expect(onDesk(k).verdict, k).toBe("allow");
    for (const k of ["cmd+q", "cmd+w", "cmd+backspace", "alt+cmd+w", "cmd+return"]) expect(onDesk(k).reason, k).toBe("this shortcut can delete, send or close things");
    expect(onDesk("cmd+k").reason).toBe("Ember can't tell what this shortcut does in this app");
    expect(onDesk("ctrl+s").reason).toBe("Ember can't tell what this shortcut does in this app");
  });

  it("refuses the Mac's own keys and every Control+Shift+Command combination (L1)", () => {
    for (const k of ["cmd+space", "cmd+tab", "alt+cmd+escape", "shift+cmd+3", "ctrl+cmd+q", "ctrl+left", "ctrl+shift+cmd+y", "ctrl+shift+cmd+z",
      "ctrl+alt+shift+cmd+n", "ctrl+shift+super+y", "ctrl+shift+meta+comma"]) {
      expect(mac.decide(keys(k)), k).toMatchObject({ verdict: "deny", tier: "never" });
    }
    // ⌘ is the primary modifier there, not the logo key.
    expect(mac.decide(keys("cmd+f")).verdict).toBe("confirm");
  });

  it("knows a ⌘ paste and ⌘X replace what is selected, and names Select All as ⌘A in its notes", () => {
    expect(replacesSelection("cmd+v", KEYS.darwin)).toBe(true);
    expect(replacesSelection("cmd+x", KEYS.darwin)).toBe(true);
    expect(replacesSelection("cmd+backspace", KEYS.darwin)).toBe(true);
    expect(replacesSelection("cmd+s", KEYS.darwin)).toBe(false);
    expect(typesCharacter("cmd+a", KEYS.darwin)).toBe(false);
    expect(typedChar("cmd+a", KEYS.darwin)).toBeNull();
    expect(typedChar("shift+a", KEYS.darwin)).toBe("a");
    expect(isActivatingKey("Return", KEYS.darwin)).toBe(true);
    expect(keyTables(KEYS.darwin).cut).toBe("cmd+x");
    const d = mac.decide({ taskId: "t", kind: "cursor_text", app: "TextEdit", window: "notes.txt", element: { role: "paragraph", name: "" }, value: "hello", mode: "replace" });
    expect(d.reason).toBe("replacing with the keyboard selects everything (Command+A), which here may be the whole document");
    expect(d.prompt).toContain("To replace it I select everything with Command+A");
    const all = mac.decide(keys("x", { element: { role: "text", name: "Notes" }, afterSelectAll: true, currentText: "a".repeat(120) }));
    expect(all.reason).toBe("everything is selected (Command+A), so this replaces all 120 characters already there");
  });

  it("asks before a ⌘ cut takes the rows selected in a list", () => {
    const d = mac.decide(keys("cmd+x", { element: { role: "table cell", name: "report.pdf" }, afterSelectAll: true, onDesk: true }));
    expect(d.reason).toBe("everything there is selected, and this cuts it all");
  });
});

describe("Windows keys in the policy", () => {
  const win = engine({ keys: KEYS.win32, os: "win32" });
  it("refuses the logo key, the Start menu and Task Manager, window switching and Ember's Win+Alt family", () => {
    for (const k of ["super+r", "win+e", "ctrl+escape", "ctrl+shift+escape", "alt+tab", "alt+space", "alt+super+y", "alt+shift+super+n"]) {
      expect(win.decide(keys(k)), k).toMatchObject({ verdict: "deny", tier: "never" });
    }
  });
  it("judges Ctrl shortcuts as on Linux", () => {
    expect(win.decide(keys("ctrl+s", { onDesk: true })).verdict).toBe("allow");
    expect(win.decide(keys("alt+f4", { onDesk: true })).reason).toBe("this shortcut can delete, send or close things");
    expect(win.decide(keys("ctrl+s")).prompt).toBe("Borrow your keyboard to press Ctrl+S in TextEdit?");
  });
});

describe("windows and labels by each OS's vocabulary", () => {
  it("keeps the Linux rows as the expressions they were (frozen copies)", () => {
    const same = (a: RegExp | null, b: RegExp) => { expect(a?.source).toBe(b.source); expect(a?.flags).toBe(b.flags); };
    same(SECURITY_TITLE.linux, /^\s*(authenticat(e|ion)\b.*\b(required|request)\b|authenticate\s*$|(password|passphrase|pin) (required|request(ed)?)\b|enter (the |your |a )?(password|passphrase|pin)\b|unlock\b.*\b(keyring|private key|password|passphrase)\b|\[sudo\]|sudo password\b)/);
    same(SECURITY_APP.linux, /polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|^firewall-config$|(^|\s)gnome-shell(\s|$)/i);
    same(TABBED_APP.linux, /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|thunderbird|evolution|geary|claws|mail|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram/i);
    same(WEB_APP.linux, /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|electron|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram|whatsapp/i);
    same(OFFICE_APP.linux, /soffice|libreoffice/i);
    same(FILE_PATH_WORDS.linux, /[~/][\w.-]|\.\w{1,5}\b/);
    // host.ts's terminal words, as they were built there.
    const TERMINAL = String.raw`(?:(?:gnome|kde|xfce)[- ])?(?:terminal|console(?![- ]companion))|command[- ]line|command prompt|shell(?![- ]extensions?\b)`
      + String.raw`|(?!gnome\s)[\w.-]+\s+(?:terminal|shell(?![- ]extensions?\b))`;
    same(TERMINAL_REQUEST.linux.asks, new RegExp(String.raw`\b(?:open|use|launch|start|run|type(?:\s+(?:in|into))?|work\s+in)\s+(?:up\s+)?(?:(?:a|an|the|my|your)\s+)?(?:new\s+)?(?:${TERMINAL})\b|\b(?:in|into|from|via|using|with|through|on)\s+(?:(?:a|an|the|my|your)\s+)?(?:${TERMINAL})\b`, "i"));
    same(TERMINAL_REQUEST.linux.refuses, new RegExp(String.raw`\b(?:not|never|without|instead\s+of|rather\s+than|don['’]?t)\s+(?:(?:use|using|open|opening)\s+)?(?:(?:in|into|from|via|using|with|through|on)\s+)?(?:(?:a|an|the|my|your)\s+)?(?:${TERMINAL})\b`, "gi"));
    same(TERMINAL_REQUEST.linux.names, /\b(?:terminal|shell|command[- ]line|command prompt|console)\b/i);
    expect([SECURITY_CLASS.linux, RISKY_EXTRA.linux, RUNS_PROGRAM_EXTRA.linux, RUN_FILE_DIALOG_EXTRA.linux, TYPING_REFUSED.linux]).toEqual([[], [], [], [], []]);
  });

  it("judges a security window by the OS asked for (Linux by default)", () => {
    expect(isSecurityWindow({ app: "polkit-gnome-authentication-agent-1", title: "Authentication Required" })).toBe(true);
    expect(isSecurityWindow({ app: "polkit-gnome-authentication-agent-1" }, "linux")).toBe(true);
    // GNOME's prompts' programs mean nothing on another OS.
    expect(isSecurityWindow({ app: "gcr-prompter" }, "darwin")).toBe(SECURITY_APP.darwin?.test("gcr-prompter") ?? false);
  });

  it("uses the security check it is given (the platform's) before anything else", () => {
    const e = engine({ keys: KEYS.win32, os: "win32", isSecurityWindow: w => w.app === "credentialuibroker", grants: () => ({ credentialuibroker: "act" }) });
    const d = e.decide({ taskId: "t", kind: "click", app: "credentialuibroker", window: "Windows Security", element: { role: "push button", name: "OK" } });
    expect(d).toMatchObject({ verdict: "deny", tier: "never", reason: "authentication and security windows are for the user only" });
  });

  it("refuses a program's name typed into a box that runs it, by the OS's rules (none on Linux)", () => {
    const address = [{ app: /^explorer$/i, field: /^address$/i, text: /^[\w.-]+$|\.(exe|com|bat|cmd|ps1|lnk)$/i }];
    const into = (value: string) => ({ app: "explorer", element: { role: "text", name: "Address" }, value });
    expect(refusesTyping(address, into("cmd"))).toBe(true);
    expect(refusesTyping(address, into(" powershell.exe "))).toBe(true);
    expect(refusesTyping(address, into("C:\\Users\\ada\\Documents"))).toBe(false);
    expect(refusesTyping(address, { ...into("cmd"), app: "notepad" })).toBe(false);
    expect(refusesTyping([{ app: /^explorer$/i, field: /^address$/i }], into("anything"))).toBe(true);
    // On Linux nothing is refused for it: GNOME has no such box.
    const d = engine({ grants: () => ({ explorer: "act" }) }).decide({ taskId: "t", kind: "text", app: "explorer", window: "Files", element: { role: "text", name: "Address" }, value: "cmd", mode: "replace" });
    expect(d.verdict).toBe("allow");
  });
});
