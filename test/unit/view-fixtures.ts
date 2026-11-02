/**
 * Views for the view tests (view-schema, view-dom and the render checks): composed as a model would, from the catalog's
 * second version (app/shared/view.ts).
 */

/** One node of every kind, composed as a model would. */
export const EVERY_KIND = {
  kind: "stack", id: "top", children: [
    { kind: "heading", text: "Overdue invoices", level: 1 },
    { kind: "row", justify: "between", children: [{ kind: "badge", text: "3 overdue", tone: "caution", symbol: "clock" }, { kind: "badge", text: "Paid 9", tone: "positive" }] },
    { kind: "grid", columns: 3, children: [
      { kind: "metric", id: "total", label: "Total due", value: "£4,210", delta: { text: "12 %", direction: "up", good: false }, spark: [3, 4, 4, 6, 5, 7] },
      { kind: "metric", label: "Clients", value: "3" },
      { kind: "metric", label: "Oldest", value: "21 days", delta: { text: "2 days", direction: "flat" } },
    ] },
    { kind: "chart", type: "bar", title: "Due by client", categories: ["Acme", "Globex", "Initech"], series: [{ name: "Due", values: [2100, 1610, 500] }], unit: "£" },
    { kind: "gauge", label: "Paid this month", value: 72, min: 0, max: 100, unit: "%", bands: [{ upTo: 50, tone: "negative" }, { upTo: 80, tone: "caution" }, { upTo: 100, tone: "positive" }] },
    { kind: "section", title: "Details", children: [
      { kind: "table", columns: ["Client", "Days", "Due"], rows: [["Acme", "21", "£2,100"], ["Globex", "12", "£1,610"]], numeric: [1, 2], caption: "Overdue" },
      { kind: "keyvalue", rows: [{ label: "Sheet", value: "Invoices 2026" }, { label: "Checked", value: "48 rows", tone: "positive" }] },
      { kind: "compare", columns: ["Last month", "This month"], rows: [{ label: "Overdue", a: "5", b: "3", better: "b" }] },
    ] },
    { kind: "card", tone: "info", children: [
      { kind: "text", text: "Acme has been overdue twice this year." },
      { kind: "rich", runs: [{ text: "Saved as " }, { text: "overdue.csv", style: "code" }, { text: " in " }, { text: "Documents", style: "strong" }] },
    ] },
    { kind: "callout", tone: "caution", title: "Worth checking", text: "Globex's last payment has no reference." },
    { kind: "stack", gap: "tight", children: [
    { kind: "quote", text: "Payment terms: 30 days from invoice.", source: { kind: "app", app: "Firefox" } },
    { kind: "list", items: ["Acme", "Globex", "Initech"], ordered: true },
    { kind: "steps", id: "plan", items: [{ text: "Open the sheet", state: "done" }, { text: "Find overdue rows", state: "now" }, { text: "Save a copy", state: "todo" }] },
    { kind: "timeline", items: [{ when: "09:14", text: "Sheet opened" }, { when: "09:15", text: "3 overdue found", tone: "caution" }] },
    { kind: "progress", id: "rows", label: "Rows checked", value: 48, max: 120 },
    { kind: "divider" },
    { kind: "code", lines: ["client,days,due", "Acme,21,2100"], lang: "text", caption: "overdue.csv" },
    { kind: "file", path: "~/Documents/overdue.csv", label: "Saved", lines: ["client,days,due"] },
    ] },
  ],
};
