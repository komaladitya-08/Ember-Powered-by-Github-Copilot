import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyEngine, alignedWithGoal, canonicalKeys, isRiskyLabel, isSecurityWindow, keyLabel, type ActionRequest } from "../../app/main/policy/policy";
import { AuditLog } from "../../app/main/policy/audit";

const engine = (grants: Record<string, "observe" | "act"> = {}, now = () => 0) =>
  new PolicyEngine({ neverLook: () => ["keepassxc"], grants: () => grants, now, rateLimit: 3 });
const req = (r: Partial<ActionRequest>): ActionRequest => ({ taskId: "t1", kind: "click", app: "Mousepad", window: "notes.txt", ...r });

describe("PolicyEngine", () => {
  it("lets reads through", () => {
    expect(engine().decide(req({ kind: "read" })).verdict).toBe("allow");
  });

  it("never touches password fields, secret fields, terminals or never-look apps", () => {
    const e = engine({ mousepad: "act" });
    expect(e.decide(req({ kind: "text", element: { role: "password text", name: "" }, value: "x" })).tier).toBe("never");
    expect(e.decide(req({ kind: "text", element: { role: "text", name: "Card number" }, value: "4111" })).verdict).toBe("deny");
    expect(e.decide(req({ kind: "text", element: { role: "terminal", name: "" }, value: "rm -rf ~" })).verdict).toBe("deny");
    expect(e.decide(req({ app: "KeePassXC", element: { role: "push button", name: "OK" } })).verdict).toBe("deny");
    expect(e.decide(req({ app: "polkit-gnome-authentication-agent-1", window: "Authentication Required", element: { role: "push button", name: "Authenticate" } })).verdict).toBe("deny");
  });

  it("asks before the first action in an app, then not once granted", () => {
    const first = engine().decide(req({ element: { role: "push button", name: "Bold" } }));
    expect(first).toMatchObject({ verdict: "confirm", needsGrant: true });
    expect(first.prompt).toContain("Mousepad");
    expect(engine({ mousepad: "act" }).decide(req({ element: { role: "push button", name: "Bold" } })).verdict).toBe("allow");
  });

  it("always asks for risky clicks, even with a grant", () => {
    const d = engine({ mousepad: "act" }).decide(req({ element: { role: "push button", name: "Delete" } }));
    expect(d).toMatchObject({ verdict: "confirm", tier: "confirm", risky: true });
    expect(d.prompt).toBe("Click “Delete” push button in Mousepad?");
  });

  it("builds the prompt from the request, not from model text", () => {
    const d = engine().decide(req({ kind: "text", element: { role: "text", name: "Subject" }, value: "Hello" }));
    expect(d.prompt).toBe("Let me work in Mousepad? First step: type “Hello” into “Subject” text.");
  });

  it("runs tier-0 settings and app launches without asking", () => {
    expect(engine().decide(req({ kind: "setting", app: "", window: "", value: "Night Light → on" })).verdict).toBe("allow");
    expect(engine().decide(req({ kind: "open_app", app: "", window: "", value: "Files" })).verdict).toBe("allow");
  });

  it("rate-limits a runaway task", () => {
    const e = engine({ mousepad: "act" });
    const click = req({ element: { role: "push button", name: "Bold" } });
    for (let i = 0; i < 3; i++) expect(e.decide(click).verdict).toBe("allow");
    expect(e.decide(click).verdict).toBe("deny");
    expect(e.decide({ ...click, taskId: "t2" }).verdict).toBe("allow");
  });
});

describe("AuditLog", () => {
  it("appends JSON lines with owner-only permissions and prunes old months", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-audit-"));
    let now = new Date("2026-10-15T10:00:00Z");
    const log = new AuditLog(dir, () => now);
    log.write({ event: "decision", task: "t1", verdict: "allow" });
    log.write({ event: "action", task: "t1", ok: true });
    const lines = fs.readFileSync(log.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ t: "2026-10-15T10:00:00.000Z", event: "decision", verdict: "allow" });
    expect(fs.statSync(log.file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(dir, "audit-2026-01.jsonl"), "{}\n");
    now = new Date("2026-10-20T00:00:00Z");
    log.prune(30);
    expect(fs.existsSync(path.join(dir, "audit-2026-01.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "audit-2026-10.jsonl"))).toBe(true);
  });
});

describe("policy: review fixes (screen text can't hide risk)", () => {
  const e = new PolicyEngine({ neverLook: () => ["keepassxc"], grants: () => ({ firefox: "act", gedit: "act" }), isTerminalApp: n => /terminal|xterm/i.test(n) });
  const click = (name: string, window = "Page", goal = "pay invoice 4411") => e.decide({ taskId: "t", kind: "click", app: "Firefox", window, element: { role: "push button", name }, goal });

  it("look-alike letters, invisible characters and typographic apostrophes don't hide a risky word", () => {
    for (const name of ["Dеlete account", "De­lete", "Del​ete", "Ｓｅｎｄ", "Don’t Save"]) expect(click(name).verdict).toBe("confirm");
  });
  it("covers overwrite dialogs, trash, authorising apps and merges", () => {
    for (const name of ["Replace", "Move to Trash", "Authorize evil-app", "Merge pull request", "Run"]) expect(click(name).verdict).toBe("confirm");
  });
  it("“OK” in a dialog about deleting is as risky as the deleting", () => {
    expect(click("OK", "Delete 500 files?").verdict).toBe("confirm");
    expect(click("OK", "About Firefox").verdict).toBe("allow");
  });
  it("Enter on a focused risky button is a click on it, and destructive shortcuts are asked about on the desk too", () => {
    const keys = (value: string, element?: { role: string; name: string }, onDesk = false) =>
      e.decide({ taskId: "k", kind: "keys", app: "Files", window: "Home", element, value, onDesk, goal: "tidy my downloads" });
    expect(keys("Return", { role: "push button", name: "Delete all" }).prompt).toMatch(/press Enter on “Delete all” push button/);
    expect(keys("Return", { role: "push button", name: "Delete all" }).aligned).toBe(false);
    expect(keys("shift+Delete", undefined, true).verdict).toBe("confirm");
    expect(keys("ctrl+Return", { role: "text", name: "Message" }, true).verdict).toBe("confirm");
    expect(keys("ctrl+s", { role: "text", name: "Doc" }, true).verdict).toBe("allow");
  });
  it("desktop-level shortcuts are never pressed", () => {
    for (const k of ["ctrl+alt+F2", "alt+F2", "super", "ctrl+alt+t", "Ctrl + Alt + BackSpace"]) {
      expect(e.decide({ taskId: "k", kind: "keys", app: "gedit", window: "w", value: k }).verdict).toBe("deny");
    }
  });
  it("typed line breaks and replacing a whole document are confirmed", () => {
    expect(e.decide({ taskId: "x", kind: "text", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value: "hello\n", mode: "insert" }).verdict).toBe("confirm");
    const doc = "line\n".repeat(50);
    const d = e.decide({ taskId: "x", kind: "text", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value: "hi", mode: "replace", currentText: doc });
    expect(d.verdict).toBe("confirm");
    expect(d.prompt).toMatch(/^Replace the text in/);
    expect(e.decide({ taskId: "x", kind: "text", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value: "hi", mode: "append", currentText: doc }).verdict).toBe("allow");
  });
  it("a risky verb must be in the request: sharing a filler word isn't enough", () => {
    const d = e.decide({ taskId: "a", kind: "click", app: "Firefox", window: "Form", element: { role: "push button", name: "Delete all my form data" }, goal: "fill in my name in the form" });
    expect(d.aligned).toBe(false);
    expect(d.prompt).toMatch(/You didn't ask for this/);
    expect(e.decide({ taskId: "a", kind: "click", app: "Firefox", window: "Form", element: { role: "push button", name: "Send" }, goal: "send the report to Ana" }).aligned).toBeUndefined();
  });
  it("never offers “Always” on a risky question", () => {
    const fresh = new PolicyEngine({ neverLook: () => [], grants: () => ({}) });
    expect(fresh.decide({ taskId: "r", kind: "click", app: "Thunderbird", window: "w", element: { role: "push button", name: "Send" }, goal: "send it" }).remember).toBe(false);
    expect(fresh.decide({ taskId: "r", kind: "click", app: "Thunderbird", window: "w", element: { role: "push button", name: "Bold" }, goal: "x" }).remember).toBe(true);
  });
  it("choosing a risky option and filling secret fields by any route are covered", () => {
    expect(e.decide({ taskId: "s", kind: "select", app: "Firefox", window: "Account", element: { role: "combo box", name: "Action" }, value: "Delete account" }).verdict).toBe("confirm");
    expect(e.decide({ taskId: "s", kind: "value", app: "Firefox", window: "Pay", element: { role: "spin button", name: "PIN" }, value: "1234" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "s", kind: "text", app: "Firefox", window: "Login", element: { role: "text", name: "Pаssword" }, value: "x" }).verdict).toBe("deny");
  });
  it("launching an app on the never-look list or a terminal is refused", () => {
    expect(e.decide({ taskId: "o", kind: "open_app", app: "KeePassXC", window: "", value: "KeePassXC" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "o", kind: "open_app", app: "XTerm", window: "", value: "XTerm" }).verdict).toBe("deny");
    expect(e.decide({ taskId: "o", kind: "open_app", app: "Text Editor", window: "", value: "Text Editor" }).verdict).toBe("allow");
  });
});

describe("policy: review round 2", () => {
  const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act", files: "act" }) });
  const deskKeys = (value: string, element?: { role: string; name: string }) =>
    e.decide({ taskId: "d", kind: "keys", app: "Files", window: "Home", element, value, onDesk: true, goal: "tidy my downloads" });

  it("on the desk, every way of pressing a button is asked about, and so are shortcuts Ember can't place", () => {
    for (const k of ["shift+Return", "shift+space", "ctrl+m", "ctrl+j"]) expect(deskKeys(k, { role: "push button", name: "Delete all" }).verdict).toBe("confirm");
    for (const k of ["alt+d", "alt+shift+s", "ctrl+k", "ctrl+shift+e"]) expect(deskKeys(k, { role: "text", name: "Doc" }).verdict).toBe("confirm");
    for (const k of ["ctrl+a", "ctrl+v", "ctrl+s", "Tab", "Down", "ctrl+End"]) expect(deskKeys(k, { role: "text", name: "Doc" }).verdict).toBe("allow");
  });
  it("“OK” or “Yes” inside a dialog asks, even when the window's title says nothing risky", () => {
    const d = e.decide({ taskId: "g", kind: "click", app: "Firefox", window: "Mail — Mozilla Firefox", element: { role: "push button", name: "Yes" },
      dialog: { name: "Confirm", text: "Remove all 2,341 messages?" }, goal: "read my mail" });
    expect(d.verdict).toBe("confirm");
    expect(d.aligned).toBe(false);
    expect(e.decide({ taskId: "g", kind: "click", app: "Firefox", window: "Page", element: { role: "push button", name: "Continue" }, dialog: { name: "", text: "" } }).verdict).toBe("confirm");
  });
  it("the object has to match too, not just the verb", () => {
    const off = e.decide({ taskId: "a", kind: "click", app: "Firefox", window: "Bank", element: { role: "push button", name: "Send money to Bob" }, goal: "send the report to Ana" });
    expect(off.aligned).toBe(false);
    expect(e.decide({ taskId: "a", kind: "click", app: "Firefox", window: "Mail", element: { role: "push button", name: "Send report" }, goal: "send the report to Ana" }).aligned).toBeUndefined();
  });
  it("destructive words in other languages count", () => {
    for (const name of ["Supprimer", "Alle löschen", "Eliminar", "Удалить", "削除", "删除", "Verwijderen", "Enviar"]) {
      expect(e.decide({ taskId: "l", kind: "click", app: "Firefox", window: "Page", element: { role: "push button", name } }).verdict, name).toBe("confirm");
    }
  });
  it("GNOME Shell with the keyboard is treated like a password prompt", async () => {
    const { isSecurityWindow } = await import("../../app/main/policy/policy");
    expect(isSecurityWindow({ app: "gnome-shell", title: "" })).toBe(true);
  });
});

describe("audit journal copy", () => {
  it("keeps only the size of what the user asked and of window titles", async () => {
    const { journalLine } = await import("../../app/main/policy/audit");
    const out = JSON.parse(journalLine(JSON.stringify({ event: "task", goal: "email my therapist", window: "Re: biopsy results", kind: "click" })));
    expect(out).toEqual({ event: "task", goalChars: 18, windowChars: 18, kind: "click" });
  });
});

describe("policy: key combinations however they are spelled (review round 2)", () => {
  const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act" }) });
  const keys = (value: string, onDesk = false) => e.decide({ taskId: `k-${Math.random()}`, kind: "keys", app: "gedit", window: "notes", element: { role: "text", name: "Doc" }, value, onDesk });

  it.each([
    "alt+ctrl+f2", "alt+ctrl+t", "alt+ctrl+delete", "alt+ctrl+backspace", "shift+ctrl+alt+t", "Ctrl + Alt + Del", "control+alt+F7",
    "Super_L", "super_r", "ctrl+super+d", "win+d", "super", "meta+l", "Hyper_L", "XF86PowerOff", "XF86LogOff", "XF86AudioMute",
    "Print", "alt+Print", "alt+Sys_Req", "alt+F2", "alt+shift+F1", "ctrl+alt+Tab", "ctrl+alt+l", "ctrl+alt+Up",
    // Ember's own shortcuts: a task never answers its own question, stops, hides or opens Ember.
    "ctrl+alt+y", "alt+ctrl+n", "ctrl+alt+a", "ctrl+alt+x", "ctrl+alt+space", "ctrl+alt+e", "ctrl+alt+m", "ctrl+alt+End", "Control+Alt+Y", "ctrl+shift+alt+y",
  ])("%s is never pressed, on the user's screen or the desk", k => {
    expect(keys(k).verdict).toBe("deny");
    expect(keys(k, true).verdict).toBe("deny");
  });

  it.each(["hyper+x", "altgr+e", "ctrl+alt t"])("%s (a combination Ember's keyboard doesn't know) is refused", k => {
    expect(keys(k).verdict).toBe("deny");
  });

  it.each([
    ["Ctrl+S", "allow"], ["ctrl+End", "allow"], ["ctrl+PageDown", "allow"], ["control+z", "allow"], ["Tab", "allow"],
    ["shift+ctrl+delete", "confirm"], ["Alt+F4", "confirm"], ["ctrl+Q", "confirm"], ["ctrl+k", "confirm"], ["shift+alt+s", "confirm"],
  ])("on the desk, %s is %s whatever the spelling", (k, verdict) => {
    expect(keys(k, true).verdict).toBe(verdict);
  });

  it.each([
    ["Control_R+w", "confirm"], ["Control_R+q", "confirm"], ["Alt_R+F4", "confirm"], ["Control_R+Shift_R+Delete", "confirm"], ["Control_R+Return", "confirm"],
    ["Control_R+s", "allow"],
  ])("on the desk, the right-hand %s is judged like the left-hand one (%s)", (k, verdict) => {
    expect(keys(k, true).verdict).toBe(verdict);
  });

  it.each(["Control_R+Alt_R+x", "Control_R+Alt_L+y", "Super_R+l", "Alt_R+F2", "Control_R+Alt_R+Delete", "Control_R+Alt_R+F3"])("%s is never pressed either", k => {
    expect(keys(k).verdict).toBe("deny");
    expect(keys(k, true).verdict).toBe("deny");
  });

  it.each(["KP_Space", "ISO_Enter", "Linefeed"])("%s on a focused Send button on the desk is asked about, like Return", k => {
    const d = e.decide({ taskId: `k-${Math.random()}`, kind: "keys", app: "gedit", window: "notes", element: { role: "push button", name: "Send" }, value: k, onDesk: true });
    expect(d.verdict).toBe("confirm");
  });

  it("one spelling for every way of writing a combination", () => {
    expect(canonicalKeys("Control_R+Alt_R+Delete")).toBe("ctrl+alt+delete");
    expect(canonicalKeys("Alt + Ctrl + Del")).toBe("ctrl+alt+delete");
    expect(canonicalKeys("shift+ctrl+alt+T")).toBe("ctrl+alt+shift+t");
    expect(canonicalKeys("cmd+space")).toBe("super+space");
    expect(canonicalKeys("ctrl++")).toBe("ctrl+plus");
    expect(canonicalKeys("hyper+x")).toBeNull();
  });
});

describe("policy: Ember doesn't run programs, through a file manager either (review round 3)", () => {
  const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ nautilus: "act" }) });
  const act = (name: string, onDesk: boolean, dialog?: { name: string; text: string }, role = "check box") =>
    e.decide({ taskId: `x-${Math.random()}`, kind: "toggle", app: "Nautilus", window: "report.sh Properties", element: { role, name }, onDesk, dialog });
  it.each(["Allow executing file as program", "Executable as Program", "Run in Terminal"])("“%s” is refused on the desk and on the user's screen", name => {
    expect(act(name, true).verdict).toBe("deny");
    expect(act(name, false).verdict).toBe("deny");
  });
  it("the file manager's “Run” answer is refused; a Run button elsewhere is judged as usual", () => {
    const ask = { name: "", text: "Do you want to run “report.sh”, or display its contents?" };
    expect(act("Run", true, ask, "push button").verdict).toBe("deny");
    expect(act("Run", true, undefined, "push button").verdict).not.toBe("deny");
  });
});

describe("policy: review round 3", () => {
  const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act", gedit: "act" }) });
  const click = (name: string, o: Partial<ActionRequest> = {}) =>
    e.decide({ taskId: `c-${Math.random()}`, kind: "click", app: "Firefox", window: "Page", element: { role: "push button", name }, goal: "fill in the form", ...o });
  const deskKeys = (value: string, element?: { role: string; name: string; secret?: boolean }) =>
    e.decide({ taskId: `k-${Math.random()}`, kind: "keys", app: "gedit", window: "notes", element, value, onDesk: true, goal: "tidy my notes" });

  it.each([
    // Italian, German, French, Spanish, Portuguese, Dutch, Polish, Russian.
    "Elimina", "Elimina definitivamente", "Invia", "Svuota cestino", "Rimuovi", "Acquista ora", "Paga ora", "Inoltra", "Condividi", "Conferma",
    "Zahlungspflichtig bestellen", "Jetzt kaufen", "Überweisen", "Antworten", "Weiterleiten", "Installieren", "Teilen", "Bestätigen", "Abmelden", "Zurücksetzen", "Verwerfen", "Loeschen",
    "Valider la commande", "Commander", "Répondre", "Repondre", "Transférer", "Partager", "Installer", "Confirmer", "Réinitialiser", "Se déconnecter", "Vider la corbeille",
    "Finalizar compra", "Realizar pedido", "Responder", "Reenviar", "Compartir", "Instalar", "Confirmar", "Cerrar sesión", "Pagar ahora",
    "Excluir", "Encaminhar", "Compartilhar", "Terminar sessão", "Verwijderen", "Doorsturen", "Afrekenen", "Uitloggen", "Bevestigen",
    "Usuń", "Wyślij", "Zapłać", "Zamów", "Wyloguj", "Potwierdź", "Удалить", "Отправить", "Оплатить", "Оформить заказ", "Подтвердить", "Выйти",
    // Nordic, Finnish, Czech, Turkish, and scripts without spaces.
    "Kill Process", "End Process", "Terminate", "Donate", "Book now", "Leave group",
    "Ta bort", "Skicka", "Logga ut", "Slet", "Bekræft", "Slett", "Poista", "Lähetä", "Maksa", "Smazat", "Odeslat", "Zaplatit", "Sil", "Gönder", "Satın al", "Onayla",
    "削除", "すべて送信", "購入する", "ログアウト", "删除所有文件", "提交订单", "转账", "삭제", "결제하기", "로그아웃",
  ])("“%s” is asked about, even with a grant", name => {
    expect(isRiskyLabel(name)).toBe(true);
    expect(click(name).verdict).toBe("confirm");
  });

  it.each([
    "Formato", "Zahlen", "Ordina per nome", "Inviati", "Posta inviata", "Liste d'envies", "Bearbeiten", "Speichern", "Enregistrer", "Guardar", "Salva",
    "Opslaan", "Zapisz", "Сохранить", "Öffnen", "Abrir", "Annulla", "Abbrechen", "Annuler", "Cancelar", "Configuración del sistema", "Tom", "Ode to Joy",
    "Vapaata tilaa", "In den Warenkorb legen", "Kop 1", "Перевод", "保存", "打开", "열기", "Ansicht", "Hilfe",
  ])("“%s” (an everyday label) isn't", name => {
    expect(click(name).verdict).toBe("allow");
  });

  it.each([["Ja", "Alle Dateien endgültig löschen?"], ["Oui", "Supprimer définitivement ?"], ["Sí", "¿Eliminar todos los archivos?"], ["Да", "Удалить все файлы?"],
    ["Tak", "Usunąć wszystkie pliki?"], ["はい(Y)", "すべて削除しますか?"], ["确定", "删除所有文件?"], ["Weiter", "Zahlung bestätigen"], ["Evet", "Tüm dosyaları sil?"]])(
    "“%s” agrees to what its dialog asks (%s), and the question quotes it", (name, text) => {
      const d = click(name, { dialog: { name: "", text } });
      expect(d.verdict).toBe("confirm");
      expect(d.prompt).toContain(`It says: “${text}”.`);
      expect(click(name, { window: "Settings" }).verdict).toBe("allow");
    });

  it("the question about answering a dialog says what it asks, also on the desk", () => {
    const d = e.decide({ taskId: "q", kind: "click", app: "Files", window: "Files", element: { role: "push button", name: "OK" }, dialog: { name: "Confirm", text: "Delete all 2,341\nmessages?" }, onDesk: true, goal: "delete my old messages" });
    expect(d.prompt).toBe("Click “OK” push button in Files (on my desk)? It says: “Delete all 2,341 messages?”.");
  });

  it("whether a risky word was asked for is judged in every language", () => {
    expect(alignedWithGoal("Aggiungi un commento", "Elimina commento")).toBe(false);
    expect(alignedWithGoal("Elimina il vecchio commento", "Elimina commento")).toBe(true);
    expect(alignedWithGoal("Lösche die Datei notes.txt", "Löschen")).toBe(true);
    expect(alignedWithGoal("Удали старый файл", "Удалить")).toBe(true);
    expect(alignedWithGoal("删除旧文件", "删除")).toBe(true);
    expect(alignedWithGoal("写一封邮件", "删除")).toBe(false);
    expect(alignedWithGoal("log out of the shop", "Log out")).toBe(true);
    expect(alignedWithGoal("fill in my name", "Log out")).toBe(false);
  });

  it("keypad twins are judged as the keys they act like", () => {
    for (const k of ["KP_Delete", "shift+KP_Delete", "ctrl+KP_Enter", "alt+KP_Enter", "KP_Decimal"]) expect(deskKeys(k, { role: "text", name: "Doc" }).verdict, k).toBe("confirm");
    expect(deskKeys("KP_Enter", { role: "push button", name: "Send" }).verdict).toBe("confirm");
    expect(deskKeys("ctrl+alt+KP_Delete").verdict).toBe("deny");
    expect(deskKeys("ctrl+KP_Add", { role: "text", name: "Doc" }).verdict).toBe("allow");
  });

  it("a letter in an open menu picks an item, so it is asked about", () => {
    expect(deskKeys("d", { role: "menu item", name: "Copy" }).verdict).toBe("confirm");
    expect(deskKeys("d", { role: "text", name: "Doc" }).verdict).toBe("allow");
  });

  it("Enter with nothing Ember can see focused says it can't tell what it will activate", () => {
    expect(deskKeys("Return").prompt).toBe("Borrow your keyboard to press Enter in gedit (on my desk)? I can't tell what it will activate.");
    expect(e.decide({ taskId: "u", kind: "keys", app: "gedit", window: "notes", value: "space" }).prompt).toBe("Borrow your keyboard to press Space in gedit? I can't tell what it will activate.");
  });

  it.each(["ctrl+alt+0x74", "ctrl+alt+0xffbf", "alt+0xffbf", "0xffeb", "0x1008ff2a", "U0074", "ctrl+alt+U+0074"])("%s (a key by its number) is never pressed", k => {
    expect(canonicalKeys(k)).toBeNull();
    expect(deskKeys(k).verdict).toBe("deny");
  });

  it("keys are shown the way the rest of Ember writes them, never as the model spelled them", () => {
    expect(keyLabel("ctrl+s")).toBe("Ctrl+S");
    expect(keyLabel("Control_R+Shift_R+Delete")).toBe("Ctrl+Shift+Delete");
    expect(keyLabel("Return")).toBe("Enter");
    expect(keyLabel("escape")).toBe("Esc");
    expect(keyLabel("KP_Delete")).toBe("keypad Delete");
    expect(keyLabel("alt+F4")).toBe("Alt+F4");
    expect(keyLabel("ctrl+Page_Down")).toBe("Ctrl+Page Down");
    expect(e.decide({ taskId: "l", kind: "keys", app: "gedit", window: "notes", value: "shift+ctrl+DELETE" }).prompt).toBe("Borrow your keyboard to press Ctrl+Shift+Delete in gedit?");
  });

  it("a field the reader found secret (by a Show-password toggle or a label beside it) is never typed into, by any route", () => {
    const secret = { role: "text", name: "", secret: true };
    expect(deskKeys("4", secret).verdict).toBe("deny");
    for (const kind of ["text", "cursor_text", "select", "value", "keys"] as const) {
      expect(e.decide({ taskId: `s-${kind}`, kind, app: "Firefox", window: "Login", element: secret, value: "4" }).verdict, kind).toBe("deny");
    }
  });

  it("an expiry date is secret only on a card (the screen reader's rule)", () => {
    const fill = (name: string) => e.decide({ taskId: `x-${name}`, kind: "text", app: "Firefox", window: "Form", element: { role: "text", name }, value: "12/27" }).verdict;
    expect(fill("Expiration date")).toBe("allow");
    expect(fill("Card expiry")).toBe("deny");
    expect(fill("MM/YY")).toBe("deny");
  });

  it("a second look at the same request isn't counted against the rate limit", () => {
    const tight = new PolicyEngine({ neverLook: () => [], grants: () => ({ gedit: "act" }), rateLimit: 1 });
    const r: ActionRequest = { taskId: "r", kind: "click", app: "gedit", window: "notes", element: { role: "push button", name: "Bold" } };
    expect(tight.decide(r).verdict).toBe("allow");
    for (let i = 0; i < 3; i++) expect(tight.recheck(r).verdict).toBe("allow");
    expect(tight.decide(r).verdict).toBe("deny");
  });

  it.each([
    [{ app: "polkit-gnome-authentication-agent-1", title: "Authentication Required" }, true], [{ app: "gtk3_hostile.py", title: "Authentication Required" }, true],
    [{ title: "Authenticate" }, true], [{ app: "gcr-prompter", title: "" }, true], [{ title: "Unlock Login Keyring" }, true], [{ title: "Enter password for “ada@example.com”" }, true],
    [{ title: "[sudo] password for ada" }, true], [{ title: "Password Required" }, true], [{ app: "pinentry-gnome3", title: "" }, true], [{ app: "ssh-askpass", title: "" }, true],
    [{ app: "firewall-config", title: "Firewall Configuration" }, true],
    [{ app: "mousepad", title: "firewall-notes.txt - Mousepad" }, false], [{ app: "Firefox", title: "How sudo works — Mozilla Firefox" }, false],
    [{ app: "soffice", title: "Security settings review.odt - LibreOffice Writer" }, false], [{ app: "Firefox", title: "Firewall - Wikipedia" }, false],
    [{ app: "gedit", title: "password-manager-comparison.md - gedit" }, false], [{ app: "gedit", title: "Authentication methods (draft).txt - gedit" }, false],
  ] as const)("security window %o: %s", (w, expected) => {
    expect(isSecurityWindow(w)).toBe(expected);
  });
});

describe("audit journal copy (review round 3)", () => {
  it("keeps element names and chosen values as sizes; keys and settings stay readable", async () => {
    const { journalLine } = await import("../../app/main/policy/audit");
    const click = JSON.parse(journalLine(JSON.stringify({ event: "action", kind: "click", app: "Evolution", element: { role: "table cell", name: "Re: your test results" }, ok: true })));
    expect(click.element).toEqual({ role: "table cell", nameChars: 21 });
    const choice = JSON.parse(journalLine(JSON.stringify({ event: "action", kind: "select", element: { role: "combo box", name: "Reason" }, value: "Pregnancy test", after: { states: [], selected: "Pregnancy test" } })));
    expect(choice).toEqual({ event: "action", kind: "select", element: { role: "combo box", nameChars: 6 }, valueChars: 14, after: { states: [], selectedChars: 14 } });
    expect(JSON.parse(journalLine(JSON.stringify({ event: "decision", kind: "keys", value: "ctrl+s" }))).value).toBe("ctrl+s");
  });
});
