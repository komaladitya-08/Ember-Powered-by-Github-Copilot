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

import contextlib
import io
import json
import math
import os
import random
import re
import sys
import threading
import time
import traceback
import unicodedata
from collections import OrderedDict

pyatspi = None
Atspi = None

# Inside a WSL distro (Ember on Windows reading WSLg's Linux apps) Ember starts this script with EMBER_ATSPI_FIND_BUS=1:
# the session bus the distro's apps use is found first (find_bus), and only then are gi and pyatspi imported, on that
# bus. Without the variable (Linux) everything is as it always was: imported now.
FIND_BUS = os.environ.get("EMBER_ATSPI_FIND_BUS") == "1"


def load_atspi():
    """Imports pyatspi, and libatspi itself through gi. False when pyatspi isn't there (reported per request)."""
    global pyatspi, Atspi
    try:
        import pyatspi as module
    except ImportError:  # reported per request; the self-test runs without it
        return False
    pyatspi = module
    try:
        # libatspi itself (pyatspi loaded it): states and extents straight from it take half the time.
        from gi.repository import Atspi as lib
        Atspi = lib
    except Exception:
        pass
    return True


if not FIND_BUS:
    load_atspi()

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
MENU_ITEM_ROLES = frozenset(["menu item", "check menu item", "radio menu item"])
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


# Elements whose names say what a secret field in them holds (see withhold_names): their names are never reported, in
# a read, under the wheel or about an action. Kept like SECRETS.
WITHHELD = SecretFields()
# How far up from a secret field its containers are looked at (see withhold_names).
WITHHELD_LEVELS = 12
# The window itself (its title is reported as the window's): where looking up from a field stops.
WINDOW_ROLES = frozenset(["frame", "window", "dialog", "alert", "file chooser", "desktop frame", "application"])


def squash(text):
    """Text as a secret's value is looked for in a name: lowercase, NFKC, without whitespace (a card number spaced
    or not) or what stands for an element inside it (see OBJECT_CHAR)."""
    return "".join(normalize_label(text).replace(OBJECT_CHAR, " ").split())


def secret_values(acc, role, everywhere=None, name=""):
    """What a secret field holds, squashed (see squash): never reported, only looked for in the names of what is around
    it. Its text, the option a drop-down shows, a spin button's number. A few calls. `everywhere` (a list) is given
    those that are what the user put in it, which are looked for in every name of a read too (see says_value): what is
    typed in it, its number, and an option chosen in it that says something (see chosen_secret; `name`: the field's)."""
    typed = [text_of(acc, 2000)]
    chosen = None
    if role == "combo box":
        item, chosen = chosen_item(acc)
        if chosen and everywhere is not None and chosen_secret(item, chosen, name):
            typed.append(chosen)
    if role in VALUE_ROLES:
        v = value_of(acc)
        if v is not None:
            typed.append("%d" % v if v == int(v) else repr(v))
    if everywhere is not None:
        everywhere.extend(s for s in (squash(v) for v in typed if v) if s and s not in everywhere)
    return [s for s in (squash(v) for v in typed + ([chosen] if chosen not in typed else []) if v) if s]


# What a drop-down shows before anything is chosen in it ("Month", "YYYY", "Select…", "-- Choose --"), in the languages
# of SECRET_WORDS: a secret one's (a card's expiry) says nothing then, and is never looked for elsewhere in a read.
# Matched on lowercase, NFKC-normalised text with single spaces. The same as PLACEHOLDER_OPTION in elements.ts.
PLACEHOLDER_OPTION = re.compile(
    r"^[\W_]*(?:(?:select|choose|pick|please|seleccion|elegir|choisi|sélection|w(ä|a)hle|auswahl|scegli|seleziona|kies|"
    r"selecione|escolha|wybierz|выбер).*|mm|yy|yyyy|dd|jj|aa|aaaa|mes|month|year|day|mois|ann(é|e)e|jour|monat|jahr|tag|"
    r"a(ñ|n)o|d(í|i)a|mese|anno|giorno|maand|jaar|dag|m(å|a)nad|(å|a)r|miesi(ą|a)c|rok|месяц|год|月|年|日|none|n/?a)[\W_]*$")
# Fields whose chosen option is what the user put in them only with a digit in it: a card's expiry ("03", "2028"),
# never its type ("Visa Electron"). Matched on the field's name, as above. The same as CARD_FIELD in elements.ts.
CARD_FIELD = re.compile(r"card|cvv|cvc|csc|expir|valid (thru|through)|mm ?/ ?yy|karte|carte|tarjeta|cart(ã|a)o|carta|"
                        r"karty|карт|卡|カード")


def chosen_secret(item, chosen, name=""):
    """Is the option `chosen` (`item`: the option itself), chosen in a secret drop-down called `name`, what the user put
    in it? Not its first option (what a page shows until something is chosen), nor a placeholder (see
    PLACEHOLDER_OPTION); in a card's field only one with a digit in it (see CARD_FIELD), elsewhere one with a digit or
    of two words or more (a plain word, "Engineering" or "March", says nothing of its own). One call at most."""
    text = " ".join(normalize_label(chosen).split())
    if not text or PLACEHOLDER_OPTION.match(text):
        return False
    digits = any(c.isdigit() for c in text)
    if not digits and (CARD_FIELD.search(normalize_label(name or "")) or len(WORD.findall(text)) < 2):
        return False
    try:
        return item is None or item.getIndexInParent() != 0
    except Exception:
        return True


def holds_value(text, values):
    """Does `text` (an element's name or text) say one of a secret field's values (see secret_values)? A short value
    (part of a code typed so far) only as a word of its own."""
    if not text or not values:
        return False
    whole, words = squash(text), " ".join(normalize_label(text).split())
    for v in values:
        if v in whole if len(v) >= 4 else re.search(r"(?<!\w)" + re.escape(v) + r"(?!\w)", words):
            return True
    return False


def named_from_contents(acc):
    """Was acc's name made from what it holds? A web engine says which of its names its page gave ("explicit-name"):
    the rest are made from their contents (Chromium names a table's cell, an ARIA row or a <div> after its text and
    the values of the fields in it). Elsewhere names are given."""
    if not web_engine(acc):
        return False
    try:
        attrs = acc.getAttributes()
    except Exception:
        return True
    pairs = attrs.items() if isinstance(attrs, dict) else (a.partition(":")[::2] for a in attrs or [])
    return not any(k == "explicit-name" and v == "true" for k, v in pairs)


def says_secret(acc, name, text, values, field):
    """Does the name or text of acc, the secret field holding `values` or what holds it (`field`: acc is the field),
    say what the field holds: the value is in it, or (a container) a web engine made its name from its contents (see
    named_from_contents)? A field's own name made from contents is still its label."""
    return holds_value(name, values) or holds_value(text, values) or (not field and bool(name) and named_from_contents(acc))


# A secret field's values are looked for in every name and text of a read too, not only in what holds the field (a
# button named after it by aria-labelledby: "Pay with 4821"): those of WORD_VALUE_MIN characters or more (a shorter one
# is too common: "Total: 42"), as words of their own. A password field's bullets say nothing.
WORD_VALUE_MIN = 4
MASKS = "\u2022\u25cf\u2219\u00b7*\u25e6"


def says_value(text, values):
    """Does `text` say one of a secret field's values (see secret_values) as a word, or words, of its own, however it
    spaces their characters ("4111 1111 1111 1111")? Only values of WORD_VALUE_MIN characters or more, and none that
    is only bullets."""
    if not text or not values:
        return False
    whole, words = squash(text), None
    for v in values:
        if len(v) < WORD_VALUE_MIN or not v.strip(MASKS) or v not in whole:
            continue
        if words is None:
            words = normalize_label(text).replace(OBJECT_CHAR, " ")
        if re.search(r"(?<!\w)" + r"\s*".join(re.escape(c) for c in v) + r"(?!\w)", words):
            return True
    return False


# A web engine's element named after what it holds (see named_from_contents) says what a secret field in it holds also
# where a read didn't list that field (scrolled out of view, or past where the read stopped); one named after other
# elements (aria-labelledby) says what a secret field among them holds. Such names are checked before they are
# reported (see name_says_secret): the fields in the element are found by the app (AT-SPI's Collection, one call), or
# else child by child, CONTENTS_NODES elements at most, and at most CONTENTS_FIELDS of them are asked whether they are
# secret. For CONTENTS_S at most (in a read, for all its names): a name that can't be checked in time, or for want of
# room, is withheld.
CONTENTS_FIELDS = 32
CONTENTS_NODES = 120
CONTENTS_S = 0.4
# Roles whose names never say what a field holds that way: fields (a field's name is its label: see is_secret), a web
# page's text (Chromium's static text holds nothing) and pages and windows (named after their titles).
OWN_NAME_ROLES = FIELD_ROLES | WINDOW_ROLES | frozenset(["static", "document web", "document frame"])
# Words, as a name's are compared with what the elements in it say (see unlisted_secrets).
WORD = re.compile(r"\w+")


def fields_in(acc, until):
    """The input fields in acc (see FIELD_ROLES), shown or not; None when they can't all be told by `until`
    (time.monotonic()), or for want of room (see CONTENTS_FIELDS)."""
    if native(acc):
        try:
            wanted = [getattr(Atspi.Role, r.upper().replace(" ", "_")) for r in sorted(FIELD_ROLES)
                      if hasattr(Atspi.Role, r.upper().replace(" ", "_"))]
            rule = Atspi.MatchRule.new(Atspi.StateSet.new([]), Atspi.CollectionMatchType.ALL, {},
                                       Atspi.CollectionMatchType.ALL, wanted, Atspi.CollectionMatchType.ANY, [],
                                       Atspi.CollectionMatchType.ALL, False)
            found = list(Atspi.Collection.get_matches(acc, rule, Atspi.CollectionSortOrder.CANONICAL,
                                                      CONTENTS_FIELDS + 1, True))
            return found if len(found) <= CONTENTS_FIELDS else None
        except Exception:
            pass
    found, todo, seen = [], [acc], 0
    while todo:
        cur = todo.pop()
        try:
            count = cur.childCount
        except Exception:
            return None
        for i in range(count):
            seen += 1
            if seen > CONTENTS_NODES or time.monotonic() > until:
                return None
            child = child_at(cur, i)
            try:
                role = child.getRoleName()
            except Exception:
                return None
            if role in FIELD_ROLES:
                found.append(child)
                if len(found) > CONTENTS_FIELDS:
                    return None
            else:
                todo.append(child)
    return found


def secret_by_labels(field, name, layout):
    """Is the unnamed `field` next to or under a "Password" or "Card number" label of a read (`layout`: a function giving
    its labels and those that name a control on their row, see secret_by_layout)? It stays secret then (see SECRETS).
    One call (where it lies)."""
    if name or layout is None:
        return False
    bounds = extents(field)
    labels, claimed = layout()
    if bounds is None or not labels or not looks_secret(nearby_label({"bounds": bounds}, labels, claimed)):
        return False
    SECRETS.add(object_key(field))
    return True


def secret_inside(acc, until, layout=None):
    """Is a secret field (see is_secret; `layout`: or one secret by the read's labels, see secret_by_labels) in acc,
    shown or not? None when that can't be told by `until` (see fields_in)."""
    fields = fields_in(acc, until)
    if fields is None:
        return None
    for f in fields:
        if time.monotonic() > until:
            return None
        try:
            role, name = f.getRoleName(), (f.name or "").strip()
        except Exception:
            return None
        if is_secret(f, role, name) or secret_by_labels(f, name, layout):
            return True
    return False


# After a walk, what the read says is checked for secrets a few calls at a time (see withhold_names): WITHHOLD_S at most
# for all of it (the names a field's value can't be looked for in, in time, are withheld), each call given only the time
# left, so a read never runs on past it when its app stops answering (see Asking and calls_by).
WITHHOLD_S = 0.8
# The least time a call is given (libatspi's timeout, see call_timeout): less is no time left.
MIN_CALL_S = 0.02
# How often the time a call is given is set again while a deadline is on (see calls_by).
DEADLINE_TICK_S = 0.05


def call_timeout(seconds=None):
    """libatspi's timeout for each call to an app from now on: `seconds` (CALL_TIMEOUT_MS at most), or as configured
    (None: see configure_atspi). Only with a real libatspi."""
    if Atspi is None:
        return
    try:
        if seconds is None:
            Atspi.set_timeout(CALL_TIMEOUT_MS, STARTUP_TIMEOUT_MS)
        else:
            # No longer for an app that started a moment ago either (libatspi's app_startup_time).
            Atspi.set_timeout(max(int(MIN_CALL_S * 1000), min(CALL_TIMEOUT_MS, int(seconds * 1000))), 0)
    except Exception:
        pass


DEADLINES = []  # the deadlines (time.monotonic()) calls are made by now (see calls_by): the earliest counts
DEADLINES_LOCK = threading.Lock()


def deadline_timeout():
    """Gives the next call the time left by the earliest deadline (MIN_CALL_S past it). DEADLINES_LOCK held."""
    call_timeout(max(MIN_CALL_S, min(DEADLINES) - time.monotonic()))


def deadline_ticks(stop):
    """Keeps libatspi's timeout at the time left (see calls_by) until `stop` is set."""
    while not stop.wait(DEADLINE_TICK_S):
        with DEADLINES_LOCK:
            if stop.is_set() or not DEADLINES:
                return
            deadline_timeout()


@contextlib.contextmanager
def calls_by(until):
    """Inside, every call to an app is given only the time left until `until` (time.monotonic()), or an earlier
    deadline around it, and MIN_CALL_S once that has passed: libatspi's timeout (see call_timeout), set again every
    DEADLINE_TICK_S by a thread while the outermost is on. So no call runs past it by more than a tick, however many
    are made: one that times out (the app stopped answering) leaves the rest the least time. None: nothing changes."""
    if Atspi is None or until is None:
        yield
        return
    stop = None
    with DEADLINES_LOCK:
        DEADLINES.append(until)
        deadline_timeout()
        if len(DEADLINES) == 1:
            stop = threading.Event()
    if stop is not None:
        ticks = threading.Thread(target=deadline_ticks, args=(stop,))
        ticks.daemon = True
        ticks.start()
    try:
        yield
    finally:
        with DEADLINES_LOCK:
            DEADLINES.remove(until)
            if stop is not None:
                stop.set()
            if DEADLINES:
                deadline_timeout()
            else:
                call_timeout(None)


class Asking(object):
    """What the checks after a walk (see withhold_names) may still ask the app: nothing once it stopped answering
    (`busy`: a call of the walk's timed out, or one since took all the time it was given), nothing past `until`
    (time.monotonic(): `seconds` from now). Inside calls_by(asking.until) (see calls), each call is given only the time
    left."""

    def __init__(self, busy=False, seconds=None):
        self.busy = busy
        self.until = time.monotonic() + (WITHHOLD_S if seconds is None else seconds)

    def calls(self, until=None):
        """The deadline for the calls made inside (see calls_by), by `until` too: past already once the app is busy (a
        call made all the same is given the least time)."""
        return calls_by(time.monotonic() if self.busy else self.until if until is None else min(self.until, until))

    def left(self, until=None):
        """The time left for calls, by `until` too: 0 when there is none (or the app is busy)."""
        if self.busy:
            return 0.0
        left = (self.until if until is None else min(self.until, until)) - time.monotonic()
        return left if left >= MIN_CALL_S else 0.0

    def run(self, ask, until=None):
        """(True, ask()) while there is time left by `until` too, (False, None) after: inside self.calls(until), its
        calls are made by then. One that took all of it (or a timeout's time) timed out, most likely: the app stopped
        answering, and isn't asked again."""
        left = self.left(until)
        if not left:
            return False, None
        t0 = time.monotonic()
        try:
            return True, ask()
        finally:
            took = time.monotonic() - t0
            if took > SLOW_APP_S or took >= left - MIN_CALL_S:
                self.busy = True


def labelled_by_secret(acc, until, layout=None):
    """Is acc named after a secret field, or after an element with one in it (aria-labelledby: "Pay with" and the PIN
    field)? None when that can't be told by `until`. `layout`: see secret_by_labels."""
    try:
        relations = acc.getRelationSet() or []
    except Exception:
        return None
    for rel in relations:
        try:
            if rel.getRelationType() != pyatspi.RELATION_LABELLED_BY:
                continue
            targets = [rel.getTarget(i) for i in range(min(rel.getNTargets(), 16))]
        except Exception:
            return None
        for t in targets:
            if time.monotonic() > until:
                return None
            try:
                role = t.getRoleName()
                name = (t.name or "").strip()
            except Exception:
                return None
            if role == "static":
                continue  # a web page's text: nothing in it
            found = (is_secret(t, role, name) or secret_by_labels(t, name, layout)) if role in FIELD_ROLES \
                else secret_inside(t, until, layout)
            if found is not False:
                return found
    return False


def name_says_secret(acc, role, name, until, layout=None):
    """Does acc's name (`name`) say what a secret field holds, though that field wasn't read with it (see CONTENTS_S)?
    True too when that can't be told by `until` (time.monotonic()). Only a web engine's names are checked (a few calls
    each); `role` None: asked for. `layout`: a read's labels, which make an unnamed field in acc secret too (see
    secret_by_labels)."""
    if not name or role in OWN_NAME_ROLES or not web_engine(acc):
        return False
    try:
        role = role or acc.getRoleName()
    except Exception:
        return True
    if role in OWN_NAME_ROLES:
        return False
    if time.monotonic() > until:
        return True
    if not named_from_contents(acc):
        return labelled_by_secret(acc, until, layout) is not False
    return secret_inside(acc, until, layout) is not False


def withhold_around(acc, role):
    """Notes in WITHHELD the names that say what secret field acc holds (see withhold_names), looking up from its
    accessible (a few calls for each level): for a field Ember found secret after a read (mark_secret). Returns their
    keys."""
    values = secret_values(acc, role)
    cur, held = acc, []
    for _ in range(WITHHELD_LEVELS + 1):
        try:
            name = (cur.name or "").strip()
            r = cur.getRoleName()
        except Exception:
            break
        if r in WINDOW_ROLES:
            break
        if name and says_secret(cur, name, None, values, cur is acc):
            held.append(object_key(cur))
            WITHHELD.add(held[-1])
        try:
            cur = cur.parent
        except Exception:
            break
        if cur is None:
            break
    return [k for k in held if k is not None]


def named_by_value(node):
    """A combo box named after the option it shows (GTK names one so): judged by the label beside it, as an unnamed
    field is (see secret_by_layout)."""
    return node["role"] == "combo box" and bool(node["name"]) and node["name"] in (node.get("selected"), node.get("text"))


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
    if "selection" not in node and not secret and "focused" in states and "editable" in states and role not in TEXT_ROLES:
        # Editable text of another kind with the keyboard (a page's editable heading or section): what is selected in it,
        # which a key that types would replace.
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


def sheet_size(acc):
    """How many rows and columns a spreadsheet's sheet has (LibreOffice 6.4: 1024 columns; 24.2: 16384), or None."""
    try:
        t = acc.queryTable()
        rows, cols = int(t.nRows), int(t.nColumns)
    except Exception:
        return None
    return {"rows": rows, "columns": cols} if rows > 0 and cols > 0 else None


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


# Cells Ember says the cursor should be in (a read's `cells`), looked at first: this many at most.
CURSOR_HINTS = 4
# A spreadsheet's last row and column (LibreOffice Calc 24.2: 1048576 rows, 16384 columns).
SHEET_ROWS, SHEET_COLUMNS = 1048576, 16384


def cell_places(addresses):
    """(row, column) of each cell address ("C62", "$AB$7") of `addresses`, CURSOR_HINTS at most; [] for anything else."""
    out = []
    for a in addresses if isinstance(addresses, list) else []:
        a = a.replace("$", "").upper() if isinstance(a, str) else ""
        m = re.match(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$", a)
        if not m:
            continue
        col = 0
        for ch in m.group(1):
            col = col * 26 + ord(ch) - 64
        place = (int(m.group(2)) - 1, col - 1)
        if place[0] < SHEET_ROWS and place[1] < SHEET_COLUMNS and place not in out:
            out.append(place)
        if len(out) >= CURSOR_HINTS:
            break
    return out


def scan_order(grid, start, around):
    """The cells on screen from `start` (row, column) on (see grid_of; the ones before were looked at), row by row: the
    rows nearest row `around` first, else the first and the last rows on screen alternately, inwards (every cell asked
    takes longer the more cells show: a zoomed-out sheet's lower rows were never reached from the top in time)."""
    first, last = start[0], grid[1]
    rows = list(range(first, last + 1))
    if around is not None and first <= around <= last:
        rows.sort(key=lambda r: (abs(r - around), r))
    else:
        rows = [rows[i // 2] if i % 2 == 0 else rows[-1 - i // 2] for i in range(len(rows))]
    for r in rows:
        for c in range(start[1] if r == first else grid[2], grid[3] + 1):
            yield r, c


def cursor_cell(table, grid, start, until, hints=()):
    """The cell of spreadsheet `table` (see grid_of) that has the keyboard, as (row, column, cell, states), or None.
    No cell says so to anything but its states (the sheet's Selection is empty without a range selected, and Calc's
    Name Box is out of reach of accessibility), so cells are asked: those Ember expects it in (`hints`, (row, column):
    where it moved it to, where it saw it), then where it was last found, wherever they are (scrolled away too), then the
    cells around each (a key moves it a cell), then those on screen from `start` (row, column) on (see scan_order),
    until `until` (time.monotonic()), two calls a cell. None too once the app takes a timeout's time to answer."""
    last = CURSORS.get(object_key(table))
    first = list(hints) + ([last] if last is not None else [])
    near = list(first)
    for r, c in first:
        near += [(r + 1, c), (r, c + 1), (r - 1, c), (r, c - 1), (r + 1, grid[2])]
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
        if 0 <= r < SHEET_ROWS and 0 <= c < SHEET_COLUMNS and (r, c) not in tried:
            tried.add((r, c))
            found = ask(r, c)
            if found is not None:
                return found or None
    for r, c in scan_order(grid, start, first[0][0] if first else None):
        if (r, c) not in tried:
            found = ask(r, c)
            if found is not None:
                return found or None
    return None


def add_cursors(nodes, sheets, until, hints=()):
    """The cell with the keyboard of each spreadsheet in `sheets` (noted by walk_grid: a read that didn't come to it),
    put in `nodes` after the sheet's other cells: wherever it is (scrolled away too: keys go there), as long as it is
    found before `until` (see cursor_cell; `hints`: the cells Ember expects it in)."""
    for s in reversed(sheets):  # from the last, so the places noted for the others stay right
        found = cursor_cell(s["table"], s["grid"], s["start"], until, hints)
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
        self.panes = {}  # a spreadsheet's panes by object path: "next" (to be read now), "read" (see read_panes)

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


# LibreOffice Calc shows a sheet with frozen rows or columns in panes, a document each (the frozen ones hold the column
# and row headings), and lists the scrolled pane first: read in that order, its cells take the read's GRID_CELLS and the
# headings are never read. The panes of a sheet are siblings among a few other children.
PANE_ROLE = "document spreadsheet"
PANE_SIBLINGS = 24


def sibling_panes(acc):
    """The panes of the spreadsheet document acc is one of (see PANE_ROLE), top left first by where they show (frozen
    rows above, frozen columns to the left), as (pane, bounds); [] for a sheet in one pane. A few calls for each of its
    siblings."""
    try:
        parent = acc.parent
        count = parent.childCount if parent is not None else 0
    except Exception:
        return []
    if count < 2 or count > PANE_SIBLINGS:
        return []
    panes = []
    for i in range(count):
        child = child_at(parent, i)
        try:
            if child is None or child.getRoleName() != PANE_ROLE:
                continue
        except Exception:
            continue
        b = extents(child)
        panes.append((((b["y"], b["x"]) if b is not None else (2 ** 31, 2 ** 31)), i, child, b))
    if len(panes) < 2:
        return []
    panes.sort(key=lambda p: (p[0], p[1]))
    return [(p[2], p[3]) for p in panes]


def read_panes(panes, depth, out, max_depth, max_nodes, parent_id, clip, budget, in_pane):
    """Reads a spreadsheet's panes (see sibling_panes) in their order, where the first of them is met in the tree; the
    rest are not read again where they are met. LibreOffice says a frozen pane a row high doesn't show (nor its sheet)
    while its cells do: one that is visible and lies on screen is read all the same (see walk's `pane`). Returns
    whether any of them shows."""
    for p, _ in panes:
        budget.panes[getattr(p, "path", None)] = "next"
    shown = False
    for p, b in panes:
        on = b is not None and in_view(b, clip)
        shown = walk(p, depth, out, max_depth, max_nodes, parent_id, clip, budget, in_pane, on) or shown
        budget.panes[getattr(p, "path", None)] = "read"
        if budget.busy or budget.over:
            break
    return shown


def walk(acc, depth, out, max_depth, max_nodes, parent_id, clip=None, budget=None, in_pane=False, pane=False, web=False):
    """Reports acc and what it contains, depth first. Returns whether acc is on screen. `pane`: a spreadsheet's pane
    (or its sheet) found on screen by where it lies, which shows if it is visible (see read_panes). `web`: acc is in a
    web page, where only the page (and a frame in it) clips what is in it, in the page's own units, as in visible_part:
    on a HiDPI screen Chromium's page reports physical pixels inside a window frame that reports logical ones."""
    budget = budget or Budget()
    if len(out) - budget.grid >= max_nodes:
        budget.cut_short("nodes")
        return False
    if budget.tick():
        return False
    states = state_names(acc)
    if not shows(acc, states, in_pane) and not (pane and "visible" in states):
        # Invisible elements are a known prompt-injection channel; never report them.
        return False
    # A viewport GTK misjudged (see shows): not listed itself, and on screen only if something in it is.
    judged = "showing" in states or pane
    if depth > max_depth:
        # It shows, but is nested deeper than a read goes: the read says it is incomplete.
        budget.cut_short("depth")
        return True
    try:
        role = acc.getRoleName()
        name = (acc.name or "").strip()
    except Exception:
        return False
    if role == PANE_ROLE and depth > 0:
        # A spreadsheet with frozen rows or columns, in panes: read top left first (see sibling_panes).
        done = budget.panes.get(getattr(acc, "path", None))
        if done == "read":
            return True
        if done is None:
            panes = sibling_panes(acc)
            if panes:
                return read_panes(panes, depth, out, max_depth, max_nodes, parent_id, clip, budget, in_pane)
    my_id = parent_id
    listed = judged and (role not in SKIP_ROLES or bool(name))
    page = role in DOCUMENT_ROLES
    bounds = extents(acc) if listed or depth == 0 or role in CLIP_ROLES or page else None
    secret = False
    mine = None
    if listed and (bounds is None or (bounds["width"] > 0 and bounds["height"] > 0)):
        node = mine = node_of(acc, role, name, states, bounds)
        node["id"] = SNAPSHOTS.add(acc)
        node["parent"] = parent_id
        node["depth"] = depth
        # A page is clipped by the page it is a frame of, never by what holds the page (see `web`).
        by = clip if web or not page else None
        shown = clip_to(by, bounds) if by is not None and bounds is not None else None
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
    if page:
        # What is in a page shows inside it (a frame's inside the frame too), in the page's units (see `web`).
        clip = clip_to(clip, bounds) if web else bounds
        web = True
    elif (depth == 0 or role in CLIP_ROLES) and not web:
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
        # A spreadsheet: its cells on screen, by row and column; and how many it has (Ember checks a cell's address).
        if mine is not None:
            size = sheet_size(acc)
            if size is not None:
                mine["size"] = size
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
        on_screen_now = walk(child, depth + 1, out, max_depth, max_nodes, my_id, clip, budget, role == "scroll pane",
                             pane and role == PANE_ROLE, web)
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
            walk(child, depth + 1, out, max_depth, max_nodes, my_id, clip, budget, web=web)
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
    """The unnamed fields, of `fields`, next to or under a "Password" or "Card number" label (a combo box named after
    the option it shows counts as unnamed: see named_by_value)."""
    claimed = claimed_labels(labels, controls)
    return [f for f in fields if (not f["name"] or named_by_value(f)) and looks_secret(nearby_label(f, labels, claimed))]


def make_secret(node, accessible_of):
    """A listed field found secret after the walk: what it holds goes, and it stays secret (see SECRETS)."""
    for k in ("text", "selection", "value", "selected"):
        node.pop(k, None)
    node["secret"] = True
    SECRETS.add(object_key(accessible_of(node["id"])))


def redact_by_layout(nodes, accessible_of):
    """Unnamed text fields next to or under a "Password" or "Card number" label: their contents are secret too. So is a
    combo box whose text field is secret (GTK's combo box with an entry, named after what is typed in it)."""
    labels = [n for n in nodes if n["role"] in LABEL_ROLES and n["name"] and n["bounds"]]
    controls = [n for n in nodes if n["role"] in LABELLED_ROLES and n["bounds"]]
    fields = [n for n in nodes if n["role"] in FIELD_ROLES and n["bounds"] and not n.get("secret")]
    for n in secret_by_layout(fields, labels, controls):
        make_secret(n, accessible_of)
    by_id = dict((n["id"], n) for n in nodes)
    for n in nodes:
        combo = by_id.get(n["parent"]) if n.get("secret") else None
        if combo is not None and combo["role"] == "combo box" and not combo.get("secret"):
            make_secret(combo, accessible_of)


def withhold_names(nodes, accessible_of, asking=None):
    """Names that say what a secret field holds (Chromium names a table's cell, a row or a <div> after what the fields
    in it hold; GTK a combo box after the option it shows): the field's own and its listed containers', with their
    text, are left out (marked `withheld`), and noted in WITHHELD (for what is under the wheel and actions). So are the
    names and texts elsewhere in the read that say what the user put in a field as words of their own (see says_value;
    the option a drop-down shows that says it goes, its name stays), and a web page's names that may say what a field
    the read didn't list holds (see unlisted_secrets). The field's value is asked for here (never reported), as
    `asking` allows (see Asking): a field that can't be asked about in time has every name around it withheld. A read
    lists parents first. Returns the keys noted."""
    by_id, held = dict((n["id"], n) for n in nodes), set()
    asking = asking or Asking()

    def withhold(c, acc):
        c["name"] = ""
        c["withheld"] = True
        for k in ("text", "selection", "selected"):
            c.pop(k, None)
        key = object_key(acc) if acc is not None else None
        if key is not None:
            WITHHELD.add(key)
            held.add(key)
    values_of_all, short = [], []
    for n in nodes:
        if not n.get("secret"):
            continue
        field = accessible_of(n["id"])
        values = []
        # (A call that timed out answers nothing: then nothing was told.)
        asked = field is None or (asking.run(lambda: values.extend(secret_values(field, n["role"], values_of_all, n["name"])))[0]
                                  and not asking.busy)
        short.extend((field, v) for v in values if len(v) < WORD_VALUE_MIN and v.strip(MASKS))
        chain = [n]
        p = by_id.get(n["parent"])
        while p is not None and len(chain) <= WITHHELD_LEVELS and p["role"] not in WINDOW_ROLES:
            chain.append(p)
            p = by_id.get(p["parent"])
        for c in chain:
            acc = field if c is n else accessible_of(c["id"])
            if acc is None or not (c["name"] or c.get("text")):
                continue
            if not asked:
                # What it holds wasn't told in time (its app stopped answering): what holds it may say it (not a page,
                # named after its title), and so may a drop-down's own name (GTK's, after the option it shows).
                if (c is not n and c["role"] not in DOCUMENT_ROLES) or c["role"] == "combo box":
                    withhold(c, acc)
            elif holds_value(c["name"], values) or holds_value(c.get("text"), values):
                withhold(c, acc)
            elif c is not n and c["name"]:
                told, contents = asking.run(lambda: named_from_contents(acc))
                if contents or not told:
                    withhold(c, acc)
    # A short value ("42") is too common to withhold wherever it is a word (see says_value), but not what is named after
    # its field (aria-labelledby: "Pay with" and the field), which the field tells (one call) where the read says it.
    for field, v in short:
        if any(not c.get("secret") and (holds_value(c["name"], [v]) or holds_value(c.get("text"), [v])) for c in nodes):
            for key in (object_key(t) for t in asking.run(lambda: labels_by(field))[1] or []):
                if key is not None:
                    WITHHELD.add(key)
                    held.add(key)
    bus = None
    for c in nodes:
        if c.get("secret") or not (c["name"] or c.get("text") or c.get("selected")):
            continue
        # Saying what the user put in a field as words of its own, or found before (see WITHHELD).
        if says_value(c["name"], values_of_all) or says_value(c.get("text"), values_of_all):
            withhold(c, accessible_of(c["id"]))
            continue
        if says_value(c.get("selected"), values_of_all):
            del c["selected"]  # a drop-down that shows it ("Pay from: Card 4242 4242 4242 4242"): its name says nothing
        if WITHHELD.keys and (c["name"] or c.get("text")):
            acc = accessible_of(c["id"])
            if bus is None and acc is not None:
                bus = (object_key(acc) or ("",))[0]
            if acc is not None and (bus, getattr(acc, "path", None)) in WITHHELD:
                withhold(c, acc)
    if nodes:
        remember_values(accessible_of(nodes[0]["id"]), values_of_all)
    unlisted_secrets(nodes, accessible_of, withhold, asking)
    return held


# What the user put in the secret fields an app's last read listed (see secret_values' `everywhere`), squashed, by its
# bus name: never reported, only looked for in an option it lists or shows chosen later (see option_items, node_info),
# which the read itself withholds (see withhold_names). Kept for a few apps, in this process only.
PAGE_VALUES = OrderedDict()
PAGE_VALUES_APPS = 8


def remember_values(acc, values):
    """Keeps `values` as what the secret fields of acc's app hold (see PAGE_VALUES)."""
    bus = (object_key(acc) or ("",))[0] if acc is not None else ""
    PAGE_VALUES.pop(bus, None)
    if values:
        PAGE_VALUES[bus] = list(values)
        while len(PAGE_VALUES) > PAGE_VALUES_APPS:
            PAGE_VALUES.popitem(last=False)


def values_known(acc):
    """What the secret fields of acc's app held when it was last read (see PAGE_VALUES)."""
    return PAGE_VALUES.get((object_key(acc) or ("",))[0], []) if PAGE_VALUES and acc is not None else []


def labels_by(field):
    """The elements named after `field` (aria-labelledby), as its LABEL_FOR relation says (a few at most)."""
    try:
        for rel in field.getRelationSet() if field is not None else []:
            if rel.getRelationType() == pyatspi.RELATION_LABEL_FOR:
                return [t for t in (rel.getTarget(i) for i in range(min(rel.getNTargets(), 16))) if t is not None]
    except Exception:
        pass
    return []


def words_of(text):
    return WORD.findall(normalize_label(text)) if text else []


def unlisted_secrets(nodes, accessible_of, withhold, asking=None):
    """A web page's names that say words none of the elements the read listed in them say (`withhold` leaves them out),
    of elements the read may not have listed all of: some of it listed, or partly out of view (`shown`), or where the
    read stopped (the last element listed and what holds it). Named after what they hold, they may say what a secret
    field the read didn't list holds (scrolled out of view, or past where the read stopped), and so are checked (see
    name_says_secret), CONTENTS_S at most for the read and as `asking` allows (see Asking: none once the app stopped
    answering, when they are all withheld); so are ones named after other elements (aria-labelledby), and an element
    with nothing listed in it whose name says what looks like a value (a word of 4 characters or more, with a digit)
    that no text of the read says (a button named after a card number field out of view; see unlisted_leaf). An unnamed
    field in one is judged by the read's labels too (see secret_by_labels). Children first: a row is checked once its
    cell's name is withheld. Elsewhere, and on a page where every name is said by what is listed in it, no call is made."""
    first = accessible_of(nodes[0]["id"]) if nodes else None
    if first is None or not web_engine(first):
        return  # names are made from contents only in a web engine (see named_from_contents); a read is one app's
    asking = asking or Asking()
    by_id, last = dict((n["id"], n) for n in nodes), nodes[-1]
    stop = set()
    while last is not None and last["id"] not in stop:
        stop.add(last["id"])
        last = by_id.get(last["parent"])
    until = time.monotonic() + CONTENTS_S
    known = []  # (the read's labels, those naming a control on their row; the words its text says), once needed

    def read_layout():
        if not known:
            labels = [n for n in nodes if n["role"] in LABEL_ROLES and n["name"] and n["bounds"]]
            controls = [n for n in nodes if n["role"] in LABELLED_ROLES and n["bounds"]]
            inside = inside_secrets(nodes)
            heard = set()
            for n in nodes:
                if n["id"] not in inside:
                    heard.update(words_of(n["name"] if n["role"] in LABEL_ROLES else None))
                    heard.update(words_of(n.get("text")))
            known.append((labels, claimed_labels(labels, controls), heard))
        return known[0]
    said, kids = {}, set()
    with asking.calls(until):
        for n in reversed(nodes):
            inner = said.pop(n["id"], None) or set()
            named = n["name"] and n["role"] not in OWN_NAME_ROLES and not n.get("secret")
            check = named and (n["id"] in kids or "shown" in n or n["id"] in stop) and not inner.issuperset(words_of(n["name"]))
            leaf = named and not check and n["id"] not in kids and any(len(w) >= WORD_VALUE_MIN and any(c.isdigit() for c in w)
                                                                       and w not in read_layout()[2] for w in words_of(n["name"]))
            if check or leaf:
                acc = accessible_of(n["id"])
                if acc is not None:
                    told, says = asking.run(lambda: unlisted_leaf(acc, n, leaf, until, lambda: read_layout()[:2]), until)
                    if says or not told:
                        withhold(n, acc)
            p = n["parent"]
            if p is not None:
                kids.add(p)
                words = said.setdefault(p, set())
                words |= inner
                for k in ("name", "text", "selected"):
                    words.update(words_of(n.get(k)))


def unlisted_leaf(acc, node, leaf, until, layout):
    """Does the name of acc (`node`, as read) say what a secret field the read didn't list holds (see
    name_says_secret)? Not a `leaf`'s (nothing in it listed) that its own text says too (a button's: one call)."""
    if leaf and set(words_of(node["name"])) <= set(words_of(cell_text(acc, 1000))):
        return False
    return name_says_secret(acc, node["role"], node["name"], until, layout)


def withheld_name(acc, name, role=None):
    """acc's name as it may be reported: none for one that says what a secret field holds (see WITHHELD and
    name_says_secret, which a few calls check)."""
    if not name:
        return name
    key = object_key(acc)
    if WITHHELD.keys and key in WITHHELD:
        return ""
    if name_says_secret(acc, role, name, time.monotonic() + CONTENTS_S):
        WITHHELD.add(key)
        return ""
    return name


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
    if FIND_BUS and pid is not None:
        # Inside WSL: the names its program goes by, for Ember's checks on Windows (they come from /proc, not the app).
        out.update(process_names(pid))
    return out


def list_windows(params):
    new_request(params)
    out, asked = [], set()
    for app, pid, win in frames(until=time.monotonic() + FIND_BUDGET_S):
        asked.add(pid)
        _, states = window_facts(pid, win)
        if "showing" in states or "active" in states:
            out.append(describe_window(app, pid, win))
            if FIND_BUS:
                # Inside WSL: what shows of it, without client-side shadows, to place it in its WSLg window (§4.9).
                out[-1]["children"] = child_extents(win)
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
        # (Its toolkit asked now, once an app, which the checks after the walk go by, see unlisted_secrets: so they
        # need not ask it of an app that stops answering during the walk.)
        web_engine(win)
        walk(win, 0, nodes, int(params.get("maxDepth", MAX_DEPTH)), max_nodes, None, None, budget)
        budget.check()  # the last element asked may have been the one that timed out
    if budget.sheets and not budget.busy:
        # A spreadsheet's cell with the keyboard that the look at its cells didn't come to (keys go there): the cells
        # Ember expects it in (`cells`: where it moved it to, where it last saw it) are asked first.
        add_cursors(nodes, budget.sheets, time.monotonic() + min(CURSOR_SCAN_S, max(0.3, READ_TOTAL_S - (time.time() - t0))),
                    cell_places(params.get("cells")))
    latest = SNAPSHOTS.latest()
    accessible_of = lambda nid: stored(latest.get(nid))  # noqa: E731
    redact_by_layout(nodes, accessible_of)
    # What the read says is checked for secrets in WITHHOLD_S at most, and without asking an app that stopped answering.
    asking = Asking(budget.busy)
    with asking.calls():
        held = withhold_names(nodes, accessible_of, asking)
    if WITHHELD.keys:
        # Names found to say what a secret field holds before (by Ember too: mark_secret).
        bus = (object_key(win) or ("",))[0]
        for n in nodes:
            if (n["name"] or n.get("text")) and (bus, getattr(accessible_of(n["id"]), "path", None)) in WITHHELD:
                n["name"] = ""
                n["withheld"] = True
                for k in ("text", "selection", "selected"):
                    n.pop(k, None)
    inside = inside_secrets(nodes)
    if inside:
        nodes = [n for n in nodes if n["id"] not in inside]
        for nid in inside:
            latest.pop(nid, None)  # nor are they read by id
    others = []
    if not budget.busy and pid is not None:
        # (Its calls by its deadline too: an app that stopped answering since the walk doesn't hold the read up.)
        with calls_by(time.monotonic() + 0.3):
            others = other_windows(pid, win, Budget(0.3))
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
        "withheldKeys": [list(k) for k in held],
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
        if is_secret(acc, role, name):
            secret.append(node)
            continue
        if role == "combo box" and name:
            # GTK names a combo box after what it shows: then it is judged by its label (see named_by_value).
            node["selected"] = combo_shows(acc)
        plain.append(node)
    if any(not n["name"] or named_by_value(n) for n in plain) and not (budget.busy or budget.over):
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
    """Secret fields an earlier helper process knew (Ember hands them over when it starts a new one), and the elements
    whose names it withheld (`withheld`: see WITHHELD)."""
    for known, keys in ((SECRETS, params.get("keys")), (WITHHELD, params.get("withheld"))):
        for key in keys or []:
            if isinstance(key, list) and len(key) == 2:
                known.add((key[0], key[1]))
    return {"count": len(SECRETS.keys)}


def mark_secret(params):
    """Elements Ember found to hold secrets (a field beside a "Show password" toggle): nothing is typed into them. The
    names around one that say what it holds are withheld from now on (see withhold_around)."""
    keys, held = [], []
    for nid in (params.get("ids") or [])[:64]:
        try:
            acc = SNAPSHOTS.get(int(nid))
        except (KeyError, ValueError, TypeError):
            continue
        key = object_key(acc)
        if key is None:
            continue
        SECRETS.add(key)
        keys.append(list(key))
        try:
            role = acc.getRoleName()
        except Exception:
            continue
        held.extend(list(k) for k in withhold_around(acc, role))
    return {"keys": keys, "withheldKeys": held}


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
    # (Inside WSL gi isn't imported before find_bus has chosen the bus: until then this can't be told.)
    if not FIND_BUS or BUS["chosen"]:
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
    out = {"version": VERSION, "python": sys.version.split()[0], "toolkitAccessibility": enabled, "apps": apps}
    if FIND_BUS:
        out.update(wsl_status())
    return out


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
    # Not one that says what a secret field holds, even one that isn't in view (see withheld_name), nor one a read
    # withheld (an unnamed paragraph whose text says it, see WITHHELD).
    withheld = (bool(name) and withheld_name(acc, name, role) == "") or (bool(WITHHELD.keys) and object_key(acc) in WITHHELD)
    info = {"role": role, "name": "" if withheld else name[:200], "states": [s for s in states if s in INTERESTING_STATES],
            "bounds": extents(acc)}
    # A menu's item once its menu closed: GTK keeps it, at its old place, only no longer showing (a guide's step
    # pointing at it is over: the user chose it, or went elsewhere). No states at all is a state read that failed (a
    # closed menu's item still reports some), which says nothing of its menu.
    if role in MENU_ITEM_ROLES and states and "showing" not in states:
        info["offscreen"] = True
    if withheld:
        info["withheld"] = True
    if is_secret(acc, role, name):
        info["secret"] = True
        return info
    if withheld:
        # A container named after what a secret field in it holds: what it says is withheld too.
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
                    # Never a name that says what a secret field holds (see said_name), in it or in the app's last read.
                    item = holder.getChildAtIndex(i)
                    info["selected"] = said_name(item, (item.name or "").strip(), secret_values_in(acc), values_known(acc))
                    break
        except Exception:
            pass
    elif role in ROW_LIST_ROLES and not spreadsheet(acc):
        # A list of rows: its row selected (the first), by its first cell with words in it (see row_list), never by what
        # a secret field in it holds (see cell_words, said_name).
        try:
            rows = acc.queryTable().getSelectedRows()
            if len(rows):
                values = secret_values_in(acc)
                for c in range(min(acc.queryTable().nColumns, 8)):
                    words = said_name(None, cell_words(table_cell_at(acc, rows[0], c)), values)
                    if words:
                        info["selected"] = words[:200]
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
# How far up to look: a page's own elements can nest deep (Chromium's clickAncestor finds its control however deep);
# a click handed further up than this is judged unknown (see click_handler), never by what was clicked.
HANDLER_LEVELS = 64


def mouse_spot(acc):
    """Where the mouse lands on acc, as Ember aims (Worker.landingSpot: its middle, at most 120 px in from its left
    edge), or None without a position."""
    b = extents(acc)
    if b is None or b["width"] <= 0 or b["height"] <= 0:
        return None
    return b["x"] + min(b["width"] // 2, 120), b["y"] + b["height"] // 2


def takes_click_at(acc, role, spot):
    """Does the control acc (role `role`) around an element take a mouse click at `spot` on that element (None: it has
    no position)? Only where it covers the spot: a page tab takes clicks on its own tab, never on the page it holds
    (GTK's notebook tab is the parent of its whole page, at the tab alone). One without a position is taken at its
    word, a page tab excepted (one whose tab doesn't show still holds its page)."""
    b = extents(acc)
    if spot is None or b is None or b["width"] <= 0 or b["height"] <= 0:
        return role != "page tab"
    return contains(b, spot[0], spot[1])


def click_handler(acc, picked):
    """The control around acc that a click on acc goes to, as {"role", "name"}; None when acc acts itself
    or nothing around it does. `picked`: the action a click by accessibility would do (None: it can't, and the mouse
    clicks it). Chromium's "clickAncestor" clicks the nearest ancestor with an action of its own (a link around its
    text, an element with a click handler: listed or not); the mouse on a label, text or a picture lands on the control
    it is in (a list's row around its label), only one that covers where the mouse lands (see takes_click_at).
    {"unknown": True}: by accessibility, handed on further up than HANDLER_LEVELS (what it works can't be told)."""
    try:
        role = acc.getRoleName()
    except Exception:
        return None
    if picked is not None and (picked not in PASSES_CLICK or (picked == "dodefault" and role in CLICK_CONTROLS)):
        return None  # an action of its own
    if picked is None and role in CLICK_CONTROLS:
        return None  # the mouse clicks the control itself
    by_action = picked is not None
    # By accessibility the click goes up the page's elements (Chromium's click bubbles), wherever they are drawn.
    spot = None if by_action else mouse_spot(acc)
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
        if (acts or (not by_action and r in CLICK_CONTROLS)) and (by_action or takes_click_at(cur, r, spot)):
            try:
                name = withheld_name(cur, (cur.name or "").strip())
            except Exception:
                name = ""
            return {"role": r, "name": name[:200]}
    # Handed on by accessibility to a control further up than Ember looks: what the click works can't be told.
    return {"unknown": True} if by_action else None


# ---------------------------------------------------------------- rows of a list or table

# A cell of a list of rows (GTK's tree view: file dialogs, file and mail lists, a preferences list). Its "activate"
# action is GTK's row-activated, a double click: in a file dialog it opens (or saves as) the row selected before, not
# this one, and in a plain list it may do nothing. A click on it selects its row instead, as a single click does.
ROW_CELL_ROLES = frozenset(["table cell", "tree item"])
# Lists of rows whose options (choose_option) are their rows, named after their first cell with words in it.
ROW_LIST_ROLES = frozenset(["table", "tree table", "tree"])
ROWS_MAX = 5000
# GTK makes a row's cells as they are asked for: a few milliseconds a row, so a folder of a thousand files takes seconds
# (and Ember waits 5 s for an answer). Listing a list's rows stops after LIST_ROWS_S; looking for the row to choose
# after FIND_ROW_S, and for another of the same name after TWIN_ROWS_S from the start.
LIST_ROWS_S = 1.5
FIND_ROW_S = 2.0
TWIN_ROWS_S = 2.5
# What to do instead where a list is too long to look through in time.
TYPE_INSTEAD = "in a long list, type the name instead (in a file dialog: Ctrl+L, or its name field)"
# GTK's own actions on a list's cell (GTK 3's check box cell names them by what they do, after its "toggle").
GTK_CELL_ACTIONS = ("expand or contract", "edit", "activate", "expands or contracts", "creates a widget", "activates")
# A check box in a list of rows (GTK's toggle cell: firewall-config's services, Evolution's accounts): its "toggle"
# action is the row's "activate" (row-activated, a double click), which never ticks the box. Only a click on it does:
# the mouse clicks it, with the user's OK.
LIST_CHECK_BOX = ("background_unavailable: a check box in a list is ticked only by a click on it (its accessible "
                  "action would open its row instead)")
# An item of a grid of icons (GTK's icon view: a file or template browser). Its "activate" action is item-activated, a
# double click (it opens the item); a click selects it instead, as a single click does.
ICON_ROLES = frozenset(["icon"])
ITEM_IN_BACKGROUND = ("background_unavailable: its window isn't the active one, and an icon is chosen as a click "
                      "chooses it (the cursor, which Enter follows, with it) only by bringing the window to the front")


def instead_of_action(acc, names, picked):
    """What a click on acc does where its own action `picked` (of its action `names`) is a double click's (GTK):
    "select row" (a cell of a list of rows, see ROW_CELL_ROLES), "select item" (an icon in a grid, see ICON_ROLES),
    "check box" (a check box in a list, see LIST_CHECK_BOX); None where its action is a click's own. Qt's cells say
    "toggle" alone (it selects them): their action is left to them."""
    try:
        role = acc.getRoleName()
    except Exception:
        return None
    if role in ROW_CELL_ROLES:
        if picked == "toggle":
            others = [n for n in names if n != "toggle"]
            return "check box" if any(n.startswith(GTK_CELL_ACTIONS) for n in others) else None
        return "select row" if picked in ("activate", "expand or contract", "edit") else None
    if role in ICON_ROLES and picked == "activate":
        return "select item"
    return None


def spreadsheet(acc):
    """Is acc a spreadsheet's sheet (as grid_of tells one: its cells made as they are asked for, millions of them, with
    no scroll bar beside it), whose cells aren't rows to choose? GTK's tree view makes its cells as asked for too."""
    try:
        return "manages descendants" in state_names(acc) and acc.childCount > MAX_CHILDREN and scroll_fraction(acc) is None
    except Exception:
        return True


def row_of(acc):
    """(list, its Table interface, the row, the row's cell in the list that acc is or is in) for a cell of a list of
    rows (a cell may be inside another: GTK puts a file's icon and name in one column's cell), or None where the row
    can't be told or chosen by accessibility."""
    top = acc
    try:
        for _ in range(4):
            holder = top.parent
            if holder is None or holder.getRoleName() not in ROW_CELL_ROLES:
                break
            top = holder
        if holder is None or spreadsheet(holder):
            return None
        holder.querySelection()
        t = holder.queryTable()
        row = t.getRowAtIndex(top.getIndexInParent())
    except Exception:
        return None
    return (holder, t, row, top) if row >= 0 else None


def selected_rows(t):
    try:
        return sorted(t.getSelectedRows())
    except Exception:
        return None


# Why a row of a list in a window the user isn't in isn't chosen by accessibility: the mouse does it, with their OK.
ROW_IN_BACKGROUND = ("background_unavailable: its window isn't the active one, and a row is chosen as a click chooses "
                     "it (the list's cursor, which Enter and the app follow, with it) only by bringing the window to the front")


def focuses_rows(holder):
    """Is a row of list `holder` chosen by its cell's grabFocus (see choose_row): True in a window that is active, False
    in one that isn't (the user is elsewhere: choosing would bring it to the front), None where it isn't asked (a web
    page's list, whose focus is no click) or that can't be told."""
    if holder is None or web_engine(holder):
        return None
    return window_active(holder)


def row_has_cursor(holder, t, row):
    """Has row `row` of list `holder` (Table `t`) the list's cursor? One of its cells says it has the keyboard
    ("focused"; GTK says "active" too), as the cursor's cell does while the list has the keyboard."""
    try:
        cols = min(t.nColumns, 8)
    except Exception:
        return False
    for c in range(cols):
        cell = table_cell_at(holder, row, c)
        if cell is not None and ("focused" in state_names(cell) or "active" in state_names(cell)):
            return True
    return False


def choose_row(t, row, holder=None, cell=None):
    """Selects `row` alone in a list (Table `t`), as a single click on it does: the rows selected before are
    unselected (a list that lets several be chosen would keep them: a file dialog would open those too), and the list's
    cursor goes there, which Enter (row-activated) and some apps follow (LibreOffice's Options shows the page of the
    row its tree's cursor is on). The row's `cell` in `holder` (the list) is given the keyboard: GTK's tree view moves its
    cursor and selection there together, as a click does, and never opens it. Only in the active window (see
    focuses_rows): elsewhere that brings the window to the front, so it is left to the mouse (ROW_IN_BACKGROUND). Where
    the cell won't take the keyboard (or isn't asked: a web page's list), the Table selects the row (the cursor stays
    where it was). Returns (it is the one selected now, it was already); background_unavailable where it can't be
    selected at all."""
    focus = focuses_rows(holder) if cell is not None else None
    if selected_rows(t) == [row] and (focus is not True or row_has_cursor(holder, t, row)):
        return True, True
    if focus is False:
        raise RuntimeError(ROW_IN_BACKGROUND)
    if focus:
        try:
            took = bool(on_link(cell.queryComponent(), "GrabFocus", (), lambda: cell.queryComponent().grabFocus()))
        except Exception:
            took = False
        if took:
            settle()
            if selected_rows(t) == [row] and row_has_cursor(holder, t, row):
                return True, False
    if row not in (selected_rows(t) or []):
        on_link(t, "AddRowSelection", (row,), lambda: t.addRowSelection(row))
        settle()
        if row not in (selected_rows(t) or []):
            raise RuntimeError("background_unavailable: its row can't be selected by accessibility")
    for other in selected_rows(t) or []:
        if other != row:
            on_link(t, "RemoveRowSelection", (other,), lambda: t.removeRowSelection(other))
    settle()
    return selected_rows(t) == [row], False


def item_of(acc):
    """(the grid of icons acc is in, its Selection, acc's index there), or None where it can't be chosen by
    accessibility (no Selection)."""
    try:
        holder = acc.parent
        if holder is None:
            return None
        sel = holder.querySelection()
        index = acc.getIndexInParent()
    except Exception:
        return None
    return (holder, sel, index) if index >= 0 else None


def choose_item(acc, holder, sel, index):
    """Selects icon `acc` (child `index` of grid `holder`, Selection `sel`) alone, as a single click does, and never
    opens it: its grabFocus moves the grid's cursor there (where Enter goes), and the Selection selects it alone. Only in
    the active window (see focuses_rows): elsewhere that brings the window to the front, so it is left to the mouse
    (ITEM_IN_BACKGROUND). Returns whether it is the one selected now; background_unavailable where it can't be selected."""
    def alone():
        try:
            return sel.nSelectedChildren == 1 and sel.isChildSelected(index)
        except Exception:
            return False
    focus = focuses_rows(holder)
    if alone() and (focus is not True or "focused" in state_names(acc)):
        return True
    if focus is False:
        raise RuntimeError(ITEM_IN_BACKGROUND)
    if focus:
        try:
            on_link(acc.queryComponent(), "GrabFocus", (), lambda: acc.queryComponent().grabFocus())
        except Exception:
            pass
        settle()
    if not alone():
        try:
            on_link(sel, "ClearSelection", (), lambda: sel.clearSelection())
            on_link(sel, "SelectChild", (index,), lambda: sel.selectChild(index))
        except Exception:
            pass
        settle()
        try:
            if not sel.isChildSelected(index):
                raise RuntimeError("background_unavailable: it can't be selected by accessibility")
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError("background_unavailable: it can't be selected by accessibility")
    return alone()


# How many fields inside a list of options are looked at for secrets (see secret_values_in).
LIST_FIELDS = 64


def fields_within(acc, limit=LIST_FIELDS):
    """The input fields inside acc, shown or not, found by a web page itself (one call: see WEB_TOOLKITS); [] elsewhere."""
    if not web_engine(acc):
        return []
    try:
        roles = [getattr(Atspi.Role, r.upper().replace(" ", "_")) for r in sorted(FIELD_ROLES)
                 if hasattr(Atspi.Role, r.upper().replace(" ", "_"))]
        rule = Atspi.MatchRule.new(Atspi.StateSet.new([]), Atspi.CollectionMatchType.ALL, {}, Atspi.CollectionMatchType.ALL,
                                   roles, Atspi.CollectionMatchType.ANY, [], Atspi.CollectionMatchType.ALL, False)
        return list(Atspi.Collection.get_matches(acc, rule, Atspi.CollectionSortOrder.CANONICAL, limit, True))
    except Exception:
        return []


def secret_values_in(acc):
    """What the secret fields inside a list or grid hold (squashed, see secret_values; never reported). A web page
    names its options and cells after what is in them (Chromium names a grid's cell after the card number typed in its
    input): a name that says one of these is withheld (see said_name). Elsewhere names are given, never made from what
    fields hold, and nothing is asked."""
    values = []
    for f in fields_within(acc):
        try:
            role = f.getRoleName()
            name = (f.name or "").strip()
        except Exception:
            continue
        if is_secret(f, role, name):
            values.extend(secret_values(f, role))
    return values


def said_name(acc, name, values=(), elsewhere=()):
    """An option's or a row's name (acc's, where it is known) as it may be reported: none where it says what a secret
    field holds (see WITHHELD; `values`: what the secret fields around it hold, see secret_values_in; `elsewhere`: what
    the user put in the secret fields of the app's last read, said as words of their own, see values_known)."""
    if acc is not None:
        name = withheld_name(acc, name)
    return "" if (values and holds_value(name, values)) or says_value(name, elsewhere) else name


def cell_words(cell, depth=0):
    """What a cell says: its name, or the first name in a cell inside it (GTK's icon and file name in one column). Never
    a name that says what a secret field holds (see WITHHELD), nor anything in a secret field (a web grid's card number
    input in its cell: its text is its value)."""
    if cell is None:
        return ""
    try:
        name = (cell.name or "").strip()
        if is_secret(cell, cell.getRoleName(), name):
            return ""
        name = withheld_name(cell, name)
        if name or depth >= 2:
            return name
        for i in range(min(cell.childCount, 4)):
            inner = cell_words(cell.getChildAtIndex(i), depth + 1)
            if inner:
                return inner
    except Exception:
        pass
    return ""


def words_in(cell):
    """What a cell says (see cell_words: never what a secret field holds), and where: None for the cell itself, else
    the index of its child that says it (or holds what does)."""
    words = cell_words(cell)
    if not words or cell_words(cell, 2) == words:
        return words, None
    try:
        for i in range(min(cell.childCount, 4)):
            if cell_words(cell.getChildAtIndex(i), 1) == words:
                return words, i
    except Exception:
        pass
    return words, None


def row_name(table, row, ncols, where=None):
    """What row `row` of a list of rows says (its first cell with words in it, see cell_words), and where they were:
    (column, see words_in). `where`: where the row before had them, asked first (a list's rows are alike: a few calls
    to the app, where finding them takes a dozen; GTK's file list holds a file's name in its first column's second
    cell). Asked there as cell_words asks: never a secret field's words."""
    if where is not None:
        col, kid = where
        cell = table_cell_at(table, row, col)
        try:
            # A cell found secret (see SECRETS) says nothing, nor does what is in it.
            at = cell if kid is None or cell is None or is_secret(cell, "table cell", "") else cell.getChildAtIndex(kid)
            name = cell_words(at, 2) if at is not cell or kid is None else ""
        except Exception:
            name = ""
        if name:
            return name, where
    for c in range(min(ncols, 8)):
        name, kid = words_in(table_cell_at(table, row, c))
        if name:
            return name, (c, kid)
    return "", where


def row_table(acc):
    """A list of rows whose rows are its options (see ROW_LIST_ROLES): (its Table interface, how many rows and
    columns it has), or None for anything else. Only one whose rows can be selected (a Selection), never a
    spreadsheet's sheet."""
    try:
        if acc.getRoleName() not in ROW_LIST_ROLES or spreadsheet(acc):
            return None
        acc.querySelection()
        t = acc.queryTable()
        nrows, ncols = t.nRows, t.nColumns
    except Exception:
        return None
    if nrows < 0 or ncols <= 0:
        return None
    return t, nrows, ncols


def row_list(acc, seconds=None):
    """A list of rows whose rows are its options (see row_table): (its Table interface, the names of its rows from the
    first, after their first cell with words in it, and how many rows it has), or None for anything else. Rows are
    named for `seconds` at most (see LIST_ROWS_S), ROWS_MAX at most: the rest are left out. BUSY where the app stops
    answering."""
    found = row_table(acc)
    if found is None:
        return None
    t, nrows, ncols = found
    budget = Budget(LIST_ROWS_S if seconds is None else seconds)
    names, where = [], None
    for r in range(min(nrows, ROWS_MAX)):
        if budget.tick():
            break
        name, where = row_name(acc, r, ncols, where)
        names.append(name)
    if budget.busy and len(names) < nrows:
        raise RuntimeError(BUSY)
    return t, names, nrows


def find_row(acc, rows, want):
    """The row of a list of rows (see row_table: `rows`) called `want` (as option_index finds an option), as (its
    index, its name, how many rows after it weren't checked for another of that name). Rows are named from the first
    until the first one called that (FIND_ROW_S at most), then the rest are checked for another one of that name
    (TWIN_ROWS_S from the start at most). ValueError where none is (or none within the time: then what to do
    instead), or several are."""
    t, nrows, ncols = rows
    want = want.strip()
    count = min(nrows, ROWS_MAX)
    start = time.monotonic()
    budget = Budget(FIND_ROW_S)
    names, where, index = [], None, None
    for r in range(count):
        if budget.tick():
            break
        name, where = row_name(acc, r, ncols, where)
        names.append(name)
        if want and name == want:
            index = r
            break
    if budget.busy:
        raise RuntimeError(BUSY)
    if index is None:
        if len(names) < nrows:
            raise ValueError("Ember looked through the list's first %d rows of %d in time and none is called exactly "
                             "that: %s" % (len(names), nrows, TYPE_INSTEAD))
        index = option_index(names, want)
        if index is None:
            raise ValueError("no option has exactly that name (it has %d options); list them and use one in full" % nrows)
    # Another row of that name (but for case): the two can't be told apart.
    same = names[index].lower()
    twins = sum(1 for n in names if n.lower() == same)
    budget = Budget(max(0.0, start + TWIN_ROWS_S - time.monotonic()))
    for r in range(len(names), count):
        if twins > 1 or budget.tick():
            break
        name, where = row_name(acc, r, ncols, where)
        names.append(name)
        twins += name.lower() == same
    if twins > 1:
        raise ValueError("several rows are called that; click a cell of the one meant instead")
    return index, names[index], nrows - len(names)


def can_do(params):
    """Could `kind` ("click", "toggle", "text" or "value") be done on element `id` by accessibility? Checked as
    do_action, set_text and set_value check it, and nothing is done: Ember asks the user only the question that
    applies (to borrow the mouse, where that is the only way). With `caret`: whether the element has the keyboard
    (`focused`) and its window is the active one (`windowActive`), for text typed where the caret is. For a click:
    `action`, the action that would do it, and `handler`, the control around the element the click goes to (see
    click_handler), which is what the user is asked about. Where a click does something else than the element's own
    action (see instead_of_action), `action` says what: "select row" or "select item" (a toggle there turns nothing on
    or off), or "toggle" with no tier 1 (a check box in a list: the mouse clicks it)."""
    nid = int(params["id"])
    acc = SNAPSHOTS.get(nid)
    kind = params.get("kind")
    out = {"tier1": True}
    picked = None
    try:
        if kind in ("click", "toggle"):
            _, names, index = pick_action(acc, kind)
            picked = out["action"] = names[index]
            instead = instead_of_action(acc, names, picked)
            if instead == "check box":
                # Ticked by a click on it alone (see LIST_CHECK_BOX): the mouse does it.
                out["action"], picked = "toggle", None
                raise RuntimeError(LIST_CHECK_BOX)
            if instead == "select row":
                out["action"] = "select row"
                if kind == "click":
                    # The click selects its row (see select_row), where accessibility can.
                    found = row_of(acc)
                    if found is None:
                        raise RuntimeError("background_unavailable: its row can't be selected by accessibility")
                    holder, t, row, _ = found
                    # A click selects its row, by accessibility or (its window in the background) with the mouse.
                    if selected_rows(t) != [row] and focuses_rows(holder) is False:
                        raise RuntimeError(ROW_IN_BACKGROUND)
            elif instead == "select item":
                out["action"] = "select item"
                if kind == "click":
                    found = item_of(acc)
                    if found is None:
                        raise RuntimeError("background_unavailable: it can't be selected by accessibility")
                    holder, sel, index = found
                    if focuses_rows(holder) is False and not (sel.nSelectedChildren == 1 and sel.isChildSelected(index)):
                        raise RuntimeError(ITEM_IN_BACKGROUND)
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
        if handler is not None and handler.get("unknown"):
            out["handlerUnknown"] = True
        elif handler is not None:
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
    # Never an action that is a double click's (see instead_of_action): what a click does instead, or nothing.
    instead = instead_of_action(acc, names, names[index])
    if instead == "check box":
        raise RuntimeError(LIST_CHECK_BOX)
    if instead is not None and want != "click":
        raise RuntimeError("element %s is no switch or check box: a click on it only selects it" % nid)
    if instead == "select row":
        return select_row(acc, nid)
    if instead == "select item":
        return select_item(acc, nid)
    before = node_info(acc, nid)
    ok = on_link(act, "DoAction", (index,), lambda: act.doAction(index))
    settle()
    res = after_action(acc, nid)
    res.update({"ok": bool(ok), "action": names[index], "before": before})
    return res


def select_row(acc, nid):
    """A click on a cell of a list of rows: its row is selected alone (see ROW_CELL_ROLES, choose_row), and "ok" says
    whether it is now; background_unavailable where that can't be done by accessibility (the mouse clicks it)."""
    found = row_of(acc)
    if found is None:
        raise RuntimeError("background_unavailable: its row can't be selected by accessibility")
    holder, t, row, top = found
    before = node_info(acc, nid)
    ok, _ = choose_row(t, row, holder, top)
    res = after_action(acc, nid)
    res.update({"ok": ok, "action": "select row", "before": before})
    return res


def select_item(acc, nid):
    """A click on an icon in a grid of them: it is selected alone (see ICON_ROLES, choose_item), and "ok" says whether
    it is now; background_unavailable where that can't be done by accessibility (the mouse clicks it)."""
    found = item_of(acc)
    if found is None:
        raise RuntimeError("background_unavailable: it can't be selected by accessibility")
    before = node_info(acc, nid)
    ok = choose_item(acc, *found)
    res = after_action(acc, nid)
    res.update({"ok": ok, "action": "select item", "before": before})
    return res


def set_text(params):
    nid = int(params["id"])
    acc = usable(nid)
    refuse_secret(acc)
    text = params.get("text", "")
    mode = params.get("mode", "replace")
    et = editable_text(acc)
    if mode == "replace":
        ok = on_link(et, "SetTextContents", (text,), lambda: et.setTextContents(text))
    else:
        t = acc.queryText()
        offset = t.characterCount if mode == "append" else max(0, t.caretOffset)
        ok = on_link(et, "InsertText", (offset, text, len(text)), lambda: et.insertText(offset, text, len(text)))
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
    on_link(v, "CurrentValue", (value,), lambda: setattr(v, "currentValue", value))
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
    """The name of the option a combo box shows as chosen, or None (see chosen_item)."""
    return chosen_item(acc)[1]


def chosen_item(acc):
    """The option a combo box shows as chosen, and its name ((None, None) without one): asked of the Selection of its
    list of options (a web page's drop-down), else its own (GTK's), a few calls; the options aren't looked through one
    by one."""
    try:
        holder = option_holder(acc)
    except Exception:
        return None, None
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
            return item, name
    return None, None


def combo_shows(acc):
    """What a combo box shows: its chosen option, else what its text field holds (GTK's combo box with an entry)."""
    chosen = chosen_option(acc)
    if chosen:
        return chosen
    try:
        count = acc.childCount
        for i in range(min(count, 2)):
            child = acc.getChildAtIndex(i)
            if child is not None and child.getRoleName() in ("text", "entry"):
                return (text_of(child) or "").strip() or None
    except Exception:
        pass
    return None


def option_chosen(sel, holder, index):
    """Is option `index` the chosen one now?"""
    try:
        return bool(sel.isChildSelected(index)) or "selected" in state_names(holder.getChildAtIndex(index))
    except Exception:
        return False


def option_items(acc):
    """The names of a combo box's or list's options: the children its Selection chooses among, an unnamed one by the
    label inside it (GTK's list row), as a read names it; a list of rows' rows (see row_list). Never a secret
    element's (its options say what it holds), nor a name that says what a secret field holds (see said_name): those
    are listed nameless."""
    refuse_secret(acc)
    values, elsewhere = secret_values_in(acc), values_known(acc)
    rows = row_list(acc)
    if rows is not None:
        return [said_name(None, n, values, elsewhere) for n in rows[1]]
    holder = option_holder(acc)
    if option_selection(acc, holder) is None:
        raise RuntimeError("background_unavailable: this element has no selectable options")
    names = []
    for i in range(min(holder.childCount, 500)):
        c = holder.getChildAtIndex(i)
        if c is None:
            names.append("")
            continue
        name = (c.name or "").strip()
        names.append("" if is_secret(c, c.getRoleName(), name) else said_name(c, name or inner_label(c), values, elsewhere))
    return names


INNER_LABEL_LEVELS = 4


def inner_label(acc, level=1):
    """The first label with a letter or digit in it inside acc, a few levels down (GTK's list row holds its label).
    Keep in step with inferLabels in elements.ts."""
    try:
        count = min(acc.childCount, 16)
    except Exception:
        return ""
    for i in range(count):
        c = child_at(acc, i)
        if c is None:
            continue
        try:
            if c.getRoleName() in LABEL_ROLES:
                name = (c.name or "").strip()
                if any(ch.isalnum() for ch in name):
                    return name
        except Exception:
            continue
        if level < INNER_LABEL_LEVELS:
            name = inner_label(c, level + 1)
            if name:
                return name
    return ""


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
    rows = row_table(acc)
    if rows is not None:
        # A row, selected alone as a click on it does (choose_row): two of that name can't be told apart (find_row).
        index, name, unchecked = find_row(acc, rows, str(params.get("option", "")))
        try:
            ok, already = choose_row(rows[0], index, acc, table_cell_at(acc, index, 0))
        except RuntimeError as err:
            if str(err) != ROW_IN_BACKGROUND:
                raise
            # The mouse does it: a click on the row's cell (which Ember does with the mouse, with the user's OK).
            raise RuntimeError("its window isn't the active one, and choosing a row there by name would bring it to the "
                               "front: click a cell of that row instead")
        res = after_action(acc, nid)
        res.update({"ok": ok, "option": name})
        if already:
            res["already"] = True
        if unchecked > 0:
            # A long list: the rows after these weren't looked through for another of that name in time.
            res["unchecked"] = unchecked
        return res
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
    ok = bool(on_link(sel, "SelectChild", (index,), lambda: sel.selectChild(index)))
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
            on_link(act, "DoAction", (i,), lambda: act.doAction(i))
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
            on_link(act, "DoAction", (i,), lambda: act.doAction(i))
            settle()
    except Exception:
        pass


def list_options(params):
    """A combo box's or list's options (see option_items). `left`: how many rows of a long list of rows weren't named
    in time (see row_list), whose names aren't among them."""
    acc = SNAPSHOTS.get(int(params["id"]))
    options = option_items(acc)
    out = {"options": options}
    rows = row_table(acc)
    if rows is not None and rows[1] > len(options):
        out["left"] = rows[1] - len(options)
    return out


def focus(params):
    acc = usable(int(params["id"]))
    ok = on_link(acc.queryComponent(), "GrabFocus", (), lambda: acc.queryComponent().grabFocus())
    settle()
    return {"ok": bool(ok), "after": node_info(acc)}


def cell_formula(acc):
    """A spreadsheet cell's formula as LibreOffice Calc tells it (its "Formula" attribute, without the "="; "" for a
    cell without one), or None where it isn't told. Calc shows a formula that works out to an error (#DIV/0!, #N/A)
    as no text at all: its formula says it went in."""
    try:
        attrs = acc.getAttributes()
    except Exception:
        return None
    pairs = attrs.items() if isinstance(attrs, dict) else (a.partition(":")[::2] for a in attrs or [])
    for key, value in pairs:
        if key == "Formula":
            return value
    return None


def read_element(params):
    """The element as it is now. With `shown` asked for (where the mouse is to aim): the part of it that shows, where
    some of it is scrolled out of view or lies outside its window (a few more calls to the app). With `formula`, for a
    spreadsheet's cell whose text is told: its formula (see cell_formula), never a secret one's."""
    nid = int(params["id"])
    acc = SNAPSHOTS.get(nid)
    info = node_info(acc, nid)
    shown = visible_part(acc, info.get("bounds")) if params.get("shown") else None
    if shown is not None:
        info["shown"] = shown
    if params.get("formula") and info.get("role") == "table cell" and not info.get("secret") and "text" in info:
        formula = cell_formula(acc)
        if formula is not None:
            info["formula"] = formula[:2000]
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
    when nothing of it shows. A web page's content is clipped by its page (and a frame's by its frame), never by
    what holds the page: on a HiDPI screen Chromium's window reports logical pixels around a page that reports
    physical ones (Ember clips by the window itself, in its own units: Worker.landingSpot)."""
    if bounds is None:
        return None
    shown, cur = bounds, acc
    try:
        web = acc.getRoleName() in DOCUMENT_ROLES
    except Exception:
        web = False
    for _ in range(AT_POINT_LEVELS):
        try:
            parent = cur.parent
            role = parent.getRoleName() if parent is not None else "application"
        except Exception:
            break
        if role == "application":
            # cur is the window: what lies outside its frame doesn't show either.
            if cur is not acc and not web:
                shown = clip_to(shown, extents(cur))
            break
        if role in DOCUMENT_ROLES:
            # The page (or a frame in it) clips what is in it, in the page's own units.
            shown = clip_to(shown, extents(parent))
            web = True
        elif role in CLIP_ROLES and not web:
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
# top few levels of containers and menu bars (never inside its documents, lists or tables). LibreOffice 24.2 (gtk3)
# keeps its menu bar in a scroll pane's viewport, five levels down: frame > panel > panel > scroll pane > viewport.
MENU_HOLDERS = frozenset(["filler", "panel", "root pane", "layered pane", "glass pane", "menu bar", "split pane",
                          "unknown", "scroll pane", "viewport"])
MENU_DEPTH = 6
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


def secret_around(el, top):
    """The secret field `el` is in, below `top` (where it was looked for), or None: the levels between, when the app
    answered with an element further down than a child of `top` (Chromium's deepest element). A few calls a level."""
    cur = el
    for _ in range(AT_POINT_LEVELS):
        try:
            cur = cur.parent
            if cur is None or same_object(cur, top):
                return None
            role = cur.getRoleName()
            name = (cur.name or "").strip()
        except Exception:
            return None
        if role in TEXT_ROLES and is_secret(cur, role, name):
            return cur
    return None


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
    chain, accs, noted = [], [], []
    # Names found to say what a secret field holds (see WITHHELD) are left out: the app's, by object path. So are a web
    # page's that may say what a secret field holds that isn't at the point (see name_says_secret): CONTENTS_S for all.
    bus = (object_key(acc) or ("",))[0]
    until = [None]

    def name_of(el, name, role):
        key = (bus, getattr(el, "path", None))
        if not name or (WITHHELD.keys and key in WITHHELD):
            return ""
        until[0] = until[0] or time.monotonic() + CONTENTS_S
        if name_says_secret(el, role, name, until[0]):
            WITHHELD.add(key)
            noted.append(list(key))
            return ""
        return name[:200]
    # The app's own popup (a drop-down's list), or an open menu, lies over its windows: what shows there is in it.
    # (`menus`: false when Ember knows none of the app's popup windows is there: a big app's menus cost dozens of calls.)
    popup = popup_at(app, acc, x, y, budget)
    over = [popup] if popup is not None else open_menu_at(acc, x, y, budget) if params.get("menus", True) is not False else []
    for el in over:
        try:
            role, name = el.getRoleName(), (el.name or "").strip()
        except Exception:
            role, name = "", ""
        chain.append({"role": role, "name": name_of(el, name, role), "bounds": extents(el)})
        accs.append(el)
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
        # Chromium answers with the deepest element there: a secret drop-down's option, a secret text box's text.
        holder = secret_around(step[-1], acc)
        if holder is not None:
            step = [holder]
        for el in step:
            try:
                role, name = el.getRoleName(), (el.name or "").strip()
            except Exception:
                role, name = "", ""
            # A secret field: neither its name nor what is in it (Chromium's text children hold its contents) leaves,
            # and nothing in it is looked at.
            secret = role in TEXT_ROLES and is_secret(el, role, name)
            node = {"role": role, "name": "" if secret else name_of(el, name, role), "bounds": extents(el)}
            if secret:
                node["secret"] = True
                # Nor do the names of what holds it that say what it holds (see withhold_names).
                values = secret_values(el, role) if any(n["name"] for n in chain) else []
                for n, held in zip(chain, accs):
                    if n["name"] and says_secret(held, n["name"], None, values, False):
                        n["name"] = ""
                        WITHHELD.add((bus, getattr(held, "path", None)))
                        noted.append([bus, getattr(held, "path", None)])
            chain.append(node)
            accs.append(el)
            if secret:
                break
        if secret:
            break
        acc = step[-1]
    if chain and not secret and dead_end(acc):
        chain[-1]["empty"] = True
    out = {"chain": chain, "ms": int((time.time() - t0) * 1000)}
    if noted:
        out["withheldKeys"] = noted
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


# ---------------------------------------------------------------- links (requests that run the app's own code)

# A GTK app does what a button or menu item does while it handles Ember's request, and a modal dialog opened there with
# gtk_dialog_run (Mousepad's File ▸ Save As…, an "Attach…" button) runs inside that handling: until the dialog closes,
# nothing more on the connection the request came on is answered. Once anything waits on that connection (a request,
# or the connection closing), the first key typed in the dialog hangs the app for good (at-spi2-atk's key snooper
# dispatches every connection again from inside, and that one can't be). So a request that runs the app's own code (an
# action, text put in, an option, a value or the keyboard given) goes on a link: a private connection to the app's
# own address (at-spi2-atk's, see link_address), never on Ember's own, which only reads. A holder process (see
# hold_main) keeps each link open, with nothing more sent on it, until the app is gone or shows no modal window any
# more (nothing of it waits on the link's request then); a link closed earlier is what hangs the app.
import array  # noqa: E402
import select  # noqa: E402
import socket  # noqa: E402
import subprocess  # noqa: E402

Gio = GLib = None
if Atspi is not None:
    try:
        from gi.repository import Gio, GLib
    except Exception:
        Gio = GLib = None


def load_links():
    """Gio and GLib for the links, as above: inside WSL (EMBER_ATSPI_FIND_BUS) once find_bus has loaded libatspi."""
    global Gio, GLib
    if Gio is None and Atspi is not None:
        try:
            from gi.repository import Gio as gio, GLib as glib
            Gio, GLib = gio, glib
        except Exception:
            Gio = GLib = None

# The requests that go on a link: (D-Bus interface, method, argument types, answer types).
LINK_CALLS = {
    "DoAction": ("org.a11y.atspi.Action", "DoAction", "(i)", "(b)"),
    "SetTextContents": ("org.a11y.atspi.EditableText", "SetTextContents", "(s)", "(b)"),
    "InsertText": ("org.a11y.atspi.EditableText", "InsertText", "(isi)", "(b)"),
    "SelectChild": ("org.a11y.atspi.Selection", "SelectChild", "(i)", "(b)"),
    "ClearSelection": ("org.a11y.atspi.Selection", "ClearSelection", "()", "(b)"),
    "AddRowSelection": ("org.a11y.atspi.Table", "AddRowSelection", "(i)", "(b)"),
    "RemoveRowSelection": ("org.a11y.atspi.Table", "RemoveRowSelection", "(i)", "(b)"),
    "GrabFocus": ("org.a11y.atspi.Component", "GrabFocus", "()", "(b)"),
    "CurrentValue": ("org.freedesktop.DBus.Properties", "Set", "(ssv)", "()"),
}
ROOT_PATH = "/org/a11y/atspi/accessible/root"
# at-spi2-atk answers an action before doing it, and the rest once done: no answer by then is a busy app.
LINK_TIMEOUT_MS = CALL_TIMEOUT_MS
# How long the holder may take to say it has a link (it starts with the first one), well within the time Ember gives a
# request (5 s): one that takes longer is let be, and the link kept here (see hold_link).
HOLDER_START_S = 2.0
# The holder looks at the apps whose links it keeps this often (the first look a while after a link came), each look
# waiting this long for an answer; links go once their app shows no modal window on this many looks in a row.
HOLD_LOOK_S = 1.0
HOLD_ASK_MS = 500
HOLD_CLEAR_LOOKS = 2
# The holder ends after this long with no link to keep (the sidecar starts a new one for its next link).
HOLD_IDLE_S = 30.0
# AT-SPI's state numbers (AtspiStateType) for a modal window that shows.
STATE_MODAL = 16
STATE_SHOWING = 25
LINK_APPS = 256  # apps whose own address is remembered
HOLDER_SCRIPT = os.path.abspath(__file__)

A11Y_BUS = []  # the accessibility bus (a Gio connection of the links' own), once connected
LINK_ADDRESSES = OrderedDict()  # app bus name -> its own address ("": it has none)
HOLDER = []  # the holder process and the socket links are handed to it on, once started
KEPT = []  # links the holder couldn't take: kept open here instead, until this process ends


def a11y_bus():
    """The accessibility bus, where an app is asked for its own address: a Gio connection kept for this (libatspi's
    isn't to be had). Its address as libatspi finds it: AT_SPI_BUS_ADDRESS, else asked of the session bus (never one
    started for it). None without one."""
    if A11Y_BUS and not A11Y_BUS[0].is_closed():
        return A11Y_BUS[0]
    del A11Y_BUS[:]
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    address = os.environ.get("AT_SPI_BUS_ADDRESS")
    if not address:
        session_address = os.environ.get("DBUS_SESSION_BUS_ADDRESS")
        if not session_address:
            return None
        session = Gio.DBusConnection.new_for_address_sync(session_address, flags, None, None)
        try:
            address = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None,
                                        GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, LINK_TIMEOUT_MS,
                                        None).unpack()[0]
        finally:
            session.close_sync(None)
    A11Y_BUS.append(Gio.DBusConnection.new_for_address_sync(address, flags, None, None))
    return A11Y_BUS[0]


def link_address(bus_name):
    """App `bus_name`'s own address (at-spi2-atk's, the one libatspi reads it on), asked once over the accessibility
    bus; "" where it has none (Qt's bridge, an app that couldn't make one) or can't be asked now (asked again next time)."""
    address = LINK_ADDRESSES.get(bus_name)
    if address is not None:
        return address
    try:
        bus = a11y_bus()
    except Exception:
        bus = None
    if bus is None:
        return ""
    try:
        address = bus.call_sync(bus_name, ROOT_PATH, "org.a11y.atspi.Application", "GetApplicationBusAddress", None,
                                GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, LINK_TIMEOUT_MS,
                                None).unpack()[0]
    except GLib.Error as err:
        if timed_out_call(err):
            return ""
        address = ""  # no such method (or app): one with no address of its own
    except Exception:
        return ""
    LINK_ADDRESSES[bus_name] = address
    while len(LINK_ADDRESSES) > LINK_APPS:
        LINK_ADDRESSES.popitem(last=False)
    return address


def timed_out_call(err):
    """Is Gio error `err` a call that got no answer in time?"""
    return getattr(err, "domain", None) == "g-io-error-quark" and getattr(err, "code", None) == Gio.IOErrorEnum.TIMED_OUT


def open_link(acc):
    """A link to acc's app (see the section's comment): (its Gio connection, the app's bus name, process id and own
    address), or None where there can be none (no Gio, an app with no address of its own, one that isn't the process
    libatspi names, a stand-in): the request then goes on Ember's own connection, as libatspi sends it."""
    if Gio is None or not native(acc):
        return None
    bus_name = None
    try:
        bus_name = acc.app.bus_name
        address = link_address(bus_name)
        if not address:
            return None
        pid = acc.get_process_id()
        conn = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT, None, None)
    except Exception:
        LINK_ADDRESSES.pop(bus_name, None)  # the app may have gone: asked again next time
        return None
    try:
        peer = conn.get_stream().get_socket().get_credentials().get_unix_pid()
    except Exception:
        peer = None
    if peer != pid:
        conn.close_sync(None)
        LINK_ADDRESSES.pop(bus_name, None)
        return None
    return conn, bus_name, pid, address


def holder():
    """The holder's control socket (see hold_main); the process is started with the first link. None if it can't be."""
    if HOLDER and HOLDER[0].poll() is None:
        return HOLDER[1]
    drop_holder()
    mine = theirs = None
    try:
        mine, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        # Its own session: it outlives this process (killed when a request takes too long) while it keeps links.
        # (Inside WSL, isolated like this process: python3 -I, its folder and the user's site-packages off the path.)
        isolated = ["-I"] if FIND_BUS else []
        proc = subprocess.Popen([sys.executable] + isolated + [HOLDER_SCRIPT, "--hold", str(theirs.fileno())],
                                pass_fds=(theirs.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True, cwd="/")
    except Exception:
        if mine is not None:
            mine.close()
        return None
    finally:
        if theirs is not None:
            theirs.close()
    HOLDER.extend([proc, mine])
    return mine


def drop_holder():
    """Stops handing links to the holder (it keeps those it has, and ends once they are let go)."""
    if HOLDER:
        try:
            HOLDER[1].close()
        except Exception:
            pass
    del HOLDER[:]


def hold_link(conn, pid, address):
    """Hands link `conn` (to app `pid`, at its own `address`) to the holder, which keeps it open from now on: True once
    it says it has it. Else it is kept open here (KEPT) until this process ends, and False."""
    fd = conn.get_stream().get_socket().get_fd()
    note = json.dumps({"pid": pid, "address": address}).encode("utf-8")
    for _ in range(2):
        ctrl = holder()
        if ctrl is None:
            break
        try:
            ctrl.sendmsg([note], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])
            answer = ctrl.recv(16) if select.select([ctrl], [], [], HOLDER_START_S)[0] else None
        except OSError:
            answer = b""
        if answer == b"ok":
            return True
        drop_holder()
        if answer is None:
            break  # too slow: it keeps what it took, and the next link goes to a new one
        # It had ended (idle, see hold_main) without taking it: a new one takes it (this end is still open).
    KEPT.append(conn)
    return False


def on_link(acc, method, args, fallback):
    """Request `method` (see LINK_CALLS) with `args` of acc (an element, or one of pyatspi's interfaces of it), sent on a
    link (see open_link) and answered as libatspi answers it (for an action: whether it was taken); `fallback()`
    (libatspi's own call, on Ember's connection) where there can be no link. The link is handed to the holder before
    anything is sent on it. An app that doesn't answer in time may still do it."""
    target = getattr(acc, "obj", acc)
    link = open_link(target)
    if link is None:
        return fallback()
    conn, bus_name, pid, address = link
    held = hold_link(conn, pid, address)
    iface, member, types, answer = LINK_CALLS[method]
    if method == "CurrentValue":
        args = ("org.a11y.atspi.Value", "CurrentValue", GLib.Variant("d", float(args[0])))
    try:
        reply = conn.call_sync(bus_name, target.path, iface, member, GLib.Variant(types, tuple(args)),
                               GLib.VariantType(answer), Gio.DBusCallFlags.NO_AUTO_START, LINK_TIMEOUT_MS, None)
    except GLib.Error as err:
        if timed_out_call(err):
            raise RuntimeError("the app did not answer in time (it may still do it)")
        raise RuntimeError(err.message)
    finally:
        if held:
            try:
                conn.close_sync(None)  # this end only: the holder's stays open
            except Exception:
                pass
    out = reply.unpack()
    return out[0] if out else True


def hold_main(fd):
    """The holder: takes links from the sidecar on control socket `fd` (one per message, with its app's process id and
    own address; answered "ok") and keeps them open, with nothing sent on them, until their app is gone or no modal
    window of it shows on HOLD_CLEAR_LOOKS looks in a row (see look_at_app): then they are let go. Ends once none is
    left and the sidecar has gone (the control socket closed) or sent none for HOLD_IDLE_S (it starts a new one)."""
    ctrl = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET, 0, fd)
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_NOFILE, (resource.getrlimit(resource.RLIMIT_NOFILE)[1],) * 2)
    except Exception:
        pass
    apps = {}  # app pid -> {"fds", "address", "since" (its latest link came), "clear" (looks in a row), "ask"}
    listening = True
    look_at = time.monotonic() + HOLD_LOOK_S
    while listening or apps:
        wait = max(0.0, look_at - time.monotonic()) if apps else HOLD_IDLE_S
        if listening:
            if select.select([ctrl], [], [], wait)[0]:
                listening = take_link(ctrl, apps)
            elif not apps:
                return  # idle
        else:
            time.sleep(wait)
        if apps and time.monotonic() >= look_at:
            for pid in list(apps):
                if look_at_app(pid, apps[pid]):
                    let_go(apps.pop(pid))
            look_at = time.monotonic() + HOLD_LOOK_S


def take_link(ctrl, apps):
    """Takes one link from the control socket into `apps` (see hold_main) and says so; False once the sidecar has gone."""
    try:
        data, anc, _, _ = ctrl.recvmsg(4096, socket.CMSG_SPACE(4 * array.array("i").itemsize))
    except OSError:
        return False
    fds = array.array("i")
    for level, kind, payload in anc:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            fds.frombytes(payload[:len(payload) - len(payload) % fds.itemsize])
    if not data and not fds:
        return False
    try:
        note = json.loads(data.decode("utf-8"))
        pid, address = int(note["pid"]), str(note.get("address") or "")
    except Exception:
        pid, address = 0, ""  # whose it is can't be told: kept until it closes at the app's end
    entry = apps.setdefault(pid, {"fds": [], "address": address, "since": 0.0, "clear": 0, "ask": None})
    entry["fds"].extend(fds)
    entry["since"] = time.monotonic()
    entry["clear"] = 0
    try:
        ctrl.send(b"ok")
    except OSError:
        pass
    return True


def look_at_app(pid, entry):
    """May app `pid`'s links (`entry`, see hold_main) be let go? Yes once it is gone (its end of every link closed), or
    once it shows no modal window on HOLD_CLEAR_LOOKS looks in a row, the first HOLD_LOOK_S after its latest link
    came: the app then waits on none of their requests (a modal dialog shows while one runs, and a busy app doesn't
    answer)."""
    entry["fds"] = [fd for fd in entry["fds"] if link_open(fd)]
    if not entry["fds"] or (pid and not process_alive(pid)):
        return True
    if not pid or time.monotonic() - entry["since"] < HOLD_LOOK_S:
        return False
    entry["clear"] = entry["clear"] + 1 if modal_shown(entry) is False else 0
    return entry["clear"] >= HOLD_CLEAR_LOOKS


def process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        pass
    return True


def link_open(fd):
    """Is link `fd` still open at the app's end? What the app sends on it is read and dropped; one it closed is closed
    here too."""
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    try:
        for _, events in poller.poll(0):
            if events & (select.POLLHUP | select.POLLERR | select.POLLNVAL) or not os.read(fd, 65536):
                os.close(fd)
                return False
    except OSError:
        try:
            os.close(fd)
        except OSError:
            pass
        return False
    return True


def modal_shown(entry):
    """Does the app (`entry`, see hold_main) show a modal window: True, False, or None where that can't be told (it
    didn't answer in time)? Asked on a connection of the holder's own to the app's own address, which no request that
    runs the app's code goes on, so it never waits on the app; closed with the app's links (see let_go)."""
    if Gio is None or not entry["address"]:
        return None
    try:
        if entry["ask"] is None or entry["ask"].is_closed():
            entry["ask"] = Gio.DBusConnection.new_for_address_sync(
                entry["address"], Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT, None, None)
        ask = entry["ask"]
        windows = ask.call_sync(None, ROOT_PATH, "org.a11y.atspi.Accessible", "GetChildren", None,
                                GLib.VariantType("(a(so))"), Gio.DBusCallFlags.NO_AUTO_START, HOLD_ASK_MS,
                                None).unpack()[0]
        for _, path in windows[:MAX_CHILDREN]:
            bits = ask.call_sync(None, path, "org.a11y.atspi.Accessible", "GetState", None, GLib.VariantType("(au)"),
                                 Gio.DBusCallFlags.NO_AUTO_START, HOLD_ASK_MS, None).unpack()[0]
            if shows_modal(bits):
                return True
    except Exception:
        return None
    return False


def shows_modal(bits):
    """Do AT-SPI state bits (GetState's answer: 32-bit words) say a modal window that shows?"""
    def has(n):
        return len(bits) > n // 32 and bool(bits[n // 32] >> (n % 32) & 1)
    return has(STATE_MODAL) and has(STATE_SHOWING)


def let_go(entry):
    """Closes an app's links (see hold_main) and the holder's own connection to it."""
    for fd in entry["fds"]:
        try:
            os.close(fd)
        except OSError:
            pass
    if entry["ask"] is not None:
        try:
            entry["ask"].close_sync(None)
        except Exception:
            pass


# ---------------------------------------------------------------- inside WSL (EMBER_ATSPI_FIND_BUS=1)

# Ember on Windows starts this script inside a WSL distro to read WSLg's Linux apps. There the session bus the apps use
# isn't in this process's environment (it is started with wsl.exe --exec): it is found first, by asking each candidate
# bus which windows its apps show and keeping the one that shows the windows WSLg shows on Windows (find_bus). Each
# candidate is looked at by a short-lived child (this script again, with EMBER_ATSPI_PROBE), so a bad bus never wedges
# this process, and nothing is ever started on a bus to answer (no D-Bus activation). Nothing here runs without the
# variable: the Linux sidecar is as it always was.

# What find_bus chose: "source" ("env", "proc", "runtime", "x11", or "none"), the addresses, and whether gi and
# pyatspi are loaded on it ("chosen").
BUS = {"source": None, "session": None, "a11y": None, "chosen": False}
# How long one candidate's look may take (a cold python3 with gi takes a few hundred milliseconds), and all of them.
PROBE_TIMEOUT_S = 3.0
FIND_TOTAL_S = 12.0
MAX_CANDIDATES = 8
MAX_TITLES = 32
# A long title RDP may have cut: one this long that starts exactly one frame's name names that frame (§4.9).
LONG_TITLE = 100
# A local bus address only (never a network one), as D-Bus writes it.
BUS_ADDRESS = re.compile(r"^unix:[A-Za-z0-9_=,./%:-]{1,1000}$")
SOURCES = ("env", "proc", "runtime", "x11")


def normalize_title(title):
    """A window title as Ember compares them: NFC, whitespace collapsed and trimmed."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", title or "")).strip()


def title_matches(frame_name, titles):
    """Does a frame's name equal one of the (normalised) titles, or start with a long one RDP may have cut?"""
    name = normalize_title(frame_name)
    return bool(name) and any(t == name or (len(t) >= LONG_TITLE and name.startswith(t)) for t in titles)


def bus_address(value):
    """A session or accessibility bus address worth trying (a local one), else None."""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    value = (value or "").strip()
    return value if BUS_ADDRESS.match(value) else None


def own_tree(proc="/proc", me=None):
    """This process and everything it started (the probes, the holder): their environments are Ember's own."""
    me = os.getpid() if me is None else me
    parents = {}
    try:
        names = os.listdir(proc)
    except OSError:
        return {me}
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open(os.path.join(proc, name, "stat"), "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            parents[int(name)] = int(stat[stat.rindex(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            continue
    tree = {me}
    grew = True
    while grew:
        grew = False
        for pid, parent in parents.items():
            if parent in tree and pid not in tree:
                tree.add(pid)
                grew = True
    return tree


def environ_bus(path):
    """The DBUS_SESSION_BUS_ADDRESS in a process's environment file, unless the process is one of Ember's commands
    (EMBER_RUN_ID): only that variable is read out of it."""
    try:
        with open(path, "rb") as f:
            data = f.read(1 << 20)
    except OSError:
        return None
    found = None
    for entry in data.split(b"\0"):
        if entry.startswith(b"EMBER_RUN_ID="):
            return None
        if entry.startswith(b"DBUS_SESSION_BUS_ADDRESS="):
            found = bus_address(entry[len(b"DBUS_SESSION_BUS_ADDRESS="):])
    return found


def bus_candidates(environ=None, proc="/proc", uid=None, skip=None, uid_of=None, is_socket=None, x11=None):
    """The session buses the distro's apps may use, each once, in order of trust: this process's own
    (DBUS_SESSION_BUS_ADDRESS), the same user's processes' (/proc/<pid>/environ), the runtime folders' sockets
    (/run/user/<uid>/bus, WSLg's /mnt/wslg/runtime-dir/bus), and the X root window's properties. Each is
    {"source", "session", "a11y"} (a11y: the accessibility bus itself, when the X root window says it)."""
    environ = os.environ if environ is None else environ
    uid = os.getuid() if uid is None else uid
    skip = own_tree(proc) if skip is None else skip

    def owner(path):
        try:
            return os.stat(path).st_uid
        except OSError:
            return None

    uid_of = uid_of or owner
    is_socket = is_socket or (lambda p: os.path.exists(p) and not os.path.isdir(p))
    out, seen = [], set()

    def add(source, session, a11y=None):
        if (session or a11y) and (session, a11y) not in seen:
            seen.add((session, a11y))
            out.append({"source": source, "session": session, "a11y": a11y})

    add("env", bus_address(environ.get("DBUS_SESSION_BUS_ADDRESS")))
    try:
        pids = sorted(int(n) for n in os.listdir(proc) if n.isdigit())
    except OSError:
        pids = []
    for pid in pids:
        if pid in skip or uid_of(os.path.join(proc, str(pid))) != uid:
            continue
        add("proc", environ_bus(os.path.join(proc, str(pid), "environ")))
    for path in ("/run/user/%d/bus" % uid, "/mnt/wslg/runtime-dir/bus"):
        if is_socket(path):
            add("runtime", "unix:path=" + path)
    props = x11() if x11 is not None else x_root_properties()
    add("x11", bus_address(props.get("_DBUS_SESSION_BUS_ADDRESS")), bus_address(props.get("AT_SPI_BUS")))
    return out[:MAX_CANDIDATES]


def probe(spec, timeout=PROBE_TIMEOUT_S):
    """What a child (this script with EMBER_ATSPI_PROBE) found for `spec`; None when it failed or took too long."""
    env = dict(os.environ)
    for name in ("DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS"):
        env.pop(name, None)
    # (With EMBER_ATSPI_FIND_BUS the child imports nothing on its own: only once it has set the bus it looks at.)
    env["EMBER_ATSPI_FIND_BUS"] = "1"
    env["EMBER_ATSPI_PROBE"] = json.dumps(spec)
    try:
        done = subprocess.run([sys.executable, "-I", os.path.abspath(__file__)], stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, timeout=timeout, cwd="/")
        return json.loads(done.stdout.decode("utf-8", "replace").strip().splitlines()[-1])
    except Exception:
        return None


def x_root_properties():
    """The X root window's _DBUS_SESSION_BUS_ADDRESS and AT_SPI_BUS on $DISPLAY (":0" by default), read by a child
    (an X error can end the process that meets it); {} without an X server or libX11."""
    found = probe({"kind": "x11", "display": os.environ.get("DISPLAY") or ":0"})
    return found if isinstance(found, dict) else {}


def score(found, titles):
    """How many apps on a candidate bus show a window WSLg shows (the probe's frames, app by app)."""
    if not isinstance(found, dict) or not isinstance(found.get("apps"), list):
        return 0
    return sum(1 for frames in found["apps"] if isinstance(frames, list) and any(
        isinstance(n, str) and title_matches(n, titles) for n in frames))


def rank(candidates, titles, look=probe, budget=FIND_TOTAL_S):
    """Each candidate with its score and the accessibility bus its look found, in order, until the time is up."""
    out = []
    until = time.monotonic() + budget
    for c in candidates:
        if time.monotonic() > until:
            break
        found = look({"kind": "bus", "session": c["session"], "a11y": c["a11y"]})
        a11y = bus_address(found.get("a11y")) if isinstance(found, dict) else None
        out.append((score(found, titles), dict(c, a11y=a11y or c["a11y"])))
    return out


def best_of(ranked):
    """The candidate with the most matches (the earlier on a tie), when it has any; else None."""
    best = None
    for n, c in ranked:
        if n >= 1 and (best is None or n > best[0]):
            best = (n, c)
    return best


def choose_bus(candidate):
    """Uses this bus from now on: its addresses go in the environment libatspi reads, then gi and pyatspi load."""
    if candidate["session"]:
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = candidate["session"]
    if candidate["a11y"]:
        os.environ["AT_SPI_BUS_ADDRESS"] = candidate["a11y"]
    if not load_atspi():
        return False
    if not configure_atspi():
        sys.stderr.write("ember_atspi: could not shorten libatspi timeouts\n")
    load_links()
    BUS.update(source=candidate["source"], session=candidate["session"], a11y=candidate["a11y"], chosen=True)
    return True


def find_bus(params, candidates=None, look=probe, choose=choose_bus):
    """find_bus { titles }: the session bus whose apps show the windows WSLg shows (`titles`, normalised), chosen and
    used from now on; "none" when no candidate shows any (every request but status then says "no session bus"). Once
    a bus is in use it can't be changed in this process: when another fits better now, `restart` says to start over."""
    titles = [normalize_title(t) for t in (params.get("titles") or [])[:MAX_TITLES] if isinstance(t, str)]
    titles = [t for t in titles if t]
    cands = bus_candidates() if candidates is None else candidates
    ranked = rank(cands, titles, look)
    best = best_of(ranked)
    # What each candidate scored, by where it was found (for the doctor and the wslg-probe job; no addresses).
    scores = [[c["source"], n] for n, c in ranked]
    if BUS["chosen"]:
        mine = [n for n, c in ranked if (c["session"], c["a11y"]) == (BUS["session"], BUS["a11y"])
                or (c["session"] and c["session"] == BUS["session"])]
        if best is not None and best[0] > (mine[0] if mine else 0):
            return {"bus": best[1]["source"], "score": best[0], "restart": True, "scores": scores}
        return {"bus": BUS["source"], "score": mine[0] if mine else 0, "scores": scores}
    if best is None or not choose(best[1]):
        BUS["source"] = "none"
        return {"bus": "none", "candidates": len(cands), "scores": scores}
    return {"bus": best[1]["source"], "score": best[0], "scores": scores}


def pyatspi_installed():
    """Is pyatspi there to import (without importing it: that would connect to a bus)?"""
    if pyatspi is not None:
        return True
    try:
        import importlib.util
        return importlib.util.find_spec("pyatspi") is not None
    except Exception:
        return False


def wsl_status():
    """What Ember on Windows checks before it reads anything here: the user (root is never read for), WSLg, the bus."""
    return {"uid": os.getuid(), "wslg": os.path.isdir("/mnt/wslg"), "bus": BUS["source"] or "none",
            "pyatspi": pyatspi_installed()}


def process_names(pid, proc="/proc"):
    """The names a process goes by, each at most 64 characters: its program (/proc/<pid>/exe's basename), the
    basenames of its command line's first two words (an interpreter and its script), and comm (15 bytes, as the
    kernel cuts it)."""
    out = {}
    base = os.path.join(proc, str(pid))
    try:
        exe = os.readlink(os.path.join(base, "exe"))
        if exe.endswith(" (deleted)"):
            exe = exe[:-len(" (deleted)")]
        if os.path.basename(exe):
            out["program"] = os.path.basename(exe)[:64]
    except OSError:
        pass
    try:
        with open(os.path.join(base, "cmdline"), "rb") as f:
            words = [w.decode("utf-8", "replace") for w in f.read(65536).split(b"\0")]
        for key, word in zip(("argv0", "argv1"), words[:2]):
            if os.path.basename(word):
                out[key] = os.path.basename(word)[:64]
    except OSError:
        pass
    try:
        with open(os.path.join(base, "comm"), "rb") as f:
            comm = f.read(64).decode("utf-8", "replace").strip()
        if comm:
            out["comm"] = comm[:15]
    except OSError:
        pass
    return out


def child_extents(win, limit=16):
    """The rectangles of a frame's direct children (the content box is their union; the frame may carry shadows)."""
    out = []
    try:
        count = min(win.childCount, limit)
    except Exception:
        return out
    for i in range(max(0, count)):
        child = child_at(win, i)
        b = extents(child) if child is not None else None
        if b is not None:
            out.append(b)
    return out


# How long the main loop has, after stdin hung up, to answer what was already sent and see the end of its input itself
# (it may hold those lines in its own buffer, where poll can't see them); one stuck in a hung app is ended then.
HUP_GRACE_S = 2.0


def stdin_state(fd):
    """(hung up, input still to read) for stdin: POLLHUP, or POLLRDHUP on a socket (a WSL relay that outlived its
    client). A pipe that can't be polled counts as hung up."""
    rdhup = getattr(select, "POLLRDHUP", 0)
    poller = select.poll()
    poller.register(fd, select.POLLIN | select.POLLHUP | rdhup)
    try:
        events = 0
        for _, ev in poller.poll(0):
            events |= ev
    except OSError:
        return True, False
    return bool(events & (select.POLLHUP | select.POLLERR | select.POLLNVAL | rdhup)), bool(events & select.POLLIN)


def stdin_hung_up(fd):
    """Has the other end of stdin gone?"""
    return stdin_state(fd)[0]


def watch_once(fd, parent, getppid=os.getppid, waited=0.0):
    """Why this process should end now: "parent" (it changed), "stdin" (hung up for HUP_GRACE_S); "draining" (hung up
    for less: what was sent is still being answered); None to go on."""
    if getppid() != parent:
        return "parent"
    if not stdin_hung_up(fd):
        return None
    return "stdin" if waited >= HUP_GRACE_S else "draining"


def start_watchdog(fd, interval=0.5):
    """Inside WSL: ends this process when its parent changes or stdin hangs up (under WSL 2 the parent may be a relay
    that outlives Ember, and a request stuck in a hung app would keep the main loop from seeing the end of input)."""
    parent = os.getppid()

    def run():
        waited = 0.0
        while True:
            why = watch_once(fd, parent, waited=waited)
            if why in ("parent", "stdin"):
                break
            waited = waited + interval if why == "draining" else 0.0
            time.sleep(interval)
        os._exit(0)

    t = threading.Thread(target=run, name="watchdog")
    t.daemon = True
    t.start()
    return t


def probe_x11(display):
    """The X root window's two string properties on `display`, through libX11 with an error handler that ignores
    errors (so a bad property can't end the process); {} without libX11 or a display."""
    import ctypes
    import ctypes.util
    try:
        x = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    except OSError:
        return {}
    handler_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    ignore = handler_type(lambda d, e: 0)
    x.XSetErrorHandler.argtypes = [handler_type]
    x.XSetErrorHandler(ignore)
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XInternAtom.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XGetWindowProperty.restype = ctypes.c_int
    x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
                                     ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                     ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                     ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
    x.XFree.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    d = x.XOpenDisplay(display.encode("utf-8"))
    if not d:
        return {}
    out = {}
    try:
        root = x.XDefaultRootWindow(d)
        for name in ("_DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS"):
            atom = x.XInternAtom(d, name.encode("ascii"), 1)
            if not atom:
                continue
            kind, fmt, n, after, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
            if x.XGetWindowProperty(d, root, atom, 0, 1024, 0, 0, ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(n),
                                    ctypes.byref(after), ctypes.byref(data)) == 0 and data.value:
                if fmt.value == 8:
                    out[name] = ctypes.string_at(data.value, n.value).decode("utf-8", "replace")
                x.XFree(data)
    finally:
        x.XCloseDisplay(d)
    return out


def a11y_address_of(session):
    """The accessibility bus a session bus has running, asked without starting it (no auto-start): None when there
    is none, so a bus whose accessibility bus isn't up scores nothing."""
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio as gio, GLib as glib
    flags = gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    conn = gio.DBusConnection.new_for_address_sync(session, flags, None, None)
    try:
        return conn.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None,
                              glib.VariantType("(s)"), gio.DBusCallFlags.NO_AUTO_START, 1000, None).unpack()[0]
    finally:
        conn.close_sync(None)


def probe_bus(session, a11y):
    """The names of every app's top-level windows on one candidate (at most 64 apps, 32 windows each)."""
    if not a11y:
        if not session:
            return {"apps": []}
        a11y = bus_address(a11y_address_of(session))
        if not a11y:
            return {"apps": []}
    os.environ["AT_SPI_BUS_ADDRESS"] = a11y
    if session:
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = session
    if not load_atspi():
        return {"apps": [], "a11y": a11y}
    configure_atspi()
    apps = []
    desktop = pyatspi.Registry.getDesktop(0)
    for a in range(min(desktop.childCount, 64)):
        app = child_at(desktop, a)
        if app is None:
            continue
        names = []
        try:
            count = min(app.childCount, 32)
        except Exception:
            count = 0
        for i in range(max(0, count)):
            win = child_at(app, i)
            try:
                if win is not None and win.name:
                    names.append(win.name[:300])
            except Exception:
                pass
        apps.append(names)
    return {"apps": apps, "a11y": a11y}


def probe_main(spec):
    """A probe child: looks at one thing find_bus asked for, prints it as one JSON line, and ends."""
    try:
        if spec.get("kind") == "x11":
            out = probe_x11(spec.get("display") or ":0")
        else:
            out = probe_bus(bus_address(spec.get("session")), bus_address(spec.get("a11y")))
    except Exception as err:
        out = {"error": str(err)[:200]}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


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
        name = req.get("method")
        method = find_bus if FIND_BUS and name == "find_bus" else METHODS.get(name)
        if method is None:
            raise KeyError("unknown method: %s" % name)
        if FIND_BUS and not BUS["chosen"]:
            # Inside WSL, before (or without) a bus: only what needs none.
            if name not in ("ping", "status", "find_bus"):
                raise RuntimeError("no session bus")
        elif pyatspi is None and name != "ping":
            raise RuntimeError("python3-pyatspi is not installed")
        result = method(req.get("params") or {})
        return {"jsonrpc": "2.0", "id": req_id, "result": result}
    except Exception as e:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"message": str(e), "detail": traceback.format_exc(limit=3)}}


def main():
    inp, out = protocol_streams()
    if FIND_BUS:
        # Inside WSL the parent may be a relay that outlives Ember: this ends with it, or when stdin hangs up.
        start_watchdog(inp.fileno())
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
    if FIND_BUS and os.environ.get("EMBER_ATSPI_PROBE"):
        probe_main(json.loads(os.environ["EMBER_ATSPI_PROBE"]))  # one look for find_bus (inside WSL)
    elif sys.argv[1:2] == ["--hold"]:
        if FIND_BUS:
            load_atspi()  # inside WSL the holder loads what it needs itself (it doesn't look for a bus)
            load_links()
        hold_main(int(sys.argv[2]))  # the holder of links (see on_link)
    else:
        main()
