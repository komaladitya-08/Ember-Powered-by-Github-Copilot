/**
 * A click whose handler runs a modal dialog with gtk_dialog_run (an "Attach…" button, Mousepad's File ▸ Save As…) runs
 * that dialog inside the app's handling of the click. Ember's own connection to the app must not be the one the click
 * came on: then the dialog couldn't be read, and the first key the user types in it would hang the app for good
 * (PR10-1). Needs an X11 display with a window manager and an accessibility bus, a Python with pyatspi and GTK 3, and
 * libXtst (the user's keys); skipped otherwise (set EMBER_ATSPI_TEST=1 to require it).
 */

import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { AtspiSidecar, pickPython, type AxNode } from "../../app/main/perception/sidecar";
import { openXInput } from "../../app/main/hands/input";
import type { Logger } from "../../app/main/logger";

const python = pickPython();
const gtk = "import pyatspi, gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk";
const available = !!process.env.DISPLAY && spawnSync(python, ["-c", gtk], { stdio: "ignore" }).status === 0;
const required = process.env.EMBER_ATSPI_TEST === "1";
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The app ticks while its main loop runs (also inside the dialog's): a hung app stops ticking.
const APP = `
import json, sys, time, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
def emit(**d):
    sys.stdout.write(json.dumps(d) + "\\n"); sys.stdout.flush()
w = Gtk.Window(title="Ember Attach Bench")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
to = Gtk.Entry()
box.add(to)
button = Gtk.Button(label="Attach\\u2026")
box.add(button)
w.add(box)
def choose(*_):
    d = Gtk.FileChooserDialog(title="Attach a file", parent=w, action=Gtk.FileChooserAction.OPEN)
    d.add_buttons("_Cancel", Gtk.ResponseType.CANCEL, "_Attach", Gtk.ResponseType.ACCEPT)
    d.set_current_folder(sys.argv[1])
    r = d.run()
    emit(response=int(r))
    d.destroy()
    # The keyboard back to the window behind (a window manager does this; CI's bare X server has none).
    w.present()
button.connect("clicked", choose)
to.connect("changed", lambda e: emit(to=e.get_text()))
GLib.timeout_add(100, lambda: emit(tick=time.time()) or True)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
`;

describe.skipIf(!available && !required)("a click that runs a modal dialog (PR10-1)", () => {
  it("the dialog can be read, and the app takes the keys typed in it and keeps running", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-attach-"));
    fs.writeFileSync(path.join(dir, "report.txt"), "hello\n");
    const script = path.join(dir, "attach.py");
    fs.writeFileSync(script, APP);
    const app = spawn(python, [script, dir], { stdio: ["ignore", "pipe", "ignore"] });
    const events: Record<string, unknown>[] = [];
    readline.createInterface({ input: app.stdout! }).on("line", l => { try { events.push(JSON.parse(l)); } catch { /* not json */ } });
    const sidecar = new AtspiSidecar(path.resolve("sidecar/atspi/ember_atspi.py"), quiet, python);
    const x = openXInput(process.env.DISPLAY);
    const press = (name: string) => {
      const sym = x!.keysymOf(name);
      expect(x!.keysym(sym, true)).toBe(true);
      x!.keysym(sym, false);
    };
    // Ticking: the app's main loop ran in the last half second.
    const ticking = async () => {
      const before = events.filter(e => "tick" in e).length;
      await sleep(500);
      return events.filter(e => "tick" in e).length > before;
    };
    const find = (nodes: AxNode[], role: string, name: RegExp) => nodes.find(n => n.role === role && name.test(n.name));
    try {
      expect(x, "libXtst").not.toBeNull();
      let r = await sidecar.readWindow({ pid: app.pid! });
      for (let i = 0; i < 50 && !find(r.nodes, "push button", /^Attach/); i++) {
        await sleep(200);
        r = await sidecar.readWindow({ pid: app.pid! });
      }
      const attach = find(r.nodes, "push button", /^Attach/);
      expect(attach, "the Attach… button").toBeDefined();

      const res = await sidecar.doAction(attach!.id, "click");
      expect(res.ok).toBe(true);
      // The dialog is read at once, on Ember's own connection.
      let dialog = await sidecar.readWindow({ pid: app.pid!, title: "Attach a file" });
      for (let i = 0; i < 20 && dialog.window?.name !== "Attach a file"; i++) {
        await sleep(200);
        dialog = await sidecar.readWindow({ pid: app.pid!, title: "Attach a file" });
      }
      expect(dialog.window?.name).toBe("Attach a file");
      expect(dialog.busy).toBeFalsy();
      expect(find(dialog.nodes, "push button", /^Cancel$/)).toBeDefined();

      // The user types in the dialog (GTK sends each key to the accessibility bus first): it takes them, and runs on.
      await sleep(300);
      for (const k of ["a", "b", "c"]) press(k);
      await sleep(500);
      expect(await ticking(), "the app hung at the user's keys").toBe(true);
      dialog = await sidecar.readWindow({ pid: app.pid!, title: "Attach a file" });
      expect(dialog.busy).toBeFalsy();
      expect(dialog.nodes.some(n => n.text === "abc"), "the keys reached the dialog").toBe(true);

      // Ember closes it; then the user types in the window behind it.
      const cancel = find(dialog.nodes, "push button", /^Cancel$/);
      await sidecar.doAction(cancel!.id, "click");
      for (let i = 0; i < 20 && !events.some(e => "response" in e); i++) await sleep(100);
      expect(events.find(e => "response" in e)).toEqual({ response: -6 });
      press("x");
      press("y");
      await sleep(500);
      expect(await ticking(), "the app hung at the user's keys").toBe(true);
      expect(events.filter(e => "to" in e).at(-1)).toEqual({ to: "xy" });
      r = await sidecar.readWindow({ pid: app.pid! });
      expect(r.window?.name).toBe("Ember Attach Bench");
      expect(r.busy).toBeFalsy();
    } finally {
      x?.close();
      sidecar.stop();
      app.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
