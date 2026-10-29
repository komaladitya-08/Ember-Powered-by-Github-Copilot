# Ember accessibility sidecar protocol: the reading side

What this covers: the newline-delimited JSON-RPC protocol between Ember's main process
(`app/main/perception/sidecar.ts`, class `AtspiSidecar`) and the Python AT-SPI sidecar
(`sidecar/atspi/ember_atspi.py`, 4662 lines). It specifies the **reading** methods: `ping`, `status`,
`list_windows`, `read_window`, `remember_secrets`, `mark_secret`, `shell_overlays`, `secret_fields`,
`read_element` and `at_point`. The action methods (`can_do`, `do_action`, `set_text`, `set_value`,
`select_option`, `list_options`, `focus`) are mentioned only where reading depends on them.

A Windows UI Automation sidecar (UIA) and a macOS AX sidecar must speak this same protocol, so the TS
core keeps working unchanged. Everything here comes from reading the code at commit `b67b02e`.
Line references are `py:N` for `sidecar/atspi/ember_atspi.py` and `ts:N` for
`app/main/perception/sidecar.ts`, unless another file is named. Sections marked **[port note]** are
recommendations, not current behaviour.

---

## 0. Contents

1. Process model and wire framing
2. Errors on the wire, and what the TS side matches
3. Shared data shapes
4. Element ids: allocation, lifetime, `keep`
5. Time budgets, timeouts, and busy or hung apps
6. Methods, one by one
7. How the walk works (read_window): hidden nodes, truncation, long lists, grids
8. Secret fields and withheld names
9. Labels for unnamed controls
10. HiDPI and coordinate units
11. Vocabulary: roles, states and action names
12. Port notes: suggested UIA and AX mappings
13. Risks and surprises

---

## 1. Process model and wire framing

### 1.1 How the TS client starts the sidecar (`AtspiSidecar.ensure`, ts:213-246)

- A process is started **on demand**, by the first `request()` after there is no live helper. There is
  no explicit start call and no handshake.
- Command: `spawn(this.python, [this.script], { stdio: ["pipe","pipe","pipe"], env })` (ts:217).
  - `python` comes from `pickPython()` (ts:170-174): `$EMBER_PYTHON`, else `/usr/libexec/platform-python`
    if it exists, else `python3`.
  - `script` is `resources/sidecar/atspi/ember_atspi.py` in packaged builds and `<appPath>/sidecar/atspi/ember_atspi.py`
    in development (`app/main/main.ts:801-803`).
  - The constructor is `new AtspiSidecar(script, log, python = pickPython(), env = process.env)` (ts:211).
    The desk passes its own env, with a separate display and accessibility bus
    (`app/main/desk/place.ts:210`). The user's display uses `process.env` (`app/main/main.ts:1167`).
- Environment: `{ ...env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", EMBER_ATSPI_ID_BASE: String(++idBlocks * ID_BLOCK) }`
  (ts:219). `ID_BLOCK = 10_000_000` (ts:181). `idBlocks` is **module-global**, so every helper process
  of every `AtspiSidecar` instance (user display, desk, and each restart) gets a new block: 10 000 000,
  20 000 000, 30 000 000, and so on.
- The sidecar sets `NO_AT_BRIDGE=1` for itself unless it is already set (`os.environ.setdefault`,
  py:4658), so its own process never joins the bus as an app.

### 1.2 Framing

- **Request**, one per line on the sidecar's stdin:
  `{"jsonrpc":"2.0","id":<int>,"method":"<name>","params":{...}}\n` (ts:323). `params` is always an
  object (default `{}`). Ids come from `this.nextId++`, start at 1 per `AtspiSidecar` instance, and keep
  counting across restarts.
- **Response**, one per line on stdout: `{"jsonrpc": "2.0", "id": <same id>, "result": <value>}`, or
  `{"jsonrpc": "2.0", "id": <id|null>, "error": {"message": "<str>", "detail": "<traceback, limit 3>"}}`
  (`handle`, py:4625-4638).
- Python writes JSON with `json.dumps(resp, allow_nan=False)` (py:4619). The default `ensure_ascii=True`
  means **every non-ASCII character is escaped `\uXXXX`**, so a line never holds a raw newline or
  non-ASCII byte.
- If a value can't be encoded (NaN, Infinity, a non-serialisable type), **the whole answer becomes an
  error**: `{"jsonrpc":"2.0","id":<id>,"error":{"message":"the answer could not be encoded: <exc>"}}` (py:4616-4622).
  `value_of` drops non-finite values before that can happen (py:254-260).
- Strictly sequential: `main()` reads a line, handles it to completion, then writes one line and flushes
  (py:4641-4653). Blank lines are skipped. At EOF on stdin the sidecar exits. Requests are never
  answered concurrently or out of order, and there is no cancellation.
- Input is decoded as UTF-8 with `errors="replace"`, whatever the locale (`protocol_streams`, py:4607-4613).
- **stdout stays clean**: `protocol_streams` dups the real stdout for the protocol and points fd 1 at
  stderr, so libraries printing to stdout land on stderr (py:4610-4611).
- A line that isn't JSON gets an error answer with `id: null` (handle's `req_id` stays None). The TS
  side ignores answers without a numeric id, so **the request then times out** (5 s) and the helper is
  killed.

### 1.3 How the TS client reads answers (`answer`, ts:260-277)

- stdout is read with `readline`. A line that fails `JSON.parse` is logged as
  `sidecar.bad_line {bytes, start?}`, where `start` (the first 120 characters) is logged only when the
  line doesn't start with `{`, since screen text could be in it. The line is then dropped.
- `id` must be a number. If it is, `h.answered = true` (the helper "works"), **even when no request is
  pending for that id**.
- An answer for an unknown id is ignored (for example the `remember_secrets` preamble, §1.5).
- `msg.error` present → the promise rejects with `new Error(msg.error.message)`. Only `message` is used:
  there is **no error code**, and `detail` is ignored.

### 1.4 stderr

Each stderr line is logged at debug as `sidecar.stderr {line: first 300 chars}`, except lines matching
`/dconf-WARNING|Gtk-WARNING/` (ts:224-226). Nothing in the protocol uses stderr. The sidecar writes
`ember_atspi: could not shorten libatspi timeouts` there when `configure_atspi()` fails (py:4643-4644).

### 1.5 Startup preamble: secrets carried across processes (ts:240-244)

If the client knows any secret-field keys or withheld-name keys from earlier processes, the **first line
written to a new process** is
`{"jsonrpc":"2.0","id":<nextId++>,"method":"remember_secrets","params":{"keys":[[bus,path],...], "withheld":[[bus,path],...]?}}`.
No pending entry is registered for it, so its answer is ignored, though it still sets `answered`. The
`withheld` field is present only when non-empty. The real request follows on the next line.

### 1.6 Timeouts, retiring and reviving (ts:279-325)

- `request(method, params = {}, timeoutMs = 5000)` (ts:311). **No caller passes another timeout**:
  every method gets 5000 ms, measured **from when the request is written**. Queued requests share that
  clock, and the sidecar answers one at a time, so time spent waiting behind other requests counts too.
- On timeout: the promise rejects with `accessibility helper did not answer <method> in <ms> ms`, the
  client logs `sidecar.timeout`, and calls `retire(h, "accessibility helper was restarted (an earlier request took too long)", "SIGKILL")`.
  Every other pending request rejects at once with that message (ts:315-321).
- On process `exit`: `retire(h, "accessibility helper stopped")`. On spawn `error`:
  `retire(h, "accessibility helper could not run (<err.message>)", "SIGKILL")`. On a stdin `error`
  (EPIPE): `retire(h, "accessibility helper stopped", "SIGKILL")` (ts:227-239).
- `retire` (ts:283-291) marks the helper done, kills it if asked, and rejects all pending requests. If
  the helper was current **and had answered something**, it calls `revive()`.
- `revive` (ts:300-309): on the next tick, unless `stop()` was called or a helper already exists, it
  starts a new process and sends `status`. The reason (comment at ts:294-298): LibreOffice 24.2 aborts if
  a client that read it leaves, a document is then opened with no client connected, and a new client lists
  the desktop. So one client must stay connected. A helper that never answered isn't restarted over and over.
- `stop()` (ts:449-452): sets `stopped`, then SIGTERMs the helper and rejects its pending requests.
  Called on app quit (`main.ts:1168`) and when the desk closes (`place.ts:219,240`).
- **State lost on a kill**: the client re-sends only SECRETS and WITHHELD keys (§1.5). Everything else in
  the sidecar's memory starts over: element ids (all previous ids become unknown), the hung and busy
  tables, the known windows, the spreadsheet cursors, and the per-app secret values.

### 1.7 Holder subprocess (action side only)

`ember_atspi.py --hold <fd>` runs the "link holder" (py:4659-4660, `hold_main` py:4446). It is started
by actions with `start_new_session=True` and never by reads. A port does not need it unless its action
backend has the same modal-dialog hang problem.

---

## 2. Errors on the wire, and what the TS side matches

### 2.1 Error object

`{"message": str(e), "detail": traceback.format_exc(limit=3)}`. There is no `code`. **Python `KeyError`
messages carry literal single quotes**, because `str(KeyError("x")) == "'x'"`:

| Raised by | Exception | Wire `message` (exact) |
|---|---|---|
| unknown method (py:4630-4632) | KeyError | `'unknown method: <name>'` (quotes included) |
| pyatspi missing, any method but `ping` (py:4633-4634) | RuntimeError | `python3-pyatspi is not installed` |
| `SNAPSHOTS.get(id)` for an id that isn't kept (py:819) | KeyError | `'element <id> is no longer known; read the window again'` (quotes included) |
| `params["id"]` missing (read_element) | KeyError | `'id'` |
| `params["x"]`/`["y"]` missing (at_point) | KeyError | `'x'` / `'y'` |
| `node_info`: element defunct, or a failed call that wasn't a timeout (py:2735, 2727) | ElementGone (RuntimeError) | `element <id> is gone (the window changed); read the window again` (`<id>` is empty when unknown, which leaves a double space) |
| `node_info`: a failed call taking more than 0.7 s, or libatspi saying `did not receive a reply` / `timeout was reached` (py:2722-2727) | RuntimeError | `the app is busy (it didn't answer in time); try again in a moment` (constant `BUSY`, py:2715) |
| encode failure (py:4621) | (synthesised) | `the answer could not be encoded: <exc>` |

The TS client adds its own messages (§1.6): `accessibility helper did not answer <m> in <ms> ms`,
`accessibility helper was restarted (an earlier request took too long)`, `accessibility helper stopped`,
`accessibility helper could not run (<msg>)`.

### 2.2 What callers match

- `isBusy` in `app/main/agent/worker.ts:415` uses
  `/\bbusy\b|did not (receive a reply|answer)|timeout was reached/i`. It matches the sidecar's `BUSY`
  text, the client's own timeout text (`did not answer`), and an action's
  `the app did not answer in time (it may still do it)` (py:4434). **A port must keep the word "busy" in
  its busy errors, or "did not answer".**
- `worker.ts:1761` uses `/did not answer/` for actions, and `worker.ts:1649,1750` look for
  `background_unavailable` (action side; `list_options` raises it too, via `option_items` py:3601).
- Most `readElement` callers do `.catch(() => null)` and treat null as "gone". Some tell busy from gone
  with `isBusy(err)` (worker.ts:1336, 1505).
- `Perception.unreadSecrets` turns any `secret_fields` error into "no screenshot" (index.ts:518-525).
  `Perception.shellOverlays` turns an error into "no overlays" (index.ts:532-539): best effort, see §6.7.
- `test/unit/perception-sidecar.test.ts` pins the client's messages: `/stopped/`, `/did not answer hang in 200 ms/`,
  `/restarted/`, `/could not run|stopped/`.

### 2.3 Not errors

These are results, not errors: a window not found (`read_window` gives `window: null`, `at_point` gives
`found: false`), a blocked window (`blocked: true`), a busy app (`busy: true`), unknown ids in
`mark_secret` (skipped), and malformed keys in `remember_secrets` (skipped).

---

## 3. Shared data shapes

TS declarations are at ts:16-160. Python builds the same shapes.

```ts
Bounds        { x: number; y: number; width: number; height: number }   // ints, screen coords in the app's units (§10)
AxNode        { id: number; parent: number | null; depth: number; role: string; name: string; states: string[];
                bounds: Bounds | null; actions?: string[]; text?: string; selection?: string; selected?: string;
                value?: number; editable?: boolean; secret?: boolean; withheld?: boolean; shown?: Bounds;
                grid?: boolean; size?: { rows: number; columns: number } }
AxWindow      { app: string; pid: number | null; path?: string; name: string; role: string; active: boolean;
                bounds: Bounds | null; busy?: boolean }
OtherWindow   { name: string; role: string; active: boolean; modal: boolean }
ElementInfo   { role; name; states; bounds; text?; value?; selected?; secret?; withheld?; shown?; open?; offscreen?; formula? }
PointElement  { role: string; name: string; bounds: Bounds | null; secret?: boolean; empty?: boolean }
SecretKey     [string, string]   // [app bus name, object path] — opaque to TS, keyed as `${k[0]} ${k[1]}`
```

### 3.1 Bounds rules

- `bounds_of` (py:191-195) returns `null` when x or y is `INT_MIN` (-2147483648, GTK's "no position") or
  when width or height is negative. Otherwise all four are integers as the toolkit reports them, in
  `DESKTOP_COORDS`/`SCREEN` coordinates. x and y may be negative (multi-monitor).
- Reads (`walk`) **never list an element with a 0×0 or zero-width/height box**. `bounds: null` (unknown)
  is listed. Spreadsheet cells need a positive size and must overlap the clip (`in_view`, py:1024-1027).
- `read_element` reports any bounds, including 0×0.

### 3.2 Element keys (`object_key`, py:302-308)

`(acc.app.bus_name or "", acc.path)`: the D-Bus unique name of the app's connection (":1.42") and the
object path ("/org/a11y/atspi/accessible/5"). They go on the wire as 2-element arrays. TS stores them
opaquely (ts:249-258), keeps at most 4096 per kind, and hands them to every new process (§1.5).
**Requirement for a port:** two strings that identify the same element across sidecar restarts, for as
long as the element lives in its app.

---

## 4. Element ids: allocation, lifetime, `keep`

### 4.1 Allocation

- `first_id(env)` (py:758-768): `base = int(EMBER_ATSPI_ID_BASE)`. If it is missing, not an int, ≤ 0, or
  > 2^50, then `base = random.randint(1, 2**20) << 20`. The first id is `base + 1`. Ids then go up by 1
  for every element given an id (`Snapshots.add`, py:803-811). **They are never reused within a process.**
- Ids are unique across processes because each process gets its own 10 000 000 block (§1.1). Nothing
  checks a block for overflow: a process that hands out more than 10 M ids would run into the next block.
  A full read hands out roughly 400–800 ids, so that takes about 12 500 or more reads.
- Ids are JSON integers and stay below 2^53.

### 4.2 Lifetime (`Snapshots`, py:771-823)

- `Snapshots.KEEP = 8` kept reads, plus **one scratch read**.
- `begin(keep=True)` (py:789-797): a kept read appends a new dict and drops the oldest past 8. A quick
  look (`keep=False`) replaces the scratch dict. Only `read_window` calls `begin`, and only after the
  window is found and isn't blocked (py:2260).
- `end()` (py:799-801): `current` goes back to the newest kept read. `read_window` calls it at the end
  (py:2317). **Ids handed out later go to the newest kept read**: `secret_fields`' ids (py:2518), and
  `add()` with no current read calls `begin()` itself.
- `get(id)` (py:813-819): looks through the kept reads newest first, then the scratch read. Otherwise
  it raises KeyError (§2.1).
- Ids of nodes dropped as "inside a secret field" after the walk are **deleted** from the read
  (`latest.pop(nid)`, py:2293-2294): they can't be used by id either.
- Spreadsheet cells are stored as `SheetCell(acc, table, row, col)` (py:826-850). Using one by id asks
  the sheet for the cell at (row, col) again (`live`, py:842-850), because LibreOffice drops a cell's
  accessible after about 15 s.
- `secret_fields` hands out **new ids on every call**, even for the same fields (py:2518).

### 4.3 `keep: false` (quick looks)

`read_window({..., keep: false})` is "what has the keyboard before a key is pressed". Its ids live in the
scratch slot until the next quick look, so quick looks never push out the reads a worker acts on. On the
TS side:

- `readWindow` calls `newQuickLook()` after a `keep: false` read (ts:377), which forgets the HiDPI
  scales of the previous quick look's ids (ts:344-347).
- `scaleElements(ids, k, keep)` keeps the scale of **16** kept groups (ts:338-340), twice the sidecar's 8.
- Callers of `keep: false`: `worker.ts:2472, 2491, 2522, 2558, 2582, 2610, 2750`, all through
  `Perception.read(..., { keep: false, cells? })` (`perception/index.ts:116,127`).

### 4.4 Invariants a port must keep

1. An id from a read stays valid for at least the next 7 kept reads, plus any number of quick looks.
2. An id from another process, or from before a restart, is never valid: the error is "no longer known".
3. Ids are positive integers, unique per process, and different between processes.

---

## 5. Time budgets, timeouts, and busy or hung apps

### 5.1 Constants

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `CALL_TIMEOUT_MS` | 800 | py:53 | libatspi timeout per call (`Atspi.set_timeout`, py:4601) |
| `STARTUP_TIMEOUT_MS` | 1000 | py:54 | libatspi timeout for an app that started recently |
| `SLOW_APP_S` | 0.7 | py:58 | a call or gap longer than this was a timeout: the app is busy |
| `STRIKES_WITHIN_S` / `STRIKE_GAP_S` / `HUNG_FOR_S` / `REPROBE_S` | 60 / 5 / 30 / 4 | py:59-66 | hung-app tracking (§5.3) |
| `FIND_BUDGET_S` | 2.0 | py:71 | finding the window (`frames(until=…)`) |
| `READ_BUDGET_S` | 1.5 | py:70 | the walk |
| `READ_TOTAL_S` | 3.0 | py:72 | target for the whole read; walk budget = `max(0.3, min(1.5, 3.0 − elapsed))` (py:2251) |
| `GRID_BUDGET_S` | 0.6 | py:111 | a spreadsheet's cells: `min(now+0.6, now + (budget.until−now)/2)` (py:1219) |
| `GRID_CELLS` | 400 | py:110 | at most this many grid cells per read, on top of `maxNodes` |
| `CURSOR_SCAN_S` | 1.0 | py:114 | finding the cell with the keyboard: `min(1.0, max(0.3, 3.0 − elapsed))` (py:2272) |
| `WITHHOLD_S` | 0.8 | py:563 | all the secret checks after the walk (`Asking`) |
| `CONTENTS_S` | 0.4 | py:480 | checks of names in web pages (`unlisted_secrets`, `withheld_name`, at_point `name_of`) |
| `MIN_CALL_S` / `DEADLINE_TICK_S` | 0.02 / 0.05 | py:565-567 | `calls_by` deadline mechanics |
| other windows | 0.3 | py:2298-2299 | `other_windows` |
| `SCAN_BUDGET_S` / `SCAN_NODES` / `SCAN_CHILDREN` | 2.0 / 6000 / 2000 | py:2327-2329 | `secret_fields` |
| secret_fields find | 1.0 | py:2465 | |
| `SHELL_FIND_S` / `SHELL_BUDGET_S` / `SHELL_ACTORS` / `SHELL_DEPTH` | 1.0 / 1.0 / 1000 / 6 | py:2562-2574 | `shell_overlays` |
| `AT_POINT_BUDGET_S` / `AT_POINT_LEVELS` / `AT_POINT_CHILDREN` | 1.0 / 40 / 64 | py:3793-3795 | `at_point` |
| `HIT_AGAIN_S` | 0.05 | py:3879 | Chromium's hit test is asked again |
| TS request timeout | 5000 ms | ts:311 | every method |

### 5.2 `Budget` (py:1418-1458)

- `check()`: if more than 0.7 s passed since the last check, then `busy = True`. It returns `busy`.
- `tick()`: `check()`, then if `last ≥ until` it sets `over = True`. It returns `busy or over`. Reads
  tick before every element.
- `cut_short(why)`: `cut = True`, and `why` is appended to `self.why` (deduplicated). The reasons are
  `"nodes"`, `"depth"` and, in `secret_fields` only, `"loading"`.
- A read that finishes at its deadline without another tick is **not** slow (test
  `test_a_complete_read_finishing_at_its_deadline_is_not_slow`).

### 5.3 Busy and hung apps (py:1931-2008)

- `note_answer(pid, t0, ok)`: a failed call taking more than 0.7 s is a strike, and the pid goes into
  `SLOW_NOW`, so it isn't asked again during this request.
- `timed_out(pid)`: strikes less than 5 s apart count as one. The 2nd strike within 60 s marks the app
  hung for 30 s (`HUNG`).
- Hung apps are skipped by `frames()` unless they were asked for by pid. They are asked again at most
  every 4 s (`reprobe`). Skipped ones go into `SKIPPED_NOW`.
- `KNOWN` (py:1939-1942): each app's windows as last seen (200 apps × 20 windows). `list_windows`
  reports a busy or skipped app's windows from it, with `busy: true, active: false`.
- `new_request(params)` (py:1944-1951) clears `SLOW_NOW`, `SKIPPED_NOW` and `OWN_NOW`, then sets
  `OWN_NOW = {params.ownPid}` if it is an int. `read_window`, `list_windows` and `at_point` pass params.
  `secret_fields` and `shell_overlays` call `new_request()` without them.

### 5.4 `calls_by(until)` and `Asking` (py:570-670)

After the walk, every call is given only the time left before a deadline. A background thread keeps
re-setting libatspi's timeout to `max(0.02, deadline − now)` every 50 ms. `Asking.run(ask)` runs a check
only while time is left. A call that took more than 0.7 s, or the whole time left, marks the app busy,
and no more checks are made. **When checks can't run in time, names are withheld rather than reported**
(§8.4).

### 5.5 Worst case for `read_window`

Find ≤ about 2.0 s, then the walk gets `max(0.3, 3.0 − elapsed)` capped at 1.5 s, the cursor scan ≤ 1.0 s
(at least 0.3 s), the withhold pass ≤ 0.8 s, and other windows ≤ 0.3 s. Each phase can overrun by about
one call timeout (≤ 0.8 s). That is about 4.4–5 s in the worst case, against the client's 5 s.
`Perception.read` retries once after 300 ms when the answer says `busy` (index.ts:130-135).

---

## 6. Methods, one by one

`METHODS` table: py:4192-4210. A method receives `req.get("params") or {}`.

### 6.1 `ping`

- params: none.
- result: `{"version": 3}` (`VERSION`, py:41).
- Works **without pyatspi** (the only method that does, py:4633). **Not used by the TS client.**

### 6.2 `status` (py:2680-2694)

- params: none.
- result: `{"version": 3, "python": "<sys.version first word, e.g. 3.6.8>", "toolkitAccessibility": true|false|null, "apps": <int>}`.
  - `toolkitAccessibility` is GSettings `org.gnome.desktop.interface toolkit-accessibility`, or `null`
    when that can't be read.
  - `apps` is the desktop's child count (accessible applications), 0 on failure.
- TS: `status(): Promise<SidecarStatus>` (ts:160, 363). Used by `revive()` (ts:307) only to start and
  connect a process, and by `test/integration/perception.test.ts:49` (`apps > 0`). The environment check
  doesn't use it: `main.ts:121-139` runs gsettings and `python -c "import pyatspi"` itself.
- **[port note]** On macOS, `toolkitAccessibility` is the natural place for `AXIsProcessTrusted()`. On
  Windows, return `true` or `null`.

### 6.3 `list_windows` (py:2140-2154)

- params: `{ ownPid?: int }`. The TS client sends `{ ownPid }` (index.ts:573, 607).
- Steps: `new_request(params)`. For each `(app, pid, win)` from `frames(until=now+2.0)` (py:2044-2074),
  which skips `SLOW_NOW`, `OWN_NOW` and hung pids not due for a reprobe, and asks at most 200 windows per
  app, it calls `window_facts`. The window is kept **if its states include `showing` or `active`**, and
  described with `describe_window` (py:2124-2137).
- `describe_window` → `{"app": app.name or "", "pid": <int|null>, "path": win.path|null, "name": win.name or "", "role": win.getRoleName(), "active": "active" in states, "bounds": extents(win)}`.
  Each attribute is asked in turn and guarded, ticking a fresh `Budget` (1.5 s). If the budget runs out,
  the remaining fields keep their defaults (`""`, `false`, `null`).
- Then `remember_windows` for each pid that answered. Busy or skipped apps' windows come from `KNOWN`
  with `{..., "active": false, "busy": true}`, sorted by pid and appended at the end.
- result: `{"windows": AxWindow[]}`, in order: desktop app order, each app's window order, then the busy
  ones.
- No never-look filtering here: TS filters (`Perception.windows`, index.ts:572-584;
  `privateWindows`, index.ts:593-619).
- Callers: `Perception.windows()` (`worker.ts:914`: listing windows for the model; desk open), and
  `Perception.privateWindows()` (masks before screenshots).

### 6.4 `read_window` (py:2237-2318)

**params** (TS type at ts:373; Python reads):

| name | type | default | meaning |
|---|---|---|---|
| `pid` | int | — | the app's process |
| `title` | string | — | lowercased, then matched against window names (exact +6, substring +4) |
| `path` | string | — | with `pid`: exactly that window or none |
| `maxDepth` | int | 64 (`MAX_DEPTH`, py:45) | `int()`ed; never sent by TS |
| `maxNodes` | int | 400 (`MAX_NODES`, py:46) | `int()`ed; never sent by TS (`Perception` relies on 400: `WORKER_LINES = 400`, index.ts:81) |
| `neverLook` | string[] | `[]` | substrings (trimmed, lowercased) of `"<app name> <window name>"` lowercased |
| `skipPids` | int[] | `[]` | processes never read (TS finds them by X11 class) |
| `ownPid` | int | — | Ember's own process: its windows are never found, not even as the active window |
| `keep` | bool | true | only literal `false` makes it a quick look (py:2260) |
| `cells` | string[] | — | spreadsheet addresses ("C62", "$AB$7") where the cell with the keyboard is expected; at most 4 are used (`cell_places`, py:1275-1291) |

TS builds params at `perception/index.ts:118-127`: `{pid, path}` when both are known, else
`{pid?, title?}`, else `{}` for the active window. `ownPid` is always sent. `neverLook` and `skipPids` are
sent only when the never-look list isn't empty, then `keep: false` and `cells` as needed. A `path`
without a `pid` is never sent: TS answers `{window: null, nodes: [], ms: 0}` itself.

**Finding the window** (`find_window`, py:2181-2205; `best_window`, py:2157-2178):

1. `pid` and `path` → only that pid's frames; the window whose `win.path == path`, else **none**
   (never another window in its place).
2. Neither `pid` nor `title` → the first window with state `active` (any app except `OWN_NOW`). Otherwise
   none.
3. `pid` given → `best_window(frames(only_pid=pid))`. Score: same pid +8, `name == title` +6, else
   `title in name` +4. A score of 0 is skipped. Then active +2 and showing +1. With no title, or a score
   ≥ 10, that one wins. Otherwise other apps' windows are scored too (they can reach at most 9), and win
   only with a higher score.
4. Only `title` → `best_window` over all frames.

**Not found** → `{"window": null, "nodes": [], "busy": <bool>, "ms": <int>}` (py:2242-2249).
`busy = time ran out (until passed) or asked pid in SLOW_NOW or any SLOW_NOW|SKIPPED_NOW app other than
the asked one might_have(title)`. `might_have` (py:2096-2099) is true when its last-seen windows are
unknown, when there is no title, or when a last-seen name contains the title. The keys `truncated`,
`cut` and `others` are absent here.

**Found** (py:2250-2318):

1. `budget = Budget(max(0.3, min(1.5, 3.0 − elapsed)))`. `window = describe_window(app, pid, win, budget)`.
2. If `pid in SLOW_NOW`, then `budget.busy = True` and there is no walk. Otherwise, if the window has a
   name, `remember_windows(pid, [window], merge=True)`.
3. **Never-look** (`never_looked`, py:2208-2214): `pid in skipPids`, or any non-blank `neverLook` item
   (trimmed, lowercased) is a substring of `("%s %s" % (app, name)).lower()`. If so, return
   `{"window": window, "nodes": [], "blocked": true, "ms": …}`. No ids are handed out and nothing inside
   is asked. **The window's real name is in the answer**: TS blanks it (index.ts:143-146).
4. `SNAPSHOTS.begin(keep)` (§4.2).
5. Unless busy: `web_engine(win)` (caches the toolkit), `walk(win, 0, nodes, maxDepth, maxNodes, None, None, budget)`,
   then `budget.check()` (§7).
6. If spreadsheets still need their cursor cell (`budget.sheets`) and the app isn't busy:
   `add_cursors(nodes, budget.sheets, now + min(1.0, max(0.3, 3.0 − elapsed)), cell_places(cells))` (§7.6).
7. `redact_by_layout(nodes, …)` (§8.3), then `withhold_names(nodes, …, Asking(budget.busy))` within
   `asking.calls()` (§8.4).
8. Anything already in `WITHHELD` (by `(bus, path)` with the window's bus) gets its name and text
   withheld (py:2281-2289).
9. `inside_secrets(nodes)`: nodes under a secret node are **removed**, and their ids deleted (py:2290-2294).
10. `others = other_windows(pid, win, Budget(0.3))` inside `calls_by(now + 0.3)`, unless busy or the pid
    is null (py:2295-2299; §6.4.2).
11. If the app was busy and isn't in `SLOW_NOW`, `timed_out(pid)` gives it a strike.
12. Result:

```json
{
  "window": AxWindow,                 // describe_window, see §6.3
  "nodes": AxNode[],
  "truncated": <bool>,                // budget.cut or budget.over
  "cut": ["nodes" | "depth", ...],    // budget.why; always present here (may be [])
  "others": OtherWindow[],            // always present here (may be [])
  "secretKeys": [[bus, path], ...],   // keys of the nodes left marked secret
  "withheldKeys": [[bus, path], ...], // keys noted by withhold_names
  "ms": <int>,
  "busy": true,                       // only when the app stopped answering
  "slow": true                        // only when not busy and the time ran out (budget.over)
}
```

TS strips `secretKeys` and `withheldKeys`, remembers them (ts:374-379), and maps
`truncated: res.slow ? "time" : !res.truncated ? null : res.cut?.length && !res.cut.includes("nodes") ? "depth" : "nodes"`
(index.ts:161).

#### 6.4.1 Node fields (`node_of`, py:858-922; `walk`, py:1571-1584; `cell_node`, py:1178-1202)

| field | when present | value / rule |
|---|---|---|
| `id` | always | new id (§4) |
| `parent` | always | the id of the **nearest listed ancestor**, or `null` (the window frame, or anything with no listed ancestor) |
| `depth` | always | the **real tree depth** from the window (0 = the window frame), counting containers that weren't listed. Spreadsheet cells get sheet depth + 1 |
| `role` | always | `acc.getRoleName()` verbatim (§11). Grid cells are always `"table cell"` |
| `name` | always | `(acc.name or "").strip()[:200]`. `""` when withheld |
| `states` | always | the element's states **filtered to `INTERESTING_STATES`**, in the toolkit's order (§11.2) |
| `bounds` | always | `extents(acc)` or `null` |
| `actions` | role in `INTERACTIVE_ROLES` and not in `LAZY_ACTION_ROLES`, and the list is non-empty | the app's action names, verbatim, not lowercased (py:213-218) |
| `text` | (a) role in `TEXT_ROLES`, not secret, text non-empty and not only U+FFFC; (b) role `heading`/`block quote`, unnamed, not in a web engine; (c) `table cell` named like a cell address (`grid: false`); (d) a grid cell with text that isn't just its name, or any text when its name is an address | first **200** characters (`text_of`, py:221-226; `cell_text`, py:229-237) |
| `selection` | not secret, `focused` in states, and (a) a `TEXT_ROLES` element, or (b) an unnamed non-web heading/block quote with text, or (c) any other role with `editable` in states | the first selection's text, ≤ 500 characters (`selection_of`, py:240-251). Never for passwords |
| `selected` | role `combo box`, not secret | the name of the option the combo box shows as chosen (`chosen_option`, py:3536-3562) |
| `value` | role in `VALUE_ROLES` and not secret | `float(currentValue)` if finite |
| `editable` | (role in `INTERACTIVE_ROLES` or `TEXT_ROLES`), state `editable`, and the EditableText interface; grid cells: the sheet's cells take text (asked once per sheet) and the cell has the `editable` state | `true` |
| `secret` | secret field (§8) | `true`; then `text`, `selection`, `selected` and `value` are absent, and **nothing inside is walked** |
| `withheld` | name withheld (§8.4) | `true`; `name` is `""`; `text`, `selection` and `selected` are removed |
| `shown` | `clip_to(clip, bounds) != bounds` (py:1577-1581, 1199-1201) | the part inside the clip (§7.3). **May be 0×0** |
| `grid` | `true` for a spreadsheet cell read by row and column; `false` for a `table cell` named like an address elsewhere (a Writer table) | |
| `size` | on the sheet node itself, when `grid_of` found a spreadsheet | `{"rows": nRows, "columns": nColumns}` (`sheet_size`, py:1144-1151) |

**Order and invariants:** depth-first pre-order, parents before children (`add_cursors` inserts a
cursor cell right after the sheet's other cells, still after its parent). When the window frame itself
shows and has a positive size, it is `nodes[0]` with `parent: null, depth: 0`. TS relies on this:
`worker.ts:1306` uses `n.depth > 0` to leave the window out, and `focusedElement` picks the deepest
`focused` node (elements.ts:433-437).

#### 6.4.2 `others` (`other_windows`, py:2217-2234)

The same pid's other top-level windows that are `showing` and (`active` or `modal`), excluding the read
window (by path). At most 5:
`{"name": other.name or "", "role": other.getRoleName(), "active": bool, "modal": bool}`. TS drops
private ones (index.ts:162) and prints "Also open in this app: …" (index.ts:643-647).
`worker.ts:2474, 2561` look for `o.active || o.modal`.

#### 6.4.3 HiDPI

Bounds are as the app reports them. TS scales them and registers the scale with `scaleElements`
(index.ts:148-158; §10).

### 6.5 `remember_secrets` (py:2526-2533)

- params: `{ keys?: [[string,string],...], withheld?: [[string,string],...] }`. Each 2-element list is
  added to `SECRETS` or `WITHHELD`, keeping the most recent 4096 of each (py:311-329). Anything else is
  ignored.
- result: `{"count": len(SECRETS)}`.
- Sent only as the preamble (§1.5), with its answer ignored. Never errors.

### 6.6 `mark_secret` (py:2536-2555)

- params: `{ ids: int[] }`. Only the **first 64** are used. Ids that can't be resolved or keyed are skipped.
- For each id: `SECRETS.add(key)`, `keys.append(key)`, then `withhold_around(acc, role)` (py:724-747).
  That walks up from the field through at most 13 accessibles (`WITHHELD_LEVELS + 1`), stopping at a
  `WINDOW_ROLES` element, and withholds every named ancestor whose name **says the field's value**
  (`says_secret`: the value is in the name, or a web engine made the name from contents). The field
  itself counts only by value.
- result: `{"keys": [[bus,path],...], "withheldKeys": [[bus,path],...]}`.
- From then on, `set_text`/`set_value`/`select_option` refuse these fields (`refuse_secret`, py:2831-2836),
  and later reads treat them as secret.
- TS: `markSecret(ids)` (ts:383-389) does nothing for an empty list. It is called from
  `Perception.withSecrets` (index.ts:200-202) for fields TS found secret that the sidecar didn't
  (`!n.secret`: reveal toggles, labels, §9). Errors are logged and ignored.

### 6.7 `shell_overlays` (py:2605-2661) — GNOME Shell only

- params: none (`new_request()`).
- Finds GNOME Shell among the desktop's apps by `/proc/<pid>/comm == "gnome-shell"` (or by app name when
  /proc can't be read), within 1.0 s of looking. Then it searches the shell's actors depth-first (≤ 1000,
  ≤ 6 levels, ≤ 60 children each, 1.0 s), skipping non-`showing`/`visible` ones below the root.
  - An actor at depth > 1 that is `focused` or named `overviewGroup` → once:
    `{"role": "overview", "name": name[:200], "text": "", "bounds": null}`.
  - role in `SHELL_ROLES` (`dialog`, `alert`, `notification`, `file chooser`) →
    `{"role", "name"[:200], "text": names of the descendants (≤ 20 words, depth 6) joined by spaces [:400], "bounds": extents}`,
    without going deeper.
- result: `{"overlays": ShellOverlay[], "complete": <bool>}`. `complete` is false when the time to find
  the shell ran out before every app was looked at, or the shell's search didn't finish.
- TS (`shellCovers`, `perception/windows.ts:118-125`):
  - any overlay whose role isn't `notification`/`overview` → `dialog` → **no screenshot**;
  - `complete === false` → `unchecked`, treated as a dialog → no screenshot;
  - `overview` → no screenshot;
  - notifications are blacked out.
  - A rejected call → `shellCovers([])`, meaning "nothing" (index.ts:532-539).
- **[port note]** Linux-specific. On Windows and macOS, return `{"overlays": [], "complete": true}`,
  or map OS-drawn secure prompts the same way:
  - Windows: CredentialUIBroker or consent windows → `"dialog"`; Task View or Alt+Tab → `"overview"`.
  - macOS: SecurityAgent → `"dialog"`; Mission Control or App Exposé → `"overview"`.
  - Never leave `complete` false for good: that would block every screenshot.

### 6.8 `secret_fields` (py:2456-2523)

- params: `{ pid: int, path: string }`. Both are required: without them, or if the window isn't found
  within 1.0 s, the answer is `{"fields": [], "complete": false, "busy": pid in SLOW_NOW, "ms"}`, with
  no `secretKeys`.
- There is no never-look check and no `ownPid` here (TS never asks for blocked windows).
- `scan_fields` (py:2360-2453) walks the window with `Budget(2.0)`, at most 6000 nodes, 2000 children
  per container, and depth `MAX_DEPTH`. It skips non-showing elements as the walk does (`shows`). It
  collects `FIELD_ROLES` elements (without looking inside them) and `LABEL_ROLES` elements.
  - A `document web` (or any web-engine document) is searched by the app in one call (AT-SPI Collection:
    showing elements with `FIELD_ROLES`, up to 6000). Hitting that cap → cut `"nodes"`.
  - A web document that shows with no children and no size → cut `"loading"`, which makes the answer
    `busy`.
  - In a long list, rows outside the view are skipped, and 3 misses in a row end the list. Rows that
    show out of order come from `showing_after`.
  - A spreadsheet's cells are never scanned (only its headers).
  - Anything cut short → incomplete.
- Every field found with a positive-size box is judged with `is_secret`. An unnamed one (or a combo box
  named after what it shows) is judged by the nearby labels as well (`secret_by_layout`, §9.1). Labels
  come from the scan, or from the web docs' Collection search for `LABEL_ROLES`.
- result:

```json
{"fields": [{"id": <new id>, "role": "<role>", "bounds": Bounds}], "complete": <bool>, "busy": <bool>,
 "secretKeys": [[bus,path],...], "ms": <int>}
```

  `complete = not (busy or over or cut)`. `busy = budget.busy or "loading" in cut`. Bounds are **as the
  app reports them, not scaled** (ts:86-93).
- TS: `Perception.unreadSecrets` (index.ts:511-526) calls it before **every** screenshot of a window
  with a pid and path, and again after the picture is taken (index.ts:472). If `complete` is false there
  is **no screenshot**. TS blacks out each field at both its reported and its scaled place
  (`physical(b, k)`, index.ts:634), and re-reads them with `readElement` (`whereNow`, index.ts:499-505,
  at most 24 at a time, **concurrently**: they queue one after another in the sidecar, under one 5 s
  clock each).

### 6.9 `read_element` (py:3774-3788 → `node_info` py:2730-2795)

- params: `{ id: int, shown?: bool, formula?: bool }`. TS sends `shown`/`formula` only when true (ts:426-428).
- Resolves the id with `SNAPSHOTS.get` (re-asking a spreadsheet's sheet for a cell). There are **no
  visibility checks**: a hidden element is reported too, and the caller looks at `states` and `offscreen`.
- result `ElementInfo`:

| field | rule |
|---|---|
| `role` | `getRoleName()` |
| `name` | stripped, `[:200]`. `""` when withheld: the key is in `WITHHELD`, or `withheld_name` finds that the name says a secret field's value (web engines only, ≤ 0.4 s, py:1904-1915) |
| `states` | filtered to `INTERESTING_STATES` |
| `bounds` | `extents` or null (0×0 is allowed) |
| `offscreen` | `true` when role in `MENU_ITEM_ROLES`, states is non-empty, and `showing` isn't among them (GTK keeps a closed menu's items) |
| `withheld` | `true` when withheld. Then it returns **without** text, value or selected |
| `secret` | `true` when `is_secret(acc, role, name)`. Then it returns without text, value or selected |
| `text` | `text_of(acc, 2000)` for **any role with the Text interface**, **including `""`** (empty text is reported; no Text interface → absent) |
| `value` | `value_of(acc)` for **any role with the Value interface** (spreadsheet cells too), when finite |
| `selected` | `combo box`: the first child of the option holder (≤ 500) that its Selection says is selected, named through `said_name` (withheld names become `""`). `table`/`tree table`/`tree` (not a spreadsheet): the first selected row's first cell with words (≤ 8 columns), via `cell_words`/`said_name`, `[:200]` |
| `open` | role `menu`: whether any of its first 3 children shows (`menu_open`, py:2798-2806) |
| `shown` | with `shown: true`: `visible_part(acc, bounds)` (py:3802-3835). Walking up at most 40 ancestors, it clips by each `document web`/`document frame` parent (inside a page, only pages and frames clip), by each `scroll pane`/`viewport` parent outside pages, and by the window (unless inside a page). `null` (absent) when it equals the bounds; may be 0×0 |
| `formula` | with `formula: true`, role `table cell`, not secret, and `text` present: the `Formula` object attribute (LibreOffice Calc), without the "=", `[:2000]` |

- Errors (§2.1): unknown id → `'element N is no longer known; read the window again'`; gone →
  `element N is gone (the window changed); read the window again`; busy → `BUSY`.
- TS: `readElement(id, {shown?, formula?})` (ts:426-428) scales `bounds` and `shown` by the id's
  registered HiDPI factor (`physical`, ts:354-357).
- Callers depend on these points:
  - `text === undefined` means "this element's text can't be read" (`worker.ts:725, 2157`);
    `TEXT_READ_LIMIT = 2000` (`worker.ts:152`) mirrors the 2000-character read.
  - `offscreen` and `open` feed the change key (`worker.ts:1259`).
  - `shown` is where the mouse aims (`landingSpot`, `worker.ts:2058`).
  - `formula` and `value` serve spreadsheet checks (`worker.ts:2447, 2521`).
  - `selected` is the drop-down's option after an action.
  - The roles and names compared with the read's (`worker.ts:1420, 1620, 1894`) **must come out the same
    way as in `read_window`**.

### 6.10 `at_point` (py:4100-4189)

- params: `{ pid: int, path: string, x: int, y: int, neverLook?: string[], skipPids?: int[], ownPid?: int, menus?: bool (default true) }`.
  `x` and `y` are in the **app's units** (TS divides physical pixels by k: index.ts:183).
- Steps:
  1. `new_request(params)`. `find_window(params, now + 2.0)`; none →
     `{"chain": [], "found": false, "ms"}`.
  2. `budget = Budget(1.0)`. If `never_looked(describe_window(...))` →
     `{"chain": [], "blocked": true, "ms"}`.
  3. Popups first:
     - `popup_at(app, win, x, y)`: one of the app's other top-level windows with role `window`
       (≤ 16 looked at) that shows, contains the point, and isn't an empty container.
     - Otherwise, if `menus` isn't false, `open_menu_at(win, x, y)` returns `[menu, item]`: an open menu
       (role `menu`, `selected` or `expanded`, with items showing), searched through the window's top 6
       levels of `MENU_HOLDERS`, ≤ 40 children each.
     - Those come first in the chain, and the descent continues from the last of them.
  4. Descent, at most 40 levels (`child_at_point`, py:3943-4001):
     - It asks the app's hit test (`Component.get_accessible_at_point`, SCREEN coords). Chromium is asked
       up to twice more, 50 ms apart, until two answers agree (`hit_at`, py:3892-3909).
     - The answer is taken if it isn't the container itself and shows. If it is an empty generic container
       (`dead_end`: role `panel`/`filler`/`unknown`/`redundant object` with 0 children), a sibling that
       shows at the point is used instead.
     - If the hit is a direct child, `on_top` prefers a **later** sibling (≤ 16 siblings, not in web
       engines) that also contains the point: the one drawn on top.
     - Otherwise it scans the first 64 children for one that shows and contains the point. Children
       that pass `shows()` but don't contain the point, and are either a `page tab` or not `showing` (a
       misjudged viewport), are looked into one level down. A match there gives `[holder, child]`. An
       empty container that contains the point is the last resort, giving `[empty]`.
     - It stops when nothing is found or the budget ends.
  5. For each step element: `{"role", "name", "bounds": extents}`. `name` goes through `name_of`
     (py:4122-4131): `""` if empty, if the key is in WITHHELD, or if `name_says_secret` (web engines,
     0.4 s for the whole call, noted in `withheldKeys`). Otherwise `name[:200]`.
  6. A step element in `TEXT_ROLES` that `is_secret` → `{"role", "name": "", "bounds", "secret": true}`.
     The chain **ends** there. Earlier chain names that say its value are blanked and noted. If the hit
     is inside a secret field (Chromium's deepest element), the field replaces it (`secret_around`,
     py:4082-4097).
  7. If the last element isn't secret and is a dead end → `chain[-1]["empty"] = true`.
- result: `{"chain": PointElement[], "ms": <int>, "withheldKeys"?: [[bus,path],...], "busy"?: true}`.
  `busy` means `budget.busy or budget.over`. The chain is **outermost first and starts below the window**:
  the window itself isn't in it.
- TS: `atPoint` (ts:414-419) remembers `withheldKeys` and strips them. `Perception.atPoint`
  (index.ts:174-186) returns `null` on `blocked`, `busy` or `found === false`, and scales the chain's
  bounds by k. It sends `menus: false` when none of the app's override-redirect windows covers the point.
- Callers depend on these points:
  - `wheelTarget` and `aimedAt` (`worker.ts:300, 371-383`) compare `last.role === role && sameRect(last.bounds, b)`
    with `read_element`'s bounds, so **at_point bounds and read_element bounds must be identical for the
    same element**.
  - `last.empty` means "unknown".
  - `chain[0].role` matching `/^(menu|window)$/` means "an open menu or popup lies over it"
    (`worker.ts:2108`).
  - `HOLDERS` and `CLICK_TAKERS` are role regexes (`worker.ts:354, 360`).

---

## 7. How the walk works (read_window)

`walk(acc, depth, out, max_depth, max_nodes, parent_id, clip, budget, in_pane, pane, web)` (py:1530-1651)

### 7.1 Hidden nodes are dropped, with their whole subtree

- First, if `len(out) − budget.grid ≥ max_nodes` → cut `"nodes"` and stop. If `budget.tick()` → stop.
- `shows(acc, states, in_pane)` (py:1461-1476): **needs `visible`**, and then `showing`, except for a
  `viewport` directly in a `scroll pane` (GTK 3 misjudges those). A spreadsheet pane found on screen by
  its box (`pane=True`) needs only `visible`.
- A node that fails this test is **not listed, and nothing under it is walked**. The comment calls
  invisible elements "a known prompt-injection channel" (py:1543), and
  `test/integration/perception.test.ts:60` checks that a hidden button doesn't appear.
- A misjudged viewport isn't listed itself (`judged = "showing" in states or pane`). It counts as on
  screen only if something in it is.

### 7.2 What gets listed

- `listed = judged and (role not in SKIP_ROLES or name)` (py:1566). `SKIP_ROLES` (py:78-79) = filler,
  panel, section, redundant object, glass pane, layered pane, root pane, scroll pane, viewport, split pane,
  internal frame, option pane, unknown. **A named container is listed.**
- Bounds are asked only for listed nodes, the root, `CLIP_ROLES` and `DOCUMENT_ROLES` (py:1568).
- A node is listed only if `bounds is null or (width > 0 and height > 0)`. Zero-size elements aren't
  listed, but their children are walked and attach to the nearest listed ancestor.
- `depth > max_depth` with the element showing → cut `"depth"`, and the walk doesn't go deeper.
- Something unlisted in `TEXT_ROLES` is still checked with `is_secret`. If it is secret, nothing inside
  is walked.

### 7.3 Clipping and `shown`

- `clip` starts as None. At depth 0, and at every `scroll pane`/`viewport` (`CLIP_ROLES`, py:1415), it
  becomes `clip_to(clip, bounds)`. Inside web pages it doesn't, because Chromium's page reports physical
  pixels on HiDPI.
- At a `document web`/`document frame` (`DOCUMENT_ROLES`, py:2330): outside a page, `clip = bounds`; in a
  page, `clip = clip_to(clip, bounds)`; then `web = True`. A page itself is never clipped by what holds it.
- `shown` is `clip_to(clip_used, bounds)` when it differs. Elements outside the clip are **still listed**
  (with a 0×0 `shown`); only long lists use the clip to choose rows.

### 7.4 Long lists (more than `MAX_CHILDREN` = 200 children; `child_indices`, py:1037-1071)

- Up to 200 children: all of them.
- A table with the Table interface and a vertical scroll bar beside it (GTK tree view): its leading header
  children, plus the rows around the scroll fraction (`table_indices`, py:986-1013).
- No clip: the first 200. "left out" is true if child 200 is on screen.
- Otherwise: leading children (≤ 16) that are showing and don't end above the clip are kept. A binary
  search finds the first row not wholly above the clip's top. A child without a size makes the search
  unsure (it probes up to 3 more), and unsure counts as left out. Then up to `cap − lead` children are
  taken from there.
- During the loop, in a long list, 3 children in a row that aren't on screen after one that was end the list.
- `left_out` → cut `"nodes"`. Otherwise, for an ordered long list that stopped before its end,
  `showing_after` (py:1392-1411) finds children that show out of order:
  - web engines: the app's Collection, ≤ 16 (`STRAGGLERS`);
  - elsewhere: the last 3 children.
  - Not complete → cut `"nodes"`.

### 7.5 Spreadsheets (LibreOffice Calc; `grid_of`, py:1113-1141)

- **Detection:** a long list (more than 200 children) with state `manages descendants`, not a web
  engine, with no vertical scroll bar beside it, and a view with a positive size. The app's hit test at
  the view's top-left (+1,+1) and bottom-right (−2,−2) corners gives the first and last row and column
  (`cell_position`, py:1094-1110). The header count is `min(Table.getIndexAt(0,0), 16)`.
- The sheet node gets `size: {rows, columns}`.
- `walk_grid` (py:1205-1251):
  - Header children are walked normally first.
  - Then the cells go row by row (`grid_cells`), until `GRID_BUDGET_S` (or half the time left) runs out.
    Each cell is asked for its text first. A cell is **listed only if** it has text (`!= ""`) or is
    `focused`/`selected`, **and** it is `showing` and `visible`, and in view.
  - At most `GRID_CELLS` = 400 listed. Past that, or past the time → cut `"nodes"`. Grid cells don't
    count toward `maxNodes` (`budget.grid`).
  - A cell node: role `"table cell"`, name = its address ("B7"), `grid: true`, `text` = its contents
    (`cell_text`, the whole text cut to 200), `editable` as in §6.4.1. Its id finds the cell by
    (sheet, row, col) again.
  - A non-cell child inside the grid is walked like any element.
- **Frozen panes** (`PANE_ROLE = "document spreadsheet"`, py:1482-1527): the sibling panes (2–24
  siblings) are read top-left first, so the frozen headings are read before the scrolling pane uses up
  the cell budget. A frozen pane that says it doesn't show but is visible and on screen is read anyway.

### 7.6 The cell with the keyboard (py:1254-1366)

- If the sheet is `focused` and its focused cell wasn't among the cells read, `budget.sheets` notes
  where to look.
- After the walk, `add_cursors` → `cursor_cell` asks, in order:
  1. the `cells` hints (at most 4);
  2. where the cursor was last found (`CURSORS`, per sheet key, 64 sheets);
  3. the cells next to each of those;
  4. the cells on screen from where the walk stopped, nearest rows first (`scan_order`).
- It stops when its time is up or a call takes more than 0.7 s.
- The cell found is inserted at the sheet's place in the list. Its `bounds` is `null` when it's
  scrolled away (`anywhere=True`).

### 7.7 Truncation summary

| Situation | Effect |
|---|---|
| `maxNodes` non-grid nodes reached, a long list left out, grid > 400 cells, grid time up | `cut: ["nodes"]`, `truncated: true` |
| something showing deeper than `maxDepth` | `cut: ["depth"]`, `truncated: true` |
| walk deadline reached (`over`) and not busy | `truncated: true`, `slow: true` (TS: "time") |
| a gap > 0.7 s (the app stopped answering) | `busy: true`; `truncated` true only if cut or over |
| window lookup timed out on that app | `busy: true`, `nodes: []` |

TS notes for the model: index.ts:650-657.

---

## 8. Secret fields and withheld names

### 8.1 What counts as secret (`is_secret`, py:335-346)

1. `role == "password text"` **or** the key is already in `SECRETS` → secret (and remembered).
2. Otherwise, only `FIELD_ROLES` (`text`, `entry`, `password text`, `spin button`, `combo box`, py:102)
   are judged by words:
   - `looks_secret(name)`;
   - or `looks_secret(label)` for any `LABELLED_BY` relation target's name (`labels_of`, py:273-286);
   - or `looks_secret(placeholder)`, from the object attributes `placeholder-text` or `placeholder`
     (`placeholder_of`, py:289-299).
   - Any of these → secret, and remembered.
3. Where `is_secret` is called:
   - `TEXT_ROLES` in reads (so `terminal`, `paragraph` and `document text` can be secret only by key or
     role);
   - unnamed non-web headings and block quotes;
   - address-named table cells;
   - grid cells;
   - unlisted text roles;
   - `read_element` (any role);
   - `at_point` (`TEXT_ROLES` only);
   - `secret_fields`, `option_items`, `cell_words`, `refuse_secret`.

`SECRETS` (py:311-332) holds keys (§3.2) in an LRU of 4096. A GTK "Show password" toggle turns a password
field into a plain entry, and it stays secret here.

### 8.2 `looks_secret` (py:116-164)

- `normalize_label`: NFKC, then characters of category `Cf` removed, then `.lower()`, then U+0307
  removed (Turkish İ).
- `SECRET_LABEL = (?<!\w)(?:SECRET_WORDS…)(?!\w)|SECRET_ANYWHERE…` is searched in that. `SECRET_WORDS`
  (py:121-148) and `SECRET_ANYWHERE` (py:150-151) are **the same lists** as `elements.ts:107-137`. A unit
  test checks them against `test/fixtures/secret-labels.json`: 82 "secret" labels and 34 "plain" labels,
  including `"Pass​word"` (a zero-width space) and full-width `ＰＩＮ`.
- `^`/`$`-anchored entries (`^[\s:*]*parol(a|ă)[\s:*]*$`, `^[\s:*]*clave[\s:*]*$`) match only the whole
  label.
- TS uses `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with the `u` flag (elements.ts:139). Python uses `\w`.
- **[port note]** In C#, use the explicit TS class (.NET `\w` includes `\p{Mn}`/`\p{Pc}` and excludes
  `\p{No}`/`\p{Nl}`). Normalise with `NormalizationForm.FormKC`, drop `UnicodeCategory.Format` code
  points (mind surrogate pairs), `ToLowerInvariant`, and strip U+0307. A Node AX sidecar can import the
  TS lists directly. Test both against the same fixture, and against `test/fixtures/chosen-options.json`.

### 8.3 Secret by layout, after the walk (`redact_by_layout`, py:1705-1717)

- `labels` = `LABEL_ROLES` nodes (`label`, `static`, `caption`) that have a name and bounds. `controls`
  = `LABELLED_ROLES` nodes with bounds (`FIELD_ROLES` + check box, radio button, toggle button, switch,
  slider; py:1656). `fields` = `FIELD_ROLES` nodes with bounds that aren't secret yet.
- A field that is **unnamed** (or a combo box named after the option it shows: `named_by_value`,
  py:750-753) and whose `nearby_label` (§9.1) looks secret → `make_secret`. That drops `text`,
  `selection`, `value` and `selected`, sets `secret: true`, and adds the key to SECRETS.
- A combo box whose child node is secret is made secret too (GTK combo with an entry).

### 8.4 Withheld names (`withhold_names`, py:1720-1798; plus py:2281-2289)

To withhold a node: `name = ""`, `withheld: true`, and `text`, `selection` and `selected` removed. Its
key goes into WITHHELD and `withheldKeys`. The rules, in order:

1. For every secret node: its values are asked (`secret_values`, py:364-381), never reported. These are
   its text (≤ 2000), the combo box's chosen option, and a value-role number, squashed: normalised, with
   whitespace and U+FFFC removed. The "typed" values (text, number, and a chosen option that passes
   `chosen_secret`, py:397-411) are also collected in `values_of_all`.
   - Then up to 12 listed ancestors are checked (stopping at `WINDOW_ROLES`: frame, window, dialog, alert,
     file chooser, desktop frame, application; py:355), including the field itself:
     - If the values couldn't be asked in time: every named ancestor that isn't a document is withheld,
       and so is the field if it is a combo box.
     - Else, a name or text that holds a value is withheld (`holds_value`: a value of ≥ 4 characters
       anywhere in the squashed text, a shorter one only as a whole word).
     - Else, an ancestor whose name a web engine **made from its contents** (no `explicit-name: true`
       attribute; `named_from_contents`, py:426-437) is withheld, and so is one that can't be checked in time.
2. Short values (< 4 characters, not bullets) that appear in some name: the elements named after the
   field through `LABEL_FOR` relations (aria-labelledby) are added to WITHHELD.
3. Every non-secret node whose name or text says a typed value of ≥ 4 characters **as a word of its own**
   (`says_value`, py:454-468: any spacing between characters, not only bullets `•●∙·*◦`) is withheld. If
   only its `selected` says it, just `selected` is dropped. Nodes already in WITHHELD by `(bus, path)`
   are withheld.
4. `remember_values` keeps `values_of_all` per app bus (8 apps). They are used later by `read_element`'s
   and `list_options`' `selected`/options.
5. `unlisted_secrets` (py:1838-1893), **web engines only**, within `CONTENTS_S`: these names are checked
   with `name_says_secret` (py:704-721), which looks for secret fields inside the element or among its
   `LABELLED_BY` targets, through Collection or child by child (≤ 120 nodes, ≤ 32 fields):
   - a named element (not in `OWN_NAME_ROLES`) whose name has words that none of its listed descendants
     say, when it is a parent, partly shown, or where the read stopped;
   - and leaves whose name has a word of ≥ 4 characters with a digit that no text in the read says.
   - A name that can't be checked in time is withheld.
6. Back in read_window: anything in WITHHELD is withheld (py:2281-2289). Then nodes inside secret fields
   are removed (py:2290-2294).

TS repeats a simpler version (`withheldIds`, elements.ts:270-293) as a second line, on nodes the sidecar
didn't already mark.

### 8.5 TS second line (elements.ts:148-199; index.ts:194-218)

- `isSecretNode`: `n.secret`, or role `password text`, or `FIELD_ROLES` with a secret name or inferred label.
- `secretIds` adds fields beside a **reveal toggle**: a check box, toggle button, switch, push button or
  check menu item named "Show password" (or a bare "Show"/"Reveal" when the field looks like a key or
  code), on the same row to its right or just below it. It also adds a combo box parent of a secret field.
- Newly found ones → `markSecret`. Their contents are dropped, and nodes inside them are removed.
- Serialisation never prints the text, value or selection of secret or withheld nodes (elements.ts:362-427).

---

## 9. Labels for unnamed controls

### 9.1 Sidecar (used only for secret detection: `nearby_label`, py:1659-1687)

- `beside(lb, b)`: gap = `b.x − (lb.x + lb.w)`. Same row if the vertical centres differ by less than
  `max(12, b.h/2)`. It counts if the row matches and `−4 ≤ gap < 320`; the smallest gap wins.
- Above: `up = b.y − (lb.y + lb.h)`, with `−4 ≤ up < 24`, `lb.x ≤ b.x + b.w/2`,
  `lb.x + lb.w ≥ b.x − 16`, and the label not "claimed". The smallest `up` wins.
- A label is claimed (`claimed_labels`, py:1666-1669) when it is beside some `LABELLED_ROLES` control on
  its own row. Such a label never names a field below it.
- The label on the left is preferred to the one above.
- Labels come from `LABEL_ROLES` nodes = `label`, `static`, `caption`.
- `inner_label` (py:3616-3638) names unnamed **options** (`list_options`) by the first label with a
  letter or digit inside them, at most 4 levels down.

### 9.2 TS (display and secret detection: `inferLabels`, elements.ts:71-96)

- Only `INTERACTIVE` roles without a name (or `namedByValue` combo boxes) are labelled.
- A label inside the control comes first: the first `LABEL_ROLES` node with a letter or digit, at most 4
  levels down. This applies to controls that aren't fields.
- Otherwise, the label to the left or above (as in §9.1). A label above must be "label-like" (≤ 40
  characters, one line, no sentence end before more text), unless `anyAbove`, which secret detection uses.
- Rows and cells (`list item`, `table cell`, `tree item`) never take the label above.
- Serialised as `"<label>" (label)`.
- **[port note]** For this to work, a port must emit static text as `label` (or `static` inside web
  pages) **with bounds**. Without them, unnamed switches and fields lose their labels, and fields
  labelled "Password" by layout aren't caught.

---

## 10. HiDPI and coordinate units

- The sidecar reports **raw toolkit coordinates** (AT-SPI `SCREEN`/`DESKTOP_COORDS`) and never scales
  anything. On Linux, GTK at `GDK_SCALE=2` and Qt report logical pixels, while Chromium's web contents
  report physical pixels inside a frame that reports logical ones.
- TS works out the scale:
  - `Perception.frameScale` matches the AT-SPI frame's bounds to an X11 top-level (`matchFrame`,
    `perception/windows.ts:28-52`). The ratio of sizes, snapped to quarters, is `k`.
  - `elementScales` (windows.ts:69-80) gives each node its parent's scale. An embedded document
    (`document web`, `document frame`, `embedded`) that fits the physical frame **unscaled** but not
    scaled gets 1, and so does everything inside it.
  - `scaleNodes` makes the read physical. `scaleElements(ids, s, keep)` registers each id's scale, so
    later `readElement` and action results come back in physical pixels (ts:334-361).
  - `secret_fields` bounds stay unscaled; TS masks both places.
  - `at_point`: TS sends `floor(round(p)/k)` and scales the chain's bounds by k, with a single k for the
    whole window. That is why `mustAimAt` skips `atPoint` when an element's scale differs from the
    window's (`worker.ts:2081-2082`).
- `scaleBounds(b, k)` (ts:163-167) rounds the edges, not the sizes.
- **[port note] Windows:** the UIA sidecar process **must be Per-Monitor-DPI-Aware V2**
  (`SetProcessDpiAwarenessContext(-4)` before the first UIA call). Otherwise UIA virtualises
  `BoundingRectangle` into logical coordinates for DPI-unaware callers. Then everything is physical,
  `k = 1` from the frame match (if the window list in Electron's main process is physical too), and no
  scaling happens. Electron's own `screen` API is in DIPs; keep it out of this path.
- **[port note] macOS:** AX reports **points** in the global top-left-origin space, and so do
  `CGWindowListCopyWindowInfo` bounds, so a frame match gives k = 1 while captures are in pixels. The
  macOS window layer must report frames in pixels (points × `backingScaleFactor` of the window's
  display), so that `matchFrame` finds k = 2. Or the platform layer must give `frameScale` directly. With
  displays at different scales, no single global "physical" space maps linearly from points. That is the
  riskiest part of the macOS port.

---

## 11. Vocabulary: roles, states and action names

### 11.1 Roles

**What the sidecar emits:** `role` is `acc.getRoleName()` verbatim, for nodes, windows, `others`,
`secret_fields` fields, `at_point` chains and `read_element`. In libatspi, that is the role's enum nick
with `-` → space. For `ATSPI_ROLE_EXTENDED`, it is the app's own `GetRoleName` string, so any custom
string can appear (TS quotes non-plain role words: `screenWord`, elements.ts:313). The sidecar adds only
two values of its own:

- `"overview"`: `shell_overlays` only.
- `""`: when the role couldn't be read (`describe_window` default, at_point fallback).

Grid cells are always `"table cell"`.

**Full AT-SPI role name list** (`AtspiRole`; the possible values):
invalid, accelerator label, alert, animation, arrow, calendar, canvas, check box, check menu item,
color chooser, column header, combo box, date editor, desktop icon, desktop frame, dial, dialog,
directory pane, drawing area, file chooser, filler, focus traversable, font chooser, frame, glass pane,
html container, icon, image, internal frame, label, layered pane, list, list item, menu, menu bar,
menu item, option pane, page tab, page tab list, panel, password text, popup menu, progress bar,
push button, radio button, radio menu item, root pane, row header, scroll bar, scroll pane, separator,
slider, spin button, split pane, status bar, table, table cell, table column header, table row header,
tearoff menu item, terminal, text, toggle button, tool bar, tool tip, tree, tree table, unknown,
viewport, window, extended, header, footer, paragraph, ruler, application, autocomplete, editbar,
embedded, entry, chart, caption, document frame, heading, page, section, redundant object, form, link,
input method window, table row, tree item, document spreadsheet, document presentation, document text,
document web, document email, comment, list box, grouping, image map, notification, info bar,
level bar, title bar, block quote, audio, video, definition, article, landmark, log, marquee, math,
rating, timer, static, math fraction, math root, subscript, superscript, description list,
description term, description value, footnote, content deletion, content insertion, mark, suggestion,
push button menu, switch.
(The last ones exist only in newer at-spi2-core. The spellings follow the GEnum nick rule, which is
what TS expects: "status bar", "tool bar", "push button menu". Very old libatspi tables spelled a few of
them differently.)

**Roles with special meaning in the sidecar** (a port must map onto these exactly):

| Set | Members | Use |
|---|---|---|
| `SKIP_ROLES` py:78 | filler, panel, section, redundant object, glass pane, layered pane, root pane, scroll pane, viewport, split pane, internal frame, option pane, unknown | not listed when unnamed |
| `MENU_ITEM_ROLES` py:80 | menu item, check menu item, radio menu item | `offscreen` |
| `INTERACTIVE_ROLES` py:85-89 | push button, toggle button, check box, radio button, combo box, text, entry, password text, spin button, slider, menu item, menu, link, page tab, list item, table cell, check menu item, radio menu item, tree item, switch, icon, table column header, column header, table row header, row header, terminal, document text, paragraph | `actions`, `editable` |
| `LAZY_ACTION_ROLES` py:90 | list item, table cell, tree item, table column header, column header, table row header, row header | no `actions` in reads |
| `TEXT_ROLES` py:92 | text, entry, password text, terminal, paragraph, document text, spin button, combo box | `text`, `selection`, secret check |
| `UNNAMED_TEXT_ROLES` py:96 | heading, block quote | text when unnamed (not web) |
| `VALUE_ROLES` py:99 | slider, spin button, scroll bar, progress bar, level bar, dial | `value` |
| `FIELD_ROLES` py:102 | text, entry, password text, spin button, combo box | secret by name or label |
| `LABEL_ROLES` py:104 | label, static, caption | labels |
| `LABELLED_ROLES` py:1656 | FIELD_ROLES + check box, radio button, toggle button, switch, slider | claimed labels |
| `WINDOW_ROLES` py:355 | frame, window, dialog, alert, file chooser, desktop frame, application | stop when looking up |
| `OWN_NAME_ROLES` py:483 | FIELD_ROLES + WINDOW_ROLES + static, document web, document frame | names never "made from contents" |
| `DOCUMENT_ROLES` py:2330 | document web, document frame | page clipping, Collection search |
| `CLIP_ROLES` py:1415 | scroll pane, viewport | clipping |
| `PANE_ROLE` py:1482 | document spreadsheet | frozen panes |
| `SHELL_ROLES` py:2560 | dialog, alert, notification, file chooser | shell overlays |
| `GENERIC_ROLES` py:3839 | panel, filler, unknown, redundant object | at_point `empty` |
| `POPUP_ROLES` py:4006 | window | at_point popups |
| `MENU_HOLDERS` py:4036 | filler, panel, root pane, layered pane, glass pane, menu bar, split pane, unknown, scroll pane, viewport | open-menu search |
| `ROW_LIST_ROLES` py:2985 | table, tree table, tree | read_element `selected` |
| others | "table cell" (grid, address cells), "menu" (`open`), "combo box" (`selected`), "page tab" (at_point), "scroll bar" (scroll fraction), "list"/"list box"/"menu" (option holder), "application" (window_active, visible_part) | |

**Roles the TS core keys on** (from grepping `app/main`):
push button, push button menu, button\*, split button\*, toggle button, link, menu item, check menu item,
radio menu item, menu, menu bar, popup menu, check box, radio button, switch, combo box, page tab,
page tab list, text, entry, password text, spin button, slider, scroll bar, list item, table cell,
tree item, icon, list, list box, table, tree, tree table, label, static, caption, heading, block quote,
paragraph, section, document text, document web, document frame, document spreadsheet, embedded, terminal,
frame, window, dialog, alert, alert dialog\*, file chooser, color chooser, font chooser, application,
root pane, panel, filler, unknown, redundant object, glass pane, layered pane, scroll pane, viewport,
split pane, internal frame, option pane, tool bar, status bar, tool tip, image, separator, form,
overview, notification, search\*, search box\*.
(\* not AT-SPI names; TS already accepts them.) Key places:
- worker.ts:154-196, 354-360, 479-562;
- policy.ts:370, 505, 635, 666, 1353, 1432, 1502, 1563, 1815-1816 (`password text` never typed into,
  `terminal` never typed into);
- elements.ts:10-22, 61, 202, 325;
- windows.ts:55 (`EMBEDDED`).

### 11.2 States

- **On the wire:** only `INTERESTING_STATES` (py:81-82), as pyatspi spells them (`stateToString`:
  the constant name lowercased, `_` → space). They appear in `AxNode.states` and `ElementInfo.states`:
  **focused, checked, selected, expanded, collapsed, pressed, editable, multi line, sensitive, enabled,
  focusable, active.**
  - TS counts an element as disabled when it has **neither `sensitive` nor `enabled`**
    (elements.ts:406). Emit both for enabled elements.
  - `active` on nodes is GTK's cursor cell (`row_has_cursor`); on windows it is a boolean field.
- **Window booleans:** `AxWindow.active` and `OtherWindow.active`/`modal`.
- **Used internally, never sent:** showing, visible, defunct, modal, manages descendants, vertical
  (scroll bars), plus the ones above.
- The full AT-SPI state vocabulary, for reference: invalid, active, armed, busy, checked, collapsed,
  defunct, editable, enabled, expandable, expanded, focusable, focused, has tooltip, horizontal,
  iconified, modal, multi line, multiselectable, opaque, pressed, resizable, selectable, selected,
  sensitive, showing, single line, stale, transient, vertical, visible, manages descendants,
  indeterminate, required, truncated, animated, invalid entry, supports autocompletion, selectable text,
  is default, visited, checkable, has popup, read only.
- TS uses: focused, checked, selected, expanded, pressed, editable, multi line, sensitive, enabled,
  focusable, active, modal (others), plus the change key's `checked`/`pressed`/`expanded`/`selected`/`focused`
  (worker.ts:1256-1259).

### 11.3 Action names (`actions` on nodes)

These are the app's action names, verbatim: GTK "click", "press", "activate", "toggle",
"expand or contract", "edit"; Chromium "click", "check", "uncheck", "open", "clickAncestor", "doDefault",
"select"; Firefox "select", "jump", and so on. TS only prints them (elements.ts:412). The action side
matches them **lowercased** against `ACTION_ALIASES` (py:2702-2709): click, press, activate, jump,
toggle, check, uncheck, select, dodefault, open, clickancestor, expand or contract. The one-way actions
are check, select and uncheck.

---

## 12. Port notes: suggested UIA and AX mappings

These are recommendations. Verify each against real apps; the contract is §6-§11.

### 12.1 Process and framing

- **Windows:** `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>`.
  - Set `[Console]::InputEncoding`/`OutputEncoding` to `New-Object Text.UTF8Encoding $false`.
  - Write through one `StreamWriter` on `[Console]::OpenStandardOutput()` with AutoFlush.
  - Escape non-ASCII as `\uXXXX`, as Python does.
  - Keep pipeline output (`Write-Output`, implicit output, `Add-Type` warnings) away from stdout.
  - PowerShell may write `#< CLIXML` to stderr. That is harmless, since TS only logs stderr.
  - Compiling with `Add-Type` (csc) can take seconds, longer with antivirus scanning. **The first
    request has the same 5 s clock and there is no handshake.** Either cache the compiled assembly
    (`Add-Type -OutputAssembly`, then load it on the next start), or add a ready line and a longer first
    timeout on the TS side.
- **macOS:** spawn `process.execPath <script>` with `ELECTRON_RUN_AS_NODE=1`, like desk-agent. Call
  `AXUIElementSetMessagingTimeout(systemWide, 0.8)`, the equivalent of `CALL_TIMEOUT_MS`. Check that TCC
  attributes Accessibility permission to Ember.app for this child (the "responsible process").
- **TS client:** generalise `(python, [script])` into a command plus args. Keep `EMBER_ATSPI_ID_BASE`
  (or a renamed equivalent) and the preamble.

### 12.2 Per-call timeouts and busy apps (Windows)

The managed `System.Windows.Automation` client has **no per-call timeout**: a hung provider can block a
call for a long time. The sidecar would then miss the TS 5 s deadline and be killed, losing its
hung-app memory, and the next read hangs again. Options:

- the COM `IUIAutomation2` (`ConnectionTimeout`/`TransactionTimeout`, through hand-written `ComImport`
  interfaces in C# 5);
- or run each element's calls on a worker thread with an ~800 ms wait, and abandon it.

Either way, keep the "> 0.7 s = busy" logic, so the result says `busy` instead of timing out.

### 12.3 Role mapping (suggested)

| AT-SPI role | UIA (ControlType / property) | AX (role / subrole) |
|---|---|---|
| frame | Window (top-level, not modal) | AXWindow / AXStandardWindow |
| dialog | Window with `WindowPattern.IsModal`, or a Window inside a Window | AXWindow / AXDialog, AXSystemDialog; AXSheet |
| window | Menu popups/Popup windows (class `#32768`, popups) | AXWindow / AXFloatingWindow; popover |
| push button | Button | AXButton |
| toggle button | Button with TogglePattern | AXCheckBox / AXToggle; AXDisclosureTriangle |
| switch | Button with Toggle, class ToggleSwitch | AXCheckBox / AXSwitch |
| check box | CheckBox | AXCheckBox |
| radio button | RadioButton | AXRadioButton (not in a tab group) |
| combo box | ComboBox | AXComboBox, AXPopUpButton |
| entry | Edit, single line | AXTextField, AXSearchField |
| text (+ state "multi line") | Edit, multi-line | AXTextArea |
| password text | Edit with `IsPassword` | AXTextField / AXSecureTextField |
| document text | Document (not web) | AXTextArea in a document window |
| document web | Document inside a browser (FrameworkId Chrome/Gecko) | AXWebArea |
| label (static inside web pages) | Text | AXStaticText |
| link | Hyperlink | AXLink |
| image | Image | AXImage |
| heading | Text with heading level (Chromium) | AXHeading |
| list / list box | List | AXList |
| list item | ListItem | AXRow in AXList, AXCell |
| table / tree table | DataGrid, Table | AXTable, AXGrid / AXOutline |
| table cell | DataItem or a grid cell (GridItemPattern) | AXCell |
| tree / tree item | Tree / TreeItem | AXOutline / AXRow (outline row) |
| column header, table column header | HeaderItem / Header | AXColumn header (AXSortButton) |
| menu bar / menu / menu item | MenuBar / Menu (and a top-level item with submenu) / MenuItem | AXMenuBar / AXMenuBarItem, AXMenu / AXMenuItem |
| check menu item / radio menu item | MenuItem with Toggle / SelectionItem | AXMenuItem with AXMenuItemMarkChar |
| page tab list / page tab | Tab / TabItem | AXTabGroup / AXRadioButton in it |
| slider | Slider | AXSlider |
| spin button | Spinner | AXIncrementor |
| progress bar / level bar | ProgressBar | AXProgressIndicator, AXBusyIndicator / AXLevelIndicator |
| scroll bar | ScrollBar | AXScrollBar |
| scroll pane | Pane with ScrollPattern | AXScrollArea |
| split pane | Pane (splitter) | AXSplitGroup |
| tool bar / status bar / tool tip / title bar / separator | ToolBar, AppBar / StatusBar / ToolTip / TitleBar / Separator | AXToolbar / — / AXHelpTag / — / AXSplitter |
| panel (unnamed → skipped) | Pane, Group, Custom | AXGroup, AXLayoutArea, AXUnknown |
| application | (the process root) | AXApplication |

### 12.4 State mapping (suggested)

| state | UIA | AX |
|---|---|---|
| focused | `HasKeyboardFocus` | `AXFocused` |
| checked | `TogglePattern.ToggleState == On` | `AXValue == 1` (check box, radio) |
| pressed | toggle button On | `AXValue == 1` (toggle) |
| selected | `SelectionItemPattern.IsSelected` | `AXSelected` |
| expanded / collapsed | `ExpandCollapsePattern` (Expanded or PartiallyExpanded / Collapsed) | `AXExpanded` true/false |
| editable | ValuePattern not ReadOnly, or a TextPattern edit that is enabled | `AXValue` settable (`AXUIElementIsAttributeSettable`) |
| multi line | multi-line Edit, Document | AXTextArea |
| sensitive + enabled | `IsEnabled` (emit both) | `AXEnabled` (emit both) |
| focusable | `IsKeyboardFocusable` | `AXFocused` settable |
| active | window = foreground | window = `AXMain` and app frontmost |
| (showing/visible filter) | `!IsOffscreen` | no attribute: frame intersects the visible rect of every `AXScrollArea` ancestor and the window, and not `AXHidden` |
| modal | `WindowPattern.IsModal` | `AXModal` |

### 12.5 Other mappings

- **Keys** `[bus, path]`:
  - UIA: `["uia:<pid>", RuntimeId joined by "."]`.
  - AX: `["ax:<pid>", <stable element identity>]`. AX has no persistent id. Verify whether
    `CFHash(AXUIElementRef)` is stable across sidecar restarts; if not, fall back to an index path from
    the window.
- **Window `path`:** must be non-null and stable while the window is open. `unreadSecrets` refuses
  screenshots of a truncated or busy read without it (index.ts:514-517), and `at_point` needs it.
  - UIA: HWND as a string (`NativeWindowHandle`).
  - AX: `CGWindowID` (private `_AXUIElementGetWindow`) as a string.
- **Labels:**
  - `LABELLED_BY`: UIA `LabeledBy`; AX `AXTitleUIElement` / `AXLinkedUIElements`.
  - placeholder: AX `AXPlaceholderValue`; UIA has no standard property (Chromium may put it in `HelpText`).
- **Values:**
  - selection text: UIA `TextPattern.GetSelection()`; AX `AXSelectedText`.
  - combo `selected`: UIA `SelectionPattern.GetSelection()[0].Name`, or `ValuePattern.Value`; AX
    `AXValue` / `AXTitle` of an AXPopUpButton.
  - `value`: UIA `RangeValuePattern.Value`; AX `AXValue` (number).
- **"Named from contents"** (§8.4): Chromium on Windows and macOS has no `explicit-name` attribute.
  Treat web-engine container names conservatively: check them with `name_says_secret`, or withhold.
- **`at_point`:**
  - UIA: `AutomationElement.FromPoint`, then walk up, then reverse into outermost first, from below the
    window.
  - AX: `AXUIElementCopyElementAtPosition(app, x, y)` (points), same treatment.
  - Chain bounds must equal `read_element` bounds.
- **Spreadsheets:** the `grid` contract is role `table` for the sheet with `size`, cells as `table cell`
  named "B7" with `grid: true` and `text` = displayed value, and `read_element` with `value`/`formula`.
  For Excel: Excel's UIA DataGrid and DataItem cells with `GridItemPattern`; the "Formula" equivalent is
  `ValuePattern`/`LegacyIAccessible.Value`. Verify the names.

---

## 13. Risks and surprises

1. **Quoted KeyError messages**: `'element N is no longer known; read the window again'`, with the
   quotes. Match by substring.
2. **`read_element` differs from `read_window`**:
   - `text` is `""` for empty text, it is reported for any element with Text, and it is cut at 2000
     characters (200 in reads);
   - `value` comes from any element with Value (200 vs any);
   - `selected` covers tables and trees too.
   - Worker logic relies on `text === undefined` meaning "unreadable".
3. **Every request has a 5 s clock that starts when it is written**, including queued ones (`whereNow`
   sends up to 24 at once) and the first request to a new process (no handshake). A timeout kills the
   process and fails every queued request.
4. **Per-call timeouts and "> 0.7 s gap = busy" are part of correctness.** UIA's managed client lacks
   them (§12.2).
5. **Hidden-node filtering is a security property**, not an optimisation. AX has no SHOWING state.
6. **Secret rules must be identical in all three sidecars plus TS**: the shared fixtures, normalisation,
   word boundaries, `remember_secrets` keys that last across restarts, and withholding when time runs
   out ("fail closed").
7. **Window `path` must exist and stay stable**, or Ember refuses screenshots of busy or truncated
   windows and can't use `at_point` or `secret_fields`.
8. **Node invariants:** `nodes[0]` is the window frame (depth 0). `parent` is the nearest *listed*
   ancestor. `depth` is the real tree depth. Pre-order. Zero-size elements aren't listed, but their
   children are.
9. **Grid cells don't count against `maxNodes`.** A read can hold up to 400 nodes + 400 grid cells +
   cursor cells. `maxNodes` and `maxDepth` are never sent by TS, and `WORKER_LINES = 400` mirrors `MAX_NODES`.
10. **`shell_overlays` is GNOME-only.** `complete: false` blocks screenshots; an error counts as "no
    overlays".
11. **HiDPI comes from X11 frame matching.** Windows needs a Per-Monitor-V2 sidecar. On macOS (points
    vs pixels, mixed-DPI displays), the frame-match idea breaks unless the window layer reports pixels.
12. **IDs from `secret_fields` are new on every call** and go into the newest kept read.
13. **`ping` and `focus` aren't used by TS.** `status` is used only for reviving and in tests.
14. **NaN or Infinity anywhere turns the whole answer into an error.** JSON must be ASCII-safe and one
    line per answer.
15. **The answer to the `remember_secrets` preamble sets `answered`**, so a helper that answered only
    that one is revived after it dies.
16. **`never_looked` returns the window's real title**. TS blanks it, and a port must keep it out of logs.
17. **`list_windows` lists busy apps' windows from memory** (`busy: true`). If the sidecar is killed,
    that memory is gone.
