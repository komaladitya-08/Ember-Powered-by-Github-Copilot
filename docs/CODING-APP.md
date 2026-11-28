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
- **A session's own state, and no other's:** the coding runtime keeps its state (COPILOT_HOME) in a folder of its
  own beside the data folder (`SystemPaths.codeState`, app/main/code/state.ts), not inside it: a path the sandbox
  grants doesn't open anything under a denied one (probed), so inside the data folder plan mode couldn't write its
  `plan.md`. Each session's sandbox denies Ember's paths and, of that folder, every entry beside `session-state` (the
  session store, logs, personal skills and instructions, MCP configuration, plugins) and every other session's folder
  (`siblingDenials`: the folder itself can't be denied without its own state); when a session opens, every open
  session's sandbox is set again to deny it too, and one that won't take it is closed. The pre-tool hook counts the
  whole folder as Ember's data but for the session's own state. A folder that can't be read whole is denied whole.
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
| Transcript | Messages with markdown and code, and the sources a reply cites; reasoning; tool rows (shell with live output, edits with diffs, reads, searches, fetches, MCP, pictures a tool returned); sub-agent rows that open; plan and to-do updates; compaction and model changes; handoffs, context truncation, finished tasks, schedules, workflows; errors with their remedy and the action it names (sign-in, the sandbox, rewind points); request cards |
| Composer | Text; attachments (files, folders, images, pasted text); @-files and slash commands from the SDK's completions; pickers for model, reasoning effort, agent mode and permission mode; queue and steer while running; the queue itself; Stop; context and usage meter; dictation when the companion's voice is on |
| Changes | The session's diff (session, unstaged, branch: `workspaces.diff`, its paths the repository top's), by file, with line comments sent back to the agent; rewind points with preview; commit, push and pull request through the agent. Read again after a tool that edited a file or ran a command, and again on its own while the runtime still says it is busy after a turn |
| Plan | The plan file, to-dos with dependencies, the Autopilot objective, approve or revise when leaving plan mode |
| Files | The working folder as main lists it (`listFolder`, a folder at a time; `.git` and what git ignores left out) with the session's changes marked, read through main (`readFile`); Copilot's own session files (`workspaces.listFiles`/`readFile`); a read-only viewer; attach to the composer |
| Terminal | The user's own shell in the session's folder (`shell.executeUserRequested`, which waits for the command and streams `tool.user_requested`, `tool.shell_output`), and the output of the agent's commands |
| Agents and tasks | Background agents and shells: progress, message, cancel, promote; start an agent (custom ones from `agent.list`, then Copilot's built-in types, which it doesn't list); fleet |
| Customise | Models and providers; MCP servers (add, sign in in the browser through `openLink`, tools, resources, prompts; values never sent to the window); skills; plugins and marketplaces; custom agents; instructions; hooks; permission rules (`shell(npm test)`, `shell(git:*)`), trusted folders and locations; sandbox; schedules; usage and quota; the person's defaults and each project's instructions and extra folders; a session's settings (reasoning summaries, long context, co-author, credit limit, built-in tools left out); storage (sizes, old sessions deleted after a dry run) |
| Sidebar's projects | Add, and Remove (asked again in place; refused while it has sessions, with main's sentence) |
| Command palette | Every action and slash command by name |

## 5. The companion

`settings.companion.enabled`: off for a new install, on for an existing user (`migrateCompanion`: a settings file
that has finished the welcome and has no `companion` key keeps it on). Home's "Companion and coding" group holds its
switch and the coding sessions' one; the coding window's Customise › Companion shows the state and opens Home there.
Which parts run is one pure decision, `companionParts()` (app/main/companion.ts), that main and the host follow:

- **Off:** no overlay or handle, no Ask box (its shortcut and mute's are let go), no listening, no greeting, no
  conversation (the host signs in for the coding sessions but opens no conductor session, so no task or worker runs),
  and requests are refused. Stop and Settings keep their shortcuts, and Stop reaches the coding sessions. With coding
  sessions on, a start by hand opens the coding window; with both off, Home, which says what can be turned on
  (`startOpens`). First run's tries leave out "Say “Hey Ember”" and the Ask box.
- **Turned off or on while Ember runs:** the windows go or come at once, the microphone closes or opens, the shortcuts
  are let go or held, and the conversation is let go (every task stopped as Stop stops it, saying why) or opened
  again, resuming it. Nothing needs a restart, except that the coding tools are fixed for a conversation: turning
  coding sessions on or off reaches them with the next conversation.
- **On:** what it was, plus, while coding sessions are on too, seven conductor tools (app/main/agent/coding-tools.ts),
  each a `dispatch` as `companion`: `list_coding_sessions`, `read_coding_session`, `start_coding_session`,
  `send_to_coding_session`, `stop_coding_session`, `list_coding_requests`, `show_coding_session`. The hub holds what
  the companion may do, by actor (app/main/code/companion.ts `companionRefusal`): list, create, send, interrupt and
  Stop everything only; a session it starts is in a project the user added (never a path), with no mode of its
  choosing (so the user's defaults), and only for a request in the user's own words this turn; no attachments, no
  answer, mode, rename, fork, delete, attach or RPC; at most 20 commands a minute (`CompanionPace`); every command,
  refused ones too, audited with the actor. What it reads is wrapped `untrusted="true"`.
- **A request waiting:** Ember says so in the bubble and, where replies are spoken, aloud, in its own words from the
  request's kind and the project's name ("Copilot wants to run a command in “app”. Open it?"), with Open it showing
  the session. It is no question of Ember's, so a spoken yes never answers it: a coding session's request is
  answered only in the coding window, by click or key.

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
5. **Companion as an option:** the switch, the hub tools, voice in the composer. Built (§5) but for dictation in the
   composer (§7): app/main/companion.ts, app/main/code/companion.ts, app/main/agent/coding-tools.ts, Home's
   "Companion and coding" group and Customise › Companion.
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

### The panels and Customise on the real runtime

The panel tabs and Customise were built against the SDK's generated types and a scripted stand-in. A probe through the
hub on the bundled runtime (SDK 1.0.21, runtime 1.0.97, the mock model, 28 November 2026: every method they call, in a
repository, a subfolder of it and a worktree) and test/integration/code-panels-live.test.ts found:

- **The SDK can't list the working folder.** `workspaces.listFiles`, `readFile` and `statFile` are the session's own
  state folder (its plan, pasted files), and `statFile` needs "session memory v2", which is off. Main now lists and
  reads the session's folder itself (`listFolder`, `readFile`).
- **A repository file a tool wrote sends no event.** `session.workspace_file_changed` is the state folder only, so the
  Changes tab read the diff only at a turn's end; it reads it after a tool with `fileEdits` or a command now.
- **"Busy" outlasts the turn.** For a while after `session.idle`, `workspaces.diff` and `history.listRewindPoints`
  answer `session-busy`, and nothing tells the window when that ends: the tab tries again on its own.
- **`includeContents` is for the session diff only**; the others refuse it.
- **Paths:** `workspaces.diff`'s are relative to the repository's top, also for a session in a subfolder of it;
  `history.previewRewind`'s and `rewind`'s are absolute.
- **A rewind's history isn't cut in the run's log.** `session.snapshot_rewind` (`upToEventId`, not ephemeral) names
  the message it went back to; the window's replay now drops that message and what followed it.
- **The person's own command starts with `tool.user_requested`**, never `tool.execution_start`, and
  `shell.executeUserRequested` answers only once it ends (a command was cut at about 10 s, exit code -1). It is
  sandboxed and raises no permission request in any mode; main's guard refuses one that names Ember's data.
- **`agent.list` lists no built-in agent**, even with `includeBuiltInAgents`, while `tasks.startAgent` takes
  `explore`, `task`, `general-purpose` and `code-review`. An idle background agent is `status: "idle"`.
- **Rules match only Copilot's own lower-case kinds:** `{ kind: "shell", argument: "npm test" }` lets `npm test` run
  unasked, `"Shell"` does nothing, and `"git:*"` covers every command starting `git`. The window writes them so.
- **MCP:** `mcp.config.list` answers every variable's and header's value as stored, and a program server with no
  `type`; main now hides them. A session's `mcp.list` names only servers it has a client for: a failed one is only in
  `host.failedServers`, one waiting to sign in only in `needsAuthServers`. A server added to the configuration starts
  only in new sessions (or by its Start). The Customise page's status listener was cleared at its first draw and never
  heard a status change.
- **Without a Copilot account** `models.list` and `account.getQuota` answer "Not authenticated": the runtime is
  tokenless, so main gives those two the sign-in. Failed methods were said in the model service's words ("Check its
  API key"); they are said in Ember's now.
- **The sandbox's remedy** is a long sentence ending in a docs address; the window quotes it without that.
- **Plan mode couldn't write its plan under the sandbox.** Copilot writes `plan.md` in its session state, which lay in
  Ember's data folder, which the sandbox denies (a `readwritePaths` entry doesn't open a denied path, probed), so in
  plan mode only `exit_plan_mode`'s summary reached the Plan tab. A probe (bubblewrap, the mock model) found what the
  runtime writes itself, unsandboxed: `events.jsonl`, `workspace.yaml`, `checkpoints/`, `rewind-file-snapshots/`,
  `session.db` (the `sql` tool's to-dos) and the session store, so `sql` and `session_store_sql` worked all along; and
  what its tools write through the sandbox: `plan.md` (the `create` and `edit` tools) and `files/` (granted read and
  write; under a denied folder a write there went to a scratch copy and was lost). The sandbox's policy is a list of
  grants: it gives a session its own `events.jsonl` (read), the runtime's `logs/` (read), its `files/` and in plan
  mode its plan, and the temporary folder whole (large tool output is saved there). So the state moved beside the
  data folder, other sessions' folders are denied by name, and test/integration/code-panels-live.test.ts writes a
  plan, shows and edits it in the tab, has the model read the edit, and finds another session's state and Ember's
  settings refused by the sandbox. Not changed here: large tool output in the temporary folder is readable by every
  session's tools, and `session_store_sql` (in the runtime, unsandboxed) reads every session's history, as before.
- **Not confirmed here** (they need a Copilot account or the network): citations and generated images from a real
  model (§8: built against the SDK's types, checked in the window with the stand-in only), `models.list`'s and
  `account.getQuota`'s answers, `mcp.oauth.login`'s address and status, `quota.*` with a plan, plugin installs and marketplaces, `history.compact`'s
  summary from a real model, `completions.request` (it answered no items and no trigger characters with the mock model).

### The companion as an option

Making the companion an option (step 5, test/integration/companion-live.test.ts) changed the design here:

- **The companion doesn't read a request out for the user to answer by voice.** §5 first had the user answer a
  session's request "by click, shortcut or voice as for any question"; a spoken yes answers only a question Ember's
  own Confirmer put up, and a session's request is the SDK's, so it is answered in the coding window alone.
- **The conversation needs the sign-in but the sign-in doesn't need the conversation.** Coding sessions take their
  access from the host's connection, so with the companion off the host still connects and only skips the conductor.
- **The session's modes are the user's, not the companion's to pick.** The companion picks none: its sessions start
  with the person's own defaults (§8, `CodeHub.userDefaults`), as a start by hand that names none does.
- **Dictation in the composer is not in this build.** Listen once delivers its words to the conversation through
  main's request path; putting them in the composer as a draft needs a channel of its own from the voice process to
  the coding window, with Home's hold rules, which is more than forwarding one.

Not in this build: cloud sessions and handoff, remote control from a phone, canvases and MCP Apps rendering,
a built-in browser preview. The contract leaves room for each; §8 says why each waits.

## 8. SDK coverage

An audit of SDK 1.0.21 (runtime 1.0.97) on 28 November 2026: its 393 RPC methods (`rpcmethods.txt`), 145 event types
(`events.txt`), session options, permission kinds, attachments and hooks, against what the coding window and main
name (grep of app/renderer/code and app/main/code; `CODE_RPC` in app/shared/code.ts), each new part probed on the
bundled runtime with the mock model before it was built. **Used**: in the window before this audit. **Built**: added
with it (test/integration/code-sdk-live.test.ts runs them on the real runtime; code-sdk-renderer.test.ts in the window).
**Not built**: with the reason. test/unit/code-transcript-events.test.ts fails on an event type the transcript neither
names nor folds on purpose.

| Capability | State |
|---|---|
| Sessions: create, resume, list, delete, fork, attach with replay | Used |
| Turns: send (queue, steer, agent mode, attachments: file, directory, selection, image blob), abort, interrupt keeping background work, `queue.*` | Used |
| Permission requests: every kind (shell, write, read, url, mcp, memory, custom-tool, hook, workflow and extensions as "other", shown whole); decisions approve-once, for the session, read-only, for the location, permanently (URL), reject with feedback | Used |
| Other blocking requests: the model's question, elicitation (form fields from the schema's types, enums, formats, ranges; URL mode opens through main), leaving plan mode, auto-mode switch, session limits, MCP sign-in | Used |
| Permission and agent modes, rules, paths, trusted folders, locations; sandbox status | Used (modes only by their own commands; the sandbox only read) |
| Models, reasoning effort, providers; MCP config, status, tools, resources, prompts, sign-in; skills, plugins, marketplaces, custom agents, instructions, hooks (read); schedules; usage, quota; plan, to-dos, objective; diff, rewind; files; the person's shell; background agents, fleet; slash commands, completions | Used |
| Events: 108 of 145 drawn or kept as state before | Used |
| The other 37 events: handoff, context truncation (was taken for a history cut, which blanked a kept history after it), cleared context, finished task, tool search, a retried model call (composer), auto tier that couldn't change, schedules, credit limit, permission recovery, an MCP server to restart, a model withdrawn, workflow runs, binary assets (pictures), branch from `session.context_changed` | Built |
| Hidden on purpose: telemetry (fusion, auto router, usage record, quota observation, completion receipt), events of what Ember never registers (host tools `external_tool.*`, host commands `command.execute`, header refresh, canvases, MCP Apps), side questions | Built (each with why, in transcript.ts) |
| `session.custom_notification` (an extension's own) | Folded as a generic row |
| Citations (`enableCitations`) on replies; pictures in tool results (`binaryResultsForLlm`, `contents` of type image) | Built: data URLs of PNG, JPEG, GIF or WebP whose first bytes match, whole base64 only (main cuts strings past 128 KiB, so larger pictures say they aren't shown; the runtime's secret filter can star a short provider key inside base64, which is refused) |
| Remediations: sign in, switch or show account, review the sandbox, allow outbound, rewind | Built: sign-in opens Home's Copilot section (`openSignIn`), the sandbox's Customise › Sandbox, rewind the Changes tab |
| The person's defaults (permission mode, agent mode, model, effort, worktree) for every project and per project | Built: Ember's index, `CodeHub.userDefaults(projectId?)`, the start flow preselects; the organisation's modes win |
| `systemMessage` append (a project's instructions), `additionalDirectories` (extra folders from main's picker), `reasoningSummary`, `contextTier`, `excludedTools`, `coauthorEnabled`, `sessionLimits.maxAiCredits` (with `limitPrediction.predict`'s cap) | Built: create and every resume (the runtime forgets them), changed live through main's `configure` (`options.update`) |
| `sessions.getSizes`, `sessions.pruneOld` (dry run only), transcript export, `history.summarizeForHandoff` | Built: Customise › Storage deletes through Ember's own Delete (index and worktrees kept whole); export through main's save dialog; a handoff leaves the summary as a draft |
| `history.truncate` | Not built: it is a rewind of the conversation (`session.snapshot_rewind`, probed), which the Changes tab has |
| `history.clearContext` | Not built: the runtime takes it only from inside a tool handler (probed), and Ember defines no tools |
| `name.setAuto` | Not built: it takes the summary the host supplies (probed); `name.set` and the runtime's own titles cover naming |
| `allowedModels`, `toolSearch`, `largeOutput`, `imageGeneration`, `infiniteSessions` thresholds, `disabledMcpServers`, `agent`/`excludedBuiltinAgents`, `availableTools`, `enableConfigDiscovery` | Not built: tool search and large output keep the runtime's defaults (tool search past 30 tools; large output saved to the temporary folder, §7); an allow-list of tools or models and image generation would need the window to widen or narrow what main passes, which only main decides (the window may only narrow, as excluded tools do); MCP servers start and stop per session in Customise; the start flow picks an agent; generated images need a model that makes them, which the mock can't, and arrive as `session.binary_asset`, which is drawn |
| MCP sampling (`sampling.requested`) | Not built: the event names only the server and an id, not what it asks the model, so approval would be blind; the card offers only to refuse |
| MCP resources as attachments, prompts as slash commands | Not built: the SDK's attachment union has no resource kind; Customise › MCP servers lists both |
| MCP Apps (`enableMcpApps`, `mcp.apps.*`) and canvases (`canvas.*`, `requestCanvasRenderer`) | Not built: they are server-written HTML with scripts. The window's CSP is `script-src 'self'`, which a `srcdoc` frame inherits, so the app could not run; loosening it would let the server's script share the window's policy. A safe host needs a frame on an origin of its own (a custom protocol serving only that resource) with `sandbox="allow-scripts"` and no same-origin, its own CSP with `connect-src 'none'`, and a postMessage bridge that passes only SEP-1865's methods through main's allow-list |
| Workflows (`workflow.*`, the `workflow` permission kind) | Not built: the runtime answers "Agent workflows are not available for this session" without an account (`quota.get`: `dynamicWorkflowsEnabled: false`), and workflows are defined by the host's code (`defineWorkflow`), of which Ember has none; their events are drawn |
| Remote and cloud (`cloud`, `remoteSession`, `sessions.open` remote, cloud and handoff, `remote.*`, `environments.*`, remote control) | Not built: `remote.enable` and `environments.list` answer "not authenticated" (probed), `visibility.set` reports nothing synced; an account-backed test would need a Copilot login with Mission Control, a repository on GitHub and network to github.com |
| Account (`account.getCurrentAuth`, `gitHubAuth.getStatus`, `accounts.*`, login, logout) | Not built beyond the sign-in remedy: the coding runtime is tokenless by design (runtime.ts); Home owns signing in |
| Quota warnings (`quota.takeWarnings`) | Not built: they answer an empty list without an account; with one, Customise › Usage shows the quota |
| Hooks: `onPreToolUse` (Ember's data, Stop), `onPostToolUse` (vault values) | Used |
| Hooks: `onUserPromptSubmitted`, `onSessionStart`/`End`, `onErrorOccurred`, `onAgentStop`, `onSubagentStart`/`Stop`, `onPreMcpToolCall` | Not built: none protects or informs beyond what the events already say (an error with its remedy, a sub-agent's row); retry is the runtime's own (`model.call_failure`); a hook that changes a prompt or a result would change what the person sent without their seeing it |
| Diagnostics (`debug.collectLogs`, `diagnostics.read`) | Not built: `collectLogs` writes the runtime's logs, which hold prompts and file contents, to a path; `diagnostics.read` reads MCP only |
| Search across sessions | Not built: only the model's `session_store_sql` tool reaches the session store; the sidebar searches session names |
| Host-side SDK parts: custom tools, host slash commands, `sessionFs`, `requestHandler`, extensions, telemetry, LSP, AHP host | Not built: each would put Ember's own code in the session's path, which the guards keep to the two hooks above |

