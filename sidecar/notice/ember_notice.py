#!/usr/bin/env python3
"""Ember's notice on a remote computer's screen (design 5.3.9).

While Ember, reached over SSH from someone's PC, uses this screen, a small window titled "Ember" stays on top of every
workspace at the top centre of the screen: "Ember on <PC> is using this screen." with a Stop button. Its title makes it
one of Ember's own windows, which Ember never acts in. On a Wayland session without Xwayland a window can't stay on top,
so the notice is a resident desktop notification with a Stop action instead (--notification). Before the first read on
a computer whose administrator requires it, the same notice asks first: "Ember on <PC> wants to use this screen." with
Allow and Don't allow.

The agent's desktop child starts it and talks to it in JSON lines:
  stdin:  {"cmd": "show", "text": ...}  {"cmd": "ask", "text": ...}  {"cmd": "paused", "text": ...}  {"cmd": "quit"}
  stdout: {"ev": "shown", "form": "window"|"notification"}  {"ev": "failed", "why": ...}  {"ev": "stop"}
          {"ev": "answer", "allow": true|false}
It exits when its stdin ends (the agent stopped or went away). If it can't show itself at all, it says "failed" and
exits: the agent then uses no desktop on this computer.

Runs on the remote's own Python (RHEL 8's platform-python 3.6 and newer) with PyGObject and GTK 3; nothing else.
"""

import json
import os
import sys

TITLE = "Ember"
MAX_TEXT = 200


def emit(obj):
    """Writes one event line to the agent."""
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except (IOError, OSError, ValueError):
        pass  # the agent is gone: stdin's end stops us next


def parse_command(line):
    """One command line as a dict with a known "cmd" and a plain "text", or None for anything else."""
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    if not isinstance(msg, dict) or msg.get("cmd") not in ("show", "ask", "paused", "quit"):
        return None
    text = msg.get("text", "")
    if not isinstance(text, str):
        return None
    # One plain line: no control characters, bounded.
    text = "".join(c for c in text if c >= " " and c != "\x7f")[:MAX_TEXT]
    return {"cmd": msg["cmd"], "text": text}


class Lines(object):
    """Splits what arrives on a file descriptor into lines (a GLib watch reads whatever is there)."""

    def __init__(self):
        self.buf = b""

    def feed(self, data):
        self.buf += data
        out = []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            out.append(line.decode("utf-8", "replace"))
        if len(self.buf) > 65536:
            self.buf = b""
        return out


class WindowNotice(object):
    """The always-on-top window."""

    def __init__(self, Gtk, Gdk, GLib, quit_cb):
        self.Gtk, self.Gdk, self.GLib = Gtk, Gdk, GLib
        self.quit_cb = quit_cb
        self.answered = True
        win = Gtk.Window(title=TITLE)
        win.set_keep_above(True)
        win.stick()
        win.set_decorated(True)
        win.set_deletable(False)
        win.set_resizable(False)
        win.set_skip_taskbar_hint(True)
        win.set_skip_pager_hint(True)
        # It never takes the keyboard from the app the person is typing in.
        win.set_accept_focus(False)
        win.set_focus_on_map(False)
        win.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        win.connect("delete-event", lambda *a: True)
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        box.set_border_width(10)
        self.label = Gtk.Label(label="")
        self.label.set_line_wrap(True)
        self.buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.pack_start(self.label, True, True, 0)
        box.pack_end(self.buttons, False, False, 0)
        win.add(box)
        self.win = win

    def _buttons(self, specs):
        for child in self.buttons.get_children():
            self.buttons.remove(child)
        for label, cb in specs:
            b = self.Gtk.Button(label=label)
            b.set_can_focus(False)
            b.connect("clicked", cb)
            self.buttons.pack_start(b, False, False, 0)

    def _place(self):
        self.win.show_all()
        left, width = 0, 0
        display = self.win.get_display()
        monitor = None
        if display is not None and hasattr(display, "get_primary_monitor"):
            monitor = display.get_primary_monitor() or (display.get_monitor(0) if display.get_n_monitors() else None)
        if monitor is not None:
            geometry = monitor.get_geometry()
            left, width = geometry.x, geometry.width
        w, _h = self.win.get_size()
        self.win.move(left + max(0, (width - w) // 2), 0)
        self.win.set_keep_above(True)

    def show(self, text):
        self.label.set_text(text)
        self._buttons([("Stop", lambda *_: emit({"ev": "stop"}))])
        self._place()
        emit({"ev": "shown", "form": "window"})

    def paused(self, text):
        self.label.set_text(text)
        self._buttons([])
        self._place()

    def ask(self, text):
        self.label.set_text(text)
        self.answered = False

        def answer(allow):
            if self.answered:
                return
            self.answered = True
            self._buttons([])
            emit({"ev": "answer", "allow": allow})

        self._buttons([("Allow", lambda *_: answer(True)), ("Don't allow", lambda *_: answer(False))])
        self._place()
        emit({"ev": "shown", "form": "window"})


class NotificationNotice(object):
    """A resident desktop notification (org.freedesktop.Notifications) with a Stop action."""

    def __init__(self, Gio, GLib):
        self.Gio, self.GLib = Gio, GLib
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        caps = self._call("GetCapabilities", None)
        if caps is None or "actions" not in caps.unpack()[0]:
            raise RuntimeError("the notification service shows no buttons")
        self.id = 0
        self.mode = None
        self.replacing = False
        self.bus.signal_subscribe("org.freedesktop.Notifications", "org.freedesktop.Notifications", "ActionInvoked",
                                  "/org/freedesktop/Notifications", None, Gio.DBusSignalFlags.NONE, self._action)
        self.bus.signal_subscribe("org.freedesktop.Notifications", "org.freedesktop.Notifications", "NotificationClosed",
                                  "/org/freedesktop/Notifications", None, Gio.DBusSignalFlags.NONE, self._closed)

    def _call(self, method, params):
        try:
            return self.bus.call_sync("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                                      "org.freedesktop.Notifications", method, params, None,
                                      self.Gio.DBusCallFlags.NONE, 5000, None)
        except Exception:  # noqa: BLE001 -- any D-Bus failure means it can't be shown
            return None

    def _notify(self, text, actions):
        GLib = self.GLib
        hints = {"resident": GLib.Variant("b", True), "urgency": GLib.Variant("y", 2)}
        params = GLib.Variant("(susssasa{sv}i)", (TITLE, self.id, "", TITLE, text, actions, hints, 0))
        self.replacing = self.id != 0
        res = self._call("Notify", params)
        self.replacing = False
        if res is None:
            emit({"ev": "failed", "why": "notification"})
            return False
        self.id = res.unpack()[0]
        return True

    def _action(self, _conn, _sender, _path, _iface, _signal, params):
        nid, key = params.unpack()
        if nid != self.id:
            return
        if key == "stop":
            emit({"ev": "stop"})
        elif key in ("allow", "deny") and self.mode == "ask":
            self.mode = None
            emit({"ev": "answer", "allow": key == "allow"})

    def _closed(self, _conn, _sender, _path, _iface, _signal, params):
        nid, _reason = params.unpack()
        if nid == self.id and not self.replacing:
            # Dismissed: nobody can see Ember is there any more.
            if self.mode == "ask":
                emit({"ev": "answer", "allow": False})
            emit({"ev": "failed", "why": "closed"})

    def show(self, text):
        self.mode = "show"
        if self._notify(text, ["stop", "Stop"]):
            emit({"ev": "shown", "form": "notification"})

    def paused(self, text):
        self.mode = "paused"
        self._notify(text, [])

    def ask(self, text):
        self.mode = "ask"
        if self._notify(text, ["allow", "Allow", "deny", "Don't allow"]):
            emit({"ev": "shown", "form": "notification"})


def main(argv):
    notification = "--notification" in argv
    try:
        import gi
        if not notification:
            gi.require_version("Gtk", "3.0")
            gi.require_version("Gdk", "3.0")
        from gi.repository import Gio, GLib
    except Exception:  # noqa: BLE001 -- no PyGObject: no notice can be shown
        emit({"ev": "failed", "why": "no-gi"})
        return 1
    GLib.set_prgname("ember-remote-notice")
    loop = GLib.MainLoop()
    try:
        if notification:
            notice = NotificationNotice(Gio, GLib)
        else:
            from gi.repository import Gdk, Gtk
            ok = Gtk.init_check(argv)
            ok = ok[0] if isinstance(ok, tuple) else ok
            if not ok:
                emit({"ev": "failed", "why": "no-display"})
                return 1
            notice = WindowNotice(Gtk, Gdk, GLib, loop.quit)
    except Exception:  # noqa: BLE001 -- whatever stops it from showing, it says so and goes
        emit({"ev": "failed", "why": "notice"})
        return 1

    lines = Lines()
    fd = sys.stdin.fileno()

    def on_input(_source, condition):
        data = b""
        if condition & GLib.IO_IN:
            try:
                data = os.read(fd, 4096)
            except OSError:
                data = b""
        if not data:
            loop.quit()
            return False
        for line in lines.feed(data):
            cmd = parse_command(line)
            if cmd is None:
                continue
            if cmd["cmd"] == "quit":
                loop.quit()
                return False
            getattr(notice, cmd["cmd"])(cmd["text"])
        return True

    channel = GLib.IOChannel.unix_new(fd)
    GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_input)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
