# Direct Node LPAC diagnostic

This experiment starts a pinned official Windows Node executable directly in the existing zero-capability LPAC fixture. It does not enable coding, supply a general shell, establish child-process support, or certify Windows 10/11 clients. Windows Server 2022 and 2025 CI are the configured native test environments.

The separate Node 22.23.5 and 24.21.0 ZIP and EXE pins come from their official `nodejs.org` SHA256 manifests. On 15 November 2026, `gpg --verify` verified both detached signatures with exact fingerprint `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`, using the Node release-key repository at commit `481637f813e912c4aa3622d7964ab426c97b8e8d`. Linux pins are not reused. CI checks the archive hash, extracts only its exact `node.exe` entry, then checks that executable's independent size/hash. Before launch, the freshly staged EXE also needs a valid timestamped Windows Authenticode result, the OpenJS Foundation organization and the pinned signing-certificate SHA256. Reading PE certificate metadata on Linux does not establish Windows signature validity.

The existing fixture's 16 MiB executable limit is unchanged. A host-compiled, checked-in C bootstrap is prepared normally but never executed. One strict test-only redirect accepts only its expected empty argument list, working directory and complete clean environment, then creates the exact staged Node image suspended. Native process-image/PID checks use the same process handle that is assigned to the private job and verified as capability-free LPAC before resume. Asset files remain handle-pinned against modification/deletion. All new assets use fresh package-specific protected ACLs; no host, profile ancestor, source tree or capability is granted more access.

Two startup diagnostics precede the three workload cases:

- A fixed `--eval "process.exitCode = 0"` LPAC case loads no supplied script or module and produces no application report. It keeps the existing LPAC token, security attributes, private job, clean environment and zero-handle-inheritance contract.
- A clearly separate trusted-host control uses the same pinned staged image, fixed eval arguments, working directory and exact input environment buffer through native `CreateProcessW`. It is suspended, headless and Unicode, with inheritance disabled and all standard-handle fields zero. It has its own kill-on-close job and verifies its exact suspended image/PID and ordinary non-AppContainer token before resume. The control omits the LPAC security attributes and uses ordinary `STARTUPINFOW` rather than the extended structure. Windows still performs its own LPAC profile-variable redirection inside the LPAC process; identical input buffers do not mean identical OS-observed profile variables. The pair runs sequentially against one prepared fixture; only stopped-and-cleaned numeric outcomes are cached for the two independent assertions. Neither result substitutes for the other. This comparison can distinguish a shared native-launch/startup issue from an LPAC-specific issue, but cannot by itself identify the failing API or prove an invalid-standard-handle cause.

- Direct Node writes its version and a copied-file edit, checks that two synthetic host environment markers are absent, and requires actual `EACCES`/`EPERM` results for host-file read/write and synthetic loopback access. A timeout is a failure, not evidence of network denial. The host compares actual `LOCALAPPDATA`, `TEMP` and `TMP` with the fresh OS-created package profile after the job is stopped.
- `node --test --experimental-test-isolation=none` runs one useful in-process copied-module check. TAP goes to a fresh private report file; no inherited stdout/stderr handle is assumed. The same flag is explicitly supported by the pinned 22 release and is an alias of the stable option in pinned 24.
- Ordinary Node child startup is a separate expected-unsupported diagnostic. It does not confer child/toolchain compatibility. Unexpected child success fails this case until a separate token/image/job proof is supplied.

A separate `startup-io` mode tests the same fixed eval with exactly two controlled inherited handles. One fresh output file handle is shared by stdout and stderr; a read-only canonical `\\Device\\Null` handle supplies stdin. Neither is an SDK, authentication, source-project or host-console handle. The output writer has payload-write rights without payload-read, delete or ACL-changing rights, and the parent holds a separate non-writable identity pin. Only this fresh artifact receives a protected owner/SYSTEM DACL and Low integrity label; no host path or capability is broadened. Its loader verifies the ordinary-file identity/link count, granted handle rights, canonical NUL identity and EOF behavior.

[Pinned Node's Windows startup code](https://github.com/nodejs/node/blob/v22.23.5/src/node.cc#L693) checks standard handles and attempts to open `nul` when they are invalid. Supplying valid private handles tests that startup dependency; it does not establish that this branch caused the earlier breakpoint.

This mode uses `STARTF_USESTDHANDLES` and a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` containing only those two owned handles. Microsoft requires [`bInheritHandles=TRUE` and inheritable handles for this explicit list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute); the helper enables and verifies their inheritance only around synchronous creation, then clears and verifies it before inspecting the result or resuming anything. Its LPAC creation still includes the same zero-capability security attributes and AAP opt-out. The original API and all five zero-handle assertions remain separate and unchanged.

The I/O host control runs first with the same image, arguments, cwd, input environment and two handles. It must exit zero with its private job empty and leave zero output bytes before LPAC admission. The LPAC root is created suspended, assigned to its private job, and checked for exact image/PID and capability-free package identity before resume. After exact root exit and job zero, the host closes its parent I/O handles and rechecks stop. It then acquires a non-writable read pin that denies writer/delete sharing, verifies it is the same single-link file while the original identity pin is still held, and reads at most 64 KiB. Alias, handle or shutdown uncertainty retains scratch/pins and fences further I/O launches. The existing Stop and command deadlines are unchanged.

Only a parser receipt can leave that artifact: a source-relative V8 file and bounded line known to the pinned version's public source catalog, or a fixed status and bounded byte count. The catalog records exact annotated-tag commits and untruncated V8 source trees for both pinned versions. No raw output, CHECK message, stack, address, build/private prefix, environment or arguments are logged or uploaded. [Pinned Release V8 logging code](https://github.com/nodejs/node/blob/v22.23.5/deps/v8/src/base/logging.h#L35) can omit file/line or crash without a message, so `no-location` is an expected diagnostic outcome. The two new assertions report the I/O host control and LPAC fixed eval independently; native I/O compatibility remains pending CI and does not enable a coding backend.

At probe commit `4242fae1ac9e3cfa9908a1a069a5e0a60d8620d4`, [run 43794602957](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43794602957) passed all 172 contract tests on each of the four matrix combinations. All original host controls exited zero and the original LPAC cases still exited `0x80000003`. Each new I/O pair failed during native setup before its host process was created. No two-handle host, LPAC or output receipt was produced, so this run does not test whether valid standard handles affect Node startup.

Setup failures now carry a branded, frozen receipt from a closed stage list. A genuine native FALSE result may add only its allowlisted operation and immediately captured unsigned Win32 error; a nonzero `NtQueryObject` status uses that returned unsigned NTSTATUS. Predicate failures carry only their stage and never sample stale `GetLastError`. The integration emits one such receipt per mode run before propagating the failure. Cleanup uncertainty still takes priority and retains the existing fences; there is no access-right or deadline change.

At `55429f71`, [Node 22 / Server 2022](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43795576062/job/133063526206)
passed all 196 contracts and reported `writer-rights / NtQueryObject / 0xc0000004` (`STATUS_INFO_LENGTH_MISMATCH`).
The helper supplied a 64-byte buffer for the fixed `ObjectBasicInformation` class. Microsoft's documented
[`PUBLIC_OBJECT_BASIC_INFORMATION`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryobject)
contains four 32-bit fields and ten reserved 32-bit fields: 56 bytes. The helper now supplies and requires that exact
size. Contract bindings reproduce the size mismatch and refuse short or oversized successful receipts. Rights masks,
token, ACLs and deadlines are unchanged; native confirmation of the repair and two-handle startup remains pending.

The first Node 22 / Server 2022 job at `47cc11cb` ([run 43795955193](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43795955193/job/133064705549))
passed 198 contracts and advanced from the failed native status to the `writer-rights` predicate. It still created
no I/O host process. For a successful rights query only, setup may now report a fixed failure detail and one unsigned
numeric value: returned structure bytes, missing required access, or unexpected granted access. These values contain
no handle, path or process identity. No stale Win32 error is sampled, and the original refusal still propagates.

At `1adaab9a`, [run 43796488488](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43796488488)
passed all 200 contracts on each of the four combinations. All four successful writer-rights queries returned
`0x100082` before any two-handle host was created. That is the requested `FILE_WRITE_DATA` plus `FILE_READ_ATTRIBUTES`
and `SYNCHRONIZE`. Microsoft defines [attribute reading separately from file-data reading](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants).
The diagnostic now permits that exact additional metadata/wait subset while still requiring payload-write access;
it refuses payload-read, delete, append, execute, attribute-write and security-descriptor modification rights.
`CreateFileW` still requests only `0x2`; no ACL, inherited-handle list, token or deadline changes. Native validation
of this predicate repair and the subsequent host/LPAC launches remains pending.

At `5ef69758`, [run 43796961370](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43796961370)
passed all 218 contracts on every matrix combination. All four two-handle host controls then exited zero with zero
output bytes after verified job stop. All four LPAC fixed evals still exited `0x80000003`; each produced a 48-byte
private artifact that the source-location parser refused as `unreadable`. Valid private standard handles therefore
did not resolve this observed LPAC startup failure. No public callsite was recovered.

The parser now has a separate inspection receipt containing only its closed refusal stage and, for refused encoding,
an alternating ASCII/zero byte-shape class (`utf16le-ascii`, `utf16be-ascii` or `other`). Its original output contract
and source/encoding acceptance remain unchanged. It does not decode or log refused bytes. Native classification of
the 48-byte artifacts remains pending; a refused representation is not evidence of any particular fatal message.

At `17349a2b`, [run 43797881882](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43797881882)
passed all 226 contracts and the private-stdio host controls on every matrix combination. All four LPAC 48-byte
artifacts were refused at `newline`: strict ASCII validation succeeded, but
ordinary CRLF normalization left at least one CR. This does not distinguish doubled CRLF from a bare or mixed CR.
The inspection therefore adds only four bounded structural counts (ordinary CRLF, doubled CRLF, bare CR and LF),
without accepting or returning any new text. Native counts remain pending.

At `5f26d1df`, [run 43798408813](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43798408813)
passed all 231 contracts per job. All four LPAC artifacts contained exactly one doubled CRLF and no ordinary CRLF,
bare CR or LF. The parser now normalizes ordinary CRLF or this observed doubled CRLF in one pass. It still refuses
every residual CR, including runs of three or more before LF; sequential replacement could incorrectly erase those.
Control bytes, private/unknown source paths, malformed or duplicate headers and release-specific membership retain
their existing refusals. Native public-location or `no-location` results after this normalization remain pending.

At `3d922cad`, [run 43798869479](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43798869479)
passed all 237 contracts per job. Normalization returned `no-location` for all four 48-byte artifacts; the private-stdio
host controls passed and LPAC still exited `0x80000003`. No V8 source location was recovered.

Both pinned releases' [libuv fatal handler](https://github.com/nodejs/node/blob/v22.23.5/deps/uv/src/win/error.c#L35)
prints a static syscall name, numeric error and dynamic `FormatMessageA` text, then calls `DebugBreak`. Its source
notes that the system message already contains a newline. An inspection may now recognize only that complete
single-line grammar and emit a release-pinned syscall enum plus a positive signed-32-bit error code; system text is
discarded. The allowlist comes from the pinned libuv `core.c`, `winsock.c`, `util.c`, `thread.c` and `winapi.c` literals, including
the releases' distinct `GetModuleHandleA`/`GetModuleHandleW` spelling. This preserves `no-location`; it does not infer
a public callsite or identify the observed error before a native receipt matches. Native signature results remain pending.

No result or copied content is read by the host until the real root handle has exited and both private job counters are zero. Unverified shutdown retains its scratch and pins. No ACL, AppContainer, network, PowerShell, CLR or registry compatibility fallback is permitted. PowerShell runs only as a trusted host-side signature or event observer, outside the LPAC job; Node is the executable under test inside that job.

The dedicated workflow is `experimental-windows-node-lpac.yml`; it explicitly sets `EMBER_LPAC_NODE_PROOF=1` and the exact asset/version inputs, so its configured Windows jobs must execute or fail. Unconfigured general integration runs skip this separate diagnostic.

At commit `7942e55456d1cab8af85f1a9326e41ed8f2aecca`, [run 43781824215](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43781824215) executed all four Node-version/Windows-server combinations. All twelve original workload cases failed with root exit `0x80000003`, after the verified launch and stopped-job path reached the exit assertion.

At commit `83a8d918b1446de10e4bbb02b107855733e8dcc5`, [run 43784084184](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43784084184) ran the paired startup comparison on both Node versions and both server images. All four trusted-host fixed-eval controls exited `0`; all four LPAC fixed-eval cases and all twelve original LPAC workloads exited `0x80000003`. Every paired numeric outcome followed exact root exit and private job-zero observation; the assertions cached outcomes only after verified cleanup. Each matrix job therefore passed its host-control assertion and failed its other four assertions.

The shared input comparison excludes a general failure of the same headless, no-inherited-standard-handle native launch contract in the ordinary host control, and excludes dependence on the supplied workload scripts. It does not identify the failing API or determine whether the breakpoint occurs before eval or during shutdown. No useful LPAC eval, direct workload, in-process-test or ordinary-child compatibility was established, and the Windows product gate remains unavailable. Linux lifecycle tests, lint/types or platform skips do not establish native runtime compatibility or Windows client support.

The optional next diagnostic queries only recent `Application Error` event 1000 records after the fixed-eval LPAC root and job are stopped, while the staged image and native identity are still held. It uses named `EventData` fields (`ProcessId`, `AppPath`, `AppName`, `ExceptionCode`, `FaultingOffset`, `ModuleName`), verified against the runner's own provider manifest, and never treats `System.Execution.ProcessID` as the faulted application's PID. The [Get-WinEvent provider/time filters](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-winevent?view=powershell-5.1) bound the query to a window of at most 60 seconds. It accepts at most 32 records; a 33rd sentinel produces an explicit limit result. Unknown provider schemas remain unavailable rather than falling back to positional fields.

Only records matching the exact native PID and staged `node.exe` path cross the captured pipe. TypeScript independently checks those identities, provider GUID/channel/event ID, time window, strict field bounds and JSON size before printing a fixed receipt: normalized exception code, module basename and hexadecimal offset. XML, event messages, computer/user identities, arguments, environment and full paths are never printed or uploaded. There is no dump or registry/ACL/capability change. Missing events produce explicit `absent`; query, schema and parse failures produce fixed `unavailable` reasons. Neither status changes the failing compatibility assertion. Native event availability and fault offsets remain pending CI.

At `36225fda9debd1b6f2c2b87c9c05246701618077`, jobs `133035500587` (Node22/Server2022) and `133035501074` (Node24/Server2025) again recorded a successful host control and LPAC breakpoint, while event observation returned `unavailable/event-api` about 8.8 seconds after the host-control receipt. That timing suggests the unchanged eight-second child deadline but did not itself expose an error code or identify a PowerShell phase.

The query emits at most ten fixed ASCII stage markers and monotonic elapsed milliseconds around encoding, input validation, module/provider/schema loading, event querying, selection and result serialization. TypeScript accepts only that ordered enum prefix with bounded integer timings; raw partial fragments and process errors are discarded. Only an actual `execFileSync` error code `ETIMEDOUT` becomes `unavailable/timeout`; error text or signals cannot create that classification. The returned stage/timing receipt is bounded. `process-start` with null timing means no validated script marker was captured, not a measured startup duration.

At `c0b14060ea687cfada21b8acf203ab36671ab1f6`, the Node22/Server2022 and Server2025 jobs (`133039949356`, `133039949587`) both returned an actual timeout with only `script-start` captured at 9/10 milliseconds. The timeout is therefore before `encoding-ready`; this does not distinguish constructor/command discovery from the console encoding setter. The encoding object uses `[System.Text.UTF8Encoding]::new($false)`, with an `encoding-object-created` marker before assigning it to the console. Microsoft documents [`::new` support since PowerShell5.0](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_intrinsic_members), [`New-Object` as a Utility module command](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/?view=powershell-5.1), and [automatic module loading on first command use](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-5.1#psmoduleautoloadingpreference). This removes that command-dispatch dependency without claiming it caused the measured timeout.

The subsequent [dedicated experiment run 43788644273](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43788644273) completed encoding on all four matrix combinations in 18–51 milliseconds, then reached `inputs-ready` at 40–77 milliseconds before the same eight-second timeout. The next operation was the explicit trusted-host Diagnostics module import. That measured phase, plus the existing successful host-side OpenJS verifier's 30-second budget with a comparable fixed environment and Security module import, supports a 30-second **host event observer** budget. The same constant bounds accepted stage timings. LPAC creation, command/Stop deadlines and permissions are unchanged; the new budget does not establish event availability or runtime compatibility.

The event query's end time is now captured immediately before reading events, after module/provider initialization, and clipped to `min(UtcNow, start + 60 seconds)`. TypeScript validates against its fresh clock after the child returns or fails and rejects expired/future identities. This permits an own-process event published during module loading without opening an arbitrary future or stale query range. Exact PID/image/provider checks and all record/XML/output limits remain in force. Native observer completion and fault offsets remain pending.
