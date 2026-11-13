/**
 * Apps & privacy › Vault: the list of what the vault keeps (app/main/vault/), by kind, destination and date only, with
 * Forget for each and Forget all, which asks first. Home is never sent a value, and shows none. With the
 * organisation's switch off the list stays, with Forget, and the hint says nothing new is kept or filled in.
 */
import type { EmberVaultHomeApi, VaultEntryRow, VaultHomeState } from "../../shared/vault";
import { VAULT_EMPTY, VAULT_UNREAD, VAULT_WORDS, vaultDay, vaultForgetAllScope, vaultForgetLabel, vaultHint, vaultRowText } from "./copy";

declare global { interface Window { emberVault?: EmberVaultHomeApi } }

/**
 * Mounts the vault's list; it reads again whenever main says the list changed. Without the bridge (a page main didn't
 * load) the list says it couldn't be read, never that it is empty.
 */
export function mountVault(bridge: EmberVaultHomeApi | undefined): void {
  const $ = (id: string) => document.getElementById(id)!;
  if (!bridge) {
    $("vault-hint").textContent = vaultHint(true);
    $("vault-list").replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: VAULT_UNREAD }));
    return;
  }
  const api = bridge;
  const list = $("vault-list");
  const hint = $("vault-hint");
  const message = $("vault-msg");
  const bulk = $("vault-forget-all") as HTMLButtonElement;
  const confirm = $("vault-forget-confirm");
  const scope = $("vault-forget-scope");
  const yes = $("vault-forget-yes") as HTMLButtonElement;
  const no = $("vault-forget-no") as HTMLButtonElement;
  let rows: VaultEntryRow[] = [];
  /** The newest read wins: an older answer that comes back later is dropped. */
  let reads = 0;
  /** Where the keyboard goes after the list is drawn again: the row at this place, else the list itself. */
  let focusAt: number | null = null;
  const say = (text: string) => { if (message.textContent !== text) message.textContent = text; };
  const closeConfirm = () => { confirm.hidden = true; };

  function draw(state: VaultHomeState): void {
    // The keyboard stays where it was when the list is drawn again under it (a Forget's own redraw, or main's push).
    const held = [...list.querySelectorAll("button")].indexOf(document.activeElement as HTMLButtonElement);
    if (focusAt === null && held >= 0) focusAt = held;
    rows = state.entries;
    const text = vaultHint(state.allowed);
    if (hint.textContent !== text) hint.textContent = text;
    list.replaceChildren(...(rows.length
      ? rows.map((r, i) => {
        const li = document.createElement("li");
        li.append(Object.assign(document.createElement("span"), { textContent: vaultRowText(r.kind, r.where, vaultDay(r.savedAt)) }));
        const btn = Object.assign(document.createElement("button"), { type: "button", className: "btn quiet small", textContent: "Forget" });
        btn.setAttribute("aria-label", vaultForgetLabel(r.kind, r.where));
        btn.addEventListener("click", () => {
          closeConfirm();
          focusAt = i;
          api.forget(r.id).then(ok => { say(ok ? VAULT_WORDS.forgot(r.kind, r.where) : VAULT_WORDS.failed); if (!ok) focusAt = null; void read(); },
            () => { focusAt = null; say(VAULT_WORDS.failed); });
        });
        li.append(btn);
        return li;
      })
      : [Object.assign(document.createElement("li"), { className: "empty", textContent: VAULT_EMPTY })]));
    bulk.hidden = !rows.length;
    if (!rows.length) closeConfirm();
    else if (!confirm.hidden) scope.textContent = vaultForgetAllScope(rows.length);
    if (focusAt !== null) {
      const buttons = list.querySelectorAll("button");
      (buttons[Math.min(focusAt, buttons.length - 1)] ?? list).focus();
      focusAt = null;
    }
  }

  async function read(): Promise<void> {
    const mine = ++reads;
    try {
      const state = await api.state();
      if (mine === reads) draw(state);
    } catch {
      if (mine !== reads) return;
      // Never shown as empty when it couldn't be read.
      list.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: VAULT_UNREAD }));
      bulk.hidden = true;
      closeConfirm();
    }
  }

  bulk.addEventListener("click", () => {
    if (!rows.length) return;
    scope.textContent = vaultForgetAllScope(rows.length);
    confirm.hidden = false;
    say("");
    // "Keep them" is the safe choice: the keyboard starts there.
    no.focus();
  });
  no.addEventListener("click", () => { closeConfirm(); bulk.focus(); });
  confirm.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    closeConfirm();
    bulk.focus();
  });
  yes.addEventListener("click", () => {
    closeConfirm();
    const done = (ok: boolean) => {
      say(ok ? VAULT_WORDS.forgotAll : VAULT_WORDS.failedAll);
      void read().then(() => { (bulk.hidden ? list : bulk).focus(); });
    };
    api.forgetAll().then(done, () => done(false));
  });
  api.onChanged(() => { void read(); });
  hint.textContent = vaultHint(true);
  void read();
}
