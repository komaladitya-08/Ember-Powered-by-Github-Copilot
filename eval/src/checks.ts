/** Checkers for the task suite: what the apps, settings and files look like after a task. */

import fs from "node:fs";
import { execFile } from "node:child_process";
import type { AtspiSidecar, AxNode } from "../../app/main/perception/sidecar";
import { inferLabels } from "../../app/main/perception/elements";
import type { Check } from "./schema";

export interface CheckContext {
  sidecar: AtspiSidecar;
  /** Events the fixture windows logged. */
  events: () => Record<string, unknown>[];
  /** Expands {tmp} in paths. */
  expand: (s: string) => string;
  /** Ember's audit log for this attempt. */
  audit: () => Record<string, unknown>[];
  /** The worker's result. */
  result: () => { success: boolean; summary: string } | null;
}

export interface CheckResult {
  ok: boolean;
  /** What was checked, in words. */
  what: string;
  /** What was actually there (for the report). */
  got: string;
}

const gsettingsGet = (schema: string, key: string) => new Promise<string>((resolve, reject) =>
  execFile("gsettings", ["get", schema, key], { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out.trim()))));

/** `role "name"` for an element, with the label inferred for unnamed controls (as workers see it). */
export function elementLine(n: AxNode, labels: Map<number, string>): string {
  const name = n.name || labels.get(n.id) || "";
  return name ? `${n.role} "${name}"` : n.role;
}

export async function findElement(sidecar: AtspiSidecar, window: string, find: string): Promise<{ node: AxNode | null; line: string; window: boolean }> {
  const r = await sidecar.readWindow({ title: window }).catch(() => null);
  if (!r?.window) return { node: null, line: "", window: false };
  const labels = inferLabels(r.nodes);
  const re = new RegExp(find);
  for (const n of r.nodes) {
    const line = elementLine(n, labels);
    if (re.test(line)) return { node: n, line, window: true };
  }
  return { node: null, line: "", window: true };
}

export async function runCheck(c: Check, ctx: CheckContext): Promise<CheckResult> {
  if ("atspi" in c) {
    const a = c.atspi;
    const { node, line, window } = await findElement(ctx.sidecar, a.window, a.find);
    const what = `${a.window}: ${a.find}${a.states ? ` is ${a.states.join("+")}` : ""}${a.notStates ? ` not ${a.notStates.join("+")}` : ""}${a.text !== undefined ? ` text=${JSON.stringify(a.text)}` : ""}${a.textContains ? ` text has ${JSON.stringify(a.textContains)}` : ""}`;
    if (!window) return { ok: false, what, got: "window not found" };
    if (!node) return { ok: false, what, got: "element not found" };
    const problems: string[] = [];
    for (const s of a.states ?? []) if (!node.states.includes(s)) problems.push(`not ${s}`);
    for (const s of a.notStates ?? []) if (node.states.includes(s)) problems.push(s);
    if (a.text !== undefined && (node.text ?? "") !== a.text) problems.push(`text ${JSON.stringify(node.text ?? "")}`);
    if (a.textContains && !(node.text ?? "").includes(a.textContains)) problems.push(`text ${JSON.stringify((node.text ?? "").slice(0, 80))}`);
    if (a.selected !== undefined) {
      const info = await ctx.sidecar.readElement(node.id).catch(() => null);
      const value = info?.selected ?? node.text ?? node.name;
      if (value !== a.selected) problems.push(`selected is ${JSON.stringify(value)}`);
    }
    return { ok: problems.length === 0, what, got: problems.length ? `${line}: ${problems.join(", ")}` : `${line} (${node.states.filter(s => ["checked", "pressed", "selected", "focused"].includes(s)).join(", ") || "ok"})` };
  }
  if ("gsettings" in c) {
    const [schema, key] = c.gsettings;
    const what = `gsettings ${schema} ${key} = ${c.equals}`;
    try {
      const got = await gsettingsGet(schema, key);
      return { ok: got === c.equals, what, got };
    } catch (err) {
      return { ok: false, what, got: `can't read: ${(err as Error).message.split("\n")[0]}` };
    }
  }
  if ("file" in c) {
    const file = ctx.expand(c.file);
    const what = `${c.file}${c.exists === false ? " absent" : ""}${c.contains ? ` contains ${JSON.stringify(c.contains)}` : ""}${c.equals !== undefined ? " equals expected" : ""}`;
    if (!fs.existsSync(file)) return { ok: c.exists === false, what, got: "no file" };
    if (c.exists === false) return { ok: false, what, got: "file exists" };
    if (fs.statSync(file).isDirectory()) return { ok: c.contains === undefined && c.equals === undefined, what, got: "a folder" };
    const body = fs.readFileSync(file, "utf8");
    const ok = (c.contains === undefined || body.includes(c.contains)) && (c.notContains === undefined || !body.includes(c.notContains)) && (c.equals === undefined || body === c.equals);
    return { ok, what, got: JSON.stringify(body.length > 120 ? body.slice(0, 120) + "…" : body) };
  }
  if ("answer" in c) {
    const r = ctx.result();
    const what = `Ember says${c.answer.success !== undefined ? ` it ${c.answer.success ? "did" : "couldn't do"} it` : ""}${c.answer.contains ? ` (mentioning ${c.answer.contains.map(x => JSON.stringify(x)).join(", ")})` : ""}`;
    if (!r) return { ok: false, what, got: "no answer" };
    const text = r.summary.toLowerCase();
    const ok = (c.answer.success === undefined || r.success === c.answer.success) && (c.answer.contains ?? []).every(x => text.includes(x.toLowerCase()));
    return { ok, what, got: `${r.success ? "done" : "not done"}: ${JSON.stringify(r.summary.slice(0, 120))}` };
  }
  const [want, list, label] = "audit" in c ? [c.audit, ctx.audit(), "audit entry"] as const : [c.event, ctx.events(), "event"] as const;
  const what = `${c.absent ? "no " : ""}${label} ${JSON.stringify(want)}`;
  const flat = (e: Record<string, unknown>) => ({ ...e, ...(e.element && typeof e.element === "object" ? Object.fromEntries(Object.entries(e.element).map(([k, v]) => [`element.${k}`, v])) : {}) });
  const hit = list.map(flat).find(e => Object.entries(want).every(([k, v]) => e[k] === v));
  const ok = c.absent ? !hit : !!hit;
  // Show what was found only when it explains a failure.
  return { ok, what, got: hit ? (ok ? "found" : JSON.stringify(hit).slice(0, 160)) : "none" };
}

/** A check's current value, to compare before and after (for "nothing else changed"). */
export async function snapshot(c: Check, ctx: CheckContext): Promise<string> {
  const r = await runCheck(c, ctx);
  return `${r.ok}|${r.got}`;
}
