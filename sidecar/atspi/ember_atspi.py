#!/usr/libexec/platform-python
# -*- coding: utf-8 -*-
"""Ember's accessibility sidecar.

Reads the AT-SPI tree of desktop applications and performs accessibility
actions on the elements it reported (tier 1: no cursor, no keyboard focus
change unless asked), answering newline-delimited JSON-RPC 2.0 on stdin and
stdout. Must stay compatible with RHEL 8's system Python 3.6 and pyatspi 2.26:
no walrus operator, no dataclasses, no f-string "=" specifiers.

The helpers (secret-field detection, ids, the walk) import without pyatspi or a
display, so `python3 test_ember_atspi.py` can check them with stand-in objects.
"""

import io
import json
import math
import os
import random
import re
import sys
import time
import traceback
import unicodedata
from collections import OrderedDict

try:
    import pyatspi
except ImportError:  # reported per request; the self-test runs without it
    pyatspi = None

VERSION = 3
# Deep enough for GTK 3.22's gedit, whose text view sits 15 levels down under fillers and panels.
MAX_DEPTH = 24
MAX_NODES = 400
MAX_CHILDREN = 200

# libatspi waits up to 15 s for apps it saw start recently ("app_startup_time"),
# and Ember asks one thing at a time, so one hung app would stall everything.
CALL_TIMEOUT_MS = 800
STARTUP_TIMEOUT_MS = 1000
# An app this slow to list its windows is treated as hung, and skipped for a while (a call that
# times out takes at least CALL_TIMEOUT_MS; a busy but working app rarely comes close).
SLOW_APP_S = 0.7
HUNG_FOR_S = 30.0

# GTK reports this position for widgets that have none.
INT_MIN = -2147483648

# Roles that only group or decorate; their children are kept, they are not listed.
SKIP_ROLES = {"filler", "panel", "section", "redundant object", "glass pane", "layered pane", "root pane",
              "scroll pane", "viewport", "split pane", "internal frame", "option pane", "unknown"}
INTERESTING_STATES = ("focused", "checked", "selected", "expanded", "collapsed", "pressed", "editable",
                      "multi line", "sensitive", "enabled", "focusable", "active")
# Controls worth listing actions for (the rest are only read). Keep in step with INTERACTIVE in elements.ts.
INTERACTIVE_ROLES = frozenset([
    "push button", "toggle button", "check box", "radio button", "combo box", "text", "entry", "password text",
    "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "table cell", "check menu item",
    "radio menu item", "tree item", "switch", "icon", "table column header", "column header", "table row header",
    "row header", "terminal", "document text", "paragraph"])
TEXT_ROLES = frozenset(["text", "entry", "password text", "terminal", "paragraph", "document text", "spin button",
                        "combo box"])
VALUE_ROLES = frozenset(["slider", "spin button", "scroll bar", "progress bar", "level bar", "dial"])
# Input fields, whose name or label can make their contents secret (documents and terminals are not judged
# by name). Keep in step with FIELD_ROLES in elements.ts.
FIELD_ROLES = frozenset(["text", "entry", "password text", "spin button", "combo box"])

# Labels of fields whose contents never leave this process (passwords, payment and bank details,
# one-time codes, keys). Keep in step with SECRET_LABEL in app/main/perception/elements.ts.
SECRET_LABEL = re.compile(
    r"\b(pass(word|phrase|code)|passwd|passwort|kennwort|mot de passe|contrase(n|ñ)a|senha|pin( ?code)?"
    r"|card ?(number|no)|credit ?card|cvv2?|cvc2?|csc|security code|card verification|expir(y|ation)"
    r"|iban|routing number|account number|sort code|one[- ]time (code|password|pin)|otp|2fa|two[- ]factor|totp"
    r"|verification code|auth(entication)? code|recovery (code|key)|secret|private key"
    r"|(api|access|auth|bearer) ?(key|token)|ssn|social security)\b")


def looks_secret(label):
    """Does this field name or label say its contents are secret?"""
    if not label:
        return False
    s = unicodedata.normalize("NFKC", label)
    s = "".join(c for c in s if unicodedata.category(c) != "Cf")
    return SECRET_LABEL.search(s.lower()) is not None


# ---------------------------------------------------------------- reading one accessible

def state_names(acc):
    try:
        ss = acc.getState()
        return [pyatspi.stateToString(s) for s in ss.getStates()]
    except Exception:
        return []


def bounds_of(x, y, width, height):
    """A rectangle for JSON, or None when the toolkit has no position for the element."""
    if x == INT_MIN or y == INT_MIN or width < 0 or height < 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def extents(acc):
    try:
        e = acc.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        return None
    return bounds_of(e.x, e.y, e.width, e.height)


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


def selection_of(acc, limit=500):
    """The selected text in a text element (first selection), or None."""
    try:
        t = acc.queryText()
        if t.getNSelections() < 1:
            return None
        start, end = t.getSelection(0)
        if end <= start:
            return None
        return t.getText(start, min(end, start + limit))
    except Exception:
        return None


def value_of(acc):
    try:
        v = float(acc.queryValue().currentValue)
    except Exception:
        return None
    # JSON has no NaN or infinity (the client would drop the whole answer).
    return v if math.isfinite(v) else None


def is_editable(acc, states):
    if "editable" not in states:
        return False
    try:
        acc.queryEditableText()
        return True
    except Exception:
        return False


def labels_of(acc):
    """Names of the elements that label this one (LABELLED_BY), e.g. "Card number" for an unnamed entry."""
    out = []
    try:
        for rel in acc.getRelationSet():
            if rel.getRelationType() != pyatspi.RELATION_LABELLED_BY:
                continue
            for i in range(rel.getNTargets()):
                target = rel.getTarget(i)
                if target is not None and target.name:
                    out.append(target.name)
    except Exception:
        pass
    return out


def object_key(acc):
    """Identifies an accessible across reads: its application's bus name and object path."""
    try:
        app = acc.app
        return (getattr(app, "bus_name", None) or "", acc.path)
    except Exception:
        return None


class SecretFields(object):
    """Accessibles known to hold secrets. GTK's "Show password" turns a password
    field into a plain entry; it stays secret here once seen as one."""

    KEEP = 4096

    def __init__(self):
        self.keys = OrderedDict()

    def add(self, key):
        if key is None:
            return
        self.keys[key] = True
        self.keys.move_to_end(key)
        while len(self.keys) > self.KEEP:
            self.keys.popitem(last=False)

    def __contains__(self, key):
        return key is not None and key in self.keys


SECRETS = SecretFields()


def is_secret(acc, role, name):
    """Never report this element's contents: a password field (now or once), or a field labelled as secret."""
    key = object_key(acc)
    if role == "password text" or key in SECRETS:
        SECRETS.add(key)
        return True
    if role not in FIELD_ROLES:
        return False
    if looks_secret(name) or any(looks_secret(label) for label in labels_of(acc)):
        SECRETS.add(key)
        return True
    return False


# ---------------------------------------------------------------- element ids

def first_id(env=None):
    """Ids continue from EMBER_ATSPI_ID_BASE (Ember gives every sidecar process its own range), else from a
    random offset, so an id from another (or an earlier) sidecar process never names an element here."""
    env = os.environ if env is None else env
    try:
        base = int(env.get("EMBER_ATSPI_ID_BASE") or 0)
    except ValueError:
        base = 0
    if base <= 0 or base > 2 ** 50:
        base = random.randint(1, 2 ** 20) << 20  # stays well inside JSON's safe integers (2**53)
    return base + 1


class Snapshots(object):
    """Accessible objects from recent reads, addressable by integer ids.

    Ids are unique across reads, so a worker acting on an id from its own read
    can't hit an element from someone else's read. The last few reads are kept.
    """

    KEEP = 8

    def __init__(self, start=None):
        self.reads = []  # list of dicts id -> accessible, oldest first
        self.next_id = first_id() if start is None else start

    def begin(self):
        self.reads.append({})
        if len(self.reads) > self.KEEP:
            self.reads.pop(0)

    def add(self, acc):
        nid = self.next_id
        self.next_id += 1
        if not self.reads:
            self.begin()
        self.reads[-1][nid] = acc
        return nid

    def get(self, nid):
        for read in reversed(self.reads):
            if nid in read:
                return read[nid]
        raise KeyError("element %s is no longer known; read the window again" % nid)

    def latest(self):
        return self.reads[-1] if self.reads else {}


SNAPSHOTS = Snapshots()


# ---------------------------------------------------------------- reading a window

def node_of(acc, role, name, states, bounds):
    """What the model is told about one element. Only controls are asked for actions, and only text
    roles for text (each is a round trip to the app); secret fields keep their contents."""
    node = {
        "role": role,
        "name": name[:200],
        "states": [s for s in states if s in INTERESTING_STATES],
        "bounds": bounds,
    }
    interactive = role in INTERACTIVE_ROLES
    if interactive:
        acts = actions(acc)
        if acts:
            node["actions"] = acts
    secret = False
    if role in TEXT_ROLES:
        secret = is_secret(acc, role, name)
        if secret:
            node["secret"] = True
        else:
            txt = text_of(acc)
            if txt:
                node["text"] = txt
            if "focused" in states:
                sel = selection_of(acc)
                if sel:
                    node["selection"] = sel
    if role in VALUE_ROLES and not secret:
        val = value_of(acc)
        if val is not None:
            node["value"] = val
    if (interactive or role in TEXT_ROLES) and is_editable(acc, states):
        node["editable"] = True
    return node


def clip_to(clip, bounds):
    """The visible area inside a scrolling container: the overlap of the two rectangles."""
    if bounds is None:
        return clip
    if clip is None:
        return bounds
    x, y = max(clip["x"], bounds["x"]), max(clip["y"], bounds["y"])
    x1 = min(clip["x"] + clip["width"], bounds["x"] + bounds["width"])
    y1 = min(clip["y"] + clip["height"], bounds["y"] + bounds["height"])
    return {"x": x, "y": y, "width": max(0, x1 - x), "height": max(0, y1 - y)}


def child_at(acc, i):
    try:
        return acc.getChildAtIndex(i)
    except Exception:
        return None


def ends_above(acc, i, top):
    """Does child i lie wholly above `top` (scrolled out of view upwards)?"""
    child = child_at(acc, i)
    b = extents(child) if child is not None else None
    return b is not None and b["y"] + b["height"] <= top


def child_indices(acc, count, clip):
    """Which children to read. Long lists and tables (thousands of rows) are read from the
    first row on screen, not from the top: rows are laid out top to bottom, so a binary search
    finds where the visible ones start. Leading children on screen (column headers) are kept."""
    if count <= MAX_CHILDREN:
        return list(range(count))
    if clip is None:
        return list(range(MAX_CHILDREN))
    top = clip["y"]
    lead = 0
    while lead < min(count, 16) and not ends_above(acc, lead, top) and "showing" in state_names(child_at(acc, lead)):
        lead += 1
    lo, hi = lead, count - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if ends_above(acc, mid, top):
            lo = mid + 1
        else:
            hi = mid
    rest = MAX_CHILDREN - lead
    return list(range(lead)) + list(range(lo, min(count, lo + rest)))


# Containers whose extents bound what their children show: scrolled lists stop at their edges.
CLIP_ROLES = frozenset(["scroll pane", "viewport"])


def walk(acc, depth, out, max_depth, max_nodes, parent_id, clip=None):
    """Reports acc and what it contains, depth first. Returns whether acc is on screen."""
    if len(out) >= max_nodes or depth > max_depth:
        return False
    states = state_names(acc)
    if "showing" not in states or "visible" not in states:
        # Invisible elements are a known prompt-injection channel; never report them.
        return False
    role = acc.getRoleName()
    name = (acc.name or "").strip()
    my_id = parent_id
    listed = role not in SKIP_ROLES or bool(name)
    bounds = extents(acc) if listed or depth == 0 or role in CLIP_ROLES else None
    if listed and (bounds is None or (bounds["width"] > 0 and bounds["height"] > 0)):
        node = node_of(acc, role, name, states, bounds)
        node["id"] = SNAPSHOTS.add(acc)
        node["parent"] = parent_id
        node["depth"] = depth
        out.append(node)
        my_id = node["id"]
    if depth == 0 or role in CLIP_ROLES:
        clip = clip_to(clip, bounds)
    try:
        count = acc.childCount
    except Exception:
        count = 0
    long_list = count > MAX_CHILDREN
    shown, misses = False, 0
    for i in child_indices(acc, count, clip):
        if len(out) >= max_nodes:
            break
        child = child_at(acc, i)
        if child is None:
            continue
        on_screen = walk(child, depth + 1, out, max_depth, max_nodes, my_id, clip)
        if long_list:
            # Past the rows on screen: the rest of a long list is scrolled away too.
            shown, misses = (True, 0) if on_screen else (shown, misses + 1 if shown else 0)
            if misses >= 3:
                break
    return True


def left_label(node, labels):
    """The label just left of an unnamed control on the same row (the rule inferLabels in elements.ts uses)."""
    b = node["bounds"]
    cy = b["y"] + b["height"] / 2.0
    best, best_gap = None, None
    for lab in labels:
        lb = lab["bounds"]
        ly = lb["y"] + lb["height"] / 2.0
        gap = b["x"] - (lb["x"] + lb["width"])
        if abs(ly - cy) < max(12, b["height"] / 2.0) and -4 <= gap < 320 and (best is None or gap < best_gap):
            best, best_gap = lab["name"], gap
    return best


def redact_by_layout(nodes, accessible_of):
    """Unnamed text fields next to a "Password" or "Card number" label: their contents are secret too."""
    labels = [n for n in nodes if n["role"] == "label" and n["name"] and n["bounds"]]
    for n in nodes:
        if n["role"] not in FIELD_ROLES or n["name"] or not n["bounds"] or n.get("secret"):
            continue
        if looks_secret(left_label(n, labels)):
            for k in ("text", "selection", "value"):
                n.pop(k, None)
            n["secret"] = True
            SECRETS.add(object_key(accessible_of(n["id"])))


# ---------------------------------------------------------------- windows

HUNG = {}  # pid -> time.monotonic() until which the app is skipped


def is_hung(pid):
    until = HUNG.get(pid)
    if until is None:
        return False
    if time.monotonic() >= until:
        del HUNG[pid]
        return False
    return True


def mark_hung(pid):
    if pid is not None:
        HUNG[pid] = time.monotonic() + HUNG_FOR_S


def process_id(app):
    try:
        return app.get_process_id()
    except Exception:
        return None


def frames(only_pid=None, skip_pid=None):
    """(app, pid, window) for every top-level window. The process id is checked before an app is
    asked for its windows; apps that recently took too long to answer are skipped unless asked for."""
    desktop = pyatspi.Registry.getDesktop(0)
    try:
        napps = desktop.childCount
    except Exception:
        return
    for a in range(napps):
        try:
            app = desktop.getChildAtIndex(a)
        except Exception:
            continue
        if app is None:
            continue
        pid = process_id(app)
        if only_pid is not None and pid != only_pid:
            continue
        if skip_pid is not None and pid == skip_pid:
            continue
        if only_pid is None and is_hung(pid):
            continue
        t0 = time.monotonic()
        wins = []
        try:
            for i in range(min(app.childCount, MAX_CHILDREN)):
                try:
                    win = app.getChildAtIndex(i)
                except Exception:
                    continue
                if win is not None:
                    wins.append(win)
        except Exception:
            pass
        if time.monotonic() - t0 > SLOW_APP_S:
            mark_hung(pid)
        for win in wins:
            yield app, pid, win


def window_facts(pid, win):
    """(lowercase name, states) of a window; a slow answer marks its app as hung."""
    t0 = time.monotonic()
    states = state_names(win)
    try:
        name = (win.name or "").lower()
    except Exception:
        name = ""
    if time.monotonic() - t0 > SLOW_APP_S:
        mark_hung(pid)
    return name, states


def window_path(win):
    """The frame's object path: with the pid, it names one window for as long as it is open."""
    try:
        return win.path
    except Exception:
        return None


def describe_window(app, pid, win):
    states = state_names(win)
    return {
        "app": app.name or "",
        "pid": pid,
        "path": window_path(win),
        "name": win.name or "",
        "role": win.getRoleName(),
        "active": "active" in states,
        "bounds": extents(win),
    }


def list_windows(params):
    out = []
    for app, pid, win in frames():
        _, states = window_facts(pid, win)
        if "showing" in states or "active" in states:
            out.append(describe_window(app, pid, win))
    return {"windows": out}


def best_window(found, pid, title):
    """(window, score) of the best match: same process, then exact title, then title substring,
    preferring the window the user has active (one app often has several windows)."""
    best, best_score = None, 0
    for app, apid, win in found:
        name, states = window_facts(apid, win)
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
    return best, best_score


def find_window(params):
    """The window to read: by pid and path (exactly that window), by pid and/or title (see
    best_window), or with none of them, the active window. With a pid, only that app is asked
    first; other apps' windows can at most score 9."""
    pid = params.get("pid")
    title = (params.get("title") or "").lower()
    path = params.get("path")
    if pid is not None and path:
        # One particular window: that one, or none (never another window in its place).
        for app, apid, win in frames(only_pid=pid):
            if window_path(win) == path:
                return app, apid, win
        return None
    if pid is None and not title:
        for app, apid, win in frames():
            if "active" in window_facts(apid, win)[1]:
                return app, apid, win
        return None
    if pid is not None:
        best, score = best_window(frames(only_pid=pid), pid, title)
        if not title or score >= 10:
            return best
        other, other_score = best_window(frames(skip_pid=pid), pid, title)
        return other if other_score > score else best
    return best_window(frames(), None, title)[0]


def read_window(params):
    t0 = time.time()
    found = find_window(params)
    if found is None:
        return {"window": None, "nodes": [], "ms": int((time.time() - t0) * 1000)}
    app, pid, win = found
    SNAPSHOTS.begin()
    nodes = []
    max_nodes = int(params.get("maxNodes", MAX_NODES))
    walk(win, 0, nodes, int(params.get("maxDepth", MAX_DEPTH)), max_nodes, None)
    latest = SNAPSHOTS.latest()
    redact_by_layout(nodes, lambda nid: latest.get(nid))
    return {
        "window": describe_window(app, pid, win),
        "nodes": nodes,
        "truncated": len(nodes) >= max_nodes,
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


# ---------------------------------------------------------------- actions (tier 1)

ACTION_ALIASES = {
    "click": ("click", "press", "activate", "jump", "toggle"),
    "press": ("press", "click", "activate"),
    "activate": ("activate", "click", "press", "jump"),
    "toggle": ("toggle", "click", "press", "activate"),
    "expand": ("expand or contract", "expand", "open", "press"),
}


def node_info(acc):
    """The element as it is now, for checking an action worked."""
    states = state_names(acc)
    role = acc.getRoleName()
    name = (acc.name or "").strip()
    info = {"role": role, "name": name[:200], "states": [s for s in states if s in INTERESTING_STATES],
            "bounds": extents(acc)}
    if is_secret(acc, role, name):
        info["secret"] = True
        return info
    txt = text_of(acc, 2000)
    if txt is not None:
        info["text"] = txt
    val = value_of(acc)
    if val is not None:
        info["value"] = val
    if role == "combo box":
        try:
            sel = acc.querySelection()
            holder = acc.getChildAtIndex(0) if acc.childCount == 1 else acc
            for i in range(holder.childCount):
                if sel.isChildSelected(i):
                    info["selected"] = (holder.getChildAtIndex(i).name or "").strip()
                    break
        except Exception:
            pass
    return info


def settle():
    # Toolkits apply most changes on their next main-loop iteration.
    time.sleep(0.08)


def usable(nid):
    """The element behind an id, if the user could use it right now (enabled and on screen)."""
    acc = SNAPSHOTS.get(nid)
    states = state_names(acc)
    if not states or "defunct" in states:
        raise RuntimeError("element %s is gone (the window changed); read the window again" % nid)
    if "sensitive" not in states and "enabled" not in states:
        raise RuntimeError("element %s is disabled right now" % nid)
    if "showing" not in states:
        raise RuntimeError("element %s is no longer on screen; read the window again" % nid)
    return acc


def refuse_secret(acc):
    role = acc.getRoleName()
    if role == "password text":
        raise PermissionError("password fields are off limits to Ember; the user must fill them in")
    if is_secret(acc, role, (acc.name or "").strip()):
        raise PermissionError("this looks like a password or payment field; the user must fill it in")


def do_action(params):
    acc = usable(int(params["id"]))
    want = (params.get("action") or "click").lower()
    try:
        act = acc.queryAction()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element has no accessible actions")
    names = [act.getName(i).lower() for i in range(act.nActions)]
    index = None
    for candidate in ACTION_ALIASES.get(want, (want,)):
        if candidate in names:
            index = names.index(candidate)
            break
    if index is None:
        raise RuntimeError("background_unavailable: no '%s' action (has: %s)" % (want, ", ".join(names) or "none"))
    before = node_info(acc)
    ok = act.doAction(index)
    settle()
    return {"ok": bool(ok), "action": names[index], "before": before, "after": node_info(acc)}


def set_text(params):
    acc = usable(int(params["id"]))
    refuse_secret(acc)
    text = params.get("text", "")
    mode = params.get("mode", "replace")
    try:
        et = acc.queryEditableText()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element's text can't be edited directly")
    if mode == "replace":
        ok = et.setTextContents(text)
    else:
        t = acc.queryText()
        offset = t.characterCount if mode == "append" else max(0, t.caretOffset)
        ok = et.insertText(offset, text, len(text))
    settle()
    return {"ok": bool(ok), "after": node_info(acc)}


def set_value(params):
    acc = usable(int(params["id"]))
    refuse_secret(acc)
    try:
        v = acc.queryValue()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element has no value to set")
    value = float(params["value"])
    if not math.isfinite(value) or value < v.minimumValue or value > v.maximumValue:
        raise ValueError("value %s is outside %s..%s" % (value, v.minimumValue, v.maximumValue))
    v.currentValue = value
    settle()
    return {"ok": True, "after": node_info(acc)}


def option_items(acc):
    """(selection-owner, [names]) for a combo box or list: the items Selection indexes."""
    try:
        acc.querySelection()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element has no selectable options")
    holder = acc
    # GTK combo boxes keep their items in a child menu.
    if acc.getRoleName() == "combo box" and acc.childCount == 1:
        child = acc.getChildAtIndex(0)
        if child is not None and child.getRoleName() in ("menu", "list"):
            holder = child
    names = []
    for i in range(min(holder.childCount, 500)):
        c = holder.getChildAtIndex(i)
        names.append((c.name or "").strip() if c is not None else "")
    return names


def select_option(params):
    acc = usable(int(params["id"]))
    refuse_secret(acc)
    names = option_items(acc)
    want = str(params.get("option", "")).strip().lower()
    index = None
    for i, n in enumerate(names):
        if n.lower() == want:
            index = i
            break
    if index is None:
        for i, n in enumerate(names):
            if want and want in n.lower():
                index = i
                break
    if index is None:
        raise ValueError("no option '%s' (options: %s)" % (params.get("option"), ", ".join(names[:30])))
    ok = acc.querySelection().selectChild(index)
    settle()
    return {"ok": bool(ok), "option": names[index], "after": node_info(acc)}


def list_options(params):
    acc = SNAPSHOTS.get(int(params["id"]))
    return {"options": option_items(acc)}


def focus(params):
    acc = usable(int(params["id"]))
    ok = acc.queryComponent().grabFocus()
    settle()
    return {"ok": bool(ok), "after": node_info(acc)}


def read_element(params):
    return node_info(SNAPSHOTS.get(int(params["id"])))


METHODS = {
    "ping": lambda p: {"version": VERSION},
    "status": status,
    "list_windows": list_windows,
    "read_window": read_window,
    "read_element": read_element,
    "do_action": do_action,
    "set_text": set_text,
    "set_value": set_value,
    "select_option": select_option,
    "list_options": list_options,
    "focus": focus,
}


# ---------------------------------------------------------------- protocol

def configure_atspi():
    """Short libatspi timeouts, so a hung app costs about a second instead of 15 (pyatspi 2.26 has no
    wrapper for this; it is libatspi's own call). Returns whether it worked."""
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.set_timeout(CALL_TIMEOUT_MS, STARTUP_TIMEOUT_MS)
        return True
    except Exception:
        return False


def protocol_streams():
    """stdin and stdout as UTF-8 whatever the locale (Python 3.6 under LANG=C would read stdin as
    ASCII), and fd 1 pointed at stderr so stray prints from libraries can't corrupt the protocol."""
    out = io.open(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    inp = io.open(sys.stdin.fileno(), "r", encoding="utf-8", errors="replace", newline="\n", closefd=False)
    return inp, out


def encode(resp):
    """One protocol line. Values JSON can't carry (NaN, infinity) turn the answer into an error."""
    try:
        return json.dumps(resp, allow_nan=False)
    except (TypeError, ValueError) as e:
        return json.dumps({"jsonrpc": "2.0", "id": resp.get("id"),
                           "error": {"message": "the answer could not be encoded: %s" % e}})


def handle(line):
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get("id")
        method = METHODS.get(req.get("method"))
        if method is None:
            raise KeyError("unknown method: %s" % req.get("method"))
        if pyatspi is None and req.get("method") != "ping":
            raise RuntimeError("python3-pyatspi is not installed")
        result = method(req.get("params") or {})
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    except Exception as e:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"message": str(e), "detail": traceback.format_exc(limit=3)}}


def main():
    inp, out = protocol_streams()
    if pyatspi is not None and not configure_atspi():
        sys.stderr.write("ember_atspi: could not shorten libatspi timeouts\n")
    while True:
        line = inp.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        out.write(encode(handle(line)) + "\n")
        out.flush()


if __name__ == "__main__":
    # Keep stdout for protocol messages only.
    os.environ.setdefault("NO_AT_BRIDGE", "1")
    main()
