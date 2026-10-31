#!/usr/bin/env python3
"""A desktop notification service for the Wayland suite (org.freedesktop.Notifications on the session bus).

A headless compositor has no notification service, and the agent's notice falls back to a resident notification on
Wayland without Xwayland (design 5.3.9). This one shows nothing: it reports each call on stdout as a JSON line
({"event": "notify" | "close" | "ready", ...}) and, for each JSON line on stdin ({"invoke": id, "key": "stop"} or
{"dismiss": id}), sends ActionInvoked or NotificationClosed as a person pressing the button or the close box would.
Test-only.
"""

import json
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/>
    </method>
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" direction="in"/></method>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
  </interface>
</node>
"""
PATH = "/org/freedesktop/Notifications"
IFACE = "org.freedesktop.Notifications"


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Service(object):
    def __init__(self, conn):
        self.conn = conn
        self.next_id = 1
        self.shown = set()

    def signal(self, name, params):
        self.conn.emit_signal(None, PATH, IFACE, name, params)

    def call(self, _conn, _sender, _path, _iface, method, params, invocation):
        if method == "GetCapabilities":
            invocation.return_value(GLib.Variant("(as)", (["actions", "body", "persistence"],)))
        elif method == "GetServerInformation":
            invocation.return_value(GLib.Variant("(ssss)", ("fake", "Ember tests", "1", "1.2")))
        elif method == "Notify":
            app, replaces, _icon, summary, body, actions, hints, timeout = params.unpack()
            nid = replaces if replaces in self.shown else self.next_id
            if nid == self.next_id:
                self.next_id += 1
            self.shown.add(nid)
            say({"event": "notify", "id": nid, "app": app, "replaces": replaces, "summary": summary, "body": body,
                 "actions": actions, "resident": bool(hints.get("resident", False)), "timeout": timeout})
            invocation.return_value(GLib.Variant("(u)", (nid,)))
        elif method == "CloseNotification":
            (nid,) = params.unpack()
            say({"event": "close", "id": nid})
            if nid in self.shown:
                self.shown.discard(nid)
                self.signal("NotificationClosed", GLib.Variant("(uu)", (nid, 3)))
            invocation.return_value(None)

    def command(self, line):
        try:
            cmd = json.loads(line)
        except ValueError:
            return
        if "invoke" in cmd:
            self.signal("ActionInvoked", GLib.Variant("(us)", (int(cmd["invoke"]), str(cmd["key"]))))
        elif "dismiss" in cmd:
            nid = int(cmd["dismiss"])
            self.shown.discard(nid)
            self.signal("NotificationClosed", GLib.Variant("(uu)", (nid, 2)))


def main():
    loop = GLib.MainLoop()
    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    service = Service(conn)
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    conn.register_object(PATH, node.interfaces[0], service.call, None, None)

    def acquired(_conn, _name):
        say({"event": "ready"})

    def lost(_conn, _name):
        say({"event": "lost"})
        loop.quit()

    Gio.bus_own_name_on_connection(conn, IFACE, Gio.BusNameOwnerFlags.NONE, acquired, lost)

    def on_stdin(source, _cond):
        line = source.readline()
        if not line:
            loop.quit()
            return False
        service.command(line)
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, lambda ch, cond: on_stdin(sys.stdin, cond))
    loop.run()


if __name__ == "__main__":
    main()
