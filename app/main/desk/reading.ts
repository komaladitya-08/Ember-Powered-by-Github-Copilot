/** A bounded, read-only description for the desk viewer, using the same secret/never-look boundaries as perception. */
import type { Seen } from "../perception";
import { inferLabels, insideSecrets, secretIds, withheldIds } from "../perception/elements";
import type { DeskReading } from "../../shared/desk";

/** Translate a fresh accessibility read into inert human-readable controls, never action IDs or approval buttons. */
export function deskReading(seen: Seen, now = Date.now()): DeskReading {
  const empty = (message: string): DeskReading => ({ at: now, title: "", message, rows: [] });
  if (seen.blocked || seen.ember) return empty("This window is private. Its contents aren't shown.");
  if (!seen.window) return empty("The app isn't exposing text right now. Refresh after it finishes loading.");
  const secret = secretIds(seen.nodes), hidden = insideSecrets(seen.nodes, secret);
  const hiddenSelection = new Set<number>();
  const withheld = withheldIds(seen.nodes, secret, hiddenSelection);
  const nodes = seen.nodes.filter(n => !secret.has(n.id) && !hidden.has(n.id) && !withheld.has(n.id) && !n.secret && !n.withheld);
  const labels = inferLabels(nodes);
  const rows: DeskReading["rows"] = [];
  let size = 0, limited = false;
  for (const n of nodes) {
    const name = (n.name || labels.get(n.id) || "").slice(0, 240);
    const text = (n.text ?? "").slice(0, 2000);
    const selected = hiddenSelection.has(n.id) ? "" : (n.selected ?? n.selection ?? "").slice(0, 400);
    if (!name && !text && !selected) continue;
    const states = n.states.filter(s => ["focused", "checked", "selected", "expanded", "collapsed", "disabled"].includes(s));
    const value = [text, selected && selected !== text ? `Selected: ${selected}` : "", states.join(", ")].filter(Boolean).join(" · ");
    if (rows.length >= 100 || size + name.length + value.length > 24_000) { limited = true; break; }
    size += name.length + value.length;
    rows.push({ role: n.role.slice(0, 60), name, text: value });
    if ((n.text?.length ?? 0) > text.length || (n.name?.length ?? 0) > name.length) limited = true;
  }
  return { at: now, title: seen.window.name.slice(0, 240), rows,
    message: `${seen.busy || seen.truncated || limited ? "Partial text; some contents aren't listed. " : ""}Read-only snapshot. Refresh to see changes. Private fields are omitted; these rows don't operate the app.` };
}
