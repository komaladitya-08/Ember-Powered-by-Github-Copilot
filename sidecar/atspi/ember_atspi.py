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
# Deep enough for web pages (Firefox lists every <div> as a section; a card field can sit 40 levels down) and
# GTK 3.22's gedit, whose text view sits 15 levels down under fillers and panels. A read that finds something
# showing deeper than this says it is incomplete.
MAX_DEPTH = 64
MAX_NODES = 400
MAX_CHILDREN = 200
# Children of a long list that show after the ones that don't (a web page's fixed panel), read per list at most.
STRAGGLERS = 16

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
# Meanwhile a list or a look by title asks it once more every so often (one call that times out, at most),
# so an app that answers again is back in the list within seconds.
REPROBE_S = 4.0
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
# Text blocks that say what they hold only as text when they have no name: LibreOffice Writer's headings and quotations
# (a web page's headings are named after what they say, and not asked again).
UNNAMED_TEXT_ROLES = frozenset(["heading", "block quote"])
# What stands in a text for an element inside it (Chromium's drop-down says U+FFFC for its option): no text of its own.
OBJECT_CHAR = "\ufffc"
VALUE_ROLES = frozenset(["slider", "spin button", "scroll bar", "progress bar", "level bar", "dial"])
# Input fields, whose name or label can make their contents secret (documents and terminals are not judged
# by name). Keep in step with FIELD_ROLES in elements.ts.
FIELD_ROLES = frozenset(["text", "entry", "password text", "spin button", "combo box"])
# Text that labels a control: GTK's and Qt's labels, Chromium's plain text. Keep in step with LABEL_ROLES in elements.ts.
LABEL_ROLES = frozenset(["label", "static", "caption"])
# A spreadsheet's cell is named by its address ("B7": LibreOffice Calc) and keeps what it holds as its text.
# Keep in step with CELL_ADDRESS in elements.ts.
CELL_ADDRESS = re.compile(r"^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}$")
# A spreadsheet's cells on screen (see grid_of) are read row by row: at most this many listed per read (on top of
# MAX_NODES), for at most GRID_BUDGET_S (or half the time the read has left). Past either, the read is cut short.
GRID_CELLS = 400
GRID_BUDGET_S = 0.6
# The cell with the keyboard, when that look didn't come to it, is looked for on its own after the rest of the window
# (see cursor_cell): for this long at most, where it was last found first.
CURSOR_SCAN_S = 1.0

# Labels of fields whose contents never leave this process (passwords, payment and bank details,
# one-time codes, keys), in the languages Ember's users are likely to meet. The same lists as
# SECRET_WORDS and SECRET_ANYWHERE in app/main/perception/elements.ts (a unit test checks): each entry
# is a regular expression both engines read alike, matched on lowercase, NFKC-normalised text, as whole words
# (English ones in the plural too: "Recovery codes").
SECRET_WORDS = [
    # Passwords and PINs. Words that mean something else too stand alone or in a phrase that says password
    # ("Palabras clave" are keywords, a "Parola chiave" a keyword).
    "pass(word|phrase|code|wd)s?", "passwort", "kennwort", "passord", "wachtwoord", "mot de passe", "contrase(n|ñ)a",
    "contrasenya", "senha", "palavra-passe", r"^[\s:*]*parol(a|ă)[\s:*]*$", "parolă", "parola d['’]ordine",
    "parola (nou(a|ă)|actual(a|ă)|curent(a|ă)|veche|contului)", "(confirm(a|ă)|introduce(ți|ti)|schimb(a|ă)) parola",
    "(yeni|mevcut|eski) parola", "parola(nız|yı|nızı)", "парола", r"^[\s:*]*clave[\s:*]*$",
    "clave (de acceso|secreta|personal|bancaria|de seguridad|de (la )?tarjeta)", "(tu|su) clave", "lösenord", "adgangskode",
    "salasana", "hasło", "heslo", "geslo", "lozinka", "jelszó", "(ş|s)ifre", "κωδικός", "пароль", "лозинка", "kata sandi",
    "mật khẩu", "كلمة (المرور|السر)", "pin( ?code)?s?",
    # Cards and bank accounts. An expiry date only beside a card ("Expiration date of the report" is not one).
    "card ?(number|no)s?", "credit ?cards?", "cvv2?", "cvc2?", "csc", "security codes?", "card verification",
    "card (expir(y|ation)|exp)", "mm ?/ ?(yy|aa|jj){1,2}", "valid (thru|through)", "kartennummer", "kreditkarte(nnummer)?",
    "prüfziffer", "prüfnummer", "sicherheitscode", "ablaufdatum der karte", "num(é|e)ro de (la )?carte", "cryptogramme",
    "date d['’]expiration de (la )?carte", "n(ú|u)mero de (la )?tarjeta", "n(ú|u)mero do cart(ã|a)o", "numero (di|della) carta",
    "kaartnummer", "kortnummer", "numer karty", "номер карты",
    "c(ó|o)digo de (seguridad|segurança|verificaci(ó|o)n|verificação|acceso|confirmaci(ó|o)n)",
    "codice di (sicurezza|verifica)", "(fecha de )?(caducidad|vencimiento|expiraci(ó|o)n) de (la )?tarjeta", "ibans?",
    "routing numbers?", "account numbers?", "sort codes?", "kontonummer",
    # One-time codes.
    "one[- ]time (code|password|pin)s?", "otps?", "2fa", "two[- ]factor", "totp", "verification codes?", "auth(entication)? codes?",
    "recovery (code|key)s?", "backup codes?", "bestätigungscode", "code de (vérification|sécurité|confirmation)", "verificatiecode", "kod weryfikacyjny",
    "код (подтверждения|безопасности)",
    # Keys, network passwords and secret answers.
    "secrets?", "private keys?", "(api|access|auth|bearer) ?(key|token)s?", "wi-?fi (key|password|passphrase)s?", "network (security )?keys?",
    "wpa2? ?(key|passphrase)s?", "pre-?shared keys?", "psk", "encryption keys?", "security (answer|question)s?", "secret (answer|question)s?",
    "ssns?", "social security",
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


def cell_text(acc, limit=200):
    """What a table cell holds (None: it has no text). A real one in one call for all of it: LibreOffice answers
    nothing for a range that runs past the end of the text, and a spreadsheet has hundreds of cells to ask."""
    if not native(acc):
        return text_of(acc, limit)
    try:
        return (Atspi.Text.get_text(acc, 0, -1) or "")[:limit]
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
    A quick look (`keep=False`: what has the keyboard before a key is pressed) goes in a
    scratch read of its own that the next quick look replaces, so looks never push the
    reads a worker acts on out of the kept ones.
    """

    KEEP = 8

    def __init__(self, start=None):
        self.reads = []  # list of dicts id -> accessible, oldest first
        self.scratch = {}
        self.current = None  # the read ids go to now
        self.next_id = first_id() if start is None else start

    def begin(self, keep=True):
        if keep:
            self.reads.append({})
            if len(self.reads) > self.KEEP:
                self.reads.pop(0)
            self.current = self.reads[-1]
        else:
            self.scratch = {}
            self.current = self.scratch

    def end(self):
        """After a quick look: ids added later (secret fields for a screenshot) go to the newest kept read."""
        self.current = self.reads[-1] if self.reads else None

    def add(self, acc, place=None):
        """A new id for acc. `place`: (sheet, row, column) of a spreadsheet's cell, which is found there again
        (see SheetCell)."""
        nid = self.next_id
        self.next_id += 1
        if self.current is None:
            self.begin()
        self.current[nid] = acc if place is None else SheetCell(acc, *place)
        return nid

    def get(self, nid):
        for read in reversed(self.reads):
            if nid in read:
                return live(read[nid])
        if nid in self.scratch:
            return live(self.scratch[nid])
        raise KeyError("element %s is no longer known; read the window again" % nid)

    def latest(self):
        """The ids of the read going on now, and what each was given for (see stored)."""
        return self.current if self.current is not None else {}


class SheetCell(object):
    """A spreadsheet's cell as a read found it: the accessible, and its sheet and place. LibreOffice Calc makes a cell's
    accessible when it is asked for and the accessibility bridge drops it 15 s later (its sheet lasts): the cell is
    asked of its sheet again whenever its id is used (see live)."""

    __slots__ = ("acc", "table", "row", "col")

    def __init__(self, acc, table, row, col):
        self.acc, self.table, self.row, self.col = acc, table, row, col


def stored(entry):
    """The accessible an id was given for, as it was given (not asked for again)."""
    return entry.acc if isinstance(entry, SheetCell) else entry


def live(entry):
    """The accessible behind an id: a spreadsheet's cell is asked of its sheet again (one call; see SheetCell), the one
    from the read where that fails (a sheet that closed: it is gone too)."""
    if not isinstance(entry, SheetCell):
        return entry
    cell = table_cell_at(entry.table, entry.row, entry.col)
    if cell is not None:
        entry.acc = cell
    return entry.acc


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
            if txt and txt.strip(OBJECT_CHAR):
                node["text"] = txt
            if "focused" in states:
                sel = selection_of(acc)
                if sel:
                    node["selection"] = sel
            if role == "combo box":
                chosen = chosen_option(acc)
                if chosen:
                    node["selected"] = chosen
    elif role in UNNAMED_TEXT_ROLES and not name and not web_engine(acc):
        # A heading or quotation in LibreOffice Writer: what it says is its text only (a web page's quotation holds
        # its text in elements of its own, read as they are).
        secret = is_secret(acc, role, name)
        txt = None if secret else text_of(acc)
        if txt and txt.strip(OBJECT_CHAR):
            node["text"] = txt
        sel = selection_of(acc) if txt and "focused" in states else None
        if sel:
            node["selection"] = sel
    elif role == "table cell" and CELL_ADDRESS.match(name):
        # Named by its address ("B7"), its text what it holds; not a spreadsheet's (those are read by walk_grid): a
        # LibreOffice Writer table's cell, say, whose text is in its paragraphs.
        node["grid"] = False
        secret = is_secret(acc, role, name)
        if secret:
            node["secret"] = True
        else:
            txt = cell_text(acc)
            if txt:
                node["text"] = txt
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


def above(acc, i, top):
    """Does child i lie wholly above `top` (scrolled out of view upwards)? None when it has no size: LibreOffice
    Calc puts the cells scrolled away, above and below the view alike, at its table's corner, sized 0x0."""
    child = child_at(acc, i)
    b = extents(child) if child is not None else None
    if b is not None and b["width"] <= 0 and b["height"] <= 0:
        return None
    return b is not None and b["y"] + b["height"] <= top


def ends_above(acc, i, top):
    """Does child i lie wholly above `top`, as far as can be told?"""
    return above(acc, i, top) is True


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


def in_view(b, clip):
    """Can rectangle b show anything inside `clip`? Not without a size: LibreOffice Calc puts the cells scrolled
    away at its table's corner, sized 0x0 (and a field without a size shows no pixels). Yes without a position."""
    return (b is None or (b["width"] > 0 and b["height"] > 0)) and overlaps(b, clip)


def on_screen(acc, i, clip):
    """Is child i showing, and inside `clip` (when both have a position)?"""
    child = child_at(acc, i)
    states = state_names(child) if child is not None else []
    return "showing" in states and "visible" in states and overlaps(extents(child), clip)


def child_indices(acc, count, clip, cap=MAX_CHILDREN):
    """Which children to read (at most `cap`), whether some on screen had to be left out, and whether they
    are a run of children taken to be laid out in order (see showing_after).
    Long lists and tables (thousands of rows) are read from the first row on screen, not from
    the top: rows are laid out top to bottom, so a binary search finds where the visible ones
    start. Leading children on screen (column headers) are kept. Children without a size say nothing about
    where the rows are: where the search meets only those, it stops, and some on screen may be left out."""
    if count <= MAX_CHILDREN:
        return list(range(count)), False, False
    in_table = table_indices(acc, count)
    if in_table is not None:
        return in_table[:cap], len(in_table) > cap, False
    if clip is None:
        return list(range(min(count, cap))), cap < count and on_screen(acc, cap, clip), True
    top = clip["y"]
    lead = 0
    while lead < min(count, 16) and not ends_above(acc, lead, top) and "showing" in state_names(child_at(acc, lead)):
        lead += 1
    lo, hi, unsure = lead, count - 1, False
    while lo < hi:
        mid = (lo + hi) // 2
        # One without a size (an empty element) may sit beside ones with a size: the next few are asked too.
        side, probe = None, mid
        while side is None and probe <= min(hi, mid + 3):
            side = above(acc, probe, top)
            probe += 1
        if side is None:
            unsure = True
            break
        if side:
            lo = probe
        else:
            hi = mid
    end = min(count, lo + cap - lead)
    return list(range(lead)) + list(range(lo, end)), unsure or (end < count and on_screen(acc, end, clip)), True


def table_cell_at(table, row, col):
    """The cell of `table` at (row, col), or None."""
    try:
        if native(table):
            return Atspi.Table.get_accessible_at(table, row, col)
        return table.queryTable().getAccessibleAt(row, col)
    except Exception:
        return None


def accessible_at_point(acc, x, y):
    """The child of acc the app finds at screen point (x, y), or None."""
    try:
        if native(acc):
            return Atspi.Component.get_accessible_at_point(acc, x, y, Atspi.CoordType.SCREEN)
        return acc.queryComponent().getAccessibleAtPoint(x, y, pyatspi.DESKTOP_COORDS)
    except Exception:
        return None


def cell_position(table, cell):
    """(row, column) of a cell of `table`, or None. LibreOffice Calc's cells say so themselves (their index in the
    table stops at 2^31, a sheet's row 131072)."""
    if native(cell):
        try:
            pos = Atspi.TableCell.get_position(cell)
            if pos[1] >= 0 and pos[2] >= 0:
                return pos[1], pos[2]
        except Exception:
            pass
    try:
        t = table.queryTable()
        i = cell.getIndexInParent()
        row, col = t.getRowAtIndex(i), t.getColumnAtIndex(i)
    except Exception:
        return None
    return (row, col) if i >= 0 and row >= 0 and col >= 0 else None


def grid_of(acc, count, states, clip):
    """A spreadsheet (LibreOffice Calc): a table that makes its cells as they are asked for ("manages descendants",
    2^31 children), with no scroll bar beside it, that puts the cells scrolled away, above and below the view alike,
    at its corner with no size: the order of its children says nothing about what shows. Returns its first and
    last row and column on screen, from the cells the app finds at the corners of the part of it that shows,
    and how many children come before its cells (column headers), as (first row, last row, first column, last
    column, headers); None for any other list (a web page's table is read by its rows, which have their places)."""
    if count <= MAX_CHILDREN or "manages descendants" not in states or web_engine(acc) or scroll_fraction(acc) is not None:
        return None
    view = clip_to(clip, extents(acc))
    if view is None or view["width"] <= 0 or view["height"] <= 0:
        return None
    left, top = view["x"] + 1, view["y"] + 1
    right, bottom = max(left, view["x"] + view["width"] - 2), max(top, view["y"] + view["height"] - 2)
    corners = []
    for x, y in ((left, top), (right, bottom)):
        cell = accessible_at_point(acc, x, y)
        pos = cell_position(acc, cell) if cell is not None else None
        if pos is None:
            return None
        corners.append(pos)
    (row0, col0), (row1, col1) = corners
    if row1 < row0 or col1 < col0:
        return None
    try:
        heads = max(0, min(acc.queryTable().getIndexAt(0, 0), 16))
    except Exception:
        heads = 0
    return row0, row1, col0, col1, heads


def grid_cells(acc, grid, budget, cap, until=None):
    """The cells of a spreadsheet's rows and columns on screen (see grid_of), row by row, as (row, column, cell):
    `cap` at most, until `until` (time.monotonic()) at most, when budget.cut notes the rest was left out; and none once
    the read should stop (see Budget.tick)."""
    row0, row1, col0, col1, _ = grid
    asked = 0
    for row in range(row0, row1 + 1):
        for col in range(col0, col1 + 1):
            if asked >= cap or (until is not None and time.monotonic() > until):
                budget.cut_short("nodes")
                return
            if budget.tick():
                return
            asked += 1
            cell = table_cell_at(acc, row, col)
            if cell is not None:
                yield row, col, cell


def next_place(grid, row, col):
    """The cell after (row, col) on screen, row by row (see grid_of); past the last, the first of the row below."""
    return (row, col + 1) if col < grid[3] else (row + 1, grid[2])


def cell_node(table, row, col, cell, name, text, states, editable, depth, parent_id, clip, anywhere=False):
    """What the model is told about a spreadsheet's cell (role "table cell", `name` its address) at (row, col) of
    `table`, `grid` marking it as one, with an id that finds it there again (see SheetCell); None when it shows
    nothing inside `clip`, unless `anywhere` (it has the keyboard: listed without a place). `editable`: whether the
    sheet's cells take text."""
    bounds = extents(cell)
    if not in_view(bounds, clip):
        if not anywhere:
            return None
        bounds = None
    node = {"role": "table cell", "name": name[:200], "states": [s for s in states if s in INTERESTING_STATES],
            "bounds": bounds, "grid": True}
    if is_secret(cell, "table cell", name):
        node["secret"] = True
    elif text and (text != name or CELL_ADDRESS.match(name)):
        node["text"] = text
    if editable and "editable" in states:
        node["editable"] = True
    node["id"] = SNAPSHOTS.add(cell, (table, row, col))
    node["parent"] = parent_id
    node["depth"] = depth
    shown = clip_to(clip, bounds) if clip is not None and bounds is not None else None
    if shown is not None and shown != bounds:
        node["shown"] = shown
    return node


def walk_grid(acc, grid, depth, out, max_depth, max_nodes, parent_id, clip, budget, focused=False):
    """Reads a spreadsheet's cells on screen (see grid_of) into `out`, as children of acc (`depth`, `parent_id`):
    those that hold something, and those focused or selected (hundreds of empty cells say nothing), GRID_CELLS at
    most in a read, for GRID_BUDGET_S at most (or half the time the read has left). A cell is asked what it holds
    first: one call, where its name, states and place take three more. `focused`: the sheet has the keyboard; when
    its cell with the keyboard isn't among those read, budget.sheets notes where to look for it (see cursor_cell)."""
    for i in range(grid[4]):
        # Column headers before the cells (GTK's tree view).
        child = child_at(acc, i)
        if child is not None:
            walk(child, depth, out, max_depth, max_nodes, parent_id, clip, budget)
        if budget.busy or budget.over:
            return
    now = time.monotonic()
    until = min(now + GRID_BUDGET_S, now + max(0.0, budget.until - now) / 2.0)
    editable = None
    start = (grid[0], grid[2])  # the first cell not looked at yet
    for row, col, cell in grid_cells(acc, grid, budget, 1 << 30, until):
        text = cell_text(cell)
        states = state_names(cell)
        if (text != "" or "focused" in states or "selected" in states) and "showing" in states and "visible" in states:
            if budget.grid >= GRID_CELLS:
                budget.cut_short("nodes")
                break
            try:
                role, name = cell.getRoleName(), (cell.name or "").strip()
            except Exception:
                role = None
            if role == "table cell":
                if editable is None and "editable" in states:
                    editable = is_editable(cell, states)  # the same for every cell
                node = cell_node(acc, row, col, cell, name, text, states, editable, depth, parent_id, clip)
                if node is not None:
                    out.append(node)
                    budget.grid += 1
                    if "focused" in states:
                        note_cursor(acc, row, col)
                        focused = False  # found
            elif role is not None:
                # Something else in the grid: read as any element is (what it holds, whether it is secret).
                walk(cell, depth, out, max_depth, max_nodes, parent_id, clip, budget)
                if budget.busy or budget.over:
                    return
        start = next_place(grid, row, col)
    if focused and not budget.busy:
        budget.sheets.append({"table": acc, "grid": grid, "start": start, "at": len(out), "depth": depth,
                              "parent": parent_id, "clip": clip})


# Where each spreadsheet's cell with the keyboard was last found (the sheet's object_key -> (row, column)).
CURSORS = OrderedDict()
CURSORS_KEEP = 64


def note_cursor(table, row, col):
    key = object_key(table)
    if key is None:
        return
    CURSORS.pop(key, None)
    CURSORS[key] = (row, col)
    while len(CURSORS) > CURSORS_KEEP:
        CURSORS.popitem(last=False)


def cursor_cell(table, grid, start, until):
    """The cell of spreadsheet `table` (see grid_of) that has the keyboard, as (row, column, cell, states), or None.
    No cell says so to anything but its states (the sheet's Selection is empty without a range selected, and Calc's
    Name Box is out of reach of accessibility), so cells are asked: where it was last found and around it first (a key
    moves it a cell), then those on screen from `start` (row, column) on, row by row (the ones before were looked at),
    until `until` (time.monotonic()), two calls a cell. None too once the app takes a timeout's time to answer."""
    near = []
    last = CURSORS.get(object_key(table))
    if last is not None:
        r, c = last
        near = [(r, c), (r + 1, c), (r, c + 1), (r - 1, c), (r, c - 1), (r + 1, grid[2])]
    tried = set()

    def ask(r, c):
        """(row, column, cell, states) when that cell has the keyboard; False to stop looking; None to go on."""
        if time.monotonic() > until:
            return False
        t0 = time.monotonic()
        cell = table_cell_at(table, r, c)
        states = state_names(cell) if cell is not None else []
        if time.monotonic() - t0 > SLOW_APP_S:
            return False
        if "focused" not in states:
            return None
        note_cursor(table, r, c)
        return r, c, cell, states

    for r, c in near:
        if r >= 0 and c >= 0 and (r, c) not in tried:
            tried.add((r, c))
            found = ask(r, c)
            if found is not None:
                return found or None
    r, c = start
    while r <= grid[1]:
        if (r, c) not in tried:
            found = ask(r, c)
            if found is not None:
                return found or None
        r, c = next_place(grid, r, c)
    return None


def add_cursors(nodes, sheets, until):
    """The cell with the keyboard of each spreadsheet in `sheets` (noted by walk_grid: a read that didn't come to it),
    put in `nodes` after the sheet's other cells: wherever it is (scrolled away too: keys go there), as long as it is
    found before `until` (see cursor_cell)."""
    for s in reversed(sheets):  # from the last, so the places noted for the others stay right
        found = cursor_cell(s["table"], s["grid"], s["start"], until)
        if found is None:
            continue
        row, col, cell, states = found
        try:
            name = (cell.name or "").strip()
        except Exception:
            continue
        node = cell_node(s["table"], row, col, cell, name, cell_text(cell), states, is_editable(cell, states),
                         s["depth"], s["parent"], s["clip"], anywhere=True)
        nodes.insert(s["at"], node)


def showing_rule():
    return Atspi.MatchRule.new(Atspi.StateSet.new([Atspi.StateType.SHOWING, Atspi.StateType.VISIBLE]),
                               Atspi.CollectionMatchType.ALL, {}, Atspi.CollectionMatchType.ALL, [],
                               Atspi.CollectionMatchType.ALL, [], Atspi.CollectionMatchType.ALL, False)


# Toolkits whose apps answer AT-SPI's Collection (the app searching its own tree) from objects that last: the web
# engines (Chromium, so Electron apps too, and Firefox's Gecko). Elsewhere the accessibility bridge answers it from
# objects the app makes on demand and drops again: one such search over LibreOffice Calc's cells makes Calc abort
# (unsaved work lost). There, only the end of a long list is looked at (see showing_after).
WEB_TOOLKITS = frozenset(["chromium", "gecko"])


def web_engine(acc):
    """Is acc in a web engine's tree (see WEB_TOOLKITS)? libatspi asks each app for its toolkit once."""
    if not native(acc):
        return False
    try:
        return (Atspi.Accessible.get_toolkit_name(acc) or "").lower() in WEB_TOOLKITS
    except Exception:
        return False


def showing_after(acc, child, index, count, budget, limit=STRAGGLERS):
    """The children of a long list after child `index` (`child`) that show although the ones just before them
    don't: laid out out of order, like a web page's fixed "Pay now" panel last in its document. A web engine
    finds them in one call (AT-SPI's Collection); elsewhere (see WEB_TOOLKITS), or when that fails, the last few
    children are looked at. Returns (those children, whether they are all of them)."""
    if web_engine(acc):
        try:
            found = list(Atspi.Collection.get_matches_from(
                acc, child, showing_rule(), Atspi.CollectionSortOrder.CANONICAL,
                Atspi.CollectionTreeTraversalType.RESTRICT_SIBLING, limit + 1, False))
            budget.last = time.monotonic()  # one call for all of them, not a timeout
            return found[:limit], len(found) <= limit
        except Exception:
            pass
    if budget.check():
        return [], False
    tail = [c for c in (child_at(acc, i) for i in range(max(index + 1, count - 3), count)) if c is not None]
    shows = [c for c in tail if "showing" in state_names(c)]
    # One showing out of order, and the children between may too.
    return shows, not shows or count - index - 1 <= len(tail)


# Containers whose extents bound what their children show: scrolled lists stop at their edges.
CLIP_ROLES = frozenset(["scroll pane", "viewport"])


class Budget(object):
    """The time one read may take. Between two ticks the app is asked only a few things, so a gap
    longer than SLOW_APP_S was a call that timed out: the app is busy (or hung), and asking it more
    would only time out again. Either way the read stops where it is. `cut` notes elements on screen left
    out for want of room rather than time, and `why` says which room: "nodes" (the node limit, a long list's
    row limit) or "depth" (nested deeper than a read goes). `grid`: the spreadsheet cells read (see walk_grid),
    which have their own limit and leave the node limit to the rest of the window; `sheets`: the spreadsheets whose
    cell with the keyboard is still to be looked for (see add_cursors)."""

    def __init__(self, seconds=READ_BUDGET_S):
        self.last = time.monotonic()
        self.until = self.last + seconds
        self.busy = False
        self.over = False
        self.cut = False
        self.why = []
        self.grid = 0
        self.sheets = []

    def cut_short(self, why):
        self.cut = True
        if why not in self.why:
            self.why.append(why)

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


def shows(acc, states, in_pane=False):
    """Is acc on screen, by its states (`in_pane`: a child of a scroll pane)? GTK 3 judges a GtkViewport's SHOWING
    against the viewport's own scroll position (gtk_widget_accessible_on_screen takes the viewport itself as the
    one to test against), so a page scrolled more than a screen down says its viewport doesn't show while the
    rows in it do, at their right places. Such a viewport (VISIBLE, in a scroll pane) is looked into: what it
    holds says for itself whether it shows (a hidden page's rows don't), at the cost of a look at its child."""
    if "visible" not in states:
        return False
    if "showing" in states:
        return True
    if not in_pane:
        return False
    try:
        return acc.getRoleName() == "viewport"
    except Exception:
        return False


def walk(acc, depth, out, max_depth, max_nodes, parent_id, clip=None, budget=None, in_pane=False):
    """Reports acc and what it contains, depth first. Returns whether acc is on screen."""
    budget = budget or Budget()
    if len(out) - budget.grid >= max_nodes:
        budget.cut_short("nodes")
        return False
    if budget.tick():
        return False
    states = state_names(acc)
    if not shows(acc, states, in_pane):
        # Invisible elements are a known prompt-injection channel; never report them.
        return False
    # A viewport GTK misjudged (see shows): not listed itself, and on screen only if something in it is.
    judged = "showing" in states
    if depth > max_depth:
        # It shows, but is nested deeper than a read goes: the read says it is incomplete.
        budget.cut_short("depth")
        return True
    try:
        role = acc.getRoleName()
        name = (acc.name or "").strip()
    except Exception:
        return False
    my_id = parent_id
    listed = judged and (role not in SKIP_ROLES or bool(name))
    bounds = extents(acc) if listed or depth == 0 or role in CLIP_ROLES else None
    secret = False
    if listed and (bounds is None or (bounds["width"] > 0 and bounds["height"] > 0)):
        node = node_of(acc, role, name, states, bounds)
        node["id"] = SNAPSHOTS.add(acc)
        node["parent"] = parent_id
        node["depth"] = depth
        shown = clip_to(clip, bounds) if clip is not None and bounds is not None else None
        if shown is not None and shown != bounds:
            # Partly scrolled out of its list, or outside its window: the part that shows (a mark goes there).
            node["shown"] = shown
        out.append(node)
        my_id = node["id"]
        secret = node.get("secret", False)
    elif judged and role in TEXT_ROLES:
        secret = is_secret(acc, role, name)
    if secret:
        # What a secret field holds is its contents too: Chromium lists a text box's text as static text in it.
        return True
    if depth == 0 or role in CLIP_ROLES:
        clip = clip_to(clip, bounds)
    if budget.check():
        return True
    try:
        count = acc.childCount
    except Exception:
        count = 0
    long_list = count > MAX_CHILDREN
    grid = grid_of(acc, count, states, clip) if long_list else None
    if grid is not None:
        # A spreadsheet: its cells on screen, by row and column.
        walk_grid(acc, grid, depth + 1, out, max_depth, max_nodes, my_id, clip, budget, "focused" in states)
        return judged
    indices, left_out, ordered = child_indices(acc, count, clip)
    shown, misses, last = False, 0, None
    for i in indices:
        if len(out) - budget.grid >= max_nodes:
            budget.cut_short("nodes")
            return True
        if budget.tick():
            return True
        child = child_at(acc, i)
        if child is None:
            continue
        last = (i, child)
        on_screen_now = walk(child, depth + 1, out, max_depth, max_nodes, my_id, clip, budget, role == "scroll pane")
        if budget.busy or budget.over:
            return True
        judged = judged or on_screen_now
        if long_list:
            # Past the rows on screen: the rest of a long list is scrolled away too.
            shown, misses = (True, 0) if on_screen_now else (shown, misses + 1 if shown else 0)
            if misses >= 3:
                break
    if left_out:
        # More of a long list is on screen than one read takes.
        budget.cut_short("nodes")
    elif long_list and ordered and last is not None and last[0] < count - 1:
        # The rest was taken to be scrolled away; what of it shows all the same is read too.
        rest, complete = showing_after(acc, last[1], last[0], count, budget)
        if not complete:
            budget.cut_short("nodes")
        for child in rest:
            if len(out) - budget.grid >= max_nodes:
                budget.cut_short("nodes")
                return True
            if budget.tick():
                return True
            walk(child, depth + 1, out, max_depth, max_nodes, my_id, clip, budget)
            if budget.busy or budget.over:
                return True
    return judged


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
        for k in ("text", "selection", "value", "selected"):
            n.pop(k, None)
        n["secret"] = True
        SECRETS.add(object_key(accessible_of(n["id"])))


def inside_secrets(nodes):
    """Ids of the nodes inside a secret field (its contents: Chromium lists a text box's text as static text in
    it). walk doesn't go into the fields it knows are secret; these are in fields found secret after it."""
    secret = set(n["id"] for n in nodes if n.get("secret"))
    inside = set()
    for n in nodes:  # parents come before their children
        if n["parent"] in secret or n["parent"] in inside:
            inside.add(n["id"])
    return inside


# ---------------------------------------------------------------- windows

HUNG = {}  # pid -> time.monotonic() until which the app is skipped
PROBED = {}  # hung pid -> time.monotonic() it was last asked (or marked hung)
STRIKES = {}  # pid -> (timeouts in a row, time.monotonic() of the last one counted)
SLOW_NOW = set()  # apps that timed out during the current request: not asked again before the next one
SKIPPED_NOW = set()  # hung apps the current request left out
OWN_NOW = set()  # Ember's own process (a request's "ownPid"): its windows are never found, listed or read
# The windows each app showed when it last answered (pid -> OrderedDict of path -> window): a busy or hung
# app's windows are still listed (as busy), not dropped as if they had closed.
KNOWN = OrderedDict()
KNOWN_APPS = 200
KNOWN_WINDOWS = 20


def new_request(params=None):
    SLOW_NOW.clear()
    SKIPPED_NOW.clear()
    OWN_NOW.clear()
    own = (params or {}).get("ownPid")
    if isinstance(own, int):
        OWN_NOW.add(own)


def is_hung(pid):
    until = HUNG.get(pid)
    if until is None:
        return False
    if time.monotonic() >= until:
        del HUNG[pid]
        PROBED.pop(pid, None)
        return False
    return True


def reprobe(pid):
    """Is it time to ask this hung app again (see REPROBE_S)? Then it counts as asked."""
    now = time.monotonic()
    if now - PROBED.get(pid, now) < REPROBE_S:
        return False
    PROBED[pid] = now
    return True


def mark_hung(pid):
    if pid is not None:
        now = time.monotonic()
        HUNG[pid] = now + HUNG_FOR_S
        PROBED[pid] = now


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
    PROBED.pop(pid, None)


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
    asked for its windows; hung apps (see timed_out) are skipped for a while unless asked for, or due to be
    asked again (see reprobe). Past `until` (time.monotonic()), busy apps took the time already: the rest wait
    for the next request. Ember's own windows (see OWN_NOW) are never among them."""
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
        if pid in SLOW_NOW or pid in OWN_NOW:
            continue
        if only_pid is None and is_hung(pid) and not reprobe(pid):
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
    new_request(params)
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
    new_request(params)
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
    # keep=False: a quick look whose ids aren't acted on (Snapshots), so it doesn't push out the kept reads.
    SNAPSHOTS.begin(params.get("keep", True) is not False)
    nodes = []
    max_nodes = int(params.get("maxNodes", MAX_NODES))
    if not budget.busy:
        walk(win, 0, nodes, int(params.get("maxDepth", MAX_DEPTH)), max_nodes, None, None, budget)
        budget.check()  # the last element asked may have been the one that timed out
    if budget.sheets and not budget.busy:
        # A spreadsheet's cell with the keyboard that the look at its cells didn't come to (keys go there).
        add_cursors(nodes, budget.sheets, time.monotonic() + min(CURSOR_SCAN_S, max(0.3, READ_TOTAL_S - (time.time() - t0))))
    latest = SNAPSHOTS.latest()
    redact_by_layout(nodes, lambda nid: stored(latest.get(nid)))
    inside = inside_secrets(nodes)
    if inside:
        nodes = [n for n in nodes if n["id"] not in inside]
        for nid in inside:
            latest.pop(nid, None)  # nor are they read by id
    others = [] if budget.busy or pid is None else other_windows(pid, win, Budget(0.3))
    if budget.busy and pid not in SLOW_NOW:
        timed_out(pid)
    keys = set(object_key(stored(latest.get(n["id"]))) for n in nodes if n.get("secret"))
    out = {
        "window": window,
        "nodes": nodes,
        "truncated": budget.cut or budget.over,
        "cut": budget.why,
        "others": others,
        "secretKeys": [list(k) for k in keys if k is not None],
        "ms": int((time.time() - t0) * 1000),
    }
    if budget.busy:
        out["busy"] = True
    elif budget.over:
        out["slow"] = True
    SNAPSHOTS.end()
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


def not_ready(doc):
    """A web document that shows with neither contents nor size: its page is painted (still loading, a very big
    one for a minute) before the browser hands it over to accessibility."""
    try:
        if doc.childCount != 0:
            return False
    except Exception:
        return False
    b = extents(doc)
    return b is not None and (b["width"] <= 0 or b["height"] <= 0)


def scan_fields(acc, depth, found, clip, budget, seen, in_pane=False):
    """Collects (role, accessible) for the input fields and labels on screen under acc into found["fields"] and
    found["labels"]; web documents searched by the app go to found["docs"] (their labels are asked for later,
    if needed). Stops short (budget.busy, .over or .cut) rather than miss part of the window unsaid.
    `in_pane`: acc is a child of a scroll pane (see shows)."""
    if budget.tick():
        return
    seen[0] += 1
    if seen[0] > SCAN_NODES:
        budget.cut_short("nodes")
        return
    states = state_names(acc)
    if not shows(acc, states, in_pane):
        return
    if depth > MAX_DEPTH:
        # It shows, and what it holds can't be looked through.
        budget.cut_short("depth")
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
        if not_ready(acc):
            # The page shows, but the browser hasn't handed over what it holds yet: none of it can be checked.
            budget.cut_short("loading")
            return
        t0 = time.monotonic()
        # Only a web page is searched by the app (see WEB_TOOLKITS): LibreOffice's drawings are document frames too.
        matches = collection_matches(acc, FIELD_ROLES) if role == "document web" or web_engine(acc) else None
        if matches is not None:
            budget.last = time.monotonic()  # one call for the whole document, not a timeout
            if len(matches) >= SCAN_NODES:
                budget.cut_short("nodes")
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
    grid = grid_of(acc, count, states, clip) if count > MAX_CHILDREN else None
    if grid is not None:
        # A spreadsheet (see grid_of): what comes before its cells is looked through, its cells are not. They hold
        # values, never fields (LibreOffice Calc keeps form controls in its drawing layer, beside the sheet), and
        # thousands of them show in a big window.
        for i in range(grid[4]):
            child = child_at(acc, i)
            if child is not None:
                scan_fields(child, depth + 1, found, clip, budget, seen)
        return
    indices, left_out, ordered = child_indices(acc, count, clip, SCAN_CHILDREN)
    if left_out:
        budget.cut_short("nodes")
    long_list, misses, last = count > MAX_CHILDREN, 0, None
    for i in indices:
        if budget.busy or budget.over or budget.cut:
            return
        child = child_at(acc, i)
        if child is None:
            continue
        last = (i, child)
        if long_list and not in_view(extents(child), clip):
            # Rows scrolled away show nothing in the picture; a few of them in a row, and the rest are too.
            misses += 1
            if misses >= 3:
                break
            continue
        misses = 0
        scan_fields(child, depth + 1, found, clip, budget, seen, role == "scroll pane")
    if not (long_list and ordered and last is not None and last[0] < count - 1) or budget.busy or budget.over or budget.cut:
        return
    # Except what shows all the same (a fixed panel last in a web page): those are looked through too.
    rest, complete = showing_after(acc, last[1], last[0], count, budget)
    if not complete:
        budget.cut_short("nodes")
    for child in rest:
        if budget.busy or budget.over or budget.cut:
            return
        if overlaps(extents(child), clip):
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
        "busy": budget.busy or "loading" in budget.why,
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
# The shell is looked through for this long and this many actors at most. Past either (a busy shell), what
# wasn't looked at may be a password prompt: the answer says it is incomplete.
SHELL_BUDGET_S = 1.0
SHELL_ACTORS = 1000
# Finding the shell among the apps takes this long at most (the shell's own look not counted). Apps are told
# apart by their process's name, which asks none of them; past it, the ones not looked at may be the shell.
SHELL_FIND_S = 1.0


def process_name(pid):
    """The name the kernel has for a process (/proc/<pid>/comm), or None when it can't be read."""
    try:
        with open("/proc/%d/comm" % pid) as f:
            return f.read().strip()
    except Exception:
        return None


def is_shell(app, pid):
    """Is this application GNOME Shell? By its process's name (the bus daemon gives the pid: the app isn't asked,
    and a hung app would take a timeout's wait to answer); by its own name only when /proc can't say, and then
    not for an app that is hung or didn't answer in time just now."""
    if pid is not None:
        comm = process_name(pid)
        if comm is not None:
            return comm == "gnome-shell"
        if pid in SLOW_NOW or is_hung(pid):
            return False
    t0 = time.monotonic()
    try:
        return (app.name or "") == "gnome-shell"
    except Exception:
        if pid is not None:
            note_answer(pid, t0, False)
        return False


def shell_overlays(params):
    """What GNOME Shell shows over the windows right now: its dialogs and notifications, with their
    text (for the password-prompt check), and "overview" while the overview or the window switcher may be
    up. Empty without GNOME Shell. `complete` is false when the shell couldn't be looked through in time."""
    new_request()
    out, complete = [], True
    desktop = pyatspi.Registry.getDesktop(0)
    try:
        napps = desktop.childCount
    except Exception:
        return {"overlays": out, "complete": complete}
    until = time.monotonic() + SHELL_FIND_S
    for a in range(napps):
        if time.monotonic() > until:
            # The apps left may include the shell: its dialogs can't be ruled out.
            complete = False
            break
        app = child_at(desktop, a)
        if app is None or not is_shell(app, process_id(app)):
            continue
        started = time.monotonic()
        budget = Budget(SHELL_BUDGET_S)
        stack = [(app, 0)]
        seen, modal = 0, False
        while stack and seen < SHELL_ACTORS and not budget.tick():
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
        if stack or budget.check():
            complete = False
        until += time.monotonic() - started
    return {"overlays": out, "complete": complete}


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

# What each action may be called (lower case). Chromium (Chrome, Electron apps: VS Code, Slack, Teams) names a check
# box's, radio button's or switch's action "check" or "uncheck" (an ARIA switch's may be "doDefault"), a pop-up
# button's "open" and a click inside a clickable element "clickAncestor"; Firefox a radio button's "select".
ACTION_ALIASES = {
    "click": ("click", "press", "activate", "jump", "toggle", "check", "uncheck", "select", "dodefault", "open",
              "clickancestor"),
    "press": ("press", "click", "activate"),
    "activate": ("activate", "click", "press", "jump"),
    "toggle": ("toggle", "click", "press", "activate", "check", "uncheck", "select", "dodefault"),
    "expand": ("expand or contract", "expand", "open", "press"),
}
# Actions that only turn a control one way: whether it is checked when the action would change nothing ("check" on a
# check box already checked). Those are never used then: a toggle that does nothing would be reported as done.
ONE_WAY = {"check": True, "select": True, "uncheck": False}


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
            holder = option_holder(acc)
            sel = option_selection(acc, holder)
            for i in range(min(holder.childCount, 500) if sel is not None else 0):
                if sel.isChildSelected(i):
                    info["selected"] = (holder.getChildAtIndex(i).name or "").strip()
                    break
        except Exception:
            pass
    elif role == "menu":
        # Open: its items show (the user opened it, with the mouse or with Alt+F or F10). A hover never opens a
        # closed menu in a menu bar, though it selects it.
        info["open"] = menu_open(acc)
    return info


def menu_open(acc):
    """Do a menu's items show (it is open)? Its first few are asked (a separator shows too)."""
    try:
        for i in range(min(acc.childCount, 3)):
            if "showing" in state_names(acc.getChildAtIndex(i)):
                return True
    except Exception:
        pass
    return False


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


def pick_action(acc, want):
    """(acc's Action interface, its action names, the index of the one that does `want`), or background_unavailable.
    A one-way action ("check", "uncheck") is only picked where it changes something."""
    try:
        act = acc.queryAction()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element has no accessible actions")
    names = [act.getName(i).lower() for i in range(act.nActions)]
    checked = None
    for candidate in ACTION_ALIASES.get(want, (want,)):
        if candidate not in names:
            continue
        if candidate in ONE_WAY:
            if checked is None:
                checked = "checked" in state_names(acc)
            if ONE_WAY[candidate] == checked:
                continue
        return act, names, names.index(candidate)
    raise RuntimeError("background_unavailable: no '%s' action (has: %s)" % (want, ", ".join(names) or "none"))


def editable_text(acc):
    try:
        return acc.queryEditableText()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element's text can't be edited directly")


def value_iface(acc):
    try:
        return acc.queryValue()
    except NotImplementedError:
        raise RuntimeError("background_unavailable: this element has no value to set")


def window_active(acc):
    """Is the window acc is in the active one (None: can't tell)?"""
    cur = acc
    for _ in range(60):
        try:
            parent = cur.parent
            if parent is None or parent.getRoleName() == "application":
                return "active" in state_names(cur)
        except Exception:
            return None
        cur = parent
    return None


# Actions that hand a click on to the element's ancestor: Chromium's "clickAncestor" (text, a picture or a heading
# inside a link, a button or an element with a click handler) and "doDefault" (on what isn't a control itself).
PASSES_CLICK = frozenset(["clickancestor", "dodefault"])
# A control's own actions (not one handed on, nor its context menu).
OWN_ACTIONS = frozenset(["click", "press", "activate", "jump", "open", "select", "toggle", "check", "uncheck",
                         "expand or contract"])
# What a click acts on itself: a mouse click on what is inside one of these (its label, its text) goes to it.
CLICK_CONTROLS = frozenset(INTERACTIVE_ROLES - TEXT_ROLES - frozenset(["terminal"]))
# Where looking for the control around an element stops: its page or window.
HANDLER_STOP = frozenset(["document web", "document frame", "frame", "window", "dialog", "alert", "file chooser",
                          "application", "desktop frame"])
HANDLER_LEVELS = 12


def click_handler(acc, picked):
    """The control around acc that a click on acc goes to, as {"role", "name"}; None when acc acts itself
    or nothing around it does. `picked`: the action a click by accessibility would do (None: it can't, and the mouse
    clicks it). Chromium's "clickAncestor" clicks the nearest ancestor with an action of its own (a link around its
    text, an element with a click handler: listed or not); the mouse on a label, text or a picture lands on the control
    it is in (a list's row around its label)."""
    try:
        role = acc.getRoleName()
    except Exception:
        return None
    if picked is not None and (picked not in PASSES_CLICK or (picked == "dodefault" and role in CLICK_CONTROLS)):
        return None  # an action of its own
    if picked is None and role in CLICK_CONTROLS:
        return None  # the mouse clicks the control itself
    by_action = picked is not None
    cur = acc
    for _ in range(HANDLER_LEVELS):
        try:
            cur = cur.parent
            if cur is None:
                return None
            r = cur.getRoleName()
        except Exception:
            return None
        if r in HANDLER_STOP:
            return None
        # Chromium hands the click to the nearest ancestor that acts (a row of a list doesn't, a link does).
        acts = OWN_ACTIONS.intersection(n.lower() for n in actions(cur))
        if acts or (not by_action and r in CLICK_CONTROLS):
            try:
                name = (cur.name or "").strip()
            except Exception:
                name = ""
            return {"role": r, "name": name[:200]}
    return None


def can_do(params):
    """Could `kind` ("click", "toggle", "text" or "value") be done on element `id` by accessibility? Checked as
    do_action, set_text and set_value check it, and nothing is done: Ember asks the user only the question that
    applies (to borrow the mouse, where that is the only way). With `caret`: whether the element has the keyboard
    (`focused`) and its window is the active one (`windowActive`), for text typed where the caret is. For a click:
    `action`, the action that would do it, and `handler`, the control around the element the click goes to (see
    click_handler), which is what the user is asked about."""
    nid = int(params["id"])
    acc = SNAPSHOTS.get(nid)
    kind = params.get("kind")
    out = {"tier1": True}
    picked = None
    try:
        if kind in ("click", "toggle"):
            _, names, index = pick_action(acc, kind)
            picked = out["action"] = names[index]
        elif kind == "text":
            editable_text(acc)
        elif kind == "value":
            value_iface(acc)
    except RuntimeError as err:
        if not str(err).startswith("background_unavailable"):
            raise
        out["tier1"] = False
        out["why"] = str(err)[len("background_unavailable: "):]
    if kind in ("click", "toggle"):
        # Whichever way it is clicked: by accessibility, or with the mouse where it can't be (picked is None).
        handler = click_handler(acc, picked)
        if handler is not None:
            out["handler"] = handler
    if params.get("caret"):
        out["focused"] = "focused" in state_names(acc)
        active = window_active(acc)
        if active is not None:
            out["windowActive"] = active
    return out


def do_action(params):
    nid = int(params["id"])
    acc = usable(nid)
    want = (params.get("action") or "click").lower()
    act, names, index = pick_action(acc, want)
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
    et = editable_text(acc)
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
    v = value_iface(acc)
    value = float(params["value"])
    if not math.isfinite(value) or value < v.minimumValue or value > v.maximumValue:
        raise ValueError("value %s is outside %s..%s" % (value, v.minimumValue, v.maximumValue))
    v.currentValue = value
    settle()
    return {"ok": True, "after": node_info(acc)}


def option_holder(acc):
    """The element whose children are acc's options: a combo box's one child menu or list (GTK, Chromium and
    Firefox keep the items there), else acc itself."""
    if acc.getRoleName() == "combo box" and acc.childCount == 1:
        child = acc.getChildAtIndex(0)
        if child is not None and child.getRoleName() in ("menu", "list", "list box"):
            return child
    return acc


def option_selection(acc, holder):
    """The Selection that chooses among holder's children: acc's own (GTK's combo box), else the holder's (a
    Chromium or Firefox <select> has it on its menu); None without one."""
    for owner in ((acc, holder) if holder is not acc else (acc,)):
        try:
            return owner.querySelection()
        except NotImplementedError:
            continue
    return None


def chosen_option(acc):
    """The name of the option a combo box shows as chosen, or None: asked of the Selection of its list of options (a
    web page's drop-down), else its own (GTK's), a few calls; the options aren't looked through one by one."""
    try:
        holder = option_holder(acc)
    except Exception:
        return None
    for owner in ((holder, acc) if holder is not acc else (acc,)):
        try:
            sel = owner.querySelection()
            if sel.nSelectedChildren < 1:
                continue
            item = sel.getSelectedChild(0)
            if item is None or getattr(item, "path", None) == getattr(holder, "path", None):
                continue
            name = (item.name or "").strip()
        except Exception:
            continue
        if name:
            return name
    return None


def option_chosen(sel, holder, index):
    """Is option `index` the chosen one now?"""
    try:
        return bool(sel.isChildSelected(index)) or "selected" in state_names(holder.getChildAtIndex(index))
    except Exception:
        return False


def option_items(acc):
    """The names of a combo box's or list's options: the children its Selection chooses among."""
    holder = option_holder(acc)
    if option_selection(acc, holder) is None:
        raise RuntimeError("background_unavailable: this element has no selectable options")
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
    holder = option_holder(acc)
    sel = option_selection(acc, holder)
    if option_chosen(sel, holder, index):
        # Chosen already: nothing is touched (Chromium's "select" on the chosen option of a closed <select> takes the
        # choice away, and the field is left empty).
        res = after_action(acc, nid)
        res.update({"ok": True, "option": names[index], "already": True})
        return res
    ok = bool(sel.selectChild(index))
    settle()
    if not ok:
        # Chromium's closed <select> refuses Selection: its option's own "select" action chooses it (and the
        # page hears of it as if the user had). Only that action: on a GTK menu item "click" activates it.
        item = holder.getChildAtIndex(index)
        try:
            if item is None:
                raise RuntimeError("background_unavailable: the option is gone")
            act, _, i = pick_action(item, "select")
        except RuntimeError as err:
            if not str(err).startswith("background_unavailable"):
                raise
        else:
            was = first_chosen(sel, holder)
            act.doAction(i)
            settle()
            ok = option_chosen(sel, holder, index)
            if not ok and was is not None and first_chosen(sel, holder) is None:
                # The field was left emptier than it was: the option chosen before is chosen again.
                choose_again(holder, was)
    res = after_action(acc, nid)
    res.update({"ok": ok, "option": names[index]})
    return res


def first_chosen(sel, holder):
    """The index of the option chosen now (the first, of up to 500), or None."""
    try:
        count = min(holder.childCount, 500)
    except Exception:
        return None
    for i in range(count):
        if option_chosen(sel, holder, i):
            return i
    return None


def choose_again(holder, index):
    """Chooses option `index` again by its own "select" action (see select_option); quietly does nothing if it can't."""
    try:
        item = holder.getChildAtIndex(index)
        if item is not None:
            act, _, i = pick_action(item, "select")
            act.doAction(i)
            settle()
    except Exception:
        pass


def list_options(params):
    acc = SNAPSHOTS.get(int(params["id"]))
    return {"options": option_items(acc)}


def focus(params):
    acc = usable(int(params["id"]))
    ok = acc.queryComponent().grabFocus()
    settle()
    return {"ok": bool(ok), "after": node_info(acc)}


def read_element(params):
    """The element as it is now. With `shown` asked for (where the mouse is to aim): the part of it that shows, where
    some of it is scrolled out of view or lies outside its window (a few more calls to the app)."""
    nid = int(params["id"])
    acc = SNAPSHOTS.get(nid)
    info = node_info(acc, nid)
    shown = visible_part(acc, info.get("bounds")) if params.get("shown") else None
    if shown is not None:
        info["shown"] = shown
    return info


# ---------------------------------------------------------------- what is at one point (under the wheel)

AT_POINT_LEVELS = 40
AT_POINT_CHILDREN = 64
AT_POINT_BUDGET_S = 1.0


def contains(b, x, y):
    return b is not None and b["x"] <= x < b["x"] + b["width"] and b["y"] <= y < b["y"] + b["height"]


def visible_part(acc, bounds):
    """The part of acc's rectangle `bounds` that shows: inside each scroll pane and viewport it is in, and inside its
    window. GTK reports a row scrolled almost out of its list as showing, at its full size: a click at its middle
    lands below the list. None without a position (or when it would be all of `bounds`); a rectangle of no size
    when nothing of it shows."""
    if bounds is None:
        return None
    shown, cur = bounds, acc
    for _ in range(AT_POINT_LEVELS):
        try:
            parent = cur.parent
            role = parent.getRoleName() if parent is not None else "application"
        except Exception:
            break
        if role == "application":
            # cur is the window: what lies outside its frame doesn't show either.
            if cur is not acc:
                shown = clip_to(shown, extents(cur))
            break
        if role in CLIP_ROLES:
            # GTK's viewport scrolled past its first screen has no position (see shows): its scroll pane clips.
            shown = clip_to(shown, extents(parent))
        cur = parent
    return None if shown == bounds else shown


# Containers that only group: one of these with nothing in it tells nothing about what shows at a point.
GENERIC_ROLES = frozenset(["panel", "filler", "unknown", "redundant object"])


def dead_end(acc):
    """An empty grouping container (or one that can't be asked): Chromium's hit test from its window ends on an
    empty views panel that lies over the web view, whose page is in a sibling panel."""
    try:
        return acc.getRoleName() in GENERIC_ROLES and acc.childCount == 0
    except Exception:
        return True


def sibling_at(acc, x, y, budget):
    """A sibling of acc that shows at (x, y) and isn't a dead end (Chromium: the panel holding the page, beside the
    empty one its hit test ended on), or None."""
    try:
        parent = acc.parent
        count = min(parent.childCount, AT_POINT_CHILDREN)
    except Exception:
        return None
    for i in range(count):
        if budget.tick():
            return None
        child = child_at(parent, i)
        if child is None or getattr(child, "path", None) == getattr(acc, "path", None):
            continue
        if shows(child, state_names(child)) and contains(extents(child), x, y) and not dead_end(child):
            return child
    return None


def same_object(a, b):
    """Are these the same accessible (one app's object path)?"""
    return a is b or (a is not None and b is not None and getattr(a, "path", None) == getattr(b, "path", None))


# Chromium answers a point it wasn't just asked about from a guess by the elements' boxes (the later one in the page
# wins, whatever is drawn on top) and asks the page in the background; asked again a moment later, it answers from the
# page's own hit test: a fixed header's button over a row, not the row. Other toolkits answer from their hit test.
GUESSING_TOOLKITS = frozenset(["chromium"])
HIT_AGAIN_S = 0.05


def guesses_first(acc):
    """Does acc's app answer a new point with a guess first (see GUESSING_TOOLKITS)?"""
    if not native(acc):
        return False
    try:
        return (Atspi.Accessible.get_toolkit_name(acc) or "").lower() in GUESSING_TOOLKITS
    except Exception:
        return False


def hit_at(acc, x, y):
    """What the app says is at screen point (x, y) in acc (None: nothing, or it couldn't say). Chromium is asked
    again (see GUESSING_TOOLKITS), and once more when its answers differ."""
    def ask():
        try:
            return Atspi.Component.get_accessible_at_point(acc, x, y, Atspi.CoordType.SCREEN)
        except Exception:
            return None
    hit = ask()
    if hit is None or same_object(hit, acc) or not guesses_first(acc):
        return hit
    for _ in range(2):
        time.sleep(HIT_AGAIN_S)
        again = ask()
        if again is None or same_object(again, hit):
            return hit
        hit = again
    return hit


# A container with at most this many children may draw one over another (GtkOverlay's floating notification, a window's
# popover): the last that shows at a point is drawn on top. Longer lists (rows) don't overlap.
ON_TOP_CHILDREN = 16


def on_top(acc, child, x, y, in_pane, budget):
    """Of acc's children that show at (x, y), the one drawn on top: `child` (the first the app or a look found there),
    or one after it (GTK, Qt: later children draw over earlier ones, and their hit test answers the first child there).
    Only for a container with a few children (see ON_TOP_CHILDREN); a web page draws in its own order (see
    GUESSING_TOOLKITS: Chromium and Firefox answer from their own hit test)."""
    if web_engine(acc):
        return child
    try:
        count = acc.childCount
    except Exception:
        return child
    if count < 2 or count > ON_TOP_CHILDREN:
        return child
    for i in range(count - 1, -1, -1):
        if budget.tick():
            return child
        c = child_at(acc, i)
        if c is None:
            continue
        if same_object(c, child):
            return child
        if shows(c, state_names(c), in_pane) and contains(extents(c), x, y) and not dead_end(c):
            return c
    return child  # not one of acc's children: as the app answered


def child_at_point(acc, role, x, y, budget):
    """The child of acc (role `role`) that shows at screen point (x, y), as a list: [child], or [holder, child]
    for a child in a notebook's page tab (its page lies outside the tab's own bounds) or in a viewport GTK
    misjudged (see shows: it has no bounds then); [] for none. The app is asked first (one call; Chromium answers
    with the deepest element there, asked again: see hit_at); where it finds none, or only an empty container, acc's
    first AT_POINT_CHILDREN children are looked through (one with something in it first). A child drawn over the one
    found is taken instead (see on_top)."""
    in_pane = role == "scroll pane"
    if native(acc):
        hit = hit_at(acc, x, y)
        if budget.check():
            return []
        if hit is not None and not same_object(hit, acc) and shows(hit, state_names(hit), in_pane):
            if not dead_end(hit):
                try:
                    direct = same_object(hit.parent, acc)
                except Exception:
                    direct = False
                return [on_top(acc, hit, x, y, in_pane, budget) if direct else hit]
            # Chromium: an empty panel over the web view; the page is in one beside it.
            beside_hit = sibling_at(hit, x, y, budget)
            if beside_hit is not None:
                return [beside_hit]
    try:
        count = min(acc.childCount, AT_POINT_CHILDREN)
    except Exception:
        return []
    through = []
    empty = None
    for i in range(count):
        if budget.tick():
            return []
        child = child_at(acc, i)
        states = state_names(child) if child is not None else []
        if not shows(child, states, in_pane):
            continue
        if contains(extents(child), x, y):
            if not dead_end(child):
                return [on_top(acc, child, x, y, in_pane, budget)]
            # An empty container lying over a sibling that holds what shows there: that one first.
            empty = empty or child
            continue
        try:
            if "showing" not in states or child.getRoleName() == "page tab":
                through.append(child)
        except Exception:
            pass
    for holder in through:
        try:
            inner = min(holder.childCount, 16)
        except Exception:
            continue
        for i in range(inner):
            if budget.tick():
                return []
            child = child_at(holder, i)
            if child is not None and shows(child, state_names(child)) and contains(extents(child), x, y):
                return [holder, child]
    return [empty] if empty is not None else []


# An app's popups (GTK's open menus and drop-down lists) are top-level windows of their own, with this role, drawn
# over its other windows (the window manager doesn't stack them). A few are looked at.
POPUP_ROLES = frozenset(["window"])
POPUP_WINDOWS = 16


def popup_at(app, win, x, y, budget):
    """The app's popup (see POPUP_ROLES) that shows at (x, y), other than `win` itself, or None."""
    try:
        count = min(app.childCount, POPUP_WINDOWS)
    except Exception:
        return None
    for i in range(count):
        if budget.tick():
            return None
        w = child_at(app, i)
        if w is None or same_object(w, win):
            continue
        try:
            if w.getRoleName() not in POPUP_ROLES:
                continue
        except Exception:
            continue
        if shows(w, state_names(w)) and contains(extents(w), x, y) and not dead_end(w):
            return w
    return None


# An open menu lies over the rest of its window (GTK draws it in a popup window of its own, its items outside the
# bounds of the menu bar they are reached through): what it shows at a point is on top. Looked for in the window's
# top few levels of containers and menu bars (never inside its documents, lists or tables).
MENU_HOLDERS = frozenset(["filler", "panel", "root pane", "layered pane", "glass pane", "menu bar", "split pane",
                          "unknown"])
MENU_DEPTH = 5
MENU_CHILDREN = 40


def open_menu_at(win, x, y, budget):
    """[menu, item] for the item of an open menu (or open submenu) in window `win` that shows at (x, y); [] for none."""
    stack = [(win, 0)]
    while stack:
        if budget.tick():
            return []
        acc, depth = stack.pop()
        try:
            role = acc.getRoleName()
            if role == "menu" and depth > 0:
                # An open menu is the one selected in its menu bar (or menu): the others aren't asked more.
                states = state_names(acc)
                if ("selected" not in states and "expanded" not in states) or not menu_open(acc):
                    continue
            elif depth > 0 and (role not in MENU_HOLDERS or depth >= MENU_DEPTH):
                continue
            count = min(acc.childCount, MENU_CHILDREN)
        except Exception:
            continue
        if role == "menu" and depth > 0:
            for i in range(count):
                item = child_at(acc, i)
                if item is None:
                    continue
                if shows(item, state_names(item)) and contains(extents(item), x, y):
                    return [acc, item]
                try:
                    if item.getRoleName() == "menu":
                        stack.append((item, depth + 1))  # a submenu: open, it shows somewhere else
                except Exception:
                    pass
            continue
        if depth < MENU_DEPTH:
            for i in range(count - 1, -1, -1):
                child = child_at(acc, i)
                if child is not None:
                    stack.append((child, depth + 1))
    return []


def at_point(params):
    """What shows at screen point (`x`, `y`) in one window (`pid` and `path`), outermost first: each element's
    role, name and bounds, as deep as the app tells. For the wheel: is a control it would change there? A read
    of the whole window would take a hundred times as long. `busy`: the app didn't answer in time. The last
    element is marked `empty` when it is an empty grouping container: the app told nothing about what shows
    there (it may lie over what does)."""
    t0 = time.time()
    new_request(params)
    found = find_window(params, time.monotonic() + FIND_BUDGET_S)
    if found is None:
        return {"chain": [], "found": False, "ms": int((time.time() - t0) * 1000)}
    app, pid, acc = found
    budget = Budget(AT_POINT_BUDGET_S)
    if never_looked(describe_window(app, pid, acc, budget), params):
        return {"chain": [], "blocked": True, "ms": int((time.time() - t0) * 1000)}
    x, y = int(params["x"]), int(params["y"])
    chain = []
    # The app's own popup (a drop-down's list), or an open menu, lies over its windows: what shows there is in it.
    # (`menus`: false when Ember knows none of the app's popup windows is there: a big app's menus cost dozens of calls.)
    popup = popup_at(app, acc, x, y, budget)
    over = [popup] if popup is not None else open_menu_at(acc, x, y, budget) if params.get("menus", True) is not False else []
    for el in over:
        try:
            role, name = el.getRoleName(), (el.name or "").strip()[:200]
        except Exception:
            role, name = "", ""
        chain.append({"role": role, "name": name, "bounds": extents(el)})
        acc = el
    try:
        role = acc.getRoleName()
    except Exception:
        role = ""
    secret = False
    for _ in range(AT_POINT_LEVELS):
        step = child_at_point(acc, role, x, y, budget)
        if not step or budget.busy or budget.over:
            break
        for el in step:
            try:
                role, name = el.getRoleName(), (el.name or "").strip()
            except Exception:
                role, name = "", ""
            # A secret field: neither its name nor what is in it (Chromium's text children hold its contents) leaves,
            # and nothing in it is looked at.
            secret = role in TEXT_ROLES and is_secret(el, role, name)
            node = {"role": role, "name": "" if secret else name[:200], "bounds": extents(el)}
            if secret:
                node["secret"] = True
            chain.append(node)
            if secret:
                break
        if secret:
            break
        acc = step[-1]
    if chain and not secret and dead_end(acc):
        chain[-1]["empty"] = True
    out = {"chain": chain, "ms": int((time.time() - t0) * 1000)}
    if budget.busy or budget.over:
        out["busy"] = True
    return out


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
    "at_point": at_point,
    "can_do": can_do,
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
