# Windows root-only copy ownership prerequisite

This is an unwired software prerequisite for fresh command-copy ownership. It does not enable a Windows command
backend, accept shell text or arbitrary project execution, select a toolchain, or replace the files-only product.
Its execution scope is **one root process with native ACTIVE_PROCESS_LIMIT=1**, enforced before assignment.
It cannot support ordinary project descendants, `node --test`, npm or a normal multi-process coding loop.

The pending source-built Node experiment is independent. Even successful fixed FS/pipe/child tests would not
provide a PowerShell/Bash grammar, a trusted complete toolchain, project admission or a generic stopped-writer
barrier. A future restricted direct-argv interface needs an explicit policy contract and user experience; it
must not accept a PowerShell stamp and silently execute Node instead.

## Owned boundary

`WindowsRootOnlyCommandCopy` owns one fresh native work tree and its root-only process generations. Its native
tree owner creates brand-new objects under a dedicated scratch parent, disjoint from protected source,
controller, tool, review and Ember data roots. It accepts bounded already-admitted host bytes. It does not grant
source capture or privacy authority, and it never changes the selected source's ACLs.

The existing `WindowsCodingNative`, its opaque handle ledger and its exact owner/SYSTEM `assertPrivate()` remain
unchanged. The new native adapter has a separate raw-handle ledger; opaque `WindowsCodingHandle` IDs are never
passed to Win32 process or security calls.

Fresh tree objects begin with an exact protected owner/SYSTEM ACL and a LOW mandatory label. An active grant
adds only the bound package's Modify rights, excluding WRITE_DAC and WRITE_OWNER. ACL changes use held-object
`NtSetSecurityObject` calls inside a bounded explicit traversal; automatic recursive inheritance propagation is
not used as a substitute for that traversal. Persistent pins carry only metadata/ACL rights, share7 and no
DATA/DELETE access. Creator/data/delete handles must be closed before a grant can finish and a root can resume.

Revocation walks **current descendants**, including newly created files. It checks held root/parent identity,
NTFS metadata, ownership, exact ACL/label phase, bounds and aliases. Reparse objects, hardlinks, ADS, foreign
owners and unsupported executable metadata refuse the operation. Restoration verifies exact private ACLs before
a snapshot is available. No unknown path is traversed or recursively removed during cleanup.

The package identity is borrowed from a host-owned fresh-profile lifetime. Profile issuance, strict token/image
and executable attestation, profile deletion, privacy filtering and source/result publication are separate
caller obligations. A SID string is not evidence that those obligations were met. The native creator must be
a trusted CREATE_SUSPENDED issuer, not a callback that returns arbitrary already-running project code.

## Process proof and phase order

Each generation receives a new private binding and a private unnamed job. The Stop owner sets and reads back
KILL_ON_JOB_CLOSE and ACTIVE_PROCESS_LIMIT=1 before any root assignment, with no breakaway allowance. The root's
process/thread identity, private job membership and required caller attestation are checked before Resume.
The job never reaches the creator callback.

The coordinator serializes this sequence:

1. Verify private fresh tree and current worker/package authority.
2. Create the root-only job owner, grant its package the fresh work tree, then admit the suspended root.
3. Retire new starts, stop the exact root/job and positively observe completion on the held root/thread objects.
4. Verify whole-job zero, root-only process history, final identities and limits under one monotonic deadline.
5. Positively close all process/thread/job handles, then mint the opaque `WindowsCommandRootOnlyStoppedRef`.
6. Validate that exact issuer/binding before revoking package grants. Only then allow a private host snapshot.

The receipt is WeakMap-branded to its generation and has scope `root-only`. A caller's boolean, a similarly
shaped object, a foreign binding or a sampled PID cannot mint it. Stop retires starts synchronously and uses
yielded zero-time waits within a shared bounded deadline, so it does not block the main thread for fifteen
seconds. It retains the same native objects rather than reopening PIDs.

Host file operations and root generations share one exclusive queue. Stop retires worker admission; a separately
captured publication/account/privacy guard may read a known-stopped private tree for review. Snapshot buffers
are cleared when the host callback ends. This component does not publish them or bypass the existing scanner,
artifact/source ownership, continuation checks or review-only export flow.

Unknown native ownership, failed close/free, limits or identity failure makes the owner terminal. Shared fences
retain every active owner graph and request only non-disposing Stop on known unclosed root/job handles. No
receipt, ACL revocation, snapshot, profile release or speculative cleanup follows uncertain ownership. Handles
whose close became uncertain are never queried, signalled or retried.

## Why this is root-only

[TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
acts like asynchronous per-process termination. Microsoft documents that
[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)
returns before shutdown completes; the process handle must be waited. A job's current PID list can lose a
short-lived descendant before its process object signals, and PIDs can be recycled.

Ordinary NEW_PROCESS, EXIT_PROCESS and ACTIVE_PROCESS_ZERO completion-port messages are
[explicitly not guaranteed](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port).
The [job object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) signalling rule concerns
the special end-of-job CPU-time-limit path; it does not establish an ordinary Stop or wall-clock barrier.
Sampling current members and waiting only the observed handles cannot certify every generic project writer.

[Debugging events](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events) provide CREATE handles
before user-mode code and document the EXIT recipe: duplicate the handle, continue the event, then wait for
kernel shutdown. However [debugger descendant coverage](https://learn.microsoft.com/en-us/windows/win32/debug/process-functions-for-debugging)
is conditional; a child can start another DEBUG_PROCESS chain. The
[creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) also distinguish
that chain and DEBUG_ONLY_THIS_PROCESS. An inherited debugger alone is not a generic hostile-descendant barrier.

A reliable enforced generic admission/completion mechanism remains open. This prerequisite issues no
child-capable lease, no outside-job service/broker proof and no ordinary coding-workspace capability.

## Verification still required

Portable phase/native-binding tests check exact grant/revoke ordering, opaque receipt provenance, callback and
input capture, cancellation, private review authority, limits, identities, process/handle completion and terminal
retention. They are contract tests, not Windows execution. The reviewed fixed native grant/write/revoke/denial
harness is now implemented separately from the product. Successful native acceptance remains pending; the actual
failed runs and their limited positive facts are recorded below. Product mode, shell/toolchain availability and the
original file-only verifier remain unchanged.

The dedicated `experimental-windows-command-copy` workflow registers portable contract checks on pull requests.
Only explicit workflow dispatch runs the hosted Server 2022/2025 native matrix. It builds one fixed C program
with the hosted image's observed MSVC tools and bundles the actual host components as CommonJS. This is
observed hosted-tool provenance, not an independently authenticated compiler or a product asset issuer.
The exact build result stays branded in the same test worker and all sources, tools, recipes, CJS and x64 PE
bytes are rechecked. The emitted default Koffi loader and real native tree factory run in the native test.
The bundle captures the actual application/package TypeScript graph and reconciles it against esbuild metadata.
Only Koffi and zod stay external under the checkout's existing `npm ci` trust; package manifest, lock and TypeScript
configuration are included in the source receipt. The real portable esbuild test exercises this same capture and
reconciliation path and rejects uncaptured module inputs. This does not claim hostile same-user writer exclusion
or independent upstream authentication of the hosted compiler or installed npm packages.

The synthetic native witness requires initial private owner/SYSTEM LOW work ACLs, fresh-package Modify grants,
read/edit/create/rename/replace/delete operations, source and canary access denial, exact root-only limits and
held-root attestation before Resume. After positive Stop and job closure it revokes grants and compares detached
private snapshots. A second launch under the same profile attempts work reads/writes/creation while work remains
revoked. A writer case publishes a closed static control receipt and metadata-only ready marker, then repeatedly
updates a fixed heartbeat until Stop. Only after Stop/revoke can the host inspect that heartbeat and verify it
remains stable, reject later starts, remove both trees and positively delete the fresh profile.

The fixed program's deletion uses `FileDispositionInfoEx` with POSIX deletion semantics, matching the pinned
Node/libuv file path. This does not establish compatibility with every Windows deletion API. No host source,
arbitrary code, shell, network, credential environment or child process is supplied. Only numeric summaries leave
the completed test. Any unknown native/setup/close ownership retains the exact graph and requests only known
non-disposing Stop; it publishes no success and performs no recursive scratch cleanup.
Native scratch uses the canonical hosted `RUNNER_TEMP`, checked disjoint from Vitest's managed temporary tree.
This prevents Vitest's unconditional teardown from recursively deleting a graph deliberately retained on failure.

Initial local verification at `d745b196` passed 449 contracts across the root Stop owner (114), coordinator (23),
native tree binding (75), fixed build/CJS source graph (68), report decoder (47), strict proof-native helper (110)
and scratch lifetime (12). The final composed TypeScript check, scoped lint, workflow parsing/dispatch checks and the app build passed. The ordinary
Linux invocation skips the Windows case; an explicitly required Linux invocation fails the suite as intended.
Neither result is Windows execution evidence. A successful real two-image matrix is required before this prerequisite
can be recorded as natively verified.

The first manual matrix at `d745b196`,
[run 43865163034](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43865163034),
passed 448 portable contracts per image plus one expected unsupported-host guard skip. Both native cases failed
with phase `3`, ownership `1`: the real emitted coordinator's cleanup error. The fixed C build/CJS setup completed,
but that phase still includes fresh-tree construction, the initial private snapshot and first launch. It establishes
neither useful native edits nor a particular NTFS/ACL failure. No additional native cause was exposed by that run.

The follow-up preserves every native call, predicate, access mask, fence and cleanup rule while adding a first-error
WeakMap receipt. It records only closed stage/operation/predicate IDs and already-returned, bounded NTSTATUS/BOOL
facts. Pointer, size, name, path, identity, malformed ABI and unknown data stay absent; it performs no extra native
query or `GetLastError`. The actual emitted getter is a fixed tenth CJS export. A catch-only wrapper around the
real factory and its methods observes the original error before coordinator shaping; it preserves delegate arguments,
resolved values and original error identity even if observation fails. The first-copy flow distinguishes factory,
initial snapshot and launch without advancing its recorded boundary after rejection. These diagnostics grant no
authority and cannot replace a successful Stop or a native acceptance result.

The frozen diagnostic follow-up passes 507 focused contracts, final composed TypeScript, scoped lint and diff
checks. Independent actual-file review closed after a regression proved that a throwing factory observer must
preserve the original failure. Its subsequent native result is recorded below.

The second manual matrix at `3d010e7a`,
[run 43868304953](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43868304953),
passed 506 portable cases per image plus the expected unsupported-host guard skip. Both native cases reached
phase `3`, subphase `3`, ownership `1`, without a branded native-tree failure. Thus the real fresh-tree factory
and initial private six-entry snapshot completed on both images, but the first launch failed. No useful edits,
successful native Stop/revoke or completed scratch/profile cleanup were established.

The launch-boundary diagnostic follows the actual Stop constructor/launch and guarded creator/attester boundaries.
It preserves their original return/receipt/error identity and retains the first branded Stop failure. A closed
constraint ID may identify the first mismatching span only after the existing complete limit predicate failed;
no value, process ID, pointer, count, access mask or additional native query is exposed. In particular, Microsoft's
[basic limit contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
says SchedulingClass is ignored without its flag and defaults to `5`. This is a possible explanation for a
whole-buffer zero comparison, not an observed cause. That diagnostic candidate preserved every acceptance
predicate pending the actual boundary evidence recorded below.

The frozen launch-boundary diagnostic passes 576 focused contracts, final composed TypeScript, scoped lint and
diff checks. Root's independent actual-file review closed without an acceptance, call-order or retention change.
No successful whole-copy lifecycle is claimed by those portable checks.

The third manual matrix at `885b2e4a`,
[run 43871588608](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43871588608),
passed 575 portable cases per image plus the expected unsupported-host guard skip. Both images reported
phase `3`, subphase `3`, ownership `1`, boundary `1`, with Stop stage `3`, operation `2`, predicate `4`, domain
`0`, code `0`, constraint `10`. This identifies the actual Stop constructor's readback refusal at the PriorityClass
span, bytes 56–60. It occurred before package grant or the creator callback. The actual priority value was not
published; no scheduling mismatch or default value was established. Useful work, a successful Stop receipt and
complete scratch/profile cleanup remain unverified.

The primary contract says both PriorityClass and SchedulingClass are ignored when their respective job flags
are absent. The surgical repair therefore compares basic-limit bytes 0–56 exactly and ignores only bytes 56–64;
it does not replace either field with a guessed default. The exact `LIMITS=0x2008` readback still excludes the
priority (`0x20`) and scheduling (`0x80`) flags, and every other time, workset, active-count, affinity, padding,
memory and UI check remains in place. No native query, access mask, Stop deadline or positive completion proof
changes. Constraint IDs 10/11 remain historical reservations; current remaining constraints retain their IDs.
Varying ignored fields are accepted only with the flags absent, while each remaining limit byte and forbidden
flag, memory and UI mutation must still refuse. The subsequent fourth matrix is recorded below.

The reviewed repair passes 644 focused contracts, including 240 Stop cases, final composed TypeScript,
scoped lint and diff checks. Native useful-work and complete cleanup acceptance remain pending.

The fourth manual matrix at `c77c170a`,
[run 43876373197](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43876373197),
passed 643 portable cases per image plus the expected unsupported-host guard skip. Both native cases failed at
phase `3`, subphase `3`, ownership `0`, boundary `0`, without a branded native-tree or Stop failure. That earlier
subphase included both the coordinator's first launch and the following wait/exit check, so it did not establish
which boundary failed or whether the creator ran. No grant, useful edits, positive Stop or complete cleanup is
claimed from this result.

A portable composition regression now connects the real coordinator, native tree binding and Stop owner through
fake Win32 operations, with the same six staged entries, deeper ancestry, four protected paths and actual observer
facade. It passes grant/callback/Resume/Stop/revoke/private-review ordering; no deterministic current/phase mismatch
was reproduced. These fake operations are not Windows execution evidence.

The next observation-only change exports the actual `ScopedCodingFileError` constructor as the fixed twelfth CJS
export. It classifies only known own data-property codes after that constructor check; error names, messages,
getters, unknown codes and foreign-module errors are not forwarded. The result is diagnostic, never cleanup or
execution authority. Subphase `4` is entered immediately after the launch promise succeeds, before the existing
process-presence/wait/exit check. A rejected launch remains in subphase `3`; every guard and native call is unchanged.

The closed `fileCode` mapping is:

| ID | File error |
| --- | --- |
| 0 | Unknown, unsupported descriptor or nonmatching constructor |
| 1 | unavailable |
| 2 | cancelled |
| 3 | path |
| 4 | boundary |
| 5 | unsupported |
| 6 | privacy |
| 7 | binary |
| 8 | secret |
| 9 | limit |
| 10 | missing |
| 11 | exists |
| 12 | conflict |
| 13 | ambiguous |
| 14 | not-empty |
| 15 | io |

Before publication, the diagnostic also captures only the validated DWORD returned by the same existing guarded
`original.exitCode` call for the admitted fixed C image. Optional `exit.code` is an integer from 0 through
`0xffffffff`; `exit.phase=1` means the useful root and `2` means the revoked-access control. The old exact-zero
gate, including `-0`, remains unchanged. The capture is cleared before each new process/wait, omitted on malformed
returns or query/getter exceptions, and never authorises report readout or Stop. No extra native query is issued.
The writer still uses its existing explicit Stop path and supplies no natural-exit receipt. This prevents a later
process from inheriting an unrelated previous exit observation. Within a process phase this remains the last
natural-exit observation: a recorded zero can coexist with a later ACL, snapshot or review failure and does not
identify that failure's cause.

The frozen classification/exit-observation candidate passes 697 focused contracts, final composed TypeScript,
scoped lint and diff checks. Root's actual-file review closed.

The fifth manual matrix at `4e0ab2a8`,
[run 43881092204](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43881092204),
passed 696 portable cases per image plus the expected unsupported-host guard skip; its separate portable job
passed all 697 cases. Both native cases failed at phase `3`, subphase `4`, ownership `0`, boundary `0`, fileCode
`0`, with `exit={phase:1,code:1}`. The useful launch promise completed and the subsequent natural-exit exact-zero
check refused code `1`. No native-tree or Stop failure was branded. This establishes neither the failed C operation
nor positive Stop, revocation, useful edits or complete cleanup. The fixed C program uses code `1` for its failure
path, which attempts a numeric failure report; no report was read in that matrix.

The next diagnostic applies only to that first useful root's captured natural exit `1`. It awaits the actual
coordinator's `stop()` fulfilment, whose existing quiescence path requires the positive root-only Stop receipt,
closed job/handles and package-grant revocation. Only then does it recheck the existing build/image/source pins,
acquire the same writer-excluding native pin on the fixed useful report and parse exactly 64 bytes with the
existing useful-report decoder. Only `FAILED` status `2` can produce optional `failedReport` metadata: fixed mode
`1`, status `2`, operation `0..12`, the validated prefix feature bits and the failed-operation DWORD as `code`.
The bytes are wiped and the report pin must close positively before this metadata is recorded.

The original exit-1 refusal remains the test failure on every path. The report grants no useful-completion,
execution or cleanup authority. A refused Stop/revocation, changed pin, absent or malformed report, wrong mode,
complete report, uncertain acquisition/read/close or diagnostic callback cannot replace that initial error;
the existing outer failure path retains the complete graph and requests only non-disposing Stop of known roots.
There is no work snapshot, `files()` call, C-image change, flag change, permission change or product enablement.
The subsequent sixth matrix is recorded below.

This candidate passes 717 focused contracts, final composed TypeScript, scoped lint and diff checks. Its real
coordinator/Stop composition tests hold ACL revocation pending after job closure and verify that no report pin
is acquired until revocation fulfils; a revocation refusal retains the owner and never reads the report. Root's
actual-file review closed. These portable checks do not establish a sixth Windows result.

The sixth manual matrix at `3400533f`,
[run 43884035955](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43884035955),
passed 716 portable cases per image plus the expected unsupported-host guard skip; its separate portable job
passed all 717 cases. Both native cases retained the fifth result's phase `3`, subphase `4`, ownership `0`, boundary
`0`, fileCode `0`, `exit={phase:1,code:1}`. The diagnostic Stop then supplied stage `12`, operation `2`, predicate
`5`, constraint `0`, domain `0`, code `0`: the real Stop binding refused its existing accounting/process-list
consistency check. No stopped receipt, grant revocation or failed-report read is claimed; `failedReport` was absent.
The original C operation and the specific failed state comparison remain unknown from this result.

The next diagnostic preserves that entire state predicate and all native calls. Only after the unchanged full
condition refuses does it select the first failed comparison, using already-decoded scalars and these closed IDs:

| Constraint | Existing failed comparison |
| --- | --- |
| 15 | Lifetime process total exceeds the one-root budget |
| 16 | Active process count exceeds the lifetime total |
| 17 | Limit-terminated count exceeds the lifetime total |
| 18 | Assigned-process count differs from returned-list length |
| 19 | Active process count differs from returned-list length |
| 20 | Returned-list length exceeds the one-root budget |
| 21 | Existing returned PID is outside the valid nonzero DWORD range |

IDs 15 through 20 follow the original source order and identify only the first failed comparison. Multiple checks
can fail together. In particular, ID 20 is a stable shadowed slot: an oversized list necessarily fails an earlier
comparison under the one-root constraints, so it cannot be selected first. ID 21 applies to the subsequent existing
PID-bounds check. No counts, process identifiers, handles, extra query or error-text lookup are exposed. The owner
copies this first branded metadata into its existing terminal stage `12` refusal, retains all owners and never
authorises report readout from the diagnostic.

Microsoft's [accounting structure documentation](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
states that lifetime totals include failed associations caused by limit violations and describes a temporary active
increment for those failed associations. Its [process-list documentation](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
distinguishes the number of identifiers to store from the number actually returned. These contracts do not identify
the sixth run's failed comparison or justify dropping any history, consistency, completion or root-only check.
The next Windows result remains pending; no DETACHED comparison is implemented in this candidate.

This diagnostic passes 743 focused contracts, including 266 Stop cases, final composed TypeScript, scoped lint
and diff checks. Root's actual-file review closed. These portable checks do not establish the next native result.
