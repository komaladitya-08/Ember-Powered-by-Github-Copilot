/** Keeps saved settings rows attached across background updates, and recovers focus only when its row disappears. */

interface Row<T> { value: T; el: HTMLElement }

/** A settings list whose keys name the same saved item, even when neighbouring items change. */
export class KeyedRows<T> {
  private rows = new Map<string, Row<T>>();
  constructor(private list: HTMLElement, private options: {
    key: (value: T) => string;
    create: (read: () => T) => HTMLElement;
    update?: (el: HTMLElement, value: T) => void;
    empty: () => string;
    fallback: () => HTMLElement;
  }) {}

  /** Reuses surviving rows and their controls; a removed focused row yields to its nearest remaining neighbour. */
  render(values: readonly T[]): void {
    const active = document.activeElement as HTMLElement | null;
    const focused = !!active && this.list.contains(active);
    const index = focused ? [...this.list.children].findIndex(el => el.contains(active)) : -1;
    const next = new Map<string, Row<T>>();
    for (const value of values) {
      const key = this.options.key(value);
      let row = this.rows.get(key);
      if (!row) {
        row = { value, el: document.createElement("li") };
        const current = row;
        row.el = this.options.create(() => current.value);
      }
      row.value = value;
      this.options.update?.(row.el, value);
      next.set(key, row);
    }
    const nodes = [...next.values()].map(row => row.el);
    const retained = new Set(nodes);
    for (const child of [...this.list.children]) if (!retained.has(child as HTMLElement)) child.remove();
    for (const [i, el] of nodes.entries()) {
      if (this.list.children[i] !== el) this.list.insertBefore(el, this.list.children[i] ?? null);
    }
    if (!nodes.length) this.list.append(Object.assign(document.createElement("li"), { className: "empty", textContent: this.options.empty() }));
    this.rows = next;
    if (focused) {
      if (active && this.list.contains(active)) { if (document.activeElement !== active) active.focus(); }
      else (nodes[Math.min(index, nodes.length - 1)]?.querySelector<HTMLElement>("button") ?? this.options.fallback()).focus();
    }
  }
}
