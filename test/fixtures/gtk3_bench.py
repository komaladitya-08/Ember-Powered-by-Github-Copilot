#!/usr/libexec/platform-python
# -*- coding: utf-8 -*-
"""A small GTK3 window with the controls Ember's tests need: buttons, a switch,
a check box, text entries (one a password), a combo box, a multi-line text view
and a hidden button. Python 3.6 compatible (RHEL 8). Prints JSON events on stdout
when controls change, so tests can check what Ember did."""

import json
import os
import sys

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib  # noqa: E402


LOG = os.environ.get("EMBER_BENCH_LOG")


def emit(kind, **data):
    data["event"] = kind
    line = json.dumps(data) + "\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    if LOG:
        with open(LOG, "a") as f:
            f.write(line)


class Bench(Gtk.Window):
    def __init__(self):
        Gtk.Window.__init__(self, title="Ember Test Bench")
        self.set_default_size(520, 500)
        self.move(140, 120)
        grid = Gtk.Grid(column_spacing=12, row_spacing=10, margin=16)
        self.add(grid)

        save = Gtk.Button(label="Save")
        save.connect("clicked", lambda b: emit("clicked", name="Save"))
        grid.attach(save, 0, 0, 1, 1)

        hidden = Gtk.Button(label="Secret hidden button")
        hidden.set_no_show_all(True)
        grid.attach(hidden, 1, 0, 1, 1)

        grid.attach(Gtk.Label(label="Night Light"), 0, 1, 1, 1)
        night = Gtk.Switch()
        night.connect("notify::active", lambda s, p: emit("toggled", name="Night Light", active=s.get_active()))
        grid.attach(night, 1, 1, 1, 1)

        remember = Gtk.CheckButton(label="Remember me")
        remember.connect("toggled", lambda c: emit("toggled", name="Remember me", active=c.get_active()))
        grid.attach(remember, 0, 2, 2, 1)

        grid.attach(Gtk.Label(label="Name"), 0, 3, 1, 1)
        name = Gtk.Entry()
        name.get_accessible().set_name("Name")
        name.connect("changed", lambda e: emit("text", name="Name", value=e.get_text()))
        grid.attach(name, 1, 3, 1, 1)

        grid.attach(Gtk.Label(label="Password"), 0, 4, 1, 1)
        pw = Gtk.Entry(visibility=False)
        pw.get_accessible().set_name("Password")
        grid.attach(pw, 1, 4, 1, 1)

        combo = Gtk.ComboBoxText()
        for c in ("Light", "Dark", "Auto"):
            combo.append_text(c)
        combo.set_active(0)
        combo.get_accessible().set_name("Theme")
        combo.connect("changed", lambda c: emit("selected", name="Theme", value=c.get_active_text()))
        grid.attach(combo, 0, 5, 2, 1)

        view = Gtk.TextView()
        view.get_accessible().set_name("Notes")
        view.get_buffer().set_text("Meeting notes\n- ship M3")
        view.get_buffer().connect("changed", lambda b: emit("text", name="Notes", value=b.get_text(b.get_start_iter(), b.get_end_iter(), False)))
        view.set_size_request(400, 80)
        grid.attach(view, 0, 6, 2, 1)

        # An area with no accessible actions: only a real pointer click reaches it (tier 3).
        pad = Gtk.EventBox()
        pad.set_size_request(400, 60)
        pad.add(Gtk.Label(label="Sketch pad (click me)"))
        pad.get_accessible().set_name("Sketch pad")
        pad.connect("button-press-event", lambda w, e: emit("pad-click", name="Sketch pad", x=int(e.x), y=int(e.y), button=e.button) or True)
        grid.attach(pad, 0, 7, 2, 1)
        self.connect("key-press-event", self.on_key)

        self.connect("destroy", Gtk.main_quit)
        GLib.idle_add(lambda: emit("ready") and False)


    def on_key(self, widget, event):
        ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        emit("key", name=Gdk.keyval_name(event.keyval), ctrl=ctrl)
        return False


if __name__ == "__main__":
    Bench().show_all()
    Gtk.main()
