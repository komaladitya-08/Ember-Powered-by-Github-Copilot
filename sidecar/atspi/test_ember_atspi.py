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
                      "Security code", "Expiry date", "Pass​word", "ＰＡＳＳＷＯＲＤ"]:
            self.assertTrue(e.looks_secret(label), label)
        for label in ["Name", "Spinner", "Pinned items", "Search", "Compass", "Bypass", "Subject", "", None]:
            self.assertFalse(e.looks_secret(label), label)

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

    def test_long_lists_at_the_top(self):
        root, _ = self.scrolled_list(rows=1000, first=0)
        nodes = []
        e.walk(root, 0, nodes, e.MAX_DEPTH, e.MAX_NODES, None)
        names = [n["name"] for n in nodes if n["role"] == "list item"]
        self.assertEqual(names, ["row %d" % i for i in range(25)])

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
        self.mail = self.AppNode(10, [Acc("frame", "Inbox - Mail", states=("showing",)),
                                      Acc("frame", "Compose - Mail", states=("showing", "active"))])
        self.notes = self.AppNode(20, [Acc("frame", "notes.txt - Text Editor", states=("showing",))])
        self.desktop = Acc("desktop frame", "main", kids=[self.mail, self.notes])
        FAKE.Registry = types.SimpleNamespace(getDesktop=lambda i: self.desktop)

    def name_of(self, params):
        found = e.find_window(params)
        return found[2].name if found else None

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
        old = e.SLOW_APP_S
        e.SLOW_APP_S = 0.01
        try:
            self.notes.delay = 0.05
            self.assertEqual(self.name_of({"title": "notes"}), "notes.txt - Text Editor")
            self.assertTrue(e.is_hung(20))
            asked = self.notes.asked
            self.assertEqual(e.list_windows({})["windows"][0]["app"], "app10")
            self.assertEqual(len(e.list_windows({})["windows"]), 2)
            self.assertEqual(self.notes.asked, asked)
            # Asked for by its own pid, it is still read.
            self.assertEqual(self.name_of({"pid": 20}), "notes.txt - Text Editor")
            e.HUNG[20] = time.monotonic() - 1  # 30 s later
            self.assertFalse(e.is_hung(20))
        finally:
            e.SLOW_APP_S = old

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
