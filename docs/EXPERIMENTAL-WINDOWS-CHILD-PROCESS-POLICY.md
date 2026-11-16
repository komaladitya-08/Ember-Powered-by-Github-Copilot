# Fixed child-process policy witness

This separate experiment observes creation-time child policy, self-setter attempts and fixed ordinary child creation. It does not enable a product executor, provide a broker, modify the source-Node experiment or establish generic process admission. The canonical LPAC APIs and their original assertions remain unchanged.

The existing baseline is [a1f10fc5 / run 43838983895](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43838983895): all six zero-capability LPAC `CreateProcessW` variants refused with Win32 error 5 / NTSTATUS `0xc0000022`, without an intended child. They varied explicit/inherited capability setup, AAP-only setup, security descriptors and window flags. None tested `CHILD_PROCESS_POLICY` or `OVERRIDE 2`. The unrelated AAP attribute `0x2000f` must not be confused with child-policy attribute `0x2000e`.

## Fixed scope

The repository C asset runs as a root or an inert literal `--leaf`, with no caller-supplied command, script, image or provider. The independently inspected ordinary host uses the original verified build image; LPAC uses its readonly LOW copy. Existing package SID, zero capabilities, AAP opt-out, exact image, two incoming stdio handles, host-only canary and Stop/cleanup rules remain. LPAC must be denied `PROCESS_CREATE_PROCESS` and `PROCESS_VM_WRITE` access to the privileged parent process; the ordinary host supplies corresponding positive handle-open controls. No memory write or injection is attempted.

A separate helper changes only the fresh experimental private job from kill-on-close to kill-on-close plus `ACTIVE_PROCESS=2`, verifies both limits and rejects breakaway/UI flags. Thus a one-process job cap cannot manufacture the child-policy denial. Each created child is checked while suspended against the fixed image, caller token/user/package/integrity, zero-capability/AAP facts for LPAC, policy query and job association; only the same fixed leaf may then resume. C checks association through `IsProcessInJob(child,NULL)`; this is not a claim of exact private-job membership. The trusted parent owns the exact private job and requires its final active/listed count zero.

The host constructor supplies the child-policy attribute only for the fixed birth cases. Before a restricted root resumes, the trusted parent reads `ProcessChildProcessPolicy` from the owned suspended process handle and requires flags exactly 1 (NoChild on, audit/secure off). A requested birth `OVERRIDE 2` is issued only after the actual trusted creator reports no child restriction. Case 0 and case 2 record observed flags empirically.

| Case | Root birth request | Root self-setter request |
| --- | --- | --- |
| 0 | Attribute omitted | None |
| 1 | RESTRICTED 1 | None |
| 2 | OVERRIDE 2 from unrestricted trusted creator | None |
| 3 | RESTRICTED 1 | Clear 0 |
| 4 | RESTRICTED 1 | Audit-only 2 |
| 5 | RESTRICTED 1 | Secure-exception 4 |
| 6 | RESTRICTED 1 | Enforce plus audit 3 |
| 7 | RESTRICTED 1 | Enforce plus secure 5 |
| 8 | Attribute omitted, broker-created inert LPAC leaf | No root observations |

Each root records a plain fixed-image child attempt and a child `OVERRIDE 2` attempt. The ordinary case 0 must successfully exercise both routes before subsequent cases launch. Restricted cases require no ordinary child after the mutation/override attempts. Case 2 is a new optional control, not a promised solution to the known LPAC refusal. An LPAC refusal has no policy-causality claim without an independently successful same-route control. A broker-created LPAC leaf proves image/leaf compatibility only; it does not replace direct creation.

Microsoft's public setter documentation does not completely specify Child policy clear/set behavior. Setter BOOL/error and before/after masks are therefore observations; the report marks setter validity and policy causality `not-established`. Unsupported setters do not prove immutability. An ordinary leaf is not a secure/protected process, so these cases do not demonstrate secure-process eligibility. Direct `NtCreateUserProcess` is deferred: no independently validated exact ABI control exists, and an invalid-parameter/access-denied result would not prove policy enforcement.

## Ownership and output

A successful creation must yield a valid distinct process/thread pair and IDs, survive exact fixed-image/token checks, resume once, exit 0 and close both handles once. FALSE with any unexpected process information, ambiguous ownership/query/resume/wait/close state or report-close uncertainty terminalizes the C root until the trusted parent's bounded Stop. There is no uncertain retry. The host owner permanently fences native uncertainty and retains its owners; no report is acquired or decoded after a root deadline, missing stopped-job lease or nonzero exit.

The exact 320 byte private report carries only fixed case/route enums, BOOL/error or mask facts and known-cleanup states. It contains no paths, process IDs, SIDs, handles, arbitrary native strings or entropy. The parent validates framing and cross-field semantics, root exit 0, private-job zero, unchanged canary, empty native stdio and complete teardown before publishing numeric observations. All cases use fresh profiles and private state. Native scratch is a canonical, validated sibling under hosted `RUNNER_TEMP`, disjoint from managed `os.tmpdir()` in both ancestor directions, with no fallback. A missing natural-completion proof permanently revokes disposal even if a later non-disposing Stop succeeds; the integration runner then preserves the complete scratch tree. No registry/global mitigation, real-host application policy, driver, network capability or ACL expansion is introduced.

The separate repository-source issuer and build receipt bind the three fixed compile inputs, hosted VS 17/18 selection, shared v143 14.44.35207 / SDK 10.0.26100.0, before/after tool hashes and a bounded x64 console PE. They make no OpenJS signature or Node-source authority claim.

## Evidence and limits

Local portable contracts cover the decoder, clean environment, exact birth attribute, policy query fencing, two-process job limits and lifecycle. A Linux-only mock compiles the actual C ownership helpers and injects faults; it establishes helper logic, not Windows ABI or policy behavior.

The [first policy run 43867362868](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43867362868),
at source head `3d22d86cc9544925a5ef24cdaf106875ab3064d7` and actual merge compile commit
`13831cb7fc47966af17e60d582ed2d0b9126dd27`, passed all ten Linux C logic tests. Each Windows Server 2022/2025 job
passed 324 portable tests, skipped the ten Linux-only shim tests and successfully built its fixed C image.
Each native suite passed case 0 and failed its other eight cases; this is not a successful policy matrix.

Case 0 established the same finite facts on both images. The ordinary host successfully created and attested
both the plain and child-override fixed leaf, resumed each once, observed exit 0 and closed its handles. Its root
had observed child-policy flags 0. Zero-capability LPAC also had flags 0, but both plain and override child calls
returned error 5 without a created child. Both roots exited 0 with private-job zero, complete controls mask 15,
unchanged canary and no native output. LPAC canary and privileged parent-handle requests were denied with error 5.
These LPAC direct-create observations have no established policy cause.

The broker-created leaf case 8 failed first, during the LPAC launch phase. Source inspection found a harness
argument mismatch: its prelaunch check required the already fixed `--leaf` argument, while the main proof called
the canonical fixture's launch method with its default empty argument list. Thus this case did not establish
leaf compatibility. Case 1 subsequently terminalized with cleanup unverified, and cases 2–7 were quarantined;
no completed restricted-policy report was published. The logs do not expose case 1's initial native operation,
so restriction enforcement, self-setter behavior and its failure cause remain unknown.

The surgical follow-up forwards the existing fixed argument selection to that same canonical launch method.
It changes no C program, API, mitigation, capability, cleanup or command-validation guard. A nine-case regression
invokes the actual main proof through synthetic platform/file/native boundaries and intercepts the launch call:
case 8 carries only `--leaf`, while cases 0–7 carry no arguments. Restoring the old call fails exactly case 8.
All 343 affected portable contracts passed locally. These synthetic results are not Windows execution; the
repaired native run is recorded below.

The [second matrix 43869055346](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43869055346),
at repaired head `d4fc1781ed25dc10d94fdbddf303b20d9c785672` and actual merge compile commit
`3862e1e0aeb1320adfa51227907ca43b30fb4d53`, passed ten Linux C logic cases. Each Windows image passed 333 portable
tests, skipped ten Linux-only cases and successfully built the fixed C image. Each native suite passed two of nine
cases. Case 0 repeated its ordinary-host useful child controls and LPAC plain/override error-5 observations with
birth flags 0. The repaired broker leaf case 8 passed: ordinary host and LPAC each exited 0, reached private-job
zero, had flags 0 and no report, preserved the canary and emitted no output. This establishes only that fixed
broker-created leaf's compatibility; it does not supply a positive direct LPAC child-creation control.

Case 1 still terminalized after about 33 ms on both images, with no stopped policy report or exposed initial
operation. Cases 2–7 were quarantined. Neither the timing nor terminal error establishes a Windows policy cause,
restriction enforcement or setter behavior.

The next code-only diagnostic uses a private WeakMap to preserve the first failure through existing owned,
host and terminal cleanup error shaping. Its frozen schema exposes only documented closed numeric phase,
operation and predicate enums, domain 0/1 and an optional 0/1 BOOL already returned by an existing call. It never
samples an extra native query or `GetLastError`, reads raw error properties, changes C or admits a failed case.
Later cleanup facts cannot replace the first receipt or restore disposal authority. All 375 affected portable
contracts, scoped lint and diff checks pass; tests include actual call boundaries, first-failure retention,
forged/proxy privacy and no-extra-call checks. Independent source review is complete. The diagnostic native run
remains pending its coordinated review gate; no third matrix has run.

Primary sources:

- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): restriction is a token property; override requires an unrestricted creator; privileged other-process handles can defeat the intended sandbox condition.
- [Child-process policy structure](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_process_mitigation_child_process_policy): NoChild/audit/secure bits and their distinct semantics.
- [GetProcessMitigationPolicy](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessmitigationpolicy): query rights and typed buffer contract.
- [SetProcessMitigationPolicy](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessmitigationpolicy): calling-process setter, without complete Child self-clear guarantees.
- [SeTokenSetNoChildProcessRestricted](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-setokensetnochildprocessrestricted): documented kernel audit-to-enforce direction, not a complete user-mode immutability proof.
