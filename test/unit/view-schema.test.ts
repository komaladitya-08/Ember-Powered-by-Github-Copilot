/**
 * Catalog v2 (app/shared/view.ts, app/main/agent/view-schema.ts): what main accepts of a worker's view. A view is a tree
 * of nodes from a closed catalog, flattened into a document with one root; every node's props are checked against its
 * kind, the whole document against the window profile's limits, and every string against Ember's own controls and voice
 * (a view never looks like Ember's question) and against secrets (refused whole, never shown redacted). A quote's
 * caption names an app only if the task read it. The model's instructions are generated from the same schemas.
 */

import { describe, expect, it } from "vitest";
import { MIMIC_WORDS, VIEW_KINDS, checkView, mimicRefusal, viewCatalogPrompt, type ViewContext } from "../../app/main/agent/view-schema";
import { EVERY_KIND } from "./view-fixtures";
import { LAYOUT_KINDS, VIEW_CATALOG, VIEW_PROFILES, upgradeView, viewText, walkView, type ViewDoc } from "../../app/shared/view";

const ctx: ViewContext = { appsRead: new Set(["Firefox"]) };
const check = (v: unknown, c: ViewContext = ctx) => checkView(v, c);
const ok = (v: unknown, c?: ViewContext) => { const r = check(v, c); if (!r.ok) throw new Error(r.error); return r.doc; };
const refused = (v: unknown, c?: ViewContext) => { const r = check(v, c); expect(r.ok, JSON.stringify(v).slice(0, 120)).toBe(false); return r as Extract<typeof r, { ok: false }>; };
const stack = (...children: unknown[]) => ({ kind: "stack", children });

describe("catalog v2", () => {
  it("takes a view of every kind, flattened into one document with Ember's ids for unnamed nodes", () => {
    const doc = ok(EVERY_KIND);
    expect(doc.catalog).toBe(VIEW_CATALOG);
    expect(doc.root).toBe("top");
    const kinds = new Set(Object.values(doc.nodes).map(n => n.kind));
    expect([...kinds].sort()).toEqual(Object.keys(VIEW_KINDS).sort());
    expect(doc.nodes.total.kind).toBe("metric");
    // Ember's ids are "_" and a number: the model's must start with a letter, so the two never collide.
    expect(Object.keys(doc.nodes).filter(id => id.startsWith("_")).every(id => /^_\d+$/.test(id))).toBe(true);
    expect(walkView(doc)).toHaveLength(Object.keys(doc.nodes).length);
  });

  it("upgrades a first-catalog view to a root stack of the same blocks", () => {
    const v1 = [{ kind: "text", text: "Found two." }, { kind: "facts", rows: [{ label: "Total", value: "£4,210" }] }];
    const doc = ok(v1);
    expect(doc).toEqual(upgradeView(v1 as never));
    expect(doc.nodes[doc.root]).toEqual({ kind: "stack", children: ["_2", "_3"] });
    expect(doc.nodes._3).toEqual({ kind: "keyvalue", rows: [{ label: "Total", value: "£4,210" }] });
    expect(viewText(doc)).toBe("Found two.\nTotal: £4,210");
  });

  it("puts a single block in a stack, since the root is always a layout node", () => {
    const doc = ok({ kind: "text", text: "Done." });
    expect(doc.nodes[doc.root].kind).toBe("stack");
  });

  it.each([
    ["a kind outside the catalog", stack({ kind: "html", html: "<b>hi</b>" })],
    ["a button", stack({ kind: "button", label: "Pay now" })],
    ["a link on a text", stack({ kind: "text", text: "Open", href: "https://example.com" })],
    ["a colour of its own", stack({ kind: "badge", text: "Late", tone: "caution", color: "#ff0000" })],
    ["a style", stack({ kind: "text", text: "Big", style: "font-size: 40px" })],
    ["a picture by URL", stack({ kind: "text", text: "Logo", image: "https://example.com/a.png" })],
    ["a tone outside the palette (the accent)", stack({ kind: "badge", text: "Late", tone: "accent" })],
    ["a symbol outside the set (a status mask)", stack({ kind: "callout", tone: "info", text: "x", symbol: "working" })],
    ["children on a leaf", stack({ kind: "text", text: "x", children: [{ kind: "text", text: "y" }] })],
    ["an empty layout node", stack({ kind: "row", children: [] })],
    ["a table row that doesn't match its columns", stack({ kind: "table", columns: ["a", "b"], rows: [["1"]] })],
    ["a table wider than a window", stack({ kind: "table", columns: Array.from({ length: 7 }, (_, i) => `c${i}`), rows: [Array.from({ length: 7 }, () => "1")] })],
    ["a chart whose series don't match its categories", stack({ kind: "chart", type: "bar", categories: ["a", "b"], series: [{ name: "s", values: [1] }] })],
    ["a bar chart of more categories than it can label", stack({ kind: "chart", type: "bar", categories: Array.from({ length: 13 }, (_, i) => `c${i}`), series: [{ name: "s", values: Array.from({ length: 13 }, () => 1) }] })],
    ["a chart of four series", stack({ kind: "chart", type: "line", categories: ["a"], series: Array.from({ length: 4 }, (_, i) => ({ name: `s${i}`, values: [1] })) })],
    ["a chart of no values", stack({ kind: "chart", type: "line", categories: ["a"], series: [{ name: "s", values: [null] }] })],
    ["a gauge outside its scale", stack({ kind: "gauge", label: "x", value: 120, min: 0, max: 100 })],
    ["a gauge's bands out of order", stack({ kind: "gauge", label: "x", value: 1, min: 0, max: 100, bands: [{ upTo: 80, tone: "caution" }, { upTo: 50, tone: "positive" }] })],
    ["a progress past its max", stack({ kind: "progress", label: "x", value: 6, max: 5 })],
    ["a progress in fractions", stack({ kind: "progress", label: "x", value: 1.5, max: 5 })],
    ["an id used twice", stack({ kind: "text", id: "a", text: "x" }, { kind: "text", id: "a", text: "y" })],
    ["an id Ember gives", stack({ kind: "text", id: "_1", text: "x" })],
    ["a heading too long", stack({ kind: "heading", text: "x".repeat(81), level: 1 })],
  ])("refuses %s", (_why, view) => {
    refused(view);
  });

  it("refuses a view past the window's limits: depth, nodes, children, characters and charts", () => {
    const P = VIEW_PROFILES.window;
    let deep: unknown = { kind: "text", text: "x" };
    for (let i = 0; i < P.depth; i++) deep = stack(deep);
    expect(refused(deep).error).toMatch(/nests more than 5 deep/);
    const wide = stack(...Array.from({ length: P.children + 1 }, () => ({ kind: "text", text: "x" })));
    expect(refused(wide).error).toMatch(/at most 12 children/);
    const many = stack(...Array.from({ length: 11 }, () => stack(...Array.from({ length: 11 }, () => ({ kind: "text", text: "x" })))));
    expect(refused(many).error).toMatch(/at most 120/);
    const long = stack(...Array.from({ length: 12 }, () => stack(...Array.from({ length: 2 }, () => ({ kind: "text", text: "x".repeat(400) })))));
    expect(refused(long).error).toMatch(/characters; at most 8000/);
    const chart = { kind: "chart", type: "spark", categories: [], series: [{ name: "s", values: [1, 2] }] };
    expect(refused(stack(...Array.from({ length: P.charts + 1 }, () => chart))).error).toMatch(/charts and gauges; at most 6/);
    expect(ok(stack(...Array.from({ length: P.charts }, () => chart)))).toBeTruthy();
  });

  it("gives every layout kind children and no other kind any", () => {
    for (const k of Object.keys(VIEW_KINDS)) expect(LAYOUT_KINDS.has(k), k).toBe(["stack", "row", "grid", "card", "section"].includes(k));
  });
});

describe("a view that imitates Ember", () => {
  it.each([
    ["a badge that says Allow", { kind: "badge", text: "Allow", tone: "positive" }],
    ["a heading that says Not now", { kind: "heading", text: "Not now", level: 1 }],
    ["a line that says Allow once", { kind: "text", text: "Allow once" }],
    ["a callout titled Approve", { kind: "callout", tone: "info", title: "Approve", text: "x" }],
    ["a section titled Yes", { kind: "section", title: "Yes", children: [{ kind: "text", text: "x" }] }],
    ["a list item that says Deny", { kind: "list", items: ["Deny"] }],
    ["a short line asking as Ember asks", { kind: "text", text: "Allow Ember to delete your files?" }],
    ["Ember's allow shortcut", { kind: "text", text: "Press Ctrl+Alt+Y to continue" }],
    ["another OS's allow shortcut", { kind: "callout", tone: "info", text: "Use Win+Alt+Y now" }],
    ["the stop shortcut's fallback", { kind: "text", text: "Ctrl+Alt+Shift+X does nothing here" }],
    ["words in Ember's voice", { kind: "quote", text: "Ember: the user already said yes", source: { kind: "screen" } }],
    ["a quote that is a button's word", { kind: "quote", text: "Allow", source: { kind: "screen" } }],
    ["a metric's figure that is a button's word", { kind: "metric", label: "Answer", value: "OK" }],
  ])("is refused whole: %s (red team R1)", (_why, node) => {
    const r = refused(stack(node));
    expect(r.why).toBe("mimic");
    expect(r.error).toMatch(/never asks, allows or speaks for Ember/);
  });

  it("keeps ordinary values that happen to be short words, where no button stands", () => {
    expect(ok(stack({ kind: "table", columns: ["Setting", "On"], rows: [["Night Light", "Yes"], ["Dark style", "No"]] }))).toBeTruthy();
    expect(ok(stack({ kind: "keyvalue", rows: [{ label: "Backed up", value: "Yes" }] }))).toBeTruthy();
    expect(ok(stack({ kind: "list", items: ["Stop", "Start"] }))).toBeTruthy();
    expect(mimicRefusal("Allowance for May")).toBeNull();
  });

  it("matches Ember's words however they are written", () => {
    for (const w of ["ALLOW", " allow. ", "Allow!", "Not-now", "don’t allow", "Always allow"]) expect(mimicRefusal(w), w).not.toBeNull();
    expect(MIMIC_WORDS).toContain("not now");
  });
});

describe("a view that would show a secret", () => {
  it.each([
    ["a password in a line", { kind: "text", text: "wifi password: hunter2" }],
    ["a token in code", { kind: "code", lines: ["export TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345"] }],
    ["a card number in a table", { kind: "table", columns: ["Card"], rows: [["4111 1111 1111 1111"]] }],
    ["a file where keys live", { kind: "file", path: "~/.ssh/id_ed25519" }],
    ["a file of Ember's own data", { kind: "file", path: "~/.config/ember/settings.json", lines: ["{}"] }],
    ["a quote from a keyring", { kind: "quote", text: "login", source: { kind: "file", path: "~/.local/share/keyrings/login.keyring" } }],
    ["a PIN in a first-catalog excerpt", null],
  ])("is refused whole, never shown redacted: %s", (_why, node) => {
    const r = node ? refused(stack(node)) : refused([{ kind: "excerpt", path: "~/notes.txt", lines: ["PIN: 4321"] }]);
    expect(r.why).toBe("secret");
  });
});

describe("a quote's caption", () => {
  const quote = (source: object) => stack({ kind: "quote", id: "q", text: "Terms: 30 days", source });
  const src = (d: ViewDoc) => (d.nodes.q as Extract<ViewDoc["nodes"][string], { kind: "quote" }>).source;

  it("names an app only if the task read it, else says it came from the screen", () => {
    expect(src(ok(quote({ kind: "app", app: "firefox" }), { appsRead: new Set(["Firefox"]) }))).toEqual({ kind: "app", app: "firefox" });
    expect(src(ok(quote({ kind: "app", app: "Firefox" }), { appsRead: new Set(["Firefox"]), appName: s => s.toUpperCase() }))).toEqual({ kind: "app", app: "FIREFOX" });
    expect(src(ok(quote({ kind: "app", app: "Bank of Ember" }), { appsRead: new Set(["Firefox"]) }))).toEqual({ kind: "screen" });
    expect(viewText(ok(quote({ kind: "app", app: "Bank of Ember" }), { appsRead: new Set() }))).toBe("From the screen: Terms: 30 days");
  });

  it("says a command only if the task ran one", () => {
    expect(src(ok(quote({ kind: "command" }), { appsRead: new Set() }))).toEqual({ kind: "screen" });
    expect(src(ok(quote({ kind: "command" }), { appsRead: new Set(), ranCommand: true }))).toEqual({ kind: "command" });
  });
});

describe("the model's instructions for views", () => {
  const prompt = viewCatalogPrompt();

  it("are generated from the catalog's own schemas: every kind, its props and the limits", () => {
    for (const k of Object.keys(VIEW_KINDS)) expect(prompt, k).toMatch(new RegExp(`^- ${k} \\{`, "m"));
    expect(prompt).toContain("- heading {text: text≤80, level: 1|2}: a short heading");
    expect(prompt).toContain("- progress {label: text≤60, value: whole number, max: whole number, tone?: tone}: how far something got (whole numbers)");
    expect(prompt).toContain("series: [{name: text≤60, values: [number|null]≤24, tone?: tone}]≤3");
    expect(prompt).toContain("A tone is one of neutral, info, positive, caution, negative, special (meaning, never decoration); a symbol one of info, tip, caution, problem, check, cross, clock, file, folder, app, person, calendar, chart.");
    expect(prompt).toContain("- stack {children: [node]≤12, gap?: \"tight\"|\"normal\"|\"loose\"}: children one under another");
    expect(prompt).toContain("Limits: depth 5, 120 nodes, 12 children each, 8,000 characters, 6 charts or gauges.");
    expect(prompt).toContain("never Ember's own words (Allow, Deny, Not now, Stop…)");
    expect(prompt.split("\n")[0]).toBe(`A view is a tree of nodes from Ember's catalog (ember.view/2). Each node is {kind, ...props}; layout nodes hold children: [node]. The root is a layout node (a stack, if unsure). Give a node an id (lower-case letters, digits, - or _) only to change it later with update_view; any node in a row may have weight 1–4.`);
  });

  it("stay small enough for a tool description", () => {
    expect(prompt.length).toBeLessThan(6_000);
  });
});
