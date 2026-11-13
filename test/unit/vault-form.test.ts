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
    expect(await answer).toBe("cancelled");
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
    for (const [result, want] of [[{ ok: true, id: "11111111-1111-4111-8111-111111111111" }, "saved"], [{ ok: false, why: "write" }, "cancelled"]] as const) {
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
