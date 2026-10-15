#!/usr/libexec/platform-python
# -*- coding: utf-8 -*-
"""Ember's accessibility sidecar.

Reads the AT-SPI tree of desktop applications and (from M4) performs
accessibility actions, answering newline-delimited JSON-RPC 2.0 on stdin and
stdout. Must stay compatible with RHEL 8's system Python 3.6 and pyatspi 2.26:
no walrus operator, no dataclasses, no f-string "=" specifiers.
"""

import json
import os
import sys
import time
import traceback

import pyatspi

VERSION = 1
MAX_DEPTH = 12
MAX_NODES = 400

# Roles that only group or decorate; their children are kept, they are not listed.
SKIP_ROLES = {"filler", "panel", "section", "redundant object", "glass pane", "layered pane", "root pane",
              "scroll pane", "viewport", "split pane", "internal frame", "option pane", "unknown"}
INTERESTING_STATES = ("focused", "checked", "selected", "expanded", "collapsed", "pressed", "editable",
                      "multi line", "sensitive", "enabled", "focusable", "active")


def state_names(acc):
    try:
        ss = acc.getState()
        return [pyatspi.stateToString(s) for s in ss.getStates()]
    except Exception:
        return []


def extents(acc):
    try:
        e = acc.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        return {"x": e.x, "y": e.y, "width": e.width, "height": e.height}
    except Exception:
        return None


def actions(acc):
    try:
        a = acc.queryAction()
        return [a.getName(i) for i in range(a.nActions)]
    except Exception:
        return []


def text_of(acc, limit=200):
    try:
        t = acc.queryText()
        return t.getText(0, min(t.characterCount, limit))
    except Exception:
        return None


def value_of(acc):
    try:
        return acc.queryValue().currentValue
    except Exception:
        return None


def is_editable(acc, states):
    if "editable" not in states:
        return False
    try:
        acc.queryEditableText()
        return True
    except Exception:
        return False


class Snapshot(object):
    """Accessible objects from the last read, addressable by small integer ids."""

    def __init__(self):
        self.objects = {}
        self.next_id = 1
        self.taken = 0.0

    def add(self, acc):
        nid = self.next_id
        self.next_id += 1
        self.objects[nid] = acc
        return nid


SNAPSHOT = Snapshot()


def walk(acc, depth, out, max_depth, max_nodes, parent_id):
    if len(out) >= max_nodes or depth > max_depth:
        return
    states = state_names(acc)
    if "showing" not in states or "visible" not in states:
        # Invisible elements are a known prompt-injection channel; never report them.
        return
    role = acc.getRoleName()
    name = (acc.name or "").strip()
    my_id = parent_id
    if role not in SKIP_ROLES or name:
        bounds = extents(acc)
        if bounds is None or (bounds["width"] > 0 and bounds["height"] > 0):
            node = {
                "id": SNAPSHOT.add(acc),
                "parent": parent_id,
                "depth": depth,
                "role": role,
                "name": name[:200],
                "states": [s for s in states if s in INTERESTING_STATES],
                "bounds": bounds,
            }
            acts = actions(acc)
            if acts:
                node["actions"] = acts
            if role in ("text", "entry", "password text", "terminal", "paragraph", "document text", "spin button", "combo box"):
                if role != "password text":
                    txt = text_of(acc)
                    if txt:
                        node["text"] = txt
            val = value_of(acc)
            if val is not None:
                node["value"] = val
            if is_editable(acc, states):
                node["editable"] = True
            out.append(node)
            my_id = node["id"]
    try:
        count = acc.childCount
    except Exception:
        count = 0
    for i in range(min(count, 200)):
        try:
            child = acc.getChildAtIndex(i)
        except Exception:
            continue
        if child is not None:
            walk(child, depth + 1, out, max_depth, max_nodes, my_id)


def frames():
    desktop = pyatspi.Registry.getDesktop(0)
    for app in desktop:
        if app is None:
            continue
        try:
            pid = app.get_process_id()
        except Exception:
            pid = None
        for i in range(app.childCount):
            try:
                win = app.getChildAtIndex(i)
            except Exception:
                continue
            if win is None:
                continue
            yield app, pid, win


def describe_window(app, pid, win):
    states = state_names(win)
    return {
        "app": app.name or "",
        "pid": pid,
        "name": win.name or "",
        "role": win.getRoleName(),
        "active": "active" in states,
        "bounds": extents(win),
    }


def list_windows(params):
    out = []
    for app, pid, win in frames():
        states = state_names(win)
        if "showing" in states or "active" in states:
            out.append(describe_window(app, pid, win))
    return {"windows": out}


def find_window(params):
    """The window to read. With a pid and/or title, the best match wins: same
    process, then exact title, then title substring, preferring the window
    the user has active (one app often has several windows). With neither,
    the active window."""
    pid = params.get("pid")
    title = (params.get("title") or "").lower()
    best, best_score = None, 0
    for app, apid, win in frames():
        states = state_names(win)
        name = (win.name or "").lower()
        if pid is None and not title:
            if "active" in states:
                return app, apid, win
            continue
        score = 0
        if pid is not None and apid == pid:
            score += 8
        if title and name == title:
            score += 6
        elif title and title in name:
            score += 4
        if score == 0:
            continue
        if "active" in states:
            score += 2
        if "showing" in states:
            score += 1
        if score > best_score:
            best, best_score = (app, apid, win), score
    return best


def read_window(params):
    t0 = time.time()
    found = find_window(params)
    if found is None:
        return {"window": None, "nodes": [], "ms": int((time.time() - t0) * 1000)}
    app, pid, win = found
    global SNAPSHOT
    SNAPSHOT = Snapshot()
    nodes = []
    walk(win, 0, nodes, int(params.get("maxDepth", MAX_DEPTH)), int(params.get("maxNodes", MAX_NODES)), None)
    SNAPSHOT.taken = time.time()
    return {
        "window": describe_window(app, pid, win),
        "nodes": nodes,
        "truncated": len(nodes) >= int(params.get("maxNodes", MAX_NODES)),
        "ms": int((time.time() - t0) * 1000),
    }


def status(params):
    enabled = None
    try:
        from gi.repository import Gio
        schema = Gio.SettingsSchemaSource.get_default().lookup("org.gnome.desktop.interface", True)
        if schema is not None and schema.has_key("toolkit-accessibility"):
            enabled = Gio.Settings.new("org.gnome.desktop.interface").get_boolean("toolkit-accessibility")
    except Exception:
        pass
    apps = 0
    try:
        apps = pyatspi.Registry.getDesktop(0).childCount
    except Exception:
        pass
    return {"version": VERSION, "python": sys.version.split()[0], "toolkitAccessibility": enabled, "apps": apps}


METHODS = {
    "ping": lambda p: {"version": VERSION},
    "status": status,
    "list_windows": list_windows,
    "read_window": read_window,
}


def main():
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = METHODS.get(req.get("method"))
            if method is None:
                raise KeyError("unknown method: %s" % req.get("method"))
            result = method(req.get("params") or {})
            resp = {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as e:
            resp = {"jsonrpc": "2.0", "id": req_id, "error": {"message": str(e), "detail": traceback.format_exc(limit=3)}}
        out.write(json.dumps(resp) + "\n")
        out.flush()


if __name__ == "__main__":
    # Keep stdout for protocol messages only.
    os.environ.setdefault("NO_AT_BRIDGE", "1")
    main()
