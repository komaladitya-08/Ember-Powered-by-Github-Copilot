# The UI Automation bridge: wire protocol (version 1)

Ember's accessibility on Windows is two processes. The **sidecar host** (`dist/app/ax-sidecar.cjs`, TypeScript) speaks
Ember's JSON-RPC protocol to Ember and holds every rule: element ids, secret detection and withholding, labels, the
AT-SPI role and state vocabulary, budgets and verification. Below it, this **bridge** (`ember_uia.cs`, C# 5 on .NET
Framework 4.x, started through `ember_uia.ps1` by Windows PowerShell 5.1) exposes raw UI Automation facts and actions
and nothing else: control types are UIA's own names, and there are no word lists and no policy.

The bridge has one safety job of its own: it never reads the value or text of a password field (`IsPassword`), and no
screen text ever passes through a PowerShell cmdlet (module logging, script block logging and transcription would
record it).

This file is the contract the host's bridge client implements. `test/unit/uia-files.test.ts` checks that the methods
listed under "Methods" are exactly the ones in the bridge's dispatch table.

## Starting the bridge

```
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\ember_uia.ps1
```

- Use the absolute path of Windows PowerShell 5.1 (`GetSystemDirectoryW` or `%SystemRoot%`), never `pwsh` and never a
  `PATH` lookup. Spawn it with `windowsHide: true` (`powershell.exe` is a console program: without it a console window
  stays open for the bridge's whole life) and stdio `["pipe", "pipe", "pipe"]`.
- Environment: the parent's environment **without `PSModulePath`** (PowerShell 7's module folders break Windows
  PowerShell 5.1's autoloading; 5.1 rebuilds its default). Keep `SystemRoot`, `windir`, `TEMP`/`TMP` (the C# compiler
  writes there), `USERPROFILE`, `LOCALAPPDATA` and `PATH`. Never remove `__PSLockdownPolicy`: it is the
  administrator's choice, and the bridge reports what it causes (below).
- `EMBER_UIA_CACHE` (optional): a folder for the compiled bridge, e.g. `%LOCALAPPDATA%\ember\uia`. The bootstrap
  hashes `ember_uia.cs` (SHA-256) and loads `<cache>\ember_uia-<hash>.dll` when its own SHA-256 matches the
  `<cache>\ember_uia-<hash>.dll.sha256` written beside it; otherwise it compiles with `Add-Type -OutputAssembly` and
  moves the result into the cache. The DLL is loaded from bytes (`Assembly.Load(byte[])`), so the file is never
  locked and a Mark-of-the-Web never blocks it. Without the variable, or when the folder can't be written, it compiles
  in memory every time.
- Start-up time: a cold compile (csc, JIT, antivirus scanning the new DLL) takes several seconds; allow at least 20 s
  for the ready line of a new process. A start from the cache takes about as long as PowerShell itself (well under
  2 s).

## Framing

- One JSON object per line in each direction, UTF-8 without a byte-order mark, lines end with `\n` (a `\r` before it
  is accepted on input). The bridge writes **ASCII only**: every character outside printable ASCII is escaped as
  `\uXXXX` (UTF-16 code units, so astral characters are surrogate pairs), so the console code page never matters.
- Numbers are finite: a value that would be NaN or infinite is written as `null`.
- If the process exits before writing any line, PowerShell refused to run the script: a Group Policy execution
  policy (`AllSigned`, `RemoteSigned`) overrides `-ExecutionPolicy Bypass` for an unsigned script, and stderr says so.
  Report it once and don't restart in a loop.
- stdout carries only protocol lines. stderr is diagnostics only (PowerShell may write `#< CLIXML` records there); the
  bridge itself writes no screen text to stderr. Log it at debug level, never parse it.

### The first line

Exactly one of:

```json
{"ready":true,"version":1,"dpi":"per-monitor-v2"}
```

`dpi` is the DPI awareness the bridge's UIA threads run with: `"per-monitor-v2"` (expected), `"per-monitor"`,
`"system"` or `"unaware"`. Anything but `per-monitor-v2` means bounds may be scaled for some monitors; the host
should log it once.

```json
{"fatal":"Cannot add type. Definition of new types is not supported in this language mode.","languageMode":"ConstrainedLanguage"}
```

The bootstrap couldn't start the bridge (the message is PowerShell's or the compiler's, cut to printable ASCII). The
process then exits with code 1. `languageMode` is `$ExecutionContext.SessionState.LanguageMode`: `ConstrainedLanguage`
means AppLocker, WDAC or `__PSLockdownPolicy` forbids `Add-Type`, which is not something Ember can fix; a Group Policy
execution policy (AllSigned) fails the same way with the policy's own message. Don't restart in a loop after a fatal
line.

### Requests and answers

```json
{"id":7,"method":"snapshot","params":{"hwnd":132456,"deadlineMs":1500}}
{"id":7,"result":{"nodes":[...],"truncated":false,"cut":[],"busy":false}}
{"id":8,"error":{"code":"busy","message":"the app did not answer in time","pid":4242}}
```

- `id` is any JSON number or string and is echoed back unchanged. `params` may be left out (`{}`).
- **Answers can come out of order.** Every request runs on its own worker thread, so match answers by `id`. There is no
  limit on requests in flight (a hung app holds at most the requests sent to it).
- A line that isn't JSON, or has no `method`, is answered with `"id":null` and `bad_request`.
- Lines longer than 1 MiB are refused (`bad_request`).

### Errors

`error` is `{"code", "message", "pid"?}`. `pid` is present when the error concerns one process.

| code | meaning |
|---|---|
| `busy` | The app didn't answer within the deadline, or its process is marked busy (below), or no worker thread is free. Messages: `the app did not answer in time`, `the app did not answer in time (it may still do it)` (an action: it may still happen), `the app is not answering`, `too many requests are waiting for apps that do not answer`. |
| `gone` | The handle is unknown, released or evicted (`unknown handle N (released, evicted or never given)`), or the element no longer exists (`the element is no longer available`). |
| `denied` | Refused on purpose: `setValue` on a password field, or Windows denied access (an app running as administrator: UIPI). |
| `bad_request` | Malformed JSON, unknown method or `op`, a missing or ill-typed parameter. |
| `failed` | Everything else. `unsupported:<op>` when the element lacks the pattern an action needs; otherwise `<ExceptionType>: <message>` (for example `ElementNotEnabledException: ...`, `InvalidOperationException: ...`). |

### Deadlines, busy processes and hung apps

- Every method that talks to apps takes `deadlineMs` (default 800, clamped to 50-4000). The answer always arrives by
  then: if the work hasn't finished, the bridge answers `busy` at once (or, for `snapshot`, the nodes read so far
  with `busy: true`) and leaves the worker running.
- When a **read** times out, the target process is marked busy until that worker returns; meanwhile every request
  that touches that process is answered `busy` at once (`the app is not answering`), and other processes keep
  working. `status.busyPids` lists them.
- When an **action** (`perform`) times out, the answer is `busy` with `the app did not answer in time (it may still
  do it)`. The process is marked busy only if it also stops answering window messages (`SendMessageTimeout(WM_NULL)`
  with `SMTO_ABORTIFHUNG`, 300 ms): a button that opens a modal dialog keeps its `Invoke` call waiting until the
  dialog closes, and the dialog must stay readable and actionable meanwhile.
- The target process of a request is: the handle's process (handles), the window's process (`hwnd`), `pid`, the
  process of the top-level window under the point (`elementsAt`), or of the foreground window (`focused`).
- `topWindows` never waits for one process: each process is read on its own worker, and a process that is busy or
  doesn't answer in time is listed from Win32 facts alone with `busy: true`.

### Exit

The bridge exits with code 0 when stdin reaches end of file, within about 1.5 s even if a worker is stuck in a hung
app (`Environment.Exit`, then `TerminateProcess` as a backstop). Close stdin to stop it; kill it only if it doesn't
exit.

## Handles

- Elements are referred to by **handles**: positive integers from a table in the bridge. Every answer that lists an
  element registers a **new** handle (the same element read twice has two handles), so releasing one never breaks
  another read.
- `release` frees handles. The table also evicts the least recently used past 20 000 handles. An evicted, released or
  dead element answers `gone`.
- Handles die with the bridge. For an identity that survives a restart (secret fields), use `pid` + `runtimeId`.

## Units

Physical screen pixels, the same space as Win32 `GetWindowRect` and Ember's Windows window system (the bridge sets
Per-Monitor-V2 DPI awareness before any UIA call). Coordinates can be negative (monitors left of or above the
primary one) and can be fractional; the bridge never rounds or scales them.

## RawNode

One element. Every field except `h` is optional: a field is left out when UIA doesn't have it or reading it failed,
and strings are left out when empty. Strings are cut to 2000 characters.

| field | type | source |
|---|---|---|
| `h` | number | the handle |
| `parent` | number | index of the parent in the same answer, `-1` for the first node (snapshots and chains only) |
| `depth` | number | depth below the answer's root, which is 0 (snapshots and chains only) |
| `controlType` | string | `ControlType.ProgrammaticName` without `ControlType.` (`Button`, `Edit`, `Window`, ...); ids the .NET client doesn't know are named when known (`SemanticZoom`, `AppBar`) |
| `controlTypeId` | number | only when the control type has no name |
| `localizedControlType` | string | `LocalizedControlType` |
| `name` | string | `Name` |
| `automationId` | string | `AutomationId` |
| `className` | string | `ClassName` (`ConsoleWindowClass`, `TermControl`, `Chrome_RenderWidgetHostHWND`, ...) |
| `frameworkId` | string | `FrameworkId` (`Win32`, `WinForm`, `WPF`, `XAML`, `DirectUI`, `Chrome`, `Gecko`, ...) |
| `isPassword` | boolean | `IsPassword` |
| `isEnabled` | boolean | `IsEnabled` |
| `isOffscreen` | boolean | `IsOffscreen` |
| `hasKeyboardFocus` | boolean | `HasKeyboardFocus` |
| `isKeyboardFocusable` | boolean | `IsKeyboardFocusable` |
| `isControlElement` | boolean | `IsControlElement` |
| `bounds` | `{x, y, width, height}` or `null` | `BoundingRectangle`; `null` when empty or infinite |
| `pid` | number | `ProcessId` |
| `hwnd` | number | `NativeWindowHandle` (left out when 0) |
| `runtimeId` | string | `RuntimeId`, the integers joined with `.`; with `pid`, a key that is stable while the element lives |
| `labeledBy` | string | the `Name` of the `LabeledBy` element |
| `helpText` | string | `HelpText` (Chromium puts a field's placeholder here) |
| `itemStatus` | string | `ItemStatus` |
| `acceleratorKey` | string | `AcceleratorKey` |
| `accessKey` | string | `AccessKey` |
| `patterns` | object | see below; `{}` when none |
| `gone` | `true` | the element disappeared while it was being read (some fields may be missing) |
| `childCount` | number | snapshots only: how many children the element had, when more than `maxChildren` were found |
| `childrenCut` | `true` | snapshots only: not every child was listed (`maxChildren`) |
| `childrenFailed` | `true` | snapshots only: the children couldn't be read (an error other than `gone`) |

`patterns` holds one key per supported pattern:

| key | value |
|---|---|
| `invoke` | `true` |
| `toggle` | `"On"`, `"Off"` or `"Indeterminate"` (`ToggleState`) |
| `value` | `{value?, readOnly, truncated?}`. **`value` is never read for a password field** (`isPassword` true or unknown, or an `Edit` whose LegacyIAccessible state is `STATE_SYSTEM_PROTECTED`); it is also left out when the request asked for no values. `truncated: true` when it was cut to 2000 characters. |
| `range` | `{value, min, max, readOnly, smallChange}` (`RangeValuePattern`) |
| `expand` | `"Collapsed"`, `"Expanded"`, `"PartiallyExpanded"` or `"LeafNode"` (`ExpandCollapseState`) |
| `selectionItem` | `{selected}` (`SelectionItemPattern.IsSelected`) |
| `selection` | `{multiple, required}` (`CanSelectMultiple`, `IsSelectionRequired`) |
| `window` | `{modal, state, interaction}`: `IsModal`, `WindowVisualState` (`"Normal"`, `"Maximized"`, `"Minimized"`), `WindowInteractionState` (`"Running"`, `"Closing"`, `"ReadyForUserInteraction"`, `"BlockedByModalWindow"`, `"NotResponding"`) |
| `grid` | `{rows, columns}` (`GridPattern`) |
| `gridItem` | `{row, column}` (`GridItemPattern`) |
| `table` | `true` |
| `text` | `true` (`TextPattern`: use `textInfo`) |
| `scrollItem` | `true` |
| `legacy` | `{role, state, defaultAction?}`: MSAA role and state numbers and the default action verb (`LegacyIAccessible`). Only when asked for (`legacy: true`) and only where the element supports the pattern. |

## Methods

### `ping`

No params. Result: `{"version": 1}`. Answered at once on the reader thread.

### `status`

No params. Result:

```json
{"version":1,"dpi":"per-monitor-v2","handles":1234,"busyPids":[4242],"workers":9,"idleWorkers":7,"clr":"4.0.30319.42000","os":"Microsoft Windows NT 10.0.22631.0"}
```

`workers` is how many worker threads exist (at most 64), `idleWorkers` how many are free. Answered at once.

### `release`

Params: `{handles: number[]}`. Frees those handles; unknown ones are ignored. Result: `{}`. Answered at once.

### `topWindows`

Params: `{pid?: number, deadlineMs?}`. Lists the top-level windows: the children of the desktop root element in the
control view, enumerated through Win32 in z-order (front-most first, `GetTopWindow`/`GetWindow(GW_HWNDNEXT)`) so a
hung app can't stall the listing. Windows that aren't visible (`IsWindowVisible`), are cloaked (`DWMWA_CLOAKED`: other
virtual desktops, suspended UWP frames), have no area, or aren't control elements are left out. With `pid`, only that
process's windows.

Result: `{"windows": Window[]}`, front-most first. A `Window` is a RawNode of the window (values not read) plus:

| field | type | meaning |
|---|---|---|
| `hwnd` | number | the window handle (always present) |
| `pid` | number | the process that owns the window (`GetWindowThreadProcessId`). For a UWP app this is the frame's process (`ApplicationFrameHost`), so it matches Ember's window stack |
| `processName` | string | the program's file name without `.exe`, as Windows reports it (`QueryFullProcessImageNameW`: `notepad`, `msedge`, `WINWORD`). For an `ApplicationFrameHost` frame, the hosted app's program (the `Windows.UI.Core.CoreWindow` child of another process: `CalculatorApp`, `SystemSettings`); `ApplicationFrameHost` when it has none. The same rule as `wmClass` in `app/main/platform/types.ts` |
| `hostedPid` | number | the hosted app's process, for an `ApplicationFrameHost` frame |
| `owner` | number | the owner window's handle (`GetWindow(GW_OWNER)`), when it has one |
| `isModal` | boolean | `WindowPattern.IsModal` |
| `windowState` | string | `WindowPattern.WindowVisualState` |
| `isTopmost` | boolean | `WS_EX_TOPMOST` |
| `focused` | boolean | it is the foreground window (`GetForegroundWindow`), which holds the keyboard focus |
| `z` | number | position in the z-order among the windows enumerated, 0 = front-most |
| `busy` | `true` | the process is busy or didn't answer in time: the entry has **no `h`**, and only `hwnd`, `pid`, `processName`, `hostedPid`, `owner`, `name` (the Win32 title, `GetWindowTextW`, which sends no message), `className`, `bounds` (`GetWindowRect`), `isTopmost`, `focused` and `z` |

### `snapshot`

Params:

| param | default | meaning |
|---|---|---|
| `handle` / `hwnd` / `pid` + `name` | - | the window: a handle (any element: its subtree is read), a window handle, or the process's visible top-level window whose UIA `Name` (or, failing that, Win32 title) equals `name` exactly |
| `maxDepth` | 64 | deepest level read (the root is 0) |
| `maxNodes` | 400 | most nodes listed |
| `maxChildren` | 200 | most children listed under one element |
| `values` | `true` | read `patterns.value.value` (one extra call per element with a value) |
| `legacy` | `false` | read `patterns.legacy` (three extra calls per element) |
| `deadlineMs` | 800 | |

Result: `{"nodes": RawNode[], "truncated": boolean, "cut": string[], "busy": boolean}`.

- `nodes` is the control view of the subtree in pre-order. `nodes[0]` is the root with `parent: -1, depth: 0`; every
  other node's `parent` is its parent's index. Children are fetched one level at a time with a cache request that
  prefetches every RawNode property (`FindAll(TreeScope.Children)` with scope `Element | Children`, so one call brings
  two levels).
- An element that is offscreen **and** has no area (empty or zero-size bounds) is left out together with everything
  under it. Every other element is listed with its `isOffscreen` and `bounds`, so the host decides what counts as
  shown.
- Under one element with more than `maxChildren` children, the on-screen ones are kept first (in order) up to
  `maxChildren`; that node gets `childCount` and `childrenCut`, and `cut` gets `"nodes"`.
- `cut` lists, in this order, `"nodes"` (`maxNodes` reached or children left out), `"depth"` (something lies below
  `maxDepth`) and `"time"` (the walk stopped at its deadline). `truncated` is true when `cut` isn't empty.
- `busy: true` when an app call didn't return by the deadline: the answer then holds the nodes read so far, `cut`
  includes `"time"`, and the process is marked busy until the call returns.
- Errors: `gone` (the window or element doesn't exist, or no window of `pid` is named `name`), `busy` (the process is
  marked busy, or the window itself didn't answer in time), `bad_request`.

### `element`

Params: `{handle, values?: true, legacy?: true, deadlineMs?}`. Result: a fresh RawNode of that element (read again, not
from any cache), without `parent` and `depth`. The handle stays the same. Errors: `gone`, `busy`.

### `elementsAt`

Params: `{x, y, values?: true, legacy?: false, deadlineMs?}` in physical pixels. Result: `RawNode[]`, the chain from the
top-level window down to the deepest control element at that point (`AutomationElement.FromPoint`, normalised to the
control view, then its parents up to the child of the desktop, reversed). Node `i` has `parent: i - 1` and
`depth: i`. An empty array when the point is on the desktop itself. Errors: `busy`, `gone`.

### `focused`

Params: `{values?: true, legacy?: false, deadlineMs?}`. Result: `{"element": RawNode | null, "window": number | null,
"hwnd": number | null}`: the element with the keyboard focus (`AutomationElement.FocusedElement`), the handle of its
top-level window (the ancestor whose parent is the desktop) and that window's `hwnd`. `element` is null when nothing
has the focus (the desktop root). Errors: `busy`.

### `children`

Params: `{handle, max?: 200, values?: true, legacy?: false, deadlineMs?}`. Result: `RawNode[]`, the element's children in
the control view, at most `max` (1-10000), without `parent` and `depth`. For list and combo box options without
expanding anything. Errors: `gone`, `busy`.

### `perform`

Params: `{handle, op, value?, deadlineMs?}`. Result: `{"ok": true}` once the call returned.

| op | call | notes |
|---|---|---|
| `invoke` | `InvokePattern.Invoke()` | may wait for a modal dialog the click opened: expect `busy` "(it may still do it)" |
| `toggle` | `TogglePattern.Toggle()` | |
| `select` | `SelectionItemPattern.Select()` | |
| `addToSelection` | `SelectionItemPattern.AddToSelection()` | |
| `removeFromSelection` | `SelectionItemPattern.RemoveFromSelection()` | |
| `expand` | `ExpandCollapsePattern.Expand()` | |
| `collapse` | `ExpandCollapsePattern.Collapse()` | |
| `setValue` | `ValuePattern.SetValue(value)` | `value` is a string. **`denied` when the element is a password field** (or that can't be checked) |
| `setRange` | `RangeValuePattern.SetValue(value)` | `value` is a finite number |
| `focus` | `AutomationElement.SetFocus()` | brings the window to the front: the host decides when that is allowed |
| `scrollIntoView` | `ScrollItemPattern.ScrollIntoView()` | |
| `legacyDefaultAction` | `LegacyIAccessiblePattern.DoDefaultAction()` | the MSAA default action |

Errors: `failed` `unsupported:<op>` (no such pattern), `failed` `<ExceptionType>: <message>`, `denied`, `gone`, `busy`,
`bad_request` (unknown `op`, missing `value`).

### `textInfo`

Params: `{handle, maxChars?: 2000, deadlineMs?}` (`maxChars` 1-100000). Result, from `TextPattern` when the element
has it, otherwise from `ValuePattern`:

| field | meaning |
|---|---|
| `source` | `"text"` or `"value"` |
| `text` | the document's text (`DocumentRange.GetText`) or the value, at most `maxChars` characters |
| `truncated` | `true` when there was more |
| `selection` | the selected text (all selected ranges, joined), at most `maxChars` (TextPattern only) |
| `caret` | offset of the selection's start in `text`, when the selection is a single range that starts within the first `maxChars` characters (TextPattern only) |
| `selectionLength` | length of that single selection, 0 for a bare caret |
| `caretAtEnd` | `true` when the selection ends at the end of the document |

`{"secret": true}` and nothing else for a password field (`IsPassword`, an `Edit` with the protected state, or
`IsPassword` unreadable). `{}` when the element has neither pattern. Errors: `gone`, `busy`.
