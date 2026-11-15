# Conductor progress and remaining work

Reviewed 15 November 2026. Baseline: `audit/beta-readiness` at `76d0a2c9`, the most recently submitted remote branch;
main was `85b5bd56`. This follow-up deliberately retains the native coding gate and is not a release certification.

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
  provider credential cannot read the saved goals/outcomes. Forget everything removes the checkpoint. Consent version
  13 explains this retention and returning users agree again. Changing the board does not automatically save it.
- The conductor can create/select/list projects and name each delegated desktop session. Project selection is captured
  when a request arrives, so switching projects while the conductor responds cannot misattribute its eventual tasks.
  The existing scheduler, approvals and original user words remain the execution authority.
- The cursor companion identifies a single task, differentiates queued/running/waiting/stopping work, and exposes
  fuller task progress through its existing menu description and hover text without taking keyboard focus.
- Native coding cleanup callers share the actual teardown promise, including failures. Coding work also has host-owned
  limits of 150 tools and 20 active minutes; permission/clarification waits pause the time budget. None enables coding.
- [Primary-source research](COMPANION_RESEARCH.md) compares Tiki, HeyClicky, Conductor and related projects.

## What still needs implementation

1. **Production coding isolation.** Demonstrate an OS-enforced boundary around the entire runtime, native tools and all
   descendants. Existing path denials allow hardlink aliases; moving credentials to session configuration does not
   isolate them from runtime memory. The Linux experiment is not a production solution. Windows/macOS need their own
   enforced implementations and canary tests. Do not enable coding by changing `codingAvailable()`.
2. **Safe coding results.** Add bounded result traversal and a reviewable patch/export from isolated work. Automatic
   application requires a demonstrated concurrent-writer contract and recovery, as [the copy-back design](CODING-COPYBACK-DESIGN.md)
   explains. An ordinary hash-then-rename cannot protect a simultaneous editor write.
3. **Automatic session recovery.** Explicit encrypted board checkpoints now retain metadata/outcomes across restarts
   and restore interrupted work as inert stopped records. Automatic checkpointing, workspace identity reconciliation
   and a fresh-authority continuation flow remain to implement. Checkpoints do not restore worker conversations.
4. **Full conductor coordination.** Current workers execute independently; their reports reach the conductor with the
   next user message. Native coding/desktop sequencing is gated. A general dependent-session scheduler, automatic
   result-driven continuation and persistent cross-session artefacts are still needed for the complete experience.
5. **Real-provider verification.** Offline mock-provider tests establish deterministic behavior, not successful live
   authentication, provider tool compatibility or useful task completion. Verify those on the chosen account/provider.

## What needs the Windows laptop

The [Windows acceptance checklist](WINDOWS-CONDUCTOR-ACCEPTANCE.md) exercises the complete desktop story plus native
UI Automation, foreground focus, cursor takeover, global Stop, mixed display scales, keyboard layouts, real microphone
and speaker interruption, lock/recovery and account changes. Record exact commits and observed app outcomes.

The laptop can validate desktop sessions now. It is not the only remaining dependency and cannot by itself resolve
the coding isolation, persistent recovery and orchestration work above. Main should remain unmerged until those
requirements and relevant native acceptance are satisfied.

## Verification

Final check results are recorded with the follow-up commit/PR. The real runtime tests intentionally include successful
reproductions of unsafe isolation behavior; a green result there means the probe behaved as expected, not that native
coding is safe. Synthetic audio, mock providers and Chromium with a fake preload do not certify physical desktop I/O.
