# What the TypeScript side expects from the accessibility sidecar

Status: spec for porting. Everything here was read from the code at commit `b67b02e`. Line numbers are 1-based and refer to:

| Short name | File |
|---|---|
| `sidecar.ts` | `app/main/perception/sidecar.ts` (the JSON-RPC client, `AtspiSidecar`, and every wire type) |
| `index.ts` | `app/main/perception/index.ts` (`Perception`) |
| `elements.ts` | `app/main/perception/elements.ts` |
| `windows.ts` | `app/main/perception/windows.ts` |
| `marks.ts` | `app/main/perception/marks.ts` |
| `policy.ts` | `app/main/policy/policy.ts` |
| `worker.ts` | `app/main/agent/worker.ts` |
| `place.ts` | `app/main/desk/place.ts` |
| `apps.ts` | `app/shared/apps.ts` |
| `system.ts` | `app/main/hands/system.ts` (only for `isTerminalApp`, which the policy calls with the sidecar's `app`) |
| `py` | `sidecar/atspi/ember_atspi.py` (the Linux sidecar; quoted wherever the TS relies on behaviour it implements) |

This document is the contract a Windows (UIA) or macOS (AX) sidecar has to meet so that the TS logic keeps working without changes. Where the TS logic cannot keep working without changes, section 13 says so.

---

## 0. One-paragraph summary

The TS talks to one sidecar process per desktop over newline-delimited JSON-RPC 2.0 on stdio. It calls 15 methods (`status`, `list_windows`, `read_window`, `remember_secrets`, `mark_secret`, `secret_fields`, `shell_overlays`, `at_point`, `read_element`, `can_do`, `do_action`, `set_text`, `set_value`, `select_option`, `list_options`). The TS logic does not treat roles and states as opaque. It matches about 70 AT-SPI role names (lowercase with spaces, such as `"push button"`), 9 state names, 3 action names and 4 error-message substrings. It assumes a tree in pre-order with `parent`/`depth`, and it requires that an element showing as "enabled" carries `"enabled"` or `"sensitive"`. Windows are matched to the platform's window stack by `matchFrame` (pid or exact title, plus the same shape and place, with an HiDPI scale inferred from the size ratio). That match is required for every window-scope screenshot. App identity is the free-text `app` field. It feeds never-look, grants, terminal refusal, security-prompt refusal, Ember's own windows, policy heuristics (web, mail and office apps) and the names users see through `friendlyApp`. Section 12 lists the riskiest findings.

---

## 1. Transport contract (`sidecar.ts`)

### 1.1 Process and framing
- Spawned by `AtspiSidecar.ensure()` (`sidecar.ts:213-246`): `spawn(this.python, [this.script], { stdio: pipe×3, env: { ...env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", EMBER_ATSPI_ID_BASE: String(++idBlocks * ID_BLOCK) } })`. **The command is hard-wired to "interpreter + script"** (`python`, `script` constructor args, `sidecar.ts:211`). A PowerShell or Node sidecar needs this generalised: an argv array and an env overlay such as `ELECTRON_RUN_AS_NODE=1`. See section 13.
- Constructed at `main.ts:1167` (user's desktop) and `place.ts:210` (Linux desk, with the desk's env).
- Requests: one line, `{"jsonrpc":"2.0","id":<int>,"method":<string>,"params":<object>}` + `"\n"` (`sidecar.ts:323`). `params` is always an object (default `{}`).
- Responses: one line of JSON per request. `{"id":<same int>,"result":…}` or `{"id":…,"error":{"message":<string>}}` (`sidecar.ts:260-277`). `error.message` becomes `new Error(message)`. Callers string-match it (section 7.4). Extra keys (`jsonrpc`, `error.detail`) are ignored.
- Lines that are not valid JSON are logged (`sidecar.bad_line`) and dropped. The request they were meant to answer then times out (`sidecar.ts:264-268`). **Nothing but protocol may go to stdout.** stderr is logged at debug level, except lines that match `/dconf-WARNING|Gtk-WARNING/` (`sidecar.ts:224-226`).
- Responses are matched by `id`. Order does not matter to the client, but see 1.3.
- Node's `readline` is used, so CRLF line ends are fine.

### 1.2 Ids handed to the sidecar
- `EMBER_ATSPI_ID_BASE` env var = `k * 10_000_000` for the k-th process this Ember run started (`sidecar.ts:181, 219`). The sidecar **must** number element ids from `base + 1` upward (py `first_id`, py:758-768), so an id from another process or an earlier restart never names an element. Ids must stay JSON-safe integers (< 2^53).
- Element id lifetime the TS relies on (py `Snapshots`, py:771-823):
  - every `read_window` with `keep` not `false` starts a new "kept read". The **last 8** kept reads stay addressable (py `KEEP = 8`). The client keeps HiDPI scale info for the last 16 (`sidecar.ts:334-341`).
  - `read_window` with `keep:false` (a "quick look") puts its ids in a scratch slot that the next quick look replaces. It **never** pushes kept reads out (`sidecar.ts:367-372`, `worker.ts:2609`, `2749`). The worker depends on this. Ids from the latest `perceive_window` must survive any number of quick looks (`focusIn`, `cellWithKeyboard`, `scroll` look, `toCellByName`).
  - ids returned by `secret_fields` go into the newest kept read (py `Snapshots.end`, py:799-801).
  - An unknown or expired id gives an error. The Python text is `"element N is no longer known; read the window again"`. The TS treats any error from `read_element` that is not busy as "gone" (section 7.4).

### 1.3 Timeouts, restart, revive
- Every request uses the default timeout of **5000 ms** (`sidecar.ts:311`; no caller passes another). On timeout the pending promise rejects with `"accessibility helper did not answer <method> in 5000 ms"`. The whole process is then **SIGKILLed** and every other pending request rejects with `"accessibility helper was restarted (an earlier request took too long)"` (`sidecar.ts:315-321`).
- The client assumes **one request at a time**: "a stuck call would hold up every later one" (`sidecar.ts:318`). The sidecar must answer within budget, and must answer `busy` instead of blocking on a hung app. Python budgets: read 1.5 s, finding a window 2 s, whole read 3 s, `at_point` 1 s, shell 1+1 s, secret scan 2 s, per-call libatspi timeout 0.8 s (py:51-80).
- After a process that had answered at least once dies, a new one starts at once and gets `status` (`revive`, `sidecar.ts:300-309`). A process that never answered is not restarted on its own. The next request starts one.
- **There is no startup grace.** The first request's 5 s timer starts when it is written, so process start-up counts against it. A sidecar that takes more than about 2 s to start (PowerShell 5.1 + `Add-Type` compiling C# at run time, Defender scanning) will see its first `read_window` time out. That gets it killed, and because it never answered it is not revived. The next request starts another slow process, and so on. See 12 and 13.
- Before anything else, a new process is sent `remember_secrets` (`sidecar.ts:240-244`). Its answer is not awaited, and the reply's id has no pending entry, so it is dropped. The reply must still be one valid JSON line.
- `stop()` sends SIGTERM (`sidecar.ts:449-452`). On Windows, Node maps `kill()` to TerminateProcess.

### 1.4 Client-side processing the sidecar must not duplicate
- `readWindow` removes `secretKeys` and `withheldKeys` from the result before handing it on, and remembers them (up to 4096 each) to replay to the next process (`sidecar.ts:374-379`, `249-258`). `atPoint` removes `withheldKeys` (`sidecar.ts:415-418`). `secretFields` removes `secretKeys` (`sidecar.ts:396-399`). `markSecret` remembers `keys` and `withheldKeys` (`sidecar.ts:385-388`).
- HiDPI: `Perception.read` works out per-element scales and calls `scaleElements(ids, k, keep)` (`index.ts:150-157`). From then on the client scales `bounds` and `shown` in `read_element` and in action results (`before`, `after`) for those ids (`sidecar.ts:354-361`). `at_point` and `secret_fields` bounds come back **unscaled** and the callers scale them (`index.ts:185`, `457`, `474`). **The sidecar always reports coordinates in the unit the app reports.** It never scales them itself.

---

## 2. Every sidecar method the TS calls, from where, with which params

Methods the Python sidecar has but the TS **never calls**: `ping`, `focus` (py:4192-4210). `readWindow`'s `maxDepth` and `maxNodes` params are typed (`sidecar.ts:373`) but no caller sends them.

### 2.1 `status`
- Caller: `revive()` only (`sidecar.ts:307`). `AtspiSidecar.status()` (`sidecar.ts:363`) has no callers. The result is ignored.
- Result type `SidecarStatus { version: number; python: string; toolkitAccessibility: boolean | null; apps: number }` (`sidecar.ts:160`). It must be cheap and must not prompt the user. (Accessibility diagnostics live elsewhere: `main.ts:122-138` probes gsettings and `import pyatspi`, both Linux-only.)

### 2.2 `list_windows`
- Callers: `Perception.windows()` (`index.ts:573`) and `Perception.privateWindows()` (`index.ts:607`). `windows()` is used by the worker's `list_windows` tool (`worker.ts:910`), `open_app` (`worker.ts:1014`, `1020`), `open_on_desk` (`worker.ts:989`, `993`) and, when there is no X11, by `Perception.openWindows()` (`index.ts:386`).
- Params: `{ ownPid: <Ember's pid> }`.
- Result: `{ windows: AxWindow[] }` (see 3.2). Contents:
  - every top-level window that is showing **or** active, from every app except `ownPid`'s (py:2140-2154).
  - apps that did not answer this time get their windows **as last seen**, with `busy: true, active: false` (py:2150-2153). The worker shows these as `(busy, not answering)` so the model waits (`worker.ts:913-914`).

### 2.3 `read_window`
- Caller: `Perception.read()` only (`index.ts:127`). Everything else reaches it through `read`:
  - `Perception.focused()` → `read({pid, title} of the platform's active window)` (`index.ts:92-98`), used by `quickContext` (`index.ts:277`), `describe` (`index.ts:352`) and `perceive` when there is no target (`index.ts:406`).
  - `Perception.perceive({target})` (`index.ts:406`) ← worker `perceive` (`worker.ts:1429`) ← tools `perceive_window`, `switch_window`.
  - worker quick looks with `keep:false`: `cellRefused` (`worker.ts:2472`, `cells:[cell]`), `windowWords` (`worker.ts:2491`, target `{pid?, title}`), `cellNow` (`worker.ts:2522`, `cells`), `toCellByName` (`worker.ts:2558`), `cellWithKeyboard` (`worker.ts:2582`, `cells`), `focusIn` (`worker.ts:2610`), `scroll` look (`worker.ts:2750`).
  - `host.cantGuide` (`agent/host.ts:1086`, target from quickContext).
- Params, exactly as built at `index.ts:118-127`:
  - `{pid, path}` when the target has both (that window, or none: never another one in its place, py:2190-2195), **or** `{pid?, title?}`, **or** `{}` (meaning "the active window"). A target with `path` but no `pid` is never sent (`index.ts:120`: the read returns `{window:null}`).
  - plus always `ownPid`. Plus `neverLook: string[]` and `skipPids: number[]` when the never-look list is not empty. `skipPids` = pids of stack windows whose `wmClass` matches never-look (`index.ts:126`). Plus `keep:false` for quick looks. Plus `cells: string[]` (spreadsheet addresses such as `"C62"`, looked at first) when given.
- Window lookup semantics the TS relies on (py `find_window`/`best_window`, py:2157-2205): `title` is compared **lowercased**, as an exact match (+6) or a substring (+4). Same pid +8, active +2, showing +1. With a pid, the other apps are tried only when no window of that pid matches pid+title (score < 10). Without pid and title, the result is the active window. Ember's own windows (`ownPid`) are never found, not even as the active window.
- Result: `ReadWindowResult` (`sidecar.ts:68-83`) plus `secretKeys` and `withheldKeys`:
  ```
  { window: AxWindow|null, nodes: AxNode[], truncated?: boolean, cut?: string[], slow?: boolean,
    busy?: boolean, blocked?: boolean, others?: OtherWindow[], ms: number,
    secretKeys?: [string,string][], withheldKeys?: [string,string][] }
  ```
  - not found: `{window:null, nodes:[], busy:<bool>, ms}`. `busy:true` when the app may simply not have answered (py:2240-2248). The TS turns `busy` into "app is busy" rather than "closed" (`index.ts:147`, `worker.ts:1436`).
  - never-look: `{window, nodes:[], blocked:true, ms}` (py:2254-2255). The TS checks again itself (`index.ts:138-146`).
  - `truncated` is true when cut short for want of room or time. `cut` is a subset of `["nodes","depth"]` (py also uses `"loading"` internally). `slow` is true when the time budget ran out. `busy` is true when the app stopped answering partway. **How the TS maps them** (`index.ts:161`): `slow` → `"time"`; otherwise `truncated` with `cut` not empty and not containing `"nodes"` → `"depth"`; otherwise `truncated` → `"nodes"`; otherwise `null`.
  - `busy` makes the TS retry once after 300 ms and keep the second answer unless it has fewer nodes and is busy again (`index.ts:129-135`).
  - `others`: see 3.3.

### 2.4 `remember_secrets`
- Caller: `ensure()` on every new process (`sidecar.ts:243`).
- Params: `{ keys: [string,string][], withheld?: [string,string][] }`. These are the opaque secret-field keys and withheld-name keys earlier processes returned.
- Result: anything (Python returns `{count}`). Not read.

### 2.5 `mark_secret`
- Caller: `Perception.withSecrets()` (`index.ts:202`), with the ids of fields the TS judged secret that the sidecar had not flagged (a field beside "Show password", an unnamed field under "Card number").
- Params: `{ ids: number[] }` (the Python caps this at 64).
- Result: `{ keys: [string,string][], withheldKeys: [string,string][] }`. From then on the sidecar must refuse `set_text`, `set_value` and `select_option` on those elements and must never report their contents (py:2536-2557).

### 2.6 `secret_fields`
- Caller: `Perception.unreadSecrets()` (`index.ts:519`), before **every** screenshot of a window that has `pid` and `path` (`index.ts:453`, `472`).
- Params: `{ pid: number, path: string }`.
- Result: `SecretFieldsResult { fields: {id, role, bounds}[], complete: boolean, busy?: boolean, ms }` + `secretKeys` (`sidecar.ts:86-93`).
  - must find **every** secret field showing in the whole window, beyond the 400-node read limit.
  - `complete:false` means the TS takes **no screenshot**. `busy` picks the wording (`index.ts:520-521`).
  - bounds are as the app reports them. The TS masks both the unscaled and the scaled rectangle (`index.ts:457`, `634`).
- When the window has no `pid` or no `path`, the TS takes a picture only if the read was complete and not busy (`index.ts:514-517`). **So without `path`, any truncated read means no screenshot.**

### 2.7 `shell_overlays`
- Caller: `Perception.shellOverlays()` (`index.ts:534`), before every screenshot (`index.ts:421`) and in `systemDialogOpen()` (`index.ts:543`) ← worker `withCursor` before every borrow of the user's mouse or keyboard (`worker.ts:2915`).
- Params: none (`{}`).
- Result: `{ overlays: ShellOverlay[], complete?: boolean }`, where `ShellOverlay = { role, name, text, bounds|null }` (`sidecar.ts:96`).
- TS meaning (`shellCovers`, `windows.ts:121-128`):
  - any overlay whose role is **not** `"notification"` or `"overview"` is a system dialog: no screenshot, and no borrowing of mouse or keyboard.
  - `"overview"` (Activities overview, window switcher) means no screenshot.
  - `"notification"` and other overlays with bounds are blacked out.
  - `complete === false` counts as a dialog (fail closed). A missing `complete` counts as complete (`index.ts:535`).
  - an error is logged and treated as **no overlays** (fail open, `index.ts:536-539`).
- Without GNOME Shell the Python returns `{overlays:[], complete:true}`. The Windows and macOS equivalents are listed in 8.5.

### 2.8 `at_point`
- Caller: `Perception.atPoint()` (`index.ts:183`) ← worker `mustAimAt` (`worker.ts:2090`, before any mouse click or wheel over an element) and `scroll` `underWheel` (`worker.ts:2815`).
- Params (`index.ts:183`): `{ pid, path, x, y, ownPid, menus?: false, neverLook?, skipPids? }`. `x`,`y` = `Math.floor(Math.round(p)/k)`: **integer, in the app's reported units**. `menus:false` is sent when the platform stack shows no override-redirect popup of that pid covering the point (`index.ts:181-182`).
- Result: `AtPointResult { chain: PointElement[], busy?, blocked?, found?, ms }` + `withheldKeys` (`sidecar.ts:103-106`). `PointElement = { role, name, bounds|null, secret?, empty? }`.
- Semantics the worker relies on (py `at_point`, py:4116-4190):
  1. **Outermost first, and the window itself is NOT in the chain.**
  2. If one of the app's popup windows (role `"window"`) or an open menu (role `"menu"`) covers the point, the chain **starts with it**. `mustAimAt` reads `chain[0].role` matching `/^(menu|window)$/` as "an open menu or popup lies over the element" and refuses the click (`worker.ts:2108-2111`). **A sidecar that puts the target window first with role `"window"` would block every borrowed click.**
  3. Then each level down, as deep as the app tells. It may include holders (`panel`, `filler`, `scroll pane`…), which the worker treats as "unknown" (`HOLDERS`, `worker.ts:360`, `382`).
  4. A secret field comes **nameless, last**, with `secret:true`. Nothing inside it is listed.
  5. `empty:true` on the last element when it is an empty grouping container (`worker.ts:374`, `2825`).
  6. Role strings and bounds must be **identical** to the ones `read_window` gives for the same element. `aimedAt` requires `last.role === role && sameRect(last.bounds, b)` within 1 px (`worker.ts:375`, `324`).
  - `busy`, `blocked` or `found:false` → the TS returns `null` ("can't tell") (`index.ts:184`).

### 2.9 `read_element`
- Callers (the element "as it is now"):
  - `index.ts:501` (re-checking a secret field's place while a picture is taken)
  - `worker.ts:927` (toggle pre-check), `1043` (point_at), `1248`, `1331`, `1336` (wait_for_click), `1505` (`fresh`, before every action), `1617` (`stillSame`), `1710`, `1892`, `1956`, `2003`, `2008` (`notTurned`), `2036` (`untilFocused`), `2156` (`holds`, paste check), `2953` and `2996` (verify after borrow).
  - with `{shown:true}`: `worker.ts:1873`, `1931`, `1941`, `2761` (where to aim the mouse).
  - with `{formula:true}`: `worker.ts:2520` (spreadsheet cell).
- Params: `{ id, shown?: true, formula?: true }` (`sidecar.ts:426-428`).
- Result: `ElementInfo` (3.5). Errors: "busy" (matches the busy regex) or anything else, which means gone.

### 2.10 `can_do`
- Caller: worker `route()` (`worker.ts:1783`) before click, toggle, text and value actions, to decide between tier 1 (accessibility) and borrowing the mouse **before** asking the user anything.
- Params: `{ id, kind: "click"|"toggle"|"text"|"value", caret: boolean }`. `caret` is true only for `type_text` mode `"insert"`.
- Result: `CanDo` (3.6). It must check exactly what the real action would check, and do nothing.

### 2.11 `do_action`
- Callers: `click` tool `doAction(id, "click")` (`worker.ts:921`), `toggle` tool `doAction(id, "toggle")` (`worker.ts:934`). **Only `"click"` and `"toggle"` are ever sent.**
- Params: `{ id, action }`.
- Result: `ActionResult` (3.7).

### 2.12 `set_text`
- Caller: `type_text` tool (`worker.ts:948`).
- Params: `{ id, text, mode: "replace"|"insert"|"append" }`. `insert` goes at the caret, `append` at the end.
- Result: `ActionResult`. `after.text` must hold the field's text, up to 2000 characters, so `textNotTaken` can check it went in (`worker.ts:724-729`, `1736`). It must refuse secret and password fields with an error.

### 2.13 `set_value`
- Caller: `set_value` tool (`worker.ts:963`).
- Params: `{ id, value: number }`. Out of range is an error.
- Result: `{ ok, after }` (the Python has no `before`).

### 2.14 `select_option`
- Caller: `chooseOption` (`worker.ts:1661`), after `list_options` and an exact-name match (`pickOption`, `worker.ts:689-695`).
- Params: `{ id, option: <exact option name> }`.
- Result: `ActionResult & { option, unchecked?, already? }`. The TS reads `unchecked` (`worker.ts:1661-1665`). `already` is ignored.

### 2.15 `list_options`
- Caller: `chooseOption` (`worker.ts:1646`).
- Params: `{ id }`.
- Result: `{ options: string[], left?: number }`. `left` = rows of a long list not named in time (`worker.ts:1653-1656`). An error containing `background_unavailable` → "no options Ember can choose by accessibility" (`worker.ts:1649`).

---

## 3. Wire types, field by field, with their consumers

### 3.1 `Bounds { x, y, width, height }` (`sidecar.ts:16`)
- Screen coordinates, top-left origin, **in the unit the app reports**. The TS works out the unit by matching window frames (section 8), so window bounds and node bounds must be in the **same** unit.
- `null` = no position. The Python sends `null` for GTK's `INT_MIN` and for negative sizes (py:191-195).
- Elements whose bounds have **zero width or height are not listed** (py:1594).

### 3.2 `AxWindow` (`sidecar.ts:52-63`)
| field | meaning | consumers |
|---|---|---|
| `app: string` | the app's name as the accessibility layer gives it (on Linux, the AT-SPI application name: `"gedit"`, `"Firefox"`, `"soffice"`, `"nautilus"`, `"gnome-terminal-server"`, `"electron"`…) | never-look and security (`index.ts:107`, `139`, `162`, `579`, `608`), `quickContext` target.app and text (`index.ts:286-291`), `serializeElements` attribute `app=` (`elements.ts:425`), worker `this.window.app` → `ActionRequest.app` → policy: never-look (`policy.ts:1810`), `isSecurityWindow` (`1812`), `isEmberWindow` (`1814`), `isTerminalApp` (`1817`, `1819`), grants keyed by `app.toLowerCase()` (`1854`, `worker.ts:3123`), `TABBED_APP`, `WEB_APP` and `OFFICE_APP` heuristics (`policy.ts:680`, `1520-1521`), carry check `elsewhere()` (`policy.ts:673`), `friendlyApp` in prompts. Also `open_app`'s window detection `programs.has(w.app.toLowerCase())` (`worker.ts:1016`), `list_windows` output and `isEmberWindow` filter (`worker.ts:910`), audit, lease key fallback (`worker.ts:1714`), `carriedMenuApproval` (`worker.ts:1629`). Section 9 covers it in full. |
| `pid: number\|null` | owning process | `matchFrame` (`windows.ts:36`), frame-scale cache key (`index.ts:226`), `quickContext` target (`index.ts:281`), `secret_fields`/`at_point` key, worker `target.pid` → `findWindow(title, pid)` for borrowing (`worker.ts:2928`), `windowKey` (`worker.ts:1480`), `ReadSource.pid`, `windowId.pid` → `isEmberWindow` (`policy.ts:1814`), `elsewhere()` (`policy.ts:675-677`), `cursor.activeWindow().pid` comparisons (`worker.ts:1395`) |
| `path?: string` | stable id of the frame: with the pid it names this one window until it closes, whatever its title (on Linux, the frame's D-Bus object path) | `read_window`/`at_point`/`secret_fields` exact targeting. Worker `this.target.path` (`worker.ts:1450`). `windowKey` (`worker.ts:1480`). `ReadSource.path` and `elsewhere()`: two reads are "the same window" only when **both** have pid and path (`policy.ts:676-677`). Without it, any title change counts as another window, so more carry questions. Without it, `mustAimAt` and `scroll` cannot use `at_point` (`worker.ts:2082`, `2786`). Without it, `secret_fields` is skipped (2.6). |
| `name: string` | window title | private-title checks, `matchFrame` exact-title tie-break (`windows.ts:37`), `switch_window` verification `p.window.name.toLowerCase().includes(expectTitle.toLowerCase())` (`worker.ts:1438`), `this.window.name` → **`cursor.findWindow(this.window.name, pid)`**: the platform window's title must equal it for any borrowed input (`worker.ts:2928`, `2987`), lease key (`worker.ts:1714`, `2933`), `dialogNote` (`worker.ts:206-219`), `ActionRequest.window` (policy riskiness by title, `FILE_DIALOG_TITLE`, `SECURITY_TITLE`) |
| `role: string` | window role: `"frame"`, `"dialog"`, `"alert"`, `"file chooser"`, `"color chooser"`, `"font chooser"`, `"window"` (popups) | worker `this.window.role` (`worker.ts:1445`) → `windowId.role` → policy `DIALOG_WINDOW` (`policy.ts:666`, `675`, `1519`, `1598`, `1663`), `enterMaySend` file chooser (`policy.ts:1519`). `dialogNote` `QUESTION_ROLE` `/^(dialog\|alert\|alert dialog)$/` (`worker.ts:196`, `210`). `inDialog` `/dialog\|chooser/i` (`worker.ts:1228`). `othersLine` (`index.ts:645`). Desk-only `DIALOG_ROLES` (`place.ts:167`, `worker.ts:3017`) |
| `active: boolean` | the window the user is in | `(focused by the user)` in lists (`index.ts:392`, `worker.ts:914`). `toCellByName` "in front" check `seen.window.active` (`worker.ts:2561`) |
| `bounds: Bounds\|null` | frame rectangle | `matchFrame`/`frameScale` (`index.ts:148-149`, `225-242`). Worker `this.frame` clips aiming (`worker.ts:1447`, `2059`) and `placeOf` (`worker.ts:1534`). `privateWindows` fallback (`index.ts:612`) |
| `busy?: boolean` | listed as last seen | display only |

### 3.3 `OtherWindow { name, role, active, modal }` (`sidecar.ts:66`)
- In `read_window.others`: **the same app's other windows that show and are active or modal**, excluding the one read. At most 5 (py:2217-2234).
- Consumers:
  - `othersLine` puts "Also open in this app: "X" (dialog, modal, the user is in it)…" in front of the model (`index.ts:643-647`).
  - `cellRefused`: `others.find(o => o.active || o.modal)` = the message box that Enter brought up. Its words are then read by `windowWords(box.name)` → `read({pid, title})` (`worker.ts:2474-2478`).
  - `toCellByName`: `others.some(o => o.active)` means a dialog is in front (`worker.ts:2561`).
- Filtered by `isPrivate(window.app, other.name)` (`index.ts:162`).
- On macOS, sheets are inside their window's AX tree, not separate windows. Report them as nodes (role `"dialog"`/`"alert"`, see 6.1), not in `others`. `others` is for separate modal windows (NSPanel/alert windows).

### 3.4 `AxNode` (`sidecar.ts:18-50`): one element of a read
| field | must | consumers |
|---|---|---|
| `id: number` | unique, from the id block (1.2) | everywhere: worker `known` map (`worker.ts:1451`), tool args, marks label (`marks.ts:26`) |
| `parent: number\|null` | id of the nearest **listed** ancestor (skipped holders collapse), `null` for the root | `insideSecrets` (`elements.ts:299-303`), `inferLabels` inner labels (`elements.ts:79-88`), `secretIds` combo-box parent (`elements.ts:194-197`), `withheldIds` walk up (`elements.ts:279-283`), indentation (`elements.ts:375`), `elementScales` (`windows.ts:70`), `wheelControls` (`worker.ts:290`), `tabPage` (`worker.ts:339-340`), `cellOf` and `readSheet`/`sheetSize`/`cellWithKeyboard` (sheet = parent with role `"table"`, `worker.ts:442`, `2499-2509`, `2585`), `dialogAround` (`worker.ts:538-552`), `inWebPage` (`worker.ts:554-560`), `intoSheet` (`worker.ts:526-532`), `clickSelects`/`inDialog`/`placeOf`/`ancestorsOf`/`controlsInside` (`worker.ts:1215-1236`, `1527-1532`, `2121-2149`) |
| `depth: number` | true depth below the window (holders count), **0 = the window itself** | `focusedElement` picks the **deepest** element that says `focused` (`elements.ts:433-437`). `waitForClick` excludes the window with `n.depth > 0` and sorts by depth (`worker.ts:1306-1308`) |
| `role: string` | from the vocabulary in section 6 | everywhere |
| `name: string` | ≤ 200 chars, trimmed. `""` when withheld | labels, policy riskiness, prompts, `isSecretLabel`, `CELL_ADDRESS`, dismiss detection (`worker.ts:230-232`) |
| `states: string[]` | **only** names from the vocabulary in 6.2. The Python filters to `INTERESTING_STATES` (py:83-84) | see 6.2 |
| `bounds: Bounds\|null` | 3.1 | marks, labels by layout, aiming, covering, wheel |
| `actions?: string[]` | the element's own action names, controls only (not rows or cells) | **display only** (`elements.ts:412`). Never matched |
| `text?: string` | text roles only, **≤ 200 chars**, omitted when empty or only U+FFFC. Never for secret fields | `serializeElements`, `quickContext`, `fresh`→`currentText` (policy "replaces N characters", `howMany(n>=200)` = "all the characters", `policy.ts:1359`). **Omitted text on a `READ_TEXT_ROLES` element is read as "" (empty)** (`worker.ts:2614`). Withheld/secret value search (`elements.ts:212-215`). Dialog words (`worker.ts:544-545`) |
| `selection?: string` | selected text, **focused element only**, ≤ 500 chars, never for secrets | `quickContext` (`index.ts:294`), `serializeElements` (`elements.ts:415`). **`focusSelection`: omitted on a `READ_TEXT_ROLES` element = "nothing selected"** (`worker.ts:2615`) → policy `selection` (`policy.ts:1392-1415`; "500 or more" at `1414`) |
| `selected?: string` | a combo box's shown option. Never for a secret one | `namedByValue` (`elements.ts:57-58`), secret-value search (`elements.ts:213`, `289`), `serializeElements` |
| `value?: number` | finite number for slider, spin button, scroll bar, progress bar and similar. Never NaN or Infinity (the client would drop the whole line) | serialization, secret values (`elements.ts:214`), `cellNow` (`worker.ts:2524`) |
| `editable?: boolean` | typed but **never read by the TS**. The TS reads the **`"editable"` state** instead | — |
| `secret?: boolean` | password, payment or one-time-code field. Its `text`, `selection`, `selected` and `value` are never sent | marks skip (`marks.ts:19`), masks (`index.ts:447`), `isSecretNode` (`elements.ts:148-150`), policy deny (`policy.ts:1823`), `chooseOption` refuse (`worker.ts:1640`), cells (`worker.ts:2200`, `2232`) |
| `withheld?: boolean` | its name (and text) were withheld because they say what a secret holds. `name` = `""` | policy `WITHHELD` question (`policy.ts:1693`, `1746`), `nameWithheld` (`worker.ts:568-573`), `placeOf` (`worker.ts:1524`, `1531`) |
| `shown?: Bounds` | the part of `bounds` that shows when clipped by a scroll pane, viewport or the window. **Only when it differs from `bounds`** | marks (`marks.ts:21-22`), `landingSpot` (`worker.ts:2058`) |
| `grid?: boolean` | `true` = a spreadsheet's cell read from its sheet's grid. **`false` = a `"table cell"` whose name looks like a cell address (`/^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}$/`) but is not a spreadsheet's** | `isSheetCell` = `role==="table cell" && grid!==false && CELL_ADDRESS` (`elements.ts:334-335`). See 10 |
| `size?: {rows, columns}` | on the sheet (`"table"`) node | `sheetSize` (`worker.ts:2506-2512`) |

### 3.5 `ElementInfo` (`sidecar.ts:109-132`): `read_element`, and `before`/`after` in action results
| field | notes | consumers |
|---|---|---|
| `role`, `name`, `states`, `bounds` | same vocabulary and units as `AxNode`. `name` `""` when withheld | `fresh`: role must equal the read's or the element "has changed", `isDisabled` check (`worker.ts:1508-1509`). Toggles `isOn` (`worker.ts:929`, `2005`). `waitForClick` change key (`worker.ts:1259`). `targetBox`/`stillSame`/`landingSpot`/`untilFocused` same role and name (`worker.ts:1420`, `1620`, `2052`, `2038-2039`) |
| `text?` | **up to 2000 chars** (py `text_of(acc, 2000)`) | `TEXT_READ_LIMIT = 2000`: text this long counts as unreadable or cut (`worker.ts:152`, `725`, `2164`). Paste verification (`worker.ts:2155-2165`), `textNotTaken` |
| `value?` | finite | `cellNow`, `describeAfter` |
| `selected?` | combo: the chosen option. Table/tree: first selected row's words | `waitForClick` key, `describeAfter`, audit |
| `secret?`, `withheld?` | as AxNode | paste and holds (`worker.ts:1957`, `2157`), `cellNow` |
| `shown?` | with `{shown:true}` | aiming |
| `open?: boolean` | **role `"menu"` only**: its items show | `waitForClick` key (`worker.ts:1259`), `describeAfter` |
| `offscreen?: true` | **menu item roles only**: the item still exists but no longer shows (its menu closed) | `waitForClick`, `targetBox`, `stillSame`, `changedWhileDeciding`, `cursorAct` (`worker.ts:1259`, `1341`, `1375`, `1420`, `1620`, `1628`, `1894-1895`) |
| `formula?: string` | with `{formula:true}` on a spreadsheet cell: the formula without `=`, `""` for none | `cellNow` → `formulaIn` (`worker.ts:654-661`, `2521`) |

### 3.6 `CanDo` (`sidecar.ts:139-152`)
`{ tier1: boolean, why?: string, focused?: boolean, windowActive?: boolean, action?: string, handler?: {role,name}, handlerUnknown?: boolean }`. Consumers are all in `route()` (`worker.ts:1780-1813`):
- `tier1:false` + `why` → borrow the mouse if possible (`withoutTier1`), otherwise fail quoting `why`.
- `action === "select row"` or `"select item"`: a click only selects. A `toggle` there is refused (`worker.ts:1786-1793`). The element is judged as content (`clickSelects`).
- `action === "toggle"` with `tier1:false`: a check box in a list that only a mouse click ticks (`box`, `worker.ts:1795`).
- `handler`: the control around the element that receives the click. The user is asked about whichever of the two is riskier (`clickJudged`, `worker.ts:1821-1830`). Its `role` must be from the vocabulary.
- `handlerUnknown: true` → refuse (`worker.ts:1797-1800`).
- `focused` and `windowActive` (only with `caret:true`): insert at the caret by mouse is impossible when the window is active and the field is not focused (`worker.ts:1809-1811`).
- `selects` is computed when `can && !handler && (selectsOnly || (!can.tier1 && !can.action))` (`worker.ts:1794`). So **`action` should be present whenever tier 1 can click**. Otherwise a mouse click on something without its own action is judged as "only selects".

### 3.7 `ActionResult` (`sidecar.ts:158`)
`{ ok: boolean, action?: string, option?: string, before?: ElementInfo, after: ElementInfo|null, gone?: boolean, busy?: boolean, unchecked?: number }`
- `after: null` + `gone:true` means the element went away (its dialog closed: **success**, not an error). `after: null` + `busy:true` means the app is still busy (`worker.ts:1729-1745`).
- `action === "select row"` or `"select item"`: a row or icon was selected the way a single click selects it. The worker clears the key selection and tells the model it was not opened (`worker.ts:1725`, `1742-1744`).
- After a toggle, `after.states` must show the new state within 1 s, otherwise "it didn't turn on" (`notTurned`, `worker.ts:2001-2010`).

---

## 4. Tree invariants the TS depends on (`read_window.nodes`)
1. **Pre-order**: a parent is listed before everything in it. Stated and relied on at `elements.ts:77`, `297`, `375`, `windows.ts:70`, `elements.ts:430-431` (LibreOffice: root pane, then sheet, then cell; the deepest focused wins).
2. The **first node is the window itself** (depth 0, `parent:null`). Its role is the window's role (`"frame"`, `"dialog"`…), so `dialogAround` finds a dialog when the read window is one (`worker.ts:538-552`). Its name is the title and its bounds are the frame.
3. `parent` refers to an id in the same array. Unlisted holders (py `SKIP_ROLES`: `filler, panel, section, redundant object, glass pane, layered pane, root pane, scroll pane, viewport, split pane, internal frame, option pane, unknown`, py:80-81) are skipped **unless named**, and their children attach to the nearest listed ancestor. `depth` still counts the skipped levels.
4. **Nothing invisible is listed** (offscreen or hidden: "a known prompt-injection channel", py:1572-1574). Rows scrolled away are not listed.
5. Nothing **inside a secret field** is listed (py:1611-1613, `inside_secrets`). The TS also removes such nodes (`index.ts:197`, `203-204`).
6. At most **400 nodes**, plus spreadsheet grid cells (`MAX_NODES = 400`, py:45). `WORKER_LINES = 400` in `index.ts:81` assumes workers see every node a read returns.
7. `MAX_DEPTH = 64`. Deeper elements that show set `cut:["depth"]`.

---

## 5. How the TS turns nodes into text and labels (why role names matter)
- `inferLabels` (`elements.ts:71-96`): only `LABEL_ROLES` nodes with a name and bounds label others. Only `NAMED_BY_ROW` roles take the label on their row. Only `INTERACTIVE` roles get labels. Rows and cells (`ROW_ROLES`) take only an **inner** label.
- `secretIds`/`isSecretNode` (`elements.ts:148-199`): only `FIELD_ROLES` are judged by name and label. `"password text"` is always secret.
- `serializeElements` (`elements.ts:362-427`): role printed with `screenWord` (bare when `/^[a-z][a-z0-9 _-]{0,39}$/i`, otherwise quoted). States printed except `enabled`, `sensitive`, `focusable`. **`disabled` is added when neither `sensitive` nor `enabled` is present.** Sheet cells are grouped one row per line.
- `marksSvg` (`marks.ts:15-35`): only `MARKABLE` roles get numbered boxes. Never `"password text"`, `secret` or sheet cells. **`"switch"` is not in `MARKABLE`.**

---

## 6. The vocabulary contract

The sidecar must emit AT-SPI's lowercase, space-separated role and state names. Every string below is matched literally (Set membership, `===`, anchored regex) unless marked **substring**. A role not in this table is still allowed (it is quoted when printed), but it takes part in **no** heuristic. That is safe only for decoration. For any input field or control it **silently disables** secret detection, labelling, marks, borrowing and policy checks.

### 6.1 Roles: every role the TS matches, and where

Legend: E=`elements.ts`, M=`marks.ts`, W=`windows.ts`, P=`policy.ts`, K=`worker.ts`, D=`place.ts`.

**Buttons and toggles**
| role | matched at | effect if a platform control is NOT given this role |
|---|---|---|
| `push button` | E INTERACTIVE:10, REVEAL_ROLES:154; M MARKABLE:6; P ACTING_CONTROL:370, ACTIVATING_ROLES:505 (substring "button"), riskyContent synthetic:1458; K ACTS_ITSELF:163, CLICK_TAKERS:354, WORKED_CONTROL:562, selectsAll:510, PLAIN_ROLE:169 | no mark, no risky-word check on activation, no "Show password" detection |
| `toggle button` | E INTERACTIVE, NAMED_BY_ROW:22, REVEAL_ROLES; M; P ACTING_CONTROL, ACTIVATING (substring), TOGGLE_ROLES:635 (substring "toggle"), SETTING_ROLES:1563; K ACTS_ITSELF, CLICK_TAKERS, WORKED_CONTROL, selectsAll; on/off = state `checked` **or** `pressed` (K:182) | toggles can't be verified |
| `check box` | E INTERACTIVE, NAMED_BY_ROW, REVEAL_ROLES; M; P ACTIVATING, TOGGLE_ROLES, SETTING_ROLES, not-a-risky-click exclusion:1671; K CLICK_TAKERS, WORKED_CONTROL | "Allow executing file as program" (`runsProgram`) and security-setting checks lost |
| `radio button` | E INTERACTIVE, NAMED_BY_ROW; M; P ACTIVATING (substring "radio"), SETTING_ROLES, :1671; K CLICK_TAKERS, WORKED_CONTROL, toggle tool `/^radio/`:932 | |
| `switch` | E INTERACTIVE, NAMED_BY_ROW, REVEAL_ROLES; P ACTIVATING, TOGGLE_ROLES, SETTING_ROLES, :1671; K CLICK_TAKERS, WORKED_CONTROL. **Not in MARKABLE** | |
| `push button menu`, `button`, `split button` | P ACTING_CONTROL:370; K ACTS_ITSELF:163, CLICK_TAKERS:354, WORKED_CONTROL:562; `button` in selectsAll:510 | **Not in INTERACTIVE/MARKABLE**: emit `push button` instead (e.g. for a UIA SplitButton) |

**Text input**
| role | matched at | notes |
|---|---|---|
| `text` | E INTERACTIVE, FIELD_ROLES:17; M; P UNNAMED "text area":1317, HOLDS_ALL_TEXT:1353, TEXT_FIELD:1502; K TYPING_ROLES:154, FOCUS_IS_THE_STEP:165, PLAIN_ROLE, fieldLike:242, READ_TEXT_ROLES:489, MOVES_IN:479, DOCUMENT_ROLES:493 (editable document only with `multi line`, K:494), CLICK_TAKERS, windowWords:2493, toCellByName Name Box:2562, dialogAround (substring "text"):544 | GTK uses `text` for both one-line and multi-line. Multi-line carries the `multi line` state |
| `entry` | E INTERACTIVE, FIELD_ROLES; M; P UNNAMED "text field", HOLDS_ALL_TEXT, TEXT_FIELD; K TYPING_ROLES, FOCUS_IS_THE_STEP, PLAIN_ROLE, fieldLike, READ_TEXT_ROLES, MOVES_IN, onlyMoves Tab:485, CLICK_TAKERS, toCellByName | one-line field (Qt and Chromium style). **Use for search fields too** (see `search` below) |
| `password text` | E INTERACTIVE, FIELD_ROLES, isSecretNode:149; M excluded:19; **P: never act (`policy.ts:1815`)**; P UNNAMED, HOLDS_ALL_TEXT; K FOCUS_IS_THE_STEP, fieldLike, CLICK_TAKERS | **Mandatory** for UIA `IsPassword` and `AXSecureTextField`. Also set `secret:true` and never read its text |
| `spin button` | E INTERACTIVE, FIELD_ROLES; M; P HOLDS_ALL_TEXT, TEXT_FIELD, Enter-never-sends exclusion:1518; K TYPING_ROLES, WHEEL_VALUE_ROLES:157, FOCUS_IS_THE_STEP, fieldLike, READ_TEXT_ROLES, CLICK_TAKERS | carries `value` |
| `combo box` | E INTERACTIVE, FIELD_ROLES, NAMED_BY_ROW, namedByValue:57, secret parent:196; M; P HOLDS_ALL_TEXT, TEXT_FIELD; K WHEEL_VALUE_ROLES, POPUP_ROLES:190, fieldLike (searching combo):242, nameOf (label wins):1558, CLICK_TAKERS, toCellByName | `selected` = option shown. Also for `AXPopUpButton` |
| `terminal` | **P: never type (`policy.ts:1816`)**; P HOLDS_ALL_TEXT; K FOCUS_IS_THE_STEP | **Mandatory** for console and terminal text areas (see 8.6) |
| `search`, `search box` | K FOCUS_IS_THE_STEP:165, PLAIN_ROLE:170, fieldLike `/search/i`:242 | **Do NOT emit for fields**: they are absent from FIELD_ROLES, TYPING_ROLES, TEXT_FIELD and INTERACTIVE, so secret detection, labels, marks, borrowing and the Enter-may-send check would all be lost. Emit `entry` |

**Documents and text blocks**
| role | matched at | notes |
|---|---|---|
| `document web` | W EMBEDDED:56; P TEXT_FIELD; K DOCUMENT_ROLES, **inWebPage:557**, focusInPage:2626, HOLDERS:360 | **Mandatory** for web content roots (Chromium/Edge/Firefox UIA Document, `AXWebArea`). Marks a page: Enter in its fields "may send" (`inPage`), and dialogs inside it are `alert`s (K:546) |
| `document frame` | W EMBEDDED; P TEXT_FIELD; K DOCUMENT_ROLES, HOLDERS | non-web document container |
| `document text` | P UNNAMED "document", TEXT_FIELD; K TYPING_ROLES, FOCUS_IS_THE_STEP, READ_TEXT_ROLES, MOVES_IN, DOCUMENT_ROLES, dialogAround (substring "text") | an editor's document (Writer, Word, Notepad's RichEdit, TextEdit) |
| `document spreadsheet` | K intoSheet:528 | a spreadsheet's pane: text there is a formula |
| `embedded` | W EMBEDDED; K HOLDERS | |
| `paragraph` | P UNNAMED, TEXT_FIELD; K TYPING_ROLES, FOCUS_IS_THE_STEP, READ_TEXT_ROLES, MOVES_IN, TEXT_BLOCKS:491, DOCUMENT_ROLES, windowWords, dialogAround | |
| `section` | P TEXT_FIELD; K TYPING_ROLES, DOCUMENT_ROLES | listed only when named (py SKIP_ROLES) |
| `heading`, `block quote` | P TEXT_FIELD; K TEXT_BLOCKS, DOCUMENT_ROLES; `heading` also in windowWords and dialogAround | |
| `label`, `static`, `caption` | E LABEL_ROLES:15. `static` also P TEXT_FIELD, K DOCUMENT_ROLES. `label`/`static` in windowWords:2493 and dialogAround:544 | `label` for native static text (UIA Text, `AXStaticText`). `static` for web page text leaves |

**Menus, tabs, lists, tables**
| role | matched at | notes |
|---|---|---|
| `menu item` | E INTERACTIVE; M; P ACTING_CONTROL, ACTIVATING, opensDialog:1573; K ACTS_ITSELF, HOVER_SELECTS:186, selectsAll, WORKED_CONTROL, CLICK_TAKERS, `/menu item$/` at 1270, 1620, 1628, 1894-1895; P keys `/menu/` (substring):1757 | `offscreen` in ElementInfo |
| `check menu item`, `radio menu item` | E INTERACTIVE; `check menu item` in REVEAL_ROLES; M; P ACTIVATING (substring), SETTING_ROLES, opensDialog, :1671; K ACTS_ITSELF, HOVER_SELECTS, CLICK_TAKERS, `/menu item$/` | |
| `menu` | E INTERACTIVE; M; K HOVER_SELECTS, POPUP_ROLES, CLICK_TAKERS, **at_point chain[0] = popup**:2108; P keys `/menu/` | a menu bar's top-level menus are `menu` in GTK (with `selected`/`expanded`), as is an open submenu. ElementInfo `open` |
| `menu bar`, `popup menu`, `tool tip` | K POPUP_ROLES:190 (`menu bar` also HOLDERS) | ancestors that make a row "hover-selects" |
| `link` | E INTERACTIVE; M; P ACTING_CONTROL, ACTIVATING; K ACTS_ITSELF, selectsAll, WORKED_CONTROL, CLICK_TAKERS | |
| `page tab` | E INTERACTIVE; M; P ACTIVATING (substring "tab"); K wheelControls:290, wheelTarget:300, tabPage:339, CLICK_TAKERS | **must be a child (`parent`) of its `page tab list`** |
| `page tab list` | K WHEEL_VALUE_ROLES, wheelControls, tabPage:335, scroll:2768, HOLDERS | |
| `list item`, `tree item` | E INTERACTIVE, ROW_ROLES:61, ITEM_ROLES:325; M; P UNNAMED "row", CONTENT_ROLES:1432; K HOVER_SELECTS, ROW_ROLES:188, PLAIN_ROLE, CLICK_TAKERS | named by content (a file's name, a mail's subject): judged gently |
| `table cell` | as `list item`, plus E isSheetCell:334; K cursorAct:1986, typeInCell:2201, cellNow:2521; P ACTIVATING (substring "tab") | see 10 for `grid` |
| `icon` | E INTERACTIVE, ITEM_ROLES; M; P CONTENT_ROLES; K CLICK_TAKERS | items of an icon view (can_do `select item`) |
| `table` | K sameFocus:437, readSheet:2500, cellWithKeyboard:2585, HOLDERS | a spreadsheet's sheet is the `table` parent of its cells, with `size` |
| `scroll bar` | K seesInside:312, scroll "direct":2779 | |
| `list`, `list box`, `tree`, `tree table`, `tool bar`, `status bar`, `panel`, `filler`, `unknown`, `redundant object`, `glass pane`, `layered pane`, `root pane`, `scroll pane`, `viewport`, `split pane`, `internal frame`, `option pane` | K HOLDERS:360 (at_point: "only holds others"); `root pane` also K unsureFocus:496 | mostly skipped in reads (4.3) but appear in `at_point` chains |

**Windows and dialogs (node roles and `AxWindow.role`)**
| role | matched at |
|---|---|
| `frame` | E WINDOW_ROLES:202; K unsureFocus:496 (`root pane\|frame\|window` = "focus not known yet"), placeOf stop:1530, HOLDERS |
| `window` | E WINDOW_ROLES; K unsureFocus, POPUP_ROLES, HOLDERS, **at_point chain[0]**:2108. **Reserve for popup windows** (menus, drop-down lists, tooltips) |
| `dialog`, `alert` | E WINDOW_ROLES; P DIALOG_WINDOW:666; K DIALOG_ROLE:536 (`dialogAround`: `alert` → policy treats "OK" as agreeing, K:546), QUESTION_ROLE:196, inDialog:1232, placeOf stop, HOLDERS (dialog); D DIALOG_ROLES:167 |
| `file chooser` | E WINDOW_ROLES; P DIALOG_WINDOW, **enterMaySend: Enter in a file chooser never sends**:1519; K DIALOG_ROLE, inDialog, placeOf stop; D |
| `color chooser`, `font chooser` | P DIALOG_WINDOW; K DIALOG_ROLE, inDialog; D |
| `alert dialog` | K QUESTION_ROLE, inDialog |
| `desktop frame`, `application` | E WINDOW_ROLES; `application` K placeOf stop |

**Substring-matching quirks** (an invented role name may trigger these by accident):
- `ACTIVATING_ROLES = /button|link|menu item|check box|radio|toggle|switch|tab/` (`policy.ts:505`). It matches `table cell`, `table` and `page tab list` too (checked: all `true`). Enter or Space on a focused table cell is therefore judged as activating it.
- `TOGGLE_ROLES = /check box|toggle|switch/` (`policy.ts:635`). Keys on a role containing `menu` (`policy.ts:1757`). `dialogAround` collects words from roles matching `/label|static|heading|paragraph|text/` (`worker.ts:544`).
- `inDialog` window role `/dialog|chooser/i` (`worker.ts:1228`).

### 6.2 States (only these reach the TS)
The Python filters node and ElementInfo states to `("focused","checked","selected","expanded","collapsed","pressed","editable","multi line","sensitive","enabled","focusable","active")` (py:83-84). TS uses:

| state | where | requirement |
|---|---|---|
| `enabled` / `sensitive` | `isDisabled = states.length>0 && !sensitive && !enabled` (`worker.ts:731`, used in `fresh` `1509`): **every action refuses a "disabled" element**. `serializeElements` prints `disabled` when neither is there (`elements.ts:406`). Hidden from output (`elements.ts:405`, `339`) | **MUST** be on every enabled element. Emitting other states but not these makes **every** element look disabled. Emit both for safety (UIA `IsEnabled`, `AXEnabled`) |
| `focused` | `focusedElement` (deepest, `elements.ts:435`). Keyboard target for `press_keys` (`worker.ts:2612`). `untilFocused` before typing (`worker.ts:2039`). `landingSpot.focused` (insert mode, `worker.ts:2066`). `waitForClick` reached and marks (`worker.ts:1257`, `1260`). `cursorHints` (`worker.ts:2542`). Editing cell (`worker.ts:2623`) | the element with keyboard focus, and only it (ancestors may carry it too: the deepest wins) |
| `checked` | `isOn` (`worker.ts:182`), waitForClick marks (`1256`) | check box, radio button (AT-SPI uses `checked` for radios), switch, checked menu items, toggled toggle button |
| `pressed` | `isOn`, waitForClick marks | toggle button on (emitting `checked` as well is fine) |
| `selected` | waitForClick marks for non-hover-select roles and reached (`worker.ts:1257`, `1260`). **Text blocks (`paragraph`, `heading`, `block quote`) or a focused document role carrying `selected` → "text may be selected beyond what is seen"** (`worker.ts:2618-2621`) → policy `selectionBeyond` | selected row, tab, list item. Do not put it on text blocks unless text in them is selected |
| `expanded` | waitForClick marks (`worker.ts:1256`) | expanded combo box, tree item, menu |
| `editable` | `typable` = role in TYPING_ROLES **and** state `editable` (`worker.ts:155`): only such fields can be typed into with the borrowed keyboard (`withoutTier1` `1839`, `untilFocused` `2039`). `editableDocument` (`worker.ts:494`). Spreadsheet cell not protected (`worker.ts:2408`). `PLAIN_CELL_STATES` (`elements.ts:339`) | editable text (UIA: Value or Text pattern and not `IsReadOnly`. AX: value settable) |
| `multi line` | `fieldLike` excludes documents (`worker.ts:241`). `focusMultiLine` → policy `multiLine` (Enter only starts a line, `policy.ts:1521`). `editableDocument` for `text` (`worker.ts:494`). `PLAIN_CELL_STATES` | multi-line text areas |
| `collapsed`, `focusable`, `active` | passed through. `focusable` hidden from output | optional |

Never emit `disabled` (the TS derives it). `showing`, `visible`, `defunct` and `modal` are used **inside** the Python only (`modal` and `active` on windows become `OtherWindow.modal`/`.active` and `AxWindow.active`).

### 6.3 Action names
- Sent: `do_action` `action` ∈ {`"click"`, `"toggle"`} only (`worker.ts:921`, `934`). `can_do` `kind` ∈ {`"click"`, `"toggle"`, `"text"`, `"value"`}.
- Matched in results: `ActionResult.action` / `CanDo.action` equal to **`"select row"`**, **`"select item"`** (`worker.ts:1725`, `1742`, `1786`), and `CanDo.action === "toggle"` with `tier1:false` (`worker.ts:1795`). Any other value is opaque and only logged. The Python returns the app's own action name, e.g. `"click"`, `"press"`, `"activate"`, `"clickancestor"`.
- Python behaviour to mirror (py:2702-2712): `click` tries `click, press, activate, jump, toggle, check, uncheck, select, dodefault, open, clickancestor`. `toggle` tries `toggle, click, press, activate, check, uncheck, select, dodefault`. One-way actions (`check`, `select`, `uncheck`) are **never** used when they would change nothing, because a toggle that does nothing would be reported as done. GTK actions that are really a double click (a row's or icon's `activate`) are replaced by **selecting** it (`select row`/`select item`). A list's check-box cell → `background_unavailable` "check box in a list" (the mouse ticks it).

### 6.4 Error-message substrings the TS matches
| substring / regex | where | meaning |
|---|---|---|
| `"background_unavailable"` (prefix `"background_unavailable: "` stripped for display) | `worker.ts:1750-1758` (act), `1649` (list_options). The Python also reports it inside `can_do` as `{tier1:false, why}` | tier 1 can't do it: borrow the mouse (or refuse). **Must be used for "this element has no such pattern/action"**, otherwise the router never escalates |
| `"check box in a list"` | `worker.ts:1757` | the mouse click flips it |
| `/\bbusy\b\|did not (receive a reply\|answer)\|timeout was reached/i` | `isBusy`, `worker.ts:415` (used at 1336, 1505, 1650, 1762) | app busy, element not gone. The Python text: `"the app is busy (it didn't answer in time); try again in a moment"` (py:2715) |
| `"did not answer"` | `worker.ts:1761` | the client's own 5 s timeout: unknown whether it happened |
| anything else | `worker.ts:1764`, `1507` | shown to the model, quoted. From `read_element` it means **gone** |

Required refusals with an error (any message): `set_text`, `set_value` and `select_option` on `password text` or secret elements (py `refuse_secret`, py:2831-2836). Actions on elements that are disabled or no longer showing (py `usable`, py:2814-2828).

---

## 7. Field values the TS sends that the sidecar must honour
- `ownPid` (`read_window`, `list_windows`, `at_point`): Ember's windows are never found, listed or read, not even as the active window.
- `neverLook: string[]` + `skipPids: number[]`: a window whose `"<app> <title>"` (lowercased) contains any trimmed, lowercased item, or whose pid is in `skipPids`, is **found but not read**: `blocked:true` (py `never_looked`, py:2208-2214). The rule must be identical to `isNeverLook` (`elements.ts:440-443`).
- `keep:false` (1.2). `cells` (10). `menus:false` (2.8). `shown`, `formula` (2.9). `caret` (2.10). `mode` (2.12). `path`+`pid` exactness (2.3).

---

## 8. Window matching, scale, `others`, overlays, and private windows

### 8.1 `matchFrame(w, stack)` (`windows.ts:29-53`)
Input: an `AxWindow` (`pid`, `name`, `bounds`) and the platform stack (`StackedWindow[]`, bottom to top, `x11.ts:23-42`: `id, client, pid, title, wmClass, x, y, width, height, outer, inner, overrideRedirect`). Algorithm:
1. Returns null unless `w.bounds` has a positive size.
2. Skips `overrideRedirect` stack entries.
3. Needs `samePid` (`s.pid === w.pid`, non-null) **or** `sameTitle` (`w.name` non-empty and `s.title === w.name`, **exact and case-sensitive**).
4. For each of `s.outer`, `s.inner`, `{s.x,s.y,s.width,s.height}`: `kw = o.width/b.width`, `kh = o.height/b.height`. It needs `|kw-kh| ≤ 0.05·max(kw,kh)`. Then the scale `k` = 1 if `|kw-1| ≤ 0.05`, otherwise the nearest quarter if within 1%, otherwise `kw`. Position tolerance: `|o.x - b.x·k| + |o.y - b.y·k| ≤ 8 + 4k`.
5. Cost = offset + (sameTitle ? 0 : 1000) + (samePid ? 0 : 500). The lowest cost wins. Returns `{index, window, scale}`.

Consumers and what fails without a match:
- `Perception.read` (`index.ts:137`): blocked checks against the matched window's `wmClass`/title (`index.ts:140`), and `frameScale` (`index.ts:148`). Without a match the scale is 1.
- `Perception.locate` (`index.ts:256-261`), which re-matches the already-scaled window at scale 1. **If it fails, a window-scope screenshot is refused**: "Ember couldn't find the window on screen" (`index.ts:435-436`), and `maskAfter` returns null, so no picture either (`index.ts:480-481`). **Workers always ask for scope `"window"`** (`worker.ts:1429`), so a broken match means **no worker screenshots at all.**
- `windows()` (`index.ts:578-583`), `privateWindows()` (`index.ts:610-612`).

Port consequences:
- The platform stack must give, for each top-level window, at least one rectangle (`outer`, `inner` or `x/y/w/h`) that equals the sidecar's frame `bounds` within ~12 px and 5% in shape. Windows: UIA's top-level `BoundingRectangle` is the `GetWindowRect` rectangle, which on Win10/11 includes the invisible resize borders (~7 px each side at 100%). For small dialogs, a 14 px width difference can exceed 5%. So put the exact `GetWindowRect` in `outer`, `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` (what visibly covers) in `x/y/w/h`, and the client area in `inner`. macOS: `AXPosition`/`AXSize` of the AXWindow equal `kCGWindowBounds`, both in points.
- `title` comparison is exact. macOS `kCGWindowName` is empty without Screen Recording permission, so matching then relies on pid (fine). Windows UWP apps: the frame window belongs to **`ApplicationFrameHost.exe`**, the content to the app process. Pid then matches only if the sidecar reports the frame's pid, and title tie-breaks matter (see 9.4).
- **Units.** `k` is inferred from frame size ratios and then applied to every node (`elementScales`, `windows.ts:64-75`). Embedded roles `document web`, `document frame` and `embedded` keep scale 1 if they already fit the physical frame (Chromium on HiDPI). So:
  - Windows: the sidecar must be **per-monitor DPI aware (V2)** before its first UIA call. Otherwise UIA virtualises coordinates for a DPI-unaware client and every frame looks scaled. Report physical pixels. The stack (koffi user32/dwmapi from DPI-aware Electron) is physical too, so k = 1.
  - macOS: AX reports **points**. If the platform stack reports points too, k = 1 and the whole TS works in points. That requires capture, overlay and screen bounds to agree on points. If the stack reports backing pixels, matchFrame finds k = 2 on Retina and the existing HiDPI machinery (built for GDK_SCALE=2) scales nodes, and `at_point` gets `x/k`. That works per window but mixes scales across displays. Choosing points everywhere is the safer option. **Either way the sidecar reports raw AX points and never scales.**
- `scaleOf(id) !== axScale` makes `mustAimAt` skip `at_point` (`worker.ts:2081-2082`). `axScale !== 1` disables per-notch `at_point` in `scroll` (`worker.ts:2786`).

### 8.2 `coveringRects` and own windows (`windows.ts:103-112`)
Windows stacked above the target hide parts of the picture. The target app's own **override-redirect** popups (same pid) don't. Ember's own windows hide what is under them, except the one titled exactly **`"Ember overlay"`** (`OVERLAY_TITLE`, `windows.ts:93`). The overlay window must keep that exact title on every OS.

### 8.3 `others`
See 3.3. Windows: other top-level windows of the same process that are visible and either foreground (`GetForegroundWindow`) or modal (`WindowPattern.IsModal` / disabled owner). macOS: separate windows of the app that are `AXModal` or the focused window. Sheets are in-tree nodes instead.

### 8.4 `elementScales` and `scaleNodes` (`windows.ts:64-84`)
Node `bounds` and `shown` are both scaled. The client-side `scaleBounds` rounding (`sidecar.ts:163-167`) means the sidecar must not round or scale itself.

### 8.5 Shell overlays on Windows and macOS (what to report so `shellCovers` stays meaningful)
- A role other than `notification`/`overview` blocks screenshots and borrowing: report credential and authentication prompts as `"dialog"` (Windows `CredentialUIBroker.exe` "Windows Security", `consent.exe` if visible; macOS `SecurityAgent`, `coreautha`/LocalAuthentication panels).
- `"overview"` blocks screenshots (they show every window, never-look ones included): report it for Windows Task View / Alt+Tab switcher and the Start/Search flyout, and macOS Mission Control / App Exposé.
- `"notification"` with bounds is blacked out: Windows toast and Action Center windows, macOS Notification Center banners.
- `complete:false` when not checked in time.
- If none are implemented, return `{overlays:[], complete:true}`. The TS then relies on `isSecurityWindow` of the focused window alone (`index.ts:418-419`), and that does **not** know Windows or macOS prompt names (8.6).

### 8.6 Private and refused windows: `isNeverLook`, `isSecurityWindow`, `isTerminalApp`, `isEmberWindow`
- **`isNeverLook({app,name}, list)`** (`elements.ts:440-443`): case-insensitive **substring** of each trimmed item in `"${app} ${name}"`. Called with the sidecar's window (`index.ts:107`, `579`, `608`), with stack `wmClass` (`index.ts:126`, `140-141`, `178`, `319`, `576`, `580`, `601`, `main.ts:1259`), and in policy with `ActionRequest.app`/`window` (`policy.ts:1810-1811`). Also re-implemented inside the sidecar (7).
- **`isSecurityWindow({app?, title?|name?})`** (`policy.ts:403-407`): `SECURITY_APP = /polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|^firewall-config$|(^|\s)gnome-shell(\s|$)/i` on `app`, or `SECURITY_TITLE` (English start-of-title patterns: "Authentication required", "Enter your password", "Unlock … keyring", "[sudo]"…, `policy.ts:398`) on the title. Used for blocking reads (`index.ts:107`), list filtering (`index.ts:320`, `323`, `579-580`), screenshots (`index.ts:419`), borrowing (`worker.ts:2909`), and the policy's "never" (`policy.ts:1812`). **Checked: `CredentialUIBroker.exe`, `consent.exe`, `SecurityAgent`, `coreautha` and the titles "Windows Security", "User Account Control", "Touch ID" all return `false`.** Only `pinentry*` (gpg4win, pinentry-mac) matches.
- **`isTerminalApp`**: the policy is given `name => isTerminalApp({ id: name, name })` (`main.ts:1251`) and calls it with `ActionRequest.app`, i.e. the sidecar's `app` (`policy.ts:1817`, `1819`). `system.ts:317-323`: `.`-split id parts in `TERMINALS` or `console`, IDE/shell apps (`SHELL_APP`, `SHELL_APP_NAME`), name `/\b(terminal|console)\b/i`. **Checked**: Windows `WindowsTerminal(.exe)`, `OpenConsole.exe`, `conhost.exe`, `cmd(.exe)`, `powershell(.exe)`, `pwsh(.exe)`, `wsl.exe`, `mintty.exe` → **false**. `putty.exe`, `Code(.exe)` → true. macOS `Terminal`, `com.apple.Terminal`, `Ghostty` → true. `iTerm2`, `com.googlecode.iterm2`, `Warp`, `dev.warp.Warp-Stable` → **false**. The other guard is element role `terminal` (`policy.ts:1816`), which the sidecar must emit for console text areas (Windows: `ConsoleWindowClass` and Windows Terminal's `TermControl`; macOS: Terminal's and iTerm2's text views).
- **`isEmberWindow({app,name,pid}, ownPid)`** (`policy.ts:497-501`): pid equals Ember's, **or** `app` (normalised, trimmed) matches `/^(ember|ember overlay|ask ember|ember's desk|ember microphone)$/`, **or** pid unknown and the title matches. Used by `list_windows` (`worker.ts:910`), `perceive` (`worker.ts:1442`) and policy (`policy.ts:1814`). On Windows the process name `Ember.exe` does **not** match (checked). Safety rests on the pid, which is right as long as the sidecar reports the real owning pid (Electron BrowserWindows belong to the main process on all three OSes).
- `Perception.isPrivate(app, title)` = never-look OR security (`index.ts:106-108`). A private window's title is blanked before it goes anywhere (`index.ts:143-146`).
- `isSecretField` (`policy.ts:503`) and `isSecretLabel` (`elements.ts:145`) operate on element names. The `SECRET_WORDS` list is kept identical to py by a test (`test/unit/perception.test.ts:293-298`). New sidecars should load the same lists (fixtures: `test/fixtures/secret-labels.json`, `chosen-options.json`).

---

## 9. App names (`AxWindow.app`) and `friendlyApp`

### 9.1 What Linux puts there
The AT-SPI application accessible's `name` (py `describe_window`: `app.name`, py:2128). It is usually the program name `g_get_prgname()`, sometimes a display name, sometimes a desktop id. Values in tests and fixtures: `gedit`, `Firefox`/`firefox`, `soffice`, `soffice.bin`, `mousepad`, `Thunderbird`, `nautilus`, `org.gnome.Nautilus`, `gnome-control-center`, `gnome-terminal-server`, `electron` (any Electron app: `index.ts:123-124`), `KeePassXC`, `evolution`, `gcr-prompter`, `polkit-gnome-authentication-agent-1`, `pinentry-gnome3`, `firewall-config`, `gnome-shell`.

### 9.2 `friendlyApp(name)` (`apps.ts:34-47`), display only
1. Trim, then strip a trailing `.desktop` (case-insensitive). Empty → `""`.
2. Exact lowercase lookup in `APP_NAMES` (Linux table only, `apps.ts:4-27`).
3. `/^libreoffice/i` → `LibreOffice`.
4. A desktop id `/^[a-z]{2,}(\.[\w-]+){2,}$/i` (two or more dots) → its last part, looked up, otherwise `capitalised`.
5. `capitalised`: only all-lowercase `[a-z][a-z0-9-]*` gets its first letter upper-cased. Anything else (dots, capitals, spaces) is returned **as is**.

Used in policy prompts (`policy.ts:1324`, `1346`, `1790`, `1798-1799`, `1857`), the worker (`worker.ts:2327`, `2477`, `3115` "Always in X"), `index.ts:327` (X11 lines), `main.ts:676`, and renderer copy (`home/copy.ts:134`, `home/main.ts:650` grants list).

**Checked outputs for candidate Windows and macOS values:**
| input | friendlyApp | input | friendlyApp |
|---|---|---|---|
| `notepad.exe` | `notepad.exe` | `notepad` | `Notepad` |
| `WINWORD.EXE` / `WINWORD` | unchanged | `EXCEL` | `EXCEL` |
| `msedge.exe` | `msedge.exe` | `msedge` | `Msedge` |
| `chrome.exe` | `chrome.exe` | `chrome` | `Chrome` |
| `firefox.exe` | `firefox.exe` | `firefox` | `Firefox` |
| `soffice.bin` | `LibreOffice` | `explorer` | `Explorer` |
| `ApplicationFrameHost.exe` | unchanged | `SystemSettings` | `SystemSettings` |
| `com.apple.TextEdit` | `TextEdit` | `TextEdit` | `TextEdit` |
| `com.apple.finder` | `Finder` | `com.apple.systempreferences` | `Systempreferences` |
| `com.apple.Safari` | `Safari` | `org.libreoffice.script` | **`Script`** |
| `com.microsoft.Word` | `Word` | `org.mozilla.firefox` | `Firefox` |
| `com.googlecode.iterm2` | `Iterm2` | `dev.warp.Warp-Stable` | `Warp-Stable` |

### 9.3 Everything else that matches on `app` (not only display)
| consumer | rule | Windows/macOS gaps (checked) |
|---|---|---|
| grants | `settings.grants[app.toLowerCase()]` (`policy.ts:1854`, `worker.ts:3123`), `allowedApps` per task (`worker.ts:3094`, `3108`, `3128`) | needs a **stable, locale-independent** value. All UWP apps under one `ApplicationFrameHost` name would share one grant |
| never-look | substring of `"${app} ${title}"` | `app` should contain the words users type ("keepass", "1password", "bitwarden"). Process names do, mostly. Bundle ids like `com.apple.keychainaccess` don't contain "keychain access" |
| `TABBED_APP` (`policy.ts:668`): carry check and Enter-may-send | `/firefox\|chrom(e\|ium)\|…\|thunderbird\|evolution\|…\|mail\|slack\|teams\|discord\|…/i` | `msedge`, `Microsoft Edge`, `Safari`, `OUTLOOK`, `Microsoft Outlook` → **false**. `chrome.exe`, `Google Chrome`, `Mail`, `com.apple.mail`, `ms-teams` → true |
| `WEB_APP` (`policy.ts:1507`) | fallback when `inPage` is unknown | Edge and Safari are missing (rarely reached: `inPage` is set from the `document web` ancestor whenever there is a focused element) |
| `OFFICE_APP` (`policy.ts:1504`) `/soffice\|libreoffice/i` | Enter never sends in LibreOffice | `soffice.bin`, `org.libreoffice.script` → true. MS Office is missing |
| `SECURITY_APP`, `EMBER_WINDOW`, `isTerminalApp` | 8.6 | see 8.6 |
| `open_app` window detection | `programsOf(app)` = desktop id and Exec basenames, lowercased, `LAUNCHERS` removed (`worker.ts:697-702`). New window found when `programs.has(w.app.toLowerCase())` or the title contains the app name (`worker.ts:1015-1022`) | the `app` value must equal what the Windows/macOS `hands/system` launcher records as the program (e.g. `notepad.exe` keeps `.exe` so it matches `path.basename(exe)`), or `programsOf` must normalise both |
| `quickContext` / `describe` text and `serializeElements` `app=` | shown to the model, quoted | — |

### 9.4 Recommendation for what `app` should contain
- **Windows**: the owning process's **image file name** (`Process.MainModule.ModuleName` or `QueryFullProcessImageName` basename), e.g. `notepad.exe`. It is locale-independent, stable for grants, matches never-look words, and `.exe` makes `isTerminalApp`'s `.`-split logic work for `putty.exe`, `alacritty.exe` and `Code.exe`. **For UWP**, report the hosted CoreWindow's process (e.g. `CalculatorApp.exe`, `SystemSettings.exe`) as `app`. Keep `pid` = the frame owner's pid (`ApplicationFrameHost`) so that `matchFrame`, `findWindow(title, pid)` and `others` stay consistent with the stack. Either way the TS needs vocabulary additions (13).
- **macOS**: the app's `localizedName` (the application AXUIElement's `AXTitle`, e.g. `TextEdit`, `Safari`, `Terminal`, `iTerm2`). This is closest to AT-SPI's names, reads well, and never-look titles work. It is locale-dependent ("Systemeinstellungen") but stable per machine. Bundle ids are the alternative: locale-proof, and handled by friendlyApp's desktop-id branch, but `org.libreoffice.script` → "Script" and never-look by display name breaks.

---

## 10. Spreadsheet fields (`grid`, `size`, `cells`, `formula`): LibreOffice-specific
- `isSheetCell` = `role==="table cell" && grid !== false && /^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}$/.test(name)` (`elements.ts:328-335`). **Checked**: `A1`, `B7`, `X1`, `AB12`, `ZZZ9`, `Q4` → all true. A sheet cell:
  - gets no mark (`marks.ts:19`)
  - is grouped one line per row (`elements.ts:376-382`)
  - redirects `type_text` to the keyboard path `typeInCell` (`worker.ts:1675`)
  - is described as "cell B5" in questions (`policy.ts:1320-1322`)
  - takes formula checks (`policy.ts:1474`, `1707`)
  - is matched by `cellJob`, `readSheet`, `cursorHints` and `cellWithKeyboard`.
- **Requirement: every `"table cell"` the sidecar did not read from a real spreadsheet grid must carry `grid:false` when its name matches that pattern** (py `node_of` does this, py:899-904). Otherwise an ordinary list cell named e.g. "Q4" or "X1" is treated as a spreadsheet cell.
- Real grid cells: `grid:true`, name = address, `text` = what it holds, `parent` = the sheet node with role **`"table"`**, name = sheet name, `size: {rows, columns}`. `read_window.cells` = addresses to look at first for the cell with the keyboard (py `add_cursors`). `read_element {formula:true}` → `formula`.
- On Windows and macOS (Excel, Numbers, LibreOffice through IA2 or AX) this is optional. Without it, `type_text {cell}` and `fill_cells` fail cleanly ("Your latest perceive_window shows no spreadsheet cells", `worker.ts:2197`, `2230`).

---

## 11. Linux-only consumers (desk)
- `place.ts`: `openDeskPlace` builds a second `AtspiSidecar` with the desk's env (`place.ts:210`). `DIALOG_ROLES` (`place.ts:167`) and `deskWindowAt` (`place.ts:176-181`: same pid, any of outer/inner/frame within 8 px of the accessible frame) are used only by `worker.deskDialogWindow` (`worker.ts:3015-3019`) on the desk. The desk's `screenBounds` is `{0,0,info.width,info.height}` (`place.ts:213`).
- Without `desk`, the worker leaves out `open_on_desk` (`worker.ts:973`) and never reaches `onDeskInput`.

---

## 12. Risky findings and surprises for implementers
1. **`enabled`/`sensitive` are mandatory states.** `isDisabled` treats any element with states but neither of these as disabled, and `fresh()` refuses to act on it (`worker.ts:731`, `1509`). A sidecar that emits only `focused`/`checked` would make every action fail.
2. **`at_point` chain must exclude the window itself**, and use role `window` only for popups. `chain[0].role` matching `/^(menu|window)$/` is read as "a menu covers the element" and refuses every borrowed click (`worker.ts:2108`). Bounds and roles must equal the read's exactly (`aimedAt`, `worker.ts:375`).
3. **Window matching gates screenshots.** If `matchFrame` can't pair the sidecar frame with a platform stack entry (pid or exact title, ≤5% shape, ≤12 px offset), window-scope screenshots are refused (`index.ts:435-436`). Workers only ask for window scope. Windows' invisible resize borders and DPI virtualisation will break this unless handled (8.1).
4. **Terminal refusal is name-based and Linux-tuned.** `WindowsTerminal`, `cmd`, `powershell`, `pwsh`, `conhost`, `OpenConsole`, `wsl`, `mintty`, `iTerm2` and `Warp` are **not** recognised by `isTerminalApp` (checked). The only other guard is the element role `terminal`. Without TS additions **and** a `terminal` role, Ember could type into a shell.
5. **Security prompts are not recognised** on Windows or macOS by `isSecurityWindow` (CredentialUIBroker, consent, SecurityAgent, coreautha, "Windows Security" all false). `shell_overlays` is the other line of defence and must report them as `dialog` (8.5).
6. **No startup grace.** A PowerShell 5.1 sidecar that compiles C# with `Add-Type` on every start can miss its first 5 s deadline, get killed, and, because it never answered, never be revived (1.3). Use a precompiled or cached assembly, or add a first-request grace in the client.
7. **One request at a time, hard 5 s kill.** A hung app must produce `busy`, not a blocked call. Managed `System.Windows.Automation` has no per-call timeout (unlike `IUIAutomation2.TransactionTimeout`). Run UIA calls on a worker thread with a ~0.8 s wait and keep the Python's hung-app bookkeeping (strikes, skip for 30 s, last-seen windows marked `busy`). Otherwise every hung app costs a restart.
8. **Omitted `text`/`selection` have meaning.** For `text`, `entry`, `paragraph`, `document text` and `spin button`, a missing `text` is read as empty and a missing `selection` as "nothing selected" (`worker.ts:2613-2615`). The policy then skips "this replaces N characters" questions. A sidecar that cannot read the selection must still report it, or not use those roles. This is fail-open.
9. **`grid:false` on address-like cells** (10), or list cells named like "Q4" are handled as spreadsheet cells.
10. **`search`, `split button`, `button` and other off-list roles silently disable safety heuristics.** Map fields to `entry`/`text`/`password text`/`combo box`/`spin button`, and buttons to `push button`.
11. **`document web` is load-bearing.** It decides `inPage`, which drives Enter-may-send, and in-page dialogs counting as `alert`s (`worker.ts:546`, `2626`, `policy.ts:1520`).
12. **`app` drives grants, never-look, terminal and security refusal, and the Edge/Safari/Outlook heuristics**, none of which know Windows or macOS names (9.3). `friendlyApp` shows `notepad.exe`, `msedge.exe` and `Script` (LibreOffice on macOS) as is. UWP's `ApplicationFrameHost` would merge every UWP app into one grant.
13. **Coordinates**: the sidecar reports the app's units and never scales. macOS AX gives points; pick the platform stack's unit deliberately (8.1).
14. **`path` is quietly essential**: exact re-reads, `at_point`, `secret_fields` (otherwise screenshots of truncated reads are refused), policy window identity. It must be stable for the window's life and unique per pid (Windows: HWND or RuntimeId string; macOS: CGWindowID via `_AXUIElementGetWindow`, or a sidecar-kept registry).
15. **Titles**: borrowed input finds the platform window by `findWindow(AxWindow.name, pid)` (`worker.ts:2928`). The platform title must equal the accessible frame name. macOS CGWindow titles need Screen Recording permission, so the macOS `findWindow` should match through AX.
16. **Secret keys** are opaque `[string,string]` pairs replayed to new processes. They should identify an element across sidecar restarts (Windows: `[pid, RuntimeId]`). macOS AXUIElements can't be serialised, so best effort is acceptable: the TS never inspects them.
17. Limits the TS assumes: names ≤200, node text ≤200 (`howMany`), selection ≤500, `read_element` text ≤2000 (`TEXT_READ_LIMIT`), ≤400 nodes, U+FFFC for embedded objects in text (`policy.ts:1364`, `1399`, `1718`). No NaN or Infinity anywhere (the client drops the whole line).
18. Protocol hygiene for PowerShell: set `[Console]::InputEncoding`/`OutputEncoding` to UTF-8 without BOM, never use `Write-Host` or `Write-Output` for anything but protocol, use `ConvertTo-Json -Depth` ≥ 10 (PS 5.1 defaults to 2 and turns nested objects into strings) or a C# serializer, and use `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.

---

## 13. TS changes needed so the logic keeps working (minimal list)
1. `AtspiSidecar`: take a command and argv (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ember_uia.ps1`; `process.execPath sidecar.js` with `ELECTRON_RUN_AS_NODE=1`) instead of `python + script`. Keep `EMBER_ATSPI_ID_BASE`, or rename it and support both. Optionally a longer timeout for a new process's first request.
2. `system.ts` `TERMINALS`/`idIsTerminal`: add `windowsterminal`, `openconsole`, `conhost`, `cmd`, `powershell`, `powershell_ise` (shell app), `pwsh`, `wsl`, `bash` (via SHELLS), `mintty`, `iterm2`, `iterm`, `warp`, `hyper`, `tabby`. Consider checking `SHELLS` in `idIsTerminal` too.
3. `policy.ts` `SECURITY_APP`: add `credentialuibroker`, `consent`, `logonui`, `securityagent`, `coreautha`, `localauthentication` (exact names to be confirmed on the OS). `SECURITY_TITLE`: add "Windows Security" and macOS authorization wording.
4. `policy.ts` `TABBED_APP`/`WEB_APP`: add `msedge|edge`, `safari`, `outlook|olk`. `OFFICE_APP` may need `winword|excel|powerpnt` for "Enter never sends" (judgement call).
5. `apps.ts` `APP_NAMES`: Windows (`notepad.exe`→Notepad, `msedge.exe`→Microsoft Edge, `winword.exe`→Word, `excel.exe`→Excel, `powerpnt.exe`→PowerPoint, `outlook.exe`→Outlook, `explorer.exe`→File Explorer, `systemsettings.exe`→Settings, `calculatorapp.exe`→Calculator, `mspaint.exe`→Paint, `chrome.exe`→Chrome, `firefox.exe`→Firefox, `soffice.exe`→LibreOffice) and macOS (`script`/`org.libreoffice.script`→LibreOffice, `systempreferences`→System Settings, `iterm2`→iTerm2). Or strip `.exe` before lookup and capitalising.
6. `programsOf` (`worker.ts:697-702`) must produce the same normalisation as the sidecar's `app` on Windows and macOS (it is built from `.desktop` data today).
7. `isEmberWindow` `EMBER_WINDOW` could accept `ember.exe` (safety already holds through the pid).
