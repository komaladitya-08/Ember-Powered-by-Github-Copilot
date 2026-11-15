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
- The conductor can run ordered desktop sequences of two to eight named sessions. It preserves the original request
  and selected project/computer, waits for successful completion and confirmed cleanup, and gives the next worker
  only a quoted untrusted summary. Stop, steering or an authority change retires remaining steps. Selecting another
  project for new work does not reassign an accepted sequence. This does not enable native coding.
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
  limits of 150 tools and 20 active minutes; permission/clarification waits pause the time budget. None enables coding.
- [Primary-source research](COMPANION_RESEARCH.md) compares Tiki, HeyClicky, Conductor and related projects.

## What still needs implementation

1. **Production coding isolation.** Demonstrate an OS-enforced boundary around the entire runtime, native tools and all
   descendants. Existing path denials allow hardlink aliases; moving credentials to session configuration does not
   isolate them from runtime memory. The Linux experiment is not a production solution. Windows/macOS need their own
   enforced implementations and canary tests. Do not enable coding by changing `codingAvailable()`.
2. **Coding product integration.** Connect an enforced platform backend, scoped credential adapter, stopped result
   capture and review/export to the ordinary CodingWorker/session lifecycle. Its existing direct workspace/credential
   path remains gated. Bind a chosen workspace to each project instead of the separate global coding-folder choice.
   The experiment's artifact API alone does not provide that user flow. Automatic application additionally requires
   a demonstrated concurrent-writer contract and recovery, as [the copy-back design](CODING-COPYBACK-DESIGN.md)
   explains. Export-only review can avoid automatic source writes; an ordinary hash-then-rename cannot protect an editor.
3. **Recovery limits.** Explicit encrypted checkpoints and fresh-request continuation are implemented. Changes after
   the last Save are not recovered after a crash. Optional automatic checkpointing and workspace identity
   reconciliation need their own owner/revision/consent design. Checkpoints do not restore worker conversations.
4. **Richer coordination.** Independent tasks and bounded ordered desktop sequences are supported. The conductor
   receives ordinary background reports with the next user message; an accepted sequence itself can continue without
   another turn. General branching dependency graphs, dynamic replanning and persistent cross-session artefacts remain
   future work. Native coding/desktop sequencing remains gated.
5. **Real-provider verification.** Offline mock-provider tests establish deterministic behavior, not successful live
   authentication, provider tool compatibility or useful task completion. Verify those on the chosen account/provider.

The [Windows coding boundary plan](WINDOWS-CODING-BOUNDARY-PLAN.md) turns the isolation blocker into explicit native
acceptance gates. Its launcher, ACL/handle containment, whole runtime, toolchains and result traversal need actual
Windows enforcement evidence. Windows CI can test kernel primitives; a physical laptop is not a prerequisite for
writing those implementations or for all native tests. Neither a design nor a small fixture certifies the full boundary.

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
