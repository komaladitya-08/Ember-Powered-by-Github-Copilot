# Package S0b: the shared hooks (Step 0b)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md`, then
`specs/sshwsl/design.md`: header, "Limitations and departures", §11.1 and §11.3 (your full list), §2.6 (TaskManager
without a window system), §3.9.1 (Confirmer panels, the card's integrity), §3.10 (own-window masking, window options),
§4.3-§4.5 (`mayStart`, `noRevive`, `ownsId`, the privacy union, `wrapWindowsForWsl`, the `targetRules` seam), §5.5
(the perception text functions), §11.2 (what S0a already landed). Then "Critique resolutions" rows naming S0b
(integration-1, -3, -4, -17, -20, -21, -24; wsl-2, wsl-20).

## Goal
Make every behavioural hook in the shared runtime files, so the parallel packages only replace S0a's stubs. With S0a's
stubs in place, every hook is a no-op: Linux, Windows and macOS behave exactly as today, except one deliberate privacy
improvement (Ember's own windows are masked in screen-wide captures).

## Start and merge
Starts when S0a has merged, in parallel with MX, CL, RUN, UI, WA, SA, SB, DOC. Merges second. AG, TG, WB and SC finish
on top of you.

## Files you edit (shared; minimal)
- `app/main/agent/confirm.ts`: §3.9.1 entirely: `AnswerVia`, `QuestionPanel` (it imports `CommandCard` from
  `commands/types` and `ConsentPanel` from `shared/consent`), `Question.where/armMs/panel/clickOnly`,
  `answer(actionId, via = "bubble", proof?)`, `answerKey` → `"key"`, `ConfirmerTiming.panelReady`, the panel guards (the
  primary option only from the panel with the right sha256, or the key while `panelReady(n)` and not `clickOnly`;
  "deny" from anywhere; no wiring → never allowed), the panel bubble (`ui:panel:<n>` "Show the command" / "Read it",
  `q<n>:deny` "Not now"), `q.armMs ?? armMs`.
- `app/main/perception/index.ts`: export the four pure text functions (`perceivedText`, `describeText`,
  `quickContextText`, `openWindowsBlock`) and use them in the class (byte-identical output); in `perceive`, add the
  frames of every stacked window whose `pid === ownPid` (except the overlay's, already hidden) to the masks in both
  scopes (integration-4).
- `app/main/perception/sidecar.ts`: `SidecarLaunch.mayStart?: () => boolean` (checked in `ensure()`, which then throws
  "accessibility helper not running" without spawning, and before a revive), `SidecarLaunch.noRevive?: boolean`, and
  `AtspiSidecar.ownsId(id: number): boolean` (true for any id block this instance has used, across restarts).
- `app/main/policy/policy.ts`: `EMBER_WINDOW` gains `ember commands` (+ its test); the seam
  `const extra = targetRules(r, os); if (extra) return extra;` at the top of decideBase's never-rules (importing the S0a
  stub `policy/target-rules.ts`); `export { runsIn }`. Nothing else.
- `app/main/agent/host.ts`: create the TaskManager when `hands || targets`, from `taskBase` when `hands` is absent,
  `currentWindow: hands?.currentWindow ?? (() => null)` (§2.6). Nothing else (AG owns the rest of host.ts's changes).
- `app/main/windows.ts`: `createCommandWindow(os: OS)` and `createPromptWindow(os: OS)` exactly as §11.3 says (macOS
  panel + `acceptFirstMouse`, content protection on Windows and macOS, sandbox, contextIsolation, the preloads and pages
  S0a created).
- `app/main/main.ts`: hooks 1-12 of §11.3, exactly; hook 2 builds the privacy union on `isTerminalWindowApp` (keep the
  macOS bundle-id check), creates `wsSeen = ws && wrapWindowsForWsl(ws, …)` and passes it to Perception (`x11`), the
  hands' window lists, `currentWindow` and `activeWindow`; hook 3 runs whether or not `hands` exist and fills every
  `TargetsDeps` field (`isHome` from the existing settings guard; `elevated` from `sys.environment(...)`'s
  `windows.elevated` on Windows, `process.getuid?.() === 0` elsewhere; `emberPids` from `app.getAppMetrics()` plus the
  sidecar's, voice's and the desk's pids; `extraPath` from the darwin system's `extraBinDirs` filtered to existing
  folders; `jobHost` on Windows: `{ execPath: process.execPath, script: path.join(appDir, "job-host.cjs") }`); hook 7
  lets `ui:cmdstop:` ids through the "while driving" filter.
- New tests: `test/unit/{sshwsl-hooks,perception-own-windows,host-taskbase,main-privacy-wiring}.test.ts`.

You touch no other file. I-win and I-mac may be editing `main.ts` too: keep your hunks small and separate, and list each
in the report.

## Contracts you implement or consume (normative TypeScript from the design)

```ts
await confirmer.ask({
  title: "May I run a command?", context: taskGoalShort, prompt: `On ${label}: ${firstLine(d.says)}`,
  options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }],
  task: taskId, where: whereWords, armMs: d.armMs,
  panel: { kind: "command", card },
}, signal);
```

```ts
/** How an answer arrived: a bubble button, Ember's approve/deny keys, or the panel window's own buttons. */
export type AnswerVia = "bubble" | "key" | "panel";

/** A question whose full content shows in a window of Ember's own (the command card, a consent card). */
export type QuestionPanel =
  | { kind: "command"; card: CommandCard }
  | { kind: "consent"; consent: ConsentPanel };

/** A first-use consent card (§8.4): its exact text, and a hash of it that the yes must carry back. Lives in
 * app/shared/consent.ts (renderer-safe); confirm.ts imports it. */
export interface ConsentPanel {
  feature: "commands" | "wsl" | "ssh";
  target: TargetId;
  targetLabel: string;
  title: string;
  body: string[];
  yes: string;
  no: string;
  /** sha256Hex of title + "\n" + body.join("\n"). */
  sha256: string;
}

// Question gains:
  /** Where the asking task acts ("on build-01"): a badge in the bubble and the panel. */
  where?: string;
  /** How long clicks are ignored after it shows (default ConfirmerTiming.armMs). */
  armMs?: number;
  /** Its full content shows in a panel window; only that window's buttons (or the keys while it is fully shown) allow it. */
  panel?: QuestionPanel;
  /** The keys can't allow it (consent cards: a click only). */
  clickOnly?: boolean;
```

```ts
/** UIA's sidecar, or one that also reads WSLg windows through each distro's sidecar. */
export function wrapForWsl(base: AtspiSidecar, o: WrapForWslOptions): PerceptionSidecar & SidecarPort;

/**
 * The Windows window system, with the program name (`wmClass`) of every RAIL window the router identified rewritten to
 * "wsl:<distro>:<app>" (critique wsl-2). Main passes the result as Perception's `x11`, to the hands' window lists and to
 * `currentWindow`/`activeWindow`. Unidentified RAIL windows keep "msrdc", so the existing `isRemoteSurface` check keeps
 * masking and refusing exactly those. A Proxy like `platform/compose.ts`'s system-dialog wrapper: every other member is
 * the backend's own (I-win's extras survive).
 */
export function wrapWindowsForWsl(ws: WindowSystem, o: WrapForWslOptions): WindowSystem;

export interface WrapForWslOptions {
  os: OS;
  log: Logger;
  /** The Windows window system (its stack: HWND, pid, title, bounds, owner). */
  ws: () => PerceptionWindows | null;
  wsl: () => WslService | null;
  settings: SettingsStore;
}
```

```ts
/** The PC's privacy and terminal checks, extended so a `wsl:<distro>:<app>` window is also judged as a Linux app. */
export function wslAwarePrivacy(p: { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean }):
  { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean };
```

```ts
export interface TargetsDeps {
  log: Logger;
  os: OS;
  sys: SystemPlatform;
  userData: string;
  /** dist/app (askpass.cjs, remote-link.cjs, job-host.cjs). */
  appDir: string;
  resourcesPath: string;
  execPath: string;
  packaged: boolean;
  settings: SettingsStore;
  /** The PC's policy with its source (R5). */
  admin: () => LoadedAdminPolicy;
  audit: () => AuditLog | null;
  confirmer: () => Confirmer | null;
  /** This screen's hands (null without a window system: then local is commands-only, §2.6). */
  localHands: Hands | null;
  showState: (patch: Partial<EmberState>) => void;
  notify: (title: string, body: string) => void;
  openSettings: (section?: "computers" | "commands") => void;
  ipc: IpcLike;
  /** The settings (home) window's page: the only sender TARGETS_IPC accepts (critique integration-5). */
  isHome: (sender: WebContentsLike) => boolean;
  windows: { command: () => BrowserWindowLike; prompt: () => BrowserWindowLike };
  /** Electron's net.fetch (system proxy), for the Node runtime downloads. */
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
  /** main's devEnv: unpackaged-only switches (EMBER_TEST_ALLOW_LOOPBACK_SSH). */
  devEnv: (name: string) => string | undefined;
  /** Ember runs elevated (Windows: the platform's TokenElevation, `win32/system/environment.ts`; POSIX: uid 0). */
  elevated: () => boolean;
  /** Ember's own pids now: app.getAppMetrics() plus the sidecar's, voice's and the desk's (D4.5, live). */
  emberPids: () => number[];
  /** Folders to add to commands' PATH on this PC (macOS: extraBinDirs that exist; else []). */
  extraPath: () => string[];
  /** Ember's job host (Windows; null elsewhere). */
  jobHost: JobHostRef | null;
}

/** The parts of ipcMain the runtime uses; every handler checks the sender itself. */
export interface IpcLike {
  on(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => void): void;
  handle(channel: string, fn: (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown): void;
}
export interface WebContentsLike { readonly id: number; send(channel: string, ...args: unknown[]): void }
export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  show(): void; showInactive(): void; hide(): void; focus(): void; close(): void; moveTop(): void;
  isVisible(): boolean; isMinimized(): boolean; isDestroyed(): boolean; isAlwaysOnTop(): boolean; isFocused(): boolean;
  setAlwaysOnTop(flag: boolean, level?: "normal" | "floating" | "torn-off-menu" | "modal-panel" | "main-menu" | "status" | "pop-up-menu" | "screen-saver"): void;
  setBounds(b: { x?: number; y?: number; width?: number; height?: number }): void;
  setContentProtection(enable: boolean): void;
  on(event: "closed" | "focus" | "blur" | "show" | "hide", fn: () => void): void;
}
```

The S0a stubs you wire (their signatures are final): `createTargets(deps: TargetsDeps): TargetsRuntime`,
`targetDoctorRows(o: { os: OS; sys: SystemPlatform; admin: () => LoadedAdminPolicy; resourcesPath: string; packaged:
boolean }): Promise<PlatformDoctorRow[]>`, `wrapForWsl`, `wrapWindowsForWsl`, `wslAwarePrivacy`,
`wslAwareSystem(sys: SystemPlatform): SystemPlatform`, `targetRules(r: ActionRequest, os: OS): Decision | null`.

## Tests (OS-neutral, Linux)
- `sshwsl-hooks.test.ts`: the Confirmer panel guards (bubble can't allow a panel question; the panel needs the right
  sha256; the chord needs `panelReady`; deny from anywhere; `clickOnly`; no wiring → never allowed); `mayStart` blocks
  start; `noRevive` blocks revive; `ownsId` across a restart; `targetRules` stub → `decideBase` unchanged; the exported
  text functions give byte-identical text to today's `perceive`/`describe`/`quickContext` on the existing fixtures.
- `perception-own-windows.test.ts`: a stack holding an "Ember commands" window (Ember's pid) over the screen is masked
  in screen scope and window scope; the overlay is still hidden, not masked.
- `host-taskbase.test.ts`: an AgentHost with `targets` and no `hands` starts a task through the TaskManager.
- `main-privacy-wiring.test.ts`: on darwin, a catalogue app whose keyword is "Terminal" under another display name is
  still refused through main's wiring (the fakes of `darwin-terminal-window-app.test.ts`), via `wslAwarePrivacy`'s stub.

## Acceptance criteria
- `npx tsc --noEmit`, `npm run lint`, `npm test` pass on Linux; the `unit-matrix` job green if you may push.
- With S0a's stubs, Ember behaves exactly as before on every OS (only the own-window masking differs), and every hook
  is reachable for the packages that replace the stubs.
- The report lists every `main.ts` hunk with its hook number.
