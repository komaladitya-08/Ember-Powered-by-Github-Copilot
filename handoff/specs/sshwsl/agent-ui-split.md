# Agent / UI split: where Ember's UI side ends and its agent side begins

Branch read: `ember-improve/20261022-windows-macos`. All `file:line` references are to that tree.
Goal: let an agent (brain, eyes, hands) run on another machine (SSH remote; WSL as the same-machine case) while
everything the user touches stays on the local PC: character, bubble, overlay, handle, ask box, settings window,
microphone, wake word, speech recognition, TTS, confirmation clicks/keys, shortcuts, kill-switch keys.

This spec does not decide the open product choices; it inventories the seam, proposes an RPC boundary for the two
variants the owner asked about, and lists costs and risks.

---

## 0. Key findings (short)

1. **The seam already exists as a set of callbacks and ~17 AgentHost members.** Agent-side code does not import
   Electron: `grep 'from "electron"'` hits only `main.ts, overlay.ts, handle.ts, ask.ts, voice.ts, windows.ts,
   revive.ts, desk/view.ts`. `agent/`, `policy/`, `perception/`, `hands/`, `settings.ts`, `admin.ts` are plain Node.
   The UI ⇄ agent traffic is (a) `HostOptions` callbacks (host.ts:84-138: `setState, onStatus, describeScreen, hands,
   onAnswer, onTurnEnd, onTaskFinished, onTranscript, onAccountChanged, provider, admin, isOnline, reachable,
   resolveProxy, system`), (b) the `Hands` bundle main builds (host.ts:35-52, built main.ts:1334-1379), and (c) the
   members of `AgentHost` main calls (§2.6: `ask, stopEpoch, abortAll, claimBubble, releaseBubble, releasePin, getStatus,
   getTranscript, lastAnswer, tasks.{list,cancel,dismiss}, start, stop, forgetConversation, setModels, networkChanged,
   waitingForNetwork`).
2. **Three things are entangled across the seam today and need a protocol, not a pipe:** bubble ownership
   (`BubbleOwner`, presenter.ts:83-221, with main's own claims host.ts:480-524), the Confirmer (agent awaits
   `confirmer.ask`; UI shows it, answers it, holds keys; `waiting/settled` gate the agent's bubble writes,
   host.ts:431-432; `guardWhileAsking` gates main's writes, main.ts:394), and the kill switch (one `KillSwitch` with six
   parts that live on both sides, main.ts:731-740).
3. **Screen geometry does not cross machines.** `EmberState.focus` (flyTo, main.ts:1346), guide mode's pointer and
   Enter/Space watch (worker.ts:1311-1346), the borrow's "user takes over by moving the mouse" (borrow.ts:1-12,
   STEP_MS = 8 at borrow.ts:102), `hideOverlay` for captures (main.ts:1266-1271) and the quick context's target window
   (main.ts:681-689) all assume the user's own screen. On a remote screen the user cannot see, the right UX template is
   Ember's desk (tier 2: DeskPlace + DeskView mini-view with Take over), not tier 3.
4. **Variant R (remote brain) has a small seam; Variant L (local brain, remote hands) has a large one.** R remotes the
   callbacks above (~25 message kinds). L must remote Perception, the sidecar, the window system, input, the borrow,
   clipboard, app launch and settings change, and several are synchronous interfaces called from Electron's main thread
   (WindowSystem extends X11, platform/types.ts:65; CursorBorrow polls every 8 ms; the desk's facade blocks the thread
   with `Atomics.wait`, desk/agent.ts:139-176). Synchronous calls cannot go over a WAN; L requires moving the borrow and
   window checks to the remote and making the worker's hand path async per op (`Hand` is already async, borrow.ts:62-72).
5. **Approvals must be locally originated and the remote endpoint must not be reachable by other remote processes.**
   The only safe transport is the SSH channel's own stdio (the desk helper's IPC model, desk/agent.ts:42), never a TCP
   port or a world-reachable socket on a shared server.
6. **The desk helper is a good template** for a remote "hands and eyes" process (closed dispatch, capability handshake,
   liveness, death of the helper never hangs Ember, bulk images encoded in the helper), except its synchronous call path.

---

## 1. Today's process layout (one machine)

| Process | Started at | Talks to main via | Role |
|---|---|---|---|
| Electron main | — | — | Everything in main.ts: windows, shortcuts, voice service, AgentHost, Perception, hands, PolicyEngine, Confirmer, KillSwitch, AuditLog |
| Voice utility process | voice.ts:229 `utilityProcess.fork(voice.cjs)` | `postMessage` (process.ts:15-30) + MessagePort for audio from the mic window (voice.ts:253-265) | sherpa-onnx wake word / stop / VAD / ASR |
| Hidden mic window | voice.ts:256 | `VOICE.*` IPC (shared/voice.ts:3-9) | getUserMedia, `speechSynthesis` (renderer/mic/main.ts:62-72) |
| Hidden speaker window | voice.ts:213-219 | same | TTS while listening is off |
| Accessibility sidecar | sidecar.ts:263-269 (`spawn` python, or `SidecarLaunch` command) | newline JSON-RPC over stdio; 15 methods: `at_point can_do do_action list_options list_windows mark_secret read_element read_window secret_fields select_option set_text set_value shell_overlays status remember_secrets` | Tier 1 read/act |
| Desk helper | desk/agent.ts:42 (fork via a worker_thread relay, agent.ts:94) | Node IPC, sync relay with `Atomics.wait` | X calls on the desk display |
| Copilot runtime | host.ts:686-697 `RuntimeConnection.forStdio` | SDK JSON-RPC over stdio; tool handlers run back in main | model calls; holds the token |

Electron-only dependencies a non-Electron agent process would have to replace: `net.fetch` for `reachable`
(main.ts:1405), `session.resolveProxy` (main.ts:1407), `safeStorage` for `TokenStore` (main.ts:1236), `powerMonitor`
(main.ts:1416), `Notification` (main.ts:647-649), Electron `clipboard`/`ClipboardItem` (main.ts:1362), Electron `screen`
for the window system's DIP conversion (platform/linux/index.ts:25, platform/win32/platform.ts:49) and
`desktopCapturer` for macOS capture (platform/darwin/platform.ts:29,44).

---

## 2. Every crossing between UI side and agent side today

Notation: **UI** = local-only (windows, keys, mic, speech, focus juggling). **AG** = agent side (AgentHost, Conductor,
Worker, TaskManager, Presenter, PolicyEngine, Perception, sidecar, hands, audit). Direction `UI→AG` / `AG→UI`.

### 2.1 State out: `setState` / `showState` and `EmberState`

Types (shared/overlay.ts):
- `BubbleState` (45-58): `{visible, mood, title, thought, step, streaming, actions:{id,label,primary?}[], task?, expanded?}`
- `TaskCard` (60-67): `{id, title, status:"running"|"waiting"|"done"|"failed"|"stopped", detail, actions?}`
- `EmberState` (69-87): `{emotion, talking, bubble, tasks, status, focus?: Rect|null, gesture?, mic?, avoid?: Rect[], idle?}`

Two setters in main:
- `showState` (main.ts:385-391): merges into `lastState`, pushes to overlay (`overlay.setState`, overlay.ts:124-159) and
  handle (`handle.sendState`, handle.ts:85-90); hides tasks while the user drives the desk (main.ts:389).
- `setState = guardWhileAsking(() => confirmer?.waiting, showState)` (main.ts:394; confirm.ts:182-191): while a
  question is up, `bubble`, `emotion`, `talking` are dropped, other fields pass.

Who writes each field:

| Field | Writers | Side | Notes |
|---|---|---|---|
| `emotion/talking/bubble/gesture` | Conversation presenter (host.ts:433, `o.setState`), task presenters (host.ts:1080), Confirmer via **showState** (confirm.ts:150,165; wired main.ts:1277), main: greet (419-421), stopEverything (749), onVoice (803, 806, 813, 817, 828), showHome/readLastAnswer/expand/close (267, 577, 588, 592), hideIfStill (398), mic off (1459-1461) | AG + UI | the shared bubble |
| `tasks` | `TaskManager.publish → setCards` (tasks.ts:273-285 → host.ts:769) | AG | card buttons `task:<id>:stop|dismiss` (tasks.ts:280-282) |
| `focus` | `hands.flyTo` (main.ts:1346, `ws.toDip(b)`), worker `fly` (worker.ts:864), cleared at task end (worker.ts:1222) and by kill switch "motion" (main.ts:739) | AG writes, UI-space coords | **local DIP of the local screen** |
| `status` | `setStatus` (main.ts:775-779): owners `borrow` (1297), `listen` (806, 808, 837), `mic` (787); stopEverything (749) | UI (borrow text from AG state) | |
| `mic` | voice `onState` (main.ts:1452) | UI | |
| `avoid` | `stepAside` (main.ts:299) | UI | settings window rect |
| `idle` | `onStatus → showState({idle: idleWord(status)})` (main.ts:1391-1395; host.ts:258-271) | AG data, UI shows | |

### 2.2 Presenter events and bubble ownership

- `Presenter` (presenter.ts:314-758) turns Copilot session events (`PresenterEvent {type, data}`, presenter.ts:13) into
  `Partial<EmberState>` pushes (`push`, presenter.ts:357; `apply`, 377-394). Called by the conductor
  (conductor.ts:446) and each worker (worker.ts:1163) with every session event; host calls `notice/fail/withdraw/reset/
  userPrompt/outcome/quiet/drop/reshow/letGo` (host.ts:612, 1037-1038, 1124, 1132, 1141, 1176-1177, 784-789).
  Worker calls `taskStarted/progress/guide/stalled`, and sets `presenter.onDesk` (worker.ts:880, 1095, 1103, 1174, 1195).
- `BubbleOwner` (presenter.ts:83-221) arbitrates one bubble among presenters and main. Claims: `progress | reply | step |
  take` (presenter.ts:73). Question gate: constructed with `{up: () => confirmer.waiting, answered: () =>
  confirmer.settled()}` (host.ts:431-432); while up, nothing but the question writes (presenter.ts:137-146, 208-220).
- Main's own bubble as an owner: `claimBubble({pin?})` (host.ts:480-491; 30 s hold, MAIN_HOLD_MS host.ts:294),
  `releaseBubble(showing)` (500-514; returns false when main must hide it itself), `releasePin(showing)` (521-524).
  Main calls them at main.ts:268, 578, 587, 593, 634, 802, 813, 816, 823, 827, 1460.
- Host-side bookkeeping that reads presenter state: `dropAnnouncement` (host.ts:460-467), `conversationEvent`
  (444-452: binds a `user.message` to the queued `UserRequest`, which carries the user's words used by the policy for
  risky steps, 556-578), `withdraw` on reconnect (612), `outcomes` and card-close drop (792-797).

### 2.3 Confirmer (questions, answers, keys, guards)

Types (confirm.ts):
- `Question` (18-26): `{title, context?, prompt, options:{id,label,primary?}[], task?}`
- `ConfirmerTiming` (30-44): `timeoutMs=120000, armMs=500, gapMs=700, blocked(), onChange(q|null), keyHint()`

Flow:
1. AG: `worker.authorize → confirmer.ask(q, overSignal)` (worker.ts:3166, cell batch 2378) → `Promise<string|null>`.
   Abort via signal → `null` (confirm.ts:76-88). `cancelAll` from `abortAll`, `forgetConversation`, `doStop`
   (host.ts:1180, 1193, 1228).
2. Confirmer shows the bubble via main's **unguarded** `showState` (confirm.ts:134-152); action ids are
   `q<n>:<optionId>`; `step` line = `keyHint()` (confirm.ts:146).
3. UI side effects on `onChange` → `questionChanged` (main.ts:625-644): registers Ctrl+Alt+Y/N global shortcuts
   (`QUESTION_KEYS` 610-613, `holdQuestionKeys` 615-621), `releasePin`, un-hides Ember (637-638), speaks the question
   (639-642), notifies if the user is away (643).
4. Answers: bubble click → `OVERLAY.bubbleAction` (main.ts:983-1000) → `confirmer.answer(id)` (999); key →
   `confirmer.answerKey("primary"|"deny")` (618). Guards in `answer` (confirm.ts:110-117): id must match the current
   question and an option; not within `armMs` of display; not while `blocked()` = borrow driving or (pointerLags and a
   synthetic key < 500 ms ago) (main.ts:1280). The bubble-action handler also drops every non-`task:*:stop` action while
   the borrow drives (main.ts:989). "Always" is click-only (main.ts:606-609).
5. Answer effects on AG: `"always"` writes `settings.grants[app] = "act"` (worker.ts:3169-3171); session-scoped
   `allowedApps` (3174-3176); audit `confirm` entries (3167, 2379).

### 2.4 Kill switch

`KillSwitch` (killswitch.ts:19-44): parts run in parallel; returns after all or 300 ms (37); audits `{event:"stop",
source, ms}` (41). `StopSource = "hotkey"|"voice"|"menu"` (17). Parts (main.ts:731-740):

| Part | Does | Side |
|---|---|---|
| `borrow` | `borrowRef.stop()` | hands (machine acted on) |
| `speech` | `voice.hush()` | UI |
| `listening` | `voice.cancelListening()` | UI |
| `agent` | `agent.abortAll()` (host.ts:1171-1182: stops++, drop queued, claimBubble, quiet presenters, cancelAll tasks, `confirmer.cancelAll`, `conductor.abort`) | AG (+ UI confirmer) |
| `desk` | `deskView.handBack()` | UI (desk view) |
| `motion` | overlay `setBorrowing(false)`, deskView `setDriving(false)`, `showState({focus:null, gesture:null})` | UI |

Triggers: hotkey (main.ts:1217), voice "stop" event (846), menu (500). `stopEverything` also dismisses failed cards
(746) and shows "Stopped" (747-750).

### 2.5 Callbacks from AG to UI (`HostOptions`, wired main.ts:1380-1410)

| Callback | Type | AG source | UI effect |
|---|---|---|---|
| `setState` | `(Partial<EmberState>) => void` | presenters, TaskManager | §2.1 (guarded) |
| `onAnswer` | `(text) => void` | conductor.ts:448-451 (final `assistant.message` without tool calls) | `turnAnswer = text`; speak `spokenText(text)` if `maySpeak()` (main.ts:1384, 652) |
| `onTurnEnd` | `(aborted) => void` | conductor.ts:453 (`session.idle`), 511 (stuck) | voice `followUp(8000, {afterQuestion: endsWithQuestion(turnAnswer)})` if the request was spoken (main.ts:1386-1390) |
| `onTaskFinished` | `({title,status,summary,text}) => void` | host.ts:785 | speak, notify when away (main.ts:1399-1402) |
| `onStatus` | `(AgentStatus) => void` | host.ts:606-614 | broadcast `IPC.agentStatusChanged`, `idle` (main.ts:1391-1395) |
| `onTranscript` | `(TranscriptEntry[]) => void` | host.ts:580-586, 599 | broadcast `IPC.conversationChanged` (1396) |
| `onAccountChanged` | `() => void` | host.ts:727 | clear ask history (1398) |
| `describeScreen` | `() => Promise<string>` | conductor `describe_screen` tool (conductor.ts:111-115; host.ts:828) | `perception.describe()` (main.ts:1382) — **AG-side data, not UI** |
| `isOnline`, `reachable`, `resolveProxy` | Electron net helpers | host.ts:935, 706, 960 | machine-local network facts |
| `provider`, `admin`, `settings`, `system` | config | host.ts:686-694, 731-756 | machine-local config |

Types: `AgentStatus` (host.ts:63-79), `TranscriptEntry {t, who:"you"|"ember"|"task"|"problem", text}` (host.ts:82).

### 2.6 Calls from UI into AG (main → AgentHost)

| Member | Where in main | Sync? | Purpose |
|---|---|---|---|
| `ask(text, context, epoch)` | 699 | async | user request; `context: {target: WindowTarget&{app?}, text}` or null |
| `stopEpoch` | 695 | sync getter | taken before the 3 s context wait; a Stop since drops the request (host.ts:1118-1119) |
| `abortAll()` | 736 | async | kill switch part |
| `claimBubble/releaseBubble/releasePin` | §2.2 | sync | bubble ownership |
| `getStatus()` | 405, 598, 858, 901, 1034 | sync | greeting, settings, sign-in result |
| `waitingForNetwork` | 408 | sync | greeting |
| `getTranscript()` | 859 | sync | settings window |
| `lastAnswer()` | 504, 585 | sync | menu "Read the last answer", "Read all" |
| `tasks.list()` | 425 (quit asks if busy), 746 | sync | |
| `tasks.cancel(id)`, `tasks.dismiss(id)` | 995, 746 | sync | card buttons |
| `start(token, source, how)` | 867, 886, 913, 935, 1427 | async | sign-in/out, retry, startup |
| `stop()` | 1093 | async | quit (deletes conversation) |
| `forgetConversation()` | 863 | async | sign-out |
| `setModels(m)` | 1436 | async | settings change |
| `networkChanged(on)` | 1414, 1416 | sync | net watch, resume |

### 2.7 Context capture and describeScreen

- `captureContext()` (main.ts:681-689): only with consent; `perception.quickContext()` (perception/index.ts:293-339) +
  the selection read by `platform.clipboard.readSelection` when the active window isn't Ember's (687), combined with
  `Perception.withSelection` (357-367). Called at wake (main.ts:799), hotkey `openAsk` (717), handle menu (522).
  Timing constraint: before Ember's own windows take focus **on the local machine**.
- `askEmber` (690-700) waits for it at most 3 s (698). `QuickContext {target, text, takesSelection?}`
  (perception/index.ts:54-64). The ask box shows `sees` from it (main.ts:721-726).
- `describeScreen` → `seeing.describe()` (main.ts:1382; perception/index.ts:369-…) — a full read, AG-side.
- Ask-box text arrives by `IPC.ask` (main.ts:962-969; sender check `askWindow.owns`), max 2000 chars, ask history kept in
  main (`askHistory`, 650, 967).

### 2.8 Voice

- Engine events `VoiceEvent` (engine.ts:57-65): `wake{keyword} | stop | listening{on, reason, window} | speech{on} |
  utterance{text, ms, window, cut?} | rejected{keyword, reason, heard?}`.
- Voice process protocol (process.ts:15-30): main→proc `init | self-speaking{on} | follow-up{ms, afterQuestion?} |
  cancel`; proc→main `VoiceEvent | ready | error | stats | monitor | stalled`.
- `VoiceService` API used by main: `speak(text)` (voice.ts:200-206), `hush()` (208-211), `followUp(ms, {afterQuestion})`
  (172-176), `cancelListening()` (194-198), `setMuted` (139), `setWanted` (133), `downloadModels` (149), `micState`,
  `modelsReady`, `isMuted`, `stop`. `VOICE.speaking` from the mic page feeds `self-speaking` to the engine and delays
  follow-ups until speech ends (voice.ts:106-116, 178-186).
- `onVoice` (main.ts:795-849) mixes UI and AG: `wake` → `captureContext`, `hush`, `agent.claimBubble`, "Listening…";
  `listening` off → claim/release and restore (812-824); `utterance` → `askEmber(text)` (841); `stop` →
  `stopEverything("voice")` (846). All audio and ASR is UI side; the AG side sees only `ask(text)` and `abortAll()`.

### 2.9 Settings and admin policy

Reads/writes on the AG side:
- `settings.get().models` at start (host.ts:745-746); `set_appearance` tool writes `character/size` (conductor.ts:102-110);
  "Always" writes `grants` (worker.ts:3170); PolicyEngine reads `privacy.neverLook`, `grants` (main.ts:1337);
  Perception reads `privacy.neverLook` (main.ts:1260).
- Admin policy (admin.ts:19-59, strict schema) read on AG side: `features.actions` (host.ts:867; PolicyEngine 1339),
  `features.screenImages` (host.ts:765), `models.allowed/conductor/worker` (host.ts:731-754), `provider` (1241-1245),
  `confirmEveryAction`, `allowGrants`, `maxActionsPerMinute` (1338-1341), `features.cursor` (1300), `features.desk`
  (1364), `neverLook` (merged into settings, admin.ts:133). UI side: `features.voice` (954), `features.speak` (652),
  `auditRetentionDays` (1276), settings-window status (343-345).
- Settings window channels are guarded to the home window only (`guard`, main.ts:316-321); `updateSettings` strips admin
  never-look entries (350-361).

### 2.10 Audit

`AuditLog.write(AuditEntry {event: decision|action|confirm|task|stop, task?, ...})` (policy/audit.ts:13-17, 35-41).
Writers: worker `audit()` (worker.ts:3103 and ~every action), TaskManager (tasks.ts:109, 263), KillSwitch
(killswitch.ts:41). Reader: settings window `IPC.activity → audit.recent(150)` (main.ts:348). Journal sink per OS
(main.ts:1275).

### 2.11 Hands main gives the agent (`Hands`, main.ts:1334-1379)

| Member | Built from | Consumer | Machine |
|---|---|---|---|
| `perception`, `sidecar` | main.ts:1251, 1258-1272 | worker, cantGuide (host.ts:1090-1099) | acted-on |
| `policy` (PolicyEngine with `isTerminalApp, keys, os, isSecurityWindow` from **local** `sys`) | 1336-1344 | worker | decision; vocab must be acted-on OS |
| `audit`, `confirmer` | 1275, 1277 | worker, host | §2.3, §2.10 |
| `flyTo(b)` | 1346 → `setState({focus: ws.toDip(b)})` | worker.ts:864 | **UI geometry** |
| `currentWindow()` | 1347-1354 (excludes `pid === process.pid`, private windows) | TaskManager default target (tasks.ts:104) | acted-on |
| `pointer()` | `xinput.pointerState()` 1355 | guide `wait_for_click` (worker.ts:1338-1346) | acted-on, but **the user's** mouse |
| `activationKey()` | XInput keysDown 1357-1360 | guide (worker.ts:1316) | same |
| `clipboard` | Electron clipboard 1362 | paste path (worker.ts:848) | acted-on |
| `desk()`, `onDesk()` | 1364-1370 | open_on_desk (worker.ts:1017-1042), setPlace (873-882) | acted-on + **UI view** |
| `cursor {borrow, findWindow, activeWindow, setBorrowing}` | 1371-1378; `showBorrowing` 1290-1299 (overlay click-through, handle click-through, desk view, status line) | withCursor (worker.ts:2950-3020) | acted-on input + **UI status/click-through** |

### 2.12 Inbound UI actions (renderer → main)

`OVERLAY.bubbleAction` id grammar (main.ts:983-1000): `ui:settings | ui:more | ui:conversation | ui:close` (UI-only),
`task:<id>:stop|dismiss` (→ AG tasks), `q<n>:<opt>` (→ Confirmer). Sender must be an overlay or the handle
(main.ts:985). Others: `OVERLAY.cards/interactive/handleMenu/handleFit` (UI-only, 973-1006), `IPC.ask/askClose`
(962-970), desk view `DESK.takeOver/handBack/hide/release/input` (view.ts:104-110).

### 2.13 UI-only state that must never cross

Window focus juggling (`userWindow, askOver, deskTakenFrom, focusNow, giveFocusBack, bringToFront`, main.ts:243-262,
450-480), keyboard hold for the ask box (714-719), menu logic (481-569), compositor watch (1179-1199), shortcuts and
their retry (1202-1233), greeting (404-423), presence/hide/follow (941-950), quit dialog (431-447), session end (1065-1075),
voice model download (952-961), sign-in device flow UI (890-939).

---

## 3. Classification for a split

| Crossing | Remote brain (R) | Local brain, remote hands (L) | Meaningful remotely? |
|---|---|---|---|
| bubble/emotion/talking/gesture patches | AG→UI over wire | local | yes |
| tasks cards | AG→UI | local | yes (ids are the remote's in R) |
| focus (flyTo) | **drop**, or map into a local remote-view window | same | only with a remote view |
| status (borrow text) | AG→UI `borrow.state` | remote hands → local | yes |
| mic, avoid, idle | UI | UI | n/a |
| Confirmer display/answer/keys | UI (local Confirmer), AG has a proxy | local (whole Confirmer) | yes, must name the machine |
| KillSwitch | split: UI parts local, `agent` + `borrow` remote | split: `borrow` remote | yes + dead-man |
| onAnswer/onTurnEnd/onTaskFinished | AG→UI | local | yes |
| onStatus/onTranscript/onAccountChanged | AG→UI | local | yes |
| ask(text, context, epoch) | UI→AG | local | yes |
| quick context | remote capture (the local focused window is the terminal running ssh, which is no target for remote tasks) | RPC to remote | yes |
| describeScreen | AG-local on remote | RPC | yes |
| hideOverlay for capture | no-op on remote | no-op | no |
| guide mode pointer/key watch | only with a remote view that forwards the user's input | same | conditional |
| tier 3 borrow takeover-by-user | meaningless unless the user watches through a remote view | same | conditional |
| settings models/grants/neverLook | per §4.6 | per §5.5 | yes, scoped |
| audit | written where the action happens; local activity view reads both | local + remote echo | yes |

---

## 4. Variant R — remote brain (clone runs AgentHost + hands on the remote)

### 4.1 Placement

Remote clone ("brain host", plain Node under `ELECTRON_RUN_AS_NODE` like the sidecar host and desk helper): AgentHost,
Conductor, Workers, TaskManager, Presenters + BubbleOwner, PolicyEngine, Perception + sidecar, window system, input,
CursorBorrow, clipboard, desk, AuditLog, the Copilot runtime, and a **RemoteConfirmer** proxy. No VoiceService, no
windows, no Notification. Needs replacements for Electron-only helpers (§1): proxy resolution (env/PAC-less), reachability
via Node `fetch`, no `safeStorage` (token in memory only), DIP conversion without Electron `screen`.

Local Ember: everything in §2.13, overlay/handle/ask/settings windows, VoiceService, the real Confirmer and its keys,
the local KillSwitch parts, and a **RemoteAgent** object implementing the members main uses (§2.6) so main.ts changes
little: `agent: AgentHost | null` (main.ts:674) becomes an `AgentPort` (local AgentHost or RemoteAgent) chosen by the
active target.

`AgentPort` (proposed, exactly what main uses today):
```ts
interface AgentPort {
  ask(text: string, context: { target: unknown; text: string } | null, epoch?: number): Promise<void>;
  readonly stopEpoch: number;               // RemoteAgent: a local counter
  abortAll(): Promise<void>;
  claimBubble(o?: { pin?: boolean }): void; releaseBubble(showing?: BubbleState | null): boolean; releasePin(showing: BubbleState | null): void;
  getStatus(): AgentStatus; readonly waitingForNetwork: boolean;   // RemoteAgent: last pushed value
  getTranscript(): TranscriptEntry[]; lastAnswer(): string | null; // RemoteAgent: cached from pushes
  tasks: { list(): { id: string; status: string }[]; cancel(id: string): void; dismiss(id: string): void } | null; // cached from cards
  start(token: string | null, source?: string, how?: "user" | "auto"): Promise<AgentPhase>;
  stop(): Promise<void>; forgetConversation(): Promise<void>;
  setModels(m: { conductor?: string | null; worker?: string | null }): Promise<void>;
  networkChanged(online?: boolean): void;
}
```
Every synchronous member must be answered from a local cache (the remote pushes `status`, `transcript`, `cards`);
nothing in main may await a round trip where it reads synchronously today.

### 4.2 Bubble seam: two options

- **R-A, EmberState seam (recommended first):** remote presenters keep running; their `setState` becomes a wire
  message. Needs: (1) a claim generation: `bubble.claim{gen}` / `bubble.release{gen, showing}` sent by local main; while
  local main holds (a local mirror of the claim), incoming remote `bubble/emotion/talking` patches are not applied (the
  remote's `releaseBubble → uncover → reshow` re-pushes the covered presenter's whole bubble on release, host.ts:500-514,
  presenter.ts:449-462, so a dropped in-flight patch is restored, not lost); (2) a RemoteConfirmer whose `waiting` is
  true from `ask()` until its answer/cancel (conservative: covers queued questions too) and whose `settled()` resolves
  when none is outstanding, so the remote BubbleOwner holds its writes during questions (host.ts:431-432);
  (3) `guardWhileAsking` stays local and wraps remote patches too (main.ts:394). Smallest change on the remote.
- **R-B, presenter-event seam:** ship the session event streams and host presenter calls; run BubbleOwner and presenters
  locally. Cleaner timing (all bubble writes in one thread again), but `dropAnnouncement`, `outcomes`, `withdraw`,
  `releaseBubble` logic and `conversationEvent` (security-relevant user-words binding) are host code that reads
  presenter state (§2.2) and would have to be split or duplicated. More work; consider later.

### 4.3 RPC messages (R)

Envelope: `{v:1, seq, lane:"ctl"|"bulk", kind, body}`; one ordered stream per direction on the ctl lane; bulk (remote
screen frames, if any) on its own SSH channel so a Stop never queues behind a picture.

UI → brain:

| kind | body | when | latency need | ordering | origin rule |
|---|---|---|---|---|---|
| `hello` | `{proto, uiVersion, uiOs, consent:{version,at}, localAdmin: AdminConstraints, userNeverLook: string[]}` | connect | — | first | local Ember only |
| `auth` | variant per §4.7: `{token, source}` in memory, or `{none}` | after hello, on sign-in/out | — | before ask | settings window (`guard`) only |
| `heartbeat` | `{t}` | 1 Hz | — | any | — |
| `stop` | `{epoch, source: StopSource, dismissFailed: true}` | kill switch | **< 300 ms target** (killswitch budget, killswitch.ts:37); local parts never wait for it | after everything sent before | hotkey / "Ember, stop" / menu only |
| `context.capture` | `{cid}` | wake, hotkey, menu (main.ts:799, 717, 522) | best effort | before its `ask` | local |
| `ask` | `{rid, text ≤2000, cid|null, epoch, via:"voice"|"text"}` | utterance / ask box | RTT | FIFO | local mic ASR or ask box only (main.ts:841, 962-969) |
| `bubble.claim` / `bubble.release` / `bubble.releasePin` | `{gen, pin?}` / `{gen, showing: BubbleState|null}` | §2.2 call sites | RTT | FIFO with ask/stop | local main only |
| `confirm.answer` | `{qid, answer: string|null}` | local Confirmer resolved (click, key, expiry, cancel) | RTT | FIFO | **only the local Confirmer** (bubble click from overlay/handle, Ctrl+Alt+Y/N); never derived from any wire input |
| `task.cancel` / `task.dismiss` | `{id}` | card buttons (main.ts:994-997), stopEverything (746) | RTT | FIFO | local click |
| `models.set` | `{conductor, worker}` | settings (main.ts:1434-1437) | — | — | settings window |
| `network.changed` | `{online}` | local net watch | — | — | (remote should watch its own network instead) |
| `settings.sync` | `{neverLook: string[]}` (user's privacy list; see §4.6) | change | — | — | settings window |
| `signOut` / `retry` / `quit` | `{}` / `{}` / `{forget: true}` | settings / quit (main.ts:860-868, 882-889, 1087-1099) | quit waits ≤ 3 s like today | — | settings window / quit |
| `query` | `{qid, what: "audit", limit}` | settings activity tab (main.ts:348) | seconds | — | settings window |

Brain → UI:

| kind | body | when | latency need | ordering | trust |
|---|---|---|---|---|---|
| `welcome` | `{proto, brainVersion, os, host, capabilities:{actions,cursor,desk,guide,vision}, remoteAdmin: AdminConstraints}` | connect | — | first | remote data |
| `state` | `{gen, patch: Omit<Partial<EmberState>, "focus"|"avoid"|"mic"|"idle"|"status">}` | presenter/TaskManager pushes | coalesce to ≤ 20 Hz; latest bubble wins | FIFO | untrusted text; local whitelists action ids (§9) |
| `focus` | `{rect, screen:{width,height}}` (remote coords) | flyTo | — | FIFO | drop unless a remote view is shown, then map into it |
| `answer` | `{text}` | onAnswer | — | **before** the `turnEnd` of the same turn (conductor.ts:448-453) | speak via local `maySpeak()` |
| `turnEnd` | `{aborted}` | onTurnEnd | — | after `answer` | local follow-up decision |
| `taskFinished` | `{title, status, summary, text}` | onTaskFinished | — | after the final `state` for that card | local speak/notify (length-capped, main.ts:648) |
| `status` | `AgentStatus & {waitingForNetwork}` | onStatus | — | FIFO | cached for sync `getStatus()` |
| `transcript` | `{entries: TranscriptEntry[]}` (or append/replace deltas) | onTranscript | — | FIFO | cached for `getTranscript()/lastAnswer()` |
| `accountChanged` | `{}` | onAccountChanged | — | — | — |
| `confirm.ask` | `{qid, question: Question & {machine: string}}` | RemoteConfirmer.ask | human scale (≤ 0.5 s) | FIFO | local shows "On <host>: …" |
| `confirm.cancel` | `{qid}` | task aborted / cancelAll | RTT | FIFO | — |
| `borrow.state` | `{driving, pending, usesMouse}` | CursorBorrow onChange | — | — | local status line only (no local click-through needed: it is the remote mouse) |
| `appearance` | `{character?, size?}` | `set_appearance` tool (conductor.ts:102-110) | — | — | local validates against `SettingsSchema` and applies |
| `stopped` | `{epoch, ms, late: string[]}` | after the remote KillSwitch | — | after `stop` | local audit `{event:"stop", remote}` |
| `queryResult` | `{qid, entries}` | — | — | — | untrusted |
| `heartbeatAck` | `{t}` | — | — | — | — |

### 4.4 Confirmations in R

- Remote worker → `RemoteConfirmer.ask(q, signal)` → `confirm.ask{qid,q}`; signal abort → `confirm.cancel{qid}` →
  local `AbortController` for that qid (the real Confirmer already resolves null on abort, confirm.ts:80-84).
- Local bridge calls the real `Confirmer.ask(q, signal)` built exactly as today (main.ts:1277-1283): `armMs`, `gapMs`,
  `timeoutMs` measured locally from display; `blocked()` covers only the local borrow (none in R) and `pointerLags`.
- Answer goes back as `confirm.answer`. The remote treats link loss, `stop` and its own safety timeout (`timeoutMs` +
  RTT margin, e.g. 125 s) as `null` ("no").
- Prompts must name the machine (title "May I? (on build-01)"); "Always in <app>" is a grant on the remote's settings
  (remote-scoped by construction).
- Local `cancelAll` becomes a local kill-switch part (today it is inside `abortAll`, host.ts:1180).

### 4.5 Kill switch in R

Local `KillSwitch` parts: `speech`, `listening`, `motion`, `desk` (local view), **new** `confirm` (local
`confirmer.cancelAll()`), and `remote` = send `stop{epoch}` and resolve on `stopped` or the 300 ms race. Remote runs its
own KillSwitch with `borrow` and `agent` parts on receipt. Required safety nets:
1. **Dead-man:** no `heartbeat` for N s (proposal 3-5 s) → remote pulls its kill switch and refuses new actions until
   `hello` again (nobody can see, confirm or stop).
2. **Channel close = stop:** stdin EOF / SIGHUP → stop and exit (desk template, agent-process.ts:229).
3. **Priority:** `stop` is on the ctl lane, never behind bulk; the remote handles it before queued `ask`s (it drops
   queued requests anyway, host.ts:1174).
4. **Epoch:** UI keeps the epoch locally (`stopEpoch` in RemoteAgent); `ask` carries it; the local 3 s context wait
   drops a request whose epoch changed (main.ts:695-699 logic unchanged).

### 4.6 Settings and policy composition (R)

- `models`: remote applies local choice, within the intersection of both admins' `models.allowed`.
- `grants`: remote's own settings (remote apps); the local settings window should show them per machine.
- `neverLook`: union of local user list (sent), remote user list, local admin list, remote admin list.
- Admin features for remote actions: AND of local and remote `features.actions/cursor/desk/screenImages`;
  `confirmEveryAction` OR; `allowGrants` AND; `maxActionsPerMinute` min. `features.voice/speak` stay local.
  A new local key (e.g. `features.remote`) would let an organisation forbid remote Ember; `AdminPolicySchema` is
  `.strict()` (admin.ts:59), so an older Ember reading a newer file locks down (fail closed) — acceptable, but plan it.
- `provider` (BYOK) is a local admin's endpoint + key file; forwarding the key to a remote host is a new exposure:
  default should be "remote brain unavailable under a BYOK provider" unless the remote admin configures its own.
- Consent: hello carries the local consent version; the remote refuses `ask` without it. A per-host consent
  ("Ember will read and act on <host>'s desktop") is a local UI decision.

### 4.7 Token options (R)

| Option | How | Risk |
|---|---|---|
| R-T1 forward in memory | `auth{token}` over the ssh channel; remote passes `gitHubToken` to `CopilotClient` (host.ts:690) | remote root and same-uid processes can read it (process memory, runtime env); a GitHub CLI token (source `github-cli`) usually carries repo scopes: never forward those; at most Ember's own device-flow token |
| R-T2 sign in on the remote | device flow run by the remote, code shown locally | no keyring on a server: token on remote disk or lost at restart |
| R-T3 runtime stays local (hybrid H2, §6) | remote SDK client talks to a local copilot-runtime through the channel | token and model egress never leave the PC; needs a spike on how the SDK hands the token to the runtime |

### 4.8 What R costs

- New: wire codec + RemoteAgent (UI) + brain-host entry point (remote) + RemoteConfirmer + claim generations +
  heartbeat/dead-man + per-machine settings display. Agent code largely unchanged.
- Remote prerequisites: Node-capable Ember build for the remote OS/CPU (the Copilot runtime ships only linux-x64 for
  Linux, runtime.ts:11-22: an arm64 server has no runtime), network egress to Copilot from the remote, a graphical
  session for hands (see §4.9).
- Data volume small (text, patches); screenshots go remote → model API directly.

### 4.9 "Acts on the remote machine" constraints the boundary inherits

- The hands process must run **inside the remote's graphical login session**, not the SSH session: Linux needs that
  session's `DISPLAY`/`XAUTHORITY` and AT-SPI bus (Wayland sessions give XTest no reach into native Wayland apps);
  Windows OpenSSH sessions are not the interactive desktop (UIA/SendInput need the user's session); macOS needs the
  Aqua session and Accessibility/Screen Recording grants made on the remote by a person.
- The user cannot see that screen. Tier 3 semantics (wait for the user to be idle, let go when they move the mouse,
  Ember flying beside the control) do not hold. The safe model is tier 2's: a local **remote view** (DeskView-like
  mini-view of remote frames, view.ts:76-215) shown whenever Ember acts there, with Take over/hand back, and questions
  that say "on <host>". Without a view, restrict remote work to tier 0/1 with every step confirmed, and disable
  `show_me` (it points at things nobody sees).
- Command-line action on the remote conflicts with the "never runs programs or shell commands" rule; it is out of
  this seam and would need an explicit owner decision and its own tool + policy (not a passthrough).

---

## 5. Variant L — local brain, remote hands and eyes

### 5.1 Placement

Local: AgentHost, Conductor, Workers, TaskManager, Presenters, PolicyEngine, Confirmer, AuditLog, the Copilot runtime
and token. Remote "reach" process (in the remote's graphical session): Perception reads, the accessibility sidecar,
window system, capture + encoding, CursorBorrow with its safety loop, clipboard snapshot/paste/restore, app catalog and
launch (terminal refusal enforced remotely too), system settings change, optional remote desk.

### 5.2 Why the seam cannot be at WindowSystem/Input level

- `WindowSystem extends Omit<X11,"capture">` and `Input extends XInput` are synchronous (platform/types.ts:65-114).
  Perception, main's hands closures (`currentWindow`, `findWindow`, `activeWindow`, main.ts:1347-1375) and
  CursorBorrow (8 ms polling of `pointerState/keysDown`, borrow.ts:102, 265, 279, 341) call them in tight loops.
- The desk solves "another display" with a sync relay that blocks Ember's thread on `Atomics.wait` for each call
  (desk/agent.ts:139-176; 1 s timeout, up to 5 s while the helper burns CPU). At ~0.2 ms locally that is fine; at a
  20-200 ms RTT it would freeze Electron's main thread, which drives the overlay at 60 Hz (overlay.ts:1-5).
- Therefore: the borrow loop, the auth-prompt check before every borrowed key (worker.ts:2956-2961, 2966-2969) and
  `findWindow` must execute on the remote; the local side calls them per **Hand op** (already async: `glideTo, click,
  keys, type, checkTyping, scroll`, borrow.ts:62-72). Six `withCursor` call sites in worker.ts.

### 5.3 RPC messages (L), brain(local) → reach(remote)

| kind | body → result | latency | notes |
|---|---|---|---|
| `hello` → `welcome` | `{proto, brainVersion}` → `{os, host, screen, calls: {ax:[...], perceive:[...], hand:[...], system:[...]}, remoteAdmin}` | — | capability list like the desk's `calls` (agent-process.ts:231) |
| `ax.<method>` | the sidecar's 15 JSON-RPC methods with their params → their results (sidecar.ts:364; specs sidecar-protocol-read/act.md) | RTT + payload | element ids in a per-machine `ID_BLOCK` (sidecar.ts:214-221); secrets map per machine (sidecar.ts:240-249) |
| `perceive.read` | `{target, opts}` → `Seen` | RTT + tree size | or composed locally from `ax.*` + `perceive.windows` |
| `perceive.quick` | `{}` → `QuickContext` | ≤ 3 s cap | at wake/hotkey |
| `perceive.describe` | `{}` → `string` | seconds | describe_screen |
| `perceive.windows` | `{}` → client windows + stack snapshot | RTT | cached locally for sync getters, never for security checks |
| `perceive.systemDialog` | `{}` → `boolean` | RTT | fails closed |
| `perceive.capture` | `{rect?, maxWidth, quality}` → `{jpeg (bulk lane), width, height, scale}` | RTT + 100-400 KB | encoded remotely (desk template, agent-process.ts:194-211) |
| `borrow.open` | `{bid, window:{title,pid}, keysOnly?}` → `{ok}` / `{error}` | waits for the remote borrow's turn | remote CursorBorrow; `borrow.state` events flow back |
| `hand.op` | `{bid, op, args}` → `{ok}` / `{error:"took-over"|"stopped"|"auth-prompt"|…}` | RTT per op | remote checks auth prompt and focus each op |
| `borrow.close` / `borrow.abort` | `{bid}` | RTT / priority | abort on task stop (`overSignal`) |
| `clipboard.paste` | `{bid, text}` → `{ok}` | RTT | snapshot/restore remotely (clipboard.ts PasteClipboard) |
| `app.list` / `app.launch` | `{}` → apps / `{id}` → `{pid}` | RTT | remote refuses terminals and built-in-shell apps (place.ts:144-145 rules) |
| `setting.change` | `{name, value}` → result | RTT | remote `SystemSettings` |
| `window.find` / `window.active` | `{title,pid}` → id / → `{app,title,pid}` | RTT | |
| `pointer.watch` | `{on}` → stream of `pointer.press{x,y}` / `key.activation` | event | guide mode only with a remote view |
| `stop` | `{epoch}` → `stopped` | priority | remote releases keys/buttons, aborts borrows |
| `heartbeat` | `{t}` | 1 Hz | dead-man on the remote releases everything |

Reach → brain events: `borrow.state{driving,pending,usesMouse}`, `windows.changed`, `pointer.press`, `dead{why}`
(display gone), `stopped`.

### 5.4 The acted-on OS problem

`WorkerSystem` (worker.ts:46-54: `os, keys, words, shortcuts, apps, settings, privacy`) and the PolicyEngine's
`isTerminalApp, keys, os, isSecurityWindow` (main.ts:1336-1344) are wired from the **local** platform. In L they must be
the remote's: static tables chosen by the remote's `os` (`KEYS`, `PLATFORM_WORDS`, privacy vocab) plus `apps`/`settings`
proxied to the reach process. `HostOptions.system` (host.ts:129) is per host, so L needs a per-target WorkerSystem (one
AgentHost per target, or a target-aware worker).

### 5.5 Settings/policy (L)

Grants must be namespaced by machine in local settings (today keyed by lower-case app name only, worker.ts:3170;
`SettingsSchema.grants` is `record<string, "observe"|"act">`, settings.ts:54): e.g. `"ssh:<host-key-fp>:firefox"`.
Admin composition as in §4.6, with the remote admin constraints fetched in `welcome` (the remote's
`/etc/ember/policy.json` must still bind actions on its machine). Audit: local log has decisions; the reach process
should also append its own record of every primitive executed (the remote machine keeps a trail).

### 5.6 What L costs

Large: async-ify Worker paths that call sync window/input members (findWindow, activeWindow, pointer/activationKey
polls), move CursorBorrow remote, a target-aware WorkerSystem, a RemotePlace with async facades, tuned sidecar timeouts
over a link (today 5 s default per request and kill-and-respawn on timeout, sidecar.ts:1-12, 364). Per step 1-3 RTT +
tree/picture payload: at 300 ms RTT a step gains about 1 s. Benefits: token, conversation and policy decisions never
leave the PC; the remote needs no Copilot runtime or egress.

---

## 6. Hybrids worth keeping on the table

- **H1 local conductor, remote task runner:** conversation, transcript, `userWordsOf`/`terminalRefused` (the user's
  words binding, host.ts:556-578, 865-890) stay local; `start_task/show_me/list_tasks/cancel_task/steer_task`
  (conductor.ts:116-140) and `takeReports` call a remote TaskManager; `describe_screen` is an RPC. Workers (and their
  screenshots) run remotely. Seam = ConductorDeps task hooks + TaskManager callbacks + task presenters + RemoteConfirmer.
  Still needs a model client on the remote (token issue) unless combined with H2.
- **H2 runtime stays local:** the remote SDK client spawns a relay instead of `copilot-runtime`
  (`RuntimeConnection.forStdio({path})`, host.ts:691); the relay pipes over the SSH channel to a runtime the local Ember
  starts with the token. Tool handlers still execute remotely (SDK calls back into the client). Unknowns: how the SDK
  passes `gitHubToken` to the runtime, runtime file paths (`baseDirectory`, `workingDirectory`) that would now be local,
  and latency of every tool callback crossing the link.

---

## 7. What the desk agent teaches (template for a remote "hands and eyes" process)

Reuse:
1. **Isolation, "the helper dies, never Ember"** (agent-process.ts:1-9): a lost link or dead remote display ends the
   remote process / marks the place dead; local calls fail fast with a typed error (`DESK_STOPPED`, agent.ts:15).
2. **Capability handshake:** helper announces `{ready, calls}` (agent-process.ts:231); local builds facades only for
   methods that exist (`facade`, agent.ts:242-251). Use it for version skew between local Ember and the clone.
3. **Closed dispatch:** `targets[r.t][r.m]`, `close` refused, nothing else callable (agent-process.ts:214-219). The
   remote must expose a closed typed set; no generic exec/eval/spawn (keeps the no-commands rule enforceable).
4. **Liveness:** `alive`, `onExit`, hung → kill (agent.ts:127-176, ended 223); `guardX` proxy throwing on a dead place
   (place.ts:188-205); `onDead` handlers marked before anything else runs (place.ts:215-225). Map to heartbeat +
   dead-man + `RemotePlace.dead/onDead`.
5. **Lifecycle tie:** `process.on("disconnect", exit)` (agent-process.ts:229); relay `unref()` never keeps Ember running
   (agent.ts:96). Remote: stdin EOF → stop + exit.
6. **Minimal environment:** helper gets only the env it is given (agent.ts:108-111 doc; DISPLAY, XAUTHORITY). Remote:
   no token unless the brain is remote.
7. **Bulk work in the helper:** JPEG via sharp with `concurrency(1)` (agent-process.ts:194-211), bytes via
   `serialization:"advanced"` (agent.ts:42), async `request` path (agent.ts:180-187). Remote: encode, cap, send on a
   bulk lane.
8. **Diagnostics:** stderr tail kept with noise filtered (agent.ts:20-30, NOISE at 26) and attached to the exit reason.
9. **DeskPlace is the right abstraction** for "a screen the user doesn't see" (place.ts:20-41: perception, sidecar,
   input, x11, keys, snapshot, userInControl, dead/onDead, open, close); the worker already switches on `place`
   (worker.ts:851, 856, 873-882; `withCursor → onDeskInput`, 2952; `fly` suppressed on a place, 864), presenter words
   drop "your keyboard/mouse" (`presenter.onDesk`, presenter.ts:336), and DeskView provides the mini-view + Take over UX
   (view.ts). A RemotePlace fits here.

Change:
- The sync `call` path (Atomics, agent.ts:139-176) is unusable over a network; only `request`-style async calls.
- `deskBorrowFor(place)` builds `new CursorBorrow(place.input)` locally (worker.ts:740): over a link the borrow must be
  remote (§5.2).
- `place.open(app)` runs argv via the desk manager (place.ts:232-237): remotely it becomes `app.launch{id}` with the
  remote enforcing `deskRecipe`'s terminal/built-in-shell refusals.
- Element ids: namespace per machine, not only per process (sidecar.ts:214-221); keep the secret-field memory per machine.

---

## 8. WSL on this boundary (same machine)

- WSLg apps are Windows top-level windows owned by `msrdc.exe` (RAIL); UIA exposes the frame, not the Linux app's
  controls. Tier 1 needs the Linux AT-SPI sidecar **inside** the distro. The sidecar already runs from a
  `SidecarLaunch {command, args, env}` (sidecar.ts:198-213), so `wsl.exe -d <distro> -- python3 <ember_atspi.py>` is a
  "remote eyes" with a near-zero-latency transport. This is L with no network: a cheap testbed for RemotePlace,
  per-machine ids/secrets, composite perception routing (RAIL window → WSL sidecar, others → UIA host).
- Unknowns to spike: a session D-Bus and at-spi2 in the distro (systemd optional), whether AT-SPI coordinates map to
  Windows screen coordinates for RAIL windows (and DPI), and focus/keyboard delivery for tier 1 actions.
- Input stays Windows SendInput (the windows are on the user's screen), so tier 3 semantics (user sees, can take over)
  hold, unlike SSH.
- Launching: WSLg Start-menu entries for Linux apps fit today's tier-0 launch; a WSL shell or `wsl.exe <command>` is a
  terminal/command and is refused today (design.md:2539 lists `wsl, wslhost, bash, ubuntu…` as terminals). Lifting that
  is an owner decision outside this seam.
- Brain and UI stay on Windows; no RPC boundary beyond the sidecar's own stdio is required.

---

## 9. Transport and security requirements (both variants)

1. **Transport:** the SSH channel's stdio of a session the local Ember started (e.g. `ssh host ember-remote serve`),
   one ctl channel + one bulk channel. No listening TCP port. If a socket is unavoidable: unix socket in a 0700
   directory, peer-uid check, per-session secret from the handshake.
2. **Framing and versioning:** length-prefixed JSON (or MessagePack) frames with size caps (ctl ≤ 64 KB, bulk chunked);
   `proto` version in hello/welcome; capability lists (§7.2) so a newer local can drive an older clone.
3. **Origin rules (local side):** accept from the remote only display and data messages. Never let a remote message
   (a) answer a question, (b) change local settings other than validated `appearance`, (c) open windows/URLs or run
   anything locally. Whitelist bubble action ids in remote patches: `ui:more`, `ui:close`, `ui:conversation`,
   `ui:settings`, `task:<remote id>:stop|dismiss`; strip `q*` ids (questions only arrive via `confirm.ask` and are
   rendered by the local Confirmer). Treat all text as untrusted model/screen output (plain text only, length caps).
4. **Origin rules (remote side):** `confirm.answer`, `stop`, `ask`, `task.*`, `auth`, `models.set`, `quit` accepted only
   on the authenticated channel. Root on the remote is out of scope (it owns the machine).
5. **Wrong-machine safety:** every question, card and the handle name the target machine; the kill switch stops all
   targets (local and every remote) at once.
6. **Liveness:** heartbeats both ways; remote dead-man (§4.5); local shows "Lost <host>" and treats outstanding
   questions as "no".
7. **Privacy:** audio never leaves the PC (local wake + ASR, only text sent: keeps the voice process promise,
   engine.ts:1-3). Sending audio to the remote would break it and require models there; not recommended.
8. **Conversation residue:** in R the conversation lives in the remote runtime's store (`baseDirectory`, host.ts:688);
   deleted at quit (host.ts:658-661) and leftovers swept at start (conductor.ts:398-428); a crashed clone leaves it until
   the next start.

---

## 10. Risks and open questions for the owner

| # | Risk / question | Note |
|---|---|---|
| 1 | Which variant: R (small seam, token/egress on remote) vs L (big refactor, nothing secret leaves the PC) vs H1/H2 | R-A is the fastest path; H2 removes R's token exposure if the SDK allows it |
| 2 | Token forwarding to shared servers | never forward GitHub CLI tokens; decide whether Ember's own token may go |
| 3 | Approval spoofing via a reachable remote endpoint | stdio-over-SSH only |
| 4 | Kill switch over a WAN | local parts instant; remote ack ≤ RTT; dead-man 3-5 s; channel close = stop |
| 5 | Acting on a screen the user cannot see | require a remote view (desk template) or restrict to tier 0/1 + per-step confirms; disable guide |
| 6 | Remote session access (Linux display/bus, Wayland, Windows session 0, macOS TCC) | the hands must run in the GUI session; how it gets there is an install/launch question |
| 7 | Version skew and updates of the clone | proto + capabilities; refuse to drive an incompatible clone |
| 8 | Grants and never-look scoping across machines | per-machine grants; never-look union |
| 9 | Admin policy composition and a new `features.remote` key (strict schema) | fail closed on old builds |
| 10 | Voice routing with several targets | explicit active target on the handle/menu vs heuristics from the focused terminal (reading terminals conflicts with the rules) |
| 11 | Copilot runtime availability on the remote CPU (linux-x64 only) | blocks R on arm64 servers |
| 12 | Command-line work on the remote / in WSL | conflicts with "no terminals, no commands"; needs an explicit rule change and its own policy, not a passthrough |
