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
Atspi = None
if pyatspi is not None:
    try:
        # libatspi itself (pyatspi loaded it): states and extents straight from it take half the time.
        from gi.repository import Atspi
    except Exception:
        pass

VERSION = 3
# Deep enough for GTK 3.22's gedit, whose text view sits 15 levels down under fillers and panels.
MAX_DEPTH = 24
MAX_NODES = 400
MAX_CHILDREN = 200

# libatspi waits up to 15 s for apps it saw start recently ("app_startup_time"),
# and Ember asks one thing at a time, so one hung app would stall everything.
CALL_TIMEOUT_MS = 800
STARTUP_TIMEOUT_MS = 1000
# A call that fails after this long timed out (it takes CALL_TIMEOUT_MS). An app that times out
# twice in a row is hung, and skipped for a while; once is only busy (opening a file dialog with
# hundreds of files takes a second), and a busy app's windows mustn't vanish from the list.
SLOW_APP_S = 0.7
STRIKES_WITHIN_S = 60.0
HUNG_FOR_S = 30.0
# Timeouts closer together than this are one episode and one strike: Ember asks a busy app once more right
# away, and a look at a window asks it several things.
STRIKE_GAP_S = 5.0
# A read stops after this long with what it has (Ember gives up on the helper after 5 s, and a
# partial answer now beats a complete one too late). Looking for the window gets about as long,
# and the whole answer should be there within READ_TOTAL_S.
READ_BUDGET_S = 1.5
FIND_BUDGET_S = 2.0
READ_TOTAL_S = 3.0

# GTK reports this position for widgets that have none.
INT_MIN = -2147483648

# Roles that only group or decorate; their children are kept, they are not listed.
SKIP_ROLES = {"filler", "panel", "section", "redundant object", "glass pane", "layered pane", "root pane",
              "scroll pane", "viewport", "split pane", "internal frame", "option pane", "unknown"}
INTERESTING_STATES = ("focused", "checked", "selected", "expanded", "collapsed", "pressed", "editable",
                      "multi line", "sensitive", "enabled", "focusable", "active")
# Controls worth listing actions for (the rest are only read). Keep in step with INTERACTIVE in elements.ts.
# Rows and cells (hundreds in a file dialog) are not asked: their actions are looked up when one is used.
INTERACTIVE_ROLES = frozenset([
    "push button", "toggle button", "check box", "radio button", "combo box", "text", "entry", "password text",
    "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "table cell", "check menu item",
    "radio menu item", "tree item", "switch", "icon", "table column header", "column header", "table row header",
    "row header", "terminal", "document text", "paragraph"])
LAZY_ACTION_ROLES = frozenset(["list item", "table cell", "tree item", "table column header", "column header",
                               "table row header", "row header"])
TEXT_ROLES = frozenset(["text", "entry", "password text", "terminal", "paragraph", "document text", "spin button",
                        "combo box"])
VALUE_ROLES = frozenset(["slider", "spin button", "scroll bar", "progress bar", "level bar", "dial"])
# Input fields, whose name or label can make their contents secret (documents and terminals are not judged
# by name). Keep in step with FIELD_ROLES in elements.ts.
FIELD_ROLES = frozenset(["text", "entry", "password text", "spin button", "combo box"])
# Text that labels a control: GTK's and Qt's labels, Chromium's plain text. Keep in step with LABEL_ROLES in elements.ts.
LABEL_ROLES = frozenset(["label", "static", "caption"])

# Labels of fields whose contents never leave this process (passwords, payment and bank details,
# one-time codes, keys), in the languages Ember's users are likely to meet. The same lists as
# SECRET_WORDS and SECRET_ANYWHERE in app/main/perception/elements.ts (a unit test checks): each entry
# is a regular expression both engines read alike, matched on lowercase, NFKC-normalised text.
SECRET_WORDS = [
    # Passwords and PINs. Words that mean something else too stand alone or in a phrase that says password
    # ("Palabras clave" are keywords, a "Parola chiave" a keyword).
    "pass(word|phrase|code|wd)", "passwort", "kennwort", "passord", "wachtwoord", "mot de passe", "contrase(n|ñ)a",
    "contrasenya", "senha", "palavra-passe", r"^[\s:*]*parol(a|ă)[\s:*]*$", "parolă", "parola d['’]ordine",
    "parola (nou(a|ă)|actual(a|ă)|curent(a|ă)|veche|contului)", "(confirm(a|ă)|introduce(ți|ti)|schimb(a|ă)) parola",
    "(yeni|mevcut|eski) parola", "parola(nız|yı|nızı)", "парола", r"^[\s:*]*clave[\s:*]*$",
    "clave (de acceso|secreta|personal|bancaria|de seguridad|de (la )?tarjeta)", "(tu|su) clave", "lösenord", "adgangskode",
    "salasana", "hasło", "heslo", "geslo", "lozinka", "jelszó", "(ş|s)ifre", "κωδικός", "пароль", "лозинка", "kata sandi",
    "mật khẩu", "كلمة (المرور|السر)", "pin( ?code)?",
    # Cards and bank accounts. An expiry date only beside a card ("Expiration date of the report" is not one).
    "card ?(number|no)", "credit ?card", "cvv2?", "cvc2?", "csc", "security code", "card verification",
    "card (expir(y|ation)|exp)", "mm ?/ ?(yy|aa|jj){1,2}", "valid (thru|through)", "kartennummer", "kreditkarte(nnummer)?",
    "prüfziffer", "prüfnummer", "sicherheitscode", "ablaufdatum der karte", "num(é|e)ro de (la )?carte", "cryptogramme",
    "date d['’]expiration de (la )?carte", "n(ú|u)mero de (la )?tarjeta", "n(ú|u)mero do cart(ã|a)o", "numero (di|della) carta",
    "kaartnummer", "kortnummer", "numer karty", "номер карты",
    "c(ó|o)digo de (seguridad|segurança|verificaci(ó|o)n|verificação|acceso|confirmaci(ó|o)n)",
    "codice di (sicurezza|verifica)", "(fecha de )?(caducidad|vencimiento|expiraci(ó|o)n) de (la )?tarjeta", "iban",
    "routing number", "account number", "sort code", "kontonummer",
    # One-time codes.
    "one[- ]time (code|password|pin)", "otp", "2fa", "two[- ]factor", "totp", "verification code", "auth(entication)? code",
    "recovery (code|key)", "bestätigungscode", "code de (vérification|sécurité|confirmation)", "verificatiecode", "kod weryfikacyjny",
    "код (подтверждения|безопасности)",
    # Keys, network passwords and secret answers.
    "secret", "private key", "(api|access|auth|bearer) ?(key|token)", "wi-?fi (key|password|passphrase)", "network (security )?key",
    "wpa2? ?(key|passphrase)", "pre-?shared key", "psk", "encryption key", "security (answer|question)", "secret (answer|question)",
    "ssn", "social security",
]
# The same, for scripts written without spaces between words (matched anywhere in the label).
SECRET_ANYWHERE = ["密码", "密碼", "口令", "パスワード", "暗証", "비밀번호", "암호", "รหัสผ่าน", "סיסמ", "卡号", "卡號", "カード番号",
                   "安全码", "安全碼", "验证码", "驗證碼", "確認コード", "セキュリティコード", "認証コード"]
SECRET_LABEL = re.compile(r"(?<!\w)(?:" + "|".join(SECRET_WORDS) + r")(?!\w)|" + "|".join(SECRET_ANYWHERE))


def normalize_label(label):
    """Lowercase NFKC text without invisible characters (and Turkish İ's stray dot), as labels are matched."""
    s = unicodedata.normalize("NFKC", label)
    s = "".join(c for c in s if unicodedata.category(c) != "Cf")
    return s.lower().replace("\u0307", "")


def looks_secret(label):
    """Does this field name or label say its contents are secret?"""
    return bool(label) and SECRET_LABEL.search(normalize_label(label)) is not None


# ---------------------------------------------------------------- reading one accessible

STATE_NAMES = {}  # state -> its name, as pyatspi spells it ("multi line")


def native(acc):
    """A real libatspi accessible (not a test's stand-in), whose calls can skip pyatspi's wrappers."""
    return Atspi is not None and isinstance(acc, Atspi.Accessible)


def state_names(acc):
    try:
        states = Atspi.Accessible.get_state_set(acc).get_states() if native(acc) else acc.getState().getStates()
        out = []
        for s in states:
            name = STATE_NAMES.get(s)
            if name is None:
                name = STATE_NAMES[s] = pyatspi.stateToString(s)
            out.append(name)
        return out
    except Exception:
        return []


def bounds_of(x, y, width, height):
    """A rectangle for JSON, or None when the toolkit has no position for the element."""
    if x == INT_MIN or y == INT_MIN or width < 0 or height < 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def raw_extents(acc):
    """The element's rectangle on the desktop as the toolkit reports it; raises when it has none."""
    if native(acc):
        return Atspi.Component.get_extents(acc, Atspi.CoordType.SCREEN)
    return acc.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)


def extents(acc):
    try:
        e = raw_extents(acc)
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


def placeholder_of(acc):
    """A field's placeholder ("Password"), from its object attributes (GTK: placeholder-text)."""
    try:
        attrs = acc.getAttributes()
    except Exception:
        return ""
    pairs = attrs.items() if isinstance(attrs, dict) else (a.partition(":")[::2] for a in attrs or [])
    for k, v in pairs:
        if k in ("placeholder-text", "placeholder"):
            return v
    return ""


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
    if looks_secret(name) or any(looks_secret(label) for label in labels_of(acc)) or looks_secret(placeholder_of(acc)):
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
    """What the model is told about one element. Only controls are asked for actions (not rows and cells),
    and only text roles for text (each is a round trip to the app); secret fields keep their contents."""
    node = {
        "role": role,
        "name": name[:200],
        "states": [s for s in states if s in INTERESTING_STATES],
        "bounds": bounds,
    }
    interactive = role in INTERACTIVE_ROLES
    if interactive and role not in LAZY_ACTION_ROLES:
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


def raw_height(acc):
    """An element's height, even when its position is unknown (GTK's tree view cells)."""
    try:
        return raw_extents(acc).height
    except Exception:
        return None


def scroll_fraction(acc):
    """How far down its scroll pane a container is scrolled (0 to 1), from the vertical scroll bar."""
    try:
        pane = acc.parent
        bars = [pane.getChildAtIndex(i) for i in range(min(pane.childCount, 8))]
    except Exception:
        return None
    for bar in bars:
        if bar is None or bar.getRoleName() != "scroll bar" or "vertical" not in state_names(bar):
            continue
        try:
            v = bar.queryValue()
            low, high, now = float(v.minimumValue), float(v.maximumValue), float(v.currentValue)
        except Exception:
            continue
        return 0.0 if high <= low else min(1.0, max(0.0, (now - low) / (high - low)))
    return None


def table_indices(acc, count):
    """For a big table: its header cells and the rows around the scroll position. GTK's tree view
    (file dialogs, mail lists) reports every cell as showing and none with a position, so the
    vertical scroll bar says where the view is; the Table interface maps rows to children."""
    try:
        t = acc.queryTable()
        nrows, ncols = t.nRows, t.nColumns
        first_cell = t.getIndexAt(0, 0)
    except Exception:
        return None
    if nrows <= 0 or ncols <= 0 or first_cell < 0:
        return None
    frac = scroll_fraction(acc)
    if frac is None:
        return None
    b = extents(acc)
    row_h = raw_height(child_at(acc, first_cell)) or 20
    shown = int((b["height"] if b else 600) / max(1, row_h)) + 1
    first = max(0, int(round(frac * max(0, nrows - shown))) - 1)
    rows = range(first, min(nrows, first + shown + 2))
    try:
        # Cells are usually row after row; one look confirms it, else ask for each cell.
        regular = t.getIndexAt(first, 0) == first_cell + first * ncols
        cells = [first_cell + r * ncols + c if regular else t.getIndexAt(r, c) for r in rows for c in range(ncols)]
    except Exception:
        return None
    heads = list(range(min(first_cell, 16)))
    return heads + [i for i in cells if 0 <= i < count]


def overlaps(b, clip):
    """Does rectangle b show inside `clip`? (Yes when either has no position.)"""
    if b is None or clip is None:
        return True
    return b["x"] < clip["x"] + clip["width"] and clip["x"] < b["x"] + b["width"] \
        and b["y"] < clip["y"] + clip["height"] and clip["y"] < b["y"] + b["height"]


def on_screen(acc, i, clip):
    """Is child i showing, and inside `clip` (when both have a position)?"""
    child = child_at(acc, i)
    states = state_names(child) if child is not None else []
    return "showing" in states and "visible" in states and overlaps(extents(child), clip)


def child_indices(acc, count, clip, cap=MAX_CHILDREN):
    """Which children to read (at most `cap`), and whether some on screen had to be left out.
    Long lists and tables (thousands of rows) are read from the first row on screen, not from
    the top: rows are laid out top to bottom, so a binary search finds where the visible ones
    start. Leading children on screen (column headers) are kept."""
    if count <= MAX_CHILDREN:
        return list(range(count)), False
    in_table = table_indices(acc, count)
    if in_table is not None:
        return in_table[:cap], len(in_table) > cap
    if clip is None:
        return list(range(min(count, cap))), cap < count and on_screen(acc, cap, clip)
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
    end = min(count, lo + cap - lead)
    return list(range(lead)) + list(range(lo, end)), end < count and on_screen(acc, end, clip)


# Containers whose extents bound what their children show: scrolled lists stop at their edges.
CLIP_ROLES = frozenset(["scroll pane", "viewport"])


class Budget(object):
    """The time one read may take. Between two ticks the app is asked only a few things, so a gap
    longer than SLOW_APP_S was a call that timed out: the app is busy (or hung), and asking it more
    would only time out again. Either way the read stops where it is. `cut` notes elements left out
    for want of room (the node limit, a long list's row limit) rather than time."""

    def __init__(self, seconds=READ_BUDGET_S):
        self.last = time.monotonic()
        self.until = self.last + seconds
        self.busy = False
        self.over = False
        self.cut = False

    def check(self):
        """Did the app take a timeout's time to answer what it was asked since the last look? (True: stop.)"""
        now = time.monotonic()
        if now - self.last > SLOW_APP_S:
            self.busy = True
        self.last = now
        return self.busy

    def tick(self):
        """Before asking for more: True once the read should stop (the app stopped answering, or the time is
        up, which makes the read cut short)."""
        if self.check():
            return True
        if self.last >= self.until:
            self.over = True
        return self.over


def walk(acc, depth, out, max_depth, max_nodes, parent_id, clip=None, budget=None):
    """Reports acc and what it contains, depth first. Returns whether acc is on screen."""
    budget = budget or Budget()
    if depth > max_depth:
        return False
    if len(out) >= max_nodes:
        budget.cut = True
        return False
    if budget.tick():
        return False
    states = state_names(acc)
    if "showing" not in states or "visible" not in states:
        # Invisible elements are a known prompt-injection channel; never report them.
        return False
    try:
        role = acc.getRoleName()
        name = (acc.name or "").strip()
    except Exception:
        return False
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
    if budget.check():
        return True
    try:
        count = acc.childCount
    except Exception:
        count = 0
    long_list = count > MAX_CHILDREN
    indices, left_out = child_indices(acc, count, clip)
    shown, misses = False, 0
    for i in indices:
        if len(out) >= max_nodes:
            budget.cut = True
            return True
        if budget.tick():
            return True
        child = child_at(acc, i)
        if child is None:
            continue
        on_screen_now = walk(child, depth + 1, out, max_depth, max_nodes, my_id, clip, budget)
        if budget.busy or budget.over:
            return True
        if long_list:
            # Past the rows on screen: the rest of a long list is scrolled away too.
            shown, misses = (True, 0) if on_screen_now else (shown, misses + 1 if shown else 0)
            if misses >= 3:
                return True
    if left_out:
        # More of a long list is on screen than one read takes.
        budget.cut = True
    return True


# Controls a label on their row names (a label beside a link or a button is usually a heading). Keep in step with
# NAMED_BY_ROW in elements.ts.
LABELLED_ROLES = FIELD_ROLES | frozenset(["check box", "radio button", "toggle button", "switch", "slider"])


def beside(lb, b):
    """Is the label (bounds lb) on the row of the control (bounds b), to its left? Returns the gap, or None."""
    gap = b["x"] - (lb["x"] + lb["width"])
    same_row = abs(lb["y"] + lb["height"] / 2.0 - (b["y"] + b["height"] / 2.0)) < max(12, b["height"] / 2.0)
    return gap if same_row and -4 <= gap < 320 else None


def claimed_labels(labels, controls):
    """Labels that already name a control on their own row: they don't name a field below too (a "Password"
    label with its field to its right says nothing about the notes field under that row)."""
    return set(id(lab) for lab in labels if any(beside(lab["bounds"], c["bounds"]) is not None for c in controls))


def nearby_label(node, labels, claimed=frozenset()):
    """The label of an unnamed control: on its row to its left, else just above it and over its left part
    (the rule inferLabels in elements.ts uses)."""
    b = node["bounds"]
    left, left_gap, above, above_gap = None, None, None, None
    for lab in labels:
        lb = lab["bounds"]
        gap = beside(lb, b)
        if gap is not None and (left is None or gap < left_gap):
            left, left_gap = lab["name"], gap
        up = b["y"] - (lb["y"] + lb["height"])
        # Above it, from a little left of where it starts (an indented field) to no further than its middle.
        if -4 <= up < 24 and lb["x"] <= b["x"] + b["width"] / 2.0 and lb["x"] + lb["width"] >= b["x"] - 16 \
                and id(lab) not in claimed and (above is None or up < above_gap):
            above, above_gap = lab["name"], up
    return left if left is not None else above


def secret_by_layout(fields, labels, controls):
    """The unnamed fields, of `fields`, next to or under a "Password" or "Card number" label."""
    claimed = claimed_labels(labels, controls)
    return [f for f in fields if not f["name"] and looks_secret(nearby_label(f, labels, claimed))]


def redact_by_layout(nodes, accessible_of):
    """Unnamed text fields next to or under a "Password" or "Card number" label: their contents are secret too."""
    labels = [n for n in nodes if n["role"] in LABEL_ROLES and n["name"] and n["bounds"]]
    controls = [n for n in nodes if n["role"] in LABELLED_ROLES and n["bounds"]]
    fields = [n for n in nodes if n["role"] in FIELD_ROLES and n["bounds"] and not n.get("secret")]
    for n in secret_by_layout(fields, labels, controls):
        for k in ("text", "selection", "value"):
            n.pop(k, None)
        n["secret"] = True
        SECRETS.add(object_key(accessible_of(n["id"])))


# ---------------------------------------------------------------- windows

HUNG = {}  # pid -> time.monotonic() until which the app is skipped
STRIKES = {}  # pid -> (timeouts in a row, time.monotonic() of the last one counted)
SLOW_NOW = set()  # apps that timed out during the current request: not asked again before the next one
SKIPPED_NOW = set()  # hung apps the current request left out
# The windows each app showed when it last answered (pid -> OrderedDict of path -> window): a busy or hung
# app's windows are still listed (as busy), not dropped as if they had closed.
KNOWN = OrderedDict()
KNOWN_APPS = 200
KNOWN_WINDOWS = 20


def new_request():
    SLOW_NOW.clear()
    SKIPPED_NOW.clear()


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


def timed_out(pid):
    """A call to this app failed after a timeout: a second time in a row, a while after the first, it is hung."""
    if pid is None:
        return
    now = time.monotonic()
    count, last = STRIKES.get(pid, (0, None))
    if last is not None and now - last < STRIKE_GAP_S:
        return
    count = count + 1 if last is not None and now - last <= STRIKES_WITHIN_S else 1
    STRIKES[pid] = (count, now)
    if count >= 2:
        mark_hung(pid)


def answered(pid):
    """The app answered: it isn't hung (any more)."""
    STRIKES.pop(pid, None)
    HUNG.pop(pid, None)


def note_answer(pid, t0, ok):
    """After asking app `pid` something at t0: a failure that took a timeout's time is a strike."""
    if ok:
        answered(pid)
    elif time.monotonic() - t0 > SLOW_APP_S:
        timed_out(pid)
        SLOW_NOW.add(pid)


def process_id(app):
    try:
        return app.get_process_id()
    except Exception:
        return None


def app_windows(app, pid):
    """An app's top-level windows. libatspi answers a call that timed out with -1 for the count and None for a
    window, not with an error: then the app is busy, and isn't asked more during this request.
    (Answers prove little: libatspi may give them from its cache. window_facts asks the app.)"""
    t0 = time.monotonic()
    try:
        count = app.childCount
    except Exception:
        count = -1
    if count < 0:
        note_answer(pid, t0, False)
        return []
    wins = []
    for i in range(min(count, MAX_CHILDREN)):
        t0 = time.monotonic()
        try:
            win = app.getChildAtIndex(i)
        except Exception:
            win = None
        if win is not None:
            wins.append(win)
        elif time.monotonic() - t0 > SLOW_APP_S:
            note_answer(pid, t0, False)
            break
    return wins


def frames(only_pid=None, skip_pid=None, until=None):
    """(app, pid, window) for every top-level window. The process id is checked before an app is
    asked for its windows; hung apps (see timed_out) are skipped for a while unless asked for.
    Past `until` (time.monotonic()), busy apps took the time already: the rest wait for the next request."""
    desktop = pyatspi.Registry.getDesktop(0)
    try:
        napps = desktop.childCount
    except Exception:
        return
    for a in range(napps):
        if until is not None and time.monotonic() > until:
            return
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
        if pid in SLOW_NOW:
            continue
        if only_pid is None and is_hung(pid):
            SKIPPED_NOW.add(pid)
            continue
        for win in app_windows(app, pid):
            yield app, pid, win


def remember_windows(pid, windows, merge=False):
    """What app `pid` showed when it last answered (see KNOWN): these windows, or these too (`merge`)."""
    if pid is None:
        return
    known = KNOWN.pop(pid, None) if merge else None
    known = known if known is not None else OrderedDict()
    if not merge:
        KNOWN.pop(pid, None)
    for w in windows:
        known.pop(w.get("path") or w.get("name"), None)
        known[w.get("path") or w.get("name")] = w
    while len(known) > KNOWN_WINDOWS:
        known.popitem(last=False)
    if known:
        KNOWN[pid] = known
    while len(KNOWN) > KNOWN_APPS:
        KNOWN.popitem(last=False)


def might_have(pid, title):
    """Could this app, which didn't answer, have the window asked for? Its windows as last seen say (any, unknown)."""
    known = KNOWN.get(pid)
    return not known or not title or any(title in (w.get("name") or "").lower() for w in known.values())


def window_facts(pid, win):
    """(lowercase name, states) of a window; a timed-out answer is a strike against its app."""
    if pid in SLOW_NOW:
        return "", []
    t0 = time.monotonic()
    states = state_names(win)  # [] when the call failed: every window has some state
    try:
        name = (win.name or "").lower()
    except Exception:
        name = ""
    note_answer(pid, t0, bool(states))
    return name, states


def window_path(win):
    """The frame's object path: with the pid, it names one window for as long as it is open."""
    try:
        return win.path
    except Exception:
        return None


def describe_window(app, pid, win, budget=None):
    """The window for the client. Each answer is guarded: a busy app's window is described as far as it answers."""
    out = {"app": "", "pid": pid, "path": window_path(win), "name": "", "role": "", "active": False, "bounds": None}
    budget = budget or Budget()
    asks = (("active", lambda: "active" in state_names(win)), ("app", lambda: app.name or ""),
            ("name", lambda: win.name or ""), ("role", win.getRoleName), ("bounds", lambda: extents(win)))
    for key, ask in asks:
        try:
            out[key] = ask()
        except Exception:
            pass
        if budget.tick():
            break
    return out


def list_windows(params):
    new_request()
    out, asked = [], set()
    for app, pid, win in frames(until=time.monotonic() + FIND_BUDGET_S):
        asked.add(pid)
        _, states = window_facts(pid, win)
        if "showing" in states or "active" in states:
            out.append(describe_window(app, pid, win))
    for pid in asked - SLOW_NOW:
        remember_windows(pid, [w for w in out if w["pid"] == pid])
    # Apps that didn't answer this time (busy, or hung and skipped): their windows as last seen, marked busy.
    listed = set(w["pid"] for w in out)
    for pid in sorted(p for p in SLOW_NOW | SKIPPED_NOW if p not in listed and p in KNOWN):
        out.extend(dict(w, active=False, busy=True) for w in KNOWN[pid].values())
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


def find_window(params, until=None):
    """The window to read: by pid and path (exactly that window), by pid and/or title (see
    best_window), or with none of them, the active window. With a pid, only that app is asked
    first; other apps' windows can at most score 9."""
    pid = params.get("pid")
    title = (params.get("title") or "").lower()
    path = params.get("path")
    if pid is not None and path:
        # One particular window: that one, or none (never another window in its place).
        for app, apid, win in frames(only_pid=pid, until=until):
            if window_path(win) == path:
                return app, apid, win
        return None
    if pid is None and not title:
        for app, apid, win in frames(until=until):
            if "active" in window_facts(apid, win)[1]:
                return app, apid, win
        return None
    if pid is not None:
        best, score = best_window(frames(only_pid=pid, until=until), pid, title)
        if not title or score >= 10:
            return best
        other, other_score = best_window(frames(skip_pid=pid, until=until), pid, title)
        return other if other_score > score else best
    return best_window(frames(until=until), None, title)[0]


def never_looked(window, params):
    """Is this window on the user's never-look list (by app name or title, or by process, which Ember
    found by the window's X11 class)? Then it is not read at all."""
    if window["pid"] is not None and window["pid"] in (params.get("skipPids") or []):
        return True
    hay = ("%s %s" % (window["app"], window["name"])).lower()
    return any(t.strip() and t.strip().lower() in hay for t in params.get("neverLook") or [])


def other_windows(pid, win, budget):
    """The app's other windows the user is in or must answer first (an Open dialog over the main window)."""
    out = []
    path = window_path(win)
    for _app, apid, other in frames(only_pid=pid):
        if len(out) >= 5 or budget.tick():
            break
        if window_path(other) == path:
            continue
        states = state_names(other)
        if "showing" not in states or not ("active" in states or "modal" in states):
            continue
        try:
            out.append({"name": other.name or "", "role": other.getRoleName(), "active": "active" in states,
                        "modal": "modal" in states})
        except Exception:
            pass
    return out


def read_window(params):
    t0 = time.time()
    new_request()
    until = time.monotonic() + FIND_BUDGET_S
    found = find_window(params, until)
    if found is None:
        # A window that didn't answer in time is busy (a file dialog listing a big folder), not gone: so is
        # one that may be in an app skipped as hung, or that the look ran out of time before reaching.
        asked = params.get("pid")
        title = (params.get("title") or "").lower()
        busy = time.monotonic() > until or asked in SLOW_NOW \
            or any(might_have(p, title) for p in SLOW_NOW | SKIPPED_NOW if p != asked)
        return {"window": None, "nodes": [], "busy": bool(busy), "ms": int((time.time() - t0) * 1000)}
    app, pid, win = found
    budget = Budget(max(0.3, min(READ_BUDGET_S, READ_TOTAL_S - (time.time() - t0))))
    window = describe_window(app, pid, win, budget)
    if pid in SLOW_NOW:
        budget.busy = True
    elif not budget.busy and window["name"]:
        remember_windows(pid, [window], merge=True)
    if never_looked(window, params):
        return {"window": window, "nodes": [], "blocked": True, "ms": int((time.time() - t0) * 1000)}
    SNAPSHOTS.begin()
    nodes = []
    max_nodes = int(params.get("maxNodes", MAX_NODES))
    if not budget.busy:
        walk(win, 0, nodes, int(params.get("maxDepth", MAX_DEPTH)), max_nodes, None, None, budget)
        budget.check()  # the last element asked may have been the one that timed out
    latest = SNAPSHOTS.latest()
    redact_by_layout(nodes, lambda nid: latest.get(nid))
    others = [] if budget.busy or pid is None else other_windows(pid, win, Budget(0.3))
    if budget.busy and pid not in SLOW_NOW:
        timed_out(pid)
    keys = set(object_key(latest.get(n["id"])) for n in nodes if n.get("secret"))
    out = {
        "window": window,
        "nodes": nodes,
        "truncated": budget.cut or budget.over,
        "others": others,
        "secretKeys": [list(k) for k in keys if k is not None],
        "ms": int((time.time() - t0) * 1000),
    }
    if budget.busy:
        out["busy"] = True
    elif budget.over:
        out["slow"] = True
    return out


# ---------------------------------------------------------------- secret fields a read didn't reach

# A read cut short (the node limit, its time, a busy app) may not have reached every secret field, and a
# screenshot would show what they hold. Before one is taken, every field on screen is looked for, asking
# the rest of the window only what each element is and whether it shows; a web view's document is searched
# by the app itself (AT-SPI's Collection: one call, in GTK's and Chromium's bridges).
SCAN_BUDGET_S = 2.0
SCAN_NODES = 6000
SCAN_CHILDREN = 2000
DOCUMENT_ROLES = frozenset(["document web", "document frame"])


def collection_matches(acc, roles, limit=SCAN_NODES):
    """The showing elements with these roles under acc, found by the app itself; None when it can't."""
    if not native(acc):
        return None
    try:
        wanted = [getattr(Atspi.Role, r.upper().replace(" ", "_")) for r in sorted(roles)
                  if hasattr(Atspi.Role, r.upper().replace(" ", "_"))]
        rule = Atspi.MatchRule.new(Atspi.StateSet.new([Atspi.StateType.SHOWING]), Atspi.CollectionMatchType.ALL, {},
                                   Atspi.CollectionMatchType.ALL, wanted, Atspi.CollectionMatchType.ANY, [],
                                   Atspi.CollectionMatchType.ALL, False)
        return list(Atspi.Collection.get_matches(acc, rule, Atspi.CollectionSortOrder.CANONICAL, limit, True))
    except Exception:
        return None


def scan_fields(acc, depth, found, clip, budget, seen):
    """Collects (role, accessible) for the input fields and labels on screen under acc into found["fields"] and
    found["labels"]; web documents searched by the app go to found["docs"] (their labels are asked for later,
    if needed). Stops short (budget.busy, .over or .cut) rather than miss part of the window unsaid."""
    if depth > MAX_DEPTH or budget.tick():
        return
    seen[0] += 1
    if seen[0] > SCAN_NODES:
        budget.cut = True
        return
    states = state_names(acc)
    if "showing" not in states or "visible" not in states:
        return
    try:
        role = acc.getRoleName()
    except Exception:
        return
    if role in FIELD_ROLES:
        found["fields"].append((role, acc))
        return
    if role in LABEL_ROLES:
        found["labels"].append(acc)
        return
    if role in DOCUMENT_ROLES:
        t0 = time.monotonic()
        matches = collection_matches(acc, FIELD_ROLES)
        if matches is not None:
            budget.last = time.monotonic()  # one call for the whole document, not a timeout
            budget.cut = budget.cut or len(matches) >= SCAN_NODES
            found["fields"].extend((None, m) for m in matches)
            found["docs"].append(acc)
            return
        if time.monotonic() - t0 > SLOW_APP_S:
            budget.busy = True
            return
    if depth == 0 or role in CLIP_ROLES:
        clip = clip_to(clip, extents(acc))
    if budget.check():
        return
    try:
        count = acc.childCount
    except Exception:
        count = 0
    indices, left_out = child_indices(acc, count, clip, SCAN_CHILDREN)
    budget.cut = budget.cut or left_out
    long_list, misses = count > MAX_CHILDREN, 0
    for i in indices:
        if budget.busy or budget.over or budget.cut:
            return
        child = child_at(acc, i)
        if child is None:
            continue
        if long_list and not overlaps(extents(child), clip):
            # Rows scrolled away show nothing in the picture; a few of them in a row, and the rest are too.
            misses += 1
            if misses >= 3:
                return
            continue
        misses = 0
        scan_fields(child, depth + 1, found, clip, budget, seen)


def secret_fields(params):
    """Every secret field on screen in one window (`pid` and `path`), for blacking out in a screenshot after a
    read that was cut short: ids and bounds (as the app reports them). `complete` is false when the window
    couldn't be looked through in time: then nothing can be shown of it."""
    t0 = time.time()
    new_request()
    pid, path = params.get("pid"), params.get("path")
    win = None
    if pid is not None and path:
        for _app, _apid, w in frames(only_pid=pid, until=time.monotonic() + 1.0):
            if window_path(w) == path:
                win = w
                break
    if win is None:
        return {"fields": [], "complete": False, "busy": pid in SLOW_NOW, "ms": int((time.time() - t0) * 1000)}
    budget = Budget(SCAN_BUDGET_S)
    found = {"fields": [], "labels": [], "docs": []}
    scan_fields(win, 0, found, None, budget, [0])
    secret, plain = [], []
    for role, acc in found["fields"]:
        if budget.tick():
            break
        try:
            role = role or acc.getRoleName()
            name = (acc.name or "").strip()
        except Exception:
            continue
        b = extents(acc)
        if b is None or b["width"] <= 0 or b["height"] <= 0:
            continue
        node = {"role": role, "name": name, "bounds": b, "acc": acc}
        (secret if is_secret(acc, role, name) else plain).append(node)
    if any(not n["name"] for n in plain) and not (budget.busy or budget.over):
        labels = list(found["labels"])
        for doc in found["docs"]:
            labels.extend(collection_matches(doc, LABEL_ROLES) or [])
            budget.last = time.monotonic()
        named = []
        for acc in labels:
            if budget.tick():
                break
            try:
                name = (acc.name or "").strip()
            except Exception:
                continue
            b = extents(acc) if name else None
            if b:
                named.append({"name": name, "bounds": b})
        for n in secret_by_layout(plain, named, secret + plain):
            SECRETS.add(object_key(n["acc"]))
            secret.append(n)
    budget.check()
    if budget.busy and pid not in SLOW_NOW:
        timed_out(pid)
    keys = set(object_key(n["acc"]) for n in secret)
    return {
        "fields": [{"id": SNAPSHOTS.add(n["acc"]), "role": n["role"], "bounds": n["bounds"]} for n in secret],
        "complete": not (budget.busy or budget.over or budget.cut),
        "busy": budget.busy,
        "secretKeys": [list(k) for k in keys if k is not None],
        "ms": int((time.time() - t0) * 1000),
    }


def remember_secrets(params):
    """Secret fields an earlier helper process knew (Ember hands them over when it starts a new one)."""
    for key in params.get("keys") or []:
        if isinstance(key, list) and len(key) == 2:
            SECRETS.add((key[0], key[1]))
    return {"count": len(SECRETS.keys)}


def mark_secret(params):
    """Elements Ember found to hold secrets (a field beside a "Show password" toggle): nothing is typed into them."""
    keys = []
    for nid in params.get("ids") or []:
        try:
            key = object_key(SNAPSHOTS.get(int(nid)))
        except (KeyError, ValueError, TypeError):
            continue
        if key is not None:
            SECRETS.add(key)
            keys.append(list(key))
    return {"keys": keys}


# GNOME Shell draws its own dialogs (polkit, keyring, end session) and notifications inside its stage
# window: X11 doesn't see them as windows, but they are in every screenshot.
SHELL_ROLES = frozenset(["dialog", "alert", "notification", "file chooser"])
# They sit a few levels under the stage (its UI group, the modal dialog group or the message tray).
SHELL_DEPTH = 6
# The Activities overview and the window switcher show a picture of every window, never-look ones too. The
# overview's group of actors shows only then (Cally names an actor without an accessible name by its actor
# name), and while the shell has the keyboard (the switcher, a menu of the top bar) an actor under the stage
# has the focus.
SHELL_OVERVIEW = "overviewGroup"


def shell_overlays(params):
    """What GNOME Shell shows over the windows right now: its dialogs and notifications, with their
    text (for the password-prompt check), and "overview" while the overview or the window switcher may be
    up. Empty without GNOME Shell."""
    out = []
    desktop = pyatspi.Registry.getDesktop(0)
    try:
        napps = desktop.childCount
    except Exception:
        return {"overlays": out}
    budget = Budget(0.4)
    for a in range(napps):
        app = child_at(desktop, a)
        try:
            if app is None or (app.name or "") != "gnome-shell":
                continue
        except Exception:
            continue
        stack = [(app, 0)]
        seen, modal = 0, False
        while stack and seen < 400 and not budget.tick():
            acc, depth = stack.pop()
            seen += 1
            states = state_names(acc)
            if depth > 0 and ("showing" not in states or "visible" not in states):
                continue
            try:
                role = acc.getRoleName()
                name = acc.name or ""
            except Exception:
                continue
            if depth > 1 and not modal and ("focused" in states or name == SHELL_OVERVIEW):
                modal = True
                out.append({"role": "overview", "name": name[:200], "text": "", "bounds": None})
            if role in SHELL_ROLES:
                words = []
                shell_text(acc, words, 0)
                out.append({"role": role, "name": name[:200], "text": " ".join(words)[:400],
                            "bounds": extents(acc)})
                continue
            if depth < SHELL_DEPTH:
                try:
                    count = min(acc.childCount, 60)
                except Exception:
                    count = 0
                for i in range(count - 1, -1, -1):
                    child = child_at(acc, i)
                    if child is not None:
                        stack.append((child, depth + 1))
    return {"overlays": out}


def shell_text(acc, words, depth):
    """The names of what a shell dialog shows ("Authentication Required", "Password")."""
    if depth > 6 or len(words) > 20:
        return
    try:
        if acc.name:
            words.append(acc.name.strip())
        count = min(acc.childCount, 30)
    except Exception:
        return
    for i in range(count):
        child = child_at(acc, i)
        if child is not None:
            shell_text(child, words, depth + 1)


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


BUSY = "the app is busy (it didn't answer in time); try again in a moment"


class ElementGone(RuntimeError):
    """The element isn't there any more (its window closed or changed)."""


def unreachable(nid, err, t0):
    """Why an element couldn't be asked: its app didn't answer in time (busy), or the element is gone."""
    msg = str(err).lower()
    if time.monotonic() - t0 > SLOW_APP_S or "did not receive a reply" in msg or "timeout was reached" in msg:
        return RuntimeError(BUSY)
    return ElementGone("element %s is gone (the window changed); read the window again" % (nid if nid is not None else ""))


def node_info(acc, nid=None):
    """The element as it is now, for checking an action worked. Raises BUSY or ElementGone (never libatspi's own words)."""
    t0 = time.monotonic()
    states = state_names(acc)
    if "defunct" in states:
        raise ElementGone("element %s is gone (the window changed); read the window again" % (nid if nid is not None else ""))
    try:
        role = acc.getRoleName()
        name = (acc.name or "").strip()
    except Exception as err:
        raise unreachable(nid, err, t0)
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
    t0 = time.monotonic()
    states = state_names(acc)
    # No states after a timeout's wait: the app is busy, not the element gone.
    if not states and time.monotonic() - t0 > SLOW_APP_S:
        raise RuntimeError(BUSY)
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


def after_action(acc, nid):
    """The element after an action that worked. Gone is an answer, not an error: a Close, OK or Save button
    closes its own dialog. So is busy (the app is still at it)."""
    try:
        return {"after": node_info(acc, nid)}
    except ElementGone:
        return {"after": None, "gone": True}
    except RuntimeError as err:
        if str(err) == BUSY:
            return {"after": None, "busy": True}
        raise


def do_action(params):
    nid = int(params["id"])
    acc = usable(nid)
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
    before = node_info(acc, nid)
    ok = act.doAction(index)
    settle()
    res = after_action(acc, nid)
    res.update({"ok": bool(ok), "action": names[index], "before": before})
    return res


def set_text(params):
    nid = int(params["id"])
    acc = usable(nid)
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
    res = after_action(acc, nid)
    res["ok"] = bool(ok)
    return res


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


def option_index(names, want):
    """The option called `want`: its exact name, else the one name equal to it but for case. Never a part of
    a name: "permanently" is not "Delete permanently" (Ember decides on the option that will be chosen)."""
    want = want.strip()
    if not want:
        return None
    if want in names:
        return names.index(want)
    same = [i for i, n in enumerate(names) if n.lower() == want.lower()]
    return same[0] if len(set(names[i] for i in same)) == 1 else None


def select_option(params):
    nid = int(params["id"])
    acc = usable(nid)
    refuse_secret(acc)
    names = option_items(acc)
    index = option_index(names, str(params.get("option", "")))
    if index is None:
        # The options themselves are app text: they are listed with list_options, not in an error.
        raise ValueError("no option has exactly that name (it has %d options); list them and use one in full" % len(names))
    ok = acc.querySelection().selectChild(index)
    settle()
    res = after_action(acc, nid)
    res.update({"ok": bool(ok), "option": names[index]})
    return res


def list_options(params):
    acc = SNAPSHOTS.get(int(params["id"]))
    return {"options": option_items(acc)}


def focus(params):
    acc = usable(int(params["id"]))
    ok = acc.queryComponent().grabFocus()
    settle()
    return {"ok": bool(ok), "after": node_info(acc)}


def read_element(params):
    nid = int(params["id"])
    return node_info(SNAPSHOTS.get(nid), nid)


METHODS = {
    "ping": lambda p: {"version": VERSION},
    "status": status,
    "list_windows": list_windows,
    "read_window": read_window,
    "remember_secrets": remember_secrets,
    "mark_secret": mark_secret,
    "shell_overlays": shell_overlays,
    "secret_fields": secret_fields,
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
