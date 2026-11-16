# Conductor progress and remaining work

Reviewed 16 November 2026. Baseline: `audit/beta-readiness` at `76d0a2c9`, the most recently submitted remote branch;
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

The disabled [Windows file foundation](EXPERIMENTAL-WINDOWS-CODING-FILES.md) and separate
[direct Node LPAC diagnostic](WINDOWS-NODE-LPAC-PROOF.md) now have actual Windows Server 2022/2025 CI evidence.
At `7942e554`, file ABI/cleanup units passed seven cases on each server and native files passed 27 of 29 cases on each;
both remaining failures involve atomic replacement. The drive-root bootstrap passed. All twelve Node workload cases
across versions 22/24 and both servers exited with `0x80000003`; useful Node compatibility was not established.
Bounded native rename status and independent fixed-eval host/LPAC startup diagnostics are the next investigation steps.
Neither experiment supplies or enables a production Windows adapter, and server evidence does not certify client Windows.

The follow-up also includes the temporary coding store in desktop command, GUI and integration own-data protection,
and denies Linux key-management syscalls in project commands. The latter closes a potential inherited-session-keyring
surface; it does not report an observed credential leak. Settings search prioritizes the names and aliases of settings
before explanatory project text, preserving Conversation as the first result for history.

## What still needs implementation

1. **Production coding isolation and toolchains.** Finish the custom-tool product path and its enforced command backend
   on each supported platform. Linux currently supplies a small offline bash/Node environment; npm, arbitrary compilers
   and external or cyclic dependency links remain unsupported; validated internal links can be materialized. Packaged
   Electron is not a substitute for a real Node binary. Windows/macOS need their own stopped-writer and filesystem
   implementations and canary tests. Windows CI still exposes child-process creation and PowerShell runtime failures
   in the native prototype; see [the current proof](ISOLATED-WINDOWS-COMMAND-PROOF.md). Do not enable coding by changing
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

At `29cb624e`, [the Linux checks job](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43793162486/job/133055944521)
passed lint, types, 19,119 unit tests (38 skipped), 297 integration tests (658 skipped), the isolated Stop deadline and
the application build. The actual Electron journey then failed before app startup: Chromium selected the adjacent
npm-installed `chrome-sandbox`, which was not root-owned with mode 4755. Electron 44.9.3's pinned Chromium
[chooses an existing adjacent helper before the environment fallback](https://github.com/chromium/chromium/blob/152.0.7977.167/sandbox/linux/suid/client/setuid_sandbox_host.cc).
CI now links that exact adjacent location to a fresh root-owned helper under `/usr/lib` and verifies its ownership and
mode before launch. The normal Electron sandbox and all journey assertions remain enabled; successful CI execution
of that repair is still pending. Local sandboxed Electron success does not prove the hosted runner's helper setup.

Final check results are recorded with the follow-up commit/PR. The real runtime tests intentionally include successful
reproductions of unsafe isolation behavior; a green result there means the probe behaved as expected, not that native
coding is safe. Synthetic audio, mock providers and Chromium with a fake preload do not certify physical desktop I/O.
