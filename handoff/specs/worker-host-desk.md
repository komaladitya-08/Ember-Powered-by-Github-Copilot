# Spec: how the agent uses its hands, and the desk (port to Windows 10/11 and macOS 13+)

Scope: `app/main/agent/host.ts` (the `Hands` interface and how it is used), `app/main/agent/worker.ts` (`WorkerDeps`, every
tool), `app/main/agent/conductor.ts` (`describe_screen`, `show_me`, `start_task`), `app/main/desk/*.ts`, and
`app/main/main.ts:1166-1314`, where `Hands` is put together. I read every line cited here in the current tree (branch
`ember-improve/20261022-windows-macos`). Line numbers refer to that tree.

Notation: **R** = required, **O** = optional, "screen units" = the coordinate space every `Bounds` uses (today: physical
X root pixels).

---

## 0. The essentials

1. Hands are built only when X11 opened: `const hands: Hands | undefined = x11 ? {...} : undefined` (main.ts:1243).
   When `x11` is null (it always is on Windows and macOS, because `openX11()` loads `libX11.so.6`), `AgentHost.tasks`
   stays null (host.ts:764). The conductor then has no `startTask`, `showMe` or `tasks` (host.ts:859, 884, 897), and
   `start_task` and `show_me` return their "no desktop access" fallback strings (conductor.ts:111-118). Only
   `describe_screen` still works, because `describeScreen` is passed unconditionally (main.ts:1288).
2. The worker never touches X11 directly. It sees the OS only through:
   - `Perception`: `perceive`, `windows`, `read`, `atPoint`, `systemDialogOpen`.
   - `AtspiSidecar`: `readElement`, `doAction`, `setText`, `setValue`, `selectOption`, `listOptions`, `canDo`, `scaleOf`.
   - `WorkerDeps.cursor`: a `CursorBorrow` built on an `XInput`-shaped object, plus `findWindow` and `activeWindow`.
   - `pointer` and `activationKey`.
   - `desk`, whose `DeskPlace` carries X11 and XInput.
   - `hands/system` (`SETTINGS`, `changeSetting`, `listApps`, `findApp`, `launchApp`, `isTerminalApp`, `execArgv`). It
     is **imported directly** (worker.ts:29) and is **not injected**.
3. The tier-0 tools (`change_setting`, `open_app`) are always offered, on every platform, and they are hard-wired to
   gsettings, XDG `.desktop` files and `gtk-launch`.
4. The keyboard vocabulary is X keysym names (`Return`, `BackSpace`, `Prior`) built around Ctrl. The worker itself presses
   `ctrl+a`, `ctrl+v`, `ctrl+End`, `ctrl+Home` and `ctrl+shift+F5`. On macOS the policy treats every Cmd combination as a
   system key and **denies** it (policy.ts:531, 562-572, 1829).
5. Scaling: everything is assumed to be "physical X pixels" with one global scale factor. `flyTo` divides by the
   *primary* display's `scaleFactor` (main.ts:1197, 1253). That is wrong under Windows per-monitor DPI, and wrong on
   macOS, where AX, CGEvent and Electron all use points.

---

## 1. The `Hands` interface (host.ts:44-62)

```ts
/** What workers need to see and act (absent when there is no desktop). */
export interface Hands {
  perception: Perception;                       // R
  sidecar: AtspiSidecar;                        // R  (concrete class type)
  policy: PolicyEngine;                         // R
  audit: AuditLog;                              // R
  confirmer: Confirmer;                         // R
  flyTo: (bounds: Bounds | null) => void;       // R
  currentWindow: () => (WindowTarget & { app?: string }) | null;   // R
  pointer?: WorkerDeps["pointer"];              // O  () => { x, y, mask } | null
  activationKey?: WorkerDeps["activationKey"];  // O  () => boolean
  desk?: WorkerDeps["desk"];                    // O  () => Promise<DeskPlace>
  onDesk?: WorkerDeps["onDesk"];                // O  (place, previous) => void
  cursor?: WorkerDeps["cursor"];                // O  tier 3
  clipboard?: WorkerDeps["clipboard"];          // O  PasteClipboard | TextClipboard
}
```

### 1.1 Field by field: who produces it (main.ts) and who uses it

| Field | Producer (main.ts) | Consumers |
|---|---|---|
| `perception` | `new Perception({ sidecar, x11, log, neverLook, screenBounds, hideOverlay })` at 1169-1186. Created **even when x11 is null**. | host.ts:799 (`makeWorker`); host.ts:1084-1086 (`cantGuide` → `perception.read(target)`) |
| `sidecar` | `new AtspiSidecar(sidecarScript(), log)` at 1167; the script is `sidecar/atspi/ember_atspi.py` (801-803) | host.ts:799 → `WorkerDeps.sidecar` |
| `policy` | `new PolicyEngine({ neverLook, grants, rateLimit, actionsAllowed, confirmEveryAction, allowGrants, isTerminalApp: name => isTerminalApp({ id: name, name }) })` at 1245-1252 | host.ts:799; worker `authorize` (3087), `authorizeCells` (2297), `clickJudged` (1826), `harmlessKeys` (2737) |
| `audit` | `new AuditLog(..., journalSink(...))` at 1189. `journalSink` returns `undefined` off Linux (no `systemd-cat`), so it already degrades cleanly. | host.ts:769 (TaskManager); host.ts:799 (worker) |
| `confirmer` | `new Confirmer(showState, { blocked: () => borrowRef?.driving ?? false, ... })` at 1191-1196 | host.ts:429-430 (BubbleOwner); 799; 1173 / 1186 / 1221 (`cancelAll`) |
| `flyTo` | `b => setState({ focus: b && b.width > 2 && b.height > 2 ? { x: b.x/scale(), y: b.y/scale(), width: b.width/scale(), height: b.height/scale() } : null })` at 1253, with `scale = () => screen.getPrimaryDisplay().scaleFactor \|\| 1` at 1197 | host.ts:803 → worker `fly()` (824) and `run()`'s finally (1175) |
| `currentWindow` | `x11.activeWindow()` → null for Ember's own pid → `{ pid }` for a private window (`isNeverLook` / `isSecurityWindow` by `wmClass` and title), else `{ pid, title }` (1254-1261). **It never sets `app`.** | host.ts:766 → `TaskManager.start` uses it only when no target was given (tasks.ts:102) |
| `pointer` | `xinput ? () => xinput.pointerState() : undefined` (1262) | worker `waitForClick` (1291, 1299): `mask & 256` means "left button down" |
| `activationKey` | keycodes of `Return`, `KP_Enter`, `space` via `xinput.keycodeOf(xinput.keysymOf(n))`; returns whether any of them is in `xinput.keysDown()` (1264-1267) | worker `waitForClick` (1269, 1330) |
| `clipboard` | `electronClipboard(clipboard, ClipboardItem)` (1269). Electron API, so cross-platform; set even without XTest. | worker constructor (812) → `cursorAct` paste path |
| `desk` | `DeskManager.available().ok && policy.features.desk !== false ? () => (deskPlace ??= openDeskPlace(deskManager, {...}).catch(...)) : undefined` (1270-1273) | worker: `open_on_desk` is offered only if truthy (973); `press_keys` and `scroll` are offered if `cursor \|\| desk` (1028) |
| `onDesk` | `(place, previous) => { if (previous) deskView.leave(previous); if (place) deskView.show(place); }` (1276). **Set even when `desk` is undefined** (harmless). | worker `setPlace` (841); `run()`'s finally (1176) |
| `cursor` | `borrow && xinput ? { borrow, findWindow: (t, p) => xinput.findWindow(t, p), activeWindow: () => { const w = x11.focusWindow() ?? x11.activeWindow(); return w ? { app: w.wmClass, title: w.title, pid: w.pid } : null; }, setBorrowing: showBorrowing } : undefined` (1277-1284). `borrow` is `new CursorBorrow(xinput, { onChange: showBorrowing, mayRefocus })` when XTest opened and `policy.features.cursor !== false` (1214-1218). | worker `withCursor`, `withoutTier1`, `waitForClick`, `typeInCell`, `fillCells`; tool gating (1028) |

`setBorrowing(state)`: the worker passes `"waiting" | "active" | "off"`, but main's `showBorrowing` **ignores the
argument** and reads `borrow.driving` and `borrow.pending` itself (main.ts:1204-1213, comment at 1282). A new platform
must keep that: the status follows the shared `CursorBorrow`, not whichever task spoke last.

### 1.2 How `AgentHost` uses `Hands` (host.ts)

- Constructor (429-430): `o.hands?.confirmer` feeds `BubbleOwner` (a question holds the bubble).
- `doStart` (760-815): `this.tasks = hands ? new TaskManager({...}) : null`.
  - TaskManager gets `currentWindow`, `audit` and `makeWorker`.
  - `makeWorker` (796-814) copies these into `WorkerDeps`: `perception`, `sidecar`, `policy`, `confirmer`, `audit`,
    `flyTo`, `cursor`, `clipboard`, `pointer`, `activationKey`, `desk`, `onDesk`.
  - It also adds `vision: workerVision()`: the worker model supports images and `admin.features.screenImages !== false`.
- Conductor wiring:
  - `describeScreen` is wrapped so that what it read joins the turn (824). It does not depend on hands.
  - `startTask` (859-883) and `showMe` (884-895) exist only when `tasks` does.
  - `showMe` first calls `cantGuide(target)` (1083-1092). That uses `hands.perception.read(target)` with a 4 s cap, and
    returns a reason ("the window doesn't answer right now", "Ember can't read that window (its desktop controls
    aren't available here)", "that window is private…", "…exposes no accessibility information").
- `abortAll` (1164-1175), `forgetConversation` (1186) and `doStop` (1221) call `hands?.confirmer.cancelAll()`.

**When `hands` is undefined (today on Windows and macOS):**
- There is no TaskManager.
- `start_task` → "Ember cannot operate applications in this session (no desktop access). Tell the user and offer to
  explain how to do it instead."
- `show_me` → "Ember can't point at things in this session (no desktop access). Explain the steps in words instead."
- `list_tasks`, `cancel_task` and `steer_task` are not offered at all (conductor.ts:119).

---

## 2. `WorkerDeps` (worker.ts:38-103) and the sub-interfaces it imports

```ts
export interface WorkerDeps {
  client: CopilotClient; log: Logger; model: string | null; runtimeDefault?: boolean; vision: boolean;
  provider?: ProviderConfig; workDir: string;
  perception: Perception; sidecar: AtspiSidecar; policy: PolicyEngine; confirmer: Confirmer; audit: AuditLog;
  settings: SettingsStore; presenter: Presenter;
  lease: (windowKey: string, taskId: string, signal?: AbortSignal) => Promise<() => void>;
  flyTo: (bounds: Bounds | null) => void;           // screen units; null = come back
  onProgress: (text: string) => void;
  desk?: () => Promise<DeskPlace>;
  onDesk?: (place: DeskPlace | null, previous: DeskPlace | null) => void;
  pointer?: () => { x: number; y: number; mask: number } | null;   // screen units; mask uses X bits (256 = left)
  activationKey?: () => boolean;
  cursor?: {
    borrow: CursorBorrow;
    findWindow: (title: string, pid?: number) => number;   // native window id; 0 = none or several
    setBorrowing: (state: "waiting" | "active" | "off") => void;
    activeWindow?: () => { app: string; title: string; pid?: number | null } | null;   // keyboard-focus window
  };
  onUsage?: (input: number, output: number) => void;
  clipboard?: PasteClipboard | TextClipboard;
  limits?: { maxSteps?; maxMs?; pasteWaitMs?; turnStartMs?; turnSlowMs?; turnSilentMs? };
  inotifyUsedUp?: () => boolean;   // Linux /proc; returns false elsewhere (host.ts inotifyUse returns null)
}
```

`TaskSpec.target: WindowTarget & { app?: string }`. Here `WindowTarget = { pid?: number; title?: string; path?: string }`
(perception/index.ts:39). `path` is the accessible object path that the sidecar's `read_window` returns. Together with
the pid it names exactly one window.

`DeskPlace` (desk/place.ts:20-39) is Linux-only: `info: DeskInfo`, `perception`, `sidecar: AtspiSidecar`,
`input: XInput`, `x11: X11`, `keys: DeskKeys`, `snapshot()`, `userInControl()`, `dead`, `onDead()`, `open(app)`, `close()`.

`Hand` (hands/borrow.ts:53-63) is what borrowed input does: `glideTo(x, y)`, `click(button?)`, `keys(combo)`,
`type(text)`, `checkTyping(text)`, `scroll(direction, steps)`. `CursorBorrow` (borrow.ts:147-462) is the **only** thing
that implements it. It is built on `XInput` (hands/input.ts:14-84):

- Required members: `pointer`, `pointerState`, `move`, `button`, `keysym`, `keycode`, `keysymOf`, `keysDown`,
  `keycodeOf`, `needsShift`, `activeWindow(): number`, `screenSize`, `findWindow`, `focusedWindow(): number`,
  `activate(id)`, `sync`, `releaseAll`, `close`.
- Optional members: `focusInput`, `layout`, `keyboardGrabbed`, `pointerOn`, `screenLocked`, `watchUser`, `userInput`.

---

## 3. The tools

### 3.1 Wiring (worker.ts:854-898)

- `tools()` (854-858):
  - Guide mode keeps only `perceive_window`, `list_windows`, `switch_window`, `point_at`, `wait_for_click`,
    `report_progress` and `finish_task`.
  - "do" mode keeps everything else and drops `point_at` and `wait_for_click`.
- `tool()` (867-877) adds three things:
  - Calls are serialised (`toolTurn`), one at a time, in order.
  - `runTool` (884-898): stopped → `STOPPED()` ("Stopped. Do nothing more.", `denied`). Finished → denied. While
    wrapping up, only `finish_task` and `report_progress` run. After `maxSteps` (default 150) the task halts. Arguments
    are zod-validated.
  - The set of tool names is checked against the session (`verifySessionTools`, 1102). So any tool that is offered
    conditionally must be decided before `tools()` runs.

### 3.2 Catalogue

"place" means `this.place` (the desk, or null for the user's screen). `perception` is `place?.perception ??
d.perception` and `sidecar` is `place?.sidecar ?? d.sidecar` (815-816).

| Tool (line) | Mode / offered when | Arguments | What it uses | When a dependency is missing or fails |
|---|---|---|---|---|
| `perceive_window` (904-907) | both, always | `{ image?: boolean }`. `image` is honoured only if `d.vision`. | `perceive()` (1427-1456) → `perception.perceive({ image, scope: "window", target })`. Sets `window`, `frame`, `axScale`, `target = { title, pid, path }`, `known` and `labels`. Appends `dialogNote()`. With a capture it adds `binaryResultsForLlm` (JPEG with marks). | `blocked` → denied ("This window is private…"). No `p.window` → fail (`p.text` if busy, else "That window can't be read (it is closed or exposes no accessibility information). Use list_windows."). An Ember window → refused. Without X11, Perception returns no capture: "(No screenshot: screenshots aren't available on this display.)" (perception/index.ts:416). |
| `list_windows` (908-916) | both, always | `{}` | `perception.windows()` (sidecar `list_windows`, filtered by never-look / `isSecurityWindow` / `isEmberWindow`). Fields used: `app`, `name`, `pid`, `path`, `active`, `busy`. | Lists "No windows found." when empty. |
| `switch_window` (917-919) | both, always | `{ title: string(1..200) }` | `perceive(false, title)` with target `{ title }` only (**no pid**). Fails unless the read window's name contains the title (1438). | The same as `perceive_window`. |
| `click` (920-921) | do | `{ id }` | `act("click", id, undefined, () => sidecar.doAction(id, "click"))` | See §4. |
| `toggle` (922-935) | do | `{ id, on }` | `sidecar.readElement(id)` first ("Already on/off"; a radio can't be unchecked), then `act("toggle", …, sidecar.doAction(id, "toggle"))`. Verified by `notTurned` (2001-2010). | See §4. |
| `type_text` (936-949) | do | `{ id? , cell?: /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/, text ≤5000, mode: replace\|insert\|append }` | With `cell`, or when the element is a sheet cell (1675): `typeInCell` (2189-2210). Otherwise `act("text", id, text, () => sidecar.setText(id, text, mode), mode)`. | `typeInCell` with no `place` and no `cursor` → fail **"Filling a cell needs the keyboard, which isn't available here. Try open_on_desk."** (2196), even when the desk isn't offered. |
| `fill_cells` (950-958) | do, always | `{ cells: [{ cell, text }] (1..8) }` | `fillCells` (2218-2257): one question, one borrow (`withCursor(..., keysOnly = true)`) | No place and no cursor → **"Filling cells needs the keyboard, which isn't available here. Try open_on_desk."** (2229) |
| `choose_option` (959-961) | do | `{ id, option }` | `sidecar.listOptions(id)` → `pickOption` → `act("select", …, sidecar.selectOption(id, chosen))`. Uses `res.unchecked` and `r.left`. | A `background_unavailable` error → fail "no options Ember can choose by accessibility…" (1649) |
| `set_value` (962-963) | do | `{ id, value: finite number }` | `act("value", …, sidecar.setValue(id, value))` | — |
| `change_setting` (964-972) | do, **always** | `{ setting: z.enum(Object.keys(SETTINGS)), value: string ≤20 }`. The description is built from the `SETTINGS` values. | `system("setting", …)` → `changeSetting` from hands/system (gsettings) | No gsettings: `hasKey` catches the error → "X is not available on this desktop" (system.ts:89). The tool is still offered, and the persona tells the model to use it. If `SETTINGS` were empty, `z.enum([])` would be invalid: the tool must be **omitted** instead. |
| `open_on_desk` (973-1002) | do, only if `d.desk` | `{ name: string(1..100) }` | `findApp(listApps(), name)`, `isTerminalApp`, `d.desk()`, `place.userInControl()`, `setPlace(place)`, `place.perception.windows()`, `place.open(app)` (a pid). It polls 60 × 250 ms for the app's window (a named one, by pid, or else a new one). The reply names `place.info.handOff`. | Not offered. Every desk branch in other tools is null-safe while `place` is null. |
| `open_app` (1003-1027) | do, **always** | `{ name }` | `findApp(listApps(), name)`, then `isTerminalApp`. `system("open_app", …)`: `setPlace(null)`, then `launchApp(app)` (gtk-launch or the Exec line). It polls 40 × 250 ms for a new window whose `app` (lower-cased) is in `programsOf(app)` (the desktop id minus `.desktop` and the Exec argv basenames, `LAUNCHERS` removed, 697-702), or whose title contains the app name. After 2 s it accepts any window of the program. | Off Linux, `listApps()` finds nothing (XDG dirs) → "No installed app matches …" |
| `press_keys` (1029-1032) | do, if `cursor \|\| desk` | `{ keys: string(1..40) }`. The description's examples are `"ctrl+s"`, `"Return"`, `"ctrl+shift+t"`. | `pressKeys` (2660-2733): `steadyFocus` (repeated `perception.read(target, null, undefined, { keep: false })` plus `focusedElement`), then policy, then `withCursor("keys", …)` → `hand.keys(keys)` | Not offered |
| `scroll` (1033-1035) | do, if `cursor \|\| desk` | `{ id, direction: up\|down\|left\|right, steps?: 1..30 }` (default 5) | `scroll` (2740-2867): `fresh`, `readElement(id, { shown: true })`, `landingSpot`, `mustAimAt`, `perception.read`, `perception.atPoint` (only if `axScale === 1` and pid and path are known), then `withCursor("scroll")` → `hand.glideTo` and `hand.scroll`, one notch at a time | Not offered |
| `point_at` (1037-1052) | guide | `{ id, say ≤160 }` | `sidecar.readElement(id)` → `fly(targetBox(...))` → `presenter.guide(...)` → audit `kind: "point"` | Needs `node.bounds`. Without a usable box, `fly(null)`. |
| `wait_for_click` (1053-1055) | guide | `{ id, timeoutSeconds?: 5..300 }` (default 90) | `waitForClick` (1239-1412): polls `d.pointer` every 15 ms (`mask & 256`, press edges inside the box ± pad); `sidecar.readElement` every 500 ms (state key); `d.activationKey` (Enter/Space while reached); `d.cursor?.activeWindow?.()` (another window took the keyboard; `own` = pid is `process.pid`) | No `pointer` → never "clicked"; it relies on state, window and keyboard changes. No `activationKey` → Enter/Space is not seen. No `cursor.activeWindow` → the window-change detection is off. It falls back to "The user hasn't clicked it yet…" at the timeout. |
| `report_progress` (1056-1057) | both | `{ text ≤200 }` | `d.onProgress` and `presenter.progress` | — |
| `finish_task` (1058-1068) | both | `{ success, summary ≤400 }` | Sets the result, `ended.abort()`, `fly(null)`, aborts the session after 50 ms | — |

### 3.3 Key private paths

**`act(kind, id, value, run, mode)`** (1669-1770) is the one path every tier-1 window action takes:

1. `place?.userInControl()` → `deskTaken`.
2. `fresh(id)` (1501-1516) re-reads the element and fails if it is gone, busy, has another role, or is disabled.
   `isDisabled` (731) is `states.length > 0 && !states.includes("sensitive") && !states.includes("enabled")`.
   **Invariant for any sidecar: an enabled element must carry `"enabled"` or `"sensitive"` whenever it reports any
   states.**
3. A sheet cell with kind `text` → `typeInCell`.
4. `route()` (1780-1813) uses `sidecar.canDo(id, kind, insert)` when that method exists. It reads the `CanDo` fields
   `tier1`, `why`, `action` (`"select row"`, `"select item"`, `"toggle"`, `"clickancestor"`), `handler { role, name }`,
   `handlerUnknown`, `focused` and `windowActive`.
   - No `canDo` → `{ via: "tier1" }`.
   - `!tier1` → `withoutTier1` (1837-1846): "borrow" when `(place || d.cursor) && node.bounds` and the action is a
     click, a toggle, or text into a typable field (role in `TYPING_ROLES` with the `editable` state). Otherwise it
     returns a fail message.
5. `authorize(req)` (3064-3134): `PolicyEngine.decide`, then the confirm question, then audit.
6. `stillSame` (after a question).
7. `d.lease(window.name || window.app, …)`.
8. `fly(node.bounds)`, then a 350 ms pause.
9. `run()`, then the result is verified:
   - `notTurned` for toggles.
   - `textNotTaken` for text (`after.text`; the sidecar reads at most 2000 characters).
   - The audit entry records `after` / `busy` / `gone`.
   - `res.action === "select row"` / `"select item"` changes the wording of the reply.
10. Error strings the worker parses:
    - `"background_unavailable"` (1750; the prefix `"background_unavailable: "` is stripped) → escalate to tier 3. The
      substring `"check box in a list"` (1757) makes the click flip a list check box.
    - `/did not answer/` (1761) → "The app didn't answer in time…".
    - `isBusy` (415): `/\bbusy\b|did not (receive a reply|answer)|timeout was reached/i` → BUSY.

    **The UIA and AX sidecars must use these words** (or the worker's wording logic must be generalised).

**`cursorAct`** (1855-1994) is tier 3 for one action:

1. Before asking, it pre-checks the aim: `readElement(id, { shown: true })`, `landingSpot` and `mustAimAt`.
2. `authorize`, then a live re-read.
3. It saves the clipboard if the text will be pasted (`paste` = user screen, a clipboard exists, and the text is not empty).
4. `withCursor`, inside which it:
   - checks the clipboard is unchanged;
   - re-reads with `{ shown: true }`;
   - `hand.glideTo`, then sleeps 100 ms;
   - re-reads and calls `mustAimAt` again;
   - `hand.click()`;
   - for text: `untilFocused`, then **`hand.keys("ctrl+a")` + `hand.keys("Delete")`** (replace) or
     **`hand.keys("ctrl+End")`** (append). Then `hand.type(text)` (desk or no clipboard; ASCII only) or
     `clipboard.writeText` + **`hand.keys("ctrl+v")`**.
5. `afterBorrow`: `notTurned` and `pasteLanded`.
6. `finally`: the clipboard is restored (a password-manager copy is cleared instead).

**`withCursor(kind, element, fn, verifyId?, afterBorrow?, keysOnly)`** (2903-2968), in order:

1. Stopped → `STOPPED`.
2. On the desk → `onDeskInput` (2971-3008).
3. No `d.cursor` → **fail "This needs the mouse or keyboard, which isn't available here. Try open_on_desk."** (2906).
4. `authPrompt()` = `isSecurityWindow(c.activeWindow?.())` → denied. **If `activeWindow` is undefined, this guard is
   silently off.**
5. `perception.systemDialogOpen()` (sidecar `shell_overlays`; errors are caught → false, which **fails open**) → denied.
6. `window.name` must be known.
7. `win = c.findWindow(window.name, target.pid)`; 0 → fail "can't tell which window that is (none or several have that
   title)".
8. `lease`, then `c.borrow.borrow(hand => fn(guardedHand(...)), { window: win, signal, onStart: () =>
   c.setBorrowing("active"), keysOnly? })`.
9. `c.setBorrowing("waiting")`, then `fly(null)` (Ember rides along with the cursor).
10. Await the borrow, then `setBorrowing("off")`, then `afterBorrow`.
11. `readElement(verifyId)`, then the audit entry with tier 3.
12. Errors: `UserTookOver` → denied "The user took the mouse back…". `BorrowStopped` → `STOPPED`.

**`system(kind, value, run, app)`** (3022-3037) is tier 0. It authorizes `{ kind: "setting" | "open_app", app, window:
"", value }`. The policy answers "reversible / allow / easy to undo" (policy.ts:1852) unless the app is never-look or
`isTerminalApp` (1811, 1817). Then it runs `run()` and writes the audit entry. `BorrowStopped` → `STOPPED`;
`UserTookOver` → `deskTaken`.

### 3.4 Accessibility vocabulary the worker hard-codes

The UIA and AX sidecars must speak the AT-SPI vocabulary, or the worker's logic quietly stops applying.

- **Roles:** `push button`, `toggle button`, `split button`, `button`, `link`, `menu`, `menu item`, `check menu item`,
  `radio menu item`, `check box`, `radio button`, `switch`, `combo box`, `spin button`, `slider`, `scroll bar`, `page tab`,
  `page tab list`, `list`, `list item`, `tree item`, `table`, `table cell`, `text`, `entry`, `password text`,
  `paragraph`, `document text`, `document web`, `document frame`, `document spreadsheet`, `section`, `heading`, `label`,
  `static`, `block quote`, `dialog`, `alert`, `file chooser`, `color chooser`, `font chooser`, `frame`, `window`,
  `root pane`, `panel`, `filler`, `scroll pane`, `viewport`, `tool bar`, `menu bar`, `popup menu`, `tool tip`,
  `terminal`, `search`, `search box`, `icon`.
  Sources: worker.ts:154-190, 354-360, 489-494, 536, 562, 1232, 1530.
- **States:** `enabled`, `sensitive`, `focused`, `selected`, `checked`, `pressed`, `expanded`, `editable`, `multi line`.
  Plus `ElementInfo.offscreen`, `open`, `shown`, `secret`, `withheld`, `formula`, `value`, `selected`, `text`.
- **Spreadsheets:** `AxNode.grid`, `size`; a cell's name is its address (`isSheetCell`: role `table cell` and the name
  matches `CELL_ADDRESS`). The cell-filling keys are LibreOffice Calc's: `ctrl+Home`, `ctrl+shift+F5` for the Name Box,
  `Delete`, `Return`.
- Mnemonic underscores (`_Cancel`) and GTK file-dialog heuristics (`SAVE_TITLE`, `DISMISS`) are harmless elsewhere.

---

## 4. When a dependency is undefined

| Undefined | Effect |
|---|---|
| `hands` (whole) | No tasks or guides (§1.2). |
| `cursor` and `desk` | `press_keys` and `scroll` not offered. Tier-1 failures cannot escalate (`withoutTier1` → "This can't be done without the mouse; tell the user in finish_task."). `type_text(cell)` and `fill_cells` fail with "Try open_on_desk.". `withCursor` fails with "Try open_on_desk.". |
| `cursor` only (desk present) | `press_keys` and `scroll` are offered but only work once on the desk; on the user's screen they fail "…Try open_on_desk.". |
| `cursor.activeWindow` | **The auth-prompt guard in `withCursor` is off**, and so is the guide's window-change detection. Make it **required** on new platforms. |
| `clipboard` | Tier-3 text is typed key by key and must be printable ASCII (`typeableText`). Otherwise: "Ember can only type plain ASCII…". |
| `pointer` | The guide never detects a click by position. |
| `activationKey` | The guide never detects Enter or Space. |
| `desk` | `open_on_desk` not offered. The `place` code paths stay dormant; `setPlace(null)` is a no-op while `place` is null (832). |
| `onDesk` | No mini-view (null-safe `?.`). |
| `sidecar.canDo` | `route()` always tries tier 1, then escalates on `background_unavailable`. |
| `sidecar.scaleOf` | `k = 1`. |
| `perception.atPoint` (or a target with no pid or path) | `mustAimAt` aims blind (no check for covered spots or another control). `scroll` reads the whole window for each notch and refuses when the read is truncated. |
| `perception.systemDialogOpen` throws | Treated as "no dialog" (**fails open** for borrows). |
| `inotifyUsedUp` | Ignored (returns false off Linux). |

---

## 5. The minimum each tier needs

### 5.1 Tier 1: accessibility actions on the user's screen (plus `describe_screen`, `show_me` and guides)

**Hands (required):** `perception`, `sidecar`, `policy`, `audit`, `confirmer`, `flyTo`, `currentWindow`.

**Sidecar methods** (JSON-RPC, the same protocol as `ember_atspi.py`):

- Required: `read_window` (pid / title / path / ownPid / neverLook / skipPids / keep / cells → `ReadWindowResult`),
  `list_windows`, `read_element` (`shown`, `formula`), `do_action` (`click`, `toggle`), `set_text`, `set_value`,
  `select_option`, `list_options`.
- Strongly recommended: `can_do` (lets the user be asked the right question), `at_point` (aim checks), `secret_fields`
  (screenshots fail closed without it when a read is truncated), `shell_overlays` (system-dialog guard), `mark_secret`,
  `remember_secrets`, `status`.
- Windows must carry `pid` and `path`; otherwise `atPoint` and `secret_fields` are never used (perception/index.ts:175,
  514).

**Other requirements:**

- `currentWindow()`: the foreground top-level window as `{ pid, title }`, `{ pid }` for a private one, or null for
  Ember's own windows. It needs a "class" (`wmClass` analogue) for the never-look and security checks.
- Screenshots (`perceive_window` with `image`) also need a capture backend plus a z-ordered window stack (`X11.stack()`
  analogue: `id`, `client`, `pid`, `title`, `wmClass`, bounds, `outer`, `inner`, `overrideRedirect`). Otherwise
  "(No screenshot …)". Covered in the perception spec; noted here because `perceive_window` depends on it.

**Tools that then work:** `perceive_window`, `list_windows`, `switch_window`, `click`, `toggle`, `type_text(id)`,
`choose_option`, `set_value`, `report_progress`, `finish_task`; in guide mode `point_at` and `wait_for_click` (degraded,
see `pointer` and `activationKey`).

### 5.2 Tier 3: the borrowed cursor and keyboard

`Hands.cursor = { borrow, findWindow, activeWindow, setBorrowing }` with:

- `borrow = new CursorBorrow(input, { onChange, mayRefocus })`, where `input` implements `XInput` (§2). Semantics
  `CursorBorrow` relies on:
  - `keysym(sym, down)` / `keycodeOf(sym)` / `keysymOf(name)` take **X keysym names and values**.
  - `pointerState().mask` uses X bits: Button1Mask = 256; buttons are `0x80 << n`; `BUTTONS_MASK = 0x1f00`
    (borrow.ts:93, 341).
  - Scroll is buttons 4/5/6/7 (borrow.ts:401).
  - `screenSize()` is assumed to start at (0, 0): `glideTo` throws "off the screen" for any negative coordinate
    (borrow.ts:321-323). **Windows and macOS have negative coordinates for displays left of or above the primary.**
    Add `screenRect()`, or offset.
  - `activeWindow()`, `focusedWindow()`, `findWindow()` and `activate()` share **one id space** (§6).
  - `activate` must really bring the window to the front within 1 s, otherwise "the window didn't come to the front"
    (borrow.ts:421-427). On Windows, `SetForegroundWindow` is subject to the foreground lock; plan for the usual
    workaround.
  - The optional guards should be implemented where possible: `keyboardGrabbed` (secure desktop, lock screen),
    `pointerOn` (click-through and cover check), `screenLocked`, `watchUser` / `userInput` (user-took-over detection
    between polls).
- `findWindow(title, pid)`: the semantics of hands/input.ts:37-44. Within the pid's windows an exact title wins over
  "contains". Without the pid's windows, only an exact title counts. 0 if none or several.
- `activeWindow()`: `{ app, title, pid }` of the window with **keyboard focus**. Fed to `isSecurityWindow`
  (policy.ts:403-407), whose app list is Linux-only (§9).
- `setBorrowing`: main's `showBorrowing`.
- Recommended: `clipboard` (`electronClipboard` already works everywhere, but the password-manager marker it knows is
  only `x-kde-passwordManagerHint`, agent/clipboard.ts:54-59; add `org.nspasteboard.ConcealedType` (macOS) and
  `ExcludeClipboardContentFromMonitorProcessing` (Windows)).
- Guides: `pointer` (mask bit 256) and `activationKey`.

**Main-side expectations of the input backend:**

- `mayRefocus` (main.ts:1217) compares ids with `askWindow.isWindow(w)` and `shownWindows()` (the X11 stack). The other
  platforms need the same id space for Ember's own windows; see §6 about `getNativeWindowHandle`.
- `xinputRef.activate(xid)` and `focusInput` are also used by `bringToFront` (238), `giveFocusBack` (429-437) and the ask
  box (624).

### 5.3 Tier 0: `change_setting` and `open_app`

Today these are module imports from `hands/system` (worker.ts:29), not `Hands` fields. The minimum platform surface,
with the same signatures:

```ts
SETTINGS: Record<SettingName, string>          // descriptions; may be {} → the change_setting tool must be omitted
changeSetting(name, value): Promise<{ before: string; after: string }>   // throws Error(message) on failure
listApps(): DesktopApp[]                        // { id, name, file, keywords, exec?, generic?, categories?, terminal? }
findApp(apps, query): DesktopApp | null         // generic ranking; reusable as is
launchApp(app): void                            // detached; throws for terminal apps
isTerminalApp(app): boolean                     // also passed to PolicyEngine (main.ts:1251) and used in findApp's ranking
execArgv(exec): string[]                        // used by programsOf (worker.ts:699)
```

Invariant for `open_app`: `programsOf(app)` (worker.ts:697-702), the desktop id minus `.desktop` plus the Exec argv
basenames, lower-cased, must contain the **same string the sidecar reports as `AxWindow.app`** for that app's windows.
Otherwise the new window is found only if its title contains the app name.

- macOS: "TextEdit" opens "Untitled", so it fails and the user gets "Started TextEdit, but its window hasn't appeared yet".
- Windows UWP apps: the window process is `ApplicationFrameHost.exe`.

Recommendation: add `programs?: string[]` to `DesktopApp`, have `programsOf` prefer it, and inject a `SystemBackend`
through `WorkerDeps`, so the worker no longer imports `hands/system`.

Platform notes for implementers (verify before relying on them):

- **Windows settings.** These have documented per-user registry values:
  - dark mode: `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, `AppsUseLightTheme` /
    `SystemUsesLightTheme`, then broadcast `WM_SETTINGCHANGE` "ImmersiveColorSet";
  - text size: `HKCU\Software\Microsoft\Accessibility\TextScaleFactor`;
  - clock seconds: `HKCU\...\Explorer\Advanced\ShowSecondsInSystemClock`.

  Night light and Focus/Do Not Disturb have no public API; battery percentage does not exist on Windows. Offer only
  what works.
- **macOS settings.** Dark mode works through System Events AppleScript, which needs the Automation permission. Night
  Shift and Focus have no public API.
- **Windows apps.** Start Menu `.lnk` files (`%ProgramData%` and `%AppData%` `\Microsoft\Windows\Start Menu\Programs`)
  plus Store apps (`shell:AppsFolder`, e.g. `Get-StartApps`). Launch with `ShellExecute` / `explorer.exe
  shell:AppsFolder\<AUMID>`.
- **macOS apps.** `.app` bundles in `/Applications`, `/System/Applications`, `/System/Applications/Utilities` and
  `~/Applications` (`Info.plist`: `CFBundleIdentifier`, `CFBundleName`, `CFBundleDisplayName`, `CFBundleExecutable`).
  Launch with `open -b <id>`.

---

## 6. How window identity flows

There are three different things, and they must not be confused:

1. **Native window ids (numbers).** They live only inside one borrow.
   - Producers: `cursor.findWindow(title, pid)` (worker 2928); `place.input.findWindow(...) || deskDialogWindow(place)`
     on the desk (2987, 3015-3019, from `place.x11.stack()` / `deskWindowAt`).
   - The id goes to `CursorBorrow.borrow({ window })`, which calls `x.activate(window)`, compares with
     `x.focusedWindow()`, passes it to `x.keyboardGrabbed?.(window)` and `x.pointerOn?.(window, elementWindow)`,
     records `previousWindow = x.activeWindow()`, and on restore calls `mayRefocus(previousWindow)` then
     `x.activate(previousWindow)`.
   - main's `mayRefocus` compares the id with `askWindow.isWindow(w)` (the `getNativeWindowHandle()` low 32 bits) and
     with `shownWindows()` (`x11Ref.stack()`, `client` or `id`) (main.ts:428, 1217).
   - The worker **never stores** an id: it is looked up again for every borrow. So ids only need to be consistent
     across `findWindow`, `focusedWindow`, `activeWindow`, `activate`, the stack and Ember's own windows for a few
     seconds.
   - They are JavaScript numbers; 0 means none.
2. **Window descriptions (objects without an id):**
   - `cursor.activeWindow()` → `{ app, title, pid }` (keyboard focus): `isSecurityWindow` and the guide's "another window
     has the keyboard" check (1386-1402). Ember's own windows are recognised by `pid === process.pid`.
   - `Hands.currentWindow()` → `{ pid, title }` or `{ pid }` (the window-manager-active window).
3. **Accessibility targets** (`WindowTarget { pid?, title?, path? }`): `spec.target`, then the worker's `this.target`
   (set by `perceive()` to `{ title, pid, path }`, by `open_app` / `open_on_desk` to `{ title, pid }`, and by
   `switch_window` to `{ title }`). They feed `perception.read` / `perceive` / `atPoint`. `target.pid` is also passed to
   `findWindow` as the narrowing pid.

**Pitfalls per platform:**

- **Windows.**
  - Use the top-level HWND, cast to a number (HWNDs are 32-bit significant). `getNativeWindowHandle()` gives the HWND
    (8 bytes): `readUInt32LE(0)` happens to work, but prefer reading 64 bits and converting.
  - `GetForegroundWindow` → walk to the root (`GetAncestor(GA_ROOT)`) so it compares equal with `findWindow`.
  - UWP / ApplicationFrameHost: the pid that UIA reports for the content may differ from the frame HWND's pid, so the
    pid-narrowed `findWindow` falls back to an exact title. Handle this explicitly.
  - Elevated windows: UIPI makes `SendInput` and UIA actions on them fail silently or with access denied. Detect this
    (the process's integrity level) and refuse with a clear message.
- **macOS.**
  - `getNativeWindowHandle()` is an **`NSView*` pointer, not a window number**, so `readUInt32LE(0)` is garbage. Use
    `getMediaSourceId()`, which is `"window:<CGWindowID>:0"` (electron.d.ts:2843-2848), for Ember's own windows.
  - There is no "activate window by id" API. Keep an id → (pid, `AXUIElementRef`) table. Activate with
    `NSRunningApplication activate` plus `AXRaise` / `kAXMainAttribute`. Map AX windows to `CGWindowID` with the private
    `_AXUIElementGetWindow`, or match by pid and bounds.
  - Reading other apps' window titles through `CGWindowListCopyWindowInfo` needs the **Screen Recording** permission.
    AX titles need only the Accessibility permission, which is required anyway.
- On every platform, update `askWindow.isWindow` and `DeskView.isWindow` (desk/view.ts:203-205), which use
  `getNativeWindowHandle().readUInt32LE(0)`.

---

## 7. Coordinates and scaling

**Today's invariant** (perception/index.ts:1-7): every position handed out is in physical X root pixels. Perception
scales HiDPI apps by `frameScale` (from the X11 stack). Without a stack, `frameScale` returns 1
(perception/index.ts:231-232). The sidecar remembers per-element scales (`scaleElements` / `scaleOf`) so that
`readElement` and action results are physical too.

Where the worker and main depend on it:

| Place | Assumption |
|---|---|
| `flyTo` (main.ts:1253) | DIP = physical / **primary** `scaleFactor`, with one global scale and origin. True only on X11. |
| `screenBounds` (main.ts:1172-1178) | The union of all displays' DIP bounds × the primary scale. |
| `captureRect` (perception/capture.ts) | The captured image has **1 image pixel per screen unit**: masks are applied as `m.x - origin.x`. `img.x` / `img.y` are in screen units. The marks overlay uses `scale = image px / screen px`. |
| `CursorBorrow.glideTo` | `move(x, y)` takes screen units; the bounds check assumes origin (0, 0) and `screenSize()`. |
| `landingSpot` / `mustAimAt` (2051-2118) | Element bounds, `shown` and `frame` are screen units. `atPoint` is used only when `sidecar.scaleOf(id) === this.axScale`, and divides the point by `k` before asking (perception/index.ts:183). |
| `scroll` (2786) | `atPoint` per notch only if the window's `axScale` is 1. |
| `waitForClick` | `pointer()` and element bounds must be in the same units. |

**Recommendation:** make "screen units" a per-platform choice, and give the platform `toDip(rect)` and
`screenRect()`.

- **Windows:**
  - Screen units = physical pixels. Electron is per-monitor-v2 DPI aware, so `GetCursorPos`, `SetCursorPos`,
    `GetWindowRect` and `SendInput` with absolute coordinates are physical.
  - `flyTo` must use `screen.screenToDipRect(null, rect)` (win32 only, electron.d.ts:12261). `screenBounds` must use
    the virtual-screen metrics (`SM_XVIRTUALSCREEN` …), which can be negative.
  - **The PowerShell 5.1 UIA sidecar must call `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` itself** (P/Invoke
    through Add-Type) before its first UIA call. Otherwise it may receive DPI-virtualised `BoundingRectangle` values on
    mixed-DPI setups. Don't rely on `powershell.exe`'s manifest.
  - The sidecar reports final screen units and never sets `axScale ≠ 1`.
- **macOS:**
  - Screen units = **points**. AX `kAXPosition` / `kAXSize`, CGEvent locations, `CGWindowList` bounds and Electron DIPs
    all share one global top-left-origin point space, so `flyTo` is the identity (dividing by 2 on Retina would put
    Ember in the wrong place).
  - The capture backend must return the image **resampled to 1 px per point** (the model image is downscaled to
    1280 px anyway), or `captureRect` must learn a pixel ratio.
  - Do not try to make "physical" global coordinates on macOS: with mixed-scale displays they are not well defined.
  - `screenRect()` is the union of display bounds in points.

---

## 8. The conductor's tools: `describe_screen`, `show_me`, `start_task` (conductor.ts:92-135)

- `describe_screen` (104-108) calls `describeScreen()` if given; otherwise it returns **"Ember can't read the screen in
  this session (no X11 display or accessibility service). Tell the user."** main always passes it as
  `() => seeing.describe()` (main.ts:1288). host wraps it so that what it read goes with the turn's tasks (host.ts:824).
  - `Perception.describe()` (perception/index.ts:349-371) works without X11. `focused()` then reads the target `{}`, and
    the sidecar picks the active window.
  - The "open windows" list falls back to the sidecar's `list_windows` when there is no X11 (379-396).
  - Without X11, Ember's own window being active is not detected as `EMBERS_OWN`. The sidecar's `ownPid` hides it, so
    the user gets "does not expose accessibility information" instead. Supply an active-window function from the
    platform to restore the X11 behaviour.
- `show_me` (114-118) calls `showMe(goal)` if given (host.ts:884-895, only when `tasks` exists); otherwise "Ember can't
  point at things in this session (no desktop access). Explain the steps in words instead." `guarded()` (370-372)
  refuses after Stop. host's `cantGuide` needs a working `perception.read`.
- `start_task` (109-113) follows the same pattern as `show_me` (host.ts:859-883: the admin `features.actions` check and
  the terminal-wording checks with `ASKS_TERMINAL` / `REFUSES_TERMINAL` / `NAMES_TERMINAL`, host.ts:29-42).

---

## 9. The desk (tier 2): Linux-only by design

### 9.1 How it works

- `DeskManager` (desk/desk.ts) starts Xvfb with an MIT cookie through `xauth` (stdin), a private `dbus-daemon`, a window
  manager (`metacity` / `openbox` / `xfwm4` if present) and private XDG folders, all marked `EMBER_DESK_ID`.
- `DeskAgent` (desk/agent.ts) forks `desk-agent.cjs` with `ELECTRON_RUN_AS_NODE=1` (agent.ts:94) behind a worker-thread
  relay, so that Ember's thread can make synchronous X calls (`Atomics.wait`).
- `agent-process.ts` does every X call there through koffi with `libX11.so.6` (agent-process.ts:28, 36, 107), `openX11`
  and `openXInput`.
- `openDeskPlace` (desk/place.ts:202-247) builds a `DeskPlace`: a second `AtspiSidecar` with the desk's environment, a
  `Perception` with `screenBounds = { 0, 0, w, h }`, and guarded `x11` / `input` facades. Launch recipes (`deskRecipe`)
  cover Firefox/Thunderbird profiles, LibreOffice locked down, and Chromium `--force-renderer-accessibility`.
- Linux-only mechanics throughout: `/proc/<pid>/stat` (`running`, `startTime`, `helperState`), `/proc/*/environ`
  (`deskProcesses`), `/proc/self/mountinfo`, `fusermount`, `/tmp/.X11-unix`, `/tmp/.X<n>-lock`, `process.kill(-pgid)`,
  `xauth`, `dbus-daemon`, `Xvfb`.

### 9.2 `DeskManager.available()` (desk.ts:369-372)

```ts
static available(): { ok: boolean; missing: string[] } {
  const missing = ["Xvfb", "xauth", "dbus-daemon"].filter(c => !which(c));
  return { ok: missing.length === 0, missing };
}
```

`which` (34-40) splits `PATH` on `":"` and has no `PATHEXT`.

- **Windows:** it splits `C:\…;C:\…` wrongly and looks for `Xvfb` without `.exe`, so it returns `ok: false`, by
  accident.
- **macOS:** it returns `ok: true` when XQuartz (`/opt/X11/bin/Xvfb`, `xauth`) and Homebrew `dbus-daemon` are on `PATH`.
  That is typical when Ember is started from a terminal or during development. Finder launches get launchd's minimal
  `PATH`. When it returns `ok: true`, `open_on_desk` **is offered** and then fails at runtime: `running()` reads
  `/proc`, which doesn't exist, so it always returns false, and `startDisplay` gives up after 5 tries with "the desk
  display didn't start". Even if Xvfb came up, `koffi.load("libX11.so.6")` fails in the helper.

### 9.3 Reporting the desk as unavailable on Windows and macOS (recommended changes)

1. Gate on the platform explicitly. Either:
   - `static available(): { ok: boolean; missing: string[]; unsupported?: true }` returns `{ ok: false, missing: [],
     unsupported: true }` when `process.platform !== "linux"`; or
   - put `desk: null` in the platform object.
2. main.ts:1270: `desk: platform.desk && DeskManager.available().ok && policy.features.desk !== false ? … : undefined`.
   Also make `onDesk` undefined when `desk` is (main.ts:1276).
3. Do not construct `DeskManager` off Linux (main.ts:1223). Its constructor (desk.ts:314-341) adds a
   `process.once("exit")` handler (scans `/proc`, busy-waits with `Atomics.wait`) and calls `reapDesks()` (`os.tmpdir()`
   scan, `process.getuid`). It is harmless today but pointless. `DeskView` (desk/view.ts:102-109, IPC only) may stay; the
   kill switch and `showBorrowing` use `deskViewRef?.` (null-safe).
4. With `d.desk` undefined, the worker never offers `open_on_desk` (worker.ts:973) and only offers
   `press_keys` / `scroll` with a cursor (1028). Then fix the text that still names the desk:
   - worker.ts:2196 and 2229: "Try open_on_desk." in `typeInCell` / `fillCells`;
   - worker.ts:2906: "Try open_on_desk." in `withCursor`;
   - worker-persona.ts:13: rule 4's second line (open_on_desk, `~/Ember`).

   `workerSystemMessage()` takes no arguments (worker-persona.ts:25); it needs `{ desk: boolean, … }`.
5. doctor.ts:102-104: the desk check's "Missing … so Ember works on your screen only" and its `sudo dnf install …` fix.
   On Windows and macOS, skip the check or report "Ember's desk is available on Linux only" as info.
   main.ts:199 passes `DeskManager.available()` to the doctor.
6. Packaging: `desk-agent.cjs` and the Python sidecar ship only in Linux builds (see the packaging spec).

Importing the `desk/*` modules on Windows or macOS is safe. No native library loads at import time: koffi is loaded only
inside the helper's `main()`, and `worker.ts` imports `DIALOG_ROLES`, `deskWindowAt` and the type `DeskPlace` from
place.ts.

---

## 10. Every place where text assumes Linux

All need platform-aware text. Model-facing text matters most, because it changes what the model tries.

| File:line | Current | Needed |
|---|---|---|
| persona.ts:11 | "…next to the user's mouse cursor on their Linux desktop (RHEL, GNOME)." | The platform name ("Windows PC", "Mac"). `emberSystemMessage()` needs parameters. |
| persona.ts:25 | "(the terminal, Files, a browser)" | Platform file manager: File Explorer / Finder |
| worker-persona.ts:6 | WORKER_IDENTITY "…real Linux desktop applications (RHEL, GNOME)…" | Platform name |
| worker-persona.ts:11 | Rule 3: "For Night Light, dark style, Do Not Disturb, text size, battery percentage or clock seconds, use change_setting…" | Generated from the platform's `SETTINGS`; omitted when there are none |
| worker-persona.ts:13 | open_on_desk paragraph, "(~/Ember)" | Only when the desk is offered |
| worker-persona.ts:29 | GUIDE_IDENTITY "…Linux desktop applications (RHEL, GNOME)…" | Platform name |
| worker.ts:964 + hands/system.ts:15-22 | change_setting description from `SETTINGS` ("…in the top bar", "top-bar clock": GNOME) | Per-platform `SETTINGS` |
| worker.ts:1003 | open_app "(for example Text Editor, Files, Settings)" | Win: "Notepad, File Explorer, Settings"; Mac: "TextEdit, Finder, System Settings" |
| worker.ts:1030 | press_keys examples `"ctrl+s"`, `"Return"`, `"ctrl+shift+t"` | On Mac Cmd; see §11 |
| worker.ts:1082 | "Pick one in settings (Ctrl+Alt+E)" | Mac: Control-Option-E |
| worker.ts:1655 | "in a file dialog press Ctrl+L (or use its name field)" | GTK file chooser. Win: the File name box; Mac: Cmd+Shift+G |
| worker.ts:216 | `dialogNote`: "user named a file" only if `/[~/][\w.-]\|\.\w{1,5}\b/` matches | Add Windows paths (`[A-Za-z]:\\`, `\\`) |
| worker.ts:2196, 2229, 2906 | "Try open_on_desk." | Only when the desk is offered; otherwise "…tell the user in finish_task." |
| worker.ts:412 | `LAUNCHERS` (`gtk-launch`, `flatpak`, `gjs`…) | Add `open`, `explorer`, `cmd`, `rundll32` where relevant |
| conductor.ts:108 | "(no X11 display or accessibility service)" | "(no accessibility access)" plus the platform's permission hint (macOS Accessibility) |
| host.ts:281 | "Reinstall Ember (sudo dnf reinstall ember)." | Per platform |
| host.ts:29-42 | TERMINAL regexes (`gnome\|kde\|xfce`); misses "PowerShell", "cmd", "Windows Terminal", "iTerm", "Warp" | Extend; this is a safety rule |
| host.ts:181-183 | inotify messages | Linux-only; never triggered elsewhere (inotifyUse → null) |
| hands/system.ts:89 | "…is not available on this desktop" | OK |
| desk/desk.ts:384 | "dnf install xorg-x11-server-Xvfb…" | Linux-only path |
| doctor.ts:102-104 | Desk check text and `dnf` fix | §9.3 step 5 |
| policy.ts:400 | `SECURITY_APP = /polkit\|gcr-prompter\|pinentry\|ssh-askpass\|ksshaskpass\|^firewall-config$\|(^\|\s)gnome-shell(\s\|$)/i` | Add Windows (`CredentialUIBroker`, `consent`, `LogonUI`, "Windows Security") and macOS (`SecurityAgent`, `coreautha`, `loginwindow`). It feeds `withCursor`'s auth guard, `currentWindow` privacy and the perception masks. |
| policy.ts:1829 | "desktop shortcuts (the logo key, terminals, the run dialog, switching sessions)…" | See §11 |
| hands/system.ts:136-162, 317-323 | `isTerminalApp` misses Windows "Command Prompt" (`cmd.exe`), "Windows PowerShell" (`powershell.exe`), `pwsh.exe` (`SHELLS` has `pwsh` but is anchored, so `.exe` defeats it), `wsl.exe`, `bash.exe`, `mintty` (Git Bash) and PowerShell ISE. Only names containing "terminal" or "console" are caught ("Windows Terminal" is). On macOS it misses iTerm2 ("iTerm"), Script Editor, Automator and Xcode ("Terminal" is caught). The policy's `isTerminalApp: name => isTerminalApp({ id: name, name })` (main.ts:1251) receives the sidecar's `app` string (a process name on Windows), so `cmd`, `powershell` and `conhost` would pass. | Platform lists. **Safety-relevant**: `open_app`, `open_on_desk` and the policy rely on it. |

Presenter step words (presenter.ts:235-269) are platform-neutral.

---

## 11. Keys and shortcuts (cross-cutting; a blocker on macOS)

- `Hand.keys(combo)` uses `parseCombo` (borrow.ts:101-114). Modifiers are only `ctrl | control | shift | alt | super |
  meta` (and their `_l` / `_r` forms); `"cmd"` throws `unknown modifier "cmd"`. Key names are X keysyms (`Return`,
  `BackSpace`, `Prior`, `Next`, `Delete` = forward delete).
- Keystrokes the worker sends itself:
  - `cursorAct`: `ctrl+a`, `Delete` (replace), `ctrl+End` (append), `ctrl+v` (paste) at worker.ts:1952-1962.
  - `fillCell` / `toCellByName` / `clearCell`: `ctrl+Home`, `ctrl+shift+F5`, `Return`, `Escape`, `BackSpace`, `Delete`
    (2389, 2414-2415, 2483, 2533-2534, 2555-2569).

  On macOS these are wrong: Ctrl+A goes to the line start, **Ctrl+V scrolls a page in Cocoa text instead of pasting**,
  and Ctrl+End does nothing. On Windows they are right.
- Policy (policy.ts): `LOGO_KEY` maps `cmd`, `command`, `win` and `windows` to `super` (531), and
  `isSystemKey(k) === true` for any combination containing `super` (566). That gives a `never` verdict (1829), so **every
  Cmd shortcut the model asks for on macOS is refused**.
  - `SAFE_COMBOS`, `DESTRUCTIVE_KEYS` and `PASTE_KEYS` (576-584), `afterKeys`'s `"ctrl+a"` select-all (worker.ts:463),
    `SELECTS`, `MOVES_CARET` and `onlyMoves` are all written for Ctrl.
  - The Windows logo-key combinations stay system keys, which is correct.
- Recommended model for macOS: keep **"ctrl" as the portable primary modifier** in Ember's own strings and in the
  policy. On macOS:
  - `canonicalKeys` / `parseCombo` map `cmd` / `command` (not `super`) to the primary modifier;
  - the mac input backend presses ⌘ for it;
  - a distinct name (e.g. `"macctrl"`) reaches the real ⌃ key;
  - Ember's own `ctrl+End` / `ctrl+Home` become `cmd+Down` / `cmd+Up` where Cocoa needs them;
  - the press_keys description on macOS says "cmd+s".

  This is owned by the policy and input specs, but the worker cannot work on macOS without it.
- The XInput contract is keysym-based (`keysymOf(name)`, `keycodeOf(sym)`, `needsShift(sym)`, `layout()`). The Windows
  and macOS input backends must translate X keysyms to VK or `kVK` codes, including `planTyping` / `shortcutStroke` /
  `layout()` semantics (hands/keymap.ts), or provide `layout(): null` and accurate `keycodeOf` / `needsShift`.

---

## 12. Recommended refactor for this subsystem

```ts
// app/main/platform/types.ts (sketch: only what Hands/worker/desk need)
export interface NativeWindow { id: number; pid: number | null; title: string; app: string /* wmClass analogue */ }
export interface HandsPlatform {
  id: "linux" | "win32" | "darwin";
  activeWindow(): NativeWindow | null;          // currentWindow; describe's EMBERS_OWN
  focusWindow(): NativeWindow | null;           // cursor.activeWindow
  ownWindowId(win: BrowserWindow): number;      // replaces getNativeWindowHandle().readUInt32LE(0)
  toDip(r: Bounds): Bounds;                     // flyTo
  screenRect(): Bounds;                         // Perception.screenBounds, CursorBorrow bounds
  openInput(): XInput | null;                   // tier 3 backend (XInput-shaped, keysym vocabulary)
  system: SystemBackend;                        // tier 0 (SETTINGS may be {})
  desk: { available(): { ok: boolean; missing: string[] } } | null;   // null on win32/darwin
  sidecar: { command: string; args: string[]; env: NodeJS.ProcessEnv };   // AtspiSidecar spawn recipe
  text: { os: string; exampleApps: string; fileManager: string; keysExample: string; fileDialogHint: string; reinstall: string; settingsShortcut: string };
}
```

The main.ts assembly becomes `const hands = platform.hasDesktop() ? { … } : undefined`:

- `currentWindow` uses `platform.activeWindow()`.
- `flyTo` uses `platform.toDip`.
- `cursor.activeWindow` uses `platform.focusWindow()` and is **required**.
- `desk` is set only when `platform.desk?.available().ok`.

`WorkerDeps` gains `system: SystemBackend` and `text`. `workerSystemMessage({ desk, settings, text })` and
`guideSystemMessage({ text })`. `AtspiSidecar` gets a generalised spawn (`command` + `args`): today it always runs
`spawn(python, [script])` (perception/sidecar.ts:217).

- Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File …`.
- macOS: `process.execPath <script>` with `ELECTRON_RUN_AS_NODE=1`. Note that `appEnv` drops `ELECTRON_*` for launched
  apps, which is correct; the sidecar is not launched through `appEnv`.

Tests to add: `tools()` names per platform (no `open_on_desk` or `change_setting` when unsupported); persona text per
platform; `withCursor` refusing without `activeWindow`; `flyTo` conversion per platform; `findWindow` / `focusedWindow`
id consistency through fakes; macOS key mapping through the policy.

---

## 13. To verify on real machines

- macOS: whether `CGEventSourceKeyState` / `CGEventSourceButtonState` (for `activationKey` / `pointer`) need the Input
  Monitoring permission on 13+. If they do, request it or leave both undefined; the worker tolerates that.
- Windows: the reliability of `SetForegroundWindow` for `activate()` within CursorBorrow's 1 s wait. `SendInput`
  behaviour against elevated windows (UIPI) and the secure desktop.
- Windows: whether UWP frames report the content's pid or ApplicationFrameHost's through UIA and through
  `GetWindowThreadProcessId`; what that does to `findWindow(title, pid)` and `programsOf`.
- Excel (UIA) and Numbers (AX): whether they can be mapped to the `table cell` / `grid` / address-name contract so that
  `type_text(cell)` and `fill_cells` work. Today the cell keys are LibreOffice Calc's.
