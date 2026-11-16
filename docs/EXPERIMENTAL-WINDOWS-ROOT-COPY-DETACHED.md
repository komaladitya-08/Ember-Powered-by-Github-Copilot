# Fixed detached-root copy comparison

This separate experiment starts from `8b57398c1671505271d1158df249b13f5524b317`. The original root-only copy
experiment, C program, build producer, compiled issuer, twelve emitted CJS exports and application code are unchanged.
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
compile commit and Windows image separately. The verifier is trusted reviewed checkout code, without self-referential
hashes; these public hashes are not publisher authentication. Held reads retain independent named-path and descriptor
clock guards. An uncertain descriptor close suppresses the receipt, retains that descriptor and permanently refuses
later verification in the worker. No hostile concurrent writer exclusion is claimed.

Each dedicated Windows 2022/2025 job compiles the same C with the same producer and recipe, and verifies the original
same-worker build brand and PE checks. Independent fresh compilations can have different PE bytes, timestamps or
observed tools. This experiment therefore claims neither byte-identical assets across jobs nor unique flag causality.
Its workflow runs only for an explicit dispatch or the exact dedicated PR head. Each fresh worker executes only the
variant. It never executes a failed baseline followed by a fence reset, module reload or variant retry. The original
baseline remains independently available in its unchanged workflow.

Native outcomes remain pending. This is fixed root-only Windows Server evidence work; it supplies no general Windows
coding compatibility or production admission authority.

The frozen candidate passes 841 focused contracts across ten files, including 98 new loader, run-identity and
actual-proof routing cases, plus scoped lint and workflow YAML/guard checks. On Linux, explicitly requiring the
native integration exits 1 at its Windows-x64 guard (one failed suite, one skipped case), before compilation or
native calls. Final TypeScript, Root's actual-file review and an independent final review passed. No native result
is claimed.
