#!/usr/libexec/platform-python
# -*- coding: utf-8 -*-
"""Self-test for ember_atspi.py with stand-in accessibles: no display, no
pyatspi, no pytest. Python 3.6 compatible (RHEL 8's platform-python).

    python3 sidecar/atspi/test_ember_atspi.py
"""

import json
import os
import subprocess
import sys
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# Field labels and whether they are secret: the same table the TypeScript tests read.
LABELS = os.path.join(HERE, "..", "..", "test", "fixtures", "secret-labels.json")
# Options chosen in secret drop-downs and whether they are what the user put in them: the same table as the TypeScript's.
CHOSEN = os.path.join(HERE, "..", "..", "test", "fixtures", "chosen-options.json")

# A stand-in pyatspi, so the real one (and a desktop) are never needed.
FAKE = types.ModuleType("pyatspi")
FAKE.DESKTOP_COORDS = 0
FAKE.RELATION_LABELLED_BY = "labelled-by"
FAKE.stateToString = lambda s: s
sys.modules["pyatspi"] = FAKE
sys.path.insert(0, HERE)
import ember_atspi as e  # noqa: E402

STUB = """
import sys, types
fake = types.ModuleType("pyatspi")
fake.DESKTOP_COORDS = 0
fake.stateToString = lambda s: s
sys.modules["pyatspi"] = fake
sys.path.insert(0, %r)
import ember_atspi as e
e.configure_atspi = lambda: True
e.METHODS["echo"] = lambda p: p
def noisy(p):
    print("a library writing to stdout")
    return {"ok": True}
e.METHODS["noisy"] = noisy
e.METHODS["nan"] = lambda p: {"v": float("nan")}
e.main()
""" % HERE


class States(object):
    def __init__(self, names):
        self.names = list(names)

    def getStates(self):
        return self.names


class Relation(object):
    def __init__(self, kind, targets):
        self.kind = kind
        self.targets = targets

    def getRelationType(self):
        return self.kind

    def getNTargets(self):
        return len(self.targets)

    def getTarget(self, i):
        return self.targets[i]


class Text(object):
    def __init__(self, acc):
        self.acc = acc

    @property
    def characterCount(self):
        return len(self.acc.text)

    def getText(self, start, end):
        self.acc.reads += 1
        time.sleep(getattr(self.acc, "delay", 0.0))  # an app slow to answer
        return self.acc.text[start:end]

    def getNSelections(self):
        return 1 if self.acc.selection else 0

    def getSelection(self, i):
        return self.acc.selection


class App(object):
    bus_name = ":1.42"


class Acc(object):
    """An accessible: role, name, states, bounds, text, children; counts what is asked."""

    _paths = [0]

    def __init__(self, role, name="", states=("showing", "visible", "enabled", "sensitive"), bounds=(0, 0, 50, 20),
                 text=None, selection=None, kids=(), labelled_by=(), acts=()):
        self.role = role
        self.name = name
        self.states = list(states)
        self.bounds = bounds
        self.text = text
        self.selection = selection
        self.kids = list(kids)
        self.labelled_by = list(labelled_by)
        self.acts = list(acts)
        self.reads = 0
        self.asked_actions = 0
        self.child_reads = 0
        self.app = App()
        Acc._paths[0] += 1
        self.path = "/org/a11y/atspi/accessible/%d" % Acc._paths[0]

    def getRoleName(self):
        return self.role

    def getState(self):
        return States(self.states)

    def queryComponent(self):
        acc = self

        class C(object):
            def getExtents(self, coords):
                x, y, w, h = acc.bounds
                return types.SimpleNamespace(x=x, y=y, width=w, height=h)
        return C()

    def queryText(self):
        if self.text is None:
            raise NotImplementedError
        return Text(self)

    def queryAction(self):
        self.asked_actions += 1
        acts = self.acts
        return types.SimpleNamespace(nActions=len(acts), getName=lambda i: acts[i])

    def queryValue(self):
        raise NotImplementedError

    def queryEditableText(self):
        raise NotImplementedError

    def getRelationSet(self):
        return [Relation(FAKE.RELATION_LABELLED_BY, self.labelled_by)] if self.labelled_by else []

    def getAttributes(self):
        return ["placeholder-text:%s" % self.placeholder] if getattr(self, "placeholder", None) else []

    @property
    def childCount(self):
        return len(self.kids)

    def getChildAtIndex(self, i):
        self.child_reads += 1
        return self.kids[i]


def column_name(c):
    """A spreadsheet's column: A..Z, AA.."""
    name = ""
    c += 1
    while c:
        c, rest = divmod(c - 1, 26)
        name = chr(65 + rest) + name
    return name


class Sheet(Acc):
    """LibreOffice Calc's sheet: a table of a million rows it makes cells for as they are asked for (2^31 children,
    "manages descendants"), each named by its address with its value as text. Those scrolled away, above and below
    the view alike, sit at its corner sized 0x0. Rows 20 px high, columns 80 px wide; `top` and `left` are the first
    row and column on screen, `values` maps (row, column) to what a cell holds."""

    ROWS, COLS = 1048576, 16384

    def __init__(self, values, top=0, left=0, bounds=(37, 158, 1170, 556), focus=(0, 0)):
        Acc.__init__(self, "table", "Sheet1", bounds=bounds,
                     states=("showing", "visible", "enabled", "focusable", "focused", "manages descendants"))
        self.values, self.top, self.left, self.focus = values, top, left, focus
        self.made = 0
        self.secret_at = None

    @property
    def childCount(self):
        return 2 ** 31 - 1

    def on_screen(self, r, c):
        x, y, w, h = self.bounds
        return self.top <= r < self.top + (h + 19) // 20 and self.left <= c < self.left + (w + 79) // 80

    def cell(self, r, c):
        if not (0 <= r < self.ROWS and 0 <= c < self.COLS):
            raise IndexError(r, c)
        self.made += 1
        x, y, _, _ = self.bounds
        states = ["visible", "enabled", "focusable", "editable", "multi line"]
        if self.on_screen(r, c):
            states.append("showing")
            bounds = (x + (c - self.left) * 80, y + (r - self.top) * 20, 80, 20)
        else:
            bounds = (x - 1, y - 1, 0, 0)
        if (r, c) == self.focus:
            states.append("focused")
        cell = Acc("table cell", "%s%d" % (column_name(c), r + 1), states=states, bounds=bounds,
                   text=self.values.get((r, c), ""))
        if (r, c) == self.secret_at:
            cell.path = "/sheet/secret"
        index = min(r * self.COLS + c, 2 ** 31 - 1)
        cell.getIndexInParent = lambda: index
        return cell

    def getChildAtIndex(self, i):
        self.child_reads += 1
        return self.cell(i // self.COLS, i % self.COLS)

    def queryTable(self):
        cols = self.COLS
        return types.SimpleNamespace(nRows=self.ROWS, nColumns=cols, getIndexAt=lambda r, c: min(r * cols + c, 2 ** 31 - 1),
                                     getAccessibleAt=self.cell, getRowAtIndex=lambda i: i // cols,
                                     getColumnAtIndex=lambda i: i % cols)

    def queryComponent(self):
        sheet, extents = self, Acc.queryComponent(self)

        class C(object):
            def getExtents(self, coords):
                return extents.getExtents(coords)

            def getAccessibleAtPoint(self, px, py, coords):
                x, y, w, h = sheet.bounds
                if not (x <= px < x + w and y <= py < y + h):
                    return None
                return sheet.cell(sheet.top + (py - y) // 20, sheet.left + (px - x) // 80)
        return C()


def calc_window(sheet, after=()):
    """A Calc window: its sheet, then the rest of the window (`after`: the status bar)."""
    doc = Acc("document spreadsheet", "", bounds=sheet.bounds, kids=[sheet])
    return Acc("frame", "big.csv - LibreOffice Calc", bounds=(0, 0, 1280, 800),
               kids=[Acc("push button", "Bold", bounds=(10, 30, 24, 24)), doc] + list(after))


class Secrets(unittest.TestCase):
    def setUp(self):
        e.SECRETS = e.SecretFields()

    def test_secret_labels(self):
        for label in ["Password", "Card number", "CVV", "IBAN", "One-time code", "PIN", "Passwort", "API key",
                      "Security code", "Card expiry date", "Pass​word", "ＰＡＳＳＷＯＲＤ"]:
            self.assertTrue(e.looks_secret(label), label)
        for label in ["Name", "Spinner", "Pinned items", "Search", "Compass", "Bypass", "Subject", "", None]:
            self.assertFalse(e.looks_secret(label), label)

    @unittest.skipUnless(os.path.exists(LABELS), "the repository's test table is not here")
    def test_secret_labels_in_many_languages(self):
        with open(LABELS, encoding="utf-8") as f:
            table = json.load(f)
        for label in table["secret"]:
            self.assertTrue(e.looks_secret(label), label)
        for label in table["plain"]:
            self.assertFalse(e.looks_secret(label), label)

    def test_placeholder_says_password(self):
        field = Acc("entry", "", text="hunter2")
        field.placeholder = "Password"
        self.assertTrue(e.node_of(field, "entry", "", field.states, None).get("secret"))
        self.assertEqual(field.reads, 0)

    def test_secret_fields_known_to_an_earlier_helper(self):
        # Revealed before this process ever saw it as a password field: Ember hands over what it knew.
        pw = Acc("text", "Key", text="revealedBeforeRead")
        self.assertFalse(e.is_secret(pw, "text", "Key"))
        e.remember_secrets({"keys": [[pw.app.bus_name, pw.path], "junk", [1]]})
        self.assertTrue(e.is_secret(pw, "text", "Key"))
        self.assertRaises(PermissionError, e.refuse_secret, pw)

    def test_fields_ember_found_secret(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        field = Acc("entry", "Key", text="revealed")
        nid = e.SNAPSHOTS.add(field)
        out = e.mark_secret({"ids": [nid, 999999]})
        self.assertEqual(out["keys"], [[field.app.bus_name, field.path]])
        self.assertRaises(PermissionError, e.refuse_secret, field)

    def test_password_fields_stay_secret_after_show_password(self):
        pw = Acc("password text", text="hunter2")
        self.assertTrue(e.is_secret(pw, "password text", ""))
        pw.role = "text"  # "Show password": GTK turns it into a plain entry
        node = e.node_of(pw, "text", "", pw.states + ["focused"], None)
        self.assertTrue(node.get("secret"))
        self.assertNotIn("text", node)
        self.assertNotIn("selection", node)
        self.assertEqual(pw.reads, 0)
        self.assertTrue(e.node_info(pw).get("secret"))
        self.assertNotIn("text", e.node_info(pw))

    def test_fields_named_or_labelled_secret(self):
        card = Acc("text", "Card number", text="4111 1111 1111 1111")
        cvv = Acc("text", "", text="123", labelled_by=[Acc("label", "CVV")])
        plain = Acc("text", "Name", text="Ada", selection=(0, 3))
        self.assertNotIn("text", e.node_of(card, "text", card.name, card.states, None))
        self.assertNotIn("text", e.node_of(cvv, "text", "", cvv.states, None))
        node = e.node_of(plain, "text", "Name", plain.states + ["focused"], None)
        self.assertEqual((node.get("text"), node.get("selection")), ("Ada", "Ada"))
        # A button or a document isn't judged by its name.
        self.assertFalse(e.is_secret(Acc("push button", "Show password"), "push button", "Show password"))
        self.assertFalse(e.is_secret(Acc("document text", "secret.odt"), "document text", "secret.odt"))

    def test_unnamed_field_next_to_a_secret_label(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        label = Acc("label", "Card number", bounds=(10, 100, 90, 20))
        field = Acc("text", "", bounds=(110, 96, 200, 28), text="4111")
        name_label = Acc("label", "Name", bounds=(10, 140, 50, 20))
        name = Acc("text", "", bounds=(70, 136, 200, 28), text="Ada")
        root = Acc("frame", "Pay", bounds=(0, 0, 400, 300), kids=[label, field, name_label, name])
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        latest = e.SNAPSHOTS.latest()
        e.redact_by_layout(nodes, latest.get)
        by_text = [n for n in nodes if n["role"] == "text"]
        self.assertEqual([n.get("text") for n in by_text], [None, "Ada"])
        self.assertTrue(by_text[0]["secret"])
        # Remembered: a later read_element or set_text knows too.
        self.assertTrue(e.node_info(field).get("secret"))
        self.assertRaises(PermissionError, e.refuse_secret, field)

    def test_unnamed_field_under_a_secret_label(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        # Chromium's plain text above the field it labels.
        label = Acc("static", "Card number", bounds=(16, 264, 152, 30))
        field = Acc("entry", "", bounds=(16, 295, 359, 43), text="4000123412341234")
        far = Acc("static", "Card number", bounds=(400, 200, 152, 30))
        other = Acc("entry", "", bounds=(16, 400, 359, 43), text="Ada")
        root = Acc("frame", "Pay", bounds=(0, 0, 800, 600), kids=[label, field, far, other])
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        e.redact_by_layout(nodes, e.SNAPSHOTS.latest().get)
        entries = [n for n in nodes if n["role"] == "entry"]
        self.assertEqual([n.get("text") for n in entries], [None, "Ada"])


    def test_labels_above_an_indented_field_but_not_one_naming_its_own_row(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        kids = [Acc("static", "Password", bounds=(8, 10, 60, 18)), Acc("entry", "", bounds=(38, 30, 150, 24), text="indented"),
                Acc("static", "Password", bounds=(8, 80, 60, 18)), Acc("entry", "", bounds=(80, 78, 150, 24), text="hunter2"),
                Acc("entry", "", bounds=(8, 104, 400, 60), text="ordinary notes"),
                Acc("static", "Card number", bounds=(8, 180, 90, 18)), Acc("link", "What's this?", bounds=(200, 180, 80, 18)),
                Acc("entry", "", bounds=(8, 200, 150, 24), text="4111")]
        nodes = []
        e.walk(Acc("frame", "Form", bounds=(0, 0, 500, 300), kids=kids), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        e.redact_by_layout(nodes, e.SNAPSHOTS.latest().get)
        self.assertEqual([n.get("text") for n in nodes if n["role"] == "entry"], [None, None, "ordinary notes", None])


class Reading(unittest.TestCase):
    def setUp(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        e.CURSORS.clear()

    def test_stops_at_max_nodes(self):
        root = Acc("list", "Big", kids=[Acc("list item", "row %d" % i) for i in range(1000)])
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, 5, None)
        self.assertEqual(len(nodes), 5)
        # A few looks to find the rows on screen, then four rows: not a thousand.
        self.assertLessEqual(root.child_reads, 60)

    def scrolled_list(self, rows=5000, first=2500, visible=25):
        """A list of `rows` 20-px rows, scrolled so rows first..first+visible-1 fill a 500-px viewport."""
        top = 120  # under the column header
        kids = []
        for i in range(rows):
            y = top + (i - first) * 20
            on = first <= i < first + visible
            kids.append(Acc("list item", "row %d" % i, bounds=(10, y, 300, 20),
                            states=("showing", "visible", "enabled", "sensitive") if on else ("visible", "enabled")))
        header = Acc("table column header", "Name", bounds=(10, 100, 300, 20))
        lst = Acc("list", "Files", bounds=(10, -50000, 300, 200000), kids=[header] + kids)
        view = Acc("viewport", "", bounds=(10, 100, 300, 500), kids=[lst])
        return Acc("frame", "Files", bounds=(0, 0, 800, 700), kids=[view]), lst

    def test_long_lists_are_read_where_they_are_scrolled_to(self):
        root, lst = self.scrolled_list()
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        names = [n["name"] for n in nodes if n["role"] in ("list item", "table column header")]
        self.assertEqual(names, ["Name"] + ["row %d" % i for i in range(2500, 2525)])
        # Found by a binary search, and the rows below the viewport aren't walked one by one.
        self.assertLess(lst.child_reads, 120)

    def test_big_tables_are_read_at_the_scroll_bar(self):
        # GTK's tree view (file dialogs): every cell "showing", no cell positions; rows of 4 cells.
        rows, cols = 800, 4
        heads = [Acc("table column header", h, bounds=(10 + 100 * i, 100, 100, 20)) for i, h in enumerate(["Name", "Size", "Type", "Modified"])]
        cells = [Acc("table cell", "file%03d.txt" % (r + 1) if c == 0 else "cell", bounds=(e.INT_MIN, e.INT_MIN, 100, 21))
                 for r in range(rows) for c in range(cols)]
        table = Acc("table", "", bounds=(10, 100, 400, 630), kids=heads + cells)
        table.queryTable = lambda: types.SimpleNamespace(nRows=rows, nColumns=cols, getIndexAt=lambda r, c: 4 + r * cols + c)
        bar = Acc("scroll bar", "", states=("showing", "visible", "enabled", "vertical"), bounds=(410, 100, 6, 630))
        bar.queryValue = lambda: types.SimpleNamespace(minimumValue=0.0, maximumValue=1000.0, currentValue=500.0)
        pane = Acc("scroll pane", "", bounds=(10, 100, 406, 630), kids=[table, bar])
        table.parent = pane
        nodes = []
        e.walk(Acc("dialog", "Open File", bounds=(0, 0, 800, 800), kids=[pane]), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        files = [n["name"] for n in nodes if n["name"].startswith("file")]
        self.assertEqual([n["name"] for n in nodes if n["role"] == "table column header"], ["Name", "Size", "Type", "Modified"])
        # Halfway down 800 rows, about 31 on screen: the rows around 385, not the first 50.
        self.assertTrue(files and "file001.txt" not in files, files[:3])
        middle = int(files[len(files) // 2][4:7])
        self.assertTrue(370 <= middle <= 420, files)
        self.assertLessEqual(len(files), 40)

    def test_long_lists_at_the_top(self):
        root, _ = self.scrolled_list(rows=1000, first=0)
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        names = [n["name"] for n in nodes if n["role"] == "list item"]
        self.assertEqual(names, ["row %d" % i for i in range(25)])

    def test_rows_and_cells_are_not_asked_for_actions(self):
        cell = Acc("table cell", "file001.txt", acts=["activate"])
        item = Acc("list item", "Row 1", acts=["click"])
        nodes = []
        e.walk(Acc("frame", "W", kids=[cell, item]), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual((cell.asked_actions, item.asked_actions), (0, 0))

    def test_a_read_stops_when_the_app_stops_answering(self):
        class Stuck(Acc):
            def getState(self):
                time.sleep(0.05)  # a call that timed out
                return States([])
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.03
        try:
            later = [Acc("push button", "After %d" % i) for i in range(20)]
            root = Acc("frame", "W", kids=[Acc("push button", "Before"), Stuck("push button", "Stuck")] + later)
            budget = e.Budget()
            nodes = []
            e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        finally:
            e.SLOW_APP_S = old
        self.assertTrue(budget.busy)
        self.assertEqual([n["name"] for n in nodes], ["W", "Before"])
        self.assertEqual(sum(a.child_reads for a in later), 0)

    def test_a_read_stops_at_its_deadline(self):
        root = Acc("frame", "W", kids=[Acc("push button", "B%d" % i) for i in range(50)])
        budget = e.Budget(0)
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertTrue(budget.over and not budget.busy)
        self.assertLess(len(nodes), 50)

    def test_a_long_row_of_children_on_screen_is_cut_short(self):
        # 450 links in one paragraph, all on screen: a read takes MAX_CHILDREN of them, and says it was cut short.
        links = [Acc("link", "L%d" % i, bounds=(10 + (i % 45) * 20, 10 + (i // 45) * 12, 18, 10)) for i in range(450)]
        root = Acc("frame", "Links", bounds=(0, 0, 1000, 200), kids=[Acc("section", "", bounds=(0, 0, 1000, 200), kids=links)])
        budget = e.Budget()
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertEqual(len([n for n in nodes if n["role"] == "link"]), e.MAX_CHILDREN)
        self.assertTrue(budget.cut)
        # A long list scrolled to its end: every row on screen was read.
        root, _ = self.scrolled_list(rows=1000, first=975)
        budget = e.Budget()
        e.walk(root, 0, [], e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertFalse(budget.cut)

    def test_what_shows_too_deep_down_makes_a_read_incomplete(self):
        def nested(levels, leaf):
            for i in range(levels):
                leaf = Acc("panel", "g%d" % i, bounds=(0, 0, 400, 300), kids=[leaf])
            return Acc("frame", "Pay", bounds=(0, 0, 400, 300), kids=[leaf])
        # A web page's thirty layers of <div>s are read through.
        budget, nodes = e.Budget(), []
        e.walk(nested(30, Acc("entry", "Card number", text="4111")), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertEqual(nodes[-1]["role"], "entry")
        self.assertFalse(budget.cut)
        # Deeper than a read goes: what shows there is missing, and the read says so.
        budget, nodes = e.Budget(), []
        e.walk(nested(e.MAX_DEPTH + 5, Acc("entry", "Card number")), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertNotIn("entry", [n["role"] for n in nodes])
        self.assertEqual((budget.cut, budget.why), (True, ["depth"]))
        # What doesn't show there leaves the read complete.
        budget = e.Budget()
        e.walk(nested(e.MAX_DEPTH, Acc("entry", "Card number", states=("visible",))), 0, [], e.MAX_DEPTH,
               e.MAX_NODES, None, None, budget)
        self.assertFalse(budget.cut)
        # Neither can the secret scan look through it: then nothing can be shown.
        found, budget = {"fields": [], "labels": [], "docs": []}, e.Budget(e.SCAN_BUDGET_S)
        e.scan_fields(nested(e.MAX_DEPTH + 5, Acc("entry", "")), 0, found, None, budget, [0])
        self.assertEqual((found["fields"], budget.cut), ([], True))

    def fixed_panel(self, rows=250, visible=25):
        """A web page of `rows` paragraphs scrolled to the top, and a fixed "Pay now" panel last in it."""
        paras = [Acc("paragraph", "Item %d" % i, bounds=(10, 60 + 18 * i, 400, 16),
                     states=("showing", "visible") if i < visible else ("visible",)) for i in range(rows)]
        self.card = Acc("entry", "", bounds=(560, 150, 260, 24), text="4111 1111 1111 1111")
        panel = Acc("section", "", bounds=(540, 100, 420, 120), kids=[
            Acc("static", "Card number", bounds=(550, 130, 90, 18)), self.card, Acc("push button", "Pay", bounds=(550, 180, 40, 24))])
        doc = Acc("document web", "Fixed", bounds=(0, 50, 1000, 450), kids=paras + [panel])
        return Acc("frame", "Fixed", bounds=(0, 0, 1000, 500), kids=[doc]), doc, panel

    def test_what_shows_after_a_long_list_is_read_too(self):
        root, doc, _ = self.fixed_panel()
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        names = [n["name"] for n in nodes]
        self.assertIn("Item 24", names)
        self.assertNotIn("Item 40", names)
        self.assertIn("Pay", names)
        self.assertTrue(budget.cut)  # without the app's own search, the paragraphs between can't be vouched for
        self.assertLess(doc.child_reads, 100)
        # Nothing showing after the rows on screen: complete, as before.
        root, doc, panel = self.fixed_panel()
        panel.states = ["visible"]
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertNotIn("Pay", [n["name"] for n in nodes])
        self.assertFalse(budget.cut)
        # The secret scan (where the app can't search the page itself) looks through the panel the app says shows
        # after the paragraphs on screen; without the app's answer, it can't vouch for the window (no picture).
        saved = e.collection_matches, e.showing_after
        e.collection_matches = lambda acc, roles, limit=e.SCAN_NODES: None
        try:
            for answer, finds in ((saved[1], False), (lambda acc, *a: ([acc.kids[-1]], True), True)):
                root, _, _ = self.fixed_panel()
                e.showing_after = answer
                found, budget = {"fields": [], "labels": [], "docs": []}, e.Budget(e.SCAN_BUDGET_S)
                e.scan_fields(root, 0, found, None, budget, [0])
                self.assertEqual(([acc for _, acc in found["fields"]], budget.cut), ([self.card] if finds else [], not finds))
        finally:
            e.collection_matches, e.showing_after = saved

    def test_the_app_finds_what_shows_after_a_long_list(self):
        root, doc, panel = self.fixed_panel()
        asked = []

        def get_matches_from(acc, child, rule, sort, tree, count, traverse):
            asked.append((acc, tree, traverse))
            after = acc.kids[acc.kids.index(child) + 1:]
            return [k for k in after if "showing" in k.states][:count]
        toolkit = ["Chromium"]
        fake = types.SimpleNamespace(
            MatchRule=types.SimpleNamespace(new=lambda *a: "rule"), StateSet=types.SimpleNamespace(new=lambda s: s),
            StateType=types.SimpleNamespace(SHOWING=1, VISIBLE=2), CollectionMatchType=types.SimpleNamespace(ALL=0),
            CollectionSortOrder=types.SimpleNamespace(CANONICAL=0), CollectionTreeTraversalType=types.SimpleNamespace(RESTRICT_SIBLING=1),
            Collection=types.SimpleNamespace(get_matches_from=get_matches_from),
            Accessible=types.SimpleNamespace(get_toolkit_name=lambda acc: toolkit[0]))
        saved = e.Atspi, e.native
        e.Atspi, e.native = fake, lambda acc: acc is doc
        try:
            rest, complete = e.showing_after(doc, doc.kids[30], 30, len(doc.kids), e.Budget())
            self.assertEqual((rest, complete), ([panel], True))
            self.assertEqual(asked, [(doc, 1, False)])
            # Any other toolkit's app is never asked to search: LibreOffice Calc aborts after one search over its
            # cells (it makes them on demand). The end of the list is looked at instead.
            toolkit[0] = "gtk"
            rest, complete = e.showing_after(doc, doc.kids[30], 30, len(doc.kids), e.Budget())
            self.assertEqual((rest, complete, len(asked)), ([panel], False, 1))
            toolkit[0] = "Gecko"
            # More of them than a read takes: not all of them.
            for k in doc.kids[100:130]:
                k.states.append("showing")
            rest, complete = e.showing_after(doc, doc.kids[30], 30, len(doc.kids), e.Budget())
            self.assertEqual((len(rest), complete), (e.STRAGGLERS, False))
        finally:
            e.Atspi, e.native = saved

    def test_a_list_whose_children_have_no_size_is_never_called_complete(self):
        # A long list whose children scrolled away, above and below alike, sit at one corner with no size (Calc's
        # cells, without its Table interface): their order says nothing, so what was read can't be vouched for.
        cells = [Acc("table cell", "C%d" % i, bounds=(37 + 82 * i, 158, 82, 17)) if i < 15
                 else Acc("table cell", "C%d" % i, bounds=(36, 157, 0, 0), states=("visible",)) for i in range(5000)]
        table = Acc("table", "Sheet1", bounds=(37, 158, 1170, 556), kids=cells)
        root = Acc("frame", "Calc", bounds=(0, 0, 1280, 800), kids=[Acc("document spreadsheet", "", bounds=(37, 158, 1170, 556), kids=[table])])
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertEqual([n["name"] for n in nodes if n["role"] == "table cell"], ["C%d" % i for i in range(15)])
        self.assertEqual((budget.cut, budget.why), (True, ["nodes"]))
        self.assertLess(table.child_reads, 100)
        found, budget = {"fields": [], "labels": [], "docs": []}, e.Budget(e.SCAN_BUDGET_S)
        e.scan_fields(root, 0, found, None, budget, [0])
        self.assertTrue(budget.cut)
        self.assertLess(table.child_reads, 200)
        # One child without a size among ones with a size (an empty element in a web page) changes nothing.
        root, lst = self.scrolled_list()
        for i in range(0, 5000, 7):
            lst.kids[i].bounds = (10, 0, 0, 0)
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertIn("row 2510", [n["name"] for n in nodes])
        self.assertFalse(budget.cut)

    def test_a_spreadsheet_is_read_where_it_is_scrolled_to(self):
        # LibreOffice Calc scrolled 2000 rows down: the cells on screen, with what they hold, and the one with the
        # keyboard (empty); the empty ones and those scrolled away (above and below) are not listed.
        values = dict(((r, c), "v%d.%d" % (r, c)) for r in range(1990, 2010) for c in range(6))
        values[(5, 0)] = "far above"
        values[(9000, 0)] = "far below"
        sheet = Sheet(values, top=2000, focus=(2012, 3))
        root = calc_window(sheet, [Acc("status bar", "Sum=0", bounds=(0, 760, 1280, 24))])
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        cells = [n for n in nodes if n["role"] == "table cell"]
        self.assertEqual([(n["name"], n.get("text")) for n in cells[:3]], [("A2001", "v2000.0"), ("B2001", "v2000.1"), ("C2001", "v2000.2")])
        self.assertEqual(len(cells), 10 * 6 + 1)
        self.assertEqual((cells[-1]["name"], cells[-1].get("text"), cells[-1]["states"][-1]), ("D2013", None, "focused"))
        self.assertNotIn("far above", [n.get("text") for n in nodes])
        self.assertEqual(set(n["parent"] for n in cells), set([n["id"] for n in nodes if n["role"] == "table"]))
        self.assertEqual(cells[0]["bounds"], {"x": 37, "y": 158, "width": 80, "height": 20})
        # The rest of the window is read too, and nothing on screen was left out.
        self.assertEqual(nodes[-1]["name"], "Sum=0")
        self.assertFalse(budget.cut or budget.over or budget.busy)
        # Only the cells on screen were asked for (28 rows of 15), and none by its index (Calc's stop at 2^31).
        self.assertLessEqual(sheet.made, 28 * 15 + 2)
        self.assertEqual(sheet.child_reads, 0)
        # An element found by id is the cell.
        self.assertEqual(e.SNAPSHOTS.get(cells[0]["id"]).name, "A2001")

    def test_a_full_spreadsheet_is_read_up_to_its_limit(self):
        # Every cell on screen holds something: GRID_CELLS of them (on top of the window's own node limit), and the
        # read says it was cut short.
        sheet = Sheet(dict(((r, c), str(r * 100 + c)) for r in range(40) for c in range(20)))
        root = calc_window(sheet, [Acc("status bar", "Sum=0", bounds=(0, 760, 1280, 24))])
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, 30, None, None, budget)
        cells = [n for n in nodes if n["role"] == "table cell"]
        self.assertEqual(len(cells), e.GRID_CELLS)
        self.assertEqual((cells[-1]["name"], cells[-1]["text"]), ("J27", "2609"))  # row by row, 15 to a row
        self.assertEqual(nodes[-1]["name"], "Sum=0")
        self.assertEqual((budget.cut, budget.why), (True, ["nodes"]))
        # Nor are its cells read for longer than GRID_BUDGET_S.
        saved = e.GRID_BUDGET_S
        e.GRID_BUDGET_S = 0
        try:
            budget, nodes = e.Budget(), []
            e.walk(calc_window(Sheet({(0, 0): "1"})), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        finally:
            e.GRID_BUDGET_S = saved
        self.assertEqual([n for n in nodes if n["role"] == "table cell"], [])
        self.assertEqual((budget.cut, budget.why), (True, ["nodes"]))

    def test_a_spreadsheet_cell_known_to_be_secret_keeps_its_contents(self):
        sheet = Sheet({(0, 0): "hunter2", (0, 1): "plain"}, focus=(5, 5))
        sheet.secret_at = (0, 0)
        e.SECRETS.add((":1.42", "/sheet/secret"))
        nodes = []
        e.walk(calc_window(sheet), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        cells = dict((n["name"], n) for n in nodes if n["role"] == "table cell")
        self.assertEqual((cells["A1"].get("secret"), cells["A1"].get("text")), (True, None))
        self.assertEqual(cells["B1"].get("text"), "plain")
        self.assertNotIn("hunter2", json.dumps(nodes))

    def test_cells_named_by_their_address_say_what_they_hold(self):
        # A small sheet (a few cells, read as children): the address is the name, the value the text. A file
        # dialog's cells are named by what they show, and not asked for their text.
        nodes = []
        cells = [Acc("table cell", "A1", text="Total"), Acc("table cell", "B1", text="42"), Acc("table cell", "notes.txt", text="notes.txt")]
        e.walk(Acc("frame", "W", kids=[Acc("table", "", kids=cells)]), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([(n["name"], n.get("text")) for n in nodes if n["role"] == "table cell"],
                         [("A1", "Total"), ("B1", "42"), ("notes.txt", None)])
        self.assertEqual(cells[2].reads, 0)
        # Only a spreadsheet's cells, read from its grid, say so (a Writer table's cells are named "A1" too).
        self.assertEqual([n.get("grid") for n in nodes if n["role"] == "table cell"], [False, False, None])
        nodes = []
        e.walk(calc_window(Sheet({(0, 0): "1"})), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([n.get("grid") for n in nodes if n["role"] == "table cell"], [True])

    def test_headings_and_quotations_say_what_they_say(self):
        # LibreOffice Writer's headings and quotations have no name: what they say is their text. A web page's heading
        # is named after it, and not asked again.
        heading = Acc("heading", "", text="Quarterly report", selection=(10, 16), states=("showing", "visible", "focused"))
        quote = Acc("block quote", "", text="A quoted remark.")
        named = Acc("heading", "Results", text="Results")
        nodes = []
        e.walk(Acc("frame", "W", kids=[Acc("document text", "", kids=[heading, quote, named])]), 0, nodes, e.MAX_DEPTH,
               e.MAX_NODES, None)
        self.assertEqual([(n["role"], n["name"], n.get("text")) for n in nodes[2:]],
                         [("heading", "", "Quarterly report"), ("block quote", "", "A quoted remark."), ("heading", "Results", None)])
        self.assertEqual(named.reads, 0)
        self.assertEqual(nodes[2].get("selection"), "report")  # what "this" is in "make this bold"
        # A page's editable heading or section with the keyboard tells its selection too (a key that types replaces it:
        # SEC8-3); one without the keyboard, or not editable, isn't asked.
        web = Acc("heading", "Editable heading text", text="Editable heading text", selection=(0, 21), states=("showing", "visible", "focused", "editable"))
        self.assertEqual(e.node_of(web, "heading", web.name, list(web.states), None).get("selection"), "Editable heading text")
        still = Acc("section", "", text="Plain text", selection=(0, 5), states=("showing", "visible", "editable"))
        self.assertNotIn("selection", e.node_of(still, "section", "", list(still.states), None))
        fixed = Acc("heading", "Results", text="Results", selection=(0, 7), states=("showing", "visible", "focused"))
        self.assertNotIn("selection", e.node_of(fixed, "heading", "Results", list(fixed.states), None))

    def test_a_drop_down_says_which_option_is_chosen(self):
        # A web page's <select> (Chromium: its options and their Selection on its one child menu, its own text U+FFFC)
        # and GTK's combo box (the Selection its own): the chosen option, in a few calls. Not a secret one's.
        def select(name, options, chosen, own=False):
            items = [Acc("menu item", o, states=("visible", "enabled")) for o in options]
            menu = Acc("menu", kids=items)
            combo = Acc("combo box", name, text="" if own else "\ufffc", kids=[menu])
            sel = types.SimpleNamespace(nSelectedChildren=1, getSelectedChild=lambda i: items[chosen])
            (combo if own else menu).querySelection = lambda: sel
            if own:
                menu.querySelection = lambda: types.SimpleNamespace(nSelectedChildren=0)  # its menu: the item hovered
            return combo, items
        seat, items = select("Seat", ["Window", "Aisle"], 1)
        mode, _ = select("Mode", ["Fast", "Slow"], 0, own=True)
        expiry, _ = select("Card expiry month", ["01", "07"], 1)
        nodes = []
        e.walk(Acc("frame", "Form", kids=[seat, mode, expiry]), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        combos = [n for n in nodes if n["role"] == "combo box"]
        self.assertEqual([(n["name"], n.get("selected"), n.get("text"), n.get("secret")) for n in combos],
                         [("Seat", "Aisle", None, None), ("Mode", "Fast", None, None), ("Card expiry month", None, None, True)])
        self.assertEqual(sum(i.states != ["visible", "enabled"] for i in items), 0)  # options not looked through

    def test_the_cell_with_the_keyboard_is_read_wherever_it_is(self):
        # A full sheet: a read lists GRID_CELLS of its cells, row by row, and the cursor is further down (C29). It is
        # looked for on its own and listed after the sheet's other cells, in every read; after the first, where it was.
        values = dict(((r, c), str(r * 100 + c)) for r in range(60) for c in range(20))
        sheet = Sheet(values, focus=(28, 2), bounds=(37, 158, 1170, 600))  # 30 rows of 15 cells on screen
        root = calc_window(sheet, [Acc("status bar", "Sum=0", bounds=(0, 1160, 1280, 24))])

        def read():
            budget, nodes = e.Budget(), []
            e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
            e.add_cursors(nodes, budget.sheets, time.monotonic() + e.CURSOR_SCAN_S)
            cells = [n for n in nodes if n["role"] == "table cell"]
            focused = [n for n in cells if "focused" in n["states"]]
            return nodes, cells, focused[0] if len(focused) == 1 else None

        for _ in range(3):
            made = sheet.made
            nodes, cells, cur = read()
            self.assertEqual(len(cells), e.GRID_CELLS + 1)
            self.assertEqual((cur["name"], cur["text"], cur["grid"]), ("C29", "2802", True))
            self.assertEqual(cur["bounds"], {"x": 37 + 2 * 80, "y": 158 + 28 * 20, "width": 80, "height": 20})
            self.assertEqual(nodes[nodes.index(cur) + 1]["name"], "Sum=0")  # after the sheet's cells
            self.assertEqual(cur["parent"], [n["id"] for n in nodes if n["role"] == "table"][0])
        # Where it was found, not all the screen again: besides the cells read, the corners and the cursor only.
        self.assertLessEqual(sheet.made - made, e.GRID_CELLS + 4)
        # A key moved it; then the sheet was scrolled away from it (keys still go there: listed without a place).
        sheet.focus = (29, 2)
        self.assertEqual(read()[2]["name"], "C30")
        sheet.top = 500
        cur = read()[2]
        self.assertEqual((cur["name"], cur["bounds"]), ("C30", None))
        self.assertIsNotNone(e.SNAPSHOTS.get(cur["id"]))
        # Without the keyboard the sheet's cells say none has it: nothing is looked for.
        sheet.states.remove("focused")
        sheet.top = 0
        made = sheet.made
        self.assertIsNone(read()[2])
        self.assertLessEqual(sheet.made - made, e.GRID_CELLS + 3)

    def test_a_cell_with_the_keyboard_past_the_screen_is_looked_for_a_while_only(self):
        sheet = Sheet(dict(((r, c), "x") for r in range(60) for c in range(20)), focus=(5000, 2), bounds=(37, 158, 1170, 600))
        budget, nodes = e.Budget(), []
        e.walk(calc_window(sheet), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        t0 = time.monotonic()
        e.add_cursors(nodes, budget.sheets, time.monotonic() + 0.05)
        self.assertLess(time.monotonic() - t0, 0.5)
        self.assertEqual([n for n in nodes if "focused" in n["states"] and n["role"] == "table cell"], [])

    def test_the_cell_with_the_keyboard_is_looked_for_where_ember_expects_it(self):
        # A zoomed-out sheet (100 rows of 15 on screen): every cell asked takes longer the more show, and a look from
        # the top never came to the lower rows in time (PERC8-4). The rows are looked through from both ends inwards,
        # and the cells Ember expects the cursor in (where it moved it to) first, wherever they are.
        e.CURSORS.clear()
        values = dict(((r, c), str(r * 100 + c)) for r in range(120) for c in range(20))
        sheet = Sheet(values, focus=(98, 5), bounds=(37, 158, 1170, 2000))
        root = calc_window(sheet)
        root.bounds = (0, 0, 1280, 2200)

        def read(hints=(), scan=e.CURSOR_SCAN_S):
            e.CURSORS.clear()  # a helper that never saw it
            budget, nodes = e.Budget(), []
            e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
            made = sheet.made
            e.add_cursors(nodes, budget.sheets, time.monotonic() + scan, hints)
            cur = [n for n in nodes if n["role"] == "table cell" and "focused" in n["states"]]
            return (cur[0]["name"] if cur else None), sheet.made - made

        name, asked = read()
        self.assertEqual(name, "F99")
        self.assertLess(asked, 3 * 15)  # the last rows on screen are asked early, not after the 70 rows above them
        self.assertEqual(read([(98, 5)]), ("F99", 1))
        # Scrolled away (keys still go there): found where Ember expects it, listed without a place.
        sheet.focus = (5000, 3)
        self.assertEqual(read([(4999, 3)]), ("D5001", 2))
        self.assertEqual(read([(7, 7), (5000, 3)])[0], "D5001")
        self.assertIsNone(read(scan=0.05)[0])
        self.assertEqual(e.cell_places(["C62", "$AB$7", "c62", "junk", 5, "XFE1", "A0", "B1", "B2", "B3"]),
                         [(61, 2), (6, 27), (0, 1), (1, 1)])
        self.assertEqual(e.cell_places("C62"), [])

    def test_a_sheets_frozen_panes_are_read_top_left_first(self):
        # LibreOffice Calc with frozen rows and columns: four panes, a document and a sheet each, siblings, the scrolled
        # one first. Read in that order, its cells took the read's GRID_CELLS and the column headings were never read
        # (PERC8-3): the panes are read top left first.
        values = dict(((r, c), "Head%d" % c if r == 0 else str(r * 100 + c)) for r in range(200) for c in range(30))

        def pane(top, left, bounds, focus=None):
            sheet = Sheet(values, top=top, left=left, bounds=bounds, focus=focus)
            if focus is None:
                sheet.states.remove("focused")
            return Acc("document spreadsheet", "frozen.fods", bounds=bounds, kids=[sheet])
        corner = pane(0, 0, (37, 158, 80, 20))
        heads = pane(0, 1, (117, 158, 1600, 20))
        rows = pane(50, 0, (37, 178, 80, 800))
        cells = pane(50, 1, (117, 178, 1600, 800), focus=(60, 3))
        holder = Acc("panel", "", bounds=(0, 140, 1800, 900),
                     kids=[rows, Acc("panel", "", bounds=(0, 140, 37, 18)), cells, corner, heads,
                           Acc("page tab list", "", bounds=(0, 1000, 600, 20), kids=[Acc("page tab", "Data", bounds=(0, 1000, 60, 20))])])
        for kid in holder.kids:
            kid.parent = holder
        root = Acc("frame", "frozen.fods - LibreOffice Calc", bounds=(0, 0, 1800, 1100), kids=[holder])
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        tables = [n for n in nodes if n["role"] == "table"]
        listed = [[c["name"] for c in nodes if c["parent"] == t["id"]] for t in tables]
        self.assertEqual([t["bounds"]["y"] * 10000 + t["bounds"]["x"] for t in tables], [1580037, 1580117, 1780037, 1780117])
        self.assertEqual(listed[0], ["A1"])
        self.assertEqual(listed[1][:3], ["B1", "C1", "D1"])
        self.assertEqual(len(listed[1]), 20)  # the whole heading row
        self.assertEqual(listed[2][:2], ["A51", "A52"])
        self.assertEqual(sum(len(x) for x in listed), e.GRID_CELLS)
        self.assertIn("Head5", [n.get("text") for n in nodes])
        # Each pane once; the rest of the window after them, and the read says it left cells out.
        self.assertEqual(len([n for n in nodes if n["role"] == "document spreadsheet"]), 4)
        self.assertEqual(nodes[-1]["name"], "Data")
        self.assertEqual((budget.cut, budget.why), (True, ["nodes"]))
        # LibreOffice says a frozen pane a row high doesn't show, nor its sheet, while its cells do: read all the same.
        # One that isn't visible at all is not.
        for acc in (heads, heads.kids[0]):
            acc.states.remove("showing")
        corner.states = ["enabled"]
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        tables = [n for n in nodes if n["role"] == "table"]
        self.assertEqual([t["bounds"]["x"] for t in tables], [117, 37, 117])
        self.assertEqual([c["name"] for c in nodes if c["parent"] == tables[0]["id"]][:2], ["B1", "C1"])
        # A sheet in one pane is read where it is.
        holder.kids = [cells, holder.kids[-1]]
        budget, nodes = e.Budget(), []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None, None, budget)
        self.assertEqual([n["role"] for n in nodes[:4]], ["frame", "document spreadsheet", "table", "table cell"])

    def test_a_cells_id_outlasts_the_accessible_libreoffice_made_for_it(self):
        # Calc makes a cell's accessible when it is asked for, and the accessibility bridge drops it 15 s later (its
        # sheet lasts): the id asks the sheet for the cell at its place again.
        sheet = Sheet({(0, 0): "Total", (0, 1): "42"}, focus=(5, 5))
        nodes = []
        e.walk(calc_window(sheet), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        b1 = [n for n in nodes if n["name"] == "B1"][0]
        e.stored(e.SNAPSHOTS.latest()[b1["id"]]).states = ["defunct"]
        info = e.read_element({"id": b1["id"]})
        self.assertEqual((info["name"], info["text"]), ("B1", "42"))
        self.assertEqual(e.usable(b1["id"]).name, "B1")
        # The sheet gone too (another sheet shown, the window closed): so is the cell.
        def gone(r, c):
            raise RuntimeError("disposed")
        sheet.cell = gone
        e.stored(e.SNAPSHOTS.latest()[b1["id"]]).states = ["defunct"]
        with self.assertRaises(RuntimeError) as ctx:
            e.read_element({"id": b1["id"]})
        self.assertIn("gone", str(ctx.exception))

    def test_the_secret_scan_leaves_a_spreadsheets_cells_alone(self):
        # Calc's cells hold values, never fields (its form controls are in the drawing layer, beside the sheet): the
        # scan is complete without asking for them, however many show (a maximized window at 90 %: thousands).
        sheet = Sheet(dict(((r, c), "x") for r in range(100) for c in range(20)), top=50, bounds=(37, 158, 2500, 1300))
        card = Acc("entry", "Card number", bounds=(300, 400, 80, 20))
        root = calc_window(sheet)
        root.kids[1].kids.append(card)  # a form control on the sheet: the document's child, beside the table
        found, budget = {"fields": [], "labels": [], "docs": []}, e.Budget(e.SCAN_BUDGET_S)
        e.scan_fields(root, 0, found, None, budget, [0])
        self.assertFalse(budget.busy or budget.over or budget.cut)
        self.assertEqual([acc for _, acc in found["fields"]], [card])
        self.assertLessEqual(sheet.made, 2)  # the cells at its corners, which say what shows
        self.assertEqual(sheet.child_reads, 0)

    def test_secret_scan_reads_only_the_rows_on_screen(self):
        root, lst = self.scrolled_list()
        lst.kids[2510].kids = [Acc("password text", "", bounds=(20, 302, 100, 16))]  # in row 2509, on screen
        found = {"fields": [], "labels": [], "docs": []}
        budget = e.Budget(e.SCAN_BUDGET_S)
        e.scan_fields(root, 0, found, None, budget, [0])
        self.assertEqual([r for r, _ in found["fields"]], ["password text"])
        self.assertFalse(budget.busy or budget.over or budget.cut)
        self.assertLess(lst.child_reads, 120)

    def scrolled_page(self, page_states=("showing", "visible")):
        """GTK 3's settings page scrolled more than a screen down: its viewport says it doesn't show (GTK judges
        it against its own scroll position), the rows in it say they do, where they are."""
        on, off = ("showing", "visible", "enabled", "sensitive"), ("visible", "enabled", "sensitive")
        rows = [Acc("label", "Row %d" % i, bounds=(10, 60 + 40 * (i - 20), 150, 30), states=on if 20 <= i < 28 else off)
                for i in range(40)]
        rows[23] = Acc("slider", "", bounds=(10, 180, 400, 40), states=on)
        rows[25] = Acc("password text", "", bounds=(170, 260, 200, 30), states=on)
        box = Acc("filler", "", bounds=(10, -740, 400, 1600), states=page_states, kids=rows)
        view = Acc("viewport", "", bounds=(e.INT_MIN, e.INT_MIN, 400, 360), states=("visible", "enabled"), kids=[box])
        bar = Acc("scroll bar", "", bounds=(395, 60, 15, 360))
        pane = Acc("scroll pane", "", bounds=(10, 60, 400, 360), kids=[view, bar])
        return Acc("frame", "Settings", bounds=(0, 0, 420, 430), kids=[pane]), view, box

    def test_a_page_scrolled_past_its_first_screen_is_read(self):
        root, view, _ = self.scrolled_page()
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([n["role"] for n in nodes].count("label"), 6)
        self.assertIn("slider", [n["role"] for n in nodes])
        self.assertIn("scroll bar", [n["role"] for n in nodes])
        self.assertNotIn("viewport", [n["role"] for n in nodes])
        # The secret scan before a screenshot looks there too.
        found, budget = {"fields": [], "labels": [], "docs": []}, e.Budget(e.SCAN_BUDGET_S)
        e.scan_fields(root, 0, found, None, budget, [0])
        self.assertEqual([r for r, _ in found["fields"]], ["password text"])
        self.assertEqual(len(found["labels"]), 6)
        # A viewport that isn't visible at all stays hidden, its rows unasked.
        view.states, view.child_reads = ["enabled"], 0
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([n["role"] for n in nodes], ["frame", "scroll bar"])
        self.assertEqual(view.child_reads, 0)

    def test_a_hidden_page_stays_hidden(self):
        # A page of a stack not shown: its viewport and what it holds say they don't show; one look, and no more.
        root, view, box = self.scrolled_page(page_states=("visible",))
        nodes = []
        self.assertTrue(e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None))
        self.assertEqual([n["role"] for n in nodes], ["frame", "scroll bar"])
        self.assertEqual((view.child_reads, box.child_reads), (1, 0))
        found = {"fields": [], "labels": [], "docs": []}
        e.scan_fields(root, 0, found, None, e.Budget(e.SCAN_BUDGET_S), [0])
        self.assertEqual((found["fields"], found["labels"]), ([], []))
        # A viewport that doesn't show outside a scroll pane, or something else not showing in one, isn't looked into.
        lone = Acc("viewport", "", states=("visible",), kids=[Acc("label", "Hidden")])
        other = Acc("panel", "", states=("visible",), kids=[Acc("label", "Hidden too")])
        nodes = []
        e.walk(Acc("frame", "W", kids=[lone, Acc("scroll pane", "", kids=[other])]), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([n["name"] for n in nodes], ["W"])
        self.assertEqual((lone.child_reads, other.child_reads), (0, 0))

    def test_cut_short_only_when_something_is_left(self):
        kids = [Acc("push button", "B%d" % i) for i in range(4)]
        for limit, cut in ((5, False), (4, True)):
            budget = e.Budget()
            e.walk(Acc("frame", "W", kids=kids), 0, [], e.MAX_DEPTH, limit, None, None, budget)
            self.assertEqual(budget.cut, cut, limit)

    def test_a_complete_read_finishing_at_its_deadline_is_not_slow(self):
        budget = e.Budget(0.05)
        nodes = []
        e.walk(Acc("frame", "W", kids=[Acc("push button", "B%d" % i) for i in range(5)]), 0, nodes, e.MAX_DEPTH,
               e.MAX_NODES, None, None, budget)
        time.sleep(0.06)
        budget.check()  # what read_window does after the walk
        self.assertEqual(len(nodes), 6)
        self.assertFalse(budget.over or budget.cut or budget.busy)

    def test_an_element_that_fails_to_answer_is_skipped(self):
        class Broken(Acc):
            def getRoleName(self):
                raise RuntimeError("timeout from dbind")
        nodes = []
        e.walk(Acc("frame", "W", kids=[Broken("push button", "X"), Acc("push button", "OK")]), 0, nodes,
               e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([n["name"] for n in nodes], ["W", "OK"])

    def test_actions_only_for_controls(self):
        label = Acc("label", "Hello", acts=["click"])
        button = Acc("push button", "Save", acts=["click"])
        nodes = []
        e.walk(Acc("frame", "W", kids=[label, button]), 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual(label.asked_actions, 0)
        self.assertEqual([n.get("actions") for n in nodes], [None, None, ["click"]])

    def test_positionless_widgets_have_no_bounds(self):
        self.assertIsNone(e.bounds_of(e.INT_MIN, e.INT_MIN, 10, 10))
        self.assertIsNone(e.bounds_of(0, 0, -1, -1))
        self.assertEqual(e.bounds_of(1, 2, 3, 4), {"x": 1, "y": 2, "width": 3, "height": 4})
        acc = Acc("push button", "Off", bounds=(e.INT_MIN, e.INT_MIN, 20, 20))
        self.assertIsNone(e.node_info(acc)["bounds"])

    def test_values_json_cannot_carry(self):
        acc = Acc("slider", "Volume")
        acc.queryValue = lambda: types.SimpleNamespace(currentValue=float("nan"))
        self.assertIsNone(e.value_of(acc))
        out = json.loads(e.encode({"jsonrpc": "2.0", "id": 7, "result": {"v": float("inf")}}))
        self.assertEqual(out["id"], 7)
        self.assertIn("could not be encoded", out["error"]["message"])


class Ids(unittest.TestCase):
    def test_ids_continue_from_the_given_base(self):
        self.assertEqual(e.first_id({"EMBER_ATSPI_ID_BASE": "30000000"}), 30000001)

    def test_random_base_otherwise(self):
        for env in ({}, {"EMBER_ATSPI_ID_BASE": "junk"}, {"EMBER_ATSPI_ID_BASE": "-5"}):
            first = e.first_id(env)
            self.assertGreater(first, 2 ** 20)
            self.assertLess(first, 2 ** 53)
            self.assertEqual((first - 1) % (2 ** 20), 0)

    def test_ids_from_another_process_are_unknown(self):
        a = e.Snapshots(start=e.first_id({"EMBER_ATSPI_ID_BASE": "10000000"}))
        b = e.Snapshots(start=e.first_id({"EMBER_ATSPI_ID_BASE": "20000000"}))
        a.begin()
        b.begin()
        stale = a.add(Acc("push button", "Delete"))
        b.add(Acc("push button", "Keep"))
        with self.assertRaises(KeyError) as ctx:
            b.get(stale)
        self.assertIn("no longer known", str(ctx.exception))

    def test_quick_looks_keep_the_ids_of_the_reads_acted_on(self):
        s = e.Snapshots(start=1)
        s.begin()
        kept = s.add(Acc("push button", "Bold"))
        # A key pressed ten times: before each, a look at what has the keyboard (twice: before and once in front).
        for _ in range(20):
            s.begin(keep=False)
            look = s.add(Acc("text", "Notes"))
            s.end()
        self.assertEqual(s.get(kept).name, "Bold")
        self.assertEqual(s.get(look).name, "Notes")
        # Ids added after a look (secret fields for a screenshot) go with the newest kept read, not the look's.
        later = s.add(Acc("password text", ""))
        s.begin(keep=False)
        self.assertEqual(s.get(later).role, "password text")
        # Kept reads still push out the oldest kept ones.
        for _ in range(e.Snapshots.KEEP):
            s.begin()
        with self.assertRaises(KeyError):
            s.get(kept)


class Acting(unittest.TestCase):
    def setUp(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()

    def act_on(self, acc, method, **params):
        params["id"] = e.SNAPSHOTS.add(acc)
        return e.METHODS[method](params)

    def test_refuses_disabled_hidden_and_gone_elements(self):
        disabled = Acc("push button", "Send", states=("showing", "visible"), acts=["click"])
        hidden = Acc("push button", "Send", states=("visible", "enabled", "sensitive"), acts=["click"])
        gone = Acc("push button", "Send", states=(), acts=["click"])
        for acc, why in ((disabled, "disabled"), (hidden, "no longer on screen"), (gone, "gone")):
            for method in ("do_action", "set_text", "select_option", "set_value"):
                with self.assertRaises(RuntimeError) as ctx:
                    self.act_on(acc, method, text="x", option="a", value=1)
                self.assertIn(why, str(ctx.exception), method)

    def test_clicks_usable_elements(self):
        done = []
        ok = Acc("push button", "Save", acts=["click"])
        ok.queryAction = lambda: types.SimpleNamespace(nActions=1, getName=lambda i: "click",
                                                       doAction=lambda i: done.append(i) or True)
        settle, e.settle = e.settle, lambda: None
        try:
            res = self.act_on(ok, "do_action")
        finally:
            e.settle = settle
        self.assertTrue(res["ok"])
        self.assertEqual(done, [0])

    def test_no_text_into_secret_fields(self):
        with self.assertRaises(PermissionError):
            self.act_on(Acc("text", "Card number", text=""), "set_text", text="4111")

    def combo(self, chosen):
        items = [Acc("menu item", "Keep"), Acc("menu item", "Delete permanently")]
        combo = Acc("combo box", "When done", kids=[Acc("menu", kids=items)])
        combo.querySelection = lambda: types.SimpleNamespace(selectChild=lambda i: chosen.append(i) or True,
                                                             isChildSelected=lambda i: False)
        return combo

    def test_an_option_by_its_full_name_only(self):
        chosen = []
        settle, e.settle = e.settle, lambda: None
        try:
            # Part of a name never chooses it: Ember judged the option it was given, not "Delete permanently".
            with self.assertRaises(ValueError) as ctx:
                self.act_on(self.combo(chosen), "select_option", option="permanently")
            self.assertNotIn("Delete", str(ctx.exception))
            self.assertEqual(chosen, [])
            self.assertEqual(self.act_on(self.combo(chosen), "select_option", option="Keep")["option"], "Keep")
            self.assertEqual(self.act_on(self.combo(chosen), "select_option", option="delete permanently")["option"], "Delete permanently")
            self.assertEqual(chosen, [0, 1])
        finally:
            e.settle = settle

    def test_a_click_that_closes_its_dialog_is_done(self):
        close = Acc("push button", "Close", acts=["click"])

        def gone():
            raise RuntimeError("atspi_error: The object /org/a11y/atspi/accessible/7 does not exist")

        def click(i):
            close.getRoleName = gone
            close.states = []
            return True
        close.queryAction = lambda: types.SimpleNamespace(nActions=1, getName=lambda i: "click", doAction=click)
        settle, e.settle = e.settle, lambda: None
        try:
            res = self.act_on(close, "do_action")
        finally:
            e.settle = settle
        self.assertTrue(res["ok"])
        self.assertIsNone(res["after"])
        self.assertTrue(res["gone"])

    def test_a_busy_app_is_busy_not_gone(self):
        slow = Acc("push button", "Send", acts=["click"])

        def no_reply():
            raise RuntimeError("Did not receive a reply. Possible causes include: the remote application did not send a reply")
        slow.getState = no_reply
        saved, e.SLOW_APP_S = e.SLOW_APP_S, -1.0
        try:
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(slow, "do_action")
            self.assertEqual(str(ctx.exception), e.BUSY)
        finally:
            e.SLOW_APP_S = saved
        # Reading it back: busy in Ember's words, never libatspi's own.
        quiet = Acc("push button", "Send")
        quiet.getRoleName = no_reply
        with self.assertRaises(RuntimeError) as ctx:
            self.act_on(quiet, "read_element")
        self.assertEqual(str(ctx.exception), e.BUSY)

    # Review round 6: Chromium (Chrome, Electron apps) and Firefox name their actions by what they do now.
    @staticmethod
    def checkable(role, name, names, checked=False):
        """A control whose actions `names(acc)` are named by its state, as Chromium's are; the ones done are kept."""
        acc = Acc(role, name, states=("showing", "visible", "enabled", "sensitive") + (("checked",) if checked else ()))
        acc.done = []

        def do(i):
            n = names(acc)[i].lower()
            acc.done.append(n)
            on = "checked" in acc.states
            if n in ("check", "select") or (n == "dodefault" and not on):
                acc.states.append("checked")
            elif on and n in ("uncheck", "dodefault"):
                acc.states.remove("checked")
            return True
        acc.queryAction = lambda: types.SimpleNamespace(nActions=len(names(acc)), getName=lambda i: names(acc)[i], doAction=do)
        return acc

    def test_check_boxes_radio_buttons_and_switches_in_chromium_and_firefox(self):
        chromium = lambda acc: ["uncheck" if "checked" in acc.states else "check", "showContextMenu"]
        settle, e.settle = e.settle, lambda: None
        try:
            box = self.checkable("check box", "Urgent", chromium)
            self.assertEqual(self.act_on(box, "do_action", action="toggle")["action"], "check")
            self.assertIn("checked", box.states)
            self.assertEqual(self.act_on(box, "do_action", action="toggle")["action"], "uncheck")
            self.assertEqual(self.act_on(box, "do_action", action="click")["action"], "check")
            self.assertEqual(box.done, ["check", "uncheck", "check"])
            # A one-way action that would change nothing is never done (and so never reported as done).
            stale = self.checkable("check box", "Urgent", lambda acc: ["check"], checked=True)
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(stale, "do_action", action="toggle")
            self.assertIn("background_unavailable", str(ctx.exception))
            self.assertEqual(stale.done, [])
            # Firefox: a radio button's "select", which can't turn it off.
            radio = self.checkable("radio button", "Card", lambda acc: ["select"])
            self.assertEqual(self.act_on(radio, "do_action", action="toggle")["action"], "select")
            with self.assertRaises(RuntimeError):
                self.act_on(radio, "do_action", action="toggle")
            # An ARIA switch: "doDefault".
            switch = self.checkable("toggle button", "Notify", lambda acc: ["doDefault", "showContextMenu"])
            res = self.act_on(switch, "do_action", action="toggle")
            self.assertEqual((res["action"], "checked" in res["after"]["states"]), ("dodefault", True))
        finally:
            e.settle = settle

    def test_whether_an_action_can_be_done_is_told_without_doing_it(self):
        box = self.checkable("check box", "Urgent", lambda acc: ["check", "showContextMenu"])
        self.assertEqual(self.act_on(box, "can_do", kind="toggle"), {"tier1": True, "action": "check"})
        self.assertEqual(box.done, [])
        menu_only = self.checkable("check box", "Urgent", lambda acc: ["showContextMenu"])
        out = self.act_on(menu_only, "can_do", kind="toggle")
        self.assertFalse(out["tier1"])
        self.assertIn("no 'toggle' action", out["why"])
        # A Chromium entry has no EditableText; with `caret`, whether it has the keyboard in the active window.
        app = Acc("application", "electron")
        frame = Acc("frame", "Expense report", states=("showing", "visible", "active"))
        entry = Acc("entry", "Description", states=("showing", "visible", "enabled", "sensitive", "editable"), text="")
        frame.parent, app.parent, entry.parent = app, None, frame
        self.assertEqual(self.act_on(entry, "can_do", kind="text", caret=True),
                         {"tier1": False, "why": "this element's text can't be edited directly", "focused": False, "windowActive": True})
        self.assertEqual(self.act_on(Acc("slider", "Volume"), "can_do", kind="value")["tier1"], False)

    def test_a_click_handed_to_the_control_around_it_names_that_control(self):
        # Chromium: text in a link (or an element with a click handler) has only "clickAncestor", which works the
        # nearest ancestor with an action of its own; a list item without a handler of its own is passed over.
        doc = Acc("document web", "Page")
        link = Acc("link", "Delete my account", acts=["jump", "showContextMenu"])
        div = Acc("section", "", acts=["click"])
        item = Acc("list item", "")
        text = Acc("static", "Settings", acts=["clickAncestor"])
        inner = Acc("static", "Withdraw application", acts=["clickAncestor"])
        link.parent, text.parent, div.parent, item.parent, inner.parent = doc, link, doc, div, item
        self.assertEqual(self.act_on(text, "can_do", kind="click"),
                         {"tier1": True, "action": "clickancestor", "handler": {"role": "link", "name": "Delete my account"}})
        self.assertEqual(self.act_on(inner, "can_do", kind="click")["handler"], {"role": "section", "name": ""})
        # Nothing around it acts: no handler (the page stops the looking).
        lone = Acc("static", "Issue #12", acts=["doDefault"])
        lone.parent = Acc("paragraph", "", acts=["doDefault"])
        lone.parent.parent = doc
        self.assertNotIn("handler", self.act_on(lone, "can_do", kind="click"))
        # Its own action (a button's press, an ARIA switch's doDefault): no handler.
        self.assertNotIn("handler", self.act_on(link, "can_do", kind="click"))
        switch = Acc("toggle button", "Notify", acts=["doDefault"])
        switch.parent = div
        self.assertNotIn("handler", self.act_on(switch, "can_do", kind="click"))
        # GTK: a list row's label has no action; the mouse on it clicks the row.
        row = Acc("list item", "")
        label = Acc("label", "Row 2")
        row.parent, label.parent = Acc("list box", ""), row
        row.parent.parent = Acc("frame", "Settings")
        out = self.act_on(label, "can_do", kind="click")
        self.assertEqual((out["tier1"], out["handler"]), (False, {"role": "list item", "name": ""}))
        self.assertNotIn("handler", self.act_on(row, "can_do", kind="click"))

    def test_a_page_tab_takes_clicks_on_its_tab_only(self):
        # GTK (HND8-1): a notebook's page tab is the parent of its whole page, at the tab alone. The mouse on a label in
        # the page (LibreOffice's Format Cells, "Numbers") or in Mousepad's text (one tab: the tab has no position)
        # lands on the label or the text, not on the tab; a row's label in the page still clicks its row.
        frame = Acc("frame", "Format Cells")
        tabs = Acc("page tab list", "", bounds=(468, 296, 665, 494))
        tab = Acc("page tab", "Numbers", bounds=(489, 300, 190, 30))
        page = Acc("panel", "", bounds=(475, 340, 651, 440))
        label = Acc("label", "Leading zeroes:", bounds=(487, 663, 101, 34))
        row = Acc("list item", "", bounds=(475, 360, 200, 30))
        row_label = Acc("label", "Currency", bounds=(480, 365, 120, 20))
        tabs.parent, tab.parent, page.parent, label.parent, row.parent, row_label.parent = frame, tabs, tab, page, page, row
        self.assertNotIn("handler", self.act_on(label, "can_do", kind="click"))
        self.assertEqual(self.act_on(row_label, "can_do", kind="click")["handler"], {"role": "list item", "name": ""})
        lone = Acc("page tab", "", bounds=(e.INT_MIN, e.INT_MIN, 0, 0))
        text = Acc("text", "", bounds=(481, 319, 638, 425), text="")
        lone.parent, text.parent = tabs, lone
        self.assertNotIn("handler", self.act_on(text, "can_do", kind="click"))
        # Chromium: a tab's text has "clickAncestor", and the tab around it takes the click.
        doc = Acc("document web", "Page")
        web_tab = Acc("page tab", "Billing", bounds=(10, 10, 80, 30), acts=["click"])
        words = Acc("static", "Billing", bounds=(20, 15, 50, 20), acts=["clickAncestor"])
        web_tab.parent, words.parent = doc, web_tab
        self.assertEqual(self.act_on(words, "can_do", kind="click")["handler"], {"role": "page tab", "name": "Billing"})

    @staticmethod
    def file_list(names, selected=(0,), multiple=False, takes=True, window=None, focus=True, slow=0.0):
        """GTK's tree view of files (a file dialog): a table of rows, a column holding a cell that holds an icon's cell
        and the name's, then a size column; each cell's actions are a double click's ("activate" is row-activated,
        which opens the row selected before). `takes`: whether it lets a row be selected by accessibility. `window`:
        "active" or "inactive", the dialog it is in (None: none known). Its cursor (`table.cursor`, where Enter goes)
        is on the first row selected; a cell's grabFocus moves it there and selects that row alone, as GTK's does
        (`focus`: the list takes the keyboard), and the cursor's first cell says "focused" while the window is active.
        `slow`: seconds the app takes to make a cell (GTK makes them as they are asked for)."""
        table = Acc("table", "Files", states=("showing", "visible", "enabled", "sensitive", "manages descendants"))
        table.rows = list(selected)
        table.cursor = table.rows[0] if table.rows else 0
        table.activated = []
        table.grabs = []
        table.made = 0
        # In its scroll pane, beside its scroll bar (a long list is no spreadsheet: see spreadsheet()).
        bar = Acc("scroll bar", states=("showing", "visible", "enabled", "vertical"))
        bar.queryValue = lambda: types.SimpleNamespace(minimumValue=0.0, maximumValue=100.0, currentValue=0.0)
        pane = Acc("scroll pane", kids=[table, bar])
        table.parent = bar.parent = pane
        if window is not None:
            frame = Acc("dialog", "Open File", states=("showing", "visible", "enabled") + (("active",) if window == "active" else ()))
            frame.parent = types.SimpleNamespace(getRoleName=lambda: "application")
            pane.parent = frame
        cells = []
        for r, name in enumerate(names):
            for c in range(2):
                if c == 0:
                    icon = Acc("table cell", "", acts=["expand or contract", "edit", "activate"])
                    named = Acc("table cell", name, acts=["expand or contract", "edit", "activate"])
                    cell = Acc("table cell", "", kids=[icon, named], acts=["expand or contract", "edit", "activate"])
                    icon.parent = named.parent = cell
                else:
                    cell = Acc("table cell", "%d bytes" % (10 + r), acts=["expand or contract", "edit", "activate"])
                cell.parent = table
                cell.getIndexInParent = (lambda i: lambda: i)(len(cells))
                cells.append(cell)
        for cell in cells + [k for c in cells for k in c.kids]:
            cell.queryAction = (lambda acc: lambda: types.SimpleNamespace(
                nActions=3, getName=lambda i: acc.acts[i], doAction=lambda i: table.activated.append(i) or True))(cell)
        table.kids = cells

        def show_cursor():
            for i, cell in enumerate(cells):
                if "focused" in cell.states:
                    cell.states.remove("focused")
                if i == table.cursor * 2 and window == "active":
                    cell.states.append("focused")
        table.show_cursor = show_cursor
        show_cursor()

        def grab(i):
            table.grabs.append(i // 2)
            if not focus:
                return False
            table.cursor, table.rows = i // 2, [i // 2]
            show_cursor()
            return True
        for i, cell in enumerate(cells):
            cell.queryComponent = (lambda i: lambda: types.SimpleNamespace(grabFocus=lambda: grab(i)))(i)

        def cell_at(r, c):
            table.made += 1
            if slow:
                time.sleep(slow)
            return cells[r * 2 + c]

        def add(r):
            if not takes or r in table.rows:
                return False
            table.rows = sorted(table.rows + [r]) if multiple else [r]
            return True

        def remove(r):
            if r not in table.rows:
                return False
            table.rows.remove(r)
            return True
        table.queryTable = lambda: types.SimpleNamespace(
            nRows=len(names), nColumns=2, getRowAtIndex=lambda i: i // 2, getAccessibleAt=cell_at,
            getSelectedRows=lambda: list(table.rows), addRowSelection=add, removeRowSelection=remove)
        table.querySelection = lambda: types.SimpleNamespace(selectChild=lambda i: False, isChildSelected=lambda i: False)
        return table, [c.kids[1] if c.kids else c for c in cells[::2]]

    def test_a_click_on_a_row_of_a_list_selects_it_and_never_opens_it(self):
        # A GTK file dialog (PR8-1): "click report.pdf" selects that row alone; its "activate" (a double click) would
        # open agenda.txt, the row selected before. In a list that lets several be chosen, the others go too.
        names = ["agenda.txt", "budget.csv", "meeting.txt", "minutes.txt", "notes.md", "report.pdf"]
        settle, e.settle = e.settle, lambda: None
        try:
            table, named = self.file_list(names)
            self.assertEqual(self.act_on(named[5], "can_do", kind="click"), {"tier1": True, "action": "select row"})
            res = self.act_on(named[5], "do_action", action="click")
            self.assertEqual((res["ok"], res["action"], table.rows, table.activated), (True, "select row", [5], []))
            table, named = self.file_list(names, selected=range(6), multiple=True)
            self.assertTrue(self.act_on(named[1], "do_action", action="click")["ok"])
            self.assertEqual((table.rows, table.activated), ([1], []))
            # Its row selected already: nothing changes, and it is done.
            self.assertTrue(self.act_on(named[1], "do_action", action="click")["ok"])
            # A list that won't select by accessibility: the mouse clicks it (with the user's OK), nothing is activated.
            table, named = self.file_list(names, takes=False)
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(named[5], "do_action", action="click")
            self.assertIn("background_unavailable", str(ctx.exception))
            self.assertEqual((table.rows, table.activated), ([0], []))
            # No list of rows around it (no Table): the mouse, as can_do says.
            lone = Acc("table cell", "x", acts=["activate"])
            lone.parent = Acc("panel", "")
            self.assertFalse(self.act_on(lone, "can_do", kind="click")["tier1"])
        finally:
            e.settle = settle

    def test_a_row_of_a_list_is_chosen_by_its_cells_words(self):
        names = ["agenda.txt", "budget.csv", "report.pdf", "report.pdf"]
        settle, e.settle = e.settle, lambda: None
        try:
            table, _ = self.file_list(names)
            self.assertEqual(self.act_on(table, "list_options")["options"], names)
            res = self.act_on(table, "select_option", option="budget.csv")
            self.assertEqual((res["ok"], res["option"], table.rows, table.activated), (True, "budget.csv", [1], []))
            self.assertEqual(res["after"]["selected"], "budget.csv")
            # Two rows of that name can't be told apart: neither is chosen.
            with self.assertRaises(ValueError):
                self.act_on(table, "select_option", option="report.pdf")
            self.assertEqual(table.rows, [1])
            # A spreadsheet's sheet is no list of rows.
            self.assertIsNone(e.row_list(Sheet({})))
        finally:
            e.settle = settle

    def test_a_row_is_chosen_with_the_lists_cursor_as_a_click_chooses_it(self):
        # H9-1: Table.addRowSelection moves GTK's selection, not its cursor, which Enter (row-activated) and some apps
        # follow (LibreOffice's Options tree shows its cursor's page). In the active window the row's cell takes the
        # keyboard: cursor and selection go there together, and nothing is opened.
        names = ["agenda.txt", "budget.csv", "meeting.txt", "minutes.txt", "notes.md", "report.pdf"]
        settle, e.settle = e.settle, lambda: None
        try:
            table, named = self.file_list(names, window="active")
            self.assertEqual(self.act_on(named[5], "can_do", kind="click"), {"tier1": True, "action": "select row"})
            res = self.act_on(named[5], "do_action", action="click")
            self.assertEqual((res["ok"], res["action"]), (True, "select row"))
            self.assertEqual((table.rows, table.cursor, table.grabs, table.activated), ([5], 5, [5], []))
            # Chosen by name: the same; in a list that lets several be chosen, the others go too.
            table, _ = self.file_list(names, selected=range(6), multiple=True, window="active")
            res = self.act_on(table, "select_option", option="budget.csv")
            self.assertEqual((res["ok"], table.rows, table.cursor, table.activated), (True, [1], 1, []))
            # Its row selected and the cursor on it already: nothing is touched. Selected without the cursor: moved.
            res = self.act_on(table, "select_option", option="budget.csv")
            self.assertEqual((res.get("already"), table.grabs), (True, [1]))
            table.cursor = 3
            table.show_cursor()
            self.assertNotIn("already", self.act_on(table, "select_option", option="budget.csv"))
            self.assertEqual((table.rows, table.cursor, table.grabs), ([1], 1, [1, 1]))
            # A list whose cells won't take the keyboard: the Table selects the row (its cursor stays).
            table, named = self.file_list(names, window="active", focus=False)
            self.assertTrue(self.act_on(named[2], "do_action", action="click")["ok"])
            self.assertEqual((table.rows, table.cursor, table.grabs, table.activated), ([2], 0, [2], []))
            # A window the user isn't in: choosing would bring it to the front, so the mouse does it (with their OK).
            table, named = self.file_list(names, window="inactive")
            out = self.act_on(named[5], "can_do", kind="click")
            self.assertEqual((out["tier1"], out["action"]), (False, "select row"))  # the mouse's click only selects it too
            self.assertIn("isn't the active one", out["why"])
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(named[5], "do_action", action="click")
            self.assertIn("background_unavailable", str(ctx.exception))
            # Chosen by name there: the row's cell is to be clicked instead (the mouse, with the user's OK).
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(table, "select_option", option="report.pdf")
            self.assertIn("click a cell of that row instead", str(ctx.exception))
            self.assertEqual((table.rows, table.cursor, table.grabs, table.activated), ([0], 0, [], []))
            # ... unless it is the one selected already.
            self.assertTrue(self.act_on(table, "select_option", option="agenda.txt")["already"])
            self.assertTrue(self.act_on(named[0], "can_do", kind="click")["tier1"])
        finally:
            e.settle = settle

    def test_a_check_box_in_a_list_is_ticked_by_the_mouse_and_never_opens_its_row(self):
        # HND10-1: GTK 3's check box cell (firewall-config's services) says "toggle", then what its other actions do;
        # its "toggle" is the row's "activate" (row-activated): the box isn't ticked. Only a click on it ticks it.
        names = ["ssh", "http", "https"]
        settle, e.settle = e.settle, lambda: None
        try:
            table, named = self.file_list(names, window="active")
            box = table.kids[1 * 2 + 1]
            box.acts = ["toggle", "Expands or contracts the row in the tree view containing this cell",
                        "Creates a widget in which the contents of the cell can be edited", "Activates the cell"]
            box.name = ""
            for kind in ("click", "toggle"):
                out = self.act_on(box, "can_do", kind=kind)
                self.assertEqual((out["tier1"], out["action"]), (False, "toggle"), kind)
                self.assertIn("ticked only by a click on it", out["why"])
                self.assertNotIn("handler", out)
                with self.assertRaises(RuntimeError) as ctx:
                    self.act_on(box, "do_action", action=kind)
                self.assertIn("background_unavailable", str(ctx.exception))
            # A toggle on a cell of a row (its own action a double click's) turns nothing on: refused, nothing opened.
            self.assertEqual(self.act_on(named[1], "can_do", kind="toggle"), {"tier1": True, "action": "select row"})
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(named[1], "do_action", action="toggle")
            self.assertIn("no switch or check box", str(ctx.exception))
            self.assertNotIn("background_unavailable", str(ctx.exception))
            self.assertEqual((table.rows, table.activated), ([0], []))
            # Qt's cells say "toggle" alone (it selects them): left to them.
            qt = Acc("table cell", "x", acts=["toggle"])
            self.assertIsNone(e.instead_of_action(qt, ["toggle"], "toggle"))
        finally:
            e.settle = settle

    @staticmethod
    def icon_grid(names, window="active", takes=True):
        """GTK's icon view (a file or template browser): icons whose "activate" opens them (item-activated, a double
        click), in a grid whose Selection selects them; an icon's grabFocus moves the grid's cursor there (it says
        "focused" while its window is active). `takes`: whether the grid selects by accessibility."""
        grid = Acc("layered pane", "", states=("showing", "visible", "enabled", "sensitive"))
        grid.opened, grid.chosen, grid.cursor = [], [], None
        frame = Acc("frame", "Icon Browser", states=("showing", "visible", "enabled") + (("active",) if window == "active" else ()))
        frame.parent = types.SimpleNamespace(getRoleName=lambda: "application")
        grid.parent = frame
        icons = []
        for i, name in enumerate(names):
            icon = Acc("icon", name, acts=["activate"])
            icon.parent = grid
            icon.getIndexInParent = (lambda i: lambda: i)(i)
            icon.queryAction = (lambda i: lambda: types.SimpleNamespace(
                nActions=1, getName=lambda k: "activate", doAction=lambda k: grid.opened.append(i) or True))(i)

            def grab(i=i):
                grid.cursor = i
                for k, other in enumerate(icons):
                    if "focused" in other.states:
                        other.states.remove("focused")
                    if k == i and window == "active":
                        other.states.append("focused")
                return True
            icon.queryComponent = (lambda g: lambda: types.SimpleNamespace(grabFocus=g))(grab)
            icons.append(icon)
        grid.kids = icons

        def select(i):
            if takes:
                grid.chosen = [i]
            return takes

        def clear():
            grid.chosen = []
            return True
        class Selection(object):
            """Asked of the app each time, as pyatspi's is."""
            nSelectedChildren = property(lambda s: len(grid.chosen))
            isChildSelected = staticmethod(lambda i: i in grid.chosen)
            selectChild = staticmethod(select)
            clearSelection = staticmethod(clear)
        grid.querySelection = Selection
        return grid, icons

    def test_a_click_on_an_icon_selects_it_and_never_opens_it(self):
        # HND10-1: GTK's icon view's "activate" opens the icon (a double click); a click selects it alone instead,
        # with the grid's cursor (where Enter goes), as a single click does.
        settle, e.settle = e.settle, lambda: None
        try:
            grid, icons = self.icon_grid(["Report.odt", "Budget.ods", "Slides.odp"])
            self.assertEqual(self.act_on(icons[1], "can_do", kind="click"), {"tier1": True, "action": "select item"})
            res = self.act_on(icons[1], "do_action", action="click")
            self.assertEqual((res["ok"], res["action"]), (True, "select item"))
            self.assertEqual((grid.chosen, grid.cursor, grid.opened), ([1], 1, []))
            res = self.act_on(icons[2], "do_action", action="click")
            self.assertEqual((res["ok"], grid.chosen, grid.cursor, grid.opened), (True, [2], 2, []))
            # A toggle on an icon turns nothing on: refused, nothing opened.
            self.assertEqual(self.act_on(icons[0], "can_do", kind="toggle")["action"], "select item")
            with self.assertRaises(RuntimeError):
                self.act_on(icons[0], "do_action", action="toggle")
            self.assertEqual(grid.opened, [])
            # A window the user isn't in: choosing would bring it to the front, so the mouse does it (with their OK).
            grid, icons = self.icon_grid(["Report.odt", "Budget.ods"], window="inactive")
            out = self.act_on(icons[1], "can_do", kind="click")
            self.assertEqual((out["tier1"], out["action"]), (False, "select item"))
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(icons[1], "do_action", action="click")
            self.assertIn("background_unavailable", str(ctx.exception))
            # A grid that won't select by accessibility: the mouse clicks it.
            grid, icons = self.icon_grid(["Report.odt", "Budget.ods"], takes=False)
            with self.assertRaises(RuntimeError) as ctx:
                self.act_on(icons[1], "do_action", action="click")
            self.assertIn("background_unavailable", str(ctx.exception))
            self.assertEqual(grid.opened, [])
        finally:
            e.settle = settle

    def test_a_cells_formula_is_read_where_asked(self):
        # W10-3: Calc shows a formula that works out to an error as no text; its "Formula" attribute says it went in
        # (cut short at a ":", which LibreOffice escapes).
        cell = Acc("table cell", "A14", states=("showing", "visible", "enabled", "editable"), text="")
        cell.getAttributes = lambda: ["isdropdown:false", "Formula:1/0", "colindextext:A"]
        self.assertNotIn("formula", self.act_on(cell, "read_element"))
        self.assertEqual(self.act_on(cell, "read_element", formula=True)["formula"], "1/0")
        cell.getAttributes = lambda: {"Formula": "SUM(B2\\"}
        self.assertEqual(self.act_on(cell, "read_element", formula=True)["formula"], "SUM(B2\\")
        # A cell that doesn't tell it: none.
        cell.getAttributes = lambda: []
        self.assertNotIn("formula", self.act_on(cell, "read_element", formula=True))

    def test_a_long_list_is_looked_through_in_time(self):
        # H9-2: GTK makes each row's cells as they are asked for. Listing stops in time and says how many rows were
        # left out; choosing stops at the row asked for, checks the rest for another of that name in time and says
        # how many it couldn't; a row not found in time is to be typed instead. The helper never times out.
        names = ["file_%04d.txt" % i for i in range(3000)]
        saved = (e.settle, e.LIST_ROWS_S, e.FIND_ROW_S, e.TWIN_ROWS_S)
        e.settle, e.LIST_ROWS_S, e.FIND_ROW_S, e.TWIN_ROWS_S = lambda: None, 0.15, 0.2, 0.3
        try:
            table, _ = self.file_list(names, slow=0.0005)
            t0 = time.monotonic()
            out = self.act_on(table, "list_options")
            self.assertLess(time.monotonic() - t0, 0.6)
            listed = len(out["options"])
            self.assertTrue(10 < listed < 3000, listed)
            self.assertEqual(out["options"], names[:listed])
            self.assertEqual(out["left"], 3000 - listed)
            # The row's words are asked where the row before had them: a few calls a row.
            table, _ = self.file_list(names[:50])
            e.row_list(table)
            self.assertLess(table.made, 50 * 2 + 4)
            # Chosen: the first of that name, the rest checked for another in time (here, not all of them).
            table, _ = self.file_list(names, slow=0.0005)
            res = self.act_on(table, "select_option", option="file_0003.txt")
            self.assertEqual((res["ok"], res["option"], table.rows), (True, "file_0003.txt", [3]))
            self.assertTrue(0 < res["unchecked"] < 3000 - 4, res["unchecked"])
            # Too far down to be reached in time: nothing is chosen, and the name is to be typed instead.
            with self.assertRaises(ValueError) as ctx:
                self.act_on(table, "select_option", option="file_2999.txt")
            self.assertIn("type the name instead", str(ctx.exception))
            self.assertEqual(table.rows, [3])
            # A short list is checked all through: no "unchecked", and two of a name are refused, as before.
            table, _ = self.file_list(names[:20] + ["file_0003.txt"])
            with self.assertRaises(ValueError) as ctx:
                self.act_on(table, "select_option", option="file_0003.txt")
            self.assertIn("several rows", str(ctx.exception))
            self.assertNotIn("unchecked", self.act_on(table, "select_option", option="file_0004.txt"))
            self.assertNotIn("left", self.act_on(table, "list_options"))
        finally:
            e.settle, e.LIST_ROWS_S, e.FIND_ROW_S, e.TWIN_ROWS_S = saved

    def test_unnamed_options_are_named_by_the_label_inside(self):
        # GTK's list box (PR8-6): its rows have no name, each holds its label.
        rows = [Acc("list item", "", kids=[Acc("filler", "", kids=[Acc("label", t)])]) for t in ("English", "Français", "Deutsch")]
        box = Acc("list box", "", kids=rows)
        chosen = []
        box.querySelection = lambda: types.SimpleNamespace(selectChild=lambda i: chosen.append(i) or True, isChildSelected=lambda i: False)
        self.assertEqual(self.act_on(box, "list_options")["options"], ["English", "Français", "Deutsch"])
        settle, e.settle = e.settle, lambda: None
        try:
            self.assertEqual(self.act_on(box, "select_option", option="Deutsch")["option"], "Deutsch")
        finally:
            e.settle = settle
        self.assertEqual(chosen, [2])

    def test_options_never_say_what_a_secret_field_holds(self):
        # W9-SEC4, PERC9-2: a web page names its options and its grid's cells after what is in them, a card number's
        # input too. The read withholds those names; the options listed, and the option or row said to be chosen, do too.
        # A secret element's options aren't listed at all.
        e.SECRETS = e.SecretFields()
        e.WITHHELD = e.SecretFields()
        card = Acc("entry", "Card number", text="4111 1111 1111 1111", kids=[Acc("static", "4111 1111 1111 1111")])
        held = Acc("list item", "Card number 4111 1111 1111 1111", kids=[Acc("label", "Card number", kids=[card])])
        unseen = Acc("entry", "", text="5500 4821 0000 1234")
        e.SECRETS.add(e.object_key(unseen))  # found secret by a read (the label beside it)
        rows = [Acc("list item", "Personal"), held, Acc("list item", "", kids=[Acc("label", "5500 4821 0000 1234")]), Acc("list item", "Other")]
        box = Acc("list box", "Picker", kids=rows)
        box.querySelection = lambda: types.SimpleNamespace(selectChild=lambda i: True, isChildSelected=lambda i: i == 1)
        fields_within = e.fields_within
        e.fields_within = lambda acc, limit=e.LIST_FIELDS: [card, unseen] if acc in (box, table) else []
        table, _ = self.file_list(["agenda.txt", "5500 4821 0000 1234"], selected=(1,))
        try:
            self.assertEqual(self.act_on(box, "list_options")["options"], ["Personal", "", "", "Other"])
            self.assertEqual(self.act_on(table, "list_options")["options"], ["agenda.txt", ""])
            # The row chosen is said by another cell of it.
            self.assertEqual(e.node_info(table)["selected"], "11 bytes")
            # A name the read withheld stays withheld (WITHHELD), whatever it says.
            e.WITHHELD.add(e.object_key(rows[3]))
            self.assertEqual(self.act_on(box, "list_options")["options"], ["Personal", "", "", ""])
            # A grid's cell holding the input is named by its label, never by the input's text.
            cell = Acc("table cell", "", kids=[Acc("entry", "", text="4111", kids=[Acc("static", "4111")])])
            e.SECRETS.add(e.object_key(cell.kids[0]))
            self.assertEqual(e.cell_words(cell), "")
            combo = Acc("combo box", "Security question", kids=[Acc("menu", "", kids=[Acc("menu item", "Fluffy the cat")])])
            with self.assertRaises(PermissionError):
                self.act_on(combo, "list_options")
        finally:
            e.fields_within = fields_within

    def test_a_click_handed_on_further_than_ember_looks_is_unknown(self):
        # Text under many role=group levels inside a link "Delete everything" (SEC8-5): found however deep the page
        # nests it, and beyond what Ember looks through, unknown (never judged by the text clicked).
        def nest(n, top):
            cur = top
            for _ in range(n):
                g = Acc("panel", "")
                g.parent, cur = cur, g
            return cur
        doc = Acc("document web", "Page")
        link = Acc("link", "Delete everything", acts=["jump"])
        link.parent = doc
        text = Acc("static", "Learn about it", acts=["clickAncestor"])
        text.parent = nest(14, link)
        self.assertEqual(self.act_on(text, "can_do", kind="click")["handler"], {"role": "link", "name": "Delete everything"})
        deep = Acc("static", "Learn about it", acts=["clickAncestor"])
        deep.parent = nest(e.HANDLER_LEVELS + 2, link)
        out = self.act_on(deep, "can_do", kind="click")
        self.assertTrue(out["handlerUnknown"])
        self.assertNotIn("handler", out)
        # Nothing acts around it up to the page: no handler, as before.
        lone = Acc("static", "Issue #12", acts=["doDefault"])
        lone.parent = nest(20, doc)
        self.assertEqual(self.act_on(lone, "can_do", kind="click"), {"tier1": True, "action": "dodefault"})

    @staticmethod
    def web_select(options, selected=0, takes=True):
        """A Chromium <select>: a combo box without Selection; its one child menu has it, but refuses selectChild
        while closed; each option's "select" action chooses it (unless `takes` is False; "clears": another option's only
        takes the choice away), and on the chosen option takes the choice away (the field is left empty)."""
        items = [Acc("menu item", n, states=("visible", "enabled", "selectable") + (("selected",) if i == selected else ()))
                 for i, n in enumerate(options)]
        menu = Acc("menu", kids=items)
        menu.done = []

        def choose(item):
            menu.done.append(item.name)
            if "selected" in item.states:
                item.states.remove("selected")
            elif takes:
                for other in items:
                    if "selected" in other.states:
                        other.states.remove("selected")
                if takes != "clears" or item is items[selected]:
                    item.states.append("selected")
            return True
        for item in items:
            item.queryAction = (lambda it: lambda: types.SimpleNamespace(
                nActions=2, getName=lambda i: ["select", "showContextMenu"][i], doAction=lambda i: choose(it)))(item)
        menu.querySelection = lambda: types.SimpleNamespace(selectChild=lambda i: False,
                                                            isChildSelected=lambda i: "selected" in items[i].states)
        combo = Acc("combo box", "Category", kids=[menu], acts=["open"])

        def no_selection():
            raise NotImplementedError
        combo.querySelection = no_selection
        return combo

    def test_a_drop_down_in_a_web_page_or_electron_app(self):
        settle, e.settle = e.settle, lambda: None
        try:
            combo = self.web_select(["Travel", "Meals", "Office"])
            self.assertEqual(self.act_on(combo, "list_options")["options"], ["Travel", "Meals", "Office"])
            self.assertEqual(self.act_on(combo, "read_element")["selected"], "Travel")
            res = self.act_on(combo, "select_option", option="meals")
            self.assertEqual((res["ok"], res["option"], res["after"]["selected"]), (True, "Meals", "Meals"))
            # One that doesn't take the choice is reported as not done.
            stuck = self.web_select(["Travel", "Meals"], takes=False)
            res = self.act_on(stuck, "select_option", option="Meals")
            self.assertEqual((res["ok"], res["after"]["selected"]), (False, "Travel"))
            # The option chosen already: nothing is touched (its "select" would take the choice away) (PR7-1).
            same = self.web_select(["Travel", "Aisle", "Window"], selected=1)
            res = self.act_on(same, "select_option", option="Aisle")
            self.assertEqual((res["ok"], res["after"]["selected"], same.kids[0].done), (True, "Aisle", []))
            # An option that only takes the choice away: the one chosen before is chosen again, never an empty field.
            clears = self.web_select(["Travel", "Meals"], takes="clears")
            res = self.act_on(clears, "select_option", option="Meals")
            self.assertEqual((res["ok"], res["after"]["selected"], clears.kids[0].done), (False, "Travel", ["Meals", "Travel"]))
        finally:
            e.settle = settle

    def test_an_open_menu(self):
        items = [Acc("menu item", "New", states=("visible", "enabled")), Acc("menu item", "Open", states=("visible", "enabled"))]
        menu = Acc("menu", "File", kids=items)
        self.assertEqual(self.act_on(menu, "read_element")["open"], False)
        for item in items:
            item.states.append("showing")
        self.assertEqual(self.act_on(menu, "read_element")["open"], True)
        self.assertNotIn("open", self.act_on(Acc("push button", "Save"), "read_element"))


class Windows(unittest.TestCase):
    class AppNode(object):
        def __init__(self, pid, wins, delay=0.0):
            self.name = "app%d" % pid
            self.pid = pid
            self.wins = wins
            self.delay = delay
            self.asked = 0

        def get_process_id(self):
            return self.pid

        @property
        def childCount(self):
            self.asked += 1
            time.sleep(self.delay)
            return len(self.wins)

        def getChildAtIndex(self, i):
            return self.wins[i]

    def setUp(self):
        e.HUNG.clear()
        e.PROBED.clear()
        e.STRIKES.clear()
        e.KNOWN.clear()
        e.new_request()
        self.mail =self.AppNode(10, [Acc("frame", "Inbox - Mail", states=("showing",)),
                                      Acc("frame", "Compose - Mail", states=("showing", "active"))])
        self.notes = self.AppNode(20, [Acc("frame", "notes.txt - Text Editor", states=("showing",))])
        self.desktop = Acc("desktop frame", "main", kids=[self.mail, self.notes])
        FAKE.Registry = types.SimpleNamespace(getDesktop=lambda i: self.desktop)
        # Process names as /proc would give them (none: as if it couldn't be read).
        self.comm = {}
        self.saved_process_name, e.process_name = e.process_name, lambda pid: self.comm.get(pid)

    def tearDown(self):
        e.process_name = self.saved_process_name

    def name_of(self, params):
        found = e.find_window(params)
        return found[2].name if found else None

    @staticmethod
    def later(pid):
        """As if the app's last strike was a while ago (no longer the same busy moment)."""
        count, last = e.STRIKES[pid]
        e.STRIKES[pid] = (count, last - e.STRIKE_GAP_S - 0.1)

    def test_a_window_by_its_path_or_none(self):
        compose = self.mail.wins[1]
        found = e.find_window({"pid": 10, "path": compose.path})
        self.assertIs(found[2], compose)
        self.assertEqual(e.describe_window(*found)["path"], compose.path)
        # Closed: nothing, not the app's other window and not the active one.
        self.assertIsNone(e.find_window({"pid": 10, "path": "/org/a11y/atspi/accessible/gone"}))
        self.assertIsNone(e.find_window({"pid": 20, "path": compose.path}))

    def test_window_choice(self):
        self.assertEqual(self.name_of({"pid": 10}), "Compose - Mail")
        self.assertEqual(self.name_of({"pid": 10, "title": "Inbox - Mail"}), "Inbox - Mail")
        self.assertEqual(self.name_of({"title": "notes"}), "notes.txt - Text Editor")
        self.assertEqual(self.name_of({}), "Compose - Mail")
        self.assertIsNone(self.name_of({"pid": 99}))

    def test_other_apps_are_not_asked_when_the_pid_is_known(self):
        self.name_of({"pid": 10})
        self.assertEqual(self.notes.asked, 0)

    def test_hung_apps_are_skipped_for_a_while(self):
        class Hung(self.AppNode):
            @property
            def childCount(self):
                self.asked += 1
                time.sleep(self.delay)
                return -1  # what libatspi answers when the call timed out
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.01
        try:
            hung = Hung(30, [], delay=0.05)
            self.desktop.kids.append(hung)
            self.assertEqual(len(e.list_windows({})["windows"]), 3)
            self.assertFalse(e.is_hung(30))  # once: maybe only busy
            e.list_windows({})
            self.assertFalse(e.is_hung(30))  # asked again right away: the same busy moment
            self.later(30)
            e.list_windows({})
            self.assertTrue(e.is_hung(30))  # twice in a row, a while apart: hung
            asked = hung.asked
            self.assertEqual(self.name_of({"title": "notes"}), "notes.txt - Text Editor")
            self.assertEqual(len(e.list_windows({})["windows"]), 3)
            self.assertEqual(hung.asked, asked)
            # Asked for by its own pid, it is still tried.
            self.assertIsNone(self.name_of({"pid": 30}))
            self.assertEqual(hung.asked, asked + 1)
            # A few seconds on, a list asks it once more (one timeout); it is still hung.
            e.PROBED[30] -= e.REPROBE_S
            self.assertEqual(len(e.list_windows({})["windows"]), 3)
            self.assertEqual(hung.asked, asked + 2)
            self.assertTrue(e.is_hung(30))
            e.list_windows({})
            self.assertEqual(hung.asked, asked + 2)
            e.HUNG[30] = time.monotonic() - 1  # 30 s later
            self.assertFalse(e.is_hung(30))
        finally:
            e.SLOW_APP_S = old

    def test_a_hung_app_that_answers_again_is_listed_again_within_seconds(self):
        self.assertEqual(len(e.list_windows({})["windows"]), 3)
        e.mark_hung(20)
        asked = self.notes.asked
        self.assertEqual(e.list_windows({})["windows"][-1].get("busy"), True)
        self.assertTrue(e.read_window({"title": "notes.txt"})["busy"])
        self.assertEqual(self.notes.asked, asked)
        e.PROBED[20] -= e.REPROBE_S
        self.assertEqual(self.name_of({"title": "notes.txt"}), "notes.txt - Text Editor")
        self.assertFalse(e.is_hung(20))
        self.assertNotIn("busy", e.list_windows({})["windows"][-1])

    def test_busy_apps_stay_listed(self):
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.01
        try:
            self.notes.delay = 0.05  # slow, but it answers
            for _ in range(3):
                self.assertEqual(len(e.list_windows({})["windows"]), 3)
            self.assertFalse(e.is_hung(20))
        finally:
            e.SLOW_APP_S = old

    def test_a_busy_window_is_busy_not_gone(self):
        class Slow(Acc):
            """Every call times out (the stand-in takes a little longer than SLOW_APP_S, set short here)."""
            def getState(self):
                time.sleep(0.05)
                return States([])

            @property
            def name(self):
                time.sleep(0.05)
                return ""

            @name.setter
            def name(self, value):
                pass
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.03
        try:
            self.mail.wins.append(Slow("dialog", "Open File"))
            out = e.read_window({"title": "Open File"})
            self.assertIsNone(out["window"])
            self.assertTrue(out["busy"])
            # Busy while being read: what it answered so far, flagged, and a strike against it.
            self.mail.wins.pop()
            self.mail.wins[1].states.append("visible")
            self.mail.wins[1].kids = [Acc("push button", "Send"), Slow("push button", "Attach")]
            out = e.read_window({"pid": 10, "title": "Compose - Mail"})
            self.assertTrue(out["busy"])
            self.assertEqual([n["name"] for n in out["nodes"]], ["Compose - Mail", "Send"])
            self.assertIn(10, e.STRIKES)
        finally:
            e.SLOW_APP_S = old

    def test_never_look_windows_are_not_read(self):
        notes = self.notes.wins[0]
        notes.kids = [Acc("text", "", text="my diary")]
        out = e.read_window({"pid": 20, "neverLook": ["text editor"]})
        self.assertTrue(out["blocked"])
        self.assertEqual(out["nodes"], [])
        self.assertEqual(notes.child_reads, 0)
        # By process: Ember found it by the window's X11 class.
        self.assertTrue(e.read_window({"pid": 20, "neverLook": ["keepassxc"], "skipPids": [20]})["blocked"])
        self.assertNotIn("blocked", e.read_window({"pid": 20, "neverLook": ["keepassxc"]}))

    def test_the_apps_other_windows_are_named(self):
        dialog = Acc("file chooser", "Open File", states=("showing", "active", "modal"))
        self.mail.wins.append(dialog)
        self.mail.wins[1].states.remove("active")
        out = e.read_window({"pid": 10, "path": self.mail.wins[1].path})
        self.assertEqual(out["window"]["name"], "Compose - Mail")
        self.assertEqual(out["others"], [{"name": "Open File", "role": "file chooser", "active": True, "modal": True}])

    def test_secret_fields_are_reported_for_ember_to_keep(self):
        pw = Acc("password text", "", text="hunter2")
        self.notes.wins[0].states.append("visible")
        self.notes.wins[0].kids = [pw]
        out = e.read_window({"pid": 20})
        self.assertEqual(out["secretKeys"], [[pw.app.bus_name, pw.path]])

    def test_gnome_shell_dialogs_and_notifications(self):
        self.assertEqual(e.shell_overlays({}), {"overlays": [], "complete": True})
        prompt = Acc("dialog", "", bounds=(400, 300, 480, 260),
                     kids=[Acc("label", "Authentication Required"), Acc("password text", "Password")])
        banner = Acc("notification", "", bounds=(500, 0, 400, 80), kids=[Acc("label", "New mail")])
        hidden = Acc("notification", "", states=("visible",), bounds=(0, 0, 10, 10))
        stage = Acc("window", "", kids=[Acc("panel", "Top bar"), prompt, banner, hidden])
        shell = self.AppNode(99, [stage])
        shell.name = "gnome-shell"
        shell.getRoleName = lambda: "application"
        shell.getState = lambda: States([])
        self.desktop.kids.append(shell)
        out = e.shell_overlays({})["overlays"]
        self.assertEqual([(o["role"], o["bounds"]) for o in out],
                         [("dialog", {"x": 400, "y": 300, "width": 480, "height": 260}),
                          ("notification", {"x": 500, "y": 0, "width": 400, "height": 80})])
        self.assertIn("Authentication Required", out[0]["text"])

    def test_a_shell_not_looked_through_in_time_is_incomplete(self):
        saved = e.SHELL_ACTORS, e.SHELL_BUDGET_S
        try:
            # Without GNOME Shell there is nothing to look through, however little time there is.
            e.SHELL_ACTORS, e.SHELL_BUDGET_S = 3, -1.0
            self.assertEqual(e.shell_overlays({}), {"overlays": [], "complete": True})
            stage = Acc("window", "", kids=[Acc("panel", "Top bar", kids=[Acc("label", "12:00")]),
                                            Acc("dialog", "", kids=[Acc("label", "Authentication Required")])])
            shell = self.AppNode(99, [stage])
            shell.name = "gnome-shell"
            shell.getRoleName = lambda: "application"
            shell.getState = lambda: States([])
            self.desktop.kids.append(shell)
            e.SHELL_ACTORS, e.SHELL_BUDGET_S = 3, 1.0
            self.assertEqual(e.shell_overlays({}), {"overlays": [], "complete": False})
            e.SHELL_ACTORS, e.SHELL_BUDGET_S = 1000, -1.0
            self.assertFalse(e.shell_overlays({})["complete"])
            e.SHELL_ACTORS, e.SHELL_BUDGET_S = saved
            out = e.shell_overlays({})
            self.assertEqual(([o["role"] for o in out["overlays"]], out["complete"]), (["dialog"], True))
        finally:
            e.SHELL_ACTORS, e.SHELL_BUDGET_S = saved

    def test_shell_overview_and_switcher(self):
        stage = Acc("window", "", states=("showing", "visible", "focused"),
                    kids=[Acc("panel", "overviewGroup", states=("visible",)), Acc("panel", "Top bar")])
        shell = self.AppNode(99, [stage])
        shell.name = "gnome-shell"
        shell.getRoleName = lambda: "application"
        shell.getState = lambda: States([])
        self.desktop.kids.append(shell)
        # The overview hidden, and the stage itself holding the keyboard: an ordinary desktop.
        self.assertEqual(e.shell_overlays({})["overlays"], [])
        stage.kids[0].states.append("showing")
        self.assertEqual([o["role"] for o in e.shell_overlays({})["overlays"]], ["overview"])
        # The window switcher (or a menu of the top bar) has the keyboard.
        stage.kids[0].states.remove("showing")
        stage.kids.append(Acc("panel", "", states=("showing", "visible", "focused"), kids=[Acc("push button", "Files")]))
        self.assertEqual([o["role"] for o in e.shell_overlays({})["overlays"]], ["overview"])

    def test_the_shell_is_found_without_asking_hung_apps(self):
        class Frozen(self.AppNode):
            """Every question to it times out (the stand-in takes a little longer than SLOW_APP_S, set short here)."""
            @property
            def name(self):
                self.asked += 1
                time.sleep(0.05)
                raise RuntimeError("timeout from dbind")

            @name.setter
            def name(self, value):
                pass
        stage = Acc("window", "", kids=[Acc("dialog", "", bounds=(400, 300, 480, 260), kids=[Acc("label", "Authentication Required")])])
        shell = self.AppNode(99, [stage])
        shell.getRoleName = lambda: "application"
        shell.getState = lambda: States([])
        frozen = [Frozen(30 + i, []) for i in range(8)]
        self.desktop.kids = frozen + [self.mail, shell]
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.03
        try:
            # Every process is named in /proc: no app is asked, and the shell is known by its process.
            self.comm.update({10: "mail", 99: "gnome-shell"})
            self.comm.update((f.pid, "frozen") for f in frozen)
            out = e.shell_overlays({})
            self.assertEqual(([o["role"] for o in out["overlays"]], out["complete"]), (["dialog"], True))
            self.assertEqual(sum(f.asked for f in frozen), 0)
            # Without /proc, apps are asked their names, for a while: what the look didn't reach may be the shell.
            self.comm.clear()
            shell.name = "gnome-shell"
            saved = e.SHELL_FIND_S
            e.SHELL_FIND_S = 0.12
            try:
                self.assertFalse(e.shell_overlays({})["complete"])
            finally:
                e.SHELL_FIND_S = saved
            asked = sum(f.asked for f in frozen)
            self.assertLess(asked, 5)
            # Apps known to be hung are not asked at all.
            for f in frozen:
                e.mark_hung(f.pid)
            out = e.shell_overlays({})
            self.assertEqual(([o["role"] for o in out["overlays"]], out["complete"]), (["dialog"], True))
            self.assertEqual(sum(f.asked for f in frozen), asked)
        finally:
            e.SLOW_APP_S = old

    def test_embers_own_windows_are_never_read_or_listed(self):
        own = {"ownPid": 10}
        self.assertEqual([w["name"] for w in e.list_windows(own)["windows"]], ["notes.txt - Text Editor"])
        self.assertIsNone(e.read_window(dict(own, pid=10))["window"])
        self.assertIsNone(e.read_window(dict(own, title="Compose - Mail"))["window"])
        # Not as the active window either: Ember's ask box has the keyboard, and no app window is active.
        self.assertIsNone(e.read_window(own)["window"])
        self.assertEqual(e.read_window({})["window"]["name"], "Compose - Mail")
        self.assertEqual(len(e.list_windows({})["windows"]), 3)

    def test_what_a_secret_field_holds_is_not_read(self):
        # Chromium lists the text of a contenteditable "textbox" as static text inside it.
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        key = Acc("entry", "API key", bounds=(10, 40, 300, 24), kids=[Acc("static", "sk-live-SECRETKEY123", bounds=(12, 44, 200, 16))])
        card = Acc("entry", "", bounds=(10, 100, 300, 24), kids=[Acc("static", "4111 1111 1111 1111", bounds=(12, 104, 200, 16))])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds = (0, 0, 400, 200)
        win.kids = [key, Acc("static", "Card number", bounds=(10, 80, 100, 16)), card]
        out = e.read_window({"pid": 20})
        self.assertEqual([(n["name"], n.get("secret", False)) for n in out["nodes"]],
                         [("notes.txt - Text Editor", False), ("API key", True), ("Card number", False), ("", True)])
        self.assertEqual(key.child_reads, 0)  # a field known to be secret isn't looked into
        # The card field, found secret by its label after the read, held text the read reached: forgotten by id too.
        self.assertEqual(len(e.SNAPSHOTS.latest()), len(out["nodes"]))

    @staticmethod
    def linked(acc):
        """acc, its children told their parents (as libatspi answers acc.parent)."""
        for kid in acc.kids:
            kid.parent = acc
            Windows.linked(kid)
        return acc

    def test_names_that_say_what_a_secret_field_holds_are_withheld(self):
        # Chromium names a table's cell, an ARIA row or a <div> after the values of the fields in it: a card number, a
        # CVV, an IBAN, a PIN (PERC8-1). Those names (and texts) go wherever they would be reported: a read, what is
        # under the wheel, the element of an action, the control a click goes to; and a helper started afresh is told.
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        e.WITHHELD = e.SecretFields()
        cvv = Acc("entry", "CVV", bounds=(110, 40, 80, 20), text="737")
        tap = Acc("static", "Tap to edit", bounds=(195, 40, 4, 20), acts=["clickAncestor"])
        cvv_cell = Acc("section", "737", bounds=(100, 36, 200, 28), kids=[cvv, tap], acts=["click"])
        iban = Acc("entry", "IBAN", bounds=(110, 80, 260, 20), text="DE89 3704 0044 0532 0130 00")
        iban_cell = Acc("table cell", "DE89 3704 0044 0532 0130 00", bounds=(100, 76, 300, 28), kids=[iban])
        row = Acc("table row", "IBAN DE89 3704 0044 0532 0130 00", bounds=(10, 76, 390, 28),
                  kids=[Acc("table cell", "IBAN", bounds=(10, 76, 90, 28)), iban_cell])
        pin = Acc("entry", "", bounds=(60, 120, 80, 20), text="48 21")  # secret by the label beside it
        pin_box = Acc("section", "PIN 4821", bounds=(10, 116, 200, 28), kids=[Acc("label", "PIN", bounds=(10, 120, 40, 20)), pin])
        plain = Acc("section", "Ada", bounds=(10, 160, 200, 28), kids=[Acc("entry", "Name", bounds=(60, 164, 80, 20), text="Ada")])
        short = Acc("section", "Order 7374", bounds=(10, 200, 300, 28))  # 737 is not a word of it
        doc = Acc("document web", "Checkout", bounds=(0, 0, 400, 300), kids=[cvv_cell, row, pin_box, plain, short])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (0, 0, 400, 300), [doc]
        self.linked(win)
        out = e.read_window({"pid": 20})
        names = [n["name"] for n in out["nodes"]]
        for leak in ("737", "DE89", "4821"):
            self.assertNotIn(leak, json.dumps([n for n in out["nodes"] if n["name"] != "Order 7374"]))
        self.assertIn("Order 7374", names)
        self.assertEqual([n["name"] for n in out["nodes"] if n["role"] in ("section", "table row", "table cell")],
                         ["", "", "IBAN", "", "", "Ada", "Order 7374"])
        self.assertEqual(sorted(n["role"] for n in out["nodes"] if n.get("secret")), ["entry", "entry", "entry"])
        self.assertEqual(len(out["withheldKeys"]), 4)
        by_name = lambda name: [n for n in out["nodes"] if n["name"] == name][0]
        # Under the wheel: a point in the cell beside its field, and on the field (once more as a helper that knew none).
        at = lambda x, y: e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})["chain"]
        self.assertEqual([(c["role"], c["name"]) for c in at(250, 50)], [("document web", "Checkout"), ("section", "")])
        e.WITHHELD = e.SecretFields()
        chain = at(150, 85)
        self.assertEqual([(c["role"], c["name"]) for c in chain[1:]], [("table row", ""), ("table cell", ""), ("entry", "")])
        self.assertNotIn("DE89", json.dumps(chain))
        # Chromium answers with the deepest element there: a secret drop-down's chosen option, named after it.
        option = Acc("menu item", "Fluffy the cat", bounds=(110, 240, 80, 20))
        select = Acc("combo box", "Security answer", bounds=(110, 240, 80, 20), kids=[Acc("menu", "", kids=[option])])
        self.linked(select).parent = doc
        saved = e.child_at_point
        e.child_at_point = lambda acc, role, x, y, budget: [option] if acc is win else saved(acc, role, x, y, budget)
        try:
            self.assertEqual([(c["role"], c["name"], c.get("secret")) for c in at(120, 250)], [("combo box", "", True)])
        finally:
            e.child_at_point = saved
        # The element itself; the control a click on what is in it goes to.
        e.read_window({"pid": 20})
        cell_id = [n["id"] for n in e.read_window({"pid": 20})["nodes"] if n["role"] == "section"][0]
        self.assertEqual((e.read_element({"id": cell_id})["name"], e.read_element({"id": cell_id}).get("text")), ("", None))
        tap_id = e.SNAPSHOTS.add(tap)
        self.assertEqual(e.can_do({"id": tap_id, "kind": "click"})["handler"], {"role": "section", "name": ""})
        self.assertEqual(by_name("Ada")["role"], "section")
        # A field Ember found secret after a read (beside its "Show password"): the names around it from then on.
        e.WITHHELD = e.SecretFields()
        revealed = Acc("entry", "", bounds=(60, 244, 80, 20), text="hunter2-x")
        box = Acc("section", "hunter2-x", bounds=(10, 240, 200, 28), kids=[revealed])
        doc.kids.append(box)
        self.linked(doc)
        nodes = e.read_window({"pid": 20})["nodes"]
        self.assertIn("hunter2-x", [n["name"] for n in nodes])
        marked = e.mark_secret({"ids": [n["id"] for n in nodes if n["role"] == "entry" and n.get("text") == "hunter2-x"]})
        self.assertEqual(marked["withheldKeys"], [[":1.42", box.path]])
        self.assertNotIn("hunter2-x", json.dumps(e.read_window({"pid": 20})["nodes"]))
        # Handed to a helper started afresh.
        e.WITHHELD = e.SecretFields()
        e.SECRETS = e.SecretFields()
        e.remember_secrets({"keys": [[":1.42", revealed.path]], "withheld": [[":1.42", box.path], "junk"]})
        self.assertNotIn("hunter2-x", json.dumps(e.read_window({"pid": 20})["nodes"]))
        self.assertEqual(e.holds_value("Code 12 34", ["1234"]), True)
        self.assertEqual((e.holds_value("Step 7 of 9", ["7"]), e.holds_value("Room 707", ["7"])), (True, False))

    def test_a_combo_box_named_after_what_it_shows_is_judged_by_its_label(self):
        # GTK names a combo box after the option it shows, so one beside a "Card expiry" label was never judged secret;
        # nor was a combo box with an entry beside "PIN", named after what is typed in its (secret) entry (PERC8-5).
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        e.WITHHELD = e.SecretFields()

        def combo(shown, y, entry=None):
            item = Acc("menu item", shown, states=("visible", "enabled"))
            kids = [Acc("menu", "", states=("visible",), kids=[item])] + ([entry] if entry else [])
            c = Acc("combo box", shown, bounds=(120, y, 200, 30), kids=kids)
            c.querySelection = lambda: types.SimpleNamespace(nSelectedChildren=1, getSelectedChild=lambda i: item)
            return c
        expiry = combo("09/28", 40)
        pin_entry = Acc("text", "", bounds=(124, 84, 170, 22), text="4821")
        pin = combo("4821", 80, pin_entry)
        question = combo("Mother's maiden name: Smith", 120)
        country = combo("France", 160)
        labels = [Acc("label", name, bounds=(10, y + 5, 90, 20)) for name, y in
                  (("Card expiry", 40), ("PIN", 80), ("Security question", 120), ("Country", 160))]
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (0, 0, 400, 300), labels + [expiry, pin, question, country]
        self.linked(win)
        out = e.read_window({"pid": 20})
        combos = [(n["name"], n.get("selected"), n.get("secret", False)) for n in out["nodes"] if n["role"] == "combo box"]
        self.assertEqual(combos, [("", None, True), ("", None, True), ("", None, True), ("France", "France", False)])
        for leak in ("09/28", "4821", "Smith"):
            self.assertNotIn(leak, json.dumps(out))
        self.assertRaises(PermissionError, e.refuse_secret, pin)
        self.assertEqual(e.read_element({"id": [n["id"] for n in out["nodes"] if n["role"] == "combo box"][0]})["name"], "")
        # Looked for before a screenshot too.
        found = e.secret_fields({"pid": 20, "path": win.path})
        self.assertEqual(sorted(f["bounds"]["y"] for f in found["fields"]), [40, 80, 120])
        e.SECRETS = e.SecretFields()
        found = e.secret_fields({"pid": 20, "path": win.path})
        self.assertEqual((sorted(f["bounds"]["y"] for f in found["fields"]), found["complete"]), ([40, 80, 120], True))

    def test_a_web_name_made_from_a_secret_field_the_read_did_not_list_is_withheld(self):
        # Chromium names a cell after what it holds, a field's value too, and lists the cell when only its label line
        # shows (its field scrolled out of view), or as the last element of a read that stopped at its node limit. Such
        # a name is checked before it is reported: in a read, the element's own look, under the wheel (PERC9-1).
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        e.WITHHELD = e.SecretFields()
        hidden = ("visible", "enabled", "sensitive")
        card = Acc("entry", "Card number", states=hidden, bounds=(12, 296, 260, 20), text="4111 1111 1111 1111")
        card_cell = Acc("section", "Card number 4111 1111 1111 1111", bounds=(10, 270, 280, 46),
                        kids=[Acc("static", "Card number", bounds=(12, 272, 90, 16)), card])
        notes = Acc("section", "Notes Leave at the door", bounds=(300, 270, 280, 46),
                    kids=[Acc("static", "Notes", bounds=(302, 272, 60, 16)),
                          Acc("entry", "Delivery notes", states=hidden, bounds=(302, 296, 260, 20), text="Leave at the door")])
        ship = Acc("table cell", "Ship to Ada", bounds=(10, 40, 280, 24),
                   kids=[Acc("static", "Ship to", bounds=(12, 42, 50, 16)), Acc("entry", "Name", bounds=(70, 42, 100, 18), text="Ada")])
        pay = Acc("push button", "Pay now", bounds=(10, 70, 60, 20))
        rows = [Acc("table row", "", bounds=(10, 100 + 30 * i, 380, 24), kids=[
            Acc("table cell", "PIN %d 10010%d" % (i, i), bounds=(10, 100 + 30 * i, 380, 24), kids=[
                Acc("static", "PIN %d" % i, bounds=(12, 102 + 30 * i, 40, 16)),
                Acc("entry", "PIN %d" % i, bounds=(60, 100 + 30 * i, 60, 20), text="10010%d" % i)])]) for i in range(2)]
        doc = Acc("document web", "Checkout", bounds=(0, 0, 600, 300), kids=[ship, pay] + rows + [card_cell, notes])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (0, 0, 600, 300), [doc]
        self.linked(win)
        checked = []
        saved = e.web_engine, e.name_says_secret, e.CONTENTS_S

        def counted(acc, role, name, until, *layout):
            checked.append(name)
            return saved[1](acc, role, name, until, *layout)
        e.web_engine, e.name_says_secret = (lambda acc: True), counted
        try:
            out = e.read_window({"pid": 20})
            names = dict((n["id"], n["name"]) for n in out["nodes"])
            self.assertNotIn("4111", json.dumps(out))
            by_role = [(n["role"], n["name"]) for n in out["nodes"] if n["role"] in ("section", "table cell", "push button")]
            self.assertEqual(by_role, [("table cell", "Ship to Ada"), ("push button", "Pay now"), ("table cell", ""),
                                       ("table cell", ""), ("section", ""), ("section", "Notes Leave at the door")])
            # Only the names of what the read may not have listed all of are checked: not a button in full view.
            self.assertEqual(sorted(checked), ["Card number 4111 1111 1111 1111", "Notes Leave at the door"])
            self.assertIn([":1.42", card_cell.path], out["withheldKeys"])
            cell_id = [i for i, name in names.items() if e.SNAPSHOTS.get(i) is card_cell][0]
            notes_id = [i for i, name in names.items() if e.SNAPSHOTS.get(i) is notes][0]
            # A read that stopped at its node limit right after a cell: its field wasn't listed.
            e.WITHHELD = e.SecretFields()
            del checked[:]
            cut = e.read_window({"pid": 20, "maxNodes": 12})
            self.assertEqual((cut["truncated"], cut["nodes"][-1]["role"], cut["nodes"][-1]["name"]), (True, "table cell", ""))
            self.assertNotIn("100101", json.dumps(cut))
            self.assertEqual(checked, ["PIN 1 100101"])
            # The element's own look, and what is under the wheel, by a helper that knows of none of it.
            e.WITHHELD = e.SecretFields()
            self.assertEqual((e.read_element({"id": cell_id})["name"], e.read_element({"id": cell_id}).get("text")), ("", None))
            self.assertEqual(e.read_element({"id": notes_id})["name"], "Notes Leave at the door")
            e.WITHHELD = e.SecretFields()
            at = lambda x, y: e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})  # noqa: E731
            point = at(200, 280)
            self.assertEqual([(c["role"], c["name"]) for c in point["chain"]], [("document web", "Checkout"), ("section", "")])
            self.assertEqual(point["withheldKeys"], [[":1.42", card_cell.path]])
            self.assertEqual([c["name"] for c in at(500, 280)["chain"]], ["Checkout", "Notes Leave at the door"])
            # What can't be checked in time is withheld.
            e.WITHHELD = e.SecretFields()
            e.CONTENTS_S = -1.0
            late = [(n["role"], n["name"]) for n in e.read_window({"pid": 20})["nodes"] if n["role"] in ("section", "table cell")]
            self.assertEqual(late, [("table cell", "Ship to Ada"), ("table cell", ""), ("table cell", ""), ("section", ""), ("section", "")])
        finally:
            e.web_engine, e.name_says_secret, e.CONTENTS_S = saved
            e.WITHHELD = e.SecretFields()

    def test_a_name_that_says_a_secret_fields_value_elsewhere_is_withheld(self):
        # A button named after a secret field (aria-labelledby="lead pin") says what it holds though it doesn't hold it:
        # every name of a read is looked through for a field's value of 4 characters or more, as words of their own;
        # one named after a field whose shorter value the read says, by what the field says it labels (PERC9-3). A
        # "Total: 42" beside a CVV of 42 stays.
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        e.WITHHELD = e.SecretFields()
        FAKE.RELATION_LABEL_FOR = "label-for"
        lead = Acc("static", "Pay with", bounds=(10, 10, 60, 16))
        pin = Acc("entry", "PIN", bounds=(80, 10, 100, 20), text="ABCD")
        cvv = Acc("entry", "CVV", bounds=(80, 40, 100, 20), text="42")
        pay = Acc("push button", "Pay with ABCD", bounds=(10, 70, 100, 24), labelled_by=[lead, pin])
        pay42 = Acc("push button", "Pay with 42", bounds=(120, 70, 100, 24), labelled_by=[lead, cvv])
        cvv.getRelationSet = lambda: [Relation(FAKE.RELATION_LABEL_FOR, [pay42])]
        for button in (pay, pay42):
            button.getAttributes = lambda: ["explicit-name:true"]
        card = Acc("entry", "Card number", bounds=(80, 100, 200, 20), text="4111111111111111")
        kept = ["Pay with", "Total: 42", "Order ABCDEF", "Step 4111 of 9"]
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds = (0, 0, 400, 300)
        win.kids = [lead, pin, cvv, pay, pay42, card, Acc("static", "Saved card 4111 1111 1111 1111", bounds=(10, 130, 200, 16))] + [
            Acc("static", name, bounds=(10, 160 + 20 * i, 120, 16)) for i, name in enumerate(kept[1:])]
        self.linked(win)
        out = e.read_window({"pid": 20})
        self.assertEqual([n["name"] for n in out["nodes"] if n["role"] in ("static", "push button")],
                         ["Pay with", "", "", ""] + kept[1:])
        self.assertNotRegex(json.dumps(out), r"(?i)\babcd\b|1111")
        self.assertIn([":1.42", pay42.path], out["withheldKeys"])
        # A page's element named after a secret field, looked at by a helper that knows of none of it.
        e.WITHHELD = e.SecretFields()
        saved = e.web_engine
        e.web_engine = lambda acc: True
        try:
            chain = lambda x, y: [(c["role"], c["name"]) for c in e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})["chain"]]  # noqa: E731
            self.assertEqual(chain(50, 80), [("push button", "")])
            self.assertEqual(chain(150, 80), [("push button", "")])
            ids = dict((e.SNAPSHOTS.get(n["id"]), n["id"]) for n in out["nodes"])
            e.WITHHELD = e.SecretFields()
            self.assertEqual(e.read_element({"id": ids[pay]})["name"], "")
            self.assertEqual(e.read_element({"id": ids[lead]})["name"], "Pay with")
        finally:
            e.web_engine = saved
            e.WITHHELD = e.SecretFields()

    def fresh(self, kids, bounds=(0, 0, 600, 400)):
        """The notes window holding `kids` (told their parents), nothing known secret or withheld yet."""
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        e.WITHHELD = e.SecretFields()
        e.PAGE_VALUES.clear()
        win = self.notes.wins[0]
        if "visible" not in win.states:
            win.states.append("visible")
        win.bounds, win.kids = bounds, list(kids)
        self.linked(win)
        return win

    @staticmethod
    def drop_down(name, options, bounds, chosen=0):
        """A web page's <select> (`chosen`: the index of the option it shows, as .chosen too)."""
        items = [Acc("menu item", o, states=("visible", "enabled")) for o in options]
        for i, item in enumerate(items):
            item.getIndexInParent = (lambda i=i: i)
        c = Acc("combo box", name, bounds=bounds, kids=[Acc("menu", "", states=("visible",), kids=items)], acts=["open"])
        c.chosen = chosen
        c.querySelection = lambda: types.SimpleNamespace(nSelectedChildren=1, getSelectedChild=lambda i: items[c.chosen],
                                                         isChildSelected=lambda i: i == c.chosen)
        return c

    def test_what_a_secret_drop_down_shows_unchosen_is_no_secret_elsewhere(self):
        # A card's expiry drop-downs showing their "Month" and "Year" placeholders took every name with "month" or "year"
        # in it away: "Subscribe for $9.99/month", "Start 1 year plan", "Pay every year"; a button left without a name
        # was then clicked without a question (P10-1). Elsewhere in a read only what the user put in a secret field is
        # looked for: what is typed in it, and an option chosen in it that says something (see chosen_secret). What
        # holds the field is judged as before. A name withheld is marked so.
        month = self.drop_down("Card expiry month", ["Month", "01", "02"], (120, 40, 80, 20))
        year = self.drop_down("Card expiry year", ["Year", "2027", "2028"], (210, 40, 80, 20))
        question = self.drop_down("Security question", ["Pick one", "Engineering", "Maiden name Smithers"], (120, 70, 160, 20))
        said = ["Basic: $9.99/month, cancel any month", "Premium: $99 per year", "Valid until 2028", "Engineering team",
                "Hint: maiden name Smithers"]
        buttons = ["Pay every year", "Subscribe for $9.99/month", "Start 1 year plan"]
        self.fresh([month, year, question] + [Acc("static", s, bounds=(10, 100 + 20 * i, 300, 16)) for i, s in enumerate(said)]
                   + [Acc("push button", s, bounds=(10 + 130 * i, 220, 120, 24), acts=["press"]) for i, s in enumerate(buttons)])

        def names(out):
            return [n["name"] for n in out["nodes"] if n["role"] in ("static", "push button")]
        out = e.read_window({"pid": 20})
        self.assertEqual(names(out), said + buttons)
        # The drop-downs' own names say what they show: withheld, as before, and marked.
        self.assertEqual([(n["name"], n.get("secret"), n.get("withheld", False)) for n in out["nodes"] if n["role"] == "combo box"],
                         [("", True, True), ("", True, True), ("Security question", True, False)])
        self.assertEqual([n["name"] for n in out["nodes"] if n.get("withheld")], ["", ""])
        # Chosen: a year (digits) and an answer of three words are looked for everywhere; a month's "02" is too short.
        month.chosen, year.chosen, question.chosen = 2, 2, 2
        out = e.read_window({"pid": 20})
        self.assertEqual(names(out), ["Basic: $9.99/month, cancel any month", "Premium: $99 per year", "", "Engineering team", ""]
                         + buttons)
        self.assertNotRegex(json.dumps(out), r"(?i)2028|smithers")
        self.assertEqual([n.get("withheld", False) for n in out["nodes"] if n["role"] == "static"], [False, False, True, False, True])
        # A plain word chosen says nothing of its own.
        question.chosen = 1
        self.assertIn("Engineering team", names(e.read_window({"pid": 20})))

    @unittest.skipUnless(os.path.exists(CHOSEN), "the repository's test table is not here")
    def test_options_that_say_what_the_user_chose(self):
        # The options a secret drop-down shows that are what the user put in it: the same table as perception.test.ts.
        with open(CHOSEN, encoding="utf-8") as f:
            table = json.load(f)
        for option, field in table["secret"]:
            self.assertTrue(e.chosen_secret(None, option, field), (option, field))
        for option, field in table["plain"]:
            self.assertFalse(e.chosen_secret(None, option, field), (option, field))
        # Nor ever a drop-down's first option (what it shows until something is chosen).
        first = Acc("menu item", "2028")
        first.getIndexInParent = lambda: 0
        self.assertFalse(e.chosen_secret(first, "2028", "Card expiry year"))

    def test_what_a_read_withheld_stays_withheld_in_an_elements_own_look_and_options(self):
        # A plain drop-down whose chosen option says what a secret field elsewhere holds ("Pay from: Card 4242 4242 4242
        # 4242" beside the card number) said it as its selected option in a read, in its own look and among its options;
        # an unnamed paragraph whose text a read withheld ("Your PIN 7Q4Z9X is active") said it in its own look, also
        # after a helper started afresh (P10-3).
        card = Acc("entry", "Card number", bounds=(120, 10, 200, 20), text="4242 4242 4242 4242")
        pay = self.drop_down("Pay from", ["Card 4242 4242 4242 4242", "Bank transfer"], (120, 40, 200, 20))
        pin = Acc("entry", "PIN", bounds=(120, 70, 100, 20), text="7Q4Z9X")
        note = Acc("paragraph", "", bounds=(10, 100, 300, 16), text="Your PIN 7Q4Z9X is active")
        self.fresh([card, pay, pin, note])
        out = e.read_window({"pid": 20})
        self.assertNotRegex(json.dumps(out), r"4242|7Q4Z9X")
        by = dict((n["role"], n) for n in out["nodes"])
        self.assertEqual((by["combo box"]["name"], by["combo box"].get("withheld", False)), ("Pay from", False))
        self.assertEqual((by["paragraph"].get("text"), by["paragraph"].get("withheld")), (None, True))
        ids = dict((e.SNAPSHOTS.get(n["id"]), n["id"]) for n in out["nodes"])
        look = e.read_element({"id": ids[pay]})
        self.assertEqual((look["name"], look.get("selected")), ("Pay from", ""))
        self.assertEqual(e.list_options({"id": ids[pay]})["options"], ["", "Bank transfer"])
        look = e.read_element({"id": ids[note]})
        self.assertEqual((look["name"], look.get("text"), look.get("withheld")), ("", None, True))
        # A helper started afresh is told what was withheld.
        e.WITHHELD, e.SECRETS = e.SecretFields(), e.SecretFields()
        e.remember_secrets({"keys": out["secretKeys"], "withheld": out["withheldKeys"]})
        self.assertNotIn("7Q4Z9X", json.dumps(e.read_element({"id": ids[note]})))

    def test_a_web_name_said_by_a_secret_field_out_of_view_or_past_a_reads_end_is_withheld(self):
        # A button named after a card number field out of view (aria-labelledby) has nothing in it a read lists, and was
        # never checked; nor was a cell named after an unnamed card field that only the label beside it makes secret,
        # where a read stopped (P10-3). A button whose own text says its name is asked only for that (one call).
        lead = Acc("static", "Pay with card", bounds=(10, 10, 90, 16))
        far = Acc("entry", "Card number", states=("visible", "enabled", "sensitive"), bounds=(10, 3000, 200, 20),
                  text="4000 0566 5566 5556")
        pay = Acc("push button", "Pay with card 4000 0566 5566 5556", bounds=(10, 30, 60, 24), text="x", labelled_by=[lead, far])
        pay.getAttributes = lambda: ["explicit-name:true"]
        order = Acc("push button", "Order 12345", bounds=(80, 30, 100, 24), text="Order 12345")
        asked = []
        order.getAttributes = lambda: asked.append("order") or []
        plain = Acc("push button", "Pay with card", bounds=(200, 30, 100, 24), text="Pay with card")
        label = Acc("static", "Card number", bounds=(10, 100, 90, 16))
        cell = Acc("table cell", "4111 1111 1111 1111", bounds=(120, 96, 220, 24),
                   kids=[Acc("entry", "", bounds=(124, 98, 200, 20), text="4111 1111 1111 1111")])
        doc = Acc("document web", "Checkout", bounds=(0, 0, 600, 400), kids=[lead, pay, order, plain, label, cell, far])
        self.fresh([doc])
        saved = e.web_engine
        e.web_engine = lambda acc: True
        try:
            out = e.read_window({"pid": 20})
            self.assertEqual([(n["name"], n.get("withheld", False)) for n in out["nodes"] if n["role"] == "push button"],
                             [("", True), ("Order 12345", False), ("Pay with card", False)])
            self.assertEqual(asked, [])
            self.assertNotRegex(json.dumps(out), r"4000|5556|4111")
            # Cut short right after the cell: its field isn't listed, and isn't named.
            e.WITHHELD, e.SECRETS = e.SecretFields(), e.SecretFields()
            cut = e.read_window({"pid": 20, "maxNodes": 8})
            self.assertEqual((cut["truncated"], cut["nodes"][-1]["role"], cut["nodes"][-1]["name"]), (True, "table cell", ""))
            self.assertNotRegex(json.dumps(cut), r"4000|5556|4111")
        finally:
            e.web_engine = saved
            e.WITHHELD = e.SecretFields()

    def test_a_reads_checks_stop_asking_an_app_that_stopped_answering(self):
        # An app that stopped answering in the middle of a read was still asked about each name the read may not have
        # listed all of, and about each secret field's value, a timeout each: a busy read of 1 s took 4 s, or the
        # helper's 5 s, which lost every id (P10-2). Once a call of the read timed out, nothing more is asked (what may
        # say what a secret field holds is withheld), and the checks after a walk stop asking at WITHHOLD_S.
        class Stuck(Acc):
            def getState(self):
                time.sleep(e.SLOW_APP_S + 0.05)
                return Acc.getState(self)
        asked = []
        cells, cards = [], []
        for i in range(6):
            card = Acc("entry", "Card number", bounds=(130, 20 + 30 * i, 150, 20), text="4111 1111 1111 111%d" % i)
            cards.append(card)
            cell = Acc("section", "Code 7Q4Z%d" % i, bounds=(10, 20 + 30 * i, 100, 24),
                       kids=[Acc("static", "Code", bounds=(12, 22 + 30 * i, 40, 16))])
            cell.getAttributes = (lambda i=i: asked.append(i) or [])
            cells.append(cell)
            cells.append(Acc("section", "Card", bounds=(120, 18 + 30 * i, 200, 24), kids=[card]))
        stuck = Stuck("push button", "Pay", bounds=(10, 300, 60, 24))
        doc = Acc("document web", "Checkout", bounds=(0, 0, 600, 400), kids=cells + [stuck])
        self.fresh([doc])
        saved = e.web_engine, e.WITHHOLD_S
        e.web_engine = lambda acc: True
        try:
            t0 = time.monotonic()
            out = e.read_window({"pid": 20})
            self.assertTrue(out["busy"])
            self.assertLess(time.monotonic() - t0, e.SLOW_APP_S + 0.3)
            self.assertEqual((asked, sum(c.reads for c in cards)), ([], 0))
            self.assertEqual([n["name"] for n in out["nodes"] if n["role"] == "section"], [""] * 12)
            # An app slow to tell what its fields hold: asked until WITHHOLD_S, what is left withheld.
            e.WITHHOLD_S = 0.3
            stuck.__class__ = Acc
            for c in cards:
                c.delay = 0.15
            e.WITHHELD = e.SecretFields()
            t0 = time.monotonic()
            out = e.read_window({"pid": 20})
            self.assertLess(time.monotonic() - t0, 0.3 + 0.15 + 0.15)
            self.assertLessEqual(sum(c.reads for c in cards), 3)
            self.assertEqual([n["name"] for n in out["nodes"] if n["role"] == "section"][1::2], [""] * 6)
            self.assertNotIn("4111", json.dumps(out))
        finally:
            (e.web_engine, e.WITHHOLD_S), stuck.__class__ = saved, Acc
            e.WITHHELD = e.SecretFields()

    def test_an_open_menu_in_libreoffices_menu_bar_is_on_top(self):
        # LibreOffice 24.2 (gtk3) keeps its menu bar five levels down, in a scroll pane's viewport: with its View menu
        # open, what was under the menu (a toolbar's button, the sheet) was taken for what is at a point (PERC8-2).
        items = [Acc("radio menu item", "Normal", bounds=(77, 44, 325, 25)),
                 Acc("check menu item", "Freeze Rows and Columns", bounds=(77, 423, 325, 25))]
        view = Acc("menu", "View", bounds=(77, 19, 47, 25), states=("visible", "showing", "selected", "enabled"), kids=items)
        bar = Acc("menu bar", "", bounds=(0, 19, 1896, 25), kids=[Acc("menu", "File", bounds=(0, 19, 38, 25), kids=[
            Acc("menu item", "Open...", states=("visible",), bounds=(e.INT_MIN, e.INT_MIN, 1, 1))]), view])
        top = Acc("panel", "", bounds=(0, 19, 1920, 25), kids=[
            Acc("scroll pane", "", bounds=(0, 19, 1896, 25), kids=[Acc("viewport", "", bounds=(0, 19, 1896, 25), kids=[bar])])])
        sheet = Acc("document spreadsheet", "frozen.fods", bounds=(37, 158, 1810, 956))
        body = Acc("panel", "", bounds=(0, 44, 1920, 1156), kids=[Acc("root pane", "", bounds=(0, 19, 1920, 1156), kids=[
            Acc("panel", "", bounds=(0, 19, 1920, 78), kids=[Acc("push button", "Export Directly as PDF", bounds=(150, 50, 30, 30))]),
            Acc("panel", "", bounds=(0, 97, 1920, 1054), kids=[sheet])])])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (0, 0, 1920, 1200), [Acc("panel", "", bounds=(0, 19, 1920, 1181), kids=[top, body])]
        at = lambda x, y: [(c["role"], c["name"]) for c in e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})["chain"]]
        self.assertEqual(at(177, 56), [("menu", "View"), ("radio menu item", "Normal")])
        self.assertEqual(at(177, 435), [("menu", "View"), ("check menu item", "Freeze Rows and Columns")])
        # Closed: what is there.
        for item in items:
            item.states = ["visible"]
        self.assertEqual(at(160, 56)[-1], ("push button", "Export Directly as PDF"))

    def test_a_window_the_app_was_too_busy_to_hand_over_is_busy(self):
        class Busy(self.AppNode):
            def getChildAtIndex(self, i):
                self.asked += 1
                time.sleep(0.05)
                return None  # what libatspi answers when the call timed out: no error
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.03
        try:
            busy = Busy(30, [None, None, None])
            self.desktop.kids.append(busy)
            out = e.read_window({"pid": 30, "title": "Open File"})
            self.assertEqual((out["window"], out["busy"]), (None, True))
            self.assertEqual(busy.asked, 2)  # its window count, then one window: not a timeout for each
        finally:
            e.SLOW_APP_S = old
        old = e.FIND_BUDGET_S
        e.FIND_BUDGET_S = -1.0  # the look for the window ran out of time before reaching every app
        try:
            self.assertTrue(e.read_window({"title": "Open File"})["busy"])
        finally:
            e.FIND_BUDGET_S = old

    def test_an_app_that_answers_again_is_not_hung(self):
        e.STRIKES[20] = (2, time.monotonic())
        e.mark_hung(20)
        self.assertEqual(self.name_of({"pid": 20}), "notes.txt - Text Editor")  # asked by its pid, it answers
        self.assertFalse(e.is_hung(20))
        self.assertNotIn(20, e.STRIKES)
        self.assertEqual(len(e.list_windows({})["windows"]), 3)

    def test_a_hung_apps_windows_are_busy_not_gone(self):
        self.assertEqual(len(e.list_windows({})["windows"]), 3)
        e.mark_hung(20)
        asked = self.notes.asked
        wins = e.list_windows({})["windows"]
        self.assertEqual([(w["name"], w.get("busy", False)) for w in wins],
                         [("Inbox - Mail", False), ("Compose - Mail", False), ("notes.txt - Text Editor", True)])
        self.assertEqual(self.notes.asked, asked)  # not asked while hung
        out = e.read_window({"title": "notes.txt"})
        self.assertEqual((out["window"], out["busy"]), (None, True))
        # A title no app had is still not found, and not busy.
        self.assertFalse(e.read_window({"title": "Report.odt"})["busy"])

    def checkout(self):
        """A web page with 480 links before its card fields: a read stops at its node limit before them."""
        sections = [Acc("section", "", bounds=(0, 12 * k, 900, 12), kids=[
            Acc("link", "L%d.%d" % (k, i), bounds=(10 + i * 5, 12 * k, 4, 10)) for i in range(160)]) for k in range(3)]
        self.card = Acc("entry", "", bounds=(10, 220, 300, 24), text="4111 1111 1111 1111")
        self.cvv = Acc("entry", "Security code", bounds=(10, 250, 80, 24), text="737")
        self.name = Acc("entry", "", bounds=(10, 300, 300, 24), text="Ada")
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds = (0, 0, 900, 400)
        win.kids = [Acc("document web", "Checkout", bounds=(0, 0, 900, 400), kids=sections + [
            Acc("static", "Card number", bounds=(10, 200, 90, 18)), self.card, self.cvv,
            Acc("static", "Name", bounds=(10, 280, 90, 18)), self.name])]
        return win

    def test_secret_fields_a_read_did_not_reach(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        win = self.checkout()
        read = e.read_window({"pid": 20})
        self.assertTrue(read["truncated"])
        self.assertNotIn("Security code", [n["name"] for n in read["nodes"]])
        out = e.secret_fields({"pid": 20, "path": win.path})
        self.assertTrue(out["complete"])
        self.assertEqual(sorted(f["bounds"]["y"] for f in out["fields"]), [220, 250])
        self.assertEqual(self.card.reads + self.cvv.reads + self.name.reads, 0)  # no text is asked for
        self.assertEqual(len(out["secretKeys"]), 2)
        # Their positions can be asked again by id, and nothing is typed into them.
        self.assertEqual(e.node_info(e.SNAPSHOTS.get(out["fields"][0]["id"]))["secret"], True)
        self.assertTrue(e.is_secret(self.card, "entry", ""))

    def test_web_documents_are_searched_by_the_app(self):
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SECRETS = e.SecretFields()
        win = self.checkout()
        doc = win.kids[0]
        asked = []

        def matches(acc, roles, limit=e.SCAN_NODES):
            asked.append((acc.role, "entry" in roles))
            return [self.card, self.cvv, self.name] if "entry" in roles else [doc.kids[3], doc.kids[6]]
        saved, e.collection_matches = e.collection_matches, matches
        try:
            out = e.secret_fields({"pid": 20, "path": win.path})
            self.assertTrue(out["complete"])
            self.assertEqual(sorted(f["bounds"]["y"] for f in out["fields"]), [220, 250])
            self.assertEqual(asked, [("document web", True), ("document web", False)])
            self.assertEqual(doc.child_reads, 0)
            # LibreOffice's drawings are document frames too: looked through here, the app is never asked to search.
            doc.role, asked[:] = "document frame", []
            out = e.secret_fields({"pid": 20, "path": win.path})
            self.assertEqual((out["complete"], len(out["fields"]), asked), (True, 2, []))
            self.assertGreater(doc.child_reads, 0)
        finally:
            e.collection_matches = saved

    def test_no_secret_fields_answer_for_a_page_not_handed_over_yet(self):
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds = (0, 0, 900, 400)
        win.kids = [Acc("document web", "", bounds=(0, 30, 0, 0))]  # painted, but its contents aren't exposed yet
        out = e.secret_fields({"pid": 20, "path": win.path})
        self.assertEqual((out["complete"], out["busy"]), (False, True))
        self.assertNotIn(20, e.STRIKES)  # loading, not hung
        win.kids[0].bounds = (0, 30, 900, 370)  # an empty page
        self.assertTrue(e.secret_fields({"pid": 20, "path": win.path})["complete"])

    def test_no_secret_fields_answer_without_the_whole_window(self):
        win = self.checkout()
        old = e.SCAN_NODES
        e.SCAN_NODES = 100
        try:
            out = e.secret_fields({"pid": 20, "path": win.path})
        finally:
            e.SCAN_NODES = old
        self.assertFalse(out["complete"])
        self.assertFalse(e.secret_fields({"pid": 20, "path": "/gone"})["complete"])

    def test_what_is_under_the_wheel(self):
        # A notebook's page (outside its tab's bounds) holding a settings page scrolled past its first screen (GTK 3's
        # viewport then has no bounds and says it doesn't show): what is at a point is found through both.
        slider = Acc("slider", "Volume", bounds=(20, 200, 400, 40))
        box = Acc("filler", "", bounds=(10, -700, 420, 1600), kids=[Acc("label", "Row 9", bounds=(20, 150, 150, 30)), slider])
        view = Acc("viewport", "", bounds=(e.INT_MIN, e.INT_MIN, 420, 400), states=("visible", "enabled"), kids=[box])
        pane = Acc("scroll pane", "", bounds=(10, 80, 420, 400), kids=[view, Acc("scroll bar", "", bounds=(415, 80, 15, 400))])
        tab = Acc("page tab", "Display", bounds=(20, 50, 80, 26), kids=[pane])
        tabs = Acc("page tab list", "", bounds=(0, 40, 440, 450), kids=[tab, Acc("page tab", "Sound", bounds=(110, 50, 80, 26))])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (0, 0, 440, 500), [tabs]
        roles = lambda x, y: [(c["role"], c["name"]) for c in e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})["chain"]]
        self.assertEqual(roles(100, 210), [("page tab list", ""), ("page tab", "Display"), ("scroll pane", ""), ("viewport", ""),
                                           ("filler", ""), ("slider", "Volume")])
        self.assertEqual(roles(100, 160)[-1], ("label", "Row 9"))
        self.assertEqual(roles(150, 60)[-1], ("page tab", "Sound"))
        # A row that doesn't show (scrolled away, or a hidden page) isn't there.
        slider.states = ["visible"]
        self.assertEqual(roles(100, 210)[-1], ("filler", ""))
        # A secret field (Chromium's: its contents in text children) comes nameless and last, nothing in it asked.
        key = Acc("entry", "API key", bounds=(20, 300, 300, 30), kids=[Acc("static", "sk-live-123", bounds=(22, 302, 200, 26))])
        box.kids.append(key)
        self.assertEqual(e.at_point({"pid": 20, "path": win.path, "x": 50, "y": 310})["chain"][-1],
                         {"role": "entry", "name": "", "bounds": {"x": 20, "y": 300, "width": 300, "height": 30}, "secret": True})
        self.assertEqual(key.child_reads, 0)
        # A never-look window isn't looked at; one that is gone isn't found.
        self.assertTrue(e.at_point({"pid": 20, "path": win.path, "x": 1, "y": 1, "neverLook": ["notes"]})["blocked"])
        self.assertFalse(e.at_point({"pid": 20, "path": "/gone", "x": 1, "y": 1})["found"])

    def test_under_the_wheel_in_a_chromium_window(self):
        # Electron: the window's hit test ends on an empty views panel that lies over the web view; the page is in the
        # panel beside it. What shows at the point is looked for there.
        field = Acc("spin button", "Quantity", bounds=(700, 774, 500, 260))
        doc = Acc("document web", "Order Form", bounds=(700, 450, 500, 450),
                  kids=[Acc("paragraph", "", bounds=(700, 450, 500, 34)), field])
        holder = Acc("panel", "", bounds=(700, 450, 500, 450), kids=[Acc("panel", "", bounds=(700, 450, 0, 0), states=()), doc])
        empty = Acc("panel", "", bounds=(700, 450, 500, 450))
        top = Acc("panel", "", bounds=(700, 450, 500, 450), kids=[empty, holder])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (700, 450, 500, 450), [top]
        for parent in (win, top, holder, doc):
            for kid in parent.kids:
                kid.parent = parent
        chain = lambda x, y: e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})["chain"]
        # Looked through by bounds: the empty panel comes first, the one holding the page is taken.
        self.assertEqual([c["role"] for c in chain(950, 850)], ["panel", "panel", "document web", "spin button"])
        # Asked of the app (Chromium answers with the deepest element there, and from the window, the empty panel).
        hits = {top.path: empty, holder.path: field}
        box = lambda acc, coords: types.SimpleNamespace(x=acc.bounds[0], y=acc.bounds[1], width=acc.bounds[2], height=acc.bounds[3])
        fake = types.SimpleNamespace(
            CoordType=types.SimpleNamespace(SCREEN=0),
            Component=types.SimpleNamespace(get_accessible_at_point=lambda acc, x, y, coords: hits.get(acc.path), get_extents=box),
            Accessible=types.SimpleNamespace(get_state_set=lambda acc: types.SimpleNamespace(get_states=lambda: acc.states)))
        saved = e.Atspi, e.native
        e.Atspi, e.native = fake, lambda acc: acc is top or acc is holder
        try:
            got = chain(950, 850)
            self.assertEqual([(c["role"], c["name"]) for c in got], [("panel", ""), ("panel", ""), ("spin button", "Quantity")])
            self.assertNotIn("empty", got[-1])
            # Nothing but the empty panel there: the answer says the app told nothing about what shows.
            top.kids = [empty]
            self.assertEqual(chain(950, 850), [{"role": "panel", "name": "", "bounds": {"x": 700, "y": 450, "width": 500, "height": 450}},
                                               {"role": "panel", "name": "", "bounds": {"x": 700, "y": 450, "width": 500, "height": 450},
                                                "empty": True}])
        finally:
            e.Atspi, e.native = saved

    def test_what_is_drawn_on_top_at_a_point(self):
        # GTK: an in-app notification (GtkOverlay) floats over a list's top rows, and a header bar's popover over the
        # rows below; the app's hit test answers the first child there, which is under them.
        rows = [Acc("list item", "", bounds=(0, 80 + 37 * i, 360, 37), kids=[Acc("label", "Row %d" % i, bounds=(2, 90 + 37 * i, 356, 17))])
                for i in range(6)]
        pane = Acc("scroll pane", "", bounds=(0, 80, 360, 420), kids=[Acc("list box", "", bounds=(0, 80, 360, 1480), kids=rows)])
        undo = Acc("push button", "Undo", bounds=(100, 120, 68, 34))
        note = Acc("filler", "", bounds=(0, 110, 360, 54), kids=[Acc("label", "File deleted", bounds=(16, 120, 73, 34)), undo])
        overlay = Acc("panel", "", bounds=(0, 80, 360, 420), kids=[pane, note])
        popover = Acc("panel", "", bounds=(10, 230, 340, 120), kids=[Acc("push button", "Delete Some", bounds=(30, 250, 300, 40))])
        win = self.notes.wins[0]
        win.states.append("visible")
        win.bounds, win.kids = (0, 60, 362, 445), [overlay, popover]
        chain = lambda x, y: [(c["role"], c["name"]) for c in e.at_point({"pid": 20, "path": win.path, "x": x, "y": y})["chain"]]
        self.assertEqual(chain(120, 130)[-1], ("push button", "Undo"))
        self.assertEqual(chain(120, 260)[-1], ("push button", "Delete Some"))
        self.assertEqual(chain(120, 200)[-1], ("list item", ""))
        # Hidden: the row under it again.
        popover.states = ["visible"]
        self.assertEqual(chain(120, 260)[-1], ("list item", ""))
        # Asked of the app (its hit test answers the first child): the one drawn over it all the same.
        for parent in (win, overlay, pane, note):
            for kid in parent.kids:
                kid.parent = parent
        box = lambda acc, coords: types.SimpleNamespace(x=acc.bounds[0], y=acc.bounds[1], width=acc.bounds[2], height=acc.bounds[3])
        first = lambda acc, x, y, coords: next((k for k in acc.kids if e.contains(e.extents(k), x, y)), None)
        fake = types.SimpleNamespace(
            CoordType=types.SimpleNamespace(SCREEN=0),
            Component=types.SimpleNamespace(get_accessible_at_point=first, get_extents=box),
            Accessible=types.SimpleNamespace(get_state_set=lambda acc: types.SimpleNamespace(get_states=lambda: acc.states)))
        saved = e.Atspi, e.native
        e.Atspi, e.native = fake, lambda acc: acc in (win, overlay)
        try:
            self.assertEqual(chain(120, 130)[-1], ("push button", "Undo"))
        finally:
            e.Atspi, e.native = saved
        # The app's own popup window (an open menu) lies over its windows: what is at the point is in it.
        item = Acc("menu item", "Delete All", bounds=(100, 400, 200, 30))
        menu = Acc("window", "", bounds=(90, 390, 220, 100), kids=[Acc("menu", "", bounds=(90, 390, 220, 100), kids=[item])])
        self.notes.wins.append(menu)
        try:
            self.assertEqual(chain(120, 410), [("window", ""), ("menu", ""), ("menu item", "Delete All")])
            menu.states = ["visible"]  # closed
            self.assertEqual(chain(120, 410)[-1], ("list box", ""))
        finally:
            self.notes.wins.remove(menu)

    def test_chromium_is_asked_twice_at_a_new_point(self):
        # Chromium's first answer at a new point is a guess by the elements' boxes (the row: later in the page); asked
        # again it answers from the page's hit test (the fixed header's button drawn over the row).
        button = Acc("push button", "Delete everything", bounds=(10, 60, 300, 36))
        row = Acc("static", "A row 2", bounds=(10, 70, 54, 17))
        doc = Acc("document web", "Web Rows", bounds=(0, 60, 520, 600), kids=[button, row])
        doc.toolkit = "Chromium"
        answers = [row, button, button]
        fake = types.SimpleNamespace(
            CoordType=types.SimpleNamespace(SCREEN=0),
            Accessible=types.SimpleNamespace(get_toolkit_name=lambda acc: acc.toolkit),
            Component=types.SimpleNamespace(get_accessible_at_point=lambda acc, x, y, coords: answers.pop(0) if answers else button))
        saved = e.Atspi, e.native, e.HIT_AGAIN_S
        e.Atspi, e.native, e.HIT_AGAIN_S = fake, lambda acc: True, 0
        try:
            self.assertIs(e.hit_at(doc, 30, 75), button)
            self.assertEqual(answers, [])  # asked again until two answers in a row agree
            doc.toolkit = "GTK"
            answers[:] = [row, button]
            self.assertIs(e.hit_at(doc, 30, 75), row)  # other toolkits: one answer
        finally:
            e.Atspi, e.native, e.HIT_AGAIN_S = saved

    def test_the_part_of_an_element_that_shows(self):
        # GTK: a list scrolled until "Keep file 7" shows 6 px, above a button below the list (its middle is on the button).
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        rows = [Acc("check box", "Keep file %d" % i, bounds=(701, 84 + 30 * i, 300, 30)) for i in range(8)]
        box = Acc("filler", "", bounds=(701, 84, 300, 240), kids=rows)
        view = Acc("viewport", "", bounds=(701, 100, 294, 200), kids=[box])
        pane = Acc("scroll pane", "", bounds=(700, 99, 302, 202), kids=[view, Acc("scroll bar", "", bounds=(995, 100, 6, 200))])
        button = Acc("push button", "Delete all files", bounds=(701, 300, 300, 40))
        win = Acc("frame", "EdgeTest", bounds=(700, 80, 302, 262), kids=[pane, button])
        win.parent = types.SimpleNamespace(getRoleName=lambda: "application")
        for parent in (win, pane, view, box):
            for kid in parent.kids:
                kid.parent = parent
        shown = lambda acc: e.read_element({"id": e.SNAPSHOTS.add(acc), "shown": True}).get("shown")
        self.assertEqual(shown(rows[7]), {"x": 701, "y": 294, "width": 294, "height": 6})
        self.assertNotIn("shown", e.read_element({"id": e.SNAPSHOTS.add(rows[7])}))  # only asked for where the mouse aims
        self.assertEqual(shown(rows[0]), {"x": 701, "y": 100, "width": 294, "height": 14})
        self.assertIsNone(shown(rows[3].__class__("label", "", bounds=(701, 180, 50, 20))))  # no parent known: as reported
        self.assertEqual(shown(rows[3]), {"x": 701, "y": 174, "width": 294, "height": 30})  # under the scroll bar's edge
        self.assertIsNone(shown(button))
        win.bounds = (700, 80, 302, 240)  # a smaller window: the button is half out of it
        self.assertEqual(shown(button), {"x": 701, "y": 300, "width": 300, "height": 20})
        # A read says the same.
        nodes = []
        e.walk(win, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        by = dict((n["name"], n) for n in nodes)
        self.assertEqual(by["Keep file 7"]["shown"], {"x": 701, "y": 294, "width": 294, "height": 6})
        self.assertEqual(by["Delete all files"]["shown"], {"x": 701, "y": 300, "width": 300, "height": 20})
        self.assertNotIn("shown", by["EdgeTest"])

    def test_a_web_page_shows_in_its_own_units(self):
        # Chromium at scale 2 (HND8-2): the window reports logical pixels (20, 20, 380x440), its page physical ones
        # (40, 40, 760x880). The page clips what is in it, and a frame in it what is in the frame; the window never
        # does (Ember clips by the window in its own units).
        e.SNAPSHOTS = e.Snapshots(start=1)
        e.SNAPSHOTS.begin()
        low = Acc("static", "A row 7", bounds=(60, 756, 107, 36))
        framed = Acc("static", "F row 9", bounds=(64, 1190, 107, 36))
        inner = Acc("document web", "", bounds=(44, 820, 730, 520), kids=[framed])
        page = Acc("document web", "Web Rows", bounds=(40, 40, 760, 880), kids=[low, inner])
        win = Acc("frame", "Web Rows", bounds=(20, 20, 380, 440), kids=[page])
        win.parent = types.SimpleNamespace(getRoleName=lambda: "application")
        for parent in (win, page, inner):
            for kid in parent.kids:
                kid.parent = parent
        shown = lambda acc: e.read_element({"id": e.SNAPSHOTS.add(acc), "shown": True}).get("shown")
        self.assertIsNone(shown(low))
        self.assertIsNone(shown(page))
        self.assertEqual(shown(inner), {"x": 44, "y": 820, "width": 730, "height": 100})
        self.assertEqual(shown(framed), {"x": 64, "y": 1190, "width": 107, "height": 0})  # below what the page shows
        # A read says the same (H9-5): the window's frame cut what the page holds down to nothing, and marks.ts left
        # their numbers out of the screenshot.
        nodes = []
        e.walk(win, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([(n["role"], n["name"], n.get("shown")) for n in nodes], [
            ("frame", "Web Rows", None), ("document web", "Web Rows", None), ("static", "A row 7", None),
            ("document web", "", {"x": 44, "y": 820, "width": 730, "height": 100}),
            ("static", "F row 9", {"x": 64, "y": 1190, "width": 107, "height": 0})])
        # Scrolled panes inside a page don't clip it (they are the page's own boxes, as in visible_part); outside a
        # page, a pane does, in the window's units, as before.
        pane = Acc("scroll pane", "", bounds=(40, 40, 100, 100), kids=[Acc("static", "Deep", bounds=(60, 300, 50, 20))])
        pane.kids[0].parent, pane.parent = pane, page
        page.kids.append(pane)
        nodes = []
        e.walk(win, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertNotIn("shown", [n for n in nodes if n["name"] == "Deep"][0])
        page.kids.remove(pane)
        pane.parent = win
        win.kids.append(pane)
        nodes = []
        e.walk(win, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        self.assertEqual([n for n in nodes if n["name"] == "Deep"][0]["shown"], {"x": 60, "y": 300, "width": 50, "height": 0})

    def test_one_broken_app_does_not_break_the_list(self):
        class Broken(self.AppNode):
            @property
            def childCount(self):
                raise RuntimeError("org.freedesktop.DBus.Error.NoReply")
        self.desktop.kids.insert(0, Broken(30, []))
        self.assertEqual(len(e.list_windows({})["windows"]), 3)


class Protocol(unittest.TestCase):
    def run_sidecar(self, *requests):
        env = dict(os.environ, LANG="C", LC_ALL="C")
        env.pop("PYTHONIOENCODING", None)
        env.pop("PYTHONUTF8", None)
        p = subprocess.Popen([sys.executable, "-c", STUB], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env)
        data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests).encode("utf-8")
        out, err = p.communicate(data, timeout=20)
        return [json.loads(line) for line in out.decode("utf-8").splitlines()], err.decode("utf-8", "replace")

    def test_utf8_under_the_c_locale_and_a_clean_stdout(self):
        text = "Grüße café 日本 \U0001f600"
        out, err = self.run_sidecar({"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {"text": text}},
                                    {"jsonrpc": "2.0", "id": 2, "method": "noisy"},
                                    {"jsonrpc": "2.0", "id": 3, "method": "nan"},
                                    {"jsonrpc": "2.0", "id": 4, "method": "nope"})
        self.assertEqual(out[0]["result"]["text"], text)
        self.assertEqual(out[1]["result"], {"ok": True})
        self.assertIn("a library writing to stdout", err)
        self.assertIn("could not be encoded", out[2]["error"]["message"])
        self.assertIn("unknown method", out[3]["error"]["message"])

    def test_without_pyatspi(self):
        saved = e.pyatspi
        e.pyatspi = None
        try:
            self.assertIn("result", e.handle('{"id": 1, "method": "ping"}'))
            self.assertIn("pyatspi is not installed", e.handle('{"id": 2, "method": "list_windows"}')["error"]["message"])
        finally:
            e.pyatspi = saved


class Links(unittest.TestCase):
    """Requests that run the app's own code go on a link the holder keeps open until the app waits on none (PR10-1)."""

    def test_a_modal_window_that_shows(self):
        bit = lambda *ns: [sum(1 << n for n in ns if n < 32), sum(1 << (n - 32) for n in ns if n >= 32)]
        self.assertTrue(e.shows_modal(bit(e.STATE_MODAL, e.STATE_SHOWING, 30)))
        self.assertFalse(e.shows_modal(bit(e.STATE_MODAL)))  # hidden
        self.assertFalse(e.shows_modal(bit(e.STATE_SHOWING, 30)))
        self.assertFalse(e.shows_modal([]))
        if e.Atspi is not None:
            self.assertEqual((e.STATE_MODAL, e.STATE_SHOWING), (int(e.Atspi.StateType.MODAL), int(e.Atspi.StateType.SHOWING)))

    def test_a_stand_in_is_asked_as_libatspi_asks(self):
        class Action(object):
            obj = object()
        self.assertEqual(e.on_link(Action(), "DoAction", (0,), lambda: "libatspi"), "libatspi")

    def start_holder(self):
        import socket
        mine, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        holder = subprocess.Popen([sys.executable, os.path.join(HERE, "ember_atspi.py"), "--hold", str(theirs.fileno())],
                                  pass_fds=(theirs.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
        theirs.close()
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        return mine, holder

    def hand_over(self, ctrl, pid):
        """A link to app `pid` handed to the holder: our end of it."""
        import array
        import socket
        ours, link = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(ours.close)
        note = json.dumps({"pid": pid, "address": ""}).encode("utf-8")
        ctrl.sendmsg([note], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [link.fileno()]))])
        link.close()
        ctrl.settimeout(10)
        self.assertEqual(ctrl.recv(16), b"ok")
        ours.settimeout(0.1)
        return ours

    def still_open(self, ours, seconds):
        import socket
        until = time.time() + seconds
        while time.time() < until:
            try:
                if ours.recv(1) == b"":
                    return False
            except socket.timeout:
                pass
        return True

    def test_the_holder_keeps_a_link_until_its_app_is_gone_even_after_the_sidecar(self):
        app = subprocess.Popen(["sleep", "60"])
        self.addCleanup(lambda: app.poll() is None and app.kill())
        ctrl, holder = self.start_holder()
        ours = self.hand_over(ctrl, app.pid)
        self.assertTrue(self.still_open(ours, 2.5))  # its app can't be asked: kept
        ctrl.close()  # the sidecar has gone
        self.assertTrue(self.still_open(ours, 1.5))
        self.assertIsNone(holder.poll())
        app.kill()
        app.wait()
        self.assertFalse(self.still_open(ours, 5))
        holder.wait(timeout=5)  # nothing left to keep: it ends

    def test_a_link_its_app_closed_is_let_go(self):
        app = subprocess.Popen(["sleep", "60"])
        self.addCleanup(lambda: app.poll() is None and app.kill())
        ctrl, holder = self.start_holder()
        first = self.hand_over(ctrl, app.pid)
        second = self.hand_over(ctrl, app.pid)
        first.close()  # the app's end of it closed
        self.assertTrue(self.still_open(second, 2.5))
        ctrl.close()
        second.close()
        holder.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
