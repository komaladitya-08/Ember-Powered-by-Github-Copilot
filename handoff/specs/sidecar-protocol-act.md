# Sidecar protocol: the acting side (tier 1)

Spec for porting the acting half of Ember's accessibility sidecar from AT-SPI (Python) to a Windows UI Automation
sidecar and a macOS AX sidecar. Both must speak the **same** newline-delimited JSON-RPC protocol.

Sources read (line numbers are from the current tree):

- `sidecar/atspi/ember_atspi.py` (4662 lines). Acting code is at 2697-3790, `METHODS` at 4192-4210, links at
  4213-4590, the protocol loop at 4594-4662.
- `app/main/perception/sidecar.ts` (453 lines), the TypeScript client `AtspiSidecar`.
- `app/main/agent/worker.ts`, the only caller of the acting methods (`act`, `route`, `withoutTier1`, `cursorAct`,
  `chooseOption`).
- `sidecar/atspi/test_ember_atspi.py` (2991 lines), plus `test/integration/perception.test.ts` and
  `test/integration/action-link.test.ts`.

Sections marked **[platform note]** are porting advice based on how UIA and AX behave. They come from outside this
repo, so check them on real systems. Everything else describes the existing code.

---

## 1. Transport facts the acting side relies on

| Fact | Where |
|---|---|
| One JSON object per line on stdin, one answer per line on stdout, UTF-8 whatever the locale. A request looks like `{"jsonrpc":"2.0","id":N,"method":M,"params":{...}}`. | `handle` 4625, `main` 4641, `protocol_streams` 4607 |
| Success is `{"jsonrpc":"2.0","id":N,"result":R}`. Failure is `{"jsonrpc":"2.0","id":N,"error":{"message":str,"detail":traceback}}`. The TS side reads only `error.message`. | 4636-4638; sidecar.ts:276 |
| Values JSON can't carry (NaN, Infinity) turn the whole answer into the error `"the answer could not be encoded: ..."`. | `encode` 4616 |
| Unknown method: `KeyError("unknown method: X")`. Python's `str(KeyError)` adds quotes, so the message is `'unknown method: X'`. | 4632 |
| **Strictly one request at a time.** The client gives each request 5000 ms by default (sidecar.ts:311). After that it rejects the request, SIGKILLs the process and starts a new one (`retire` → `revive`, sidecar.ts:283-309). Every element id from the dead process becomes unknown. | sidecar.ts:311-325 |
| Stdout is reserved for protocol lines: fd 1 is pointed at stderr, so stray library prints can't corrupt answers. | `protocol_streams` 4607 |
| `EMBER_ATSPI_ID_BASE` (env) sets where this process's element ids start (`k * 10_000_000`, sidecar.ts:219). | `first_id` 758 |
| On every new process, before anything else, the client writes `remember_secrets` with the secret and withheld keys it has collected. It doesn't wait for the answer (sidecar.ts:241-244). | |

**Every acting method must answer well within 5 s, even when the app hangs or opens a modal dialog.** Otherwise the
client kills the sidecar. The Python budgets are listed in §11.

---

## 2. Shared concepts

### 2.1 Element ids (`Snapshots`, 771-853)

- Ids come only from reads: `read_window` nodes (1573), spreadsheet cells (1196) and `secret_fields` (2518). They are
  integers that are unique across reads and across processes, because each process starts from its own base.
- The sidecar keeps the last `KEEP = 8` kept reads, plus one scratch read (a `keep: false` quick look) that the next
  quick look replaces. `SNAPSHOTS.get(id)` searches the kept reads newest first, then the scratch read. An unknown id
  raises `KeyError("element N is no longer known; read the window again")`.
- A spreadsheet cell's id stores `(table, row, col)` and is looked up again on every use (`SheetCell`, `live`
  826-850). That matters for acting only because `can_do` and `read_element` take ids of cells too.
- The TS side tracks HiDPI scale by id (`scaleElements`). It turns `before.bounds`, `after.bounds` and `shown` into
  physical pixels (`physicalResult`, sidecar.ts:359). The sidecar reports bounds **as the app reports them**.

### 2.2 `usable(nid)` (2814-2828): preconditions for state-changing calls

`do_action`, `set_text`, `set_value`, `select_option` and `focus` call it. `can_do`, `list_options` and
`read_element` do **not**; they use `SNAPSHOTS.get` directly.

1. `states = state_names(acc)`. A failed state read returns `[]`.
2. If `states` is empty and the read took longer than `SLOW_APP_S = 0.7` s, raise `RuntimeError(BUSY)`.
3. If `states` is empty or contains `"defunct"`, raise `RuntimeError("element N is gone (the window changed); read the window again")`.
4. If neither `"sensitive"` nor `"enabled"` is present, raise `RuntimeError("element N is disabled right now")`.
5. If `"showing"` is absent, raise `RuntimeError("element N is no longer on screen; read the window again")`.

None of these errors carry the `background_unavailable` prefix, so the TS side never escalates them to the mouse.

### 2.3 Role and state vocabulary acting depends on

The whole stack keys off **AT-SPI role names** (lower case, with spaces: `"push button"`, `"combo box"`,
`"table cell"`, `"password text"`...) and **AT-SPI state names**. A Windows or macOS sidecar must translate UIA
ControlTypes and AX roles into these exact strings, and translate the same way in `read_window` and in
`read_element`/`node_info`. `Worker.fresh` (worker.ts:1508) fails an action when `live.role !== node.role`.

States reported in `ElementInfo.states` are filtered to `INTERESTING_STATES` (81-82): `focused`, `checked`,
`selected`, `expanded`, `collapsed`, `pressed`, `editable`, `multi line`, `sensitive`, `enabled`, `focusable`,
`active`.

The TS side reads these states:

| State | TS use |
|---|---|
| `checked`, `pressed` | `isOn` (worker.ts:182): the toggle tool, `notTurned` verification, list check boxes |
| `sensitive`, `enabled` | `isDisabled` (worker.ts:731): a **non-empty** state list without both counts as disabled. **An enabled element must report `enabled` and/or `sensitive`**, or every action is refused. |
| `focused` | `untilFocused`, `landingSpot().focused`, `can_do.focused` |
| `editable` | `typable` (worker.ts:155): text may be typed with the borrowed keyboard only into `TYPING_ROLES` (`text`, `entry`, `paragraph`, `document text`, `section`, `spin button`) that are editable |
| `selected` | the integration test expects `after.states` to contain `selected` once a row is chosen (perception.test.ts:176) |

States used only inside the sidecar: `showing` and `defunct` (in `usable`), `active` on the **window** (in
`window_active`), and `manages descendants` (in `spreadsheet`).

### 2.4 The `background_unavailable` contract

The prefix `"background_unavailable: "` on an error message, or at the start of `CanDo.why` once the prefix is
stripped, means **accessibility can't do this, but the user's mouse could** (the borrowed cursor, tier 3; or the
desk's input, tier 2). The text after the prefix is shown to the model and written to the audit log. The UI shows it
to the user with the prefix stripped (`forUser`, app/renderer/home/copy.ts:118-127), so it must be plain English
that says why.

The Python code raises it in these cases:

| Raised by | Message after the prefix |
|---|---|
| `pick_action` 2857-2858 | `this element has no accessible actions` (no Action interface) |
| `pick_action` 2870 | `no '<want>' action (has: <lower-cased names, comma-separated, or "none">)` |
| `editable_text` 2877 | `this element's text can't be edited directly` |
| `value_iface` 2884 | `this element has no value to set` |
| `LIST_CHECK_BOX` 3000 | `a check box in a list is ticked only by a click on it (its accessible action would open its row instead)` |
| `ROW_IN_BACKGROUND` 3066 | `its window isn't the active one, and a row is chosen as a click chooses it (the list's cursor, which Enter and the app follow, with it) only by bringing the window to the front` |
| `ITEM_IN_BACKGROUND` 3005 | `its window isn't the active one, and an icon is chosen as a click chooses it (the cursor, which Enter follows, with it) only by bringing the window to the front` |
| `row_of`/`choose_row`, `can_do` | `its row can't be selected by accessibility` |
| `item_of`/`choose_item` | `it can't be selected by accessibility` |
| `option_items` 3601 | `this element has no selectable options` |
| `select_option` 3698 | `the option is gone`. This one is internal: it is caught at 3700 and only skips the fallback. |

How the TS side reacts to the prefix (see §8):

- `click`, `toggle`, `text`: borrow the mouse with the user's OK (`withoutTier1` → `cursorAct`). Text is borrowed
  only into a typable field; any other target is refused.
- `value`: fails with "can't be done without the mouse". A spreadsheet cell gets "use type_text" instead.
- `select` (choose_option): `listOptions` failing with the prefix gives "no options Ember can choose by
  accessibility" (worker.ts:1649). `selectOption` failing with it goes through `act()` and `withoutTier1("select")`,
  which **fails** without borrowing. The mouse is never used for `choose_option`.

### 2.5 Busy versus gone

- `BUSY = "the app is busy (it didn't answer in time); try again in a moment"` (2715). On the TS side, `isBusy`
  (worker.ts:415) matches `/\bbusy\b|did not (receive a reply|answer)|timeout was reached/i` and maps it to "Wait a
  moment, then call perceive_window".
- `unreachable(nid, err, t0)` (2722) decides between the two: BUSY if the call took longer than `SLOW_APP_S`, or if
  the libatspi error says "did not receive a reply" or "timeout was reached". Otherwise
  `ElementGone("element N is gone (the window changed); read the window again")`.
- `after_action` (2839-2849) runs **after an action that worked**. "Gone" counts as an answer, not an error:
  `{"after": null, "gone": true}`, because an OK or Close button closes its own dialog. Busy becomes
  `{"after": null, "busy": true}`. The TS side treats `after: null` without `busy` as "the element is gone now (its
  dialog or window most likely closed)" (worker.ts:1745).
- The TS side checks `/did not answer/` (worker.ts:1761) **before** `isBusy` and replies "The app didn't answer in
  time, so it's unknown whether this happened". Two messages hit that check: the link timeout message `"the app did
  not answer in time (it may still do it)"` (4434) and the client's own 5 s timeout.

### 2.6 `settle()` (2809)

`time.sleep(0.08)` after each state-changing call, because toolkits apply most changes on their next main-loop
iteration. After an action, the element is read again once (`after`). Tests replace `e.settle` with a no-op.

### 2.7 Refusing secret fields

- `is_secret(acc, role, name)` (335-346) is true when any of these holds:
  - the role is `password text`;
  - `object_key(acc)` is in `SECRETS`, the remembered secret fields;
  - the role is in `FIELD_ROLES` (`text`, `entry`, `password text`, `spin button`, `combo box`) and its name, a
    LABELLED_BY target's name, or its placeholder (`placeholder-text`/`placeholder` attribute) matches `SECRET_LABEL`.

  A positive answer adds the key to `SECRETS`.
- `object_key(acc)` (302) is `(app bus name, object path)`. The TS side stores these keys as `[string, string]`
  pairs, at most 4096 per map (sidecar.ts:248-258), and hands them back to every new process with
  `remember_secrets {keys, withheld?}` (2526). `mark_secret {ids}` (2536) adds fields that the TS side's layout
  analysis found secret. **A Windows or macOS sidecar needs an equally stable `[string, string]` key per element**
  that survives a sidecar restart (§14).
- `refuse_secret(acc)` (2831-2836) raises `PermissionError`, which reaches the client as a plain error:
  - `"password fields are off limits to Ember; the user must fill them in"` for role `password text`;
  - `"this looks like a password or payment field; the user must fill it in"` when `is_secret`.
- **Methods that refuse:** `set_text` (3487), `set_value` (3505), `select_option` (3656), and `list_options` through
  `option_items` (3594).
- **Methods that don't refuse:** `do_action` (clicking a password field is allowed), `focus`, and `can_do`. For
  `kind: "text"`, `can_do` checks only for EditableText, so it can report `tier1: true` for a password field. The TS
  policy refuses secret fields before it gets there; the sidecar refusal is defense in depth.
- `node_info` never returns `text`, `value` or `selected` for a secret element (2753-2755).

### 2.8 Withheld names in action answers

Some names would say what a secret field holds: a list item named "Card number 4111...", or a Chromium cell named
after the input inside it. They are reported as `""`:

- `node_info`: `name` becomes `""` and `withheld: true` when `withheld_name(...) == ""` (a web-engine name check,
  plus the `WITHHELD` set), or when the key is in `WITHHELD`. A withheld element returns early, without text, value
  or selected (2756-2758).
- `said_name(acc, name, values, elsewhere)` (3216) blanks an option or row name that contains a secret value.
  `values` comes from `secret_values_in(container)`, which looks only at web engines through Collection (3199).
  `elsewhere` comes from `values_known(acc)`, the values remembered from the app's last read (1818).
- `click_handler` passes the handler's name through `withheld_name` (2970).
- `cell_words` never returns a secret cell's name or a withheld one (3225).

---

## 3. Result shapes

### 3.1 `ElementInfo`: `node_info(acc, nid=None)` (2730-2795); TS type sidecar.ts:109-132

`node_info` is used for `before`/`after` and is also the body of `read_element`.

| Field | Type | Meaning and rule |
|---|---|---|
| `role` | string | AT-SPI role name. |
| `name` | string | Trimmed and capped at 200 characters. `""` when withheld. |
| `states` | string[] | Filtered to `INTERESTING_STATES` (§2.3). `[]` when the state read failed. |
| `bounds` | `{x,y,width,height}` \| null | Screen coordinates as the app reports them. `null` when the element has no position: GTK's INT_MIN, a negative size, or an exception (`bounds_of` 191). |
| `offscreen` | true? | Only for `menu item`/`check menu item`/`radio menu item` whose states are **non-empty** and lack `showing`: GTK keeps a closed menu's items. TS: `stillSame`/`changedWhileDeciding`/`cursorAct` treat a menu item that went offscreen as "its menu closed" (worker.ts:1620, 1628, 1894). |
| `withheld` | true? | The name was withheld (§2.8). |
| `secret` | true? | `is_secret`. When set, the function returns right away: no text, value or selected. |
| `text` | string? | `text_of(acc, 2000)`: the first **2000** characters of the Text interface. A text of 2000 characters or more is treated as truncated by `textNotTaken` (worker.ts:724-729, `TEXT_READ_LIMIT = 2000`). **Keep the 2000 cap exactly.** |
| `value` | number? | Value interface `currentValue`, finite numbers only. |
| `selected` | string? | **Combo box**: the name of the first selected child of `option_holder`, using `option_selection` (the combo's own Selection, else the holder's), checking up to 500 children, passed through `said_name`. Not truncated. **Table, tree table or tree (not a spreadsheet)**: the words of the first selected row (`getSelectedRows()[0]`), from the first of up to 8 columns that has words (`cell_words`), through `said_name`, capped at 200. Exceptions are ignored. |
| `open` | boolean? | Only for role `menu`: whether any of its first three children shows (`menu_open` 2798). |

`read_element` (3774) adds two fields:

- `shown` (with param `shown: true`): from `visible_part`.
- `formula` (with param `formula: true`, for a non-secret `table cell` that has text): the `Formula` attribute,
  capped at 2000.

Errors: `ElementGone` (a subclass of RuntimeError) or `RuntimeError(BUSY)`, never libatspi's own words.

### 3.2 `ActionResult` (TS type sidecar.ts:158)

```ts
{ ok: boolean; action?: string; option?: string; before?: ElementInfo; after: ElementInfo | null;
  gone?: boolean; busy?: boolean; unchecked?: number }   // the Python side also returns already?: true
```

| Field | Set by | Meaning |
|---|---|---|
| `ok` | all | **The app's own answer** to the request (`DoAction` returns a bool), or for selections, whether the item is selected now. It does **not** mean the effect was checked; that happens on the TS side (§7). `set_value` always returns `ok: true`. |
| `action` | `do_action` | The lower-cased AT-SPI action name that ran (`"click"`, `"press"`, `"activate"`, `"toggle"`, `"check"`, `"uncheck"`, `"select"`, `"dodefault"`, `"jump"`, `"open"`, ...), or the substitutes `"select row"` and `"select item"`. TS uses only `"select row"` and `"select item"` (worker.ts:1725, 1742). |
| `option` | `select_option` | The exact name of the option or row chosen. The TS side doesn't read it. |
| `before` | `do_action`, `select_row`, `select_item` | `node_info` before the action. The TS side only rescales it and never reads it. |
| `after` | all | `node_info` after `settle()`, or `null` (gone or busy). |
| `gone` | `after_action` | The element vanished after the action. |
| `busy` | `after_action` | The app didn't answer the read-back. TS: "result can't be read yet". |
| `unchecked` | `select_option` on a row list | The number of rows after the chosen one that weren't checked for a duplicate name in time. TS appends a note (worker.ts:1661-1665). |
| `already` | `select_option` | The row or option was already chosen, so nothing was touched. Not in the TS type and not read; only tests check it. |

### 3.3 `CanDo` (TS type sidecar.ts:139-152)

```ts
{ tier1: boolean; why?: string; focused?: boolean; windowActive?: boolean;
  action?: string; handler?: { role: string; name: string }; handlerUnknown?: boolean }
```

| Field | When present | Meaning |
|---|---|---|
| `tier1` | always | Accessibility can do it, checked the way the action itself would check it, with nothing done. |
| `why` | `tier1: false` | The `background_unavailable` text with the prefix removed. |
| `action` | click/toggle, when an action was picked | The action that would do it, as in `ActionResult.action`. Can be `"select row"` or `"select item"` with `tier1` either true or false. `"toggle"` with `tier1: false` means a check box in a list that only a mouse click ticks. **It is absent when `pick_action` failed (no usable action at all).** That absence matters, see §8. |
| `handler` | click/toggle | The control around the element that receives the click (`click_handler`): `{role, name}` with the name withheld where needed. |
| `handlerUnknown` | click/toggle | The click is handed (by accessibility) further up than 64 levels, so what it works can't be told. TS refuses the click (worker.ts:1797-1800). |
| `focused` | `caret: true` | `"focused"` is among the element's states. |
| `windowActive` | `caret: true`, only when it can be told | The element's top-level window has the `active` state (`window_active` 2887). |

Exact shapes that tests pin (`assertEqual`, so no extra keys allowed):

- `{"tier1": true, "action": "check"}` for a Chromium check box and `kind: "toggle"`.
- `{"tier1": false, "why": "this element's text can't be edited directly", "focused": false, "windowActive": true}`.
- `{"tier1": true, "action": "clickancestor", "handler": {"role": "link", "name": "Delete my account"}}`.
- `{"tier1": true, "action": "select row"}`, `{"tier1": true, "action": "select item"}`, `{"tier1": true, "action": "dodefault"}`.

---

## 4. Methods

TS wrappers are in sidecar.ts:426-446. `focus` has **no** TS wrapper and **no caller** (see §13).

### 4.1 `can_do`: `{id, kind, caret}` → `CanDo` (3367-3431)

TS: `canDo(id, kind: "click"|"toggle"|"text"|"value", caret=false)`. The worker calls it from `route()` with
`caret = (kind === "text" && mode === "insert")` (worker.ts:1782-1783). A `can_do` that throws is treated as "can't
tell", and the worker goes ahead with tier 1.

Algorithm (it never calls `usable`, so disabled or hidden elements still get an answer):

```
acc = SNAPSHOTS.get(id)        # KeyError if unknown
out = {tier1: true}; picked = None
try:
  kind in (click, toggle):
    act, names, index = pick_action(acc, kind)         # may raise background_unavailable
    picked = out.action = names[index]
    instead = instead_of_action(acc, names, picked)
    "check box"  -> out.action = "toggle"; picked = None; raise LIST_CHECK_BOX
    "select row" -> out.action = "select row"
                    if kind == click:
                      row_of(acc) is None -> raise "background_unavailable: its row can't be selected by accessibility"
                      selected_rows(t) != [row] and focuses_rows(holder) is False -> raise ROW_IN_BACKGROUND
    "select item"-> out.action = "select item"
                    if kind == click:
                      item_of(acc) is None -> raise "...it can't be selected by accessibility"
                      focuses_rows(holder) is False and not (selected alone) -> raise ITEM_IN_BACKGROUND
  kind == text:  editable_text(acc)      # EditableText interface present?
  kind == value: value_iface(acc)        # Value interface present?
except RuntimeError starting with "background_unavailable": tier1 = false; why = rest
(other errors propagate)
kind in (click, toggle): h = click_handler(acc, picked); unknown -> handlerUnknown: true; else handler = h
caret: focused = "focused" in states; windowActive = window_active(acc) if not None
```

`kind: "toggle"` with `"select row"` or `"select item"` returns `tier1: true`. The TS side then refuses the toggle
("a click on it only selects it", worker.ts:1788-1793).

### 4.2 `do_action`: `{id, action="click"}` → `ActionResult` (3434-3454)

TS: `doAction(id, "click")` for the click tool and `doAction(id, "toggle")` for the toggle tool (worker.ts:921, 934).
No other action names are sent, although `ACTION_ALIASES` also defines `press`, `activate` and `expand`.

```
acc = usable(id)
want = (action or "click").lower()
act, names, index = pick_action(acc, want)             # background_unavailable if none
instead = instead_of_action(acc, names, names[index])
"check box"                       -> raise LIST_CHECK_BOX (background_unavailable)
instead not None and want != click-> raise RuntimeError("element N is no switch or check box: a click on it only selects it")   # NOT background_unavailable
"select row"  -> return select_row(acc, id)
"select item" -> return select_item(acc, id)
before = node_info(acc, id)
ok = on_link(act, "DoAction", (index,), act.doAction(index))
settle()
return after_action(acc, id) + {ok: bool(ok), action: names[index], before}
```

`select_row(acc, nid)` (3457-3468):

1. `row_of(acc)`; if None, raise `background_unavailable: its row can't be selected by accessibility`.
2. Take `before`.
3. `ok, _ = choose_row(t, row, holder, top)`.
4. Return `after_action + {ok, action: "select row", before}`.

`select_item(acc, nid)` (3471-3481):

1. `item_of(acc)`; if None, raise `background_unavailable: it can't be selected by accessibility`.
2. Take `before`.
3. `ok = choose_item(...)`.
4. Return `after_action + {ok, action: "select item", before}`.

AT-SPI interfaces used: Action (`nActions`, `getName`, `doAction`), plus Table, Selection and Component for the
row and item substitutes.

### 4.3 `set_text`: `{id, text, mode="replace"}` → `ActionResult` without `action`/`before` (3484-3500)

TS: `setText(id, text, mode)`, where `mode` is one of `replace`, `insert`, `append` and `text` is at most 5000
characters (zod, worker.ts:942). `type_text` into a spreadsheet cell never gets here (`act` sends `isSheetCell` to
`typeInCell`, the keyboard path, worker.ts:1675).

```
acc = usable(id); refuse_secret(acc)
et = editable_text(acc)                       # background_unavailable if no EditableText
replace: ok = on_link(et, "SetTextContents", (text,))
insert/append:
   t = acc.queryText()
   offset = t.characterCount (append) | max(0, t.caretOffset) (insert)
   ok = on_link(et, "InsertText", (offset, text, len(text)))
settle()
return after_action(acc, id) + {ok: bool(ok)}
```

- The caret: `insert` puts the text at `Text.caretOffset`, clamped to at least 0 (an AT-SPI caret of -1 becomes 0).
  The caret is not moved first. Any selection is **not** replaced; the text goes in at the caret offset.
- The TS side guards insert mode in two ways:
  - Policy: after Ctrl+A (`allSelected`), an insert is judged as a replace (worker.ts:1678).
  - Borrowing the mouse for an insert is refused when `can_do` says the window is active but the field doesn't have
    the keyboard (worker.ts:1809-1811), because a click would move the caret.
- **Probable latent bug (check it):** `InsertText`'s length argument is **bytes** in libatspi/ATK/GTK
  (`gtk_editable_insert_text`), but `len(text)` is code points. Non-ASCII text in `insert`/`append` mode would be cut
  short on GTK, and the TS side would report "The field didn't take the text as asked" via `textNotTaken`.
  `SetTextContents` (replace) is not affected.
- Chromium and Electron fields on Linux have **no EditableText**, so `can_do("text")` says `tier1: false` and text
  goes in through the borrowed mouse and a clipboard paste (test at test_ember_atspi.py:1204-1210).

### 4.4 `set_value`: `{id, value}` → `{ok: true, after: ElementInfo}` (3503-3512)

TS: `setValue(id, value)`, with `value` a finite number (zod).

```
acc = usable(id); refuse_secret(acc)
v = value_iface(acc)                                        # background_unavailable
value = float(value)
not finite or < v.minimumValue or > v.maximumValue -> ValueError("value X is outside MIN..MAX")
on_link(v, "CurrentValue", (value,))                        # D-Bus Properties.Set
settle()
return {ok: True, after: node_info(acc)}
```

Quirks:

- It doesn't go through `after_action`. A gone or busy element after the set is raised as an **error**, not reported
  as `gone`/`busy`. `node_info` is called without `nid`, so the gone message reads `"element  is gone ..."` with a
  double space.
- `ok` is always `true`. There is no `before`.
- There is no snapping to `minimumIncrement`.

### 4.5 `select_option`: `{id, option}` → `ActionResult + {option, already?, unchecked?}` (3653-3713)

TS: `chooseOption` (worker.ts:1636-1666) runs these steps:

1. It refuses elements the read marked secret.
2. It calls `listOptions(id)`. Errors: `background_unavailable` gives "no options Ember can choose by accessibility";
   busy gives BUSY; anything else gives "couldn't be read".
3. `pickOption(options, want)` (worker.ts:689) matches exactly, else uniquely ignoring case and whitespace.
4. If nothing matched and `left > 0`: "type the name instead".
5. It calls `act("select", ...)` with the **exact option string from the list**. `route()` skips `can_do` for
   `select` (worker.ts:1781).

The sidecar side:

```
acc = usable(id); refuse_secret(acc)
rows = row_table(acc)          # table / tree table / tree with Selection+Table, not a spreadsheet
if rows:                       # a list of rows
  index, name, unchecked = find_row(acc, rows, option)          # ValueError / BUSY
  try ok, already = choose_row(t, index, acc, table_cell_at(acc, index, 0))
  except ROW_IN_BACKGROUND -> RuntimeError("its window isn't the active one, and choosing a row there by name would
                              bring it to the front: click a cell of that row instead")    # NOT background_unavailable
  return after_action + {ok, option: name, already?: true, unchecked?: n>0}
names = option_items(acc)                                   # refuses secret; background_unavailable w/o Selection
index = option_index(names, option)                         # exact, else the unique case-insensitive name
None -> ValueError("no option has exactly that name (it has N options); list them and use one in full")
holder = option_holder(acc); sel = option_selection(acc, holder)
option_chosen(sel, holder, index) -> return after_action + {ok: True, option, already: True}   # nothing touched
ok = bool(on_link(sel, "SelectChild", (index,)))
settle()
if not ok:                       # Chromium's closed <select> refuses Selection.selectChild
   item = holder child index; act,_,i = pick_action(item, "select")   # ONLY "select" (never "click": a GTK menu item would activate)
   (a background_unavailable here is swallowed: ok stays False)
   was = first_chosen(sel, holder)
   DoAction(i) on link; settle()
   ok = option_chosen(sel, holder, index)
   if not ok and was is not None and first_chosen(...) is None: choose_again(holder, was)   # never leave the field empty
return after_action + {ok, option: names[index]}
```

- The error for an option that isn't there doesn't include the option names. "The options themselves are app text:
  they are listed with list_options, not in an error" (3680).
- Part of a name never matches: "permanently" is not "Delete permanently".
- When `SelectChild` returns true, `ok` is **not** checked again. The TS side shows `after.selected` to the model
  through `describeAfter`.

### 4.6 `list_options`: `{id}` → `{options: string[], left?: number}` (3740-3749)

```
acc = SNAPSHOTS.get(id)           # no usable()
options = option_items(acc)
rows = row_table(acc); if rows and nrows > len(options): left = nrows - len(options)
```

`option_items(acc)` (3589-3610):

1. `refuse_secret(acc)` (PermissionError).
2. Collect `values = secret_values_in(acc)` and `elsewhere = values_known(acc)`.
3. If `row_list(acc)` returns something, return `[said_name(None, n, values, elsewhere) for n in names]`. Row lists
   are named for at most `LIST_ROWS_S = 1.5` s and `ROWS_MAX = 5000` rows; `BUSY` is raised if the app stopped
   answering before every row was named.
4. Otherwise `holder = option_holder(acc)`. If `option_selection(acc, holder)` is None, raise
   `background_unavailable: this element has no selectable options`.
5. For each of up to 500 children: a `None` child gives `""`; a secret child gives `""`; anything else gives
   `said_name(c, c.name.strip() or inner_label(c), values, elsewhere)`.

Withheld or secret options are kept as `""` **in place**. Indexes must keep matching child indexes, because
`select_option` recomputes the names and chooses by index.

### 4.7 `focus`: `{id}` → `{ok, after}` (3752-3756)

`usable` → `on_link(Component, "GrabFocus")` → `settle()` → `{ok: bool, after: node_info(acc)}`. It doesn't refuse
secret fields. **Nothing in the TS side calls it.** It is in `METHODS` only. Implementing it is optional; leaving
it out costs nothing today. If you implement it on Windows, note that UIA `SetFocus()` brings the window to the
front.

### 4.8 `read_element`: `{id, shown?, formula?}` → `ElementInfo` (3774), read again after actions

`read_element` belongs to the reading side, but the acting flow depends on it:

- `fresh` re-reads the element before the policy check. It refuses when the role changed or the element is disabled
  (worker.ts:1501-1516).
- `stillSame` re-reads after a confirmation question and compares role, name and menu-item offscreen
  (worker.ts:1615-1624).
- The toggle tool reads the state before acting (worker.ts:927).
- `notTurned` polls for up to `TOGGLE_WAIT_MS = 1000` ms every 100 ms (worker.ts:2001-2010).
- The borrowed cursor's aim uses `shown` (worker.ts:1873, 1931, 1941, 2051-2067) and `untilFocused` (2034).

---

## 5. Choosing the action

### 5.1 `ACTION_ALIASES` and `ONE_WAY` (2702-2712)

```python
ACTION_ALIASES = {
  "click":   ("click","press","activate","jump","toggle","check","uncheck","select","dodefault","open","clickancestor"),
  "press":   ("press","click","activate"),
  "activate":("activate","click","press","jump"),
  "toggle":  ("toggle","click","press","activate","check","uncheck","select","dodefault"),
  "expand":  ("expand or contract","expand","open","press"),
}
ONE_WAY = {"check": True, "select": True, "uncheck": False}
```

`pick_action(acc, want)` (2852-2870):

1. Get the Action interface. `NotImplementedError` raises `background_unavailable: this element has no accessible
   actions`.
2. Lower-case the action names.
3. Walk the candidates in alias order and take the first one present.
4. Skip a **one-way** candidate when it would change nothing: `"check"` or `"select"` when the element is already
   `checked`, `"uncheck"` when it isn't. A toggle that changes nothing must never be reported as done.
5. If nothing is left, raise `background_unavailable: no '<want>' action (has: ...)`.

Chromium and Firefox name actions by what they will do. Chromium uses `check` and `uncheck` on check boxes and radio
buttons, `doDefault` on an ARIA switch, `open` on pop-up buttons, and `clickAncestor` inside clickable elements.
Firefox uses `select` on radio buttons.

### 5.2 Substitutes for actions that behave like a double click: `instead_of_action(acc, names, picked)` (3009-3025)

GTK's cell and icon actions are double clicks: `activate` is row-activated or item-activated. In a file dialog that
opens **the row selected before**. Ember substitutes what a single click does.

| Role | Picked action | Result |
|---|---|---|
| `table cell`, `tree item` (`ROW_CELL_ROLES`) | `toggle`, where another action name starts with one of `GTK_CELL_ACTIONS` (`"expand or contract"`, `"edit"`, `"activate"`, `"expands or contracts"`, `"creates a widget"`, `"activates"`) | `"check box"`: GTK3's toggle cell, whose toggle is row-activated, so only a mouse click ticks it |
| same | `toggle` alone (Qt) | `None`: left to the cell |
| same | `activate`, `expand or contract`, `edit` | `"select row"` |
| `icon` | `activate` | `"select item"` |
| anything else | | `None` |

### 5.3 The control a click goes to: `click_handler(acc, picked)` (2937-2975)

- Constants:
  - `PASSES_CLICK = {"clickancestor", "dodefault"}`.
  - `OWN_ACTIONS = {click, press, activate, jump, open, select, toggle, check, uncheck, expand or contract}`.
  - `CLICK_CONTROLS = INTERACTIVE_ROLES - TEXT_ROLES - {terminal}`.
  - `HANDLER_STOP = {document web, document frame, frame, window, dialog, alert, file chooser, application, desktop frame}`.
  - `HANDLER_LEVELS = 64`.
- It returns `None` (the element acts itself) in two cases:
  - an action was picked that doesn't pass the click on (`dodefault` on a role in `CLICK_CONTROLS` counts as the
    element's own action);
  - no action was picked (the mouse will click) and the role is in `CLICK_CONTROLS`.
- **By accessibility** (`picked` in `PASSES_CLICK`): walk up through parents to the first ancestor whose actions
  include an `OWN_ACTIONS` name. Position doesn't matter. Stop at `HANDLER_STOP` roles (return None). Past 64 levels,
  return `{"unknown": true}`, which becomes `handlerUnknown`.
- **By mouse** (`picked` None): walk up to the first ancestor that has an own action or a role in `CLICK_CONTROLS`
  **and** covers the mouse spot (`takes_click_at`):
  - An ancestor without a position is accepted, except a `page tab`: GTK's notebook tab is the parent of its whole
    page.
  - The mouse spot (`mouse_spot`, 2917) is `(x + min(width // 2, 120), y + height // 2)`. **It must match
    `Worker.landingSpot`** (worker.ts:2066).
  - Past 64 levels, return None.
- The handler's name goes through `withheld_name` and is capped at 200. The TS side asks the user about whichever of
  the element and the handler is riskier (`clickJudged`, worker.ts:1821-1830).

---

## 6. Combo boxes, lists, tables, icons, menus

### 6.1 Combo boxes and option lists

- `option_holder(acc)` (3515): for a `combo box` with **exactly one** child whose role is `menu`, `list` or
  `list box`, that child. GTK, Chromium and Firefox keep the items there. Otherwise `acc` itself.
- `option_selection(acc, holder)` (3525): `acc.querySelection()` first (GTK's combo box), then the holder's (a
  Chromium or Firefox `<select>` has Selection on its menu). Only `NotImplementedError` is skipped.
- `chosen_item(acc)` (3541): asks the **holder's** Selection first, then the combo's. It skips an item whose path is
  the holder's own and returns the first named selected child. It is used by the read side (`node_of`'s `selected`)
  and by `secret_values`.
- `option_chosen(sel, holder, i)` (3581): `sel.isChildSelected(i)` or the child has the `selected` state.
- `option_index(names, want)` (3641): the exact name, else the case-insensitive match **only if every match has the
  same name**. Never a substring.
- `inner_label(acc)` (3616): the first `label`/`static`/`caption` with a letter or digit, searched depth-first, 4
  levels and 16 children per level. GTK's ListBox rows have no name. **Keep in step with `inferLabels` in
  elements.ts.**
- Chromium's closed `<select>` refuses `selectChild`. The fallback uses the option's own **`select`** action and
  restores the previous choice if the field ended up empty (§4.5). Choosing the option that is already chosen
  touches nothing, because Chromium's `select` on the chosen option clears it.

### 6.2 Lists of rows (GTK tree views: file dialogs, preferences)

- `row_table(acc)` (3285): role in `{table, tree table, tree}`, not `spreadsheet(acc)`, has both Selection and
  Table, `nRows >= 0`, `nColumns > 0`. Returns `(Table, nrows, ncols)`.
- `spreadsheet(acc)` (3028): `manages descendants`, `childCount > 200`, and no scroll bar beside it
  (`scroll_fraction` is None). An exception counts as a spreadsheet, the safe choice.
- `row_name(table, row, ncols, where)` (3262): the first of up to 8 columns with words (`cell_words`: the cell's name,
  or the first named descendant 2 levels deep, never secret or withheld). The previous row's column and child
  position is tried first, so naming a list costs about 2 calls per row (the test checks fewer than 2n+4 cells made).
- `row_list(acc, seconds)` (3302): names rows for at most `LIST_ROWS_S = 1.5` s and `ROWS_MAX = 5000` rows. Raises BUSY
  when the app stopped answering before the end.
- `find_row(acc, rows, want)` (3323):
  1. Name rows until the first exact match, for at most `FIND_ROW_S = 2.0` s.
  2. If there is no exact match and not every row was named, raise
     `ValueError("Ember looked through the list's first N rows of M in time and none is called exactly that: in a long list, type the name instead (in a file dialog: Ctrl+L, or its name field)")`.
  3. Otherwise use `option_index`. If that finds nothing, raise ValueError "no option has exactly that name".
  4. Check the remaining rows for a second row with the same name (ignoring case) until `TWIN_ROWS_S = 2.5` s from
     the start. A twin raises `ValueError("several rows are called that; click a cell of the one meant instead")`.
  5. Return `(index, name, nrows - len(names_seen))`; the last value becomes `unchecked`.
- `row_of(acc)` (3037): climbs at most 4 levels through parents with roles in `ROW_CELL_ROLES` (a cell can sit
  inside a cell). The first non-cell parent is the list. It must not be a spreadsheet and must have Selection and
  Table. `row = Table.getRowAtIndex(top.getIndexInParent())`.
- `choose_row(t, row, holder, cell)` (3093-3126) selects the row alone, together with the list's cursor, the way a
  single click does:
  1. `focus = focuses_rows(holder)`, only when a cell was given:
     - `None` for web-engine lists (their focus isn't a click);
     - otherwise `window_active(holder)`: True or False, or None when it can't be told.
  2. If the selection is already `[row]` and (`focus is not True` or `row_has_cursor`), return `(True, True)`.
  3. If `focus is False`, raise `ROW_IN_BACKGROUND`: grabbing focus would raise the window.
  4. If `focus` is True, call `GrabFocus` on the cell over the link. GTK then moves the cursor and the selection
     together without opening the row. If the cell took the focus and the selection is now `[row]` with the cursor
     on it, return `(True, False)`.
  5. If the row isn't selected, call `Table.AddRowSelection(row)`. If it still isn't selected, raise
     `background_unavailable: its row can't be selected by accessibility`.
  6. Call `RemoveRowSelection` for every other selected row. Otherwise a multi-select file dialog would open those
     too.
  7. Return `(selection == [row], False)`.
- `row_has_cursor` (3079): one of the row's first 8 cells has `focused` or `active`.

### 6.3 Icons (GTK icon view)

- `item_of(acc)` (3129): `(parent, parent.querySelection(), acc.getIndexInParent())`.
- `choose_item` (3143-3178):
  - "Alone" means `nSelectedChildren == 1` and `isChildSelected(index)`.
  - If the icon is already alone and (`focus is not True` or the icon is `focused`), it counts as done.
  - If `focus is False`, raise `ITEM_IN_BACKGROUND`.
  - If `focus` is True, call `GrabFocus` (errors ignored).
  - If the icon still isn't alone, call `ClearSelection` and then `SelectChild(index)`. If it isn't selected after
    that, raise `background_unavailable: it can't be selected by accessibility`.
  - Return whether it is alone.

### 6.4 Menus

The acting side has no special menu logic: a menu item is clicked like any other element (`DoAction`). It matters
in three places:

- `node_info` reports `open` for a `menu` and `offscreen` for a menu item whose menu closed.
- A GTK menu item's `"click"` activates it. That is why the option fallback uses only `"select"`.
- When a confirmation click closes a menu, the TS side carries the user's OK to the re-opened item
  (`carriedMenuApproval`, worker.ts:1627-1633).

### 6.5 `window_active(acc)` (2887)

Climbs up to 60 parents until the parent is None or has role `application`. Returns whether that top element (the
window) has the `active` state, or None on an exception or if it ran out of levels.

---

## 7. How actions are checked afterwards

The sidecar reads the element once more after `settle()` (80 ms) and returns it as `after`. `gone` and `busy` are
answers, not errors.

The TS side then does the rest (worker.ts:1722-1746):

- **Toggle**, and a click on a list's check box (`box`): `notTurned(id, turns, after)` re-reads every 100 ms for up
  to 1 s until `isOn(states)` matches. If it never does, the action fails with "The app said it did it, but it didn't
  turn on/off". A gone or unreadable element counts as not contradicting the action.
- **Text**: `textNotTaken(after, value, mode)` compares with whitespace removed: `replace` must be equal, otherwise
  the field must contain the text. It is skipped when the element is secret, `text` is missing, or `text.length >=
  2000`. A mismatch fails with "The field didn't take the text as asked".
- **Click and select**: `describeAfter(after)` gives the model role, name, states, `(open)`, `selected=`, `value=`
  and `text=`. `ok: false` becomes "The app reported it did not work". `"select row"` and `"select item"` add "as a
  single click does; it wasn't opened: press Enter (press_keys) to open it if that's what the task needs".
- The worker stores `after.name`, `after.states` and `after.bounds` in `known`, and audits
  `{after: {states, selected}}`, `{busy: true}` or `{gone: true}`.

---

## 8. TS routing and escalation: which fields drive which decision

`route(kind, id, node, element, mode)` (worker.ts:1780-1813), for `click`, `toggle`, `text` and `value`:

| Condition | Effect |
|---|---|
| `canDo` throws or returns nothing | `{via: "tier1"}`: try tier 1 anyway |
| `kind === "toggle"` and `action` is `"select row"` or `"select item"` | fail: not a switch or check box (audited) |
| `handler` present (click or toggle) | the policy judges the click as `handler` or as the element, whichever is riskier (`clickJudged`) |
| `selects = clicks && can && !handler && (action is "select row"/"select item" \|\| (!tier1 && !action))` | `clickSelects: true`: the policy judges a row's name as what it holds. **That is why `action` must be absent when there is no usable action at all.** |
| `box = clicks && can && !tier1 && action === "toggle"` | the mouse click flips it; the expected end state is the opposite of the current one |
| `handlerUnknown` | fail: "Ember can't tell what a click on element N works" (audited) |
| `tier1 === true` | `{via: "tier1", handler?, selects?}` |
| `tier1 === false` | `withoutTier1(kind, node, why)`: borrow, or fail with a message |
| insert mode, `windowActive === true`, `focused === false` | fail: can't place the caret with the mouse |

`withoutTier1` (worker.ts:1837-1846):

- Borrow when there is a desk or the user's cursor, the node has `bounds`, and the kind is click, toggle, or text
  into a typable field (`TYPING_ROLES` and `editable`).
- Text into anything else fails.
- A value on a spreadsheet cell fails with "use type_text".
- Everything else fails with "can't be done without the mouse".

After the call, `act()`'s `catch` (worker.ts:1747-1765) handles errors:

| Error message | Result |
|---|---|
| contains `background_unavailable` | `withoutTier1` → `cursorAct`. `/check box in a list/` in the message sets the flip direction. |
| matches `/did not answer/` | "unknown whether this happened" |
| `isBusy` | BUSY |
| anything else | `It didn't work: “<message>”` (the message is quoted as untrusted app text) |

`select` and `value` don't borrow (§2.4). When tier 3 runs, `cursorAct` reads `read_element(id, {shown: true})`
before aiming and again once the window is in front and the pointer is over the element. It needs `bounds`, `shown`,
`role`, `name`, `states` (focused, checked or pressed) and `offscreen`.

---

## 9. Links: why actions go over a private connection (Linux only)

Summary of 4213-4590 and test/integration/action-link.test.ts.

**The problem.** at-spi2-atk runs an action's handler while it is handling Ember's D-Bus request. A modal dialog
opened with `gtk_dialog_run` (Mousepad's Save As…, an "Attach…" button) runs a nested main loop **inside** that
handling. Until the dialog closes, nothing more on the connection the request came on is answered. Once anything waits
on that connection (another request, or the connection closing), the first key the user types in the dialog hangs the
app for good: at-spi2-atk's key snooper re-dispatches every connection from inside, and the blocked one can't be.

**The fix.** Every request that runs the app's own code (`DoAction`, `SetTextContents`, `InsertText`, `SelectChild`,
`ClearSelection`, `AddRowSelection`, `RemoveRowSelection`, `GrabFocus`, `Value.CurrentValue` via
`Properties.Set`; see `LINK_CALLS` 4237) goes through `on_link`:

1. `open_link` asks the app for its own peer-to-peer address (`org.a11y.atspi.Application.GetApplicationBusAddress`
   on the accessibility bus, cached for 256 apps) and opens a **new private D-Bus connection** to it. It checks that
   the socket's peer pid (SO_PEERCRED) is the app's pid. If there can be no link (no Gio, a Qt bridge, a test
   stand-in, or a pid mismatch), the request goes on the normal libatspi connection (`fallback()`).
2. `hold_link` hands the connection's fd **before anything is sent** to a **holder process**
   (`ember_atspi.py --hold <fd>`). The fd goes over an `AF_UNIX SOCK_SEQPACKET` socketpair with `SCM_RIGHTS`, plus
   `{"pid", "address"}`, and the holder answers `"ok"`. The holder is started with `start_new_session=True`, so it
   survives the sidecar being SIGKILLed. It may take `HOLDER_START_S = 2.0` s to answer. If it is slow or gone, the
   connection is kept in this process (`KEPT`).
3. The call itself is `conn.call_sync(..., timeout=LINK_TIMEOUT_MS=800)`. A timeout raises
   `RuntimeError("the app did not answer in time (it may still do it)")`. Other D-Bus errors are raised with their
   own message. The sidecar then closes **its** end, while the holder's copy stays open. at-spi2-atk answers
   `DoAction` *before* running the action, so a modal dialog doesn't make the call time out.
4. The holder (`hold_main`) keeps each fd open, sending nothing on it, until the app's process is gone, its end of
   the link closed, or the app shows **no modal window** (AT-SPI state bits MODAL=16 and SHOWING=25) on 2 looks in a
   row. Looks are 1 s apart, the first one at least 1 s after the app's latest link. It asks over its own separate
   connection with a 500 ms timeout. The holder exits after 30 s with nothing to hold.

**Consequences.**

- Every acting call opens a fresh D-Bus connection to the app.
- Reads never go on links. The modal dialog can be read at once on Ember's normal connection
  (action-link.test.ts:92-100).

**For Windows and macOS.** Nothing like links is needed. What is needed is the same guarantee: an action whose
handler opens a modal dialog (Save As, a message box, an Open panel) must not block the sidecar's request loop, must
answer within about 1 s, and must leave the dialog readable through the normal read path right away. See §14.

---

## 10. AT-SPI interfaces used, and suggested UIA and AX counterparts

| AT-SPI interface and calls | Used for | UIA (System.Windows.Automation) [platform note] | AX (ApplicationServices) [platform note] |
|---|---|---|---|
| **Action**: `nActions`, `getName(i)`, `doAction(i)` | `do_action`, `can_do`, option fallback | `InvokePattern.Invoke`, `TogglePattern.Toggle`, `SelectionItemPattern.Select`, `ExpandCollapsePattern`, `LegacyIAccessiblePattern.DoDefaultAction()`/`.DefaultAction` (the MSAA verb, useful for Chromium's "click ancestor"-style verbs). Name them in lower case (`"invoke"`, `"toggle"`, `"select"`, `"expand or contract"`, `"dodefault"`...) and keep `ACTION_ALIASES` semantics. | `AXUIElementCopyActionNames` / `AXUIElementPerformAction` (`AXPress`, `AXShowMenu`, `AXPick`, `AXConfirm`, `AXIncrement`/`AXDecrement`). Report e.g. `"press"`. |
| **EditableText**: `setTextContents`, `insertText(pos, text, len)` | `set_text`, `can_do("text")` | `ValuePattern.SetValue` (refuse when `ValuePattern.Current.IsReadOnly`). There is no insert primitive: for `insert` or `append`, set prefix + text + suffix computed from a **fully read, non-secret** value and caret, or answer `background_unavailable`. | Settable `AXValue` (`AXUIElementIsAttributeSettable`). For `insert`: set `AXSelectedText` (inserts at the caret when the selection is empty, but replaces a non-empty selection, unlike AT-SPI). For `append`: set `AXSelectedTextRange` to `{len,0}` then `AXSelectedText`, or set `AXValue` to old + new. |
| **Text**: `characterCount`, `caretOffset`, `getText(0, n)` | `set_text` offsets, `node_info.text` | `TextPattern.DocumentRange.GetText(2000)`, `TextPattern.GetSelection()` (degenerate range = caret; get the offset by comparing endpoints), or `ValuePattern.Value` | `AXValue`, `AXNumberOfCharacters`, `AXSelectedTextRange` |
| **Value**: `minimumValue`, `maximumValue`, `currentValue` (set) | `set_value`, `can_do("value")`, `node_info.value` | `RangeValuePattern` (`Minimum`, `Maximum`, `Value`, `SetValue`, `IsReadOnly`) | `AXValue` (number), `AXMinValue`, `AXMaxValue`, settable check |
| **Selection**: `isChildSelected`, `selectChild`, `clearSelection`, `nSelectedChildren`, `getSelectedChild` | option lists, combo `selected`, icons | `SelectionPattern.GetSelection()`, `SelectionItemPattern.Select/AddToSelection/RemoveFromSelection/IsSelected` | `AXSelectedChildren` (settable on `AXList`), `AXSelected` on children |
| **Table**: `nRows`, `nColumns`, `getAccessibleAt`, `getRowAtIndex`, `getSelectedRows`, `addRowSelection`, `removeRowSelection` | row lists | `GridPattern` (`RowCount`, `ColumnCount`, `GetItem`), `GridItemPattern.Row`, `SelectionItemPattern` on the row items | `AXRows`, `AXColumns`, `AXSelectedRows` (settable), `AXIndex` on `AXRow`, `AXCellForColumnAndRow` |
| **Component**: `getExtents(SCREEN)`, `grabFocus` | `bounds`, mouse spot, `choose_row`/`choose_item`/`focus` | `BoundingRectangle`. `SetFocus()` **brings the window to the front**: call it only where the Python calls `GrabFocus` (active window only). | `AXPosition` + `AXSize`; set `AXFocused` to true |
| **States** | `usable`, `ElementInfo.states` | `IsEnabled` → `enabled` + `sensitive`; `!IsOffscreen` → `showing`; `HasKeyboardFocus` → `focused`; `IsKeyboardFocusable` → `focusable`; `ToggleState.On` → `checked` (and `pressed` for toggle buttons); `SelectionItem.IsSelected` → `selected` (and `checked` for radio buttons); `ExpandCollapseState` → `expanded`/`collapsed`; `IsPassword` → role `password text`; window `active` when its HWND root is `GetForegroundWindow()`'s | `AXEnabled`; `AXFocused`; `AXValue` 1 on a check box or radio button → `checked`; `AXSelected`; `AXExpanded`; `AXSubrole == AXSecureTextField` → `password text`; window `active` when the app is frontmost and the window is `AXMainWindow`/`AXFocusedWindow` |
| Relations (`LABELLED_BY`), attributes (`placeholder-text`, `Formula`, `explicit-name`) | `is_secret`, `named_from_contents` | `LabeledBy`, `HelpText` (Chromium maps the placeholder there) | `AXTitleUIElement`, `AXPlaceholderValue` |

---

## 11. Time budgets (all must fit in the client's 5 s)

| Name | Value | Where |
|---|---|---|
| libatspi call timeout | 800 ms (startup 1000 ms) | `CALL_TIMEOUT_MS` 53, `configure_atspi` 4594 |
| A call slower than this counts as busy | 0.7 s | `SLOW_APP_S` 58 |
| Link call timeout | 800 ms | `LINK_TIMEOUT_MS` 4250 |
| Holder handshake | 2.0 s | `HOLDER_START_S` 4253 |
| `settle()` | 80 ms per change | 2809 |
| Naming rows for `list_options` | 1.5 s | `LIST_ROWS_S` 2990 |
| Finding a row / checking for twins | 2.0 s / 2.5 s from the start | `FIND_ROW_S`, `TWIN_ROWS_S` |
| Rows considered at most | 5000 | `ROWS_MAX` 2986 |
| Children considered for options / combo `selected` | 500 | 3603, 2769 |
| Ancestors searched for a click handler | 64 | `HANDLER_LEVELS` 2914 |
| Withheld-name check | 0.4 s | `CONTENTS_S` 480 (used by `withheld_name`) |
| TS client timeout per request | 5000 ms | sidecar.ts:311 |
| TS toggle verification | 1000 ms, every 100 ms | `TOGGLE_WAIT_MS` worker.ts:180 |

---

## 12. Behaviours the tests pin down (port each one)

The Python tests run on in-process stand-ins (`Acc`, `States`, `Text`, a fake `pyatspi` module) without a display.
**Recommendation:** structure the UIA and AX sidecars so the acting logic runs against an abstract element interface
(role, name, states, bounds, children, parent, actions, patterns). The same scenarios can then run with stand-ins on
any OS, plus a few live integration tests.

### 12.1 `Acting` class (test_ember_atspi.py:1051-1767)

1. **refuses_disabled_hidden_and_gone_elements** (1060). For `do_action`, `set_text`, `select_option` and
   `set_value`, the error message contains `disabled` (no sensitive or enabled state), `no longer on screen` (no
   showing state) or `gone` (no states at all).
2. **clicks_usable_elements** (1070). `do_action` calls `doAction(0)` once and returns `ok: true`.
3. **no_text_into_secret_fields** (1083). `set_text` into an `entry` named "Card number" raises PermissionError.
4. **an_option_by_its_full_name_only** (1094). The partial name "permanently" raises ValueError, the message doesn't
   include the option names, and nothing is chosen. "Keep" chooses index 0. "delete permanently" (wrong case)
   chooses "Delete permanently" and `option` returns the exact name.
5. **a_click_that_closes_its_dialog_is_done** (1109). The element disappears during the action, and the result is
   `ok: true, after: null, gone: true`.
6. **a_busy_app_is_busy_not_gone** (1129). A slow state read failing with "Did not receive a reply" makes the error
   exactly `BUSY`, both for `do_action` and for `read_element`, never libatspi's text.
7. **check_boxes_radio_buttons_and_switches_in_chromium_and_firefox** (1168):
   - Toggling picks `check`, then `uncheck`, then `check` for a click, as the state changes.
   - A one-way action that would change nothing raises `background_unavailable` and is not performed.
   - Firefox's radio `select` works once; the second time it raises.
   - An ARIA switch's `doDefault` returns `action: "dodefault"` (lower case) and `after.states` contains `checked`.
8. **whether_an_action_can_be_done_is_told_without_doing_it** (1196):
   - Returns the exact shape `{"tier1": true, "action": "check"}` and performs nothing.
   - With only showContextMenu: `tier1: false` and `why` contains `no 'toggle' action`.
   - An entry without EditableText, with `caret`, returns the exact shape
     `{"tier1": false, "why": "this element's text can't be edited directly", "focused": false, "windowActive": true}`.
   - A slider without Value: `kind: "value"` gives `tier1: false`.
9. **a_click_handed_to_the_control_around_it_names_that_control** (1213):
   - `clickAncestor` gives the nearest acting ancestor (`link "Delete my account"`).
   - A list item without actions is passed over for an acting `section`.
   - With nothing acting up to the page, there is no handler.
   - A control's own action gives no handler, and neither does an ARIA switch's `doDefault`.
   - A GTK label inside a list item: `tier1: false` with `handler: {"role":"list item","name":""}`. The row itself has
     no handler.
10. **a_page_tab_takes_clicks_on_its_tab_only** (1245). On the mouse path, a page tab ancestor counts only if it
    covers the spot, and a page tab with no position is never taken. A list row inside the page still takes its
    label's click. In Chromium, a tab's text uses `clickAncestor` and gives `{"role":"page tab","name":"Billing"}`.
11. **a_click_on_a_row_of_a_list_selects_it_and_never_opens_it** (1354):
    - `can_do` returns `{"tier1": true, "action": "select row"}`.
    - `do_action` gives `ok`, `"select row"`, the selection `[5]`, and no row activated.
    - In a multi-select list the other rows are unselected.
    - A row already selected gives `ok`.
    - A list that won't select raises `background_unavailable` and nothing is activated.
    - A cell with no Table around it gives `tier1: false`.
12. **a_row_of_a_list_is_chosen_by_its_cells_words** (1382):
    - `list_options` returns the names taken from the nested cell.
    - `select_option("budget.csv")` selects row 1 and `after.selected == "budget.csv"`.
    - Two rows with the same name raise ValueError and leave the selection unchanged.
    - `row_list(Sheet)` is None.
13. **a_row_is_chosen_with_the_lists_cursor_as_a_click_chooses_it** (1400):
    - In the active window, GrabFocus moves the cursor and the selection together (grabs `[5]`).
    - `select_option` works in a multi-select list.
    - A row that is selected and has the cursor returns `already: true` with no grab. A row selected without the
      cursor is grabbed again.
    - Cells that refuse focus fall back to Table selection, and the cursor stays where it was.
    - In an inactive window: `can_do` returns `tier1: false`, `action: "select row"`, and `why` contains "isn't the
      active one"; `do_action` raises `background_unavailable`; `select_option` raises "click a cell of that row
      instead" without the prefix and touches nothing.
    - The row already selected in an inactive window returns `already: true`, and `can_do` gives `tier1: true` for it.
14. **a_check_box_in_a_list_is_ticked_by_the_mouse_and_never_opens_its_row** (1446):
    - A GTK toggle cell, for both click and toggle: `tier1: false`, `action: "toggle"`, `why` contains "ticked only
      by a click on it", no handler, and `do_action` raises `background_unavailable`.
    - A toggle on the row's name cell: `can_do` returns `{"tier1": true, "action": "select row"}`, and `do_action`
      raises "no switch or check box" (without the prefix). Nothing is activated.
    - A Qt cell whose only action is "toggle" is left alone.
15. **a_click_on_an_icon_selects_it_and_never_opens_it** (1525):
    - `select item` sets the chosen icon and the cursor.
    - A toggle on an icon is refused.
    - In an inactive window: `tier1: false` and `background_unavailable`.
    - A grid that won't select raises `background_unavailable`.
    - Nothing is ever opened.
16. **a_cells_formula_is_read_where_asked** (1558). `read_element` returns `formula` only when asked: from a
    list-style attribute ("Formula:1/0"), from a dict, or not at all.
17. **a_long_list_is_looked_through_in_time** (1571), with 3000 rows at 0.5 ms each:
    - `list_options` finishes in under 0.6 s, the options are a prefix of the names, and `left` is the rest.
    - Rows are named with fewer than 2n+4 cells made.
    - `select_option` finds the first match and `0 < unchecked < 2996`.
    - A row too far down raises "type the name instead" and the selection is unchanged.
    - A short list is checked all the way: "several rows" for a duplicate, and no `unchecked` or `left` key.
18. **unnamed_options_are_named_by_the_label_inside** (1611). A GTK ListBox's rows are named from the label inside,
    and `select_option("Deutsch")` calls `selectChild(2)`.
19. **options_never_say_what_a_secret_field_holds** (1625):
    - Options and row names that contain secret values become `""` in place.
    - `node_info(table).selected` is given by another cell of the row ("11 bytes").
    - A `WITHHELD` key stays withheld.
    - `cell_words` of a cell holding a secret entry is `""`.
    - `list_options` on a secret combo box raises PermissionError.
20. **a_click_handed_on_further_than_ember_looks_is_unknown** (1659):
    - A handler 14 levels up is found.
    - A handler more than `HANDLER_LEVELS` up gives `handlerUnknown: true` and no `handler`.
    - With nothing acting up to the document: exactly `{"tier1": true, "action": "dodefault"}`.
21. **a_drop_down_in_a_web_page_or_electron_app** (1717), for Chromium's `<select>`:
    - Options are listed from the child menu.
    - `read_element.selected` is "Travel".
    - `select_option("meals")` returns `ok`, `option` "Meals" and `after.selected` "Meals", through the "select"
      fallback.
    - An option that won't take the choice gives `ok: false` with `selected` unchanged.
    - The option already chosen gives `ok: true` and performs no action.
    - An option that only clears the choice gives `ok: false`, the previous option is chosen again, and the actions
      done are `["Meals", "Travel"]`.
22. **an_open_menu** (1740). `read_element.open` is false, then true once the items show. Non-menus have no `open`
    key.
23. **a_menu_item_whose_menu_closed_is_offscreen** (1749). `offscreen: true` when the item no longer shows. A failed
    state read gives `states: []` and no `offscreen`. Non-menu-items never have it.

### 12.2 Other tests that cover acting

- `Secrets` (253-367):
  - Keys handed over through `remember_secrets` make `refuse_secret` raise, and junk entries are ignored (279).
  - `mark_secret` returns `[[bus, path]]` for known ids, ignores unknown ids, and `refuse_secret` then raises (287).
  - A password field stays secret after "Show password", and `node_info` has `secret` and no `text` (296).
  - Buttons and documents are never judged secret by their name (308).
- `Windows` class:
  - The handler comes back as `{"role":"section","name":""}` when the ancestor's name is withheld (2153).
  - `refuse_secret` raises on a combo box judged secret by the label beside it (2203).
  - `read_element.selected == ""` and `list_options == ["", "Bank transfer"]` when the chosen option repeats a
    secret value (2418-2420). Withheld text stays withheld after `remember_secrets` in a fresh helper (2423-2426).
- `Ids` (1007-1049): ids continue from `EMBER_ATSPI_ID_BASE`, otherwise from a random 2^20-aligned base below 2^53;
  another process's ids are "no longer known"; quick looks never push out kept reads; 8 kept reads.
- `Protocol` (2879-2909): UTF-8 under `LANG=C`, stdout stays clean while libraries print, NaN becomes an error,
  unknown methods give an error, and `ping` works without pyatspi while other methods say it isn't installed.
- `Links` (2912-2987): the modal-and-showing bit test; a stand-in falls back to libatspi; the holder keeps a link
  until the app dies, even after the sidecar is gone, and then exits; a link closed by the app is let go. These are
  Linux-only and need no port.

### 12.3 TS integration tests against a real GTK app (they show the behaviour expected on each OS)

- `perception.test.ts:124-194`:
  - `canDo(row cell, "click").action === "select row"`.
  - `doAction` returns `ok` and `after.states` contains `selected`.
  - No row-activated event fires, and the selection becomes exactly that row.
  - `listOptions(table)` lists the rows; `selectOption(table, "budget.csv").after.selected` is "budget.csv".
  - `listOptions(list box)` gives `["English","Deutsch"]` and `selectOption` returns `ok`.
- `perception.test.ts:196-267`:
  - A toggle cell: `[tier1, action] == [false, "toggle"]` and `doAction` rejects with `background_unavailable`.
  - A toggle on the name cell rejects with "no switch or check box".
  - An icon gives `action: "select item"` and, where `tier1` is true, only a selection-changed event.
  - Nothing is ever activated, toggled or opened.
- `action-link.test.ts`:
  - Clicking "Attach…" (which runs a modal `FileChooserDialog`) returns `ok` right away.
  - The dialog can be read at once and isn't busy.
  - Keys typed into it arrive and the app keeps ticking.
  - Clicking Cancel closes it, and keys reach the window behind.

  **Write the equivalent test for each OS**: a button whose handler runs a modal dialog (Win32 `DialogBox`, WinForms
  `ShowDialog`, `MessageBox`; Cocoa `runModal`, `NSOpenPanel`). It must return quickly, the dialog must be readable,
  and the sidecar must stay responsive.

---

## 13. Quirks and surprises

1. **`focus` is dead protocol.** It is in `METHODS`, but there is no TS wrapper and no caller.
2. **`ActionResult.before`, `.option`, `.gone` and `.already` are never read by the TS side.** It reads `ok`,
   `action` (only "select row" and "select item"), `after`, `busy` and `unchecked`. `already` isn't even in the TS
   type.
3. **`ok` is the app's own answer**, not a checked result. `set_value` always returns `ok: true`. The TS side does the
   checking (toggles, text).
4. **`can_do` and `list_options` skip `usable`.** `can_do` can report `tier1: true` for a disabled element, and for a
   password field with `kind: "text"`.
5. **An absent `CanDo.action` means something.** With `tier1: false` it makes the click "selects only" in the
   policy. Never fill in a default action name.
6. **`CanDo.action === "toggle"` with `tier1: false`** tells the TS side the mouse click will *flip* the box. Don't
   return it for anything else.
7. **Not every refusal is `background_unavailable`.** Disabled, hidden or gone elements, "no switch or check box",
   choosing a row by name in a background window, and secret fields are plain errors on purpose, so the TS side does
   not borrow the mouse.
8. **Background windows.** Selecting a row or icon by accessibility is allowed only in the *active* window, because
   `grabFocus` raises the window. In a background window the answer is `background_unavailable`, which borrows the
   mouse for a click and fails for `select_option`. UIA `SetFocus` raises windows too, so keep the rule on Windows.
9. **Double-click actions.** GTK's cell and icon `activate` is a double click. On Windows the same trap exists:
   UIA `Invoke` on Explorer and file-dialog `ListItem`s opens the item. Substitute `SelectionItem.Select()` for a
   click on a row or icon, and report `"select row"` or `"select item"`.
10. **Option indexes are positional.** `""` stands in for secret or withheld options, and `select_option` rebuilds
    the list and chooses by index.
11. **Secret keys must survive a restart.** The TS side re-sends them to every new process. A key that changes
    between processes silently weakens refusal for fields that "Show password" revealed.
12. **The InsertText length is probably counted in the wrong unit** (§4.3). Insert or append with non-ASCII text
    likely truncates on GTK.
13. Error strings come from Python exceptions. `KeyError` messages arrive wrapped in quotes (`'element N is no
    longer known; read the window again'`). The TS side never parses these exactly. It looks only for the
    substrings `background_unavailable`, `did not answer`, `busy`, `did not receive a reply`, `timeout was reached`
    and `check box in a list`.
14. `select_option` on a row list returns `after` for the **list** (its `selected` is the row's words). `do_action`
    on a cell returns `after` for the **cell** (`states` contains `selected`).
15. A click on an already checked radio button that offers only a one-way `select` raises `background_unavailable`,
    and the TS side escalates it to a mouse click. This is harmless, but a port that answers `tier1: true` there
    changes the behaviour.

---

## 14. Porting guidance [platform note]

**Keep the protocol identical.** Use the same method names, params, result keys, state and role vocabulary, error
prefixes and 2000-character text cap. The TS client should only need to change how it spawns the process. Today it
runs `spawn(this.python, [this.script])` with a `pickPython()` default and a stderr filter for dconf and GTK warnings
(sidecar.ts:211-226). Make the command and arguments a platform parameter:

- Windows: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ember_uia.ps1`.
- macOS: `process.execPath ember_ax.js` with `ELECTRON_RUN_AS_NODE=1`.

**Never block the request loop on an action (the modal-dialog rule):**

- **Windows.** `InvokePattern.Invoke()` (and `Toggle` or `Select` on some providers) can block until a modal dialog
  the handler opened is closed. This happens with Win32 buttons, where the proxy's BM_CLICK is effectively
  synchronous, and with WinForms `ShowDialog`/`MessageBox`. The managed `System.Windows.Automation` client has no
  per-call timeout.
  - Run every state-changing call on its own background thread and wait for it for about 800 ms.
  - On timeout, answer with the same message as Linux, `"the app did not answer in time (it may still do it)"`. The
    TS side then says "unknown whether this happened; perceive again". Leave the thread running.
  - Don't serialize later requests behind it. In particular, don't use one shared worker thread for app calls.
  - Wrap reads in the same deadline, and answer `BUSY` (the exact Linux string) when a read times out.
  - Reads of the new modal dialog must work at once, on other threads.
- **macOS.** `AXUIElementPerformAction(kAXPressAction)` waits for the app's reply. A press whose handler runs
  `runModal`/`NSAlert` (or AppleScript-style dialogs) delays the reply until the messaging timeout (about 6 s by
  default, which is longer than the client's 5 s). Koffi FFI calls are synchronous and block Node's event loop.
  - Call `AXUIElementSetMessagingTimeout` on the system-wide element and on each app element, with about 0.8 s.
  - Map `kAXErrorCannotComplete` after an action to the same "may still do it" error.
  - Map `kAXErrorCannotComplete` or a timeout during a read to `BUSY`.
  - Map `kAXErrorInvalidUIElement` to "gone". After an action that counts as `{after: null, gone: true}`.

**State and role mapping** (§10): emit `enabled` and `sensitive` for enabled elements, `showing` when on screen,
`checked` for toggled-on controls and selected radio buttons, `focused`, `editable`, and `active` on the top-level
window. Map password fields to `password text` (UIA `IsPassword`; AX subrole `AXSecureTextField`). Never read their
value.

**Secret keys:**

- Windows: `[String(pid), RuntimeId.join(".")]`. The RuntimeId is stable for the element's lifetime.
- macOS: no public stable id exists. Options are `[String(pid), CFHash(AXUIElementRef)]` (check that it is stable
  across client processes) or a role and index path from the window. Test that `remember_secrets` really carries
  across a restart.

**Text modes:**

- `replace`: `ValuePattern.SetValue` on Windows; `AXValue` on macOS.
- `insert`: needs the caret.
  - Windows: from `TextPattern.GetSelection()`. Compose the new value only when the current value was read in full,
    then `SetValue`. Otherwise answer `background_unavailable` (the TS side borrows the mouse only if the field
    already has focus and is typable).
  - macOS: set `AXSelectedText`. Check the selection is empty first, or note the semantic difference.
- `append`: the same, using the full length. Note that on Windows `SetValue` on a Win32 multi-line edit (WM_SETTEXT)
  may not send `EN_CHANGE`.

**Combo boxes:**

- Windows: a Win32 ComboBox exposes `ListItem`s with `SelectionItem` even when collapsed. WPF and UWP combo boxes
  may create their items only once expanded; `ExpandCollapse.Expand()` is visible but uses no cursor.
- macOS: an `AXPopUpButton`'s menu items often exist only after `AXPress`/`AXShowMenu` opens the menu. Choosing an
  option is then open, press the `AXMenuItem`, and check `AXValue`. Report `ok` from the value read back.

**Tables and lists:**

- Windows: `GridPattern` for row lists; `SelectionItem.Select()` for a row (single select, replacing the selection).
  Check that the focus item (the "cursor" that Enter follows) moves too. If it doesn't, apply the active-window rule
  and treat it like GTK's cursor.
- macOS: set `AXSelectedRows` on `AXTable`/`AXOutline`.

**Chromium on Windows and macOS** exposes setting a value on `<input>` (UIA `ValuePattern`, AX `AXValue`). Typing
into Electron or Chrome fields will often be tier 1 there, where Linux always borrows the mouse. That is fine, but
`contenteditable` areas still lack it. For a click handed to an ancestor, check whether `LegacyIAccessible.DefaultAction`
(Windows) or the action list (macOS) tells "click ancestor" apart from a control's own action. If it can't, the
handler search falls back to the mouse-path rule (§5.3).
