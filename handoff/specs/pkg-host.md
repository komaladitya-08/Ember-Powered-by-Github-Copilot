# Package host: the shared TypeScript accessibility sidecar host (Windows + macOS) and its Windows bridge client

Worktree: /home/user/wt/host (branch port/host). Integration env var: EMBER_UIA_TEST (Windows end-to-end through the host).
Specs to read (all of them carefully — you are re-implementing a protocol): sidecar-protocol-read.md, sidecar-protocol-act.md,
sidecar-consumers.md, decisions.md D3 and D11, and the brief of the UIA bridge package /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/pkg-uia.md (§6–7 define the
bridge's wire protocol and RawNode; that package is writing sidecar/uia/PROTOCOL.md in parallel — code against pkg-uia.md and
keep your bridge client isolated in one module so it is easy to adjust).
Also read the code: app/main/perception/sidecar.ts (the client: framing, timeouts, revive, remember_secrets, id blocks,
scaling), app/main/perception/elements.ts (secret word lists, isSecretLabel, labels, withheld — REUSE these; do not copy
word lists), sidecar/atspi/ember_atspi.py (the reference implementation: read it for exact semantics and error texts) and
sidecar/atspi/test_ember_atspi.py (the behaviours its tests pin down — port the platform-neutral ones to your tests).

## What you build
On Windows and macOS Ember will start `dist/app/ax-sidecar.cjs` with Ember's own binary in node mode
(ELECTRON_RUN_AS_NODE=1). It must speak EXACTLY the existing newline-delimited JSON-RPC protocol of the Python sidecar
(same methods: ping, status, list_windows, read_window, remember_secrets, mark_secret, shell_overlays, secret_fields,
read_element, at_point, can_do, do_action, set_text, set_value, select_option, list_options, focus; same params, result
shapes, AT-SPI role and state vocabulary, error wording incl. "background_unavailable: …", the BUSY text, "element N is no
longer known; read the window again", "check box in a list", id blocks from EMBER_ATSPI_ID_BASE, 8 kept reads + scratch,
keep:false, secretKeys/withheldKeys, truncated/cut/slow/busy, others, path), so app/main/perception/sidecar.ts and every
consumer work unchanged. All protocol logic lives in the host; platform facts come from a provider.

## You own (and touch nothing else)
- app/sidecar-host/** — e.g. main.ts (entry: stdio JSON-RPC loop, one request at a time like the Python sidecar, never
  crashes on a bad line), protocol.ts (method table + param validation), ids.ts (id blocks, kept reads, scratch), tree.ts
  (budgets, truncation, pre-order, parent = nearest listed ancestor, dropping hidden subtrees), secrets.ts (secret fields,
  withholding, remember/mark, stable keys) reusing app/main/perception/elements.ts, labels.ts (unnamed controls borrow the
  label to their left, as the Python sidecar does), roles.ts (UIA ControlType → AT-SPI role and macOS AXRole/AXSubrole →
  AT-SPI role tables, states mapping; must emit "enabled"/"sensitive" for enabled elements, "terminal" for console text,
  "password text" for password fields, "document web" for web documents, "push button" not "button", "entry" not "search"),
  actions.ts (can_do/do_action/set_text/set_value/select_option/list_options with verification re-reads and result shaping),
  provider.ts (the AxProvider interface below), providers/uia.ts (Windows: spawns and talks to the C# bridge —
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File <resources>/sidecar/uia/ember_uia.ps1`, windowsHide, env without PSModulePath, EMBER_UIA_CACHE from the host's env,
  waits for the ready line (generous first-start timeout), request ids, per-request deadlines, kills the bridge on exit and
  exits itself when stdin closes), providers/fake.ts (an in-memory provider for tests).
  The macOS AX provider is a LATER package (it needs the darwin bindings being written in parallel); design the provider
  interface so it fits macOS too (AX is attribute-pull, synchronous, with its own timeouts) and leave a clear seam
  (providers/index.ts choosing by process.platform; darwin returns an "unsupported" provider for now).
- scripts/build-app.mjs — ONLY add the esbuild entry for app/sidecar-host/main.ts → dist/app/ax-sidecar.cjs (node, cjs,
  same target/externals as desk-agent: koffi external, electron never imported). Keep the font-copy text that a test reads.
- app/main/perception/sidecar.ts — ONLY generalise the launch: AtspiSidecar accepts an optional `launch` describing
  `{ command, args, env, firstRequestMs?, windowsHide? }` (default stays `python + [script]` exactly as today), and gives the
  FIRST request of a new process `firstRequestMs` (default: the current 5 s) so a cold bridge start isn't killed in a loop.
  Keep every current behaviour on Linux (env vars, revive, remember_secrets, timeouts). Pass windowsHide to spawn.
- test/unit/sidecar-host-*.test.ts (new), test/unit/sidecar-launch.test.ts (new). Do NOT edit existing test files.
- test/integration/ax-sidecar.test.ts — end-to-end on Windows (skip elsewhere; fail when EMBER_UIA_TEST=1 and missing):
  build output or run the host from source with the repo's esbuild, drive it through the REAL AtspiSidecar client against
  the WinForms bench (test/fixtures/win_bench.ps1 per pkg-uia.md's spec; written by another package): list_windows finds
  "Ember Bench (Windows)"; read_window returns the controls with AT-SPI roles (text, password text, check box, combo box,
  slider, list, push button), the password field is `secret` with no text; set_text on Name works and the bench logs it;
  do_action click on Save logs a click; toggle Remember me; select_option Theme "Dark"; set_value Volume; at_point on Save;
  can_do answers; secret_fields lists the password field; a modal dialog doesn't hang the host. On macOS the same file must
  skip with a clear reason until the AX provider exists (don't fail).

## The AxProvider interface (you finalise it; keep it coarse — few round trips)
```ts
interface RawWindow { handle: Handle; key: string; pid: number; app: string; title: string; role: string /* platform */; bounds: Rect | null; modal?: boolean; active?: boolean; offscreen?: boolean; native?: number /* HWND / CGWindowID */ }
interface RawNode { handle: Handle; key: string /* stable across provider restarts, e.g. "<pid>:<runtimeId>" */; parent: number /* index, -1 root */; depth: number;
  platformRole: string; platformSubrole?: string; name: string; labelledBy?: string; help?: string; bounds: Rect | null;
  enabled?: boolean; focused?: boolean; focusable?: boolean; offscreen?: boolean; password?: boolean; readOnly?: boolean;
  toggle?: "on" | "off" | "mixed"; expanded?: boolean | null; selected?: boolean; multiLine?: boolean; modal?: boolean;
  value?: string; range?: { value: number; min: number; max: number; step?: number }; actions?: string[] /* invoke, toggle, select, expand, collapse, setValue, setRange, focus, legacy */;
  textSelection?: string; grid?: { rows: number; columns: number }; cell?: { row: number; column: number }; native?: number }
interface AxProvider {
  readonly kind: "uia" | "ax" | "fake";
  start(): Promise<void>;
  topWindows(): Promise<RawWindow[]>;
  snapshot(window: Handle, o: { maxDepth: number; maxNodes: number; deadlineMs: number }): Promise<{ nodes: RawNode[]; truncated: boolean; cut: string[]; busy?: boolean }>;
  element(h: Handle): Promise<RawNode | null>;
  elementsAt(x: number, y: number): Promise<RawNode[]>;
  focused(): Promise<{ element: RawNode | null; window: Handle | null }>;
  children(h: Handle, max: number): Promise<RawNode[]>;
  perform(h: Handle, op: string, value?: unknown): Promise<void>;   // throws ProviderError { code: "busy"|"gone"|"denied"|"failed"|"unsupported" }
  textInfo(h: Handle, maxChars: number): Promise<{ text?: string; selection?: string; secret?: boolean }>;
  release(hs: Handle[]): void;
  stop(): void;
}
```

## Requirements beyond the protocol
- Units: Windows coordinates are physical pixels (the bridge is per-monitor DPI aware); the host never scales (the TS side
  does, per protocol). macOS will report points.
- Tier-1 rules from the protocol specs: never steal focus or raise windows for an action that must stay in the background;
  rows/items in a background window → plain error (not background_unavailable); Invoke on list items/Explorer items would
  OPEN them — use select semantics as the Python sidecar does for GTK rows; secret fields: refuse set_text/set_value/
  select_option/list_options and never return their text; do_action on a secret field follows the Python behaviour.
- Busy semantics: a provider `busy` maps to the exact BUSY wording; hung apps must not block other windows.
- shell_overlays on Windows: report credential/UAC prompts and other system dialogs that sit over the desktop
  (`{overlays:[{role:"dialog",…}], complete:true}`), at least CredentialUIBroker / consent windows when visible; macOS later.
- Tests on Linux with providers/fake.ts: a protocol-conformance suite covering every method's success and error shapes,
  id lifecycle (blocks, 8 kept + scratch, keep:false, "no longer known"), truncation, hidden-subtree dropping, secret
  detection by role and by label words (use test/fixtures/secret-labels.json like the other suites), withholding, label
  inference, verification after toggle/text, the role/state tables for UIA and AX, the error strings the TS consumer matches
  (busy regex /\bbusy\b|did not (receive a reply|answer)|timeout was reached/, "background_unavailable", "check box in a list").
  Also an end-to-end Linux test that spawns the built host (or `node` running the esbuild bundle) through the REAL
  AtspiSidecar with an env switch selecting the fake provider (EMBER_AX_PROVIDER=fake, honoured only when not packaged /
  only in tests — document it), to prove framing, id base and remember_secrets work through the real client.
