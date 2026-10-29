# Package uia: the Windows UI Automation bridge (C# 5 hosted by Windows PowerShell 5.1)

Worktree: /home/user/wt/uia (branch port/uia). Integration env var: EMBER_UIA_TEST.
Specs to read: decisions.md D3 (binding), sidecar-protocol-read.md and sidecar-protocol-act.md (what the TypeScript host
built on top of you must produce — you supply the raw facts it needs), sidecar-consumers.md, gaps.md (G1, G2, PowerShell
items), build-test-ci.md (Windows encoding, Add-Type cold start).

## Architecture (decided)
Ember's Windows accessibility = a TypeScript "sidecar host" (written later by another package; it speaks Ember's existing
JSON-RPC protocol to Ember and does all protocol logic: ids, secrets, labels, role vocabulary, verification) + YOUR thin
bridge that exposes raw UI Automation facts and actions. Keep the bridge dumb and fast: no Ember policy, no role mapping
(raw ControlType names), no secret-word lists. Its single safety job: never read a password field's value or text
(IsPassword), and never put screen text through PowerShell cmdlets.

## You own (and touch nothing else)
- sidecar/uia/ember_uia.ps1 — the tiny bootstrap
- sidecar/uia/ember_uia.cs — the bridge (C# 5, .NET Framework 4.x, System.Windows.Automation)
- sidecar/uia/PROTOCOL.md — the bridge wire protocol (the host package will implement against it; make it complete)
- test/unit/uia-files.test.ts — Linux-runnable checks: both files are pure ASCII; the .ps1 contains no screen-data
  handling (only the bootstrap); the documented methods in PROTOCOL.md match the dispatch table in the .cs
- test/integration/uia-bridge.test.ts — Windows-only (skip elsewhere; fail when EMBER_UIA_TEST=1 and anything is missing)
  with a minimal Node client written inside the test (or test/integration/uia-client.ts if you prefer, owned by you)

## Requirements
1. Launch: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive
   -ExecutionPolicy Bypass -File <dir>\ember_uia.ps1`, spawned with windowsHide and a sanitised env (no PSModulePath).
   The .ps1: Set-StrictMode; compute SHA-256 of ember_uia.cs; if `$env:EMBER_UIA_CACHE` is set, load
   `<cache>\ember_uia-<hash>.dll` if present, else `Add-Type -Path ember_uia.cs -ReferencedAssemblies UIAutomationClient,
   UIAutomationTypes,WindowsBase,System.Web.Extensions(if used) -OutputAssembly <tmp> ` then atomically rename into the
   cache (fall back to an in-memory Add-Type if the cache can't be written); then call `[Ember.Uia.Bridge]::Run()` and
   `exit` with its code. Nothing else. Errors before Run() are written as ONE JSON line `{"fatal":"<message>"}` to stdout
   and exit 1.
2. The C#: C# 5 only (Windows PowerShell 5.1 Add-Type compiles with the .NET Framework C# 5 compiler: no `$""`, `?.`,
   `nameof`, expression-bodied members, auto-property initialisers, `out var`, tuples, pattern matching, local functions).
   ASCII-only source (non-ASCII literals as \uXXXX). Stdio: read stdin as UTF-8 lines and write UTF-8 without BOM on a raw
   stdout stream (set Console encodings or wrap the streams), flush per line. First line after start:
   `{"ready":true,"version":1,"dpi":"<per-monitor-v2|per-monitor|system|unaware>"}`. Call
   SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) before any UIA use; if it fails, set it per
   worker thread with SetThreadDpiAwarenessContext; report what you got.
3. Requests `{"id":N,"method":"…","params":{…}}`, answers `{"id":N,"result":…}` or `{"id":N,"error":{"code":"busy|gone|
   denied|bad_request|failed","message":"…"}}`. Exit 0 on stdin EOF (Environment.Exit, even if a worker is stuck).
4. Concurrency and deadlines: a reader thread dispatches each request to an MTA worker thread; every request has a
   deadline (params.deadlineMs, default 800, max 4000). On expiry answer `busy` at once and remember the target process as
   busy until that worker returns; while busy, requests that touch that process answer `busy` immediately (other
   processes keep working). Never let one hung app block the others. Answers may come out of order (ids match them).
5. Element handles: integers from a handle table (AutomationElement), freed by `release {handles}` and capped (LRU, e.g.
   20 000) — an evicted or dead element answers `gone`. Also expose each element's RuntimeId (int[] joined with ".") and
   process id, which the host uses as a stable key for secret fields across bridge restarts.
6. Methods (document each fully in PROTOCOL.md with params/results):
   - ping → {version}
   - topWindows {} → top-level windows (children of RootElement, ControlView): handle, hwnd (NativeWindowHandle), pid,
     processName (program name without ".exe"; for ApplicationFrameHost the hosted app's program), name, className,
     controlType, frameworkId, bounds, isOffscreen, isModal + windowState (WindowPattern), isTopmost if cheap, focused (holds
     the focus).
   - snapshot {handle | hwnd | pid+name, maxDepth (default 64), maxNodes (default 400), deadlineMs} → {nodes: RawNode[]
     pre-order with parent index and depth, truncated, cut: ["nodes"|"depth"|"time"], busy}. Walk the ControlView with a
     CacheRequest (TreeScope.Element|Children batches or Subtree with a cap) prefetching every property below, so a 400-node
     window is fast. Skip (with their subtrees) elements that are offscreen AND have empty bounds; report IsOffscreen
     otherwise (the host decides).
   - element {handle} → RawNode, fresh (no cache).
   - elementsAt {x, y} (physical pixels) → chain RawNode[] from the top-level window down to the deepest element at that
     point (AutomationElement.FromPoint, then walk parents up to the window, reversed).
   - focused {} → {element: RawNode|null, window: handle of its top-level window|null}
   - children {handle, max} → RawNode[] (for list/combo options without expanding)
   - perform {handle, op, value?, deadlineMs} with op ∈ invoke | toggle | select | addToSelection | removeFromSelection |
     expand | collapse | setValue (ValuePattern; refuse with `denied` when IsPassword) | setRange (RangeValuePattern) |
     focus (SetFocus — the host decides when it is allowed) | scrollIntoView (ScrollItemPattern) | legacyDefaultAction
     (LegacyIAccessiblePattern.DoDefaultAction) | showMenu? (skip) → {ok:true} or an error (`failed` with the exception's
     message type, `denied`, `gone`, `busy`). A pattern the element doesn't support → `failed` with message
     "unsupported:<op>".
   - textInfo {handle, maxChars (default 2000)} → {text?, selection?, caretAtEnd?} via TextPattern (DocumentRange text,
     GetSelection) or ValuePattern; never for IsPassword elements (answer {secret:true}).
   - release {handles: number[]} → {}
   - status {} → {version, dpi, handles, busyPids}
7. RawNode fields (all optional except h): h (handle), parent (index in the same answer, -1 for the root), depth,
   controlType (ControlType.ProgrammaticName without the "ControlType." prefix), localizedControlType, name, automationId,
   className, frameworkId, isPassword, isEnabled, isOffscreen, hasKeyboardFocus, isKeyboardFocusable, isControlElement,
   bounds {x,y,width,height} (null when empty/infinite), pid, hwnd, runtimeId, labeledBy (the LabeledBy element's name),
   helpText, itemStatus, acceleratorKey, accessKey, patterns: { invoke?: true, toggle?: "On"|"Off"|"Indeterminate",
   value?: {value?: string (omitted when isPassword; truncated to 2000 chars), readOnly}, range?: {value, min, max, readOnly,
   smallChange}, expand?: "Collapsed"|"Expanded"|"PartiallyExpanded"|"LeafNode", selectionItem?: {selected},
   selection?: {multiple, required}, window?: {modal, state}, grid?: {rows, columns}, gridItem?: {row, column},
   table?: true, text?: true, scrollItem?: true, legacy?: {role: number, state: number, defaultAction: string} }.
   Reading a property that throws ElementNotAvailable marks the node gone; other per-property exceptions just omit it.
8. Unit test on Linux (test/unit/uia-files.test.ts) as above. Compile-check the .cs locally with the lead's harness:
   `cd /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/cscheck &&
   ../dotnet/dotnet build -p:SrcFile=/home/user/wt/uia/sidecar/uia/ember_uia.cs -v q` (net48 reference assemblies,
   LangVersion 5; it references UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions). It must build
   with 0 errors. Run it after every significant edit. (Do not modify the harness project; copy it to your own temp
   folder if you need different references.)
9. Integration test (Windows only): spawn the bridge exactly as in (1) with EMBER_UIA_CACHE pointing at a temp folder; wait
   for ready (allow 30 s for the first compile, then check a second start is fast thanks to the cache); start the shared
   bench window `test/fixtures/win_bench.ps1 -Log <tmp>` (another package writes it; its spec: WinForms window titled
   "Ember Bench (Windows)" with TextBox "Name", password TextBox "Password", CheckBox "Remember me", ComboBox "Theme"
   (Light/Dark/System), TrackBar "Volume", ListBox "Fruit", Button "Save", Button "Open dialog" (modal MessageBox "Saved?"),
   JSON-lines log incl. {"event":"ready","hwnd":N,"pid":N}; if the file isn't in your worktree, still write the test against
   this spec); topWindows finds it; snapshot lists the controls with the right controlTypes, the password edit has
   isPassword and NO value; perform invoke on Save → log click; toggle Remember me → log toggle; setValue on Name → log
   text length; select "Dark" in Theme (expand + select item, or SelectionItem on the item) → log select; setRange Volume;
   elementsAt the Save button's centre ends at the Save button; focused works; invoke "Open dialog" returns within the
   deadline (busy or ok — never hangs), the modal dialog appears in topWindows, close it with invoke on OK; EOF on stdin
   makes the bridge exit within 2 s.
