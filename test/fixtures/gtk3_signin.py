#!/usr/libexec/platform-python
# -*- coding: utf-8 -*-
"""A GTK3 sign-in window for the vault's real-window leak test (test/integration/vault-leak.test.ts, vault-3): a
user name and a password field, a line that repeats the user name and a line that counts what each field holds, all
in green so a picture shows anything left of a value. GTK's fields take text by accessibility (EditableText), which a
Chromium page's never do on Linux, so the helper's own fill is tested here. Prints nothing: what is typed into it is
never written anywhere. Python 3.6 compatible (RHEL 8)."""

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk  # noqa: E402

CSS = b"""
entry, label.echo { color: #00b000; font-family: monospace; font-size: 16px; }
"""


def main():
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider,
                                             Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    win = Gtk.Window(title="Ember test: Vault sign-in")
    win.set_default_size(560, 300)
    win.move(640, 40)
    grid = Gtk.Grid(column_spacing=12, row_spacing=10, margin=16)
    win.add(grid)
    grid.attach(Gtk.Label(label="Sign in"), 0, 0, 2, 1)
    grid.attach(Gtk.Label(label="Username"), 0, 1, 1, 1)
    user = Gtk.Entry(width_chars=32)
    user.get_accessible().set_name("Username")
    grid.attach(user, 1, 1, 1, 1)
    grid.attach(Gtk.Label(label="Password"), 0, 2, 1, 1)
    password = Gtk.Entry(visibility=False, width_chars=32)
    password.get_accessible().set_name("Password")
    grid.attach(password, 1, 2, 1, 1)
    echo = Gtk.Label(label="")
    echo.get_style_context().add_class("echo")
    grid.attach(echo, 0, 3, 2, 1)
    out = Gtk.Label(label="nothing yet")
    grid.attach(out, 0, 4, 2, 1)

    def changed(_entry):
        u = user.get_text()
        echo.set_text("Hello " + u if u else "")
        out.set_text("got %d and %d characters" % (len(u), len(password.get_text())))
    user.connect("changed", changed)
    password.connect("changed", changed)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
