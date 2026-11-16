# Fixed detached-root copy comparison

This separate experiment starts from `8b57398c1671505271d1158df249b13f5524b317`. The original root-only copy
branch, C program, build producer, compiled issuer and twelve emitted CJS exports are unchanged. A follow-up changes
only error classification in the native tree binding; all native calls, rights, owner/ACL checks and acceptance
behavior remain unchanged.
No command backend, shell, project executable, Node runtime or descendant support is enabled.

The original [seventh matrix](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43886741681)
passed 742 portable cases plus one expected unsupported-host guard skip per Windows image, with 743 cases passing
in the separate portable job. Both native cases observed useful-root exit `1`, then Stop stage `12`, operation `2`,
predicate `5`, constraint `15`: lifetime process total exceeded the one-root budget. No count or PID was emitted,
no failed report was read, and no useful-work, positive Stop, grant revocation or complete cleanup was accepted.
Constraint 15 identifies the first failed comparison and does not establish what an extra association was or
whether it executed. The C operation that failed remains unknown.

Microsoft's [job accounting contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
includes failed associations caused by limit violations in the lifetime total. The pinned Microsoft Terminal
[console-allocation specification](https://github.com/microsoft/terminal/blob/f6de9e0618015def1c9dda5b82f9d3abf03eb799/doc/specs/%237335%20-%20Console%20Allocation%20Policy.md#L103)
distinguishes a new hidden console under `CREATE_NO_WINDOW` from no console under `DETACHED_PROCESS`.
These are grounds for this single-flag comparison, not evidence that console creation caused the copy failure.

The new trusted fixture loader delegates to the unchanged LPAC API binder. It intercepts exactly one binding of
the exact `kernel32!CreateProcessW` prototype, requires ten arguments and the original flags `0x08080404`, and
replaces only argument 5 with `0x0008040c`: remove `CREATE_NO_WINDOW`, add `DETACHED_PROCESS`. Every other argument
object, native receiver, returned value and thrown error is preserved. Every other library/prototype keeps its
original delegate. There is no new native call, `GetLastError`, fallback, caller-selected flag or new process policy.
Suspension, Unicode environment, extended startup, zero capabilities, AAP opt-out, zero inherited handles and all
existing token/image checks remain. `ACTIVE_PROCESS_LIMIT=1`, exact lifetime history, consistency checks and Stop
deadlines are unchanged.

The proof is a copy of the pinned original with exactly two substitutions: its default loader import and public
entry-point name. The same useful, revoked-access and writer operations, success assertions, grant/revoke ordering,
held-root/job completion, private review, source/canary denials, retired admission refusal and cleanup remain required.
The exact exit-1 failure-report diagnostic still needs fulfilled real Stop/revocation, unchanged pins, the original
64-byte FAILED parser, byte wiping and positive report-pin close. A failure never becomes a positive result.

Run issuer `ember-root-only-copy-detached-run-v1` is separate from the unchanged compiled issuer
`ember-root-only-host-observed-build-v1`. Before compilation/native admission and at the original proof's rechecks,
the fixed verifier binds eighteen public source inputs: baseline C/builder/fixed inputs and API/proof/report,
the original workflow, and the new loader/proof/integration/workflow. It records the source baseline, actual current
compile commit and Windows image separately. The reviewed native error-classification delta has its own updated
input hash; it is not claimed byte-identical to the original native binding. The verifier is trusted reviewed checkout code, without self-referential
hashes; these public hashes are not publisher authentication. Held reads retain independent named-path and descriptor
clock guards. An uncertain descriptor close suppresses the receipt, retains that descriptor and permanently refuses
later verification in the worker. No hostile concurrent writer exclusion is claimed.

Each dedicated Windows 2022/2025 job compiles the same C with the same producer and recipe, and verifies the original
same-worker build brand and PE checks. Independent fresh compilations can have different PE bytes, timestamps or
observed tools. This experiment therefore claims neither byte-identical assets across jobs nor unique flag causality.
Its workflow runs only for an explicit dispatch or the exact dedicated PR head. Each fresh worker executes only the
variant. It never executes a failed baseline followed by a fence reset, module reload or variant retry. The original
baseline remains independently available in its unchanged workflow.

This is fixed root-only Windows Server evidence work; it supplies no general Windows coding compatibility or
production admission authority. The first native result is recorded below; the next owner-classification result is pending.

The initial `d7d9f5ce` candidate passed 841 focused contracts across ten files, including 98 new loader, run-identity and
actual-proof routing cases, plus scoped lint and workflow YAML/guard checks. On Linux, explicitly requiring the
native integration exits 1 at its Windows-x64 guard (one failed suite, one skipped case), before compilation or
native calls. Final TypeScript, Root's actual-file review and an independent final review passed at that initial
freeze, before the first native result below.

The first detached matrix,
[run 43890332358](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43890332358),
passed 840 portable cases plus the expected unsupported-host guard skip on each image. Both source/run identities
passed at actual compile merge `63e96ca80666ea0c3becfe9474a4e1ebd29a0a4d`, public source manifest
`c45ed8da23630a5a4d6669e23b85d04eaf57e854576b8a406d9ee80bcc43110e`. Both native cases failed at phase `3`,
subphase `4`, ownership `0`, boundary `0`, fileCode `0`, `exit={phase:1,code:1}`. The diagnostic quiescence path
reached native revocation, which refused at stage `7`, operation `24`, predicate `7`, domain `0`, code `0`.
That site is the existing comparison of a node's decoded owner SID to host TokenUser. No owner identity, kind,
provenance or path was exposed; no failed report was read. The C operation, successful useful edits, complete
revocation and cleanup remain unaccepted. This separately compiled comparison does not establish unique flag causality.

Before adding further native observation, portable tests reproduced that exact refusal through the real coordinator,
native tree binding with synthetic FFI results and real Stop owner. Newly created and same-name replacement files
had an inherited host/SYSTEM/package ACL but a synthetic creator owner different from host TokenUser. The real Stop
closed its root/thread/job owners before revocation rejected the owner; no ACL mutation, data read or private review
followed. The fake FFI now models owner separately from the host-user ACL entry and correctly preserves owner when
`NtSetSecurityObject` omits `OWNER_SECURITY_INFORMATION`. These are portable model results, not the unknown native owner.

The follow-up records only these optional flat numbers after the unchanged owner equality check has refused, using
the same already-decoded SID and existing node facts:

| Field | Closed values |
| --- | --- |
| `ownerClass` | 1 host user, 2 known own package, 3 SYSTEM, 4 public builtin Administrators, 5 other |
| `nodeKind` | 1 file, 2 directory |
| `nodeRoot` | 0 non-root, 1 root |
| `nodeAcl` | 1 private, 2 granted, 3 inherited provenance |
| `nodeDetached` | 0 ordinary check, 1 existing detached-object check |

Class 1 cannot be emitted by the owner-mismatch branch. Before grant supplies the native owner its package identity,
an unrecognised package SID remains class 5. The class is diagnostic and never an ownership allowlist. No SID,
path, name, file ID, pointer, handle, count, second SID decode or new native query is emitted. The first branded
failure remains immutable across peers and later operations; caller-shaped or serialized metadata has no authority.

Any repair remains design-only. It would need the actual trusted creator TokenOwner from the same held suspended
root, generation/profile/tree-bound opaque evidence and the authentic positive Stop barrier. Only after all bounded
objects pass exact preflight could ownership transfer to host TokenUser together with the private protected DACL,
followed by owner/ACL/label/identity readback. Current revoke omits OWNER in its native information mask, so `O:` in
the descriptor alone cannot perform that transfer. No OWNER bit, owner acceptance, permission or cleanup rule is
changed here. New/replaced-file WRITE_DAC/WRITE_OWNER negatives and owner implicit rights remain future evidence gates;
matching a guessed owner category is insufficient. The next native classification and any repair remain pending.

The owner-classification candidate passes 862 focused contracts across ten files, including 140 native-binding
cases, final TypeScript, scoped lint and diff checks. Root's actual-file review and the independent four-file review
closed. No current Windows owner-classification outcome is claimed.
