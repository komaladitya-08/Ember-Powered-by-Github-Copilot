# Windows conductor and companion acceptance

Use a Windows 10 22H2 or Windows 11 laptop for the native checks below. Record the exact commit, Windows build,
display scales, input language, model/provider and approval mode with each result. A passing automated suite does
not certify real app focus, microphone quality, cursor ownership or a coding execution boundary.

The Projects & sessions board groups desktop tasks. Explicit Save projects keeps an encrypted checkpoint; Open
saved projects restores inert records, ordered goals and observed outcomes and marks interrupted work stopped.
Review remaining steps prepares a fresh editable request without replaying actions. Save again to retain later progress.
It never resumes model sessions. Current consent version 14 covers saved records and copied-folder reviews. The
Windows development candidate now offers explicit files-only copied edits, sealed review, export and Forget through
the ordinary Host. Commands, tests and dependency installation remain unavailable, and the legacy native-SDK gate
stays false. Do not change those execution gates to perform acceptance. Public `7eabd077` now reports
`canContinue: true` after the separate real Home continuation proof. Automatic crash checkpointing is not implemented.

Hosted Server 2022/2025 evidence now includes the following exact heads; record it separately from laptop results:

| Candidate proof | Completed evidence | Remaining limit |
|---|---|---|
| Controller/product `0f70a7f7`, [run 43812314219](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812314219) | Per server: 97 portable cases, three native controller cases including the actual SDK contract, and one genuine Electron journey with two fresh sessions. Zero skips; Electron 13.267/14.744 seconds, normal exit, normal OS sandbox verified by process metrics, absent Node globals and no bypass. | Mock provider and supplied picker answers; no live authentication or native picker UI proof. |
| Native continuation `7eabd077`, [run 43813240393](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813240393) | Per server: 147 portable, 30 artifact, 23 sealed-copy/review and five resource cases; 410 total, zero skips. | Establishes native fresh-file continuation, not the public Home control. |
| Continuation/product `fac7c0a3`, [run 43812927368](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812927368) | Per server: 97 portable, three native controller and one genuine Electron three-session case; zero skips/failures. Electron 16.393/15.970 seconds; Continue first read `43`, produced `44` against original baseline/current `41`, survived predecessor Forget and preserved completed `42`/`44` exports after global erasure. Normal OS sandbox, sender guards and unforced exit `0` verified. | Public #223 advanced to `7eabd077` with the same production source and `canContinue: true`. Its native matrix above is green; ordinary CI remains blocked by the known Windows LPAC child-launch case; live provider and laptop checks remain. |

Windows command execution remains separate software work. Native child creation/PowerShell failures are recorded in
[the command proof](ISOLATED-WINDOWS-COMMAND-PROOF.md); stock Node LPAC startup still fails at `WSAStartup` with code
`10107`. Neither a fixed C/libuv experiment nor a successful files-only laptop story supplies that command boundary.

## Prepare the checkout

Use a disposable test folder and ordinary test documents. Keep a copy of any document used in a test. Install
Node.js 22.12 or newer and the pinned npm dependencies, then run these from PowerShell in the checkout:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration -- test/integration/killswitch-deadline.test.ts
npm run test:integration -- test/integration/coding-native-runtime.test.ts test/integration/coding-mixed-completion.test.ts test/integration/sdk-permission-modes.test.ts
npm start
```

The coding runtime tests use a local mock model and disposable files. Some sandbox probes are Linux-only or skip
when a capability is unavailable. Report every skip as unverified on Windows; a skip is not evidence of isolation.
Use the real connected provider for the interactive product checks below. Do not put account credentials in a test
prompt, fixture or screenshot.

## Run the complete desktop story

| Check | Action | Expected result |
|---|---|---|
| Project creation | In Projects, create “Laptop acceptance” with a goal. Select it. | The name and goal appear; creating the record starts no app action. |
| Conductor delegation | Ask the conductor to create a harmless note in Notepad and inspect an ordinary browser page as separate tasks, naming each session. | Delegated tasks appear beneath the active project and in Task activity. Worker sessions use the existing task scheduler and approval rules. |
| Ordered sessions | Ask for a two-step desktop sequence, then test failure, Stop during cleanup, a mode change and a steering request that fails to deliver. | The next named session starts only after observed success and confirmed cleanup. Stop/steering/authority changes retire the rest; no previous model output becomes permission. |
| Parallel work | Keep two tasks occupied and request a third independent task. | At most two workers run; the next session visibly waits its turn. Two workers do not act in the same window together. |
| Companion progress | Work in another app while one task runs, two run, and a task is queued. Hover over the companion. | Compact status distinguishes running and queued work and identifies a single task. The fuller description names task states. Updates do not steal keyboard focus. |
| Approval waiting | In Interactive, request an action that genuinely requires approval under [APPROVALS.md](APPROVALS.md). | The question and waiting state agree across the companion, session board and Task activity. Approval controls remain reachable and ordinary commands do not acquire extra questions. |
| One-session Stop | Stop one session from its board/task control. | That exact task stops; unrelated work continues. The terminal state is visible and no further action from the stopped worker occurs. |
| Global Stop | With multiple tasks active, use Win+Alt+X and separately test “Stop everything”. | All work is told to stop promptly, including queued work. A stopped session never starts later. Any cleanup still pending is reported honestly. |
| User takeover | While Ember borrows the cursor for a harmless step, move the mouse or type. | Ember releases control and does not move the pointer again behind the user. Follow-up borrows follow the existing takeover rule. |
| Project separation | Create and select a second project; delegate another harmless task. Switch between projects while tasks complete. | Session identities and outcomes remain with their original project. Merely switching projects does not cancel or reassign existing work. |
| Completion and failure | Complete one task; refuse another or close its target app. | Success, failure and Stop are distinct, with a readable outcome. Model prose alone does not turn failed work into a successful result. |
| Forget and identity | Try forgetting a project with active work; then stop it and forget it. Sign out and reconnect. | Active work cannot be silently orphaned by forgetting. Forgotten records disappear; another account sees none of the previous account's project records. |
| Quit and reopen | Quit normally, then reopen Ember. | The live board is empty. Open saved projects restores an explicitly saved checkpoint, with interrupted sessions stopped and no executable old task references. No old task resumes with old authority. |
| Review interrupted goals | Save a plan after its first completed step and during its next step, restart, open it, and review remaining steps. Repeat with a long plan and an existing unsent request. | Full goals and outcomes remain visible. Only the contiguous completed prefix is omitted. Partial effects are called out. Review does not execute or silently replace a draft; edit/use the request, then explicitly Send with current approvals. Oversized goals are not truncated and can be reviewed one step at a time. |
| Files-only coding | Bind a disposable project folder and ask for a harmless copied-file edit. Review/export it, then forget the result and all private work. | Ember edits only its private copy; original files remain unchanged. Review/export and erasure agree with session state. The summary records zero commands/tests and explains the limit. Selected-file review keeps its separate grants. |
| Execution limits | Ask the files-only session to run a test, install dependencies or use a native SDK shell/edit tool. | No execution capability appears and no command/test success is claimed. The legacy native-SDK gate remains false. |
| Reviewed continuation | Open a completed review, choose Continue and send a new request that first reads the reviewed value. Forget the predecessor after the new copy is admitted. | The fresh session starts from the complete reviewed proposal and retains the cumulative original baseline. Earlier task permissions/conversation are not resumed. Predecessor Forget preserves the admitted copy; global Forget still erases its private work. |

## Check native laptop behaviour

Repeat the relevant story on the internal display and an external display with different scaling (for example,
100% and 150%). Move the active app and companion across display boundaries. Check large text, reduced motion,
keyboard-only navigation and a screen reader: session status must be understandable without colour, and updates
must not repeatedly announce the entire board or lose focus from its controls.

Open Ask Ember over Notepad, a Chromium text field, a WPF application and Word if available. Confirm the Ask box
stays open and the user's typing reaches it; after dismissal, keyboard focus returns sensibly to the app. Check a
non-English keyboard layout, Caps Lock and remapped modifier keys if the laptop uses them.

Test a real microphone and physical speakers: wake/listen, a multi-turn request, interruption, spoken Stop, and an
approval answer while a question is visible. Repeat with other sound playing and confirm words over Ember's own
voice cannot approve an action. Synthetic audio and a mock provider do not establish this behaviour.

Lock/unlock Windows, suspend/resume, disconnect/reconnect the network and revoke/regrant microphone permission
while work is queued or active. Ember must pause or stop where appropriate, explain connection failures and avoid
replaying stale input or resurrecting stopped sessions. Include a standard-user account and an elevated target
application: Windows' privilege boundary must not be mistaken for a successful action.

## Before merge or release

Attach the exact results and observed failures to the review. Keep cloud results, real-provider results and native
laptop results separate. Re-run affected checks after fixes. The project's release workflow also requires the exact
tag/commit and its platform jobs to pass; this checklist neither publishes a release nor authorises a merge.

The custom-tool controller remains in the trusted host with native SDK tools disabled. Project code needs an enforced
boundary for commands and descendants, host-private file aliases, credentials and process inspection, toolchain/network
behaviour, Stop and crash recovery, and safe result capture/export. The separate legacy Linux canary tests still
reproduce unsafe native-runtime behaviours; their green probe results do not certify that older path. A successful
Windows desktop pass cannot close the new backend's software requirements.
