# Seventh-round starting findings and dispositions

This appendix preserves the independent re-ratings of starting main **`36451257`**, followed by their
adversarial challenges. **Every finding source `file:line` below is pinned to that starting head**, not to
today's shifted lines, unless another head is expressly stated. Resolution test paths refer to the
seventh-round tree. Commands also compare against the separately pinned safety baseline `4d64d3a`.

“Fixed” describes the reviewed repair and its named regressions; it is not a claim that native devices or
every possible input were tested. P3s, native-only validation and explicit owner decisions do not cap 9.
Shared findings are repeated under affected areas without inventing extra defects. The starting reports'
shared suite totals are deliberately not added or presented as per-area totals. Later review-discovered
regressions and their repairs are recorded separately in PLAN §10.

## 1. First run and setup

- **first-run-r6-1 — P2.** `app/renderer/home/main.ts:206/209`, `copy.ts:487`, `index.html:25`;
  `app/main/main.ts:3751` permits an already-consented wake microphone before onboarding completes. Completing
  a consent update announces “Ember has started.” and focuses the bare brand heading. Built-page `a-probe.mjs`
  recorded both exact words and focus; no new native/acoustic result was claimed at the initial audit.
  **Resolution:** name-free announcement and accessible Home/setup headings, retaining visible branding;
  `test/integration/home-first-run-renderer.test.ts` and `test/integration/voice.test.ts` cover the named
  finding.
- **Challenger miss first-run-c7-1 — P2.** `app/renderer/home/welcome.ts:277/842` enables/saves Agree while
  the recipient is unknown. `challenge-consent-unknown.mjs` delayed provider-state only, observed the
  unknown-recipient summary, then an armed click saving consent. **Resolution:** unknown destination holds
  Agree; changed agreement re-arms and is reread at click; named real-renderer regression in
  `home-first-run-renderer.test.ts`.
- **Challenge correction / path to 9:** unknown-recipient consent was “larger work,” **not** an explicit owner
  exclusion. Both defects required repair; retain existing consent/Enter/Not now arming and provider host
  boundaries. Earlier arming/recipient fixes survived challenge.

## 2. Home window

- **home-r6-1 — P2.** `app/renderer/home/main.ts:285/289` derives Features from saved voice/command/host
  preferences. A rendered managed-policy/missing-model snapshot claimed Commands/SSH/listening unavailable in
  practice (`a-probe.mjs`, `home-probe.png`). **Resolution:** typed effective target capabilities,
  policy/consent and speech readiness; `test/unit/home-status.test.ts` and
  `test/integration/home-panes-renderer.test.ts`.
- **home-c5-1 — P2.** `app/renderer/home/main.ts:1321/1600` saves the displaced draft on Edit, then clears it
  after successful edited Send. Actual renderer reproduction: draft → Edit older request → Send leaves an
  empty composer. **Resolution:** restore the displaced draft with edit/ack ownership; named success,
  later-edit and exact-once Stop cases in `home-conversation-renderer.test.ts`.
- **home-r7-1 (home-c4-1/home-r3-1 carryover) — P2.** `app/main/main.ts:532/536` destroys Home; renderer-local
  draft/unsent recovery begins at `app/renderer/home/main.ts:1230`. Reload lost the draft (`a-probe.log`), and
  close destroys that renderer. **Resolution:** retain Home hidden for this run, clearing on existing
  account/privacy/lockdown boundaries; real Electron/mock-provider `conversation-history-live.test.ts`.
- **voice-listening-r6-1 — shared P2.** `app/renderer/home/copy.ts:59`, `main.ts:1623` automatically announce
  the name-bearing Thinking line. **Resolution:** listening's name-free copy; `home-said-names.test.ts` and
  voice phrase regression.
- **home-r6-2 — P3, retained.** `app/renderer/home/status-copy.ts:69` says restart under held lockdown, while
  `app/main/main.ts:2128` → `agent/composer-refusal.ts:40` says policy problem. Source trace confirms
  conflicting advice; refusal remains closed.
- **Challenge correction / path to 9:** the first policy fixture used nonexistent command/remote booleans and
  overstated initial voice policy: `app/main/admin.ts:251` already forces wake off.
  `challenge-effective-status.mjs` used real AdminPolicySchema/applyAdminPolicy/homeAdmin and still reproduced
  command/SSH false state; missing models and held lockdown also stand. No extra miss; effective state, draft
  restoration and session recovery were required, not owner exemptions.

## 3. Companion presence and Ask

- **companion-r7-1 / voice-listening-r6-2 — P2.** `app/renderer/ask/main.ts:309/351/414` forces field focus;
  `ask/index.html:12/17` labels/placeholders name Ember. Source and built accessible words verify the
  remaining automatic wake ingress; initial audit did not repeat native acoustics. **Resolution:** name-free
  Ask page/field/title and own-window fallback retained; `test/integration/ask-renderer.test.ts` plus
  listening's focus/phrase tests.
- **companion-r7-2 / voice-speaking-r6-1 — P2.** `app/main/personal/predict.ts:85`, `agent/host.ts:3053`,
  `agent/status.ts:125`: “Read it out” is offered for the current answer but changes future task-result speech
  instead. Source trace and the speaking matcher probe confirm the mismatch. **Resolution:** a local
  retained-answer read, without changing speech preferences/consent; `test/unit/host.test.ts`.
- **Challenge / path to 9:** both shared P2s stood; no new miss. Geometry, Read all lifetime, eligibility and
  question-room safeguards survived source/placement tests. Constrained-screen residual overlap/native click
  shapes were not falsely declared universally fixed or promoted without an unreachable control. Close the
  shared focus/action defects while retaining those safeguards.

## 4. Voice: listening

- **voice-listening-r6-1 — P2.** `app/renderer/home/copy.ts:59` exports the name-bearing Thinking line outside
  held voice statuses. Exact source/copy verification retained the prior acoustically demonstrated mechanism.
  **Resolution:** “Thinking… The reply will appear above.”; `home-said-names.test.ts`, actual renderer and
  production phrase probes in `test/integration/voice.test.ts`.
- **voice-listening-r6-2 / voice-listening-q6-1 — P2.** `app/renderer/home/match-copy.ts:10/17/18`,
  `home/main.ts:2663/2683` focus Teach after teaching/Forget with a name-bearing label/description;
  `ask/index.html:12/17` supplies another focused wake name. Verified focus wiring and accessible inputs.
  **Resolution:** safe labels plus dedicated current-state description before immediate/late focus;
  `home-voice-match.test.ts` and actual Home/Ask AX journeys.
- **voice-listening-r6-3 — P3, partly polished.** `app/renderer/home/match-copy.ts:16/29/30` contains
  name-bearing failure/timeout copy; initially source verified. Listening-unavailable/unclear-hearing prefixes
  now use first person (`home-voice-match.test.ts`); remaining visible ended/timeout polish is retained, while
  automatic focused descriptions are safe.
- **voice-listening-r6-4 — P3, retained.** `app/main/voice.ts:1570`, `home/index.html:464`,
  `ask/index.html:30`, `shared/listen-once.ts:47`: global “Request heard.” can be announced by both open
  controls. Producer/subscriber source path verified, not an extra request.
- **Challenge / path to 9:** held live regions did not sanitize an idle wake microphone's newly focused
  control. Both P2s stood; no new distinct miss. Preserve deliberate help, actual focus transitions and
  real-engine phrase checks, without claiming native reader/device timing or weakening consent/Voice Match
  approval boundaries.

## 5. Voice: speaking

- **voice-speaking-r6-1 — P2.** `app/main/personal/predict.ts:86`, `agent/status.ts:125`,
  `agent/host.ts:3054`: the actual matcher returned `loud` for “Read it out”; the host persisted speakResults
  and did not read the answer. Suggested, typed and transcribed requests share that path. **Resolution:**
  one-off retained-answer intent precedes future-results intent; named `host.test.ts` cases cover request
  routes and speaking-off policy, with explicit future-results control retained.
- **voice-speaking-r6-2 — P3, fixed.** `app/main/voice.ts:942`, `app/renderer/mic/main.ts:25` always waits for
  a new sample-health event while repeated false reports are suppressed. Source/consumer trace explains the
  second no-voice sample's timeout. Per-request reported health resets; actual mic-renderer regression
  recorded in the speaking package.
- **Challenge / path to 9:** actual matcher independently confirmed the wrong action; Stop speaking still
  preserved the written answer. No extra miss. Read only the requested answer through existing speech/approval
  policy, leaving settings and consent unchanged; native voices and pronunciation/owner choices remain
  excluded.

## 6. Tasks, approvals and Stop

- **tasks-approvals-c5-1 — P2.** `app/main/agent/worker.ts:1491/1543/1954`, `agent/activity.ts:202/216`: SDK
  start events keep ids but the serial tool wrapper/refusal drops them; ActivityLog falls back to the last
  running row. Actual probe starts one/two then refuses or denies one: row two changes and one stays running.
  **Resolution:** carry invocation identity through worker/public SDK boundary and refused/denied/picture
  events; `activity.test.ts` and `worker-tools.test.ts`, including absent/stale id controls.
- **Challenge / path to 9:** serial execution did not refute queued SDK start events; picture attribution
  belongs to the same repair. No extra miss; preserve question order, repeated-refusal folding and fail-closed
  approval sources while preventing any fallback to another call.

## 7. Safety, privacy and trust

- **memory-q6-1 — shared P2.** `app/main/commands/redact.ts:112/125`, `memory/guard.ts:1269`,
  `agent/project.ts:215`: literal MySQL passwords in compose/subprocess argv arrays remain visible and
  memoryRefusal returns null. Both auditors independently executed actual redactor/guard modules;
  Projects/task-view consumers share the boundary. **Resolution:** credential-array normalisation/redaction
  plus refusal, retaining credential-free/reference controls; `memory-audit-seven.test.ts`,
  `commands-redact.test.ts`, `project.test.ts`.
- **Challenge / path to 9:** this was not a command-line-only/UI defect and no cross-host key leak was
  claimed. Prompt-before-approval, screenshot preference, tool hardening, consent/held decisions and private
  data protections survived challenge. No extra miss; fix the shared array boundary without loosening any
  other secret refusal. Title-only authentication and explicit prior owner decisions remain excluded.

## 8. Commands, WSL and SSH

- **commands-remote-r6-1 — P1.** `app/main/commands/classify.ts:6193/6228` skips unresolved download URLs/names.
  `V=1; curl -LO .../run-$V.sh` then `bash run-1.sh`, or xargs URL input then bash, gave RAN/RAN with no
  markers. Challenger verified two real tool calls with a readable harmless script
  (`download-sequence-results.json`), not merely classifier RUN. **Resolution:** uncertain provenance persists
  across calls; `commands-audit-seven.test.ts`, `command-flow.test.ts`; named CSV → unrelated Python control
  still runs.
- **commands-remote-r5-2 / i5b — P2.** `app/main/commands/intent.ts:552/561/768` ignores root-of/on-place
  phrases: “At the root of frontend/, delete the build folder” announces cwd/build instead. Actual intent
  probe confirmed the wrong-object announcement. **Resolution:** ambiguous/unestablished places ask;
  `commands-intent.test.ts`.
- **commands-remote-r7-1 — P1.** `app/main/commands/flow.ts:760` and `commands/scripts.ts` read-through permit
  an ordinary command-line if where `4d64d3a` asks; exact HOME/PWD error-check expansions also loosen.
  Challenger expanded both bundled probes and confirmed the broader class; initial case totals differ because
  coverage expanded, not because the defect was refuted. **Resolution:** baseline flow questions restored;
  `commands-audit-seven.test.ts`, `command-flow.test.ts`, `remote-agent-gate.test.ts` and maintained
  `scripts/commands/compare.mjs`.
- **commands-remote-r6-2 — P2, OPEN / safety-constrained.** `app/main/commands/scripts.ts:251` retains
  loop/test fallback: ordinary `for ...; do cat ...; done` and `[[ -f data.csv ]] && cat data.csv` ask. Both
  probes ask at the pinned baseline too. No blanket relaxation is authorised; every unrolled pass and the
  no-looser rule must both hold. This remains the sole score-blocking P2; no 9 is awarded for it.
- **commands-q6-1 — P1.** `app/main/commands/classify.ts:3502` loses the command when an empty first option
  variable disappears: `O=''; redis-cli $O FLUSHALL` RUN/RAN on main and baseline. **Resolution:** preserve a
  question on the empty/unresolved operand; named `commands-audit-seven.test.ts` and actual flow cases,
  keeping own-file --rdb refusal.
- **commands-q6-2 / i6b — P2.** `app/main/commands/classify.ts:1018` returns without recording a relative
  script under an unknown wrapper folder. `env -C . sh < deploy.sh` ran and the flow never requested its
  script. **Resolution:** conservative unknown-script-folder question; named classifier/flow regressions.
- **Challenger miss commands-remote-c7-1 — P1.** `app/main/commands/classify.ts:3826/3850`: `ln -s ~/.config
  config-link; cat config-link/ember/settings.json` (or sed edit) ran when the link was absent during probing.
  Exact Ember-folder links already refused. **Resolution:** protected-parent and destination-relative
  symbolic-target guards; `commands-audit-seven.test.ts`, `commands-link-targets.test.ts`, independent
  classifier/flow controls.
- **Challenger miss commands-remote-c7-2 — P1.** `app/main/commands/classify.ts:3907/3927` treats nullable tar
  destination as absent/current folder. `d=~; tar -C "$d" -xf /tmp/x.tar` RUN/RAN. **Resolution:** unknown
  destination asks and extraction provenance remains conservative; named audit/flow tests.
- **Challenger miss commands-remote-c7-3 — P1.** `app/main/commands/classify.ts:3670/3705` consumes xargs
  process-slot-var as inert, then judges the child under the old environment. BASH_ENV=0 can source an
  uninspected file before `bash -c 'echo okay'`; harmless local demonstration and both probes verified it.
  **Resolution:** process-slot assignments/unknown abbreviations ask; named audit regressions and differential
  controls.
- **Challenger miss commands-remote-c7-4 — P1.** `app/main/commands/scripts.ts:408` discards script-loop
  uncertainty after one body pass. Scripted flow readers returning `for f in --hard; do git reset $f; done`,
  find -delete or later cd forms gave RAN. **Resolution:** retain script-loop questions;
  `command-flow.test.ts` and maintained script fixtures. No destructive script was executed.
- **P3 retained:** awk `NR>1` write classification; unknown-download build-tool wording; protected-folder
  Test-Path refusal (the user tracks these as commands-remote-r6-3/-r6-4/-r6-5). Initial classifier/Test-Path
  probes confirmed them; they do not justify removing the required safety questions.
- **Path to 9:** provenance, intent, wrapper/state and own-path gaps are repaired and both probes reject
  forbidden loosenings. Remaining ordinary-loop/test friction requires a solution satisfying both explicit
  constraints; native SSH/WSL/device validation and P3s do not account for the sub-9 score.

## 9. Copilot, models, providers, extensions and projects

- **integrations-c5-1 — P2.** `app/renderer/home/provider.ts:139`, `app/main/provider.ts:628` accept blanket
  404/no-list as a working replacement. Existing renderer fixture actually pinned that acceptance; a passing
  test was not a refutation. **Resolution:** unsuccessful edited-provider checks retain the working pair/card;
  deliberate real chat-only first-use route remains; `home-first-run-renderer.test.ts`.
- **integrations-r7-1 — P2.** `app/renderer/home/provider.ts:153/158`, `app/main/provider.ts:534` save agreed
  endpoint before key storage. Extracted adopt probe and independent real Chromium renderer both observed test
  → agree → saveKey failure, new endpoint active and held edit gone (`provider-key-failure.mjs/.out/.png`).
  **Resolution:** transactional endpoint/consent/key adoption and rollback; `provider-adoption.test.ts`,
  `user-provider.test.ts`, actual setup renderer failure/overtaken cases.
- **P3 integrations-r5-1/-r5-2 retained:** request-level secret location/copy is less precise than file+line
  refusal; some failure routes say “your model service.” Initial source review did not elevate them to lost
  routing.
- **Challenge / path to 9:** both P2s stood, with no observed cross-host credential leak and no added miss.
  Historical missing Electron was resolved during the audit, not a current blocker. Preserve project-local
  actions, redirects/key host binding and consent while retaining the old working service on failed/overtaken
  adoption.

## 10. Memory and personalisation

- **memory-q6-1 — P2.** `app/main/commands/redact.ts:112/125`, `memory/guard.ts:1269`: synthetic MySQL
  argv-array passwords survive guard/redactor in compose/subprocess snippets (`area-b-probe.out`);
  reference-only args are a non-secret control. **Resolution:** shared credential-array repair;
  `memory-audit-seven.test.ts`, `commands-redact.test.ts`, Projects/view consumers.
- **memory-r2 (still partial at start) — P2.** `app/main/memory/service.ts:179/184`, `memory/learning.ts:487`
  acknowledge remember/learn before the delayed write. Injected ENOSPC showed first “Remembered”, no save
  attempt, and only a later call warning. **Resolution:** staged durable writes before state/acknowledgement,
  truthful failure and recovery; `memory-durable-ack.test.ts`.
- **memory-q6-4 / memory-q6-5 — P3, retained.** `app/main/memory/guard.ts:1269/1274` is the shared decision
  boundary; exact bundled probes kept `Password: hashed, salted, <demo>` and a next-line Wi-Fi `Key: <demo>`
  form. These remain documented prose-shape follow-ups, not newly fixed by array parsing.
- **memory-c1-1 ambiguity — P3, retained.** `app/main/memory/questions.ts:418`; actual memoryAsk probe treats
  “Forget Jenkins” as forget while “Forget Firefox” is null; explicit “Remove Jenkins from memory” works. Do
  not relax memory authority to improve this score. Other historical q6-2/-q6-3 over-refusals and q6-6
  demo-assertion polish were retained, not newly claimed verified fixes.
- **Challenge correction / path to 9:** Forget (`memory/service.ts:290`) and correction already commit before
  replacing state; the first-write defect must not be broadened into every Forget lying. No added miss. Fix
  credential arrays and initial durable acknowledgement without losing old facts/indexes or weakening existing
  refusals.

## 11. Accessibility, visual design and copy

- **accessibility-r7-1 / first-run-r6-1 — P2.** `app/renderer/home/main.ts:206/209`, `copy.ts:487`,
  `index.html:25`: forced heading and Start live line contain the wake name. Actual built-page focus/text
  recorded; initial audit did not claim fresh acoustics. **Resolution:** shared first-run repair; named
  renderer and voice-engine regressions above.
- **accessibility-r7-2 / voice-listening-r6-1/-r6-2/-q6-1 — P2.** `app/renderer/home/copy.ts:59`,
  `app/renderer/ask/index.html:12/17`, `ask/main.ts:351`, Home Teach focus paths: sanitised live status does not
  sanitise focused names/descriptions. **Resolution:** shared listening copy, title and description/focus
  repair; current actual AX checks retained deliberate help.
- **home-r6-1 — shared P2.** `app/renderer/home/main.ts:285/291` displays saved preferences as capabilities;
  actual rendered mismatch above. **Resolution:** effective capability/readiness repair in Home.
- **accessibility-visual-r5-1 — P3, retained.** `app/renderer/home/status-copy.ts:54` recognises not-answering
  reconnect only with exact “Reconnecting…” suffix. Synthetic renderer/probe without the suffix returns null
  and conflicting connection guidance; it is not a newly observed native reconnect.
- **Challenger addition / correction:** first-run-c7-1 is also a shared accessible trust problem, not an owner
  exclusion; the initial-policy voice subcase of Home's finding was overstated, while production-shaped
  command/model/held cases stand. No area-local new miss. Mounted statuses, focus identity, key chords and
  forced-colour fixes survived challenge.
- **Path to 9:** close shared automatic wake and false-capability/unknown-recipient defects; P3 suffix
  sensitivity, actual native reader scheduling and recorded constrained-screen decisions alone do not withhold
  9.

## 12. Reliability, performance and platform

- **rp-1 — P2.** `app/main/platform/linux/environment.ts:86/89` synchronously imports pyatspi while its
  background import is pending, with a five-second production timeout. Existing test and injected-boundary
  `probe-start.mjs` demonstrated foreground blocking. **Resolution:** bounded async probe with explicit
  checking/unknown and awaitable doctor; `linux-accessibility-responsive.test.ts`,
  `platform-linux-system.test.ts`.
- **Challenger miss reliability-c7-1 — P2.** `app/main/platform/linux/environment.ts:79` synchronously reads
  gsettings on every accessibility status read, even after bindings are known. Independent
  `reliability-challenge.ts/.out` delayed that boundary and observed a queued Stop unhandled during the read.
  **Resolution:** cached/asynchronous GNOME and reader probes, unknown permission state and retry; named Linux
  platform tests.
- **P3 retained:** `app/main/helper-watch.ts:42/46` can briefly show an older Windows row after Check again's
  bounded wait; `app/main/perception/sidecar.ts:628` / `remote/mux.ts:728` retain protocol-version detail;
  `app/renderer/home/copy.ts:1652` crash notice gives a log path without its own action. Source/timing-path
  inspection supports polish, not a newly proved broken native journey.
- **Challenge / path to 9:** startup-only Python repair would not fix recurring gsettings blocking. Both had
  to become async with truthful pending/failure rows and Stop checks; retained run-marker/backoff/monotonic
  fixes were not refuted. Later candidate-only reliability-r7-2/-r7-3 (motion lookup/setup mutation,
  assessed on the later integrated candidate) are recorded in PLAN §10 and the named
  motion/platform regression suites, not mislabelled as initial-36451257 findings. Quiet footprint/native gate
  results remain separate validation.

## 13. Install, update, docs and developer experience

- **No P1/P2 established initially; challenger agreed.** Integrity-before-publication,
  interruption/lock/rollback, handover no-prune, proxy routing, update cadence and persisted known versions
  survived source and targeted launcher/update challenges.
- **install-docs-c5-1 — P3, retained.** `packages/npm/lib/launcher.mjs:475/659` exposes redirect-limit
  URL/technical text and non-space unzip errors. Source verified; errors report a failure, not an unchecked
  install.
- **install-docs-c5-2 — P3/native, retained.** `packages/npm/lib/launcher.mjs:1258/1259` doctorMac writes lack
  friendly cache-write wrapping. Source verified; no new native execution claimed. **install-docs-c5-3**
  remains a Windows temporary-log lifecycle validation follow-up; the initial reports supply no new line-level
  failing native reproduction, so none is invented here.
- **Documentation — P3, fixed.** `README.md:26` said about 600 MB versus the recorded 790–930 MB
  idle/listening measurement; `STATUS.md:5` omitted 9 November. Source-to-measurement/history comparison
  confirmed both; notes now match the recorded evidence, with `test/unit/docs.test.ts` guarding the memory
  wording. No fresh footprint measurement is inferred.
- **Challenge / path to 9:** no extra miss. Keep at least 9 while retaining checksum, update consent and
  release/credential owner choices; copy polish and native validation do not lower it. Initial report's broad
  suite totals remain historical evidence, not newly rerun counts.


## Post-publication refresh and CI findings

The initial post-publication title and fixture findings were discovered on candidate `a6d0cfa7` and repaired at
`8279381f`. Later discoveries and repair heads are identified separately below; a new discovery is distinguished
from a regression caused by the round. Final gate and reviewed-head status remain separate.

- **listening-refresh-1 / accessibility-refresh-1 — P2, fixed at the controlled title boundary.**
  `app/main/windows.ts:37` and `app/renderer/home/index.html:7` still called the focused Home window/document
  Ember. Consented Home activation focuses it while wake listening remains on. A fresh actual AX probe observed
  the focused/focusable Ember RootWebArea; production WASM with the Amy fixture emitted a wake and unintended
  utterance for a synthetic title/Home/Ready reading. Other voice/short-title controls emitted none, so this is
  a demonstrated supported path, not a claim about every native reader's announcement. Both titles now say
  Companion home. `app/main/policy/policy.ts:604` adds only this exact own-title alias, retaining legacy names,
  own-pid protection and the known-foreign-pid distinction. Actual current AX, constructor/policy, Electron
  close/reopen/privacy and native/WASM recogniser regressions pass with ordinary wake-positive controls.
  The independent re-rater and separate challenger closed the shared Home/Companion/Listening/Trust/Accessibility
  P2. Native reader ordering and application-name announcements remain device validation.
- **home-title-review-1 — P2 regression, repaired before integration.** The initial title package changed a
  macOS startup selector that observes the Handle, not Home. Review identified the mismatch; the repair restores
  the entire native macOS test file byte-for-byte to the published base. The second review verifies that restoration
  and the exact three-line runtime diff. No native macOS execution is claimed.
- **voice-ci-r7-1 — required speech verification blocked, repaired.** Initial draft CI failed four speech stages
  because default `scripts/voice/prepare.mjs` stopped after production assets. The new phrase regressions correctly
  refused a zero-speaker check. Removing the early exit fetches the existing SHA-pinned Amy test fixture by default;
  test assets stay outside production staging. A fresh production-only cache is red before repair, while actual
  required fixture/WASM/C API checks pass afterwards. Empty or incomplete required fixtures fail the new fast
  contract; optional absent fixtures still skip. Both regression reviews accepted it without reducing assertions.
- **voice-listening-refresh-2 — P2, fixed after two independent regression reviews.**
  `app/renderer/home/main.ts:2608` and `:2613` used active-only checks for the automatic voice live region,
  while `:2570` already defined starting/Listen once/enrolment ownership for the adjacent status holders.
  The full renderer stage observed Starting… during the protected interval. Five affected journeys then passed
  unchanged on current/main, but a controlled 1,400 ms starting hold reproduced the extra live announcement on
  both trees. The named in-repository actual renderer regression failed before the two conditions adopted
  `micHeld(v)`. Visible status, deliberate teaching prompts, post-microphone settling and exact-once behaviour
  remain. The signed repair `3a0a2b3d`, integrated at `d8feb328`, passes 145 related checks and the affected
  renderer journey; its full Natural file has six passes and an unchanged failed Mic sample poll, then only that
  sample passes unchanged in package/root controls. No deadline was changed or full-file pass manufactured.
  Listening and Accessibility received separate current-source re-ratings and challenges after both reviews.
- **integrations-refresh-c1 / extensions-refresh-consent-1 — P1, fixed and accepted after re-review.**
  On `8279381f`, `app/main/extensions/service.ts:193` checked only policy, the saved on switch and feature consent.
  Main called startup refresh before the general-consent brain gate. A valid persisted state with general version 6
  and current extension feature version 3 therefore probed saved HTTP/stdio servers and exposed cached tools before
  `hasConsent`. No ordinary historical migration into that state is claimed. Actual settings/store/service tests
  with injected probers fail before the fix, without a real server request or process. The integrated `e8642b28`
  service requires the current general agreement for initiating operations and session exposure, keeps later
  revocation/continuation barriers, and preserves Browse before the feature card after general agreement. The
  first review's cleanup regression and second review's late-output discovery were repaired before acceptance.
- **extensions-consent-review-2 — P1, fixed and accepted after re-review.** The second review of `fea91375` confirms
  that an actual hardened SDK post-tool hook still returns a late result after global revocation. This is an
  SDK-facing payload proof, not a claimed external send. Failed-tool hooks cannot rewrite the raw error and
  hook exceptions are swallowed, so unsupported output fields or throwing would not close the boundary.
  Further actual private-runtime/offline-model controls exercise retirement before either post-hook returns,
  renewed-agreement recovery and old-client ownership. A no-extension held describe_screen control separately
  proves the parallel global-loss path can send another model request (one to two) before its repair. The
  signed `ffb6ad6c` package therefore covers general runtime retirement as well as extension output and token renewal.
  The independent re-review accepts it: 13 unit and five actual SDK controls pass, in addition to the implementer's
  seven complete real-runtime journeys and 603 unique related controls. Transport closure precedes fallible observers;
  main-side pending work stops synchronously and agreement epochs fence held startup reads. The exact source is
  integrated at `e8642b28`. The final full gate, separate area scores and CI/review acceptance remain required.
- **reliability-refresh-c1 — measured P2 cap lifted after a new controlled pair, with historical failures retained.**
  The eight earlier raw CPU failures remain failed and their cause is unresolved. A later quiet pair using the
  unchanged WASM fixture passes its original limits on both main (14.7%, 886 MB) and `8279381f` (13.8%, 885 MB).
  An external observer captures all 13 actual counter intervals near 30 seconds and comparable thread costs,
  with no observation errors. The earlier current increase is not reproduced; no product patch, arithmetic
  adjustment or budget relaxation creates these raw passes. The independent challenger lifts the current
  journey cap on that evidence, with lower performance confidence and required EL8 native/WASM acceptance pending.
- **companion-refresh-1 — P3, open.** At 320 px/Larger the history-key capsule reaches about x328.5 and the page's
  scroll width is 329. The inspected render keeps Esc and the close words readable; no lost or inaccessible text
  was demonstrated. Record the bounded edge overflow rather than alleging clipping the evidence does not show.

Final fresh scores, six dimensions and all gate exceptions are in the companion review. CI and automated-review
completion must be assessed at the actual final head; these package results do not establish release readiness.


## CI wake diagnosis and reviewed repair, 10 November

Assessed integrated source: `446e1b47`, app `740790298da14b333e6abaf6b7c0d32603a1747c`.

- **listening-ci-r7-1 — P2, partly fixed and still open.** The evaluation's green job at `1ee46d69` reports
  14/46 synthetic bare-name misses and an inconclusive 5/78 ordinary-wake result (`eval/src/gates.ts:276`).
  At `1ee46d69`, `app/voice/engine.ts:191` discarded some early punctuated/decoder-repeat hypotheses before the full
  question could confirm its name. Two fixed synthetic WAVs fail first (two failures, six negative controls pass),
  then pass on native and WASM after bounded deferral at current `446e1b47` engine.ts:192. The final name rules are unchanged. A separate fixed
  220-input comparison improves ordinary misses from 5 to 1 on WASM and 4 to 0 on the C API, but bare misses remain
  7/46 and 8/46 respectively. These are different inputs from CI, not a retest that makes its 14/46 green.
  No negative accepted wake/request is added across the 96 negative inputs on either backend. Seven remaining
  bare cases on each have no keyword hit; native's eighth has a hit followed by the existing full-name rejection.
  Both final assessors retain the P2 and score Listening 8.8/8.7. An owner/native-only exemption is not established.
- **listening-ci-r7-2 — P1, fixed.** At `1ee46d69` engine.ts:1780, a pending ambiguous-name check cleared itself on an
  empty, punctuation-only or nameless complete transcript. Three finding-named controls fail on that source;
  two emit unrelated later Open the calendar words as a request and the third can emit the nameless question.
  This is actual engine-event evidence, not an observed model send. Current `446e1b47` engine.ts:1781 requires the existing
  positive full-name/standalone rules or Stop before clearing uncertainty; otherwise it ends the window. The
  first and separate second reviews accept the repair. The second review independently executes 160 transcript
  cases: 96 negatives emit no candidate request versus seven baseline requests, 48 positives work and all 16
  Stop controls stop without a request. Safety returns to 9.1/9.0; pre-repair P1-open scores remain historical.
- **listening-ci-review-1 — P3, fixed.** The first runtime review accepts the code but catches the new documentation
  attributing every residual native miss to the spotter. The actual native trace includes a detected name followed
  by Amber opened the terminal, which the unchanged bounded alias rejects. Signed repair `bfb4d11f` corrects the
  cause, preserving result counts and guards; the second reviewer verifies the correction.

The package adds only synthetic regression speech with pinned provenance/licence; production audio is not written.
The source comparison, actual tests, finite counts and residual limits are recorded in the main review. Both CI
workflows at the earlier head pass, but the automated code and security reviews fail to complete because their
paying accounts have exhausted usage limits. That external blocker is not a completed review or a substantive code
finding. The final available-head assessment cannot be called completed automated-review acceptance.
