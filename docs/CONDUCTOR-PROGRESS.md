# Conductor progress and remaining work

Software progress updated on 18 November 2026, following published checkpoint `5930bc4b` and its hosted results. The original submitted baseline was `audit/beta-readiness` at `76d0a2c9`; main remains `85b5bd56`.
[PR #262](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/262) contains the conductor, projects, named coding/desktop sessions, companion, isolated coding, approved public dependencies and encrypted drafts. Current-source Windows product acceptance is still required before authorized merge.

## Current software work on 18 November 2026

Published P8 `5930bc4b` again completed all fourteen strict product leaves at **24 of 46** (Node 18/20, WSL 4/24, encrypted-draft restart 2/2), with every ordinary CI job, all twelve preservation workflows and the registration contracts green. The same six leaves stayed red on both images, but two of them moved:

- **WSL source.** The corrected model fixture took effect on the hosted run: the first repair now reaches a done session at model step 4 with an idle turn and a successful command result (terminal stage 3, session 4, turn 1, summary kind 1, steps 4, command 1). The case then refused in the assertions that follow. Source review found the cause: the fixture's `tsc` build adds a new `dist` directory, and the exporter records a directory change in JSON, not the text patch, so `patchComplete` is false. The journey had copied `patchComplete: true` from the Node journey, whose check adds no directory. The expectation now matches the product, and the exported review must name `dist` (added, no conflicts) as its only limited change. This is a test correction; a hosted run must still verify it and the eight cases behind it.
- **WSL packaged.** The new project stage names the refusing step: stage 15, choosing the WSL option in the environment combo, on a snapshot read (operation 2) rather than after twelve Downs. Every guard there reports the same frame, so the follow-up records which guard refused (1–12) and the Down count (0–11) as one failure-only number from the snapshot already read. No UIA read, action, retry or deadline is added, and no cause is claimed yet.
- **Node packaged.** Unchanged: at the first command decision's readout focus, UIA focus stays on a Document instead of the Edit, while the last renderer record measured the command page as not visible although its window was foreground. The follow-up folds the last card's existing log records into one number (ever visible, visible last, went from visible to hidden) to tell a page that was never visible from one that became hidden, and both from a focus-ordering fault. The hosted run of `1890768e` returned visibility 5 on both images: the page was measured visible, then went hidden and stayed so. A foreground window whose page is hidden is what Chromium's native occlusion check produces when it counts Ember's full-screen overlay, no longer click-through while a question's buttons take the pointer, as covering the windows beneath it. Ember now starts Chromium on Windows with that check off (`disable-features=CalculateNativeWinOcclusion`, in the Windows platform layer only). This is one application runtime input changed outside the qualified graph; the hosted packaged run is its verification, and it is reverted if the page still turns hidden.

The same hosted run of `1890768e` moved WSL source: on both images the first repair passed its completion expectations and refused at phase 7, the review step, whose assertions had never run on Windows. Phases 19–22 now name that step's parts (patch preview, export, limited changes, continuation form). Packaged WSL on Server 2022 reported selection 112: on the first read, nothing under the combo read as selected. The follow-up counts what the snapshot held under the combo (descendants, selection items, the combo's value pattern and expand state) so the selected-option evidence can be matched to what Chromium exposes for a closed list, without guessing. Server 2025 stopped earlier, at phase 4 input, before project setup.

The hosted run of `278049b6` then showed:

- **Node packaged, Server 2022.** With native occlusion off, the command page stayed visible (visibility 3, card in view), both command decisions returned, and the journey reached the review step for the first time. It refused there after three model steps: the journey began its bounded Tab search for the result's button before the approved command had finished, and a result exists only once its session ends. The review step now first waits, within the existing bound the Stop case already uses, for Home to say Ready. Server 2025 stopped earlier, at a focus check on the provider switch (phase 4), as packaged WSL did there one run before the occlusion change; that intermittent stop is not yet explained.
- **WSL packaged.** Both images reported the same shape under the environment combo: no descendants, a value pattern, collapsed. Chromium lists nothing under a closed list, so no option can read as selected. The combo's own value, read in the same snapshot and matched exactly, is now the selected-choice evidence there; a listed drop-down still needs exactly one selected option. Focus, identity and the final commit-focus checks are unchanged.
- **WSL source.** The patch preview passed; the first repair refused inside the review export (phase 20) on both images. Its checks now mark phases 23–27.
- **WSL resources, Server 2025.** Case 1 refused during workspace assembly (stage 4, a refused workspace call), as it did at `0eecb62d`; it passed at `5930bc4b` and `1890768e`, and Server 2022 passed both cases. Not yet explained.

These changes touch fixtures, two workflows' failure reporting, tests and this document. The 146-file native graph, its verifier, the fixed producer and all application runtime/build inputs are unchanged. One product follow-up is recorded, not addressed: a new directory that only holds new files marks the whole text patch as limited, though such a patch could carry it; the exporter is in the qualified graph, so changing it needs requalification.

The paragraphs below describe the preceding checkpoint.

Published P7 `9586f31b` completed all fourteen strict product leaves at **24 of 46**: Node 18/20, WSL 4/24 and encrypted-draft restart 2/2. Both images now pass both WSL resource cases. Both Node packaged cases fail while exact native focus remains on a Document instead of the command readout Edit. Both WSL source suites reach the first repair's failed session after an observed successful command-result message and quarantine later cases. Both packaged WSL cases advance beyond consent/configuration to phase 6 project setup. Eight leaves passed, six failed; required product aggregates remain red. All twelve preservation workflows and 876 registration contracts passed. Windows UI/ZIP and macOS packaging checks passed; the PR records the remaining ordinary CI results.

A deterministic real pinned-SDK counterexample reproduces the WSL fixture's completion mismatch: after the controller accepts its first finish tool, the SDK requests one final model reply. The fixture instead emits a second failing finish tool and invalidates completion. The fixture correction returns prose only at its expected terminal step and after the exact fixed controller acceptance reply. It preserves prescribed action counters, refuses forged/wrapped or unaccepted replies, and does not change runtime completion. Real-SDK controls verify corrected success while premature finish and Stop remain unsuccessful. The hosted numeric signature matches the local baseline; the hosted first acceptance itself was not recorded, so native verification remains required.

Packaged WSL selection also used all descendant text as evidence of the selected distro. The correction requires one exact selected option in the same native combo subtree, fresh combo focus before selection-changing keys, and the same selected identity plus final commit-button focus immediately before Return. Unknown, partial, duplicate or changed evidence refuses input. Existing unguarded press callers remain unchanged. A separate cached stage distinguishes the existing phase-6 setup/send operations without additional UIA queries, actions, retries or budgets. Independent review closed the focus-drift and selection-change counterexamples before promotion.

A normal-sandbox Linux Electron ABBA comparison passed all four command-window load-order controls, preserving focus, visibility and host in-view evidence. It establishes no Windows/UIA cause or production repair. A separate qualified auxiliary Windows comparison is being prepared; its older renderer/preload provenance is distinct from P7 and cannot qualify product cases.

The local follow-up changes only fixtures, reporting, tests and this document. The 146-file native graph, complete verifier, fixed producer and all 757 application runtime/build inputs remain unchanged. Combined Root checks passed: full TypeScript over 1,579 unchanged inputs, all 616 affected cases across nine files with no skips, scoped lint over six TypeScript paths, YAML and whitespace checks. The previous build and normal-sandbox smoke retain exact runtime/build inputs; no Root build/smoke/SDK rerun is claimed. Three exact corrected-fixture real-SDK controls passed independently of the inert baseline/candidate comparison. A new exact-source Windows run remains required. The legacy native-SDK coding gate remains false. No merge, release, chosen-account provider or physical-laptop acceptance has occurred. The user's authorization to push and merge after green CI/CD and addressed review findings persists.

## Previous checkpoints

Published P6 `0eecb62d` completed all seven ordinary CI jobs, twelve preservation workflows and 876 registration contracts successfully. Its strict product inventory remains **22 of 46**: Node 18/20, WSL 2/24 and encrypted-draft restart 2/2. Seven of fourteen product leaves passed; the seven failed leaves and two required aggregates correctly block merge. Linux passed 23,079 unit cases, 322 integration cases and all 355 renderer journeys; its 39 unit and 856 integration skips are configured platform/feature exclusions. These results certify P6 only.

Both packaged Node cases now stop while verifying native focus on the command readout. Both WSL source suites reach the first repair's failed terminal session state and quarantine later cases. Server 2025 WSL resources stop during workspace assembly, while both Server 2022 resource cases pass. Both packaged WSL cases stop during environment configuration. The bounded cached observations do not establish these failures' causes.

The reviewed local follow-up adds failure-only numeric detail from reads already performed: packaged command target/focused control types and state, focus trajectory and window count; WSL workspace RPC entry/result/refusal and first-repair session/model milestones. Private runtime identities never enter reports and are discarded on stage exit or first capture. Independent controls corrected revoked-Proxy handling and observer access to hostile getters, connection objects and Promise hooks. Observations preserve existing connection, argument and promise identity, action sequence, deadlines, guard predicates and success qualification. Alternate or contradictory evidence remains unknown.

A separate portable reproduction found a packaged WSL fixture error: its 600 ms assumption treated the consent button's normal 900 ms arming delay as unread overflow, then tried to focus a fitting, nonfocusable body. The correction waits within the original bound for either the exact enabled affirmative button or explicit unread-body evidence. End input and the final guarded click require a fresh exact consent title, including unnamed-heading fallback, so a replacement card cannot inherit the earlier decision. This fixture finding is not attribution of the hosted failure; the actual Windows journey must verify it.

The complete 146-file native source graph, its verifier and the fixed toolchain producer remain byte-identical to their qualified versions. This follow-up changes fixtures, reporting, tests and this document; application runtime/build inputs are unchanged. Combined Root verification passed: full TypeScript over 1,579 unchanged inputs, all 587 affected cases across nine files without skips, scoped lint over 13 TypeScript paths, both YAML workflows and whitespace checks. All 757 application runtime/build source files and the built main bundle match P6 exactly, preserving its successful build and normal-sandbox launcher/Ask smoke; no new build, smoke, browser or SDK run is claimed. A new exact-source hosted run remains required. The legacy native-SDK `codingAvailable()` gate remains false.

The user has authorized push and merge after current-source CI/CD passes and review findings are fixed. GitHub's automated review services reported payer usage limits; they published no code/security findings or failing review check contexts. Selected independent source reviews have been completed; they do not claim a complete review of the entire large diff. No merge, release or physical laptop acceptance has occurred. This session's remote Linux workspace briefly disconnected and recovered with its files and completed test receipts intact; the user's Windows PC was unaffected.

Published P5 `1507dc70` again completed **22 of 46** required product cases (Node 18/20, WSL 2/24, draft restart 2/2), with all twelve preservation workflows and all 876 registration contracts passed. Windows 2025 resources advanced from phase 2 to workspace assembly at phase 5; Windows 2022 resources passed both cases. Both source suites advanced from phase 2 to the first repair's phase-6 terminal/idle/result boundary and quarantined their remaining cases. Packaged Node stopped in native focus: the Models & connections link on Server 2025 and the fresh second command readout on Server 2022. Packaged WSL stopped earlier at navigation/settings stages. These remain distinct unqualified product outcomes.

The local P6 follow-up corrects the packaged fixtures' activation order: it observes the exact foreground HWND before one SetFocus and verifies exact focus within the same existing ten-second budget. Current-run checks also precede activation and follow the fresh native snapshot. Portable controls reproduce the prior permitted asynchronous ordering and reject Stop/deadline changes; no Windows cause is attributed to them. The stale vault-barrier fake Host now initializes the same completion-plan Map as the real constructor.

A targeted independent source review found that new conductor callbacks could remain admissible after normal session idle. A conductor-local fence now requires an exact matched live user request and session lifetime at action admission, with synchronous retirement on idle, error, abort, Stop and model/session transitions. Inert fake-runtime controls distinguish the original and corrected boundary. Healthy-runtime reachability is unverified; already-admitted asynchronous work keeps its existing lifetime checks, and the SDK provides no per-tool turn identity. The review covered selected integration boundaries rather than the whole large diff. GitHub's automated code/security review could not complete because its payer reached review usage limits; those notices are not published failing check contexts.

The real offline SDK wait fixture also needed a more precise oracle: it previously confused completion settlement observers with its foreground waiter. The corrected fixture identifies the callback registered by the actual Host wait, retains both-worker/wire/disposal assertions and original deadlines, and passed on exact P5. Root will verify the combined final source. A separately attempted unbounded/default-worker full test run was terminated; it earns no pass or causal claim.

Failure-only numeric observations now distinguish WSL workspace assembly from the first repair's already-read session/turn/result milestones. Optional data requires an explicitly failed consistent report; malformed, contradictory, partial or missing evidence remains unknown. No new content, browser/native reads, authority, deadlines or success proof is introduced. All 146 qualified source pins and the complete verifier remain unchanged. The user has authorized merge after current-source CI/CD is green and review findings are addressed; no merge, release or physical laptop acceptance has occurred.

Published P4 `656dd12b` completed the full required product inventory at **22 of 46**: Node 18/20, WSL 2/24 and encrypted-draft restart 2/2, across seven successful and seven failed strict leaves. All twelve preservation workflows passed. Ordinary CI finished four successful jobs and three failures (Ubuntu, macOS and Windows), each first failing the same obsolete IPC test call: a generic string no longer exercises the validated command-card API. Windows nevertheless passed the full 198-case worker-tools file, including the pointer-fixture repair; its later build/native-app steps skipped. Registration failed during its unchanged 2.5-second C compiler setup; the ordinary Ubuntu C model separately passed all 256 cases. Source/setup bytes match successful preceding checkpoints, and the cause of the registration timeout remains unknown.

The actual Server 2025 packaged command failure now has a known, uncapped renderer observation: its second card was seen and armed and its DOM Allow enabled, while the last measured document was not visible or in-view. A separately cached UIA snapshot reported Allow disabled. These observations are not atomic and establish no causal repair. Server 2022 stopped earlier at provider focus, with unknown card evidence. Both WSL source suites failed their first phase-2 case and quarantined their tails; packaged WSL stopped at environment configuration; WSL resources passed only on Server 2022.

The local follow-up corrects the IPC harness using a valid legacy seen/in-view report while preserving its exact closed channel assertion. It also owns the dedicated CI WSL fixture through the proof with a guest pipe: readiness is observed before the proof, and terminal acknowledgement plus a genuine clean close are required before successful outputs. A portable real-service composition reproduces the idle-stop precondition gap; this is not attribution of the hosted phase-2 failures. The four-path fixture batch passed 171 affected tests and independent review, with all 146 qualified source pins unchanged.

A further actual-Host counterexample found that combined completion sealed membership before later accepted sequence/mixed sessions started. Independent review also caught ordinary finished-card expiry while dependent work continued. The fixed-slot/witness and fresh native readout changes have passed independent review and are integrated locally, with 217 and 368 affected portable cases respectively. They are not yet published or qualified. If a card disappears before its exact cleanup outcome can be observed, combined completion remains suppressed. Existing foreground-wait, explicit dismissal, source/owner revocation, cleanup and Stop behavior must remain intact. No physical laptop acceptance, chosen-account live-provider request, merge, tag or release has occurred.

The local P4 follow-up fixes a reproduced WSL first-use cycle: a fresh listing had an unknown default user, but execution readiness blocked the route that learned it. Explicit Home environment selection now checks an already-running personal WSL2 distro through the existing user-facts API, under current policy, command consent and project/account/folder/selection latches. Root and unknown users remain blocked, and no distro or coding command is started by this check. A host-derived **Check environment** action permits an explicit retry.

The follow-up also adds bounded numeric command-card observations so an actual packaged failure can distinguish renderer visibility, arming and host-seen state. Diagnostics cannot approve a command or update seen/in-view authority. Capped, malformed or unavailable evidence stays unknown; one held log read happens only before cleanup. Both the ordinal-cap and cleanup-only acquisition counterexamples were fixed before integration. The separate pointer fixture now uses bounded local virtual time and acknowledged input progression, preserving the real five-second tool wait and fifteen-second test bound; wrong-field, wrong-first-target and missing-final-target controls failed as expected on its unchanged semantic body. A local zero-case fork-termination failure is retained separately from its later positive exact-source run; no scheduling cause is claimed.

Current local checks passed: full TypeScript over 1,577 unchanged inputs (`2dcd0f08…`), 624 targeted cases across ten files with zero skips, the selected pointer fixture case with its other 197 cases explicitly filtered, all 38 coding-board browser cases, scoped lint across 25 TypeScript files, a rebuilt app from 757 unchanged runtime/build source files, and a normal-sandbox launcher/Ask smoke with the temporary helper restored exactly. The main bundle is `e1c4f723…`. These checks do not establish Windows product acceptance for this follow-up. Its first Type run had four narrow typing errors, corrected with erased assertions after existing runtime checks; those failed receipts are retained.

Published P3 `1df47927` completed at **22 of 46** strict product cases: both Node native/source inventories (18), both encrypted-draft restart cases (2), and Server 2022 WSL resource cases (2). Both WSL source suites failed their first case at phase 2, then quarantined the other eight; packaged WSL stopped at phase 4/provider focus on Server 2025 and phase 5/environment configuration on Server 2022. Packaged Node repeated the disabled second Allow on Server 2025, while Server 2022 stopped earlier at the UIA cold-compilation boundary. The Server 2025 WSL resource job was cancelled during setup before its proof started and earns no credit. Ordinary CI finished six successful jobs and one Windows pointer-fixture failure; all twelve preservation workflows and all 876 registration contracts passed. Missing packaged-app assertions after the skipped Windows build are not separate proven desktop behavior defects.

All 146 qualified pins and verifier `9674e7b0…` remain byte-identical to the actual P1 native proof. The next hosted run must qualify the complete current-source 46-case inventory and its ordinary/preservation checks. No live-provider account request, physical laptop acceptance, merge, tag or release is claimed.

Published product checkpoint `8d828cfb` completed all fourteen required product leaves: six succeeded and eight failed, with zero skipped leaves. Strict acceptance passed 20 of 46 cases: Node native two and source Home seven on each image, plus the encrypted-draft restart case on each image. Both packaged Node cases failed at the second Allow button, observed present, disabled and onscreen; each proof step lasted 84 seconds, below the five-minute journey bound. All six WSL leaves refused with child exit 1 and no outer timeout, but their inner phases and partial case counts were withheld. Those 24 WSL cases remain unqualified. Called workflow contracts passed 104 cases without skips; the draft aggregate passed while Node and WSL aggregates blocked release. All twelve preservation workflows and all seven ordinary CI jobs passed. A separate native-qualification registration job timed out its unchanged 2.5-second C compiler setup before any C model case executed; the ordinary Linux C step passed. Nine source/setup inputs matched successful P1 exactly; no cause or code repair is established for the registration timeout.

Source review separately found two resource-test setup errors: personal distros omit the optional `tool` field, and a fresh WSL service needs an explicit authoritative default-UID query. This test-only follow-up batch corrects those assumptions and projects bounded numeric failed-case phases; it does not attribute the hosted refusals to those source findings. All 146 qualified pins and the complete verifier remain unchanged. The separate native focus experiment at `c1b7099a` refused at startup on both images before any focus condition executed, so it supplied no activation-order finding. Passive startup diagnostics and a native comparison of Commands renderer state with UI Automation state are in preparation.

Earlier checkpoint `a0a7c707` added only bounded cached diagnostics for the two packaged failures. Its exact source passed
342 targeted cases, lint and the full 1,517-file TypeScript check. Its six Windows product leaves completed at
18 of 20: Server 2022 stopped at the second command decision's answer-button path, and Server 2025 at a project-flow
focus identity check after provider setup. The earlier
published 131-file qualification remains unchanged.

Published `106d1353` completed all seven ordinary CI jobs, including the actual Windows UIA suite's 24 cases.
Its [product run 44101175837](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44101175837)
passed 18 of 20 required Node cases: both Windows images passed two native and seven source Home cases, zero skips.
The packaged cases failed at distinct stages: Server 2025 at phase 4/provider setup and Server 2022 at phase 6/command-card
interaction; neither hit the outer timeout. These frames do not establish the exact failed assertion or a shared cause.
The ordinary UIA pass does not certify either packaged case or the unpublished integration.

The final combined source has 146 pins (4,238,624 bytes), manifest `91f162e8…`, with whole-verifier hash
`9674e7b0…`. Root and an independent reviewer verified all source bytes, the 116-input native closure and unchanged
worker recipes. Only the WSL readiness row changed from the earlier 146-file preparation. All live pins match.
Published `aa5345a9` qualified that exact graph in
[manual run 44117708730](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44117708730):
876 contract cases passed, and each Windows Server image passed 620 portable cases and all seven native modes,
zero skips. Root and an independent reviewer checked all fourteen exact-source frames, including the 32 C49
controls in each natural mode (13 positive, 19 denied, two DACL pairs), genuine Node exit 17, mode-specific Stop/output,
snapshot, unchanged seed and asset/private-tree/profile cleanup. This closes the fixed native asset proof, not Home
or arbitrary-workload acceptance. Published P2 binds all four product-proof tuples to that
qualification; its separate required product results are recorded above.

The earlier [WSL native run 44093857380](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44093857380)
at `b7e8e54b` passed its one real Windows-to-WSL case on each image, zero skips: non-root helper provisioning,
offline TypeScript repair, interop/socket denials, drained writer Stop, snapshot and cleanup. The new guest then
passed the same real boundary case on both images at `20300c71` in
[run 44110658272](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44110658272), zero skips.
Root and an independent reviewer read both completed logs and checked actual Stop, close, exit and canary assertions.
WSL runtime readiness now names that exact commit and run. This qualifies its isolation boundary, not public
downloads, Home, ZIP or draft acceptance. WSL keeps source custody, model access
and final artifacts on Windows; unknown host or guest cleanup retains the owner and blocks further work.

The public-dependency integration captures per-project opt-in separately from normal mode-sensitive approval
of each baseline or changed exact lock set before host downloads. Commands remain offline; private registries and
general fetch are unavailable. Encrypted coding-draft Save/Open/Forget and fresh-folder import are implemented
under consent 15. Opening is inert; old code/context grants no task, folder or execution authority, and work
requires fresh source checks and a new explicit request. Neither implementation yet has its complete Windows Home proof.

Two real pinned-SDK/public-dependency cases and five real Linux guest cases passed; these overlapping scopes are
not Windows product evidence. The local full unit attempt passed 22,783 cases, skipped 107 and failed two stale
source/workflow contract assertions. The corrected focused scope passed 379 cases; the full suite has not been
recertified. Renderer validation passed 145 cases and timed out one built named-session appearance case at its
unchanged 60-second bound. That focused case later passed alone (57 other cases unselected), and a subsequent full
four-suite run passed all 146 cases with the same source and original bounds. The prior failure and its unknown
cause remain. No load or CPU explanation is established.

New acceptance requires two resource, nine source Home and one shipped Home WSL case per image, plus a separate
one-case saved-draft source Home journey per image that restarts the real app and OS keyring. With the unchanged
Node two/seven/one inventory, the required total is 46 current-source cases across both images. P2 enables these
cases through the required CI caller and release dependencies; 20 passed and 26 remain unqualified at P2.
The earlier integrated source passed its full 1,568-file TypeScript check and 458 targeted cases with no skips, plus full
lint. The final readiness/pin batch passed a new full 1,568-file TypeScript check, 1,094 targeted cases with no skips,
a fresh app build and normal-sandbox launcher/Ask smoke; the temporary helper was restored exactly. Its portable
resource mocks now explicitly select closed or open readiness instead of depending on the production literal.
The preceding three fixture typing errors and one exact-comment contract mismatch remain in their failed
attempt receipts; those test-only corrections do not establish native behavior.
The existing Node two/seven/one inventories remain separate and unchanged. Portable tests and reviewed fixtures
are preparation, not execution of these new Windows cases.

At `20300c71`, the two required new workflow contracts passed 96 cases. All fourteen configured Node, WSL Home
and draft product leaves refused the closed proof gate before app execution; those refusals provide no product
qualification. A separate auxiliary branch at `2f194bbd` retains the old qualified 131-file graph while testing cached
button diagnostics and an observed runtime-focus departure after Tab. Its 383 portable cases, 18 board cases and
full 1,517-file TypeScript check passed. Actual Windows native/source leaves again passed 18 of 20 cases, but both
packaged cases failed at strict focus checks (focus flags 11, identity flags 59) in different paths. The queued-Tab
change has not established a hosted cause or repair. A separate nine-file native Chromium focus/activation probe
was subsequently frozen; its `only=focus` route is auxiliary only and does not relax the identity guard or qualify
required product cases. Its later startup refusal is recorded above.

The published P2 code/test composition is independently peer-closed across 17 paths, with all 146 qualified source pins and
verifier `9674e7b0…` unchanged. Its full TypeScript check passed over an unchanged 1,570-file catalog
(`1cd9d6c2…`); 553 targeted cases across 13 files passed, zero skips, and all 13 TypeScript files passed lint.
Consent expectations were updated: the focused two-case and whole 60-case views passed. The combined Root
browser gate passed all 78 cases across both files, with zero failures or skips and the original bounds.

Two separate preservation failures remain recorded. A Windows PowerShell UTF-8 case timed out at its original
15-second bound, then passed in the single same-commit job retry; its first stall is unexplained. An EL8 forced-WASM
speech case classified one synthetic refusal as assent. Twenty-four bounded local controls (sixteen user-rendition
and eight read-out variations) were all clipped and emitted no utterances. One full original forced-WASM file,
including the preceding cases, then passed 43 cases with one expected native-voice skip at unchanged bounds.
These results did not reproduce or explain the EL8 failure; its original clipped/tail state was not captured.
P2 includes failure-only bounded replay capture for those fixed public synthetic fixtures, with no recognizer or
runtime repair and no transcript upload. The speech failure did not demonstrate a tool authorization. Earlier
Windows and macOS ordinary jobs passed; final complete platform evidence is still required.

Automatic combined completion was published at `7830febd`. Two to eight tasks from the current request can produce
one tool-free synthesis after terminal results and cleanup settle. New intake, Stop and captured ownership/context
changes retire it. Settled foreground joins suppress duplication; existing questions and replies retain priority.
The feature passed affected units, two real pinned-SDK/local-provider cases and normal-sandbox app smoke.

The product is not merge-ready. Remaining software includes the packaged focus failures, speech investigation,
all 46 required current-source product cases, and affected Linux, macOS and Windows regressions.
No accepted live-provider credential is available; no chosen-account live request or acceptance is claimed. That
verification is not intrinsically Windows-only. Physical device acceptance follows the software work. Main remains
unchanged; no merge, tag or release.

## Historical 131-file qualification at `5b895638`

The following results qualify their named older source and do not certify the local 146-file integration.

WSL admission remains `false` with null proof metadata. Its first toolchain supports offline TypeScript projects
without external dependencies; public dependency acquisition is still separate work. The fixed native asset bundle
now has 104 inputs and its catalog expands from 125 to 131 files (4,131,699 bytes), manifest `3b1f1c4b…`.
The previous `c1fa3b27` proof qualifies the old 125-file graph only. Fresh
[manual qualification 44077815204](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44077815204)
passed at `5b895638`: 620 portable and all seven native modes on each Windows image, zero skips; contracts 256+620.
Root and an independent reviewer checked all fourteen exact source/Stop/snapshot/seed/cleanup frames. Both Node
product proof gates now name that 131-file qualification and whole-verifier hash `8dff6a53…`. This qualifies the fixed
asset layer only. WSL product admission remains closed pending its actual Windows-to-WSL and product proofs.
The merged candidate passed full TypeScript over 1,515 unchanged inputs, an app build, 256 C-contract cases and
867 source/workflow cases. Full lint and normal-sandbox launcher/Ask smoke also passed; its helper was restored exactly.
Both real Linux helper cases passed, including npm/TypeScript repair, child-process Stop and artifact cleanup.
Actual Windows-to-WSL and final product proofs remain required.
Earlier failed compile/check attempts remain recorded; later passes do not establish their cause.

## Historical checkpoint at `b294347e`

The following results belong to their named immutable heads. Use #262's completed checks for later product and
platform outcomes, rather than treating this checkpoint as a pass for a newer head.

At 04:34 UTC on 17 November, the qualified native asset proof completed:
[manual 44017447515](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44017447515)
completed on both Windows Server 2022 and 2025 at `546793a3`. Each passed 620 portable cases and all seven native
modes, with zero native skips. The exact source catalog is `bcf191c0…`, the verifier file is `a581968c…`, and the
reviewed producer is `b75c944d`, artifact `14289217635`. All fourteen mode-specific Stop, output, snapshot,
unchanged-seed and asset/private-tree/profile cleanup expectations passed. Both natural cases on each server
passed the C49 prelude's 32 DACL/data/create checks (13 positive, 19 denied, two DACL pairs) and genuine Node exit 17.

This closes the fixed asset proof, not the product journeys. The prior `71046f40` pair passed all seven cases on
Server 2022; Server 2025 passed its first three, then cancellation failed at phase 7/asset-close class 8 and retained
its graph, blocking later cases. That failure's cause remains unknown. The new Native-class WeakMap observations
are diagnostics; the later pass does not establish a causal repair or change the production security requirements.

Registration at `546793a3` passed 876 cases. Local gates passed 544 redaction/privacy cases, 157 cases for the Native model,
transfer and CJS, 207 probe contracts and 105 source cases. These scopes overlap and must not be summed.
For the `546793a3` tree, normal full Type checking completed with exit 0 and an unchanged 1,479-file catalog (`dfed…`). The prior
`46a68f2c` Windows unit step still records two Azure-budget failures: 2,096 ms against 2,000 ms and 313.1709 ms
against 300 ms, with 21,409 passes and 433 skips. The local redactor repair preserves every original regex and the
150/300/2,000 ms assertions. Finite profiles were mixed: the value run improved, but the final URL-only full profile
regressed. No CPU cause is established. At 04:45 UTC, the ordinary Windows job for `546793a3` completed successfully:
21,436 remaining units (433 skipped), 23 fixed-C cases (233 platform skips), two kill, 74 desktop, 44 speech and eight
Ember cases, plus build, smoke, UIA, ZIP and fuse checks. All 426 redactor cases passed, including the unchanged
2,000/300/150 ms assertions; individual hosted timings were not reported. That head's EL8, package, evaluation and
voice jobs also passed; Linux and macOS were cancelled with no failed step and remain incomplete, not passed.
This ordinary Windows pass does not replace the separate Node product journeys.

The separate 119-case source-binding preparation remained frozen with `ready: false` and null proof metadata.
Its reviewed copy and literal producer/proof promotion were published at `88e063c2`, after 119 cases, lint, YAML
checks and normal full Type checking (`58520`, unchanged 1,479-file catalog `ba9b8fce…`) passed. It authenticates
the verifier before running its actual 125-pin reader. The first enabled
[product attempt 44019676539](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44019676539)
failed all six extraction steps before app cases ran: the caller passed a relative cache path to a verifier that
requires an absolute path. The caller-only correction at `fb88ec25` passed 120 focused cases and full types.
Its [run 44021821323](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44021821323)
authenticated and extracted the producer in all six leaves, then failed source binding, again with zero product
cases executed. Actual Node controls reproduced the temporary workflow script's inability to resolve repository
`esbuild`. The repository-anchored correction at `5ba19a15`, included in `b294347e`, passed 121 focused cases,
lint and full types. The 125 source pins, source catalog `bcf191c0…`, whole-verifier hash `a581968c…`, producer and
strict report inventories are unchanged; a caller fix alone supplies no Windows product pass.

At `fb88ec25`, ordinary macOS, EL8, package, evaluation and voice jobs passed. Windows retained a Stop assertion
of 144.0222 ms against 40 ms; its cause is unresolved, and later packaging failures followed a skipped build.
Linux completed coding before an empty named-session review preview failed. Three separate deterministic browser
reproductions proved lost review gestures during row refresh. The repair keeps logical controls stable and verifies
a fresh review tuple after IPC, preserving retirement, authority and Stop fences. It passed 70 browser cases across
three files, 27 mapping/project units, one real Host/SDK journey, one normal-sandbox Electron journey, build and
full types across 1,480 inputs. All 24 built Home/review screenshots were individually reviewed with no visible
clipping, overlap or readability defect. These results do not establish the cause of the earlier hosted or local
empty-preview observations; a local diagnostic also passed without changing the earlier baseline's app source.

The broad parallel unit attempt was interrupted with exit 130 after 51 failed-case reports across ten files; it
remains incomplete. A controlled serial run at the same assertions and limits passed 21,840 cases, skipped 106
and failed one Desk listener test at 5,626.9 ms against 5,000 ms. The ten earlier failing files passed serially;
no CPU, GC or load cause is established. The test-only Desk correction supplies an empty `/proc` fixture for that
listener-only case, retaining its 20 real manager cycles, listener assertions and original deadline. All 29 Desk
cases and the final unchanged 1,480-input Type catalog passed. This is not a claim that the full suite passed.

At the `b294347e` checkpoint, main `85b5bd56` was an ancestor with no divergence, 196 candidate commits ahead and
a cumulative 529-file diff. #262 had already been retargeted to main and its bounded feature wiring reviewed.
No main merge, tag or release was performed. The first
[CI run 44031570588](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44031570588)
still had ordinary jobs active when this checkpoint was recorded. All six product leaves completed authentication,
extraction and the actual 125-pin source binding, then failed the development stager's fixed refusal before `npm run build`.
All app-proof steps were skipped, with zero product cases executed; the stager failure's cause remains unknown.
[Registration 44031570459](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44031570459)
failed with C compiler `ETIMEDOUT` at the unchanged 2,500 ms bound: 23 compiler-fact cases passed and 233 C-dependent
cases were skipped after setup failure; the native PR leaf was skipped. No CPU cause is established.
Native controller and file foundations on both Server images and toolchain
authentication had passed. Those preservation results do not certify the complete product or platform gate.
Earlier child/stock-Node/PowerShell compatibility failures remain failures; their native runs are explicit
[compatibility experiments](DEVELOPING.md#131-historical-windows-compatibility-experiments), with automatic portable contracts.

Before merge, require all three product journeys on both images (2 native, 7 source Home and 1 packaged Home case
per image, zero skipped), successful affected platform checks, chosen live-account verification and physical acceptance.
Directory rename, shells, npm, installation, networking and child processes remain unavailable in the Node subset.
No accepted live credential was supplied and no live model request was made; account verification is not Windows-only.
The product and platform gates remain cloud/software work. Dated failures below remain failures at their named heads.

## What was already implemented

- One text conductor delegates desktop work to per-task Copilot worker sessions. TaskManager schedules at most two
  workers, owns window leases and preserves the user's original request for policy decisions.
- The companion, Ask box, voice, task activity, approvals and Stop already form the desktop-agent experience.
- Projects already offers selected-file review, planning, patch drafting, explicit patch application and encrypted
  workspace checkpoints. These selected-file grants are separate from a native coding workspace.
- The submitted branch adds a native coding prototype, coding/desktop handoff, runtime probes and a Linux isolation
  experiment. Its entry points are intentionally unavailable because those probes demonstrate unresolved boundaries.

## What this follow-up changes

- Projects now has a project/session board: create and select projects, give each an objective, send an original typed
  request to the conductor, inspect delegated desktop sessions and outcomes, and stop an individual task. Live work
  prevents forgetting its project. Records remain bounded and in memory unless the user explicitly saves a checkpoint.
- Save/Open/Forget saved projects use an encrypted, account-and-provider-bound checkpoint with no plaintext fallback.
  Restoring replaces old task references and marks interrupted sessions stopped; it never resumes actions. A different
  provider credential cannot read the saved goals/outcomes. Forget everything removes the checkpoint. Current consent
  version 14 describes saved records and copied-folder reviews; returning users agree again. Changing the board does
  not automatically save it.
- The conductor can create/select/list projects and name each delegated desktop session. Project selection is captured
  when a request arrives, so switching projects while the conductor responds cannot misattribute its eventual tasks.
  The existing scheduler, approvals and original user words remain the execution authority.
- The conductor can run ordered desktop sequences of two to eight named sessions. It preserves the original request
  and selected project/computer, waits for successful completion and confirmed cleanup, and gives the next worker
  only a quoted untrusted summary. Stop, steering or an authority change retires remaining steps. Selecting another
  project for new work does not reassign an accepted sequence. This does not enable native coding.
- The conductor can join up to eight independent tasks it delegated or touched in the current request using
  `wait_for_tasks`, then summarise their observed outcomes in the same turn. The read-only wait lasts at most 20
  seconds, consumes no reports and starts no work. Card completion remains separate from positive post-disposal cleanup
  and handoff witnesses. Ordinary desktop cleanup stays best effort: summaries can be joined, but cleanup remains
  unknown and dependent success false. Stop, new intake, Forget or a captured authority change retires the wait. A real pinned-SDK
  test exercises two inert workers with held disposal and one combined reply, without another user request; it does
  not replace desktop or live-provider verification.
- Ordered goals and observed step outcomes now belong to the project record, including outcomes whose session rows
  have left the bounded history. Explicit checkpoints retain these plans. Opening remints record identities and
  interrupts live steps. Review remaining steps prepares an editable new request; it neither executes nor restores
  permissions. It skips only the contiguous observed-success prefix and preserves full oversized goals for individual
  review. Steering the final worker also leaves its original goal uncertain.
- The portable coding review formatter retains baseline, proposed and optionally current bytes, with hashes, binary
  contents, empty directories, executable bits and explicit conflicts/unsupported metadata. Conflicted changes stay
  out of the text patch. The Linux experiment now retains a baseline before execution, verifies namespace shutdown
  before result capture, and writes private review artifacts without modifying the original project. These are
  experimental APIs and fixtures, not the ordinary coding product flow.
- A host-only, listener-free model broker and pinned-SDK stdio adapter keep a synthetic provider credential outside
  the experimental runtime. They bind the destination/model/session, reject unsupported routes/transports and revoke
  streaming work on Stop. Offline real-runtime tests cover HTTP/SSE and native file work. Supported wire format is
  OpenAI-compatible chat completions; this does not implement the default GitHub credential protocol.
- A [bounded stdio proxy](CODING-RPC-FRAMING.md) now checks wire framing before the SDK receives runtime bytes.
  A real isolated-runtime fixture verifies the normal broker/edit/export path and rejection of an oversized declared
  frame before its body arrives. This bounds admitted wire frames, not decoded SDK object memory or all sandbox resources.
- The [Windows LPAC experiment](WINDOWS-LPAC-EXPERIMENT.md) implements native bindings and a suspended launch/private-job
  lifecycle for a small credential-free C fixture. It grants only fresh disposable objects, verifies LPAC identity before
  resume and observes contained descendants before releasing a stop receipt. Portable lifecycle tests pass; the new
  hosted-Windows enforcement test must pass too. This does not launch the Copilot runtime or implement Windows result capture.
- The cursor companion identifies a single task, differentiates queued/running/waiting/stopping work, and exposes
  fuller task progress through its existing menu description and hover text without taking keyboard focus.
- Native coding cleanup callers share the actual teardown promise, including failures. Coding work also has host-owned
  limits of 150 tools and 20 active minutes; permission/clarification waits pause the time budget. The legacy native-SDK gate stays closed.
- [Primary-source research](COMPANION_RESEARCH.md) compares Tiki, HeyClicky, Conductor and related projects.

## Custom-tool coding follow-up

The next branch uses a fresh trusted SDK controller with Ember's custom file and command tools. Its process and
session start in private empty directories; native SDK shell/edit/fetch, plugins, hooks, skills, extensions and
subagents remain disabled. This is necessary in addition to inspecting the advertised tool inventory: positive-control
tests demonstrated that an explicitly loaded plugin hook could execute without appearing as a tool.

Only copied project code enters the [isolated command workspace](ISOLATED-COMMAND-WORKSPACE.md). Credentials and the
controller remain in the trusted host. Commands pass through the existing command flow, approval modes, refusals,
audit and output redactor. Each Linux command uses fresh namespaces and has a real stopped-writer witness. File tools
operate through an exclusive handle-checked lease. Failed, fully observed checks can be repaired and rerun; an unrelated
successful command cannot clear the earlier failure.

Per-project folder grants, reviews and explicit full-file exports now connect Home and AgentHost. They
remain connection-scoped and are invalidated on account/provider changes, Forget and restored checkpoints. The original
folder is never written; exports contain all captured baseline/proposed files, including unchanged files. Consent 14
describes those data flows and retention. The legacy native-SDK coding gate stays false.

The Linux resource owner captures the original source's native identity before creating its coding copy and carries
that opaque receipt into the shared result registry. Moving or replacing that source before publication keeps the
review preview but refuses export, including export into the moved original. An unavailable intake receipt is never
recaptured from a replacement path. Source capture is drained before store close, and unverified storage cleanup
keeps coding unavailable after an ordinary Forget retry.

The conductor can give coding sessions the same bounded display names as desktop sessions. A name changes only the
project board label; the task goal, original permission words, captured project and folder remain separate. Offered
coding tools still check live availability before starting, and mixed handoff guidance appears only when that tool exists.

Finished, failed or stopped coding sessions now offer Review changes when exactly one retained result matches
that session's project, task and source. It opens the existing review without a model request or new work. The
renderer checks current session/result metadata again after the asynchronous read; Forget, replacement and navigation
cannot attach a stale review to another session. Opening from the still-focused session control brings the review
heading into view; navigation during loading keeps the user's focus. Closing returns focus to the current matching
session control.

The [explicit continuation flow](CODING-CONTINUATION-MATERIALIZATION.md) carries a reviewed result's complete proposed
files into a fresh coding session while preserving the original cumulative baseline. Home requires a new typed request;
the host pins its result, project, account and original source before waiting. Earlier task permissions never carry over.
Dependencies are captured anew, and the SDK conversation remains fresh. The actual sandboxed Electron journey verifies
both sessions, four command approvals, cumulative review, selective Forget, global erasure and clean shutdown.

Real-runtime tests demonstrate a failing Node test, private-copy repair, successful rerun and stopped review export
with unchanged source. A composed Chromium/IPC/Host/controller test covers that complete flow plus Forget/account
cleanup and explicit-export retention. An actual Electron journey additionally exercises the genuine preload and
sender guard, native command approval window, isolated commands, review/export, per-result Forget, the main Forget
everything handler and normal shutdown. Its model and native source/export picker selections are fixtures; live
authentication and the operating system's picker UI remain unverified.
Compatible preinstalled packages can be copied read-only, with explicit `.git`/`node_modules` source omissions,
validated manifests and dependency receipts. Packaged/native-provider verification and broader toolchains remain;
this is not a Windows-ready coding feature.

Complete-file privacy scans now run in a bounded trusted worker thread. Stop and global erasure await its actual
exit; an unverified exit prevents further coding. Forget everything also drains private copies, late exports and
trusted controller sessions. Failed older connection cleanup remains a barrier after account replacement, using
disposal-only receipts. Per-result Forget revokes pending access to that review without changing project history or
completed exports.

The [Windows file foundation](EXPERIMENTAL-WINDOWS-CODING-FILES.md) now underpins the separate files-only candidate
below. Its earlier native replacement failures have subsequent native coverage; they are not evidence that the host
resources are still absent. The separate [direct Node LPAC diagnostic](WINDOWS-NODE-LPAC-PROOF.md) still does not
establish useful Node compatibility: zero-capability LPAC startup reaches a libuv `WSAStartup` failure with code
`10107` and exits `0x80000003`, including with validated private standard handles. The compile-time
fixed libuv probe is a separate bounded experiment, not a Node runtime or
command backend. Windows commands and toolchains remain software work; server evidence does not certify client Windows.

The separate fixed C/libuv [draft #218](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/218)
now has positive feasibility evidence: [run 43814351971](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43814351971)
at `91de031c` passed 400 portable contracts (one privilege-dependent case skipped) and four native cases on each
Server image. The independent ordinary-host controls retained their parent's observed security context; stock LPAC
preserved the expected Winsock failure, while the separately built fixed program completed its local file, timer,
thread, work-queue and loop operations with verified cleanup. This establishes only that fixed program. Node startup,
normal child spawning and an actual coding command backend still require separate implementation and proof.

The follow-up also includes the temporary coding store in desktop command, GUI and integration own-data protection,
and denies Linux key-management syscalls in project commands. The latter closes a potential inherited-session-keyring
surface; it does not report an observed credential leak. Settings search prioritizes the names and aliases of settings
before explanatory project text, preserving Conversation as the first result for history.

## Earlier Windows files-only product evidence

The earlier development candidate introduced an explicit Windows copied-file backend through
`project-coding-backend.ts`. It does not require a local command service and never substitutes for a failed command
backend. Project/account/source grants, task disposal, private controller storage, native file tools, sealed review,
explicit export and Forget are connected. The controller exposes seven file tools, completion and the existing
optional clarification tool; native SDK execution and configuration loading remain disabled. Commands, test execution
and dependency installation are unavailable in this mode and are disclosed in the UI/tool metadata.
Linux retains its existing command backend. The legacy `codingAvailable()` remains false.

Exact head `0f70a7f7` passed the separate controller/product
[run 43812314219](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812314219) on both
Server 2022 and Server 2025: 97 portable cases, three native controller cases including the actual pinned-SDK contract,
and one real Electron journey per server, with zero skips. The journey used two fresh sessions and verified zero checks, unchanged source, explicit
export, selective/global Forget and normal exit in 13.267 and 14.744 seconds respectively. Actual Electron process
metrics confirmed the normal OS sandbox and absent Node globals; no sandbox bypass was used. Its provider and
picker selections are fixtures, so this does not establish live-provider or physical picker behaviour.

Native continuation at public head `7eabd077` passed
[run 43813240393](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813240393): 147
portable cases, 30 artifact cases, 23 sealed-copy/review cases and five resource cases on each server, 410 total
with zero skips. Complete prior files become fresh native inodes while retaining the original cumulative baseline;
source identity, account/project/privacy revocation, erasure and predecessor independence remain checked.

Continuation head `fac7c0a3` passed the real Home form and three fresh sessions in
[run 43812927368](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812927368).
Both Server images passed 97 portable and three native controller cases plus one actual Electron case, with zero
skips or failures. Electron completed in 16.393/15.970 seconds. Continue first read the prior proposal `43`, changed
it to `44`, and retained cumulative baseline/current `41`. Predecessor Forget preserved the independent `44` copy;
global erasure retained only completed `42`/`44` user exports. The normal OS sandbox, sender guards and unforced
exit `0` remained verified. Public PR #223 advanced to `7eabd077` with the same production source and
`canContinue: true`. That exact-head native matrix was green; its ordinary CI was blocked by the known Windows LPAC child-launch case.
Commands, live-provider and physical Windows acceptance remain separate; the candidate is not ready to merge.

The actual ZIP now has separate packaged evidence at `4db67491` in
[run 43817687919](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43817687919): one
native integration case passed on each Server image (about 15.2/13.1 seconds). The original extracted app retained
normal fuses, refused debugging, ignored the development provider, opened Home/Ask and handed over correctly. A
separate fixed source fixture used packaged Ember's supported Node mode and the shipped SDK/Koffi/runtime to edit
a private native copy, preserve source, record zero checks and verify SDK-child, controller, copy and privacy cleanup.
The original ZIPs are Actions artifacts for three days. This proves packaged launch/dependencies, not a live packaged
Home-to-Host coding session or physical client acceptance; see [development checks](DEVELOPING.md).

## What still needs implementation or verification

1. **Production coding isolation and toolchains.** The published 131-file Windows Node asset proof passed; the local
   146-file integration requires fresh qualification and complete product gates against its authenticated source.
   Resource/coordinator, stopped output and canonical transfer implementations are present. The optional WSL backend
   supports isolated offline npm/TypeScript work and approval-bound public lock sets; general downloads, private
   registries, arbitrary compilers and external or cyclic dependency links remain unsupported. Packaged
   Electron is not a substitute for a real Node binary. The earlier Windows child-process and PowerShell failures remain
   in the separate [native prototype proof](ISOLATED-WINDOWS-COMMAND-PROOF.md). macOS coding remains a separate extension.
   Do not enable coding by changing
   `codingAvailable()` or interpret a small native fixture as the production backend.
2. **Coding product integration.** Complete packaged/native-provider verification of per-project grants, real
   policy-controlled workers, stopped capture, review/export and lifecycle erasure. The deterministic composed flow
   passes; the legacy direct workspace/credential path remains gated.
   Automatic application additionally requires
   a demonstrated concurrent-writer contract and recovery, as [the copy-back design](CODING-COPYBACK-DESIGN.md)
   explains. Export-only review can avoid automatic source writes; an ordinary hash-then-rename cannot protect an editor.
3. **Recovery limits.** Explicit encrypted checkpoints and fresh-request continuation are implemented. Changes after
   the last Save are not recovered after a crash. Optional automatic checkpointing and workspace identity
   reconciliation need their own owner/revision/consent design. Checkpoints do not restore worker conversations.
4. **Richer coordination.** Independent tasks, bounded current-request joins and ordered desktop sequences are
   supported. A join can return settled observations within the current turn; an accepted sequence can continue
   without another turn. Two to eight current-request delegated tasks can now receive one automatic tool-free combined
   completion after their terminal outcomes and cleanup attempts settle, without another user message. A settled
   foreground join suppresses a duplicate summary; individual reports remain available for follow-up. The accepted
   run is retired by newer intake, Stop, Forget or a captured owner/context change. General
   branching dependency graphs, effectful future wakeups, dynamic replanning and persistent cross-session artefacts
   remain future work. Windows Node coding/desktop sequencing remains behind its product gates.
5. **Real-provider verification.** Offline mock-provider tests establish deterministic behavior, not successful live
   authentication, provider tool compatibility or useful task completion. Verify those on the chosen account/provider.
   No accepted live-provider credential was available in this environment, so no live model request was attempted.
   This verification needs the chosen account's sign-in; it is not intrinsically dependent on a Windows laptop.

The [Windows coding boundary plan](WINDOWS-CODING-BOUNDARY-PLAN.md) turns the isolation blocker into explicit native
acceptance gates. Its launcher, ACL/handle containment, whole runtime, toolchains and result traversal need actual
Windows enforcement evidence. Windows CI can test kernel primitives; a physical laptop is not a prerequisite for
writing those implementations or for all native tests. Neither a design nor a small fixture certifies the full boundary.

## What needs the Windows laptop

The [Windows acceptance checklist](WINDOWS-CONDUCTOR-ACCEPTANCE.md) exercises the complete desktop story plus native
UI Automation, foreground focus, cursor takeover, global Stop, mixed display scales, keyboard layouts, real microphone
and speaker interruption, lock/recovery and account changes. Record exact commits and observed app outcomes.

The laptop can validate desktop sessions now. The Windows milestone combines the implemented project/session
board, bounded coordination, explicit checkpoints and review/continuation with a usable isolated command/test
backend for a declared supported toolchain, live-provider verification and the relevant native acceptance checks.
Hosted Windows can advance the command backend before laptop access. Main should remain unmerged until the
six Windows product leaves, affected platform checks and live/native acceptance requirements have completed successfully.

Earlier software diagnostics retain their failed outcomes. The creator-owner
[fifth matrix](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43927686126) passed the
fresh staging-metadata correction on both Server images, then failed replacement with exit 212/error 5 after
temporary-file preparation. First Stop/revoke/private readback and the four in-run ACL denials passed; full useful
completion and final cleanup were not established. The separate Node single-process
[third matrix](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43923940767) passed both
ordinary-host controls but still exited 1 in LPAC without a report or output. Removing its exact earlier discovery
refusal did not prove module loading. These diagnostic drafts remain separate from the integrated product and do
not establish a laptop-only remaining checklist. See the boundary plan for the finite command milestone and bridge.

The later explicit module-resolution [experiment #245](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/245)
passed [its first matrix](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43932197397) on
both Server images. With the two documented preserve-symlink flags and explicit single-process test isolation, the
fixed CommonJS import, async read, timer and Node test completed with exit 0, empty output, genuine job Stop and
known cleanup. The earlier unflagged failures remain unchanged. This is useful compatibility evidence for a declared
invocation, not command-backend integration. The later output and transfer foundations below advance that bridge;
complete Windows Node/product journeys remain unproved.

The separate ordinary-host [POSIX replacement control #254](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/254)
at `dc8b4cc4` passed [manual run 43949773571](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43949773571)
on both Server images. Both unpinned and metadata-pinned regular targets replaced through FileRenameInfoEx with
flags 3. The old pinned object had links 0 and DeletePending 1; identity, security, streams, source matching,
root-only Stop and known cleanup passed. The original failing LPAC proof is unchanged. The separate full LPAC
[witness #256](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/256) at `8c893a52` then passed
[manual run 43956921968](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43956921968)
on both images. Each passed 405 portable cases (32 Linux-only logic skips) and the native case requiring all eight
operations, twelve protected and three revoked-work denials, four host ACL controls, four in-run ACL denials,
genuine Stop/revoke, stable snapshot, unchanged source and complete tree/profile cleanup. Both receipts match the
reviewed source manifest; no retry or assertion change occurred. The regular-file Node adaptation is implemented
and its actual SDK ABI preflight passes; the source build below supplies an authenticated artifact, with native
execution/product validation still required.

The corrected bounded-output foundation [#249](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/249)
at `e9deced4` passed 1,801 focused cases and full types. Its separate fixed C witness
[#252](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/252) passed
[manual run 43948135820](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43948135820)
on Server 2022 and 2025: 201 portable and three actual native cases each. Natural exit 17 retained complete output;
overflow and explicit cancellation caused genuine automatic Stop before completion was requested. Every case
verified stdin EOF, live output, drained pipes, snapshot/unchanged seed and complete known tree/pin/profile cleanup.
This is a C output/lifecycle proof, not a Node or product execution result.

The disabled canonical transfer foundation
[#251](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/251) at `d526b644` implements complete
privacy-scanned input, authentic stopped/output-closed snapshots, one-shot claims and fresh-root adoption against
the original baseline. Final 55 affected cases and full types passed; earlier aggregate failures are disclosed in
its validation document. Its hosted files, artifacts and controller workflows passed. Ordinary CI passed 20,797 Linux
units, the existing integrations and RHEL/package/evaluation/voice jobs; Windows retained the old stage-18 failure,
and macOS was cancelled rather than passed. Actual native transfer remains to be exercised. The fixed asset packaging foundation
[#253](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/253) at `f934068f` passed 113 portable
and six real pinned-artifact checks plus full types. Its dedicated [asset workflow 43948837888](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43948837888)
also passed; ordinary CI passed Linux/RHEL/package/evaluation/voice and macOS (19,456 units), with only the old Windows
LPAC failure. Packaging supplies no native execution authority. Those results preceded the dedicated native asset
owner and Node-only workspace below; authentic cancellation and composition are implemented, while native product
verification remains unfinished. The disabled native owner [#257](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/257)
at `5ef8b2fc` passed 1,104 affected cases, 90 final focused cases, full types and source review. Ordinary CI passed
20,547 macOS and 20,497 Windows units; the Windows job still fails the old LPAC fixture. Full default-factory
coordinator composition exposed shared-task cancellation before output matching. Its correction is now published
at `46fed893`: exact returned-child authority permits only authenticated Stop, output drain and prepared-grant
revocation, with no Resume or execution claim. It passed 1,142 affected cases, full types and independent source
review. That correction's head also passed 20,585 macOS and 20,535 Windows units; its Windows job failed the old
LPAC fixture. Actual native asset/parent enforcement remains a separate proof gate. The existing
five-second timeout and initial typing failures remain disclosed in that foundation's validation document.

The unregistered Node coordinator [#259](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/259)
at `68860d55` composes the real canonical copy, native assets, stopped output and one-shot adoption. Its disjoint
local gates passed 1,248 cases across 27 files and full types; hosted regression checks passed all six existing
Windows controller, ZIP and files-only Electron jobs. Those jobs do not exercise the new Node command path.
Initial Host/resource integration in [draft #262](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/262)
kept both reviewed Windows prerequisites closed. The protected-ancestor allocation conflict is corrected
with a narrow, one-use owned-parent capability while preserving the full protected set. Independent review is
closed on the six runtime modules, including namespace uniqueness and cross-input refusal. Workspace-first,
resource-first and platform-first import regressions now pass. Atomic request intake keeps commands-off requests
file-only and prevents later enablement or failed Node startup from upgrading them. Local gates passed 74 runtime,
14 resource/readiness, 68 controller, 53 host, three actual SDK/model and twelve Linux SDK/isolation cases; these
are separate scopes, not a single non-overlapping total. The application build and one normal-sandbox Linux
Electron journey passed (13.10 seconds). At `8f12ec82`, final integrated types passed across all 1,469 sources/declarations after
the packaged-test naming correction, native harness provenance fix and legacy file-only packaging job correction.
The native harness now reads fixed installed Electron metadata and a bounded PE prefix without executing Electron's
index or accepting its executable override; 49 focused cases passed. The old file-only ZIP recipe and its unchanged
assertions remain separate from the strict Node product/release gate; 30 workflow contracts passed. Source Home and
ordinary packaged Windows UI journeys have reviewed test implementations but no Windows execution receipt.
Full Linux CI at `8f12ec82` passed 21,181 units and found two stale release/import fixture expectations; their
correction passed 281 affected cases and is published at `fbbac1f4`. Completed Windows logs also showed 51 resource
model failures from a test spy calling itself when node:path and win32 alias. A same-object control reproduced the
RangeError; the new regression was red before the module-initial predicate capture and passed with that fix.
Its 249 affected cases passed; test-only correction `4de1889b` and its seven successful ordinary jobs are recorded
in Historical verification below. The earlier full remote matrix and six existing
controller/ZIP/files-only Electron jobs also passed. Cancelled or unfinished jobs are not passes. The six required
Node-product leaves still refuse the closed reviewed-producer prerequisites; regression successes do not certify
Windows Node execution.

The additive four-patch Node producer [#260](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/260)
preserves the three reviewed startup patches and adds the fixed POSIX regular-file rename operation. Six distinct
exact-head hosted attempts have failed their mandatory ABI preflight; none reached vcbuild or produced a new Node
artifact. The launch correction established compiler entry, and C11 probe correction passed the first SDK target.
Diagnostic [43982542556](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43982542556)
at `0a192d0b` identified target 2 C2220/C5287 at exact public copied-fixture line 26, even with both enum casts.
At `e56aa8c9`, that comparison was replaced with separate real compile-time assertions that adapter and SDK values
each equal literal ABI class 22. Both equality and fixed numeric value remain required; SDK/private 23 negatives
fail. Headers, source adapter, flags and warning policy are unchanged. Its 352 local contracts, full types and 234
registration cases passed. One [ABI-only run 43984400533](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43984400533)
passed both actual SDK targets, fresh x64 COFF and source/tool/recipe checks under C11. The separately issued
ABI-only route produced no artifact. One subsequent same-head
[full source attempt 43985674098](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43985674098)
failed at identify-tools, before ABI or vcbuild in that fresh attempt. The prior SDK pass remains valid, and the
identify-tools failure's cause remains unexplained. The fixed checkpoint observation and both actual SDK/C11/fresh-COFF
preflights then passed at `b75c944dec58973d157542e2d4d2db3720667982` in
[43989502028](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43989502028).
The one observed [full source build 43991252195](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43991252195)
succeeded at that exact head, with 232 Windows portable cases passing and 32 skipped. Artifact `14289217635`
is independently statically authenticated: archive/API provenance, four members, exact receipt/recipe/patch inputs,
two fresh COFF objects, x64 PE and license checks agree. Hosted staging then passed 113 portable and six actual
staging cases. Authentication did not execute the image. Consumer Node execution within the later phase-5 failure
is unknown; static authentication and staging are not a native/product pass.

The native asset proof [#261](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/261)
retains all four failed V1 native pairs. A separately issued V2 at `bcce66ad` added identical-owner/DACL Low/Medium
control pairs and corrected the disproven private-parent positive assumptions, without changing production rights.
It passed 562 local/registration cases, full types and source reviews. Its one
[pair 43983628743](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43983628743)
failed on both images: each passed 363 eligible portable cases, then first natural C305 at prelude 11/probe 7/2/1;
later cases remained blocked. Actual production parent/root/image security-right outcomes remain denied/read-only.
The new Medium full-package controls allowed all three security rights, so V2 did not establish its MIC claim.
Read-only inspection found missing C-token integrity/policy attestation and an explicit Medium executable label.
The subsequent actual held-C-token observation (C49) measured Low integrity, exact attributes `0x60` and mandatory
`NO_WRITE_UP` on both servers. It disproves the earlier Medium/OFF-token lead; the V2 failure remains a failure.

V3 `e13766e22d8181cee83b8cc6612dc533f08acb99` replaces the incorrect control expectation with direct
`FILE_WRITE_DATA`/`FILE_ADD_FILE` (`2`) controls: Low positive, Medium denied. Production security-right denials and
rights remain unchanged. [Registration 43994410142](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43994410142)
passed all 783 cases in separate 264/519-case gates, with the original 2,500 ms compiler bound unchanged. The earlier
`e65` compiler `ETIMEDOUT` remains recorded; no CPU cause is established. The one first
[V3 native pair 43995186426](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43995186426)
failed on both servers against the earlier pinned Node artifact. Each passed 519 portable cases but closed zero
of seven native cases: the first natural case failed with genuine C405 at phase 4/prelude 11/probe `[7,4,1]`.
All four direct data opens returned positive (`1111`), including Medium full-directory `FILE_ADD_FILE`; the required
Medium denials were absent despite the authenticated held primary token being Low with exact `0x60` attributes and
`NO_WRITE_UP`. The original 24 security-right assertions, failure retention and later-case blocking remain unchanged.
No causal MIC differential, V3 native pass or complete Windows Node product proof is established; the failed
assertions remain failed. Microsoft's [AppContainer guidance](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
permits access to Medium-or-lower objects when both user/group and package ACEs grant it. V3's expected Medium
denials were therefore invalid for this AppContainer case. V4 uses fresh all-Low controls comparing package RX with
FA DACL grants on the final product source graph. It retains the original production denials and makes no MIC-defense claim.

The first [V4 pair 43998770804](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43998770804)
at `5f1cf38917f8286d225d8bbb428d4c301051799e` failed on both servers. C49/prelude 14 passed all 32 actual
DACL/data/create controls, genuine C Stop, EOF and post-control readbacks. Both then failed phase 5 with outer
Copy class 1. Zero full cases closed, later cases stayed blocked and the private graphs remain retained;
asset/private-profile cleanup was not established. Cause remains unestablished, and Node execution within phase 5 is unknown.

Published `0553e412` adds bounded Node checkpoints `0..7` and inner classes `0..8` in four probe-only files.
The C program, runtime/native implementation, guards and bounds are unchanged. Its manual contracts passed all
828 cases. The one [diagnostic 44001782995](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44001782995)
failed on both servers after 572 portable passes per image. C49/prelude 14 and all 32 Low DACL controls passed
again, but phase 5/outer Copy class 1 remained, with identical Node checkpoint `6` and inner class `0`.
The factory returned a genuine suspended Node PI and the ordinary image/pin attester completed. Failure is after
that attester ends and before Copy launch resolves a RunRef; the remaining interval includes creator capture,
output matching/activation, automatic Node asset attestation and Resume. No particular cause is established.
Actual Node Resume/execution and full cleanup remain unknown: zero of seven full cases closed, later cases stayed
blocked and graphs remain retained. At that head, the reviewed seven-case asset proof was still required on both
images before exact product prerequisites could become ready.

At `d68bbdea`, [44007986934](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44007986934)
fully passed the first natural case on both images: C49, Node exit 17, stdout/stderr and stdin EOF, 13 positive/19
denial checks, two DACL pairs, genuine Stop/output closure/snapshot, unchanged seed and known asset/private-tree/
profile cleanup, including emitted CJS. The second natural-default case failed at phase 2/class 6 before C or Node;
five later cases stayed blocked. Each image had one pass and six failures, with private graphs retained.
At `71046f40`, the default-parent witness omitted the earlier explicit empty SACL. Server 2022 passed all seven
native cases; Server 2025 passed natural, natural-default and overflow, then cancellation failed at phase 7 with
asset-close class 8. Later cases stayed blocked and the graph remained retained. The cause remains unknown;
`546793a3`'s later complete pair does not retroactively make these failed suites pass.

The separate worker startup correction [#258](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/258)
at `bec2e6ad` preserves genuine native/artifact/seed cleanup uncertainty when a factory rejects before returning a
workspace. It passed 21 worker cases, full types and build; its hosted controller workflow passed all six jobs,
including both files-only Electron journeys. This prevents a retained owner from becoming a positive disposal or
safe handoff. It does not enable the Windows command backend.

The separate [observer ABI control #246](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/246)
passed [run 43935627569](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43935627569):
648 portable cases and 96 ordinary-host comparisons of six wrappers using the exact original object. Independent
verification checked the five public artifact members, source/build recipes, object digest, report and PE imports.
This proves those fixed control cases, not LPAC execution or general observer admission; the original emission
refusal and `nativeEmissionReviewed = false` remain unchanged.

Automatic checkpoints, general dependency graphs, future wakeups, automatic source writeback and macOS coding
are separate extensions. They do not add requirements to this Windows milestone; the implemented limits must
remain explicit in the product and acceptance results.

## Historical verification

Current readiness is summarized above. The following receipts retain each named head's results and failures.

At `d68bbdea`, all seven ordinary jobs in
[CI 44007596118](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44007596118)
eventually passed. At `46a68f2c`, the Windows unit step instead failed the two unchanged Azure budgets recorded
above. The first local repair gate passed 542 cases but failed two semantic checks: an added checkpoint changed
short output from 86 to 87 steps, and a new test wrongly expected a Vault value to remain plain. Correcting the
between-window yield and the new expected value produced 544 passes without changing any timing limit.
Finite Node 22 profiles measured the value run at 971.89 ms before and 555.23 ms finally; the final URL-only run was
792.97 ms against 659.49 ms before. These observations are retained without a CPU/load explanation or a blanket
performance claim. An initial probe-model gate separately passed 205 and failed two cases (an unchanged five-second
timeout and a new synthetic-hash fixture error); the corrected 207-case gate passed at the original bound.

At `5f1cf389`, ordinary Linux, Windows and macOS jobs failed only a stale `docs.test` expectation; the other four
ordinary jobs and all separate preservation matrices passed. `0553e412` corrected that expectation with 87 focused
cases passing. Its completed [CI 44001406593](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/44001406593)
passed six ordinary jobs; macOS alone failed the unchanged 150 ms key-value redaction assertion at 243.570209 ms.

At `4de1889be1829f1c07c88ba0ffbbbc2902959ca8`, all seven ordinary jobs in
[CI 43988264446](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43988264446)
succeeded. Linux passed 21,184 units (38 skipped), 319 integrations (769 skipped) and 314 renderer cases; Windows
passed 20,785 units (433 skipped), and macOS 20,835 (387 skipped). RPM/package, RHEL, voice and evaluation jobs
also succeeded, as did the separate preservation matrices. Its required Node product leaves remained closed.
These are historical head-specific results, not a pass for the latest pending CI. The earlier RHEL Save-button
failure did not recur; its cause remains unknown. Skipped cases remain unverified.

The earlier integrated product candidate [draft #247](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/247)
at `a970a98388d8f8df3e805a518c498571cb37335b` added literal `run_node` arguments to the existing guarded command
flow, including a genuine Node-only tool inventory; Linux isolation, approvals, output, Stop and repair are shared.
Windows remained files-only at that head. Local verification passed full types/build/lint, 21 real isolated-workspace cases,
eight pinned-SDK cases and one normal-sandbox Electron journey. The 1,200-case unit aggregate used a disclosed
15-second CLI override; 13 selected corpus/direct-Node cases separately passed the original five-second default.

[Remote run 43935924791](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43935924791)
passed all 11 eligible jobs with two gated skips, and
[controller run 43935924838](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43935924838)
passed all six Windows jobs, including both files-only Electron journeys.
[Ordinary CI 43935924802](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43935924802)
completed with five successful jobs, two failures and two gated skips. Linux passed 19,800 units, 316 offline
integrations, two isolated Stop cases, the Electron journey and 314 renderer cases; macOS passed 19,451 units.
Windows passed 19,402 units and its build/desktop/UIA/voice/package checks, then retained the existing LPAC stage-18
failure. RHEL 8's saved-workspace restart case waited for a disabled Save button; 85 desktop cases passed, one failed
and one skipped. Its test and renderer/IPC implementation are unchanged from the preceding candidate; investigation
continues. Overall CI remains red, and Windows command integration/live-account/laptop acceptance remain unfinished.

The failure-only workspace diagnostic [#250](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/250)
subsequently passed its RHEL desktop suite in
[run 43941583962](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43941583962), without
changing product behaviour or deadlines; the earlier Save-button cause remains unknown. That run retained the known
Windows LPAC failure and failed one unchanged macOS redaction budget case at 322.895 ms versus 300 ms. The separate
reviewed [redaction change #255](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/255) skips an
impossible MySQL password search when its literal `-p` prerequisite is absent, retaining the exact regex, unguarded
reference and budget. Its 457 focused cases, full types, lint and build passed.
[CI 43949496691](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43949496691)
passed 19,802 Linux units, the existing integrations, renderer/Electron and RHEL/package/evaluation/voice checks.
Windows retained the old LPAC failure; macOS was cancelled. The single subsequent macOS-only
[run 43956411177](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43956411177)
at unchanged `f6a5b209` passed the full job, including 19,453 units and the unchanged 300 ms budget assertion.
Build, native accessibility, smoke and app-bundle checks also passed. Other platform/release jobs were intentionally
skipped. This closes the cancelled-job verification gap without establishing a cause for the earlier timing failure.

The preceding integrated product candidate was [draft #236](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/236)
at `88106606726e0f24e43f8ae7f5d430f899ab0f34`, including the session review change from
[draft #235](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/235) at `f5871bbe`.
[Completed CI 43877755675](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43877755675)
has six successful jobs, one failed Windows job and two gated skips. The sole Windows failure remains the existing
LPAC stage-18 child denial (`CreateProcessW` error 5, NT status `0xc0000022`); overall CI is red and this candidate
is not merge-ready. All non-Windows jobs succeeded. Linux passed 19,755 units (38 skipped), 306 offline integrations
(753 platform/gated skips), both isolated Stop cases, the genuine sandboxed Electron journey and all 314 renderer
cases across 21 files. Windows passed 19,357 units (432 skipped), and macOS 19,406 (387 skipped).

The separate [controller run 43877755446](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43877755446)
passed all six jobs. Each Windows Server image passed 97 portable cases, three native controller cases, one ZIP
case and one genuine files-only Electron journey, with zero skips. These retain mock providers and supplied picker
answers. The preceding session-review candidate likewise passed its
[dedicated controller run](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43876270000);
its [ordinary CI](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43876269950) had the
same sole Windows LPAC failure and successful non-Windows jobs.

Focused local verification of the combined candidate passed 198 wait/lifecycle and 149 mapping/copy cases, plus
one real pinned-SDK integration with two inert workers and a combined reply in the same turn. The genuine Electron
coding journey passed with the normal OS sandbox in 30.08 seconds, and both Stop deadline cases passed without
changing their deadlines. These checks do not establish live-provider completion, physical laptop behaviour or a
Windows command backend. The native diagnostic sibling drafts are separate experiments, not product capabilities.

At submitted head `7eabd077`, [ordinary CI 43813490098](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813490098)
completed with Linux, macOS, RHEL 8, voice, evaluation and RPM/AppImage packaging successful. Windows units, build,
desktop, voice, UI Automation, staging and ZIP checks passed; its job failed solely at the existing experimental LPAC
stage-18 child access denial (`CreateProcessW` error 5). Overall CI remains red and the candidate is not merge-ready.

The Linux job passed 19,656 units with 38 environment skips, 304 integration cases with 732 platform/environment
skips, two kill-switch cases, the genuine Electron coding journey (7.867 seconds) and 294 renderer cases. Skipped
platform cases are unverified there. Dedicated PR [controller 43813490107](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813490107)
passed 202 checks and [artifact 43813490028](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813490028)
passed 410 across the two Windows Server images. These PR jobs checked merge `4893079a` of exact `7eabd077` into
`0f70a7f7`; the direct-head manual proofs above remain separate receipts.

At `410161e7`, full run `43804472777` passed Linux lint/types/build/lab, 19,480 units (38 environment skips), two Stop
deadlines, 300 integrations (698 environment skips), the genuine sandboxed Electron journey (1/1, 8.77 seconds) and
all 293 renderer cases. macOS, RHEL compatibility, packaging, evaluation and voice jobs passed. Windows unit, build,
desktop and packaging checks passed; only the experimental LPAC startup fixture failed, so the overall run remains red.
This also verifies the repaired cleanup fixture with its real tree wiper, owned-byte clearing after drain and unchanged
external review buffers. The later combined adapter candidate passed full local types/lint/build, 12 real SDK cases,
20 Chromium coding UI cases and the genuine Electron journey again (19.61 seconds).

At `29cb624e`, [the Linux checks job](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43793162486/job/133055944521)
passed lint, types, 19,119 unit tests (38 skipped), 297 integration tests (658 skipped), the isolated Stop deadline and
the application build. The actual Electron journey then failed before app startup: Chromium selected the adjacent
npm-installed `chrome-sandbox`, which was not root-owned with mode 4755. Electron 44.9.3's pinned Chromium
[chooses an existing adjacent helper before the environment fallback](https://github.com/chromium/chromium/blob/152.0.7977.167/sandbox/linux/suid/client/setuid_sandbox_host.cc).
CI now links that exact adjacent location to a fresh root-owned helper under `/usr/lib` and verifies its ownership and
mode before launch. The normal Electron sandbox and all journey assertions remain enabled.

At `fb846a57`, [the hosted Linux job](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43795719365/job/133063956691)
passed lint/types, 19,261 unit tests (38 skipped), 297 integrations (660 skipped), the isolated Stop deadline, build,
and the actual sandboxed Electron coding journey (one case, 6.73 seconds). Its separate Chromium suite passed 282
cases and failed two. The composed coding fixture selected its CLI installation instead of the separately configured
trusted command asset, so production discovery correctly kept coding unavailable. It now supplies the verified test
asset to unchanged discovery and asserts that exact selection; the composed repair/review/export/erasure journey
passes locally. Required isolation failures fail this fixture instead of being skipped. Native and product deadlines
are unchanged. The other failure involved a delayed navigation resize notification after a manual scroll.

The navigation row now remembers the layout it already positioned. A delayed resize notification for that same
layout does not move a row the person subsequently scrolled; genuine badge, font, link and row size changes still
bring the selected pane into view. A regression holding actual native resize deliveries reproduces the exact
955-pixel jump with the previous renderer and passes with the repair. All 54 Home pane cases pass locally, including
the original narrow-row assertion and the badge-growth case; no assertion or timeout was weakened.

Final check results are recorded with the follow-up commit/PR. The real runtime tests intentionally include successful
reproductions of unsafe isolation behavior; a green result there means the probe behaved as expected, not that native
coding is safe. Synthetic audio, mock providers and Chromium with a fake preload do not certify physical desktop I/O.

### Explicit saved coding drafts and fresh-folder imports

The draft product branch connects certified stopped-review snapshots to encrypted Save/Open/Forget controls in
Home, under consent 15. Full-file privacy validation and fresh-folder three-way comparison run in a fixed trusted
worker. Opening remains inert; a successful import is a new stopped private review with new identity and zero
fresh checks. A later explicit request captures current execution authority and receives old request/summary only
as quoted untrusted history. Conflicts, unavailable current source, late source changes, credential-holder changes
and incomplete cleanup refuse the corresponding operation. Original source folders are never written.

This work changes the native source graph (including consent, registry, TaskManager and Windows resources) and
requires fresh qualification after composition with the optional WSL/public-dependency work. It does not refresh
native proof metadata or claim physical Windows acceptance. See `docs/CODING-DRAFT-FOUNDATION.md` for custody,
bounds, erasure and the separation between saved data and new task authority.
