# Hand-offs between SSH/WSL packages (kept by the lead; read the rows for your package)

## Merged so far on ember-improve/20261022-ssh-wsl
- S0a (89657f8), S0b + MX (d8b1854).

## From S0a's review
- RUN: check RunnerFacts.shellPath matches [A-Za-z0-9/._-].
- SB: RunnerFacts.ember.names via emberNamesRegExp(names) (only [A-Za-z0-9._+ -]); truncate RunExit.error to 500 chars.
- CL: keep paths out of the decision's `reason`.

## From S0b's review
- AG: replace the interim makeWorker / refusedWorker(spec: TaskSpec, why: string): WorkerLike with §2.6's version;
  refuse before queueing in startTask and show_me; add targetId to TaskManager.start.
- TG: questionWords(q: Question): string | null must return words for consent panels too (else main speaks the
  approve-key hint for a click-only card); questionChanged, panelReady, quickContext and bubbleAction must never throw;
  emberPids covers only app.getAppMetrics(), the sidecar, the desk and voice — add TG's helpers (ssh, askpass, WSL
  sidecars) and look at the Copilot runtime child (a design gap).
- TG (+ win32): win32/system/environment.ts reports an unreadable elevation token as false; TargetsDeps.elevated
  needs yes / no / unknown so it fails closed (unknown = treat as elevated: every command asks). I-win has finished,
  so TG may make that minimal change.
- WB: targetRules(r: ActionRequest, os: OS): Decision | null must return only refusals (the seam runs it before every
  never-rule).
- AG/TG: on a session with no screen, "act now" starts a task that fails with the stub's words; AG's
  refuse-before-queueing removes it.

## From MX's review
- createMux returns Mux & MuxBacklog: backlog(): { ctl; data; bulk; diag } bytes waiting — SB should cap a command's
  output backlog with it (a fast printer over a slow link). A request over 60 KiB travels on data and is overtaken by
  later ctl requests (epoch fencing still protects Stop).

## Merged: AG (87cf110: host-taskbase tests updated to §2.6), UI + WA (6a93a16; design-system PAGES += command, prompt)

## From AG's review
- CL (at CL's merge, lead): set DEFAULT_JUDGE in app/main/commands/flow.ts to CL's classifyCommand, decideCommand,
  shapeOutput, redactSecrets, trackSecretPrompts({interactive}), outputTaint, resolveTargetPath — until then nothing
  runs (fail closed).
- TG: CommandService.consentPanel() (missing on TG's branch; a target waiting for consent refuses commands until it
  exists); routing of ui:cmdstop:. main: wire HostOptions.emberPids and onAnnounce.
- Owner question: admin features.actions = false also blocks commands (AG's conservative reading).

## From UI's review
- TG: keep calling hideConsent(n) and hideCard(n) when a question ends; wire onAnswer/onConsent to
  confirmer.answer(`q${n}:${answer}`, "panel", { sha256 }); use show() for ui:panel:<n>; use termSize(), keyHintText(os),
  note(runId, …), consentPanel.
- main.ts (TG): pass AskContext.target, admin.commands and sshHostsLimited in the status.
- RUN: add RunExit.stragglers?: string[].
- CL: once app/shared/visible-text.ts lands, UI's visible.ts becomes a re-export.
- Card sha256 = sha256Hex(`${target}\0${shell}\0${cwd}\0${command}`) (AG matches); a card failing validCard stops the run.
- Lead decision: SSH prompts wait behind a consent card (up to 120 s) rather than swapping the card under the pointer.

## From WA's review
- RUN: jobHostArgv(ref, program, args, interactive) must drop ELECTRON_RUN_AS_NODE before spawning (WA's runner sets
  it); interactive mode relays stdin and ends the job only when stdin closes. WA should swap in RUN's commandEnv(base,
  { os, pty, remote, extraPath, runId }) and sweepScript at merge (lead).
- CL: wire trackSecretPrompts({ interactive }) into wsl/service.ts (WA uses fallbackSecretTracker today).
- AG/TG/UI: WSL runs carry extras (secretSpans(), stragglers(), status()/onStatus() "Starting Ubuntu…", lastFacts());
  WslServiceImpl.runner() returns the extended runner. TG must not call facts() when features.wsl is false.
- WB: use WA's runScript(script, { lines?, cwd?, timeoutMs?, mayBoot? }) — the design's wslpath script with the path on
  the next line breaks under dash.
- SA: bootIds() hashes the boot-id file's exact bytes (UUID + newline); the probe's boot value must hash the same.

## TG reviewed (sw/tg, f0ba3fa + dfb559c) — HOLD until RUN, SA, SC (and CL, SB) have merged
- Lead at TG merge: doctor rows ssh-client "No SSH client found" and remote-parts "Missing from this install" are "fail"
  per §8.8 → make them "warn" unless an SSH host is configured (a missing optional feature must not fail the check-up;
  the el8 packaging job runs `ember doctor` in rockylinux:8, possibly without openssh-clients).
- Lead: accept eaae251 (win32/system/environment.ts: unreadable elevation token counts as elevated; fail closed).
- SA: set notice: { sshDestination, userSshProcesses } in productionParts; Connections.stopAll() ends reconnects,
  cancels connects and stops every link; ConnectError "machine-changed" thrown before upload; onProgress(hostId,
  { step: "ready" }) after link(hostId) returns the new link.
- UI: onAnswer/onConsent fire only for the card shown via showCard(n)/showConsent(n); consent hash =
  sha256(title + "\n" + body.join("\n")); SSH card body lines within 2000 chars.
- AG/main: cancel tasks bound to a lost host; optional TargetsDeps keyHint and activeWindow.
- WB: check settings.targets.wsl.on before starting distro helpers.
- Open (small): askpass folder $XDG_RUNTIME_DIR/ea-* not in Ember's own paths (deleting it asks rather than refuses);
  a 7 s info bubble can clear a presenter bubble that replaced it.

## Merged: SC + WB (see git log)
## From SC's review
- SA: RemoteLink.request(op, args, {timeoutMs}) rejects with Error carrying code: ErrCode; sends requests in call
  order; a new onBytes(channel, fn) listener gets bytes already held for that channel (bounded per channel); link
  epoch increases on stop() and nothing older is sent afterwards (SC's stamp fix depends on it).
- TG: catch the throw from remoteTargetParts; dispose() when the link closes; don't send policy.sync itself; call
  refreshDesktop() before a task where it can.
- AG (lead at merge): onAuthorized with valueSha256 = sha256 of the request's value (String(n) for set_value, the app
  name for open_app); pass RemoteStepError/RemoteError messages through unchanged; quote app.name in "Opened …" /
  "Started …"; add RemoteRunExit.rules to stamp.rules when it re-asks.
- CL: pass trackSecretPrompts to createRemoteRunner in place of the stand-in tracker.
- SB: send desktop.changed with access "none" when the notice fails or the session goes inactive.
## From WB's review
- TG: stopWslHelpers() in the kill switch's "targets" part; wslHelperPids() into emberPids; wslHelperDoctorRows() into
  targetDoctorRows; wire turnOnLinuxAccessibility(wsl.runner(d), d) as the wsl-a11y fix; write targets.wsl.on together
  with its consent record (WB counts WSL as on only with consent recorded).
- WA: targets.wsl must be null when the admin turns WSL off.
- RUN/WA: settle the job host's stdin EOF semantics (design: EOF kills the job; WA's probes send a script then EOF).
- S0b's AtspiSidecar: a hostile distro could send endless lines (memory bound) — lead/follow-up.
- I-win follow-up: owner-chain pointer check and scancode text path before tier 3 in WSLg can be lifted.

## Merged: SA + SB, and ci.yml builds remote parts before every stage.mjs (lead)
## From SA's review
- SB: Welcome.machineIdHash = sha256 of /etc/machine-id's bytes (as the probe hashes it); hello answers busy/denied;
  agent accepts `serve --proto 1 --pc <id>` with `SERVE <pcId> <runtimeId> <partsId>`; remote-runtime.json in
  dist/remote-parts/; parts tarball with manifest.sha256 and ember-remote.cjs at its root. (check at integration)
- RUN: the real job-host.cjs (Windows ssh runs under it).
- WA: WslService.bootIds() = sha256 of raw boot_id bytes (WA matches); wsl-windows key + known_hosts set-up.
- TG: ask consent again on resolution-changed or machine-changed; forget the host after uninstall(); use hostIdFor,
  parseTypedDestination, sshClientRow.
- Lead: a .sh text loader in the build (bootstrap.ts holds byte-exact copies pinned by a test — fine as is);
  ship resources/ssh/ember_askpass.cs in the Windows package (layout.mjs); optionally export DEFAULT_GRACE_SECONDS from
  admin.ts; NSLocalNetworkUsageDescription mention of SSH computers (mac-bundle.mjs).
- Open: `busy` retries 10 min against another PC's lock (needs a field from SB); a loss from an unanswered Stop starts a
  batch-mode reconnect (§5.1.13) — lead decision: acceptable (batch mode never prompts).
## From SB's review
- S0a contract: Hello lacks a target id, so the remote can't check the decision's sha256 (contract change; follow-up).
- SA/SC/lead: hello may wait up to 25 s on reconnect (taking over this PC's previous agent) vs the PC's 20 s hello
  timeout — pick one (integration: raise the PC's hello timeout to 30 s, or the agent's takeover wait to 15 s).
- SC: handle console.stop (SC's review says it voids stamps on console.stop — check wired).
- CL: classifyCommand(text, shell, ctx) replaces SB's stand-in (until then every remote command asks once).
- RUN: launchArgv(spec, facts, o), commandEnv(base, o), sweepScript, localFacts(o), createLocalRunner(o) for inspect
  and gitFacts.

## DOC reviewed (sw/doc, acfb1f6) — HOLD, merges after TG; re-check against CL/RUN/TG code at the end
## From DOC's review (for INT)
- WRONG-TARGET RISK (fix in INT, safety): TG's resolve.ts rule 3 binds a named computer only with a colon/comma after
  the name, a place word (in/on/into/onto …) or "'s desktop". "build-01 delete build/" binds to the ACTIVE computer and
  D4.4 could announce-then-run "delete build/" there. Fix: when the user's words contain the name or alias of any known
  target other than the one the task is bound to, D4.4 never announces (every dangerous command asks, and the card
  names the target), and the bubble's first line for the task says which computer it is on. Unit-test it.
- Docs to re-check at the end: dangerous-class examples, refusal/announcement words, redaction list, timeouts, stop
  ladder, non-interactive defaults (against CL/RUN code); doctor rows warn (TG merge); WSL status wording vs §8.3; PLAN
  M12 statuses; "no remote.yml job has run".
- Owner: CLAUDE.md and .claude/rules on the apple-design branch (open PR #44) still forbid commands; owner decision 4
  overturns that — the owner's files need updating (draft wording for them).

## Merged: RUN (commandEnv also scrubs BASH_FUNC_*, CDPATH, SHELLOPTS, BASHOPTS, GLOBIGNORE, IFS — accepted)
## From RUN's review (for INT)
- CL: trackSecretPrompts(o: { interactive }): SecretTracker; spans() are UTF-16 offsets into the decoded raw output as
  fed (terminal codes and the start marker included).
- AG/lead: KeptRun.kept(): { bytes; omitted; secretSpans } and stragglers: Promise<string[]> (or add to types.ts).
- TG/main: createLocalRunner({ …, elevated: TargetsDeps.elevated, extraPath: TargetsDeps.extraPath(), ember.pids,
  jobHost: { execPath, script: <appDir>/job-host.cjs } }).
- WA: launchArgv(spec, facts, { jobHost, wsl: { exe, distro } }), commandEnv, startLadder("wsl-pty"|"wsl-pipe", ops,
  REAL_TIMERS); feed sweepScript to `/bin/sh -s -- ...sweepArgs(signal, runId)`; the sweeping shell must not carry
  EMBER_RUN_ID.
- SB: createRunner({ ...o, target, remote: true }). UI: stragglerText(names) for the status line.
- Design gaps (INT decides, smallest safe fix): WSL pipe runs can't get non-interactive defaults (WSLENV list is
  normative — add the fixed non-interactive values to WSLENV, as WA's reviewer accepted); WSL stragglers can't be named
  (sweepScript prints nothing — print pid+comm); local POSIX runs survive an Ember crash (document under L10, or add a
  parent-death watchdog in the launcher).

## Merged: CL (36334bd) — ALL 13 main packages merged; INT-A and INT-B wire them
## From CL's review
- AG: compute outputTaint(cleanOutput(raw, o)) BEFORE the output is cut to size; pass classifyCommand's
  ClassificationExtra (cwd, windowsReach) to decideCommand unchanged; probe only cls.probe.
- AG/UI: the card's "Why:" line, the remote's own-check lines and the output-taint wording.
- RUN/SC/WA: feed trackSecretPrompts text decoded as a stream (TextDecoder { stream: true }) so span offsets match
  shapeOutput's decoding; pass its spans in ShapeOptions.secretSpans.
- Open (accepted): branch names compared after stripping punctuation; taint's system: pattern over-matches (asks more);
  `pgrep ember | xargs kill` asks rather than refuses; git in a downloaded non-cloned folder may use its .git/config.
