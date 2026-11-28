# Ember as a coding agent

Owner decision of 27 November 2026: Ember is first a complete coding agent on the GitHub Copilot SDK, like the
GitHub Copilot, Claude Code and Codex desktop apps. It supports what the SDK supports, with the SDK's own tools,
permissions and modes as they are. The companion (the character beside the cursor, voice, the desktop tools) is an
option the user turns on; when on, it can control the desktop and the app's own coding sessions on request.

This is the design and its build order. PLAN.md §2 and §10 record the decision; where the older documents describe
the companion as the centre, this one wins for the coding app.

## 1. What the research found

Three studies fed this (27 November 2026): the three desktop apps, open-source agents (Codex CLI, opencode, Cline,
Zed's agent panel) and an inventory of SDK 1.0.21 (runtime 1.0.97).

- **All three apps have:** a session list grouped by project with archive; a start flow that picks a folder and
  whether to work in it, in a git worktree or in the cloud; a transcript with tool rows, diffs, reasoning and a
  plan or to-do surface; a composer with attachments, @-files, slash commands, skills and pickers for model,
  reasoning effort and mode; a diff review with comments sent back to the agent, and pull requests with their CI;
  a browser or preview; MCP, skills and an instructions file; scheduled tasks; managed settings that can turn modes
  off.
- **Two of three have:** a terminal, a file tree and viewer, voice dictation, and queueing or steering while a turn
  runs. Claude has checkpoints and rewind, and a background-tasks pane.
- **The Copilot app's permissions are the SDK's:** an agent mode (Interactive, Plan, Autopilot) and, separately, tool
  permissions (Ask every time, Assisted, Approve all), with the organisation's rules always winning and a sandbox
  the user can switch.
- **From the open-source agents:** make state re-readable (stable ids, numbered events, attach with replay); keep
  one path for every decision, answered once and cleared everywhere; treat undo as a feature with honest limits.
- **The SDK already has nearly all of it:** about 110 session options, 500 RPC methods and 145 event types: queue and
  steering, rewind with file tracking, session diff, plan and to-dos, background agents, MCP with OAuth, skills,
  plugins, custom agents, slash commands, composer completions, workspace files, a user shell, models and usage,
  fork, compaction, schedules. Nearly all of the RPC surface is marked experimental.

## 2. Layers

```
coding window (sandboxed renderer)      app/renderer/code/     pure reducers over SDK events, DOM views
  │  window.emberCode (preload)          app/preload/code.ts
  │  typed IPC, app/shared/code.ts
main                                     app/main/code/
  CodeHub          one dispatch(command, actor) for the window, the companion and tests
  SessionRuntime   one per open session: SDK events → numbered envelopes, the pending-request table
  SessionIndex     projects, rows, pinned, archived, unread, parent, worktree (Ember's own file)
  Workspaces       folders, git worktrees per session, leases
  Guards           organisation policy, consent, sandbox, Ember's data, redaction, limits, audit
  CodeRuntime      the Copilot runtime for coding sessions (the only importer of the SDK here)
GitHub Copilot SDK                       sessions, tools, permissions, modes, MCP, hooks, sub-agents, history
```

- **Pass through, don't translate.** Main sends each SDK event to the window as it is, redacted and bounded,
  with a per-session sequence number. The window calls SDK RPC methods by name through one allow-list
  (`CODE_RPC`). What the transcript, plan or diff looks like is decided by pure reducers in the renderer. A new SDK
  event or method then needs a reducer case or a list entry, never a new layer.
- **Re-readable state.** `attach(sessionId, sinceSeq)` returns what was missed and every request still waiting.
  A gap in `seq` means attach again. History of a kept session comes from the SDK's own event log.
- **One decision path.** Every blocking request (permission, the model's question, elicitation, leaving plan
  mode, auto-mode switch, session limits, MCP sign-in, sampling) sits in one pending table, is answered once
  through `respond`, and is cleared in every window. A permission request shows exactly the SDK's choices.
- **Actors.** Every command carries who asked: `user`, `companion` or `system`. Policy and the audit log key off it.
- **Full Copilot mode.** Coding sessions run the runtime as the Copilot CLI does, not in the SDK's "empty" mode:
  skills, memory, custom instructions, on-demand instruction discovery, file hooks, host git, the session store
  and the environment context are on, so a session behaves like Copilot.

## 3. Guards

What Ember keeps whatever the SDK allows. Each fails closed.

- **Consent:** no session starts, and nothing is read or sent, before `hasConsent`.
- **Stop:** the hub is a `StopPart`; Stop aborts every turn and background agent within the kill switch's 300 ms.
- **Organisation policy:** passed to the SDK as managed settings; a mode it forbids is refused, and the window is
  told which mode stays. LOCKDOWN and `features.actions: false` keep coding sessions off.
- **Ember's data:** its data folder, the audit log and the organisation's policy are denied paths in the SDK's
  sandbox, and a pre-tool hook refuses the SDK's file tools on them where there is no sandbox.
- **Sandbox:** on by default where the host supports it, with outbound network allowed (a coding agent installs
  packages); the user can switch it per session as in the Copilot app. Where the host has no sandbox the session
  runs without one and the start flow says so. A window's RPC call can never turn it off: only the setting can.
- **Secrets:** the GitHub token never reaches a command's environment; vault values are redacted from events.
- **Audit:** session start and end, every decision with who made it, every mode change, every companion command.
- **IPC:** every handler checks its sender; arguments are `unknown`, checked for type and size; paths come only from
  main's pickers and lists, never as free text from the window.

## 4. The window

One window, `app/renderer/code/`, in Ember's design system. Home stays as Settings for the companion and is reached
from it.

| Area | Holds |
|---|---|
| Sidebar | Projects and their sessions: status (working, needs you, unread), pin, archive and an archived view, search, new session |
| Start flow | Folder or known project; work in the folder or a new worktree and its base branch; model, reasoning effort, agent, modes |
| Transcript | Messages with markdown and code; reasoning; tool rows (shell with live output, edits with diffs, reads, searches, fetches, MCP); sub-agent rows that open; plan and to-do updates; compaction and model changes; errors with their remedy; request cards |
| Composer | Text; attachments (files, folders, images, pasted text); @-files and slash commands from the SDK's completions; pickers for model, reasoning effort, agent mode and permission mode; queue and steer while running; the queue itself; Stop; context and usage meter; dictation when the companion's voice is on |
| Changes | The session's diff (session, unstaged, branch), by file, with line comments sent back to the agent; rewind points with preview; commit, push and pull request through the agent |
| Plan | The plan file, to-dos with dependencies, the Autopilot objective, approve or revise when leaving plan mode |
| Files | The workspace tree and a read-only viewer; attach to the composer |
| Terminal | The user's own shell in the session's folder (`shell.*`), and the output of the agent's commands |
| Agents and tasks | Background agents and shells: progress, message, cancel, promote; fleet |
| Customise | Models and providers; MCP servers (add, sign in, tools, resources, prompts); skills; plugins and marketplaces; custom agents; instructions; hooks; permission rules, trusted folders and locations; sandbox; schedules; usage and quota |
| Command palette | Every action and slash command by name |

## 5. The companion

Off by default for new installs; existing users keep it on. When on it is what it was: the character, voice, the
desktop tools and their rules. It gains tools over the hub, each a `dispatch` as actor `companion`: list sessions
and projects, read a session's status and recent messages, start a session, send or queue a message, stop a turn,
list what is waiting. Answering a permission request for the user is not one of them in the first release: it
reads the request out and the user answers by click, shortcut or voice as for any question. What it reads from a
session is untrusted text. Stop reaches it first.

## 6. Build order

1. **Session layer:** `app/main/code/`, the contract, the preload, tests against the real runtime.
2. **Window shell:** the window, sidebar, start flow, transcript, composer, request cards. Built in `app/renderer/code/`: a pure store
   (`store.ts`, `transcript.ts`: reducers over the SDK's events, idempotent by `seq` and event id, a gap marks the
   session to attach again), its views (sidebar, start flow, transcript with request cards, composer, panel with empty
   tabs registered through `registerPanelTab`, Customise's sections through `registerCustomiseSection`, the command
   palette), and `createCodeWindow`/`openCodeWindow` in windows.ts, which open nothing until the build has the coding
   preload. test/integration/code-window-renderer.test.ts plays a session against a scripted `window.emberCode`
   (test/fixtures/code-window/fake-api.js).
3. **Panels:** Changes, Plan, Files, Terminal, Agents and tasks.
4. **Customise:** models, MCP, skills, plugins, agents, instructions, hooks, rules, sandbox, schedules, usage. Built in
   `app/renderer/code/customise-*.ts`, one file a section over the SDK's own methods through `CODE_RPC`
   (customise-kit.ts: each says whether it applies to this computer or names the session; a refused or failed call says
   main's sentence with Try again; a method off the allow-list says it isn't available yet), pure readers and form
   checks in customise-read.ts and customise-forms.ts, words in copy-customise.ts, styles in customise-sections.css.
   An MCP server's variable and header values are write-only: never drawn, kept on an edit unless retyped. Modes change
   only through their own commands; the sandbox is read-only. test/integration/code-customise-renderer.test.ts plays
   every section against the fake.
5. **Companion as an option:** the switch, the hub tools, voice in the composer.
6. **Retire what this replaces:** Home's Chats pane and `app/main/agent/chat-*`, then the isolated-copy coding path
   with its Windows pin workflows.

## 7. What the first end-to-end run corrected

The real window in real Electron on the real runtime (test/integration/code-window-live.test.ts, 28 November 2026)
found where the design and the parts built against it were wrong:

- **The window didn't open.** Wiring the coding window into the start detached the greeting (an `else` bound to the
  new `if`), and opened the window only for a start that greets, never when a setup row opened settings. A start by
  hand now opens it beside whatever else it shows (`opensCodeAtStart`), and the greeting is back.
- **A permission's record is the runtime's, not the answer.** `permission.completed` says `approved` for a one-time
  yes, not the `approve-once` the window sent; the window read it as a bare "Allowed".
- **"Attach" is not "looked at".** Attaching cleared a session's unread count and nothing counted while any window
  was attached, so a session kept attached in the background never showed what happened in it. Unread now counts
  until the window says it shows the session with the focus (`markRead`), and is kept as it changes.
- **A session couldn't be deleted from the window.** The contract had `remove` and `fork`, the window no control for
  them; the command palette has both now (Delete asks again, with keeping it first).
- **A fork shared its parent's worktree,** so deleting the parent took the fork's folder. A fork gets its own.
- **Links opened nothing.** The contract has `openLink` now, through main.
- **The microphone's hold** reaches the window over its own channel (`code:mic-held`, from Home's rule
  `voiceHoldsLive`), not a hook left for later.

Not in this build: cloud sessions and handoff, remote control from a phone, canvases and MCP Apps rendering,
a built-in browser preview. The contract leaves room for each.
