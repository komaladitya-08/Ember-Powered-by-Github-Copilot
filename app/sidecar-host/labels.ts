/**
 * Labels for unnamed controls, as the Python sidecar finds them: the label on a field's row to its left, else just above
 * it (a label that already names a control on its own row names nothing below it), and the first label inside an
 * unnamed option (GTK's list rows, WinUI's templated list items hold theirs). The host uses them to judge fields secret
 * ("Password", "Card number" beside an unnamed field) and to name options; the rule itself is elements.ts's
 * inferLabels, shared with Ember's own second check, so the two can't drift apart.
 */

import { inferLabels, isSecretLabel, namedByValue } from "../main/perception/elements";
import type { AxNode } from "../main/perception/sidecar";
import { FIELD_ROLES, LABEL_ROLES } from "./roles";

/**
 * The unnamed fields of a read (and combo boxes named after what they show) that sit beside or under a label saying
 * their contents are secret, by id. Fields already secret aren't looked at again.
 */
export function secretByLayout(nodes: AxNode[]): number[] {
  const labels = inferLabels(nodes, { anyAbove: true });
  return nodes.filter(n => FIELD_ROLES.has(n.role) && !n.secret && n.bounds && (!n.name || namedByValue(n))
    && isSecretLabel(labels.get(n.id) ?? "")).map(n => n.id);
}

/** How deep inside an option its label is looked for, and how many children of each level. */
export const INNER_LABEL_LEVELS = 4;
const INNER_LABEL_CHILDREN = 16;

/** An element of a tree being searched for a label: its role in AT-SPI's words, its name, and how to get its children. */
export interface LabelSearch { role: string; name: string; children(): Promise<LabelSearch[]> }

/**
 * The first label with a letter or digit in it inside an element, depth first, INNER_LABEL_LEVELS levels down at most
 * ("" for none). Keep in step with inferLabels in elements.ts and inner_label in ember_atspi.py.
 */
export async function innerLabel(el: LabelSearch, level = 1): Promise<string> {
  let kids: LabelSearch[];
  try {
    kids = (await el.children()).slice(0, INNER_LABEL_CHILDREN);
  } catch {
    return ""; // can't be asked: no label
  }
  for (const c of kids) {
    if (LABEL_ROLES.has(c.role)) {
      const name = c.name.trim();
      if (/[\p{L}\p{N}]/u.test(name)) return name;
    }
    if (level < INNER_LABEL_LEVELS) {
      const name = await innerLabel(c, level + 1);
      if (name) return name;
    }
  }
  return "";
}
