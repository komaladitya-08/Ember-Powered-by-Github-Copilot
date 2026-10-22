/**
 * Secret fields and withheld names, as the Python sidecar keeps them: a password field, or a field named or labelled as
 * a password, payment or one-time-code field, never has its contents reported, and names that say what one holds (a
 * row named after the card number in it, a button named "Pay with 4821") are withheld. Fields once found secret stay
 * secret by their keys (a "Show password" toggle turns a password field into a plain one), and Ember hands those keys
 * to every new host process (remember_secrets). The word lists and the rules for values in names are elements.ts's
 * (isSecretLabel, withheldIds): there is no third copy of them here.
 */

import { insideSecrets, isSecretLabel, withheldIds } from "../main/perception/elements";
import type { AxNode } from "../main/perception/sidecar";
import type { RawNode } from "./provider";
import { secretByLayout } from "./labels";
import { FIELD_ROLES } from "./roles";

/** An element's key on the wire: two strings that name it across host restarts (opaque to Ember). */
export type WireKey = [string, string];

/** How many keys of each kind are kept (as the Python sidecar and Ember keep them). */
export const KEYS_KEPT = 4096;

/** The most recent keys of one kind (secret fields, or withheld names). */
export class KeySet {
  private keys = new Map<string, WireKey>();

  constructor(private limit = KEYS_KEPT) {}

  add(k: WireKey | null | undefined): void {
    if (!k) return;
    const s = `${k[0]} ${k[1]}`;
    this.keys.delete(s);
    this.keys.set(s, [k[0], k[1]]);
    while (this.keys.size > this.limit) this.keys.delete(this.keys.keys().next().value!);
  }

  has(k: WireKey | null | undefined): boolean {
    return !!k && this.keys.has(`${k[0]} ${k[1]}`);
  }

  get size(): number {
    return this.keys.size;
  }
}

/** The values a secret field holds, never reported: only looked for in the names around it. */
export type SecretValues = Pick<AxNode, "name" | "role" | "text" | "selected" | "value">;

/** Apps whose secret fields' values are remembered (for options and choices read later). */
const VALUE_APPS = 8;

/** A read after its last checks: its nodes, the keys it sends back (secret fields, withheld names), and the ids it no longer lists. */
export interface Redaction { nodes: AxNode[]; secretKeys: WireKey[]; withheldKeys: WireKey[]; removed: number[] }

/** What the host knows about secrets, for as long as it runs (and what Ember hands to its next process). */
export class Secrets {
  readonly fields = new KeySet();
  readonly withheld = new KeySet();
  /** The values the secret fields of each app's last read held (by pid): names that say them are withheld later too. */
  private values = new Map<number, SecretValues[]>();

  /** An element's key on the wire. */
  static key(kind: string, n: Pick<RawNode, "key">): WireKey | null {
    return n.key ? [kind, n.key] : null;
  }

  /**
   * Is this element's text off limits? A password field (now or once: its key), or a field named, labelled or with a
   * placeholder that says it is secret. A secret one is remembered.
   */
  isSecret(key: WireKey | null, n: Pick<RawNode, "labelledBy" | "help" | "placeholder">, role: string, name: string): boolean {
    if (role === "password text" || this.fields.has(key)) {
      this.fields.add(key);
      return true;
    }
    if (!FIELD_ROLES.has(role)) return false;
    if (isSecretLabel(name) || isSecretLabel(n.labelledBy ?? "") || isSecretLabel(n.placeholder ?? "") || isSecretLabel(n.help ?? "")) {
      this.fields.add(key);
      return true;
    }
    return false;
  }

  /**
   * A read's last checks, after its elements are listed (`hidden`: what the secret fields among them hold, kept apart
   * and never reported): unnamed fields beside a secret label become secret, and so does a combo box whose field is; the
   * names that say what a secret field holds are withheld (its listed containers', and any element's that says what the
   * user put in one as words of their own); names withheld before stay withheld; and what is inside a secret field
   * goes (Chromium lists a text box's text inside it). `keyOf` gives an id's key.
   */
  redact(nodes: AxNode[], hidden: Map<number, SecretValues>, keyOf: (id: number) => WireKey | null, pid: number | null): Redaction {
    for (const id of secretByLayout(nodes)) this.makeSecret(nodes.find(n => n.id === id)!, hidden, keyOf);
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const n of nodes) {
      const combo = n.secret && n.parent !== null ? byId.get(n.parent) : undefined;
      if (combo?.role === "combo box" && !combo.secret) this.makeSecret(combo, hidden, keyOf);
    }
    const secret = new Set(nodes.filter(n => n.secret).map(n => n.id));
    // Names are checked against what the secret fields hold, put back for this check only.
    const told = nodes.map(n => (hidden.has(n.id) ? { ...n, ...hidden.get(n.id)! } : n));
    const selectedOnly = new Set<number>();
    const held = withheldIds(told, secret, selectedOnly);
    for (const n of nodes) {
      if ((n.name || n.text) && this.withheld.has(keyOf(n.id))) held.add(n.id);
    }
    const withheldKeys: WireKey[] = [];
    for (const n of nodes) {
      if (held.has(n.id)) {
        n.name = "";
        n.withheld = true;
        delete n.text;
        delete n.selection;
        delete n.selected;
        const k = keyOf(n.id);
        if (k) {
          this.withheld.add(k);
          withheldKeys.push(k);
        }
      } else if (selectedOnly.has(n.id)) {
        delete n.selected; // a drop-down that shows what the user put in a field: its own name says nothing
      }
    }
    if (pid !== null) this.rememberValues(pid, told.filter(n => secret.has(n.id)));
    const inside = insideSecrets(nodes, secret);
    const kept = inside.size ? nodes.filter(n => !inside.has(n.id)) : nodes;
    const secretKeys = new Map<string, WireKey>();
    for (const n of kept) {
      const k = n.secret ? keyOf(n.id) : null;
      if (k) secretKeys.set(`${k[0]} ${k[1]}`, k);
    }
    return { nodes: kept, secretKeys: [...secretKeys.values()], withheldKeys, removed: [...inside] };
  }

  /**
   * Is `name` (an option's, a row's, a combo box's choice) one that says what the user put in a secret field of app
   * `pid`'s last read, as words of its own? Then it is reported as "".
   */
  saysSecret(name: string, pid: number | null | undefined): boolean {
    const known = pid == null ? undefined : this.values.get(pid);
    if (!name || !known?.length) return false;
    const fields: AxNode[] = known.map((v, i) => ({ ...v, id: -1 - i, parent: null, depth: 1, states: [], bounds: null, secret: true }));
    const candidate: AxNode = { id: 0, parent: null, depth: 1, role: "label", name, states: [], bounds: null };
    return withheldIds([...fields, candidate], new Set(fields.map(f => f.id))).has(0);
  }

  /** A name as it may be reported: none for one withheld before (by its key). */
  saidName(name: string, key: WireKey | null, pid?: number | null): string {
    return !name || this.withheld.has(key) || this.saysSecret(name, pid) ? "" : name;
  }

  /** A node found secret after it was listed: what it holds goes (kept apart), and it stays secret. */
  private makeSecret(n: AxNode, hidden: Map<number, SecretValues>, keyOf: (id: number) => WireKey | null): void {
    hidden.set(n.id, { name: n.name, role: n.role, text: n.text, selected: n.selected, value: n.value });
    delete n.text;
    delete n.selection;
    delete n.value;
    delete n.selected;
    n.secret = true;
    this.fields.add(keyOf(n.id));
  }

  private rememberValues(pid: number, fields: SecretValues[]): void {
    this.values.delete(pid);
    const told = fields.filter(f => f.text || f.selected || f.value !== undefined).map(f => ({ name: f.name, role: f.role, text: f.text, selected: f.selected, value: f.value }));
    if (!told.length) return;
    this.values.set(pid, told);
    while (this.values.size > VALUE_APPS) this.values.delete(this.values.keys().next().value!);
  }
}
