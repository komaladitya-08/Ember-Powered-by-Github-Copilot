/**
 * The Secure Form's controller (the vault; the round's brief, decision 2): only main opens it, its words are main's,
 * the values come once from its own page for the form on screen, are checked whole and go straight to be sealed, and
 * nothing it answers, logs or sends holds a value.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createVaultForm, formView, VAULT_FORM_SIZE, type VaultFormRequest, type VaultWindowLike } from "../../app/main/vault/form";
import type { VaultKept } from "../../app/main/vault/store";
import type { IpcLike, WebContentsLike } from "../../app/main/targets/types";
import { saveHeldBack } from "../../app/renderer/vault/copy";
import { PROMPT_ARM_MS } from "../../app/renderer/prompt/copy";
import { VAULT_IPC, VAULT_KINDS, type VaultFormView, type VaultSubmitResult } from "../../app/shared/vault";

const CANARY = "hunter2-CANARY-9f3a";
const read = (f: string) => fs.readFileSync(f, "utf8");

interface FakeWin extends VaultWindowLike { closed: boolean; shown: number; keyboard: number; kind: string; emitClosed(): void }
function harness(o: { keep?: (kind: string, dest: unknown, values: unknown) => Promise<VaultKept>; create?: () => never } = {}) {
  const handlers = new Map<string, (e: { sender: WebContentsLike }, ...a: unknown[]) => unknown>();
  const ipc: IpcLike = { on: (c, f) => { handlers.set(c, f); }, handle: (c, f) => { handlers.set(c, f); } };
  const wins: FakeWin[] = [];
  const logged: unknown[] = [];
  const kept: { kind: string; dest: unknown; values: unknown }[] = [];
  let nextId = 100;
  const log = { info: (m: string, f?: unknown) => logged.push([m, f]), warn: (m: string, f?: unknown) => logged.push([m, f]), error: (m: string, f?: unknown) => logged.push([m, f]), debug: (m: string, f?: unknown) => logged.push([m, f]) };
  const form = createVaultForm({
    ipc, log: log as never,
    create: o.create ?? (kind => {
      const on: Record<string, (() => void)[]> = {};
      const w: FakeWin = {
        webContents: { id: nextId++, send: () => { throw new Error("nothing is ever sent to the form's page"); } },
        closed: false, shown: 0, keyboard: 0, kind,
        show: () => { w.shown++; }, showInactive: () => {}, hide: () => {}, focus: () => {}, moveTop: () => {},
        close: () => { if (w.closed) return; w.closed = true; for (const f of on.closed ?? []) f(); },
        isVisible: () => true, isMinimized: () => false, isDestroyed: () => w.closed, isAlwaysOnTop: () => true, isFocused: () => true,
        setAlwaysOnTop: () => {}, setBounds: () => {}, setContentProtection: () => {},
        on: (ev: string, f: () => void) => { (on[ev] ??= []).push(f); },
        takeKeyboard: () => { w.keyboard++; },
        emitClosed: () => w.close(),
      };
      wins.push(w);
      return w;
    }),
    keep: o.keep ?? (async (kind, dest, values) => { kept.push({ kind, dest, values }); return { ok: true, id: "11111111-1111-4111-8111-111111111111" }; }),
  });
  const from = (w: { webContents: WebContentsLike } | number) => ({ sender: typeof w === "number" ? { id: w, send: () => {} } : w.webContents });
  const view = (w: FakeWin) => handlers.get(VAULT_IPC.form)!(from(w)) as VaultFormView | null;
  const submit = (w: FakeWin | number, id: unknown, values: unknown) => handlers.get(VAULT_IPC.submit)!(from(w), id, values) as Promise<VaultSubmitResult>;
  const cancel = (w: FakeWin | number, id: unknown) => { handlers.get(VAULT_IPC.cancel)!(from(w), id); };
  return { form, handlers, wins, logged, kept, view, submit, cancel };
}
const GITHUB = { site: "https://github.com" };
const req = (o: Partial<VaultFormRequest> = {}): VaultFormRequest => ({ kind: "login", dest: GITHUB, where: "github.com", via: "Firefox", keyring: true, ...o });
const login = { user: "ada", password: CANARY };

describe("the Secure Form's view", () => {
  it("is built from the kind and the destination: its title, where it is for, and each part's label and limits (vault-2)", () => {
    expect(formView("id-1", req())).toEqual({
      id: "id-1", kind: "login", keyring: true,
      title: "Login for github.com",
      where: "Asked in Firefox. Ember fills it in only on github.com, in any browser.",
      lead: "Ember keeps it locked with your computer's keyring and uses it only in Autopilot. It never shows it to you again, and the AI model never sees it.",
      parts: [
        { part: "user", label: "User name or email", secret: false, required: false, max: 256, multiline: false },
        { part: "password", label: "Password", secret: true, required: true, max: 1024, multiline: false },
      ],
    });
    const card = formView("c", req({ kind: "card", dest: { app: "thunderbird" }, where: "Thunderbird", via: "Firefox" }));
    expect(card.where).toBe("Ember fills it in only in Thunderbird.");
    expect(card.parts.filter(p => p.secret).map(p => p.part)).toEqual(["cardNumber", "securityCode"]);
    expect(formView("a", req({ kind: "contact" })).parts.find(p => p.part === "address")?.multiline).toBe(true);
    for (const k of VAULT_KINDS) expect(VAULT_FORM_SIZE[k].width).toBe(440);
  });
});

describe("the Secure Form", () => {
  it("opens a window of its own for one form, takes the keyboard, and gives the view only to that window's page (vault-2)", async () => {
    const h = harness();
    const answer = h.form.ask(req());
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0]).toMatchObject({ shown: 1, keyboard: 1, kind: "login" });
    expect(h.view(h.wins[0])).toMatchObject({ title: "Login for github.com", keyring: true });
    expect(h.handlers.get(VAULT_IPC.form)!({ sender: { id: 7, send: () => {} } })).toBeNull();
    expect(h.form.owns(h.wins[0].webContents)).toBe(true);
    expect(h.form.owns({ id: 7, send: () => {} })).toBe(false);
    expect(h.form.owns(undefined)).toBe(false);
    h.cancel(h.wins[0], h.view(h.wins[0])!.id);
    expect(await answer).toBe("cancelled");
  });

  it("keeps what was typed once, sealed by `keep`, answers saved and closes the window (vault-2)", async () => {
    const h = harness();
    const answer = h.form.ask(req());
    const w = h.wins[0];
    expect(await h.submit(w, h.view(w)!.id, login)).toEqual({ ok: true });
    expect(await answer).toBe("saved");
    expect(h.kept).toEqual([{ kind: "login", dest: GITHUB, values: login }]);
    expect(w.closed).toBe(true);
    // The same Save again, from the closed window or for the old form: nothing more is kept.
    expect(await h.submit(w, "x", login)).toEqual({ ok: false, why: "gone" });
    expect(h.kept).toHaveLength(1);
  });

  it("takes values only from its own page, only for the form on screen (vault-2)", async () => {
    const h = harness();
    const answer = h.form.ask(req());
    const w = h.wins[0];
    const id = h.view(w)!.id;
    expect(await h.submit(7, id, login)).toEqual({ ok: false, why: "gone" });
    expect(await h.submit(w, "another-form", login)).toEqual({ ok: false, why: "gone" });
    expect(await h.submit(w, 5, login)).toEqual({ ok: false, why: "gone" });
    h.cancel(7, id);
    h.cancel(w, "another-form");
    expect(h.kept).toEqual([]);
    expect(w.closed).toBe(false);
    h.cancel(w, id);
    expect(await answer).toBe("cancelled");
    expect(h.kept).toEqual([]);
  });

  it("checks what was typed whole before keeping it, and names the part, never its value (vault-2)", async () => {
    const h = harness();
    void h.form.ask(req());
    const w = h.wins[0];
    const id = h.view(w)!.id;
    expect(await h.submit(w, id, { user: "ada" })).toEqual({ ok: false, why: "invalid", part: "password" });
    expect(await h.submit(w, id, { password: `${CANARY}\n` })).toEqual({ ok: false, why: "invalid", part: "password" });
    expect(await h.submit(w, id, { ...login, cardNumber: "4242424242424242" })).toEqual({ ok: false, why: "invalid" });
    expect(await h.submit(w, id, "x".repeat(100_000))).toEqual({ ok: false, why: "invalid" });
    expect(await h.submit(w, id, null)).toEqual({ ok: false, why: "invalid" });
    expect(h.kept).toEqual([]);
    expect(w.closed).toBe(false);
  });

  it("keeps nothing without a keyring: Save says so and the form stays to be closed (vault-2)", async () => {
    const h = harness();
    const answer = h.form.ask(req({ keyring: false }));
    const w = h.wins[0];
    expect(h.view(w)!.keyring).toBe(false);
    expect(await h.submit(w, h.view(w)!.id, login)).toEqual({ ok: false, why: "keyring" });
    expect(h.kept).toEqual([]);
    h.cancel(w, h.view(w)!.id);
    // Closing a form that could keep nothing is nobody's no (integ-y-2).
    expect(await answer).toBe("unavailable");
  });

  it("answers a form that could keep nothing as unavailable when it is closed, and one that could as the person's own close (integ-y-2)", async () => {
    const done = (h: ReturnType<typeof harness>) => h.logged.filter(l => (l as [string])[0] === "vault.form_done").map(l => (l as [string, unknown])[1]);
    // Shown without a keyring: its Close, and its window's own close.
    for (const how of ["close", "window"] as const) {
      const h = harness();
      const answer = h.form.ask(req({ keyring: false }));
      const w = h.wins[0];
      if (how === "close") h.cancel(w, h.view(w)!.id); else w.emitClosed();
      expect(await answer).toBe("unavailable");
      expect(done(h)).toEqual([{ kind: "login", answer: "unavailable", unkept: "keyring" }]);
    }
    // A Save the keyring, the disk or a full vault refused, then closed: by Cancel, by the window, or closed while it was being kept.
    for (const why of ["keyring", "write", "full"] as const) {
      for (const how of ["cancel", "window", "during"] as const) {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        const h = harness({ keep: async () => { if (how === "during") await gate; return { ok: false, why }; } });
        const answer = h.form.ask(req());
        const w = h.wins[0];
        const id = h.view(w)!.id;
        const saving = h.submit(w, id, login);
        if (how === "during") { w.emitClosed(); release(); }
        expect(await saving).toEqual({ ok: false, why });
        if (how === "cancel") h.cancel(w, id); else if (how === "window") w.emitClosed();
        expect(await answer, `${why} ${how}`).toBe("unavailable");
        expect(done(h), `${why} ${how}`).toEqual([{ kind: "login", answer: "unavailable", unkept: why }]);
        expect(JSON.stringify(h.logged)).not.toContain(CANARY);
      }
    }
    // A keep that threw is the disk's refusal.
    const t = harness({ keep: async () => { throw new Error(`disk ${CANARY}`); } });
    const thrown = t.form.ask(req());
    await t.submit(t.wins[0], t.view(t.wins[0])!.id, login);
    t.wins[0].emitClosed();
    expect(await thrown).toBe("unavailable");
    expect(JSON.stringify(t.logged)).not.toContain(CANARY);
    // A form that could keep values: closed without a Save, or after a slip the person could have put right, is their own close.
    const c = harness();
    const closed = c.form.ask(req());
    expect(await c.submit(c.wins[0], c.view(c.wins[0])!.id, { user: "ada" })).toEqual({ ok: false, why: "invalid", part: "password" });
    c.cancel(c.wins[0], c.view(c.wins[0])!.id);
    expect(await closed).toBe("cancelled");
    expect(done(c)).toEqual([{ kind: "login", answer: "cancelled" }]);
    // A crashed page is still nobody's answer, and a Save that kept is saved.
    const s = harness();
    const saved = s.form.ask(req());
    expect(await s.submit(s.wins[0], s.view(s.wins[0])!.id, login)).toEqual({ ok: true });
    expect(await saved).toBe("saved");
    expect(done(s)).toEqual([{ kind: "login", answer: "saved" }]);
  });

  it("says why when keeping fails, and the form stays up to try again (vault-2)", async () => {
    for (const why of ["keyring", "write", "full", "invalid"] as const) {
      const h = harness({ keep: async () => ({ ok: false, why }) });
      void h.form.ask(req());
      const w = h.wins[0];
      expect(await h.submit(w, h.view(w)!.id, login)).toEqual({ ok: false, why });
      expect(w.closed).toBe(false);
    }
    const h = harness({ keep: async () => { throw new Error(`disk ${CANARY}`); } });
    void h.form.ask(req());
    expect(await h.submit(h.wins[0], h.view(h.wins[0])!.id, login)).toEqual({ ok: false, why: "write" });
  });

  it("keeps nothing when the person closes the window, and says nobody could answer when its page crashed (vault-2)", async () => {
    const h = harness();
    const a = h.form.ask(req());
    h.wins[0].emitClosed();
    expect(await a).toBe("cancelled");
    const b = h.form.ask(req());
    h.wins[1].pageGone = true;
    h.wins[1].emitClosed();
    expect(await b).toBe("unavailable");
    expect(h.kept).toEqual([]);
  });

  it("answers unavailable when no window can be made or the request isn't one main built (vault-2)", async () => {
    const h = harness({ create: () => { throw new Error("no display"); } });
    expect(await h.form.ask(req())).toBe("unavailable");
    const g = harness();
    for (const bad of [req({ kind: "passkey" as "login" }), req({ dest: { site: "https://github.com/login" } }), req({ dest: { app: "Firefox" } }), req({ where: "" }), req({ where: "a\nb" }), req({ where: "x".repeat(301) }), req({ via: "a\u0007" }), req({ keyring: "yes" as unknown as boolean })]) {
      expect(await g.form.ask(bad)).toBe("unavailable");
    }
    expect(g.wins).toEqual([]);
  });

  it("shows one form at a time, each in a new window, the next once the first is answered (vault-2)", async () => {
    const h = harness();
    const a = h.form.ask(req());
    const b = h.form.ask(req({ kind: "card", dest: { app: "thunderbird" }, where: "Thunderbird", via: null }));
    expect(h.wins).toHaveLength(1);
    h.cancel(h.wins[0], h.view(h.wins[0])!.id);
    expect(await a).toBe("cancelled");
    expect(h.wins).toHaveLength(2);
    expect(h.wins[0].closed).toBe(true);
    expect(h.wins[1].kind).toBe("card");
    // The first window's page can no longer answer anything.
    expect(h.handlers.get(VAULT_IPC.form)!({ sender: h.wins[0].webContents })).toBeNull();
    expect(h.view(h.wins[1])).toMatchObject({ title: "Card for Thunderbird" });
    h.cancel(h.wins[1], h.view(h.wins[1])!.id);
    expect(await b).toBe("cancelled");
  });

  it("closes every form at Stop, answers each stopped and opens none of the waiting ones (vault-2)", async () => {
    const h = harness();
    const a = h.form.ask(req());
    const b = h.form.ask(req({ kind: "card" }));
    h.form.stop();
    expect(await a).toBe("stopped");
    expect(await b).toBe("stopped");
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].closed).toBe(true);
    expect(await h.submit(h.wins[0], "x", login)).toEqual({ ok: false, why: "gone" });
    // And it can ask again afterwards; once disposed it never does.
    const c = h.form.ask(req());
    expect(h.wins).toHaveLength(2);
    h.form.dispose();
    expect(await c).toBe("stopped");
    expect(await h.form.ask(req())).toBe("unavailable");
  });

  it("refuses a second Save and a Cancel while one is being kept (vault-2)", async () => {
    let release: (k: VaultKept) => void = () => {};
    const h = harness({ keep: () => new Promise<VaultKept>(r => { release = r; }) });
    const answer = h.form.ask(req());
    const w = h.wins[0];
    const id = h.view(w)!.id;
    const first = h.submit(w, id, login);
    expect(await h.submit(w, id, login)).toEqual({ ok: false, why: "gone" });
    h.cancel(w, id);
    expect(w.closed).toBe(false);
    release({ ok: true, id: "11111111-1111-4111-8111-111111111111" });
    expect(await first).toEqual({ ok: true });
    expect(await answer).toBe("saved");
  });

  it("answers as the Save came out when its window is closed while it is being kept (vault-2)", async () => {
    for (const [result, want] of [[{ ok: true, id: "11111111-1111-4111-8111-111111111111" }, "saved"], [{ ok: false, why: "write" }, "unavailable"], [{ ok: false, why: "invalid" }, "cancelled"]] as const) {
      // (A Save the disk refused could keep nothing: closing its form is nobody's no, integ-y-2.)
      let release: (k: VaultKept) => void = () => {};
      const h = harness({ keep: () => new Promise<VaultKept>(r => { release = r; }) });
      const answer = h.form.ask(req());
      const w = h.wins[0];
      const pending = h.submit(w, h.view(w)!.id, login);
      w.emitClosed();
      release(result);
      await pending;
      expect(await answer).toBe(want);
    }
  });

  it("never logs, returns or sends a value (vault-2)", async () => {
    const h = harness();
    const answer = h.form.ask(req());
    const w = h.wins[0];
    const said = [await h.submit(w, h.view(w)!.id, { password: `${CANARY}\u0000` }), await h.submit(7, "x", login), await h.submit(w, h.view(w)!.id, login), await answer, h.view(w)];
    expect(JSON.stringify([said, h.logged])).not.toContain(CANARY);
    expect(JSON.stringify(h.logged)).not.toContain("ada");
    expect(JSON.stringify(h.logged)).not.toContain("github");
  });

  it("leaves an Enter alone that is a held key's repeat or comes before the form has had the keyboard for the prompt window's arm time (integ-y-3)", () => {
    const enter = { key: "Enter", repeat: false }, held = { key: "Enter", repeat: true };
    const at = 50_000;
    // Keys the person was typing into their own app land in the form as it takes the keyboard: their Enter saves nothing.
    expect(saveHeldBack(enter, "other", at, at)).toBe(true);
    expect(saveHeldBack(enter, "other", at + PROMPT_ARM_MS - 1, at)).toBe(true);
    expect(saveHeldBack(enter, "other", at + PROMPT_ARM_MS, at)).toBe(false);
    // A held Enter never saves, however long the form has been up.
    expect(saveHeldBack(held, "other", at + 60_000, at)).toBe(true);
    // A no is always safe: Enter on Cancel or Close, and Esc anywhere, are taken at once, held or not.
    for (const e of [enter, held]) expect(saveHeldBack(e, "cancel", at, at)).toBe(false);
    for (const target of ["other", "cancel", "lines"] as const) expect(saveHeldBack({ key: "Escape", repeat: false }, target, at, at)).toBe(false);
    // Enter in the address's box is a new line, and other keys are typing.
    for (const e of [enter, held]) expect(saveHeldBack(e, "lines", at, at)).toBe(false);
    for (const key of [" ", "a", "Tab"]) for (const repeat of [false, true]) expect(saveHeldBack({ key, repeat }, "other", at, at)).toBe(false);
    // The page asks it of every key-down before anything else sees the key, counting from when its window took the keyboard.
    const page = read("app/renderer/vault/main.ts");
    expect(page).toContain("if (saveHeldBack(e, target, Date.now(), keyboardAt)) e.preventDefault();\n}, true);");
    expect(page).toContain('window.addEventListener("focus", () => { keyboardAt = Date.now(); judgeFocus(); });');
    // One timing and one held-key rule: the prompt window's and the agree buttons' own.
    const copy = read("app/renderer/vault/copy.ts");
    expect(copy).toContain('import { PROMPT_ARM_MS } from "../prompt/copy";');
    expect(copy).toContain('import { heldPress } from "../../shared/provider";');
    expect(copy).not.toMatch(/\b\d{3,}\b/);
  });

  it("is bridged by a preload with only the form's three channels (vault-2)", () => {
    const preload = read("app/preload/vault.ts");
    expect([...preload.matchAll(/VAULT_IPC\.(\w+)/g)].map(m => m[1]).sort()).toEqual(["cancel", "form", "submit"]);
    expect(preload).not.toMatch(/ipcRenderer\.on\(/);
    expect(preload).toContain('contextBridge.exposeInMainWorld("emberVaultForm", api);');
  });

  it("is a window with contextIsolation, the sandbox and no Node, titled Ember, kept out of captures where the OS can (vault-2)", () => {
    const src = read("app/main/windows.ts");
    const factory = src.slice(src.indexOf("export function createVaultWindow"), src.indexOf("/** One of Ember's windows as main sees it"));
    expect(factory).toContain('webPreferences: webPreferences("vault"),');
    expect(factory).toContain('title: "Ember",');
    expect(factory).toContain('if (os === "win32" || os === "darwin") win.setContentProtection(true);');
    expect(factory).toContain("closeWhenGone(win);");
    expect(factory).toContain('pageUrl(path.join(appDir, "renderer", "vault", "index.html"))');
    expect(read("scripts/build-app.mjs")).toContain('const pages = ["home", "overlay", "handle", "ask", "mic", "desk", "command", "prompt", "vault"];');
  });

  it("types secret parts into password boxes and builds every word as text (vault-2)", () => {
    const page = read("app/renderer/vault/main.ts");
    expect(page).toContain('box.type = p.secret ? "password" : p.part === "email" ? "email" : "text";');
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(page).not.toMatch(/localStorage|sessionStorage|clipboard/);
    const html = read("app/renderer/vault/index.html");
    expect(html).toContain(`default-src 'self'; script-src 'self'; style-src 'self'`);
    expect(html).toContain("<title>Ember</title>");
  });
});
