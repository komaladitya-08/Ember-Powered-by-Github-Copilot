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

    def test_secret_scan_reads_only_the_rows_on_screen(self):
        root, lst = self.scrolled_list()
        lst.kids[2510].kids = [Acc("password text", "", bounds=(20, 302, 100, 16))]  # in row 2509, on screen
        found = {"fields": [], "labels": [], "docs": []}
        budget = e.Budget(e.SCAN_BUDGET_S)
        e.scan_fields(root, 0, found, None, budget, [0])
        self.assertEqual([r for r, _ in found["fields"]], ["password text"])
        self.assertFalse(budget.busy or budget.over or budget.cut)
        self.assertLess(lst.child_reads, 120)

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
        e.STRIKES.clear()
        e.KNOWN.clear()
        e.new_request()
        self.mail =self.AppNode(10, [Acc("frame", "Inbox - Mail", states=("showing",)),
                                      Acc("frame", "Compose - Mail", states=("showing", "active"))])
        self.notes = self.AppNode(20, [Acc("frame", "notes.txt - Text Editor", states=("showing",))])
        self.desktop = Acc("desktop frame", "main", kids=[self.mail, self.notes])
        FAKE.Registry = types.SimpleNamespace(getDesktop=lambda i: self.desktop)

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
            e.HUNG[30] = time.monotonic() - 1  # 30 s later
            self.assertFalse(e.is_hung(30))
        finally:
            e.SLOW_APP_S = old

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
        self.assertEqual(e.shell_overlays({}), {"overlays": []})
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
        finally:
            e.collection_matches = saved
        self.assertTrue(out["complete"])
        self.assertEqual(sorted(f["bounds"]["y"] for f in out["fields"]), [220, 250])
        self.assertEqual(asked, [("document web", True), ("document web", False)])
        self.assertEqual(doc.child_reads, 0)

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
