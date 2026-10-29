# Keeping Ember's safety guarantees over SSH and inside WSL

Branch `ember-improve/20261022-windows-macos`. Code read for this spec: `app/main/policy/policy.ts`,
`app/main/agent/{confirm,killswitch,worker,host}.ts`, `app/main/admin.ts`, `app/main/policy/audit.ts`,
`app/shared/consent.ts`, `app/shared/never-look.ts`, `app/main/hands/{terminals,borrow,system}.ts`,
`app/main/policy/vocabulary.ts`, `app/main/agent/{auth,session-config,persona,conductor}.ts`,
`app/main/perception/{elements,index}.ts`, `app/main/platform/{compose.ts,win32/system/*}`, `app/main/main.ts`,
`app/renderer/home/index.html`, `PLAN.md` §2, §5, §6 and `docs/RESEARCH.md` §5, §9.

The sibling specs in this folder cover the mechanics: `decisions.md` (the owner's answers), `agent-ui-split.md` (the seam),
`install-transport.md` (ssh, the clone, the channel), `remote-desktop.md` (reaching the remote GUI session) and `wsl.md`
(WSLg and the in-distro sidecar). This spec covers only the safety mapping. It cites them where they already settle a
mechanism, and it re-checked every code fact it uses.

Tags: **(code)** = read in this branch, with a line. **(OS fact)** = documented platform behaviour. **(verify)** = an
assumption that needs a spike. **(choice)** = an owner decision this spec does not make.

---

## 0. Key findings

1. **The binding decisions (`decisions.md`) put the brain on the local PC.** The conductor, the workers, the Confirmer,
   voice, TTS, the first policy gate and the kill switch's origin stay local. The remote clone is eyes, hands and a
   command runner only. That one choice makes most guarantees structural rather than procedural:
   - approvals cannot be forged from the remote, because no message type answers a question;
   - the GitHub token never leaves the PC;
   - audio never leaves the PC.
2. **Approvals today have exactly two origins, and both are local.**
   - A click in Ember's own overlay or handle: `ipcMain.on(OVERLAY.bubbleAction)` checks `overlay.owns(sender)`
     (main.ts:983-1000).
   - Ember's own global keys: `globalShortcut.register(... confirmer.answerKey)` (main.ts:615-619).
   `Confirmer.answer` also requires the current question's number, a known option, ≥ 500 ms since display, and that
   Ember is not driving the pointer (confirm.ts:110-117, timings 63-65). The remote protocol must never add a third
   origin.
3. **The policy engine is built once, for the local OS** (main.ts:1336-1343): `os`, `keys`, `isSecurityWindow` and
   `isTerminalApp` are the local platform's. A remote Linux desktop driven from Windows, or a Linux app under WSLg,
   would be judged with Windows' vocabulary. Then a polkit or pinentry prompt, or an xterm, passes as an ordinary app.
   **Each target needs its own engine (remote OS), or a union of vocabularies (WSLg: Linux ∪ Windows).**
4. **Identity keys don't know which machine they belong to.**
   - Grants: `grants()[r.app.toLowerCase()]` (policy.ts:2002).
   - A task's allowed apps: `allowedApps.add(req.app.toLowerCase())` (worker.ts:3175).
   - Never-look: substring match (elements.ts:440-443).
   - The cross-window carry check `elsewhere()`: same app plus same title means "same window" (policy.ts:783-792).
   - `isEmberWindow`: by pid (policy.ts:522-526).
   So "Always in gedit" given locally would cover gedit on build-01. Text read in a local "Untitled 1 - gedit" and
   typed into a remote window with the same title would not count as a move between windows. **Add `machine` to
   `ActionRequest`, `WindowId` and `ReadSource`, and key grants per machine.**
5. **A second gate on the remote.** The clone re-checks every primitive operation against the element as it is now,
   with the remote's admin policy and the remote OS's vocabulary. It refuses when the element no longer matches what
   the user approved, which closes the time-of-check/time-of-use gap of one round trip. This gate can refuse or demand
   a question. It can never approve.
6. **Privacy filters run at the source.** Never-look, withholding secret fields, capture masks and the auth-window
   refusal all run on the remote before any data leaves it. The remote sends structured, size-capped data and never
   model-ready text. Quoting and `untrusted="true"` wrapping happen locally (elements.ts:306-308, 425-426), so a
   modified clone cannot break out of the wrapper.
7. **Admin policy: both bind, and combining them only tightens.** The local policy decides whether Ember may go remote
   or into WSL, may run commands, and on which hosts. The remote's policy binds what is done on the remote machine.
   - A remote policy that exists but is broken means LOCKDOWN (admin.ts:72-81), so the clone refuses to serve.
   - The remote's `provider` and `models.allowed` cannot be honoured by a local brain. Refuse, or warn (choice).
   - In WSL, **only the Windows policy (HKLM) binds.** Root inside a distro is not an administrator boundary
     (`wsl.exe -u root` gives a root shell without a password, OS fact).
8. **Audit on both sides.**
   - Local entries are tagged with the machine.
   - The remote keeps its own 0600 log, plus journald through `journalLine` redaction (audit.ts:122-143), written
     before each operation.
   - If the remote audit can't be written, the operation is refused.
   - New events: `remote` and `command`. `journalLine` already reduces the `value` of any kind not in
     `PLAIN_VALUE_KINDS` to a size (audit.ts:113, 129), so a command's text never reaches the journal.
9. **Consent.**
   - Bumping `CONSENT_VERSION` (consent.ts:2) sends every user through onboarding again (settings.ts:205-207). It is
     right when the feature ships, because the data flows change.
   - Each host and each command target also needs its own first-use consent.
   - **The remote account may not be the local person.** Rules: act only in a GUI session owned by the SSH login's
     uid; show a visible notice on the remote screen; keep a consent record on the remote. The remote admin may require
     consent clicked at the remote console (choice).
10. **The kill switch.**
    - Local parts are unchanged, and the local side stops sending at once (`stops++`, host.ts:1172).
    - The remote part is a `stop` frame on the priority stream, with epoch fencing.
    - The < 300 ms target (PLAN.md:256) holds for the remote while one-way latency plus about 20 ms ≤ 300 ms.
    - Beyond that, the fallbacks are fixed: no `stopped` within max(1 s, 3×RTT) means the local ssh is killed, the
      remote sees EOF and stops. A dead-man stops the remote after 3 s of silence, and a freshness gate (1.5 s) bounds
      what can happen meanwhile to at most one action.
    - The borrow's < 100 ms abort (PLAN.md:257; measured 0.3-3 ms, PLAN.md:312) is the remote's own input watch. It
      protects a person at the remote screen. The local user can only take over with Stop. Tier 3 is off on remotes by
      default.
11. **The channel is the only way in.** SSH stdio only. No listening port or socket. No exec, eval or spawn-by-name
    operation. A closed, schema-checked set of operations, with size caps. The clone stops on EOF. A clone that is this
    same machine (loopback, or the same machine id) is refused, so "remote commands" can never become local commands.
12. **WSL GUI today is a gap, before any WSL work.** WSLg windows are owned by `msrdc.exe`, so every Linux app reports
    as app `msrdc`, and `isTerminalApp("msrdc")` is false (`wsl.md` §0.1). An unidentified RAIL window must get no
    action at any tier. "In WSL" in the user's words is refused today as a terminal request, because `TERMINAL_WIN32`
    contains `wsl` (vocabulary.ts:242, 259; host.ts:880-885).
13. **Commands are a separate capability, not a loosened terminal rule.**
    - The GUI refusals stay exactly as they are (policy.ts:1960-1963, 1964-1966, 1974-1978).
    - New: a `run_command` tool and a `policy/commands.ts` decision function. Targets are only `wsl:<distro>` or
      `ssh:<alias>`.
    - Every command is shown in full and confirmed every time, with no "Always" and no grants.
    - Secrets: the model may not send input while the terminal has echo off, and output from those spans is withheld.
    - Programs that persist or escape are refused (`nohup`, `setsid`, `&`, `crontab`, `systemd-run`, nested `ssh`), so
      the kill switch can always reach what Ember started.
14. **A WSL command is not contained.** WSL interop runs Windows `.exe` files, and `/mnt/c` exposes the user's Windows
    files (OS fact). A WSL command therefore has the user's full Windows rights. It could even run `powershell.exe` to
    decrypt Ember's DPAPI-sealed token. "Local commands stay forbidden" then rests on classification and the user's
    click, not on a sandbox. That must be said plainly to the owner. Mitigation options are in §5.6.

---

## 1. Scope, decisions and trust model

### 1.1 What is being changed

| Capability | Owner's decision (`decisions.md`) | Rule it touches |
|---|---|---|
| WSL GUI | See and act in WSLg Linux apps, launch them, work with WSL files | None: same rules, new routing |
| WSL shell | Commands in a WSL distro shell, in a visible terminal, confirmed every time, secrets never to the model | Lifts "never runs commands / never acts in terminals" **for WSL distro shells only** |
| SSH desktop | Act on the remote's logged-in desktop through the existing backends | None: same rules, on another machine |
| SSH shell | Commands on the remote, confirmed on the local PC every time; headless servers allowed (commands only) | Lifts the same rule **for the remote SSH shell only** |
| SSH brain | **Local.** Copilot sessions, presenter, Confirmer, voice and TTS stay on the PC. The clone is eyes, hands and command runner. No token and nothing Copilot-related on the remote | Token storage, consent text, audit placement |

What stays forbidden, unchanged:
- local commands;
- the user's own terminals (local GUI, and the remote's and WSLg's terminal windows);
- local programs being run;
- password fields and authentication windows, anywhere;
- goals that don't come from the user.

### 1.2 Actors and trust boundaries

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Local user (at the PC) | Goals, approvals, consent, stop | n/a |
| Local Ember main process (policy, Confirmer, audit, kill switch) | Everything: it is the trusted computing base today | n/a |
| The model (conductor, workers) | Proposing steps | Goals; approvals; choosing hosts; anything secret. It sees only Ember's tools (session-config.ts:25-46, verified at 70-82) |
| Screen text and command output (local, remote, WSL) | Nothing | Instructions. Always quoted and wrapped untrusted |
| Remote clone (Ember's code on the remote, user-writable install) | Faithful reporting and execution **only as far as the remote machine is trustworthy** | Answers, settings, local actions, model-ready text |
| Remote root, or a process with the remote user's uid | Owns the remote machine: can read or alter anything there, including the clone | Anything on the local PC |
| A person at the remote screen | Stopping Ember there | Approving (approvals are only the local user's) |
| WSL distro (root reachable by the Windows user without a password) | As much as the Windows user | Admin policy (its `/etc/ember/policy.json` is not an admin boundary) |

### 1.3 Threats this spec closes (and the ones it can't)

Closed by design:
- T1, forged approvals from the remote or from screen text.
- T2, a remote that keeps acting after the link drops or after Stop.
- T3, data from never-look or secret fields leaving the remote.
- T4, local data carried to the remote without a question.
- T5, privileges taken from local settings (grants, never-look) on another machine.
- T6, the remote channel used by other processes.
- T7, token exposure.
- T8, commands persisting beyond the kill switch.
- T9, the model typing secrets into a shell.
- T10, prompt injection through command output.
- T11, Ember acting on another person's desktop.

Not closable (stated to the owner):
- U1. Remote root (or the same remote uid) can lie to the clone, watch everything Ember does there and alter the clone.
  The remote's admin policy therefore binds an honest clone, not a hostile remote user (`install-transport.md` §12).
- U2. An action already done (a deleted file, a sent message, a finished `rm`) is not undone by Stop.
- U3. WSL commands reach Windows through interop and `/mnt/c` unless the owner disables those (§5.6).
- U4. Static classification of shell text can be evaded. The user's verbatim view and click is the last line, and
  wording says when Ember can't tell what a command does.

---

## 2. Today's mechanisms (inventory)

| # | Mechanism | Where (code) | What it guarantees |
|---|---|---|---|
| M1 | `PolicyEngine.decide` / `recheck` | policy.ts:1720-1727 → `judge` 1729-1765 → `decideBase` 1947-2012 | Deterministic verdict per structured request; model text never decides |
| M2 | "Never" list | policy.ts:1953 (never-look), 1956 (auth/security windows), 1958 (Ember's windows), 1959 (password text), 1960 (terminal element), 1961 (open a terminal), 1963 (act in a terminal or app with a shell), 1964-1966 (runs a program), 1967-1969 (secret or payment field), 1971-1973 (box that runs typed text), 1974-1978 (unknown or system keys), 1981 (admin: no actions) | Refused whatever the user or model says |
| M3 | Confirm tiers | policy.ts:1987-1992 (desk), 1995-1997 (borrowed cursor every time), 2002-2011 (grants), 1759-1763 (admin: confirm every action), 1743-1757 (unasked steps flagged) | Risky steps need a click; prompt built from the request, "never model text" (policy.ts:139-140) |
| M4 | Rate limit | policy.ts:1983, 2015-2021 (40/min default, admin can lower: admin.ts:41) | Bounded action rate |
| M5 | Worker gate | worker.ts:3111-3182: `decide` 3134, taint 3139-3146, ask 3166, "always" only with `remember` 3160, 3169-3171, audit 3101-3104 and 3157/3167 | Every tool action is decided, logged, and confirmed when needed |
| M6 | Confirmer | confirm.ts:46-175: timeout 120 s (63), arm 500 ms (64), gap 700 ms (65), `blocked` (67, 114), `answer` guards (110-117), `answerKey` (120-125), `cancelAll` (127-132), `guardWhileAsking` (182-191) | One question at a time; no accidental, borrowed or voice approval |
| M7 | Approval origins | main.ts:983-1000 (bubble IPC, `owns(sender)`, ignores everything but task Stop while Ember drives, 989); main.ts:610-621 (Ctrl+Alt+Y/N; "Always" is click-only, 606-609); `blocked` wiring main.ts:1280 | Only the local user's click or keys |
| M8 | Never-look | elements.ts:440-443; perception/index.ts:126, 141-146 (sidecar told to skip), 464-486 (capture masks), 621-627; defaults never-look.ts:15-19 | Private apps never read or captured |
| M9 | Secret fields | policy.ts:406, 528, 1967-1969; elements.ts:139-149, 297-302 (`insideSecrets`), perception/index.ts:309-312 (context never shows a secret field's text) | Never typed into; contents never shown |
| M10 | Auth windows | policy.ts:413-418 + vocabulary.ts:43-58 (`SECURITY_APP`), `SECURITY_TITLE`, `SECURITY_CLASS` | Ember stays out of credential prompts |
| M11 | Terminal refusal | terminals.ts:37-58 (`TERMINALS`), 62-67 (`SHELLS`), 185-192 (`REFUSED` never-start list incl. `ssh`, `wslg`); policy.ts:1960-1963; host.ts:878-885 with `TERMINAL_REQUEST` vocabulary.ts:257-261 | No terminals, no commands, no "do it in another app instead" |
| M12 | Untrusted wrapping | elements.ts:306-308 (quote escapes `<`), 425-426 (`<screen ... untrusted="true">`); perception/index.ts:302, 321; worker.ts:958, 1178, 1705; conductor.ts:111, 132, 469; persona.ts:35 (goals only from the user) | Screen text is data, never instructions |
| M13 | Audit | audit.ts:21-71 (dir 0700 line 23, file 0600 line 37, prune 62-71), journald copy 92-110, journal redaction 122-143; Windows: file only (win32/system/index.ts:65); worker `auditValue` keeps typed text as a length (worker.ts:3185-3189) | A record of every decision, question and action |
| M14 | Admin policy | admin.ts:19-59 (strict schema), 72-81 (LOCKDOWN), 88-97 (parse fails closed), 105-122 (root-owned check), 125-138 (only tightens), dev override only unpackaged (main.ts:58, 190); Windows HKLM (win32/system/admin-policy.ts:15-19) | The administrator can only make Ember stricter; a broken policy locks it down |
| M15 | Consent | consent.ts:2; settings.ts:70, 205-207, 337; gates main.ts:680-708, 883, 892, 1420, 1467; text index.html:29-35 (onboarding) and 92 (voice) | Nothing read, heard or sent before consent |
| M16 | Kill switch | killswitch.ts:19-43 (parallel parts, 300 ms race at 37, audited at 41); parts main.ts:731-740; triggers main.ts:500, 846, 1217; `abortAll` host.ts:1171-1182 | Everything stops in < 300 ms (PLAN.md:256) |
| M17 | Borrow takeover | borrow.ts:1-12, `check()` 262-276 every `STEP_MS = 8` (102); target checks 279-296 | User input aborts within < 100 ms (PLAN.md:257) |
| M18 | Tokens | auth.ts:29-75 (safeStorage, 0600, no plaintext fallback 33-35), 91-102 (order); runtime gets it via the SDK (host.ts:690); helpers get scrubbed env (compose.ts:44 `SECRET`, 56; system.ts:452-464 `KEEP`/`NEVER`) | Token encrypted at rest, never in helpers' env |
| M19 | SDK hardening and network | session-config.ts:25-46 (no built-ins; refuse ungranted tools), 70-82 (fail closed); worker.ts:1146 (permission requests rejected); main.ts:309-312 (no page opens windows or navigates); host.ts:954-980 (runtime talks only to GitHub or the admin's endpoint); onboarding "sends no usage statistics" (index.html:33); voice "audio never leaves" (engine.ts:1-3) | No tools beyond Ember's; no telemetry; audio local |

---

## 3. SSH: the remote agent (brain local, clone = eyes + hands + runner)

### 3.1 Where each mechanism runs

| Mechanism | Local PC | Remote clone | Why |
|---|---|---|---|
| M1/M3 policy decision (verdict, prompt, risky, aligned) | **Yes: gate 1**, one engine per target with the remote OS's vocabulary and the combined policy | Gate 2: "never" checks and element match only (§3.3) | The question must be built where the user is; the facts are freshest where the screen is |
| M2 never-list | Yes (gate 1) | **Yes (gate 2)**, the authority on facts | A stale or lying report locally is caught remotely, and vice versa |
| M5 worker gate, taint, alignment | Yes | No | It needs the user's words (`goal`, `agreed`), which stay local |
| M6/M7 Confirmer and approval origins | **Only here** | Never | §3.2 |
| M8/M9/M10 privacy filters | Re-applied (defence in depth) | **First, at the source** | Pixels and text from private windows never cross the wire |
| M11 terminal refusal (GUI) | Yes (remote OS vocabulary) | Yes | Remote terminals are refused like local ones |
| M12 untrusted wrapping | **Only here** | Sends structured data only | The wrapper must be produced by trusted code |
| M13 audit | Yes (`machine` tag) | **Yes (own log)** | The user's record and the remote admin's record |
| M14 admin policy | Local policy + combined remote constraints | Remote policy enforced in gate 2 | Both bind |
| M15 consent | Global + per-host | Remote consent record (+ console consent if required) | The remote account may be someone else |
| M16 kill switch | Origin (hotkey, voice, menu) | Remote part + dead-man + console Stop | §3.8 |
| M17 borrow takeover | n/a | Remote input watch | The person at the remote screen |
| M18 tokens | Only here | None present | §3.10 |

### 3.2 Confirmations: answered only by the local user, unforgeable by the remote or the screen

**Rule C1. There is no protocol message that answers a question.** With the brain local, questions are asked by the
local worker (`confirmer.ask`, worker.ts:3166, 2378) and answered by M7's two origins. The remote protocol's local
receiver must:
- accept only display and data kinds: perception results, operation results, command output, status, `stopped`,
  `lost`, the remote console's `stop`;
- never forward anything to `confirmer.answer` or `answerKey`;
- never forward to `OVERLAY.bubbleAction`;
- never set bubble `actions`;
- strip any string shaped like `q<n>:` from remote-supplied data before display. Belt and braces: remote strings are
  only ever shown as quoted text, never as action ids.

This matches `agent-ui-split.md` §9.3, origin rules on the local side.

**Rule C2. A remote message can only add questions, never remove one.** Gate 2 may answer `needs_confirm` (§3.3).
Local then asks the user and resends with an approval reference. To prevent approval fatigue, a hostile remote's
re-asks count toward the task's rate limit (policy.ts:1983). After 3 `needs_confirm` replies for operations local
judged `allow`, the task stops with "build-01 keeps asking for confirmation; stopped".

**Rule C3. The prompt is local and names the machine from local data.**
- `Decision.prompt` is built from the request (policy.ts:139-140, `describe` 1441-1473). Remote strings inside it
  (element name, window title, dialog text) are quoted as today.
- Add a machine badge to `Question` (confirm.ts:18-26, new field `machine?: string`), drawn by the overlay from the
  connection record: the host alias the user picked plus the remote login, e.g. "build-01 (deploy)". Never from a name
  the remote reports.
- The spoken question (main.ts:639-642) starts "On build-01, Ember asks: …".
- A question for a remote action is never phrased like a local one.

**Rule C4. Time of check and time of use, across a round trip.**
- The approved operation carries what the user saw: `expect: {app, window, role, name, value-hash}`.
- Gate 2 re-reads the element just before acting and refuses with `changed` when it doesn't match. This is the remote
  equivalent of "the element as it is now" (worker.ts:1545) and of `recheck` (policy.ts:1725-1727).
- On `changed`, the local worker re-decides. A new question is asked if needed; the old approval is never reused.

**Rule C5. Approval references are for the record, not a security boundary.**
- Each confirmed operation carries `approval: {q: <n>, answer: "once", at}`. Gate 2 refuses operations that need one
  but lack it: kinds `cursor_*`, `keys` and `scroll` (always confirmed: policy.ts:1995-1997), `command`, and anything
  the combined policy marks `confirmEveryAction`. This catches local bugs.
- It is **not** cryptographic, and it shouldn't pretend to be. The Confirmer and the code that sends the operation are
  the same trusted local process. A signature made by that process proves nothing extra. The model cannot reach the
  channel at all: it only calls worker tools, which go through `authorize`.

**Rule C6. Voice never approves (confirm.ts:3-4). Unchanged.** There is no audio path to the remote, so no remote voice
path exists to change this.

**Rule C7. Never "Always" for remote steps by default (choice).**
- If the owner allows it, the grant is keyed `ssh:<alias>:<app>` (§3.4), shown "Always in gedit on build-01", and
  disabled when either policy says `allowGrants: false` (admin.ts:38-39).
- Commands never get "Always" (§5.4).

**Rule C8. A person at the remote screen cannot approve.** They can stop (§3.8) and take over a borrow (M17). The
question appears only on the local PC.

**Rule C9. Tasks are bound to one machine.** A task's target is fixed at `start_task`. It must be the active target
the user chose (the handle shows it) or one the user named in their own words, checked deterministically like
`TERMINAL_REQUEST` (host.ts:878-885). The model can never pick a host from screen text or from remote content.
Cross-machine tasks are refused in v1. Moving data between machines goes through `withCarried` (§3.4) and is always
asked.

### 3.3 The policy engine per target, and gate 2 on the remote

**Gate 1 (local)** is a `PolicyEngine` per connected target, built like main.ts:1336-1343 but with:
- `os`, `keys`: the remote's OS and `KEYS[os]`. A macOS remote uses ⌘ for "mod"; `isSystemKey` uses the remote OS's
  system keys (policy.ts:613-628).
- `isSecurityWindow`: the remote OS's `SECURITY_APP` / `SECURITY_TITLE` / `SECURITY_CLASS` (policy.ts:413-418). Data
  only, already keyed by OS.
- `isTerminalApp`: the remote OS's `TERMINALS`, `SHELLS` and built-in-shell rows (terminals.ts), judged on the
  identity the remote reports (program name, desktop id).
- `neverLook`: union of the local user's list, the local admin's list, the remote admin's list, and
  `NEVER_LOOK_DEFAULTS[remoteOS]` (never-look.ts:15-19). Union only tightens.
- `grants`: the per-machine slice (§3.4).
- `actionsAllowed`, `confirmEveryAction`, `allowGrants`, `rateLimit`: the combined policy (§3.6).
- `ownPid`: an impossible pid (−1), so no remote window is mistaken for Ember's own by pid (policy.ts:523). The
  remote's own notice window is caught by gate 2 with the clone's pid.

**Gate 2 (remote)** runs inside the clone, before every primitive operation:
1. The freshness gate (§3.8): the last frame from local is under 1.5 s old.
2. The stop epoch is current (§3.8).
3. Re-read the target element (role, name, `secret`, `withheld`, window app and title, dialog).
4. Run the never checks of `decideBase` (policy.ts:1953-1979) with the **remote** admin policy, the remote OS
   vocabulary and the remote's own pid. That is the same code: `PolicyEngine` is plain Node (`agent-ui-split.md` §0.1).
5. Check the `expect` match (C4), and the approval reference where required (C5).
6. Write the audit entry (§3.7), then act.

Gate 2 returns `ok | deny(reason) | needs_confirm(reason) | changed | stale | stopped`. It never returns "approved".

Why two gates: gate 1 has the user's words (alignment, taint, `agreed`; worker.ts:3134-3146), which must never leave
the PC. Gate 2 has the true screen state and the remote admin's rules, which a modified local or a stale report could
miss. Their union refuses more than either alone; neither can loosen the other.

### 3.4 Machine-aware identities (closing finding 4)

| Key | Today | Change |
|---|---|---|
| Grants | `grants()[app]` (policy.ts:2002) | `grants()[machineKey(target, app)]`, where `machineKey` is `app` for local, `ssh:<alias>:<app>` and `wsl:<distro>:<app>` otherwise. Settings shows them grouped per machine |
| Session-allowed apps | `allowedApps` by app (worker.ts:3175) | Key with the machine (tasks are single-machine, so this is belt and braces) |
| `ActionRequest` | No machine | Add `machine?: string` ("local" when absent). `describe()` and `Decision.prompt` add "on <alias>" for non-local |
| `WindowId` / `ReadSource` | pid + path | Add `machine`. `elsewhere()` (policy.ts:783-792): a different machine is always elsewhere, before any pid, path or title test. Text read locally and typed remotely (or the reverse) is then always asked about, naming both ("I read Mousepad on this PC in this task…") |
| Never-look | Substring of "app title" | Unchanged matcher; the remote's list is the union (§3.3). A user entry like `build-01` hides that whole machine's windows only if the remote identity string includes the alias, so add `machine` to the matched haystack |
| Clipboard | The local clipboard is used for pasting (`Hands.clipboard`, host.ts:50) | Never synchronise clipboards. Remote pastes use the remote's clipboard through the clone. The local clipboard never crosses |
| Audit | No machine | `machine` on every entry |

### 3.5 Never-look, secret fields, authentication windows and Ember's windows on the remote

- **Never-look at the source.** The clone runs the same `Perception` filters before replying:
  - the sidecar gets `neverLook` and `skipPids` (perception/index.ts:141-146);
  - window lists drop private windows (621-627);
  - captures are masked (464-486).
  The combined list (§3.3) is sent to the clone in `hello`. The clone also adds the remote admin's list itself, so a
  local bug can't drop it.
- **Secret fields.** The sidecar withholds secret contents (`insideSecrets`, elements.ts:297-302; `withheld`). Gate 2
  refuses typing into them (policy.ts:1967-1969). The text never crosses.
- **Authentication windows.** Polkit, pinentry, ssh-askpass and the GNOME Shell prompt (vocabulary.ts:44); UAC,
  credential UI and LogonUI on a Windows remote (45-51); SecurityAgent and loginwindow on macOS (52-58). All are
  refused by both gates. A locked remote screen is a security window, so no action is taken and no task starts
  (`remote-desktop.md` §7 S3).
- **Ember's windows.**
  - Locally, unchanged.
  - The remote notice window (§3.9) belongs to the clone's pid: gate 2 refuses acting in it (`isEmberWindow` with the
    clone's pid, policy.ts:522-526).
  - If a full Ember also runs on the remote for its own user, its windows are Ember windows there too (EMBER_WINDOW
    titles, policy.ts:516).

### 3.6 Admin policy: which binds (both), and how they combine

**Local policy** (the PC's file, or HKLM) decides whether this Ember may reach out at all. Proposed keys:

```
features.remote: boolean      // false: no SSH connections (no clone install, no serve)
features.wsl: boolean         // false: no WSL sidecar, no WSLg actions
features.commands: boolean    // false: no run_command anywhere
remote.allowedHosts: string[] // globs over the resolved "user@host:port" (ssh -G), not the alias the user typed
remote.desktop: boolean       // false: commands only on remotes (no remote GUI)
commands.targets: ("wsl"|"ssh")[]
commands.deny: string[]       // program names always refused (adds to Ember's list)
commands.allowOnly: string[]  // when present, only these programs (narrows)
commands.maxPerTask: number   // ≤ Ember's own cap
```

Every key can only switch things off or narrow them. The `.strict()` schema (admin.ts:59) means an older Ember that
reads a policy with these keys locks down (admin.ts:88-97). That is safe but disruptive, so ship the schema before
admins can use the keys, and document it.

**Remote policy** (the remote's `/etc/ember/policy.json` with the root-owner check, admin.ts:105-122; macOS
`/Library/Application Support/Ember/policy.json`; Windows HKLM) is loaded by the clone with the same code and sent in
`welcome`. Local combines the two (pure function `combineAdminPolicy(local, remote)` in admin.ts, property-tested to
never loosen either input):

| Field | Combined |
|---|---|
| `features.*` | AND (a `false` on either side wins) |
| `neverLook` | union |
| `confirmEveryAction` | OR |
| `allowGrants` | AND |
| `maxActionsPerMinute` | min |
| `auditRetentionDays` | each side keeps its own log by its own value |
| `features.screenImages: false` (remote) | no screenshot of the remote goes to the model; tier 1 text only |
| `features.cursor` / `features.desk` (remote) | no tier 3 or tier 2 there |
| `features.voice` / `features.speak` (remote) | not applicable: voice and speech happen on the PC under the local policy. Shown in the connection details so the remote admin's intent is visible |
| `models.allowed`, `models.*`, `provider` (remote) | **Cannot be honoured by a local brain**: they say where that machine's data may go. Options (choice): (a) refuse to connect when the remote names a `provider` or a `models.allowed` the local brain doesn't satisfy (recommended, fail closed); (b) connect read-nothing (commands' output and screen text never sent), which is useless; (c) warn and connect, which overrides the remote admin and is not recommended |

New remote-only keys the clone enforces itself:
- `remote.allowClone: false`: the clone refuses to serve ("This machine's administrator doesn't allow Ember here").
- `remote.requireConsoleConsent: true`: §3.9.
- `remote.allowFrom: string[]`: globs over the connecting machine's reported name. Advisory, since the local side
  reports it.

**Failure modes:**
- Remote policy exists but is unreadable or invalid → LOCKDOWN on the remote. Recommended: the clone **refuses to
  serve** with the reason, stronger than the local LOCKDOWN, which still allows reading.
- No remote policy → the remote's defaults, i.e. no extra tightening. Whether a remote with no policy may be used at
  all is an owner choice (`remote-desktop.md` §7 S6). A local `remote.allowedHosts` covers the enterprise case.

**How strong the remote policy is:**
- A clone in the user's home binds an honest install only. The user can edit it (U1; `install-transport.md` §12).
- A remote admin who needs enforcement installs the clone root-owned (`/opt/ember-remote`) and uses OS controls.
- The PC's own policy is as strong as today's.

### 3.7 Audit on both sides

**Local** (the existing `AuditLog`, audit.ts):
- Every entry for a remote operation adds `machine: "<alias>"`, `remoteUser`, and `op: "<conn>:<task>:<n>"` for
  correlation.
- New events (extend `AuditEntry.event`, audit.ts:15):
  - `remote`, with `step` = `connect | install | update | serve | stop | lost | disconnect | refused`;
  - `command` (§5.4).
- Confirm entries record the machine (worker.ts:3167).
- The activity timeline shows the machine badge.

**Remote** (the same `AuditLog` class in the clone):
- Directory `~/.local/state/ember-remote/audit` (0700; files 0600; audit.ts:23, 37), or `/var/log/ember-remote/<user>`
  for a root-owned install.
- journald copy when available (`journalSink`, audit.ts:92-110), always through `journalLine` (122-143), so goals, titles
  and values go to the journal as sizes only.
- Retention is the remote admin's `auditRetentionDays` (audit.ts:62).
- Entries carry `from` (the connecting machine's name as reported, marked unverified), the local `op` id, and the
  approval reference.
- **Write-ahead:** gate 2 writes `{event:"action", phase:"start"}` before acting and `phase:"done"`/`"failed"` after.
  If the write throws, the operation is refused (fail closed). Today a throwing `audit.write` aborts the tool, because
  the worker writes the decision before acting (worker.ts:3157); keep that property explicitly on the remote.
- **Never logged on either side:**
  - frame payloads in the debug logs;
  - typed text, except as a length (`auditValue`, worker.ts:3185-3189);
  - SSH credentials;
  - anything typed while a terminal had echo off (§5.4).
- The remote audit is the remote admin's record, so the local Ember never deletes or rewrites it. Uninstalling the
  clone leaves it in place (choice: or offers to remove it, with the remote user's click).

### 3.8 Kill switch and borrow abort across the link

**Today:** `KillSwitch.pull` runs all parts in parallel and returns after all of them or after 300 ms (killswitch.ts:37).
`abortAll` drops queued requests, cancels tasks and questions, and aborts the conductor (host.ts:1171-1182). Workers
check `isOver` before every send (worker.ts:862, 925-931).

**Remote design:**

1. **The local side stops issuing first.**
   - `stopEverything` → `abortAll` increments `stops` (host.ts:1172) and cancels every task. Worker tools return
     `STOPPED()`.
   - The remote connection object holds a `stopEpoch`, incremented synchronously in the same pull, **before** anything
     is awaited.
   - From that moment no new operation is sent. Cost: about 0 ms, independent of the network.
2. **The remote part:** a `StopPart` per live connection, `{name: "remote:<alias>", stop: () => conn.stop()}`, added
   to main.ts:731-740.
   - `conn.stop()` writes `{t:"stop", epoch}` on the control stream, which has strict priority over bulk
     (`install-transport.md` §10.3), and resolves on `{t:"stopped", epoch}`.
   - If the ack is later than the 300 ms race, the part is reported in `late` (killswitch.ts:38-40) and the audit says
     so.
3. **On the remote, `stop`:**
   - runs the clone's own `KillSwitch` (the same class) with parts `borrow` (`CursorBorrow.stop`, immediate), `ops`
     (drop the queue and refuse in-flight operations at their next check), `commands` (§5.4: SIGINT to the process
     group, SIGTERM at +300 ms, SIGKILL at +1 s, or stop the transient scope), `desk` (hand back), and `sidecar` (cancel
     reads);
   - records `stopEpoch`, so any operation frame with an older epoch is refused (`stopped`). This is **epoch
     fencing**: an operation sent just before the stop on another stream can't run after it;
   - audits `{event:"stop", source:"local", ms}`.
4. **Budget.** Remote stopped at T + one-way latency + about 20 ms of processing.
   - With RTT ≤ 500 ms (one way ≤ 250 ms), the remote stops within PLAN's 300 ms.
   - Beyond that, the honest SLO is "nothing new is sent at once; the remote stops within one-way latency + 20 ms;
     whatever was mid-execution finishes its current primitive (a click, a key) or is signalled (a command)". The
     settings window shows the measured RTT per connection.
5. **Escalation:** no `stopped` within max(1 s, 3 × RTT) → kill the local `ssh` process. TCP closes, sshd closes the
   channel, the clone sees stdin EOF and runs the same stop, then exits (`install-transport.md` §9.2, §10.3).
6. **Fail safe when the channel drops** (Wi-Fi off, laptop lid, VPN drop):
   - PING every 1 s each way.
   - **Dead-man:** no frame from local for 3 s → the remote stops everything and exits (no grace by default; G1 grace
     is a choice, `install-transport.md` §9.2).
   - **Freshness gate:** an operation runs only if the last local frame arrived < 1.5 s ago. That bounds the
     link-lost window to at most one primitive. A running command lives until the dead-man, at most 3 s, then gets the
     signal ladder.
   - A watchdog thread kills the clone if its main loop stalls for > 2 s (`install-transport.md` §9.2).
   - No `nohup`, daemon or `setsid` for the clone, ever: a clone that survives the link is an agent nobody can see or
     stop.
7. **Local side on loss:**
   - tasks on that target are marked stopped;
   - their open questions resolve `null` through the task's `overSignal` (confirm.ts:76-84);
   - the handle shows "Lost build-01";
   - the audit says `remote/lost`.
   A reconnect gets a new connection id; no task resumes, and no approval carries over (`install-transport.md` §10.5).
8. **Stop from the remote side.** A person at the remote screen can stop through the remote notice (§3.9: a Stop button,
   or a key grab on the remote's Ctrl+Alt+X where the clone can grab keys, `remote-desktop.md` §7 S2).
   - The clone stops locally first, then tells local `{t:"stop", source:"remote-console"}`.
   - Local cancels that target's tasks, shows "Stopped on build-01 by someone there", and audits it.
   - Add `"remote-console"` and `"remote-lost"` to `StopSource` (killswitch.ts:17).
9. **Every local trigger stops every target:** Ctrl+Alt+X (main.ts:1217), "Ember, stop" (main.ts:846; spotted by the
   local voice process, engine.ts:1-3) and the menu (main.ts:500). Per-target stop lives in the task card (Stop on a
   card cancels that task only, main.ts:994-995).

**Borrow abort < 100 ms on a remote.**
- The takeover watch (`check()`, borrow.ts:262-276) runs in the clone against the remote's input devices. It protects a
  person at the remote screen within the same budget, because it is local to that machine.
- The local user's mouse is not the remote's. If they watch through a remote-desktop viewer (VNC or RDP) their input
  becomes remote input and aborts the borrow; otherwise their takeover is Stop, bounded by §3.8.
- Hence: **tier 3 on a remote is off by default.** It is allowed only while a masked remote view is open, still
  confirmed every time (policy.ts:1995-1997; `remote-desktop.md` §7 S1, S9). The admin can force it off
  (`features.cursor` combined).
- Tier 2 (a desk on the remote) keeps its existing rules (policy.ts:1987-1992). The desk's raw snapshot path must not be
  streamed unmasked (`remote-desktop.md` §7 S1).

### 3.9 Consent: local, per host, and the remote account

**Local, global.** The onboarding list (index.html:29-35) and the voice text (index.html:92) promise:
- "It reads the window you're working in";
- "your request and what Ember read go to GitHub Copilot";
- "It asks before acting … It never types passwords";
- "On this computer it keeps … a record of every action … sends no usage statistics";
- "no audio leaves it … only that text is sent to Copilot".

With the brain local:
- voice and request text still go only to Copilot;
- the remote receives only steps: element ids, values to type, commands, all of them approved per §3.2;
- data now also flows **from** another machine to Copilot.
That is a change in "what Ember does with the screen or data" (consent.ts:1), so `CONSENT_VERSION` → 2 when the
feature ships. The cost: every user goes through onboarding again (settings.ts:205-207; main.ts:680 gates).

Alternative (choice): leave the global version alone until the user first enables SSH, WSL or commands, and gate those
features on feature consents. This spec recommends both: bump on release, plus feature consents. Proposed new
onboarding line: "**Other computers**: if you connect Ember to a computer over SSH or to WSL, it reads and acts there
the same way, asks you here before anything hard to undo, and that computer keeps its own record. It runs commands
there only if you turn that on, and you approve each one."

**Per host (first connect), local, a click:**
- "Ember will read and act on build-01's desktop as deploy. What it reads there goes to GitHub Copilot from this PC.
  Your voice stays on this PC. build-01 keeps its own record. About 40 MB goes into ~/.local/share/ember-remote."
- Stored per resolved destination, with the consent version.
- A host whose `ssh -G` resolution changes (a new HostName or User) is asked again.

**The remote account may not be the local person.** For example, Alice SSHes into Bob's desktop with Bob's password, or
into a shared `deploy` account.
- **R1 (code-enforced, not a choice).** Act only in a GUI session whose owner uid equals the SSH login's uid. No root,
  no `xhost`, no other user's cookie, no SYSTEM (`remote-desktop.md` §2.2 P1). Otherwise commands only, if enabled.
- **R2 (code-enforced).** While connected, a visible notice on the remote screen names the connecting machine and says
  whether Ember is reading or acting ("Ember on ALICE-PC is using this screen"). It has a Stop. If the notice can't be
  shown, no reading and no acting on that desktop.
- **R3, the remote consent record (choice of strength):**
  - (a) Authenticating as the account counts as consent. The record in `~/.config/ember-remote/consent.json` holds the
    consent version, the connecting machine's name and the date. A connection from a machine not in the record shows
    the local per-host consent again.
  - (b) Console consent: a dialog on the remote screen that a person there must click before the first read in a GUI
    session. Required when the remote admin sets `remote.requireConsoleConsent`. Recommended by default when the
    remote session had local input in the last 5 minutes, meaning someone is probably there. An unattended screen
    falls back to (a).
  - (c) Never act on a remote desktop with recent console input. Safest; breaks "help me on my office PC while a
    colleague watches".
- A locked remote session is a security window: nothing is read or done until it is unlocked by someone at it.
- **Headless or commands-only:** per-host consent plus the commands consent (§5.4).

### 3.10 Channel, clone hardening, tokens and network

**Only the authenticated channel commands the clone:**
- Transport: the stdio of the `ssh -T` session that local started (`install-transport.md` §2.2, §9-10).
  - The clone opens **no listening TCP port, no Unix socket, no named pipe**.
  - Its single-instance lock is a file in a 0700 directory, never a socket (`install-transport.md` §9.3).
- **Closed operation set**, zod-validated, with size caps (control ≤ 64 KB). Operations: `list_windows`, `read_window`,
  `at_point`, `capture(masked)`, `act(kind, element, value, expect, approval, epoch)`, `launch(appId)`,
  `run_command(...)` (§5), `stop`, `ping`.
  - No exec, eval, `require` or spawn-by-name. No file read or write operation (file work happens through apps, or
    commands if enabled).
  - An unknown operation or a malformed frame triggers a protocol error, a stop and an exit.
- `hello` / `welcome` carry the protocol version and capabilities. A clone of another version is updated or refused,
  never driven.
- Start-up hygiene (`install-transport.md` §9.1):
  - refuse `NODE_OPTIONS`, `NODE_PATH` and `NODE_DEBUG`; `--disable-sigusr1`;
  - no dev overrides (mirror `devEnv`, main.ts:58: a packaged clone ignores `EMBER_*` except the log level);
  - nothing secret or user-supplied on argv (`/proc/<pid>/cmdline` is world-readable; auditd logs `execve`);
  - stop on stdin EOF.
- **Never the same machine.** `welcome` carries the remote's machine id (Linux `/etc/machine-id`, Windows
  `MachineGuid`, macOS `IOPlatformUUID`, read by the clone). If it equals the local one, local refuses: "build-01 is this
  computer". So does a destination resolving to loopback. Without this, `ssh localhost` would turn remote commands into
  local commands. (WSL's own sshd reached from Windows has a different machine id, but see §5.6.)
- **ssh options:** no agent forwarding, no X11, no forwardings, no `LocalCommand`, strict host-key checking
  (`install-transport.md` §2.2). `ForwardAgent=no` matters for commands: a forwarded agent would let remote commands use
  the user's keys to hop on.
- **Remote to local is data only** (C1). The local side never opens URLs, files or windows, changes settings (beyond
  displaying the remote's state), or speaks remote-supplied text except inside model output or a question built
  locally.

**Tokens and secrets:**
- **The GitHub token never leaves the PC** (decision 3). It stays in safeStorage (auth.ts:29-75), and the runtime gets
  it through the SDK (host.ts:690).
- Ember's `ssh` and `wsl.exe` children get scrubbed environments: `cleanEnv` / the `SECRET` rule (compose.ts:44, 56) and
  `appEnv`'s `NEVER` rule (system.ts:456).
  - `SSH_AUTH_SOCK` is kept **only** for Ember's own `ssh` process, so the user's agent can authenticate the
    connection. It is never forwarded.
  - `WSLENV` is cleared for `wsl.exe`, so no Windows variable is shared into the distro.
- SSH prompts (passwords, passphrases, OTP, host keys) go to Ember's own prompt window. The user answers; the model
  never sees them; they are never logged (`install-transport.md` §2.4, §11).
- A BYOK provider key (admin.ts:152-155) is local only and never forwarded.
- Remote secrets (the remote's credential helpers, keys, tokens) are never read by Ember's own code. Commands that would
  read them are refused (§5.4).

**Network and telemetry:**
- The clone makes **no network connections**. A build check fails the bundle if it imports `http`, `https`, `net`
  (beyond the stdio framing), `dgram`, `tls` or `fetch`.
- No telemetry on either side. The onboarding promise (index.html:33) extends to the clone.
- Commands are the only remote network use, and they are classified (§5.4).

### 3.11 If the brain were ever moved to the remote (variant R, not chosen)

Recorded for completeness (`agent-ui-split.md` §4). What would change for safety:
- the token goes to the remote, in memory only;
- the Confirmer stays local, with answers sent back as `confirm.answer{q,id}` accepted only for the one question the
  remote asked;
- the remote's admin `provider` and `models` would bind naturally;
- audio still stays local.

The token's exposure on the remote (`/proc/<pid>/environ`, same uid, root, swap; `install-transport.md` §0.5, §11) is
the main cost. The decision to keep the brain local removes it.

---

## 4. WSL: Linux GUI apps (WSLg)

Same rules, through the in-distro AT-SPI sidecar (`wsl.md` §4) and a WSLg window identity (`wsl.md` §6.1). The safety
deltas:

| Mechanism | WSLg change | Where |
|---|---|---|
| Identity | `app = "wsl:<distro>:<linux app>"`, the Linux program from `/proc/<pid>/comm`; `pid = null` towards Windows code; Linux pids never sent to Windows code and the reverse (`wsl.md` §6.3) | perception routing (new) |
| **Unidentified RAIL window** | **No action at any tier**; title-only reading with both vocabularies; masked in captures when the never-look list is non-empty (`wsl.md` §6.4). **This is needed today, before any WSL feature:** every WSLg app currently reports as `msrdc`, and terminals and polkit inside WSLg pass the checks | policy input `isTerminalApp`/`isSecurityWindow` + a new `unidentifiedForeign(windowId)` never-rule in `decideBase` |
| Security windows | `isSecurityWindow(w) = win32(w) ∨ (isWsl(w) ∧ linux(w.program, w.title))`. Polkit, pinentry, ssh-askpass, gcr-prompter (vocabulary.ts:44) refused inside WSLg | PolicyInputs gains a per-request vocabulary hook; union only refuses more |
| Terminals | Linux `TERMINALS`, `SHELLS` and built-in-shell rows judged on the Linux program, OR'ed with Windows'. gnome-terminal, xterm or kitty in WSLg are refused like local terminals (policy.ts:1960-1963) | `isTerminalApp` at main.ts:1342 gets a `wsl:` branch |
| Never-look | Matcher unchanged ("keepassxc" matches `wsl:ubuntu:keepassxc`), plus `NEVER_LOOK_DEFAULTS.linux` applied to `wsl:` windows; the user can add "wsl" to hide all of them | settings defaults per window kind |
| Secret fields | The in-distro sidecar reports `password text` and secret labels as on Linux (M9) | none |
| Grants | `wsl:<distro>:<app>`, never "msrdc" (§3.4) | policy.ts:2002 key |
| Launching | Through WSLg Start Menu shortcuts only, with a strict parser that judges the Linux argv with Linux `REFUSED` and `TERMINALS` (`wsl.md` §9.1). `wslg` stays in `REFUSED.win32` (terminals.ts:189-190) for every other use | apps.ts launch path |
| Keys | SendInput to RAIL windows; Windows `isSystemKey`, plus Linux's logo-key rule (harmless: the logo key goes to Windows anyway) | none |
| Admin policy | **Windows HKLM only** (win32/system/admin-policy.ts:15-19). The in-distro `/etc/ember/policy.json` is ignored: the distro's root is reachable as `wsl.exe -u root` without a password (OS fact), so it is not an administrator's file. Documented | the WSL sidecar never reads policy |
| Audit | Windows file audit (no journal, win32/system/index.ts:65); entries carry `machine: "wsl:<distro>"` | §3.7 local |
| Consent | Same person, same PC: the existing "reads the window you're working in" covers WSLg windows. Feature consent once: "Ember will start a helper inside Ubuntu to read Linux apps" | settings |
| Kill switch | Local: unchanged parts. The in-distro sidecar is a child of `wsl.exe`. Stop cancels its reads; it exits on stdin EOF (ember_atspi.py exits on EOF, `install-transport.md` §0.1). Whether killing `wsl.exe` terminates the Linux child must be checked **(verify)**; if not, the helper's own EOF handling is the guarantee | sidecar launch |
| Borrow | Local takeover watch, unchanged (< 100 ms) | none |
| The user's words | Split `TERMINAL_WIN32` (vocabulary.ts:242, 259): "in WSL" / "in Ubuntu" as a place is **not** a terminal request. "In the WSL terminal / shell / bash" is a command request: routed to the command capability when enabled (§5), refused as today otherwise | vocabulary + host.ts:878-885 |

Never used: `wsl.exe -u <user>`, `wsl --terminate`/`--shutdown` (they disrupt the user's work), and booting a stopped
distro without the user's click (`wsl.md` §4.5).

---

## 5. Commands in WSL and SSH shells

### 5.1 Where the rule is enforced today

Ember "never runs commands" in seven places. All of them stay **unchanged for the GUI**:
1. policy.ts:1960: an element with role `terminal`;
2. policy.ts:1961: opening a terminal;
3. policy.ts:1963: any action in a terminal app or an app with a shell built in;
4. policy.ts:1964-1966: "run as program" and "make executable";
5. policy.ts:1974-1978: system keys, including the terminal and Run shortcuts;
6. `REFUSED` never-start programs, including `ssh` and `wslg` (terminals.ts:185-192), applied by `launchApp`;
7. the user's terminal words (host.ts:878-885).

### 5.2 Options

| | Option | Safety | Usefulness | Cost |
|---|---|---|---|---|
| K | **Keep the rule.** Guide only (`show_me`), explain commands in words | Strongest; no new surface | Low for servers and WSL, where most work is the shell | None |
| D1 | Read-only allowlist (`ls`, `cat` of non-secret files, `git status`…), still confirmed | Small surface; still exposed to secrets in output and interop | Diagnosis only | Classifier, runner, view |
| **D2** | **Full capability with classification; confirm every command; refuse a never list** (the owner's decision) | Defensible if §5.3-§5.6 hold; residual U3 and U4 | High | Classifier, runner, view, kill, audit, consent, admin keys |
| D3 | D2 under an admin allowlist (`commands.allowOnly`) | Enterprise-tight | Admin-defined | D2 + a schema key |

The owner chose D2. D3 comes with it as an admin key. K remains the behaviour whenever the feature is off, which is
the default.

### 5.3 The capability's shape (separate, never a loosened terminal rule)

- **Tool:** worker tool `run_command({target, command, cwd?, why})`. Added to a worker's tools only when the task's target
  is `wsl:<distro>` or `ssh:<alias>` **and** commands are enabled by:
  - the local admin (`features.commands`, `commands.targets`);
  - the remote admin (same keys, combined);
  - the user's setting (off by default, per target);
  - the feature consent.
  `verifySessionTools` (session-config.ts:70-82) then sees it as granted.
- **Target:**
  - The type has no `local` member.
  - The runner resolves the target and refuses when it is this machine: loopback, or the same machine id (§3.10).
  - A WSL distro is a target only through Ember's own `wsl.exe -d <distro>` launch, never through anything typed.
- **Decision module:** `app/main/policy/commands.ts` (pure, unit-tested).
  `decideCommand(req, ctx) → {verdict: "confirm"|"deny", class, reasons[], prompt, flags}`. There is no `allow`: every
  command is confirmed (decision).
  - It shares `alignedWithGoal` (policy.ts:1323) for the "you didn't ask for this" flag.
  - It shares the rate limiter: commands per minute ≤ 6, per task ≤ 30, and `commands.maxPerTask` lower if set.
- **Execution, one command per call:**
  - a fresh non-login shell, `bash --noprofile --norc -c <command>` or `sh -c` where there is no bash (choice: with
    `--norc` aliases and functions can't surprise the classifier, but conda or nvm PATH set-ups are lost;
    alternatively source a fixed, shown profile);
  - its own process group; on systemd Linux remotes, a transient user scope created by the runner (not the command) so
    Stop can kill everything it started **(verify user-bus availability over SSH)**;
  - stdin attached only to the user's view (§5.5);
  - a 120 s timeout by default, after which the signal ladder runs;
  - `cd` handled by the runner as state (shown in the view), not by a shell that persists.
  The WSL equivalent: `wsl.exe -d <distro> --cd <dir> --exec <runner>`, an in-distro runner speaking the same framing
  (`wsl.md` §12.3).

### 5.4 The rules for every command

**Shown and confirmed:**
- Shown **verbatim**: monospace, no truncation (it scrolls), control characters and bidi or invisible characters made
  visible (reuse `INVISIBLE`/`normalizeLabel`, policy.ts:194-205).
- The question names the target ("On build-01 as deploy", "In Ubuntu (WSL)"), the working directory, the class, and the
  risky parts highlighted ("deletes", "runs as root", "reaches Windows", "uses the network").
- Confirmed by a click or Ctrl+Alt+Y **every time**:
  - no "Always" (options are only Allow / Not now);
  - grants never apply;
  - an earlier yes in the task covers nothing;
  - `Decision.everyTime = true`.
- **Arm time per question:** risky classes get `armMs` 1500 instead of 500. A new `Question.armMs?` is passed through
  `Confirmer.ask` (confirm.ts:64, 114).

**Classes** (parsed with a real shell grammar, e.g. tree-sitter-bash in WASM, never regular expressions alone; a
PowerShell remote uses PowerShell's own AST parser through Ember's PowerShell helper later):

| Class | Examples | Verdict |
|---|---|---|
| reads | `ls`, `cat` (non-secret), `grep`, `find` without `-exec`/`-delete`, `df`, `du`, `ps`, `uname`, `git status/log/diff`, `systemctl status`, `journalctl` without `--vacuum` | confirm ("This only reads") |
| changes | `mkdir`, `cp`, `mv`, `touch`, `tee`, redirection `>`/`>>`, `sed -i`, `git add/commit`, `npm install` (local project) | confirm ("This changes files in …") |
| risky (red wording, longer arm) | deletes or overwrites (`rm`, `rmdir`, `shred`, `truncate`, `dd`, `mkfs`, `git reset --hard`, `git clean`, `push --force`, `> existing`); privileged (`sudo`, `su`, `doas`, `pkexec`); system (`systemctl start/stop/restart/enable`, `service`, `kill`, `pkill`, `reboot`, `shutdown`, package managers, firewall, user management); network (`curl`/`wget` that write, `scp`/`rsync` to this host, `git push`, `pip install`); WSL interop (`*.exe`, `/mnt/<drive>/…`, `wslpath`, `wslview`, `cmd.exe`, `powershell.exe`, `explorer.exe`, `clip.exe`) | confirm, risky |
| unknown | command substitution `$(…)` or backticks feeding a command position, `eval`, variables or globs in command position, here-docs into interpreters, aliases or functions, anything the parser can't read fully | confirm, risky ("Ember can't tell everything this does") |
| **never** | see below | deny |

**Never** (refused whatever the user says, mirroring M2):
- **Secrets:**
  - reading key or credential files (`~/.ssh/id_*`, `*.pem`, `*.key`, `~/.aws/credentials`, `~/.git-credentials`,
    `~/.netrc`, `~/.pgpass`, `~/.config/gh/hosts.yml`, `~/.kube/config`, `~/.docker/config.json`, `.env`, `/etc/shadow`,
    keyrings, browser profiles);
  - token printers (`gh auth token`, `git credential fill`, `security find-*-password`);
  - `env`, `printenv`, `set`, `declare -p`, unless filtered by the runner's own redaction (choice);
  - secrets on argv (`-p<password>`, `--password=`, `sshpass`, token-shaped strings: `ghp_`/`gho_`/`github_pat_`,
    `AKIA…`, `-----BEGIN`).
- **Persistence or escape from the kill switch:** `nohup`, `setsid`, `disown`, a trailing `&`, `screen`/`tmux` new
  sessions, `at`, `batch`, `crontab`, `systemd-run`, `systemctl --user` units started by the command, `launchctl`,
  `schtasks.exe`, `start` (cmd), `Start-Process`.
- **Other machines:** `ssh`, `mosh`, `telnet`, `rsh`, `scp`/`rsync`/`sftp` to a host other than the target, and
  `kubectl exec`, `docker exec`/`run -it` into other systems (choice: risky instead of never for `docker`/`kubectl`).
- **Interactive programs** that would hang or need a TTY dialogue: editors, pagers, `top`, REPLs without a script, `ssh`
  without a command, `passwd`.
- **Ember itself:** anything touching `ember-remote`, `~/.config/ember`, `/etc/ember`, the audit directories, or Ember's
  processes (`kill` of its pid or pgid).
- **Fetch-and-run:** `curl … | sh`, `wget -O- | bash`, `bash <(curl …)`, `python -c "$(curl …)"`.
- **Typing into secret prompts:** the model can't send input while echo is off (below).
- **On the local OS:** any target that resolves to this machine (§5.3).

**Secrets, in and out:**
- **The model never types into a password prompt.**
  - The runner watches the PTY's termios `ECHO` flag: on Linux the master shares the slave's termios, so it can be read
    with `tcgetattr` on the master, through a tiny helper **(verify on each runner OS)**.
  - While echo is off, a `send_input` from the model is refused (there is no model input tool in v1 at all; see §5.5),
    and the user's keys go straight to the PTY.
  - The span is marked secret: not recorded, not audited, not sent to the model.
  - The model gets `[the command asked for a password; you typed it]`.
- **Output to the model:**
  - ANSI and OSC stripped;
  - bounded (last 200 lines, 16 KB);
  - echo-off spans withheld;
  - token and key patterns redacted (best effort, stated);
  - wrapped `<command_output target=… exit=… untrusted="true">` with `<` escaped (elements.ts:306);
  - produced locally from the runner's raw bytes, never pre-rendered by the remote.
- **Prompt injection via output.** READMEs, MOTDs, error messages and banners are untrusted. A command whose program or
  object the user didn't name, and that is risky, is flagged "You didn't ask for this" and taints the task (the
  worker.ts:3134-3146 pattern). After taint, every step is asked about with the reason.

**Kill:**
- Stop → SIGINT to the process group (or the scope) → SIGTERM at +300 ms → SIGKILL at +1 s.
- Audited with the exit status.
- Already-done effects are not undone (U2). The kill switch's message says so when a command was running ("Stopped.
  The command had been running for 12 s; what it already changed stays").

**Audit:**
- `{event:"command", task, machine, target, cwd, command, class, flags, verdict, answer, exit, ms, outBytes,
  secretSpans}` in the 0600 file. Secrets in the command are masked: refused anyway; this is belt and braces.
- The journal gets `commandChars`, class, verdict and exit. `journalLine` sizes unknown kinds' `value` (audit.ts:113,
  129); add `command` to the sized keys (audit.ts:128).
- SSH: written on both sides (§3.7).

**Admin:**
- `features.commands`, `commands.targets`, `commands.deny` and `commands.allowOnly`, `commands.maxPerTask` (§3.6),
  combined local ∧ remote.
- A remote that forbids commands refuses `run_command` in gate 2 as well.

**Consent:** a separate feature consent, once per target: "Let Ember run commands in Ubuntu (WSL)? You'll see each
command in full and approve it every time. Commands can change or delete files there [and, in WSL, on Windows too]. You
can stop one with Ctrl+Alt+X."

### 5.5 The visible terminal (RESEARCH.md §9) and its alternatives

| | Shape | For | Against |
|---|---|---|---|
| X1 | **Ember-owned command view**: an Electron window with xterm.js, rendering the runner's PTY stream. The user can type into it (password prompts, `y/n` questions); the model can't | Visible and stoppable; Ember never opens or types into a terminal app (policy.ts:1961-1963 stay intact); the view is an Ember window, so GUI tasks can never act in it (policy.ts:1958) | A new window and a PTY dependency on the runner side (node-pty is native: glibc and arch builds; or use `script`/Python `pty` as the PTY provider, **verify**) |
| X2 | RESEARCH §9: Ember opens the user's real terminal running `tmux -L ember`, types with `send-keys`, reads with `capture-pane`, gets exit codes from OSC 133 via `pipe-pane` | "Real terminal"; works on any server with tmux | Opening a local terminal contradicts "never opens terminals" for Ember's own code too; `send-keys` interleaves with the user's typing; pane scraping is fragile; tmux absent on macOS and Windows; the local terminal app becomes Ember's input surface |
| X3 | No PTY: argv or `sh -c` with pipes, output streamed into an Ember card | Simplest; exact exit codes; nothing interactive, so no secret prompts at all (`sudo` fails with "needs your password: run it yourself") | No `sudo` with a password, no prompts; less like a terminal |

Recommendation for v1: **X1 with one-shot commands**, or X3 if the PTY dependency blocks the schedule. X2 only if the
owner wants the user's own terminal. In every option the model has **no** tool that sends input to a running command in
v1. Interactive answers are the user's, typed in the view.

### 5.6 WSL-specific: interop and `/mnt/c` mean "WSL" isn't a boundary

Facts (OS facts, verify the defaults on the user's Windows build):
- WSL interop runs Windows executables from Linux (`cmd.exe`, `powershell.exe`, any `.exe`) as the Windows user.
- Drives are mounted at `/mnt/<letter>`, so any Windows file the user can write can be changed from WSL.
- `wsl.exe -u root` needs no password.
- `WSLENV` controls which variables cross.

Consequences:
- A WSL command can do anything a local command could: run Windows programs, edit Windows files, start processes that
  outlive the distro's process group, even call `powershell.exe` to unseal Ember's DPAPI-protected token file in the
  user's profile.
- "Local commands stay forbidden" therefore holds only through classification and the user's click.

Options (choice):

| | Option | Effect | Cost |
|---|---|---|---|
| W1 | Classify only: interop tokens (`*.exe`, `/mnt/<drive>`, `wslpath`, `wslview`, …) are risky ("This reaches Windows"); writes under `/mnt/<drive>` count as "changes Windows files"; `powershell.exe`/`cmd.exe` and Ember's own data directories under `/mnt/c/Users/*/AppData/*/Ember` are never | Honest wording; evadable (U4) | Low |
| W2 | W1, plus run Ember's commands under a mount and binfmt sandbox (bubblewrap or `unshare -m`: tmpfs over `/mnt`, no WSLInterop binfmt access) | A real boundary if it works **(verify: whether interop can be blocked per process, and whether bwrap is present or user namespaces allowed in WSL2 kernels)** | Medium; may break commands that need Windows files |
| W3 | Require the distro's interop and automount off (`/etc/wsl.conf` `[interop] enabled=false`, `[automount] enabled=false`) before commands are enabled; Ember checks, never changes it | Strong | Breaks the user's own WSL workflow; most users won't accept it |
| W4 | No WSL commands; WSL GUI only | Strongest | Loses the owner's requested feature |

Recommended: W1 always. W2 if the spike shows per-process containment. Admin key `commands.wslInterop: false` forces
W3-or-off.

### 5.7 SSH-specific notes

- The remote shell runs with the remote user's full rights. That is the intended scope, bounded by the remote's own
  policy and its admin's OS controls.
- `sudo` on the remote:
  - with a password, the prompt appears in the view and the user types it (echo-off rule);
  - with NOPASSWD, a privileged command runs after a single click, so the "runs as root" wording is mandatory.
- Nested hops are never (§5.4). The channel and the kill switch don't reach a third machine.
- Windows remotes (cmd and PowerShell) are out of scope for v1 commands until the PowerShell AST classifier exists.
  The runner refuses non-POSIX shells.

---

## 6. Proposed code changes (safety parts only)

| File | Change |
|---|---|
| `app/main/policy/policy.ts` | `ActionRequest.machine`, `WindowId.machine`, `ReadSource.machine`; `elsewhere()` (783) treats another machine as elsewhere; `describe()` adds "on <alias>"; grant lookup (2002) by `machineKey`; `PolicyInputs.vocabularyFor?(r)` for the WSLg union; a never rule for unidentified foreign windows |
| `app/main/policy/commands.ts` (new) | `CommandRequest`, parser adapter, `classifyCommand`, `decideCommand`, secret-pattern and redaction helpers; pure, unit-tested |
| `app/main/admin.ts` | Schema keys (§3.6); `combineAdminPolicy(local, remote)` (only tightens, property test); remote-only keys read by the clone |
| `app/main/agent/confirm.ts` | `Question.machine?`, `Question.armMs?`; guards unchanged |
| `app/main/agent/killswitch.ts` | `StopSource` += `"remote-console" \| "remote-lost"`; per-connection parts added by main |
| `app/main/policy/audit.ts` | `AuditEntry.event` += `"remote" \| "command"`; `journalLine` sizes `command` |
| `app/main/agent/worker.ts` | `run_command` tool (only for command targets); `authorize` passes `machine`; approval reference and `expect` on remote operations; handles `changed`, `stale`, `needs_confirm` |
| `app/main/agent/host.ts` | Task bound to a target (C9); `TERMINAL_REQUEST` routing for command targets (878-885) |
| `app/main/policy/vocabulary.ts` | Split "WSL" as a place from "WSL terminal" (242, 259) |
| `app/main/main.ts` | Per-target `PolicyEngine` (1336-1343); remote stop parts (731-740); machine badge on questions; remote origin filter (C1) |
| `app/main/remote/*` (new; `install-transport.md` §14) | Connection, framing, epoch fencing, PING and dead-man, origin filter, machine-id check |
| `ember-remote` clone | Gate 2, its own `AuditLog`, admin loader, `KillSwitch`, notice window, console Stop, the runner |
| `app/shared/consent.ts`, `app/renderer/home/index.html:29-35, 92` | `CONSENT_VERSION` 2 and the new line (§3.9); feature consents in settings |

---

## 7. How to verify

- **Unit (pure, every OS):**
  - `combineAdminPolicy` never loosens (property test over random policy pairs);
  - per-target vocabularies (a polkit window from a Linux remote is refused when the local OS is win32);
  - machine-aware grants and `elsewhere`, with same-titled windows on two machines;
  - the origin filter drops `q<n>:` strings and every non-data kind;
  - `decideCommand` against a corpus: each class; obfuscations (`r''m`, `\rm`, `$(echo rm)`, `eval`, IFS tricks, unicode
    look-alikes); persistence forms; WSL interop forms; secrets on argv;
  - `journalLine` with `command` entries.
- **Integration (Linux CI):** a fake clone on a pipe with injected latency (0, 50, 250, 1000 ms):
  - kill-switch latency measured as in PLAN §6;
  - epoch fencing: an operation queued before Stop never runs;
  - EOF → the remote stops and exits;
  - silence → the dead-man fires at 3 s;
  - freshness gate → at most one operation after the link stalls;
  - a gate 2 `changed` → a new question;
  - no audit write → refused.
- **Runner:** a PTY fixture with `read -s`: echo-off detected, model input refused, span withheld; Stop kills a
  `sleep 1000 & wait` pipeline's whole group; `nohup` refused before running.
- **WSL:** manual script or self-hosted Windows 11 runner (no WSL2 on hosted runners, `wsl.md` §0.9):
  - an unidentified RAIL window gets no action;
  - xterm and polkit in WSLg are refused;
  - "in WSL" is not a terminal request;
  - an interop command is flagged.
- **Two-user check (remote GUI):** a session of another uid is refused; a locked session is refused; the notice appears;
  console Stop works.

---

## 8. Owner choices this spec does not make

1. Remote consent strength: R3 (a) authentication only, (b) console consent when someone is likely there, or (c) never
   act with recent console input (§3.9).
2. Tier 3 on remotes: off (recommended), or allowed with the masked remote view.
3. "Always in this app" on remote apps: never (recommended for v1), or per machine.
4. Remote with no policy file: usable (default) or require an explicit remote opt-in.
5. Remote `provider` / `models.allowed` versus the local brain: refuse to connect (recommended) or warn.
6. Commands default: off until enabled per target (recommended).
7. WSL interop: W1 / W2 / W3 / W4 (§5.6).
8. Execution shape: X1 / X2 / X3 (§5.5); `--norc` versus a shown profile.
9. `env`/`printenv`: never, or allowed with runner-side redaction.
10. `docker`/`kubectl` exec: never or risky.
11. `CONSENT_VERSION` bump at release (recommended) or feature consents only.
12. The remote audit at uninstall: always kept (recommended), or removable by the remote user.

## 9. Risks

| # | Risk | Mitigation / residual |
|---|---|---|
| 1 | Approval fatigue: every command and every remote borrow confirmed | Class wording, risky highlighting, longer arm time, rate caps, alignment flags; residual |
| 2 | Classifier evasion | Fail to "unknown, risky"; verbatim view; residual U4 |
| 3 | Hostile remote root or remote uid | Out of scope by nature (U1); data filters at source protect the remote's privacy from honest bugs only |
| 4 | WAN latency beyond the 300 ms budget | Epoch fencing, escalation, dead-man and freshness; show RTT; residual: effects within one-way latency |
| 5 | Effects done before Stop | Stated in the stop message (U2) |
| 6 | WSL interop: a WSL command equals a local one | §5.6; residual unless W2 or W3 |
| 7 | Another person at or owning the remote screen | Same-uid rule, notice, console Stop, console consent option |
| 8 | Secrets in output reaching Copilot | Never-list for secret readers, redaction (best effort), echo-off withholding |
| 9 | Prompt injection through command output, banners, remote screens | Untrusted wrapping done locally, goals only from the user (persona.ts:35), taint after unasked risky steps |
| 10 | Mixed versions plus the strict admin schema → lockdown | Ship the schema first, versioned protocol, document |
| 11 | Machine-blind identity bugs (grants, carries) | §3.4 changes plus tests with same-named apps on two machines |
| 12 | Today's WSLg gap (msrdc) | Fix first (§4), independent of the new features |
