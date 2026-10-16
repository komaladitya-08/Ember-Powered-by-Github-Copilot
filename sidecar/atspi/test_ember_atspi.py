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


if __name__ == "__main__":
    unittest.main()
