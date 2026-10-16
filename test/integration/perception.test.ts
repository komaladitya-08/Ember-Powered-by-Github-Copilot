/**
 * Reads the GTK3 test bench through the real AT-SPI sidecar. Needs an X11
 * display with an accessibility bus, and a Python with pyatspi; skipped
 * otherwise (set EMBER_ATSPI_TEST=1 to require it). Run on the demo desktop:
 *   DISPLAY=:55 scripts/demo/as-demo-user.sh env EMBER_ATSPI_TEST=1 EMBER_PYTHON=/usr/bin/python3.12 npm run test:integration -- perception
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AtspiSidecar, pickPython } from "../../app/main/perception/sidecar";
import { Perception } from "../../app/main/perception";
import { inferLabels, serializeElements } from "../../app/main/perception/elements";
import { openX11 } from "../../app/main/x11";
import type { Logger } from "../../app/main/logger";

const python = pickPython();
const available = !!process.env.DISPLAY && spawnSync(python, ["-c", "import pyatspi, gi"], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe.skipIf(!available && !required)("AT-SPI sidecar on a real GTK window", () => {
  let bench: ChildProcess;
  let sidecar: AtspiSidecar;
  const events: Record<string, unknown>[] = [];

  beforeAll(async () => {
    bench = spawn(python, [path.resolve("test/fixtures/gtk3_bench.py")], { stdio: ["ignore", "pipe", "inherit"] });
    readline.createInterface({ input: bench.stdout! }).on("line", l => { try { events.push(JSON.parse(l)); } catch { /* not json */ } });
    sidecar = new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python);
    // Wait for the window to show up on the accessibility bus.
    for (let i = 0; i < 50; i++) {
      const r = await sidecar.readWindow({ title: "Ember Test Bench" }).catch(() => null);
      if (r?.window && r.nodes.length > 5) return;
      await new Promise(res => setTimeout(res, 200));
    }
    throw new Error("the test bench never appeared on the accessibility bus");
  }, 20_000);

  afterAll(() => {
    sidecar?.stop();
    bench?.kill();
  });

  it("answers status", async () => {
    const s = await sidecar.status();
    expect(s.apps).toBeGreaterThan(0);
  });

  it("reads the window's controls in under 300 ms", async () => {
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    expect(r.window?.name).toBe("Ember Test Bench");
    expect(r.ms).toBeLessThan(300);
    const roles = r.nodes.map(n => `${n.role}:${n.name}`);
    expect(roles).toContain("push button:Save");
    // The hidden button is not on screen, so it is not reported.
    expect(r.nodes.some(n => n.name === "Secret hidden button")).toBe(false);
  });

  it("gives the unnamed switch its label and never reads the password", async () => {
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    const labels = inferLabels(r.nodes);
    const sw = r.nodes.find(n => labels.get(n.id) === "Night Light");
    expect(sw, serializeElements(r.window!, r.nodes)).toBeDefined();
    const pw = r.nodes.find(n => n.role === "password text");
    expect(pw).toBeDefined();
    expect(pw!.text).toBeUndefined();
  });

  it("says which option the combo box shows (review round 7)", async () => {
    const r = await sidecar.readWindow({ title: "Ember Test Bench" });
    expect(r.nodes.find(n => n.role === "combo box" && n.name === "Theme")?.selected).toBe("Light");
  });

  it("judges a combo box named after what it shows by its label: a card's expiry, a PIN typed in its entry (PERC8-5)", async () => {
    // GTK names a combo box after the option it shows (or what is typed in its entry).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-combos-"));
    const script = path.join(dir, "combos.py");
    fs.writeFileSync(script, `
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="Ember Combo Bench")
grid = Gtk.Grid(column_spacing=8, row_spacing=6, margin=12)
def row(i, label, combo, items, active):
    grid.attach(Gtk.Label(label=label), 0, i, 1, 1)
    for x in items:
        combo.append_text(x)
    combo.set_active(active)
    grid.attach(combo, 1, i, 1, 1)
row(0, "Country", Gtk.ComboBoxText(), ["Germany", "France"], 1)
row(1, "Card expiry", Gtk.ComboBoxText(), ["01/27", "09/28"], 1)
row(2, "PIN", Gtk.ComboBoxText.new_with_entry(), ["1234", "4821"], 1)
row(3, "Security question", Gtk.ComboBoxText(), ["First pet", "Maiden name: Smith"], 1)
w.add(grid)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
`);
    const app = spawn(python, [script], { stdio: "ignore" });
    try {
      let r = await sidecar.readWindow({ pid: app.pid! });
      for (let i = 0; i < 50 && r.nodes.filter(n => n.role === "combo box").length < 4; i++) {
        await new Promise(res => setTimeout(res, 200));
        r = await sidecar.readWindow({ pid: app.pid! });
      }
      const combos = r.nodes.filter(n => n.role === "combo box");
      expect(combos.map(n => [n.name, n.selected, !!n.secret]).sort()).toEqual([["", undefined, true], ["", undefined, true], ["", undefined, true], ["France", "France", false]]);
      expect(JSON.stringify(r)).not.toMatch(/09\/28|4821|Smith/);
      const perception = new Perception({ sidecar, x11: null, log: quiet, neverLook: () => [], screenBounds: () => ({ x: 0, y: 0, width: 4000, height: 4000 }) });
      const text = (await perception.perceive({ image: false, scope: "window", target: { pid: app.pid! } })).text;
      expect(text).toMatch(/combo box "Card expiry" \(label\) \([^)]*secret\)/);
      expect(text).not.toMatch(/09\/28|4821|Smith/);
      for (const n of combos) expect(JSON.stringify(await sidecar.readElement(n.id))).not.toMatch(/09\/28|4821|Smith/);
    } finally {
      app.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("a click on a row of a file list selects that row alone, never opens it; rows and list rows are chosen by their words (PR8-1, PR8-6)", async () => {
    // GTK's tree view, as in a file dialog: an icon and the name in one column; its cells' "activate" is a double click.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-rows-"));
    const script = path.join(dir, "rows.py");
    fs.writeFileSync(script, `
import json, sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
def emit(**d):
    sys.stdout.write(json.dumps(d) + "\\n"); sys.stdout.flush()
w = Gtk.Window(title="Ember Rows Bench")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
store = Gtk.ListStore(str, str, str)
for n in ["agenda.txt", "budget.csv", "report.pdf"]:
    store.append(["text-x-generic", n, "%d bytes" % len(n)])
tv = Gtk.TreeView(model=store)
col = Gtk.TreeViewColumn("Name")
icon, text = Gtk.CellRendererPixbuf(), Gtk.CellRendererText()
col.pack_start(icon, False); col.pack_start(text, True)
col.add_attribute(icon, "icon-name", 0); col.add_attribute(text, "text", 1)
tv.append_column(col)
tv.append_column(Gtk.TreeViewColumn("Size", Gtk.CellRendererText(), text=2))
sel = tv.get_selection(); sel.set_mode(Gtk.SelectionMode.MULTIPLE); sel.select_path(Gtk.TreePath(0))
sel.connect("changed", lambda s: emit(selected=[store[p][1] for p in s.get_selected_rows()[1]]))
tv.connect("row-activated", lambda t, p, c: emit(activated=store[p][1]))
box.add(tv)
lb = Gtk.ListBox()
for t in ("English", "Deutsch"):
    r = Gtk.ListBoxRow(); r.add(Gtk.Label(label=t)); lb.add(r)
lb.connect("row-selected", lambda b, r: emit(lang=r.get_child().get_text() if r else None))
box.add(lb)
w.add(box)
w.connect("destroy", Gtk.main_quit)
# Rows are chosen only in the active window: with no window manager (CI's bare X server) it takes the focus itself.
w.connect("map-event", lambda *a: w.present())
w.show_all()
Gtk.main()
`);
    const app = spawn(python, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const said: Record<string, unknown>[] = [];
    readline.createInterface({ input: app.stdout! }).on("line", l => { try { said.push(JSON.parse(l)); } catch { /* not json */ } });
    try {
      let r = await sidecar.readWindow({ pid: app.pid! }).catch(() => null);
      for (let i = 0; i < 50 && !r?.nodes.some(n => n.name === "report.pdf"); i++) {
        await new Promise(res => setTimeout(res, 200));
        r = await sidecar.readWindow({ pid: app.pid! }).catch(() => null);
      }
      const nodes = r!.nodes;
      const report = nodes.find(n => n.role === "table cell" && n.name === "report.pdf")!;
      expect((await sidecar.canDo(report.id, "click")).action).toBe("select row");
      const res = await sidecar.doAction(report.id, "click");
      expect(res.ok).toBe(true);
      expect(res.after?.states).toContain("selected");
      await new Promise(res => setTimeout(res, 200));
      expect(said.filter(s => "activated" in s)).toEqual([]);
      expect(said.filter(s => "selected" in s).pop()).toEqual({ selected: ["report.pdf"] });
      const table = nodes.find(n => n.role === "table")!;
      expect((await sidecar.listOptions(table.id)).options).toEqual(["agenda.txt", "budget.csv", "report.pdf"]);
      expect((await sidecar.selectOption(table.id, "budget.csv")).after?.selected).toBe("budget.csv");
      const list = nodes.find(n => n.role === "list box")!;
      expect((await sidecar.listOptions(list.id)).options).toEqual(["English", "Deutsch"]);
      expect((await sidecar.selectOption(list.id, "Deutsch")).ok).toBe(true);
      await new Promise(res => setTimeout(res, 200));
      expect(said.filter(s => "selected" in s).pop()).toEqual({ selected: ["budget.csv"] });
      expect(said.filter(s => "lang" in s).pop()).toEqual({ lang: "Deutsch" });
      expect(said.filter(s => "activated" in s)).toEqual([]);
    } finally {
      app.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("finds the same window through X11 by pid", async () => {
    const x11 = openX11();
    if (!x11) return;
    try {
      const r = await sidecar.readWindow({ pid: bench.pid! });
      expect(r.window?.pid).toBe(bench.pid);
    } finally {
      x11.close();
    }
  });
});
