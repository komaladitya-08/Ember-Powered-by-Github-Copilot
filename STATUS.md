# Ember status

Updated 3 November 2026. This is the short pickup list; [the review backlog](docs/review-2026-11-03.md) records evidence and acceptance checks. PLAN.md §10 retains implementation history.

## Completed review and merged repairs

- Completed a 15-area source-and-test quality review, including Apple-oriented UI/accessibility, voice, safety, project-session integration and platform resilience. This does **not** certify live UI, audio, assistive-technology quality or parity with a reference voice agent.
- Merged privacy/consent (#148), multi-turn voice smoke and quieter-follow-up endpoint fix (#149), feedback (#150), lifecycle/PID/reminder guards (#151), extension consent/revocation (#152), incoming-speech cancellation (#153), speech recovery/local-only fallback (#154), action-approval binding (#155), retry/FIFO provenance (#156), memory deletion (#157), command revocation (#158), Linux lock rediscovery (#159), complete settings/audit writes (#160), and installer rollback (#161). [PR links and limits](docs/review-2026-11-03.md#merged-repairs).
- Wake timing: the earlier synthetic regression was not reproduced in the current narrow fixture (199–222 ms WASM, 192–195 ms native). Keep load/device validation open; these are not real-microphone measurements.

## Next correctness work

The review is complete, not the backlog. Prioritise reliable interruption/turn ownership and remaining deterministic P2 cases: meaningful “No” replies, text correction and memory negation, setup/save navigation, Home keyboard focus, stale lease state/session-start cancellation, remote exit-status spoofing, extension metadata consistency, contrast and small-window layout. See [reproductions and acceptance checks](docs/review-2026-11-03.md#remaining-correctness-backlog).

## Architecture and owner decisions

- Keep the GitHub token out of the runtime environment: inherited-environment filtering does not solve the pinned SDK's explicit token injection. Requires a supported authentication/account-validation design.
- Durable account-owned memory needs a persistent ownership format and migration/failure policy. Current-run deletion protection is not restart isolation; graph/vector updates are not atomic.
- Super agent: recover the missing original D1–D15 design notes and obtain the owner's answers before implementing project sessions. Support non-Git folders explicitly; do not repurpose hardened desktop workers by enabling coding tools.
- Owner decision: spoken trust on Windows/macOS where the user's voice cannot be distinguished from Ember's speakers; the associated CLAUDE.md “Policy decides” wording still needs approval.
- Owner decision: whether releases should attach eSpeak NG source archives.

## Native validation still required

- Real Windows microphone recordings and `node scripts/voice/bench.mjs --kokoro` on the owner's PC; held-out voice/physical playback and interruption tests across supported devices.
- Real accessibility trees for Pluma, xed, Mousepad and Notepad++; message boxes in CJK, Greek, Arabic, Hebrew and Ukrainian.
- Native keyboard/screen-reader, large-text, contrast, small-window and mixed-DPI checks; OS lock/recovery, suspend, permission revoke/regrant and failed/offline reinstall sequences.
- Monitor the previously intermittent 20-second extension integration test if it recurs. CI and synthetic measurements do not replace these checks.
