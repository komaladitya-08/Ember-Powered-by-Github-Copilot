# Fixed libuv spawn localization witness

This separate experiment prepares one trusted C root and inert fixed child against the exact libuv bundled with
Node 22.23.5. Its first Windows workflow is **compile and emission review only**. It runs no C image, LPAC process,
Node program or native integration case. Native admission remains held until the actual compiler emission is reviewed.

The existing source Node image and all six assertions remain unchanged. In
[the native-only replay](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/237), the four original
controls passed: ordinary official Node startup, official LPAC Winsock refusal, and useful filesystem/async/timer
work in both ordinary and zero-capability source Node. The two child assertions still failed. The fixed spawn literal
reported synchronous `EPERM`, errno `-4048`; the default test runner supplied no accepted failure frame. Neither fact
identifies the failing Windows API. Existing direct C child denials and the detached-root child-policy result likewise
do not assign Node's failure to `CreateProcessW` or a child-process policy.

## Exact source and separate authority

The issuer is `ember-experimental-windows-uv-spawn-fixed-probe`. It has no OpenJS binary-signing authority and does not
modify the original signed-Node verifier, the old standalone libuv probe, any previous artifact pin or a product gate.
The signed Node archive is 50,529,596 bytes, SHA-256
`6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a`, release commit
`60553651579ec33ca1aef9e1eedab2c3855f1f7e`. Its recorded release-key fingerprint is
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.

Only the authenticated 155-file `deps/uv` catalogue is extracted. Stock has 2,277,779 bytes. The separate working copy
has 2,278,938 bytes and exactly two source changes: the existing compile-time Winsock-initialization guard and the exact
upstream [LOCAL namespace backport](https://github.com/libuv/libuv/commit/2cadaa40167050baf7c6905ac897e6fb57afb2c6).
The working manifest is `2539fd38c07e40601381fd3d8c72410893812a6aa6da7ce1a9b885c617423fb8`.
The patched pipe file is SHA-256 `0739cb731a3e21eb23a7ee69ba2f1251542f34a06838cd115aa69e4a4bcc7b54`.
The upstream helper's global-prefix fallback, ignored token-close result and pipe-name retries are preserved.
There is no OpenSSL dependency or CNG change in this C-only experiment.

The external CMake overlay leaves every upstream source byte and the upstream CMake file unchanged. It removes the
one CMake `_WIN32_WINNT=0x0A00` definition and replaces it with exactly `0x0602`, the value declared by the pinned
Node libuv GYP recipe, before SDK or `uv.h` inclusion. Compile guards and both generated Release x64 project readbacks
bind that definition. The standalone CMake defaults and optimisation/LTCG are still distinct from a complete Node build.

The first recipe selects Server 2022, VS 17, v143 14.44.35207, SDK 10.0.26100.0, CMake 3.31.6, hosted Python 3.12.10,
static libuv and `/MT`. Python is attested before extraction. Selected tools, generated projects, source manifests,
both exact patches and every fixed compile input are hashed before/after the trusted build. Captured command failures
emit only a fixed stage. The PE receives ordinary bounded section/entry checks and staged hash readback.

## Fixed call and observations

The root accepts no arguments; its only child mode is the literal `--leaf`. It creates three non-IPC `uv_pipe_t`
handles. Each stdio slot uses exactly `UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE` (`0x31`), with
`stdio_count=3`, `options.flags=0`, inherited cwd and a fixed clean environment array. It supplies no shell, detach,
hide, overlapped-stdio, identity or arbitrary-code option.

That route is pinned at `process.c:1005` → `process-stdio.c:244` → `uv__create_stdio_pipe_pair`. The exact patched
`pipe.c` reaches `CreateNamedPipeA:252`, `CreateFileA:333`, `ConnectNamedPipe:361`, and `CreateIoCompletionPort:467`,
then `process.c:1067` calls `CreateProcessW`. The LOCAL hunk covers this internal stdio path as well as exported pipe
operations; the wide named-pipe call in `uv_pipe_bind` is a different route.

Only the two relevant translation units receive the SDK-first observation header. Five exact `WINAPI` wrappers call
the real imports once, forward every original argument and return the original `HANDLE` or `BOOL`. They record only
preallocated scalar observations; they add no `GetLastError`, `SetLastError`, native query, logging or allocation.
A C11 type assertion checks each selected SDK declaration and wrapper, including pointer widths and mutable command
line, before the aliases are defined. The translation has its separate `int(int)` assertion.
A sixth wrapper delegates the existing `process.c` `uv_translate_sys_error` call once, recording its already captured
integer argument and unchanged return. A thread-local ledger is armed only for the one synchronous spawn call.

The ledger contains bounded counts, result bits, operation IDs and the existing translation/final return. Unknown,
overflow, reentry or mismatched observations cannot establish useful work. A first denied pipe attempt may be retried;
`ConnectNamedPipe(FALSE, ERROR_PIPE_CONNECTED)` is accepted upstream. Cwd/PATH failures can precede all five wrappers,
and direct `done_uv` errors bypass translation. The decoder never labels the last or first FALSE alone as the cause.
Both Windows errors 5 and 1314 map to `UV_EPERM`, so `-4048` alone does not distinguish them.

The private assembly listing and observer object are bounded and hashed. Only closed metadata for six fixed function
IDs is publishable: counts, masks, fixed delegate IDs, hashes and `candidate` or `refused`. Unknown transfers use ID 0;
no assembly/source line, symbol, path, address, operand or raw compiler output is published. `candidate` means only
recognised unproven syntax. Its `review: "not-reviewed"` is never native admission or LastError-transparency proof.
The first workflow stays compile-only regardless of those counts, with `/GS` retained.

## Held native scope and lifetime

The prepared native harness retains the original root launch flags and a private outer job limited to two processes,
without breakaway. The original build image is the ordinary host control; the separate readonly LOW-labelled copy is
the LPAC image. Root image/token checks precede resume. The LPAC has zero capabilities and AAP opt-out. Protected
host-canary and privileged-parent-handle controls remain; exactly two private incoming stdio handles are inherited.

For a successful spawn, the fixed leaf waits for a fixed ACK. The parent holds and checks its exact image, job and
ordinary or LPAC token before ACK; the root then transfers 12 fixed input bytes and validates 14 fixed output bytes
with empty stderr. That ACK follows trusted child initialisation and is not general pre-execution admission.
The ordinary same-route useful exchange must pass before any LPAC attempt. A complete synchronous LPAC refusal is
an observation and has `useful:false`; it is never compatibility success.

The 256-byte numeric report is written only after the C loop and callbacks are closed. `processClosed` means a libuv
close callback, including an initialised failed-spawn handle; it does not certify an ignored internal native close.
No report is read before natural root completion, private-job zero and held-child Stop. Writer-excluding pins precede
readback, and complete known cleanup precedes publication. The Stop interval remains 15 seconds. Unknown owners,
missing natural completion or failed native close/pin retain their private owners even if a later non-disposing Stop
succeeds. Malformed content alone does not revoke independently proven cleanup authority. Hosted scratch uses canonical
`RUNNER_TEMP`, disjoint in both directions from the integration runner's managed temporary tree, with no fallback.

The C witness has a different PE/CRT, initialisation, environment/path, package instance, fixed argv and outer-job
constraints from Node. It can localise only its own observed call. Even a matching error does not prove the immutable
Node image failed at the same site, resolve `node --test`, establish a general offline runtime, admit arbitrary project
code or enable Ember's Windows coding gate.

## Verification state

The first automatic compile-only run
[43894712995](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43894712995), at head
`73a65938520ac39d0eda93ebab5548d70d4d17b0`, passed all 263 Linux portable tests. Windows passed 241 tests and skipped
the 22 Linux-only observer/ABI cases, then verified the source archive's fixed size and SHA-256. Its build entry step
returned exit 1 after 39 seconds with only the fixed build-contract refusal. There was no finer accepted checkpoint,
public compiler code, verified build receipt/PE or emission artifact; upload was skipped. The elapsed time does not establish
whether compilation ran or which check refused. Neither job executed the fixed C image or a native probe.

The follow-up adds only private first-failure branding and a closed numeric build checkpoint. It does not inspect
foreign error properties or publish caught errors, stdout, stderr, commands, paths or assembly. Configure and compiler
execution have separate checkpoints from their subsequent metadata/readback checks. This is evidence collection,
with the same source, flags, tools, timeouts and native hold; it is not a presumed fix for the first refusal.
The [fixed checkpoint catalogue](../scripts/experimental/windows-uv-spawn-build-diagnostic.mjs) defines 0 as unknown
and 1–20 as the owned input, setup, source/tool, compiler, emitted-output and receipt boundaries. Only the invocation's
earliest privately branded failure is projected into `{schema:1,status:"failed",checkpoint:<number>}`.
The follow-up passed 293 affected tests across eleven suites, scoped lint, syntax, YAML and diff checks. A fresh
typecheck passed before a subsequent assertion-only correction that prevents unexpected CLI streams from printing
on test failure; the same exact JSON/status predicates remain, and all 30 diagnostic tests and lint passed afterward.

The automatic diagnostic retry
[43897227391](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43897227391), at head
`b7af0852d8995ce3c0f3f0cbe214d95b99837939`, passed 293 Linux tests and 271 Windows tests with the same 22 expected
Linux-only skips. Windows returned `{schema:1,status:"failed",checkpoint:7}` during version retrieval, parsing or
validation. The source/identity stages before it completed, but source-before, configure and compilation were not
reached. Upload was skipped and no build/emission artifact or native result was produced. This identifies an owned
phase, not a particular observed version mismatch or command failure.

The phase-7 evidence extension distinguishes the PowerShell call, JSON decoding and shape check; the CMake call
and exact banner check; the VS/MSBuild version calls; and the six existing format checks followed by their existing
prefix/exact comparisons. Only checkpoint 7 adds `versionDiagnostic`, with a fixed numeric subcheckpoint and six
tool slots: VS, compiler, linker, MSBuild, Python and CMake. Each slot is unobserved, numeric or unprojectable; only
an anchored two-to-four-component numeric version with every component at most 999999 yields a numeric array.
No suffix, arbitrary string, tool path or captured output survives. Python comes from the earlier successful
attestation and CMake from its actual exact-prefix banner. All observations are copied and frozen at the first
owned failure. This projection does not change the original three-to-four-component validation, any prefix/exact
pin, tool invocation, order or native hold. Other checkpoints retain their original diagnostic shape.
The phase-7 follow-up passed 317 affected tests across eleven suites, scoped lint, final typecheck, syntax and YAML checks. An earlier
batch had one five-second deadline failure in the unchanged archive-refusal test; all seven source tests passed
alone, then the fresh 317-test batch passed without changing the test, source helper or deadline.

The third automatic run
[43901518918](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43901518918), at head
`1eecaaf3e3c28c460ee007bc945d834e05d04773`, passed 317 Linux tests and 295 Windows tests with 22 expected skips.
Windows stopped at checkpoint 7/subcheckpoint 1, the PowerShell version process. Only the earlier Python attestation
was observed as `[3,12,10]`; the other five tool slots remained unobserved. PowerShell supplied no accepted output,
so JSON parsing, CMake and compilation were not reached. This is not an observed pin mismatch. No artifact or native
result was produced; the process exit/spawn/timeout cause was not yet distinguished.

The PowerShell-only outcome diagnostic replaces that one capture with one equivalent `spawnSync` invocation. Its
program, arguments, clean environment, cwd, 30-second timeout, 65,536-byte buffer, UTF-8 encoding, hidden-window and
private-pipe options stay unchanged. Only own data descriptors of the captured result's status, signal and error,
and that captured error's code, can contribute to a closed numeric projection. Getter/trap/malformed results remain
unknown failures; status zero with an extra error, any signal and nonzero status remain failures. No exception
message, stack, path, stderr or output array is inspected. Success-only stdout stays in a private capture and reaches
the existing parser through the same trim; it is never an enumerable result or diagnostic field. Only phase 7 may
snapshot the owned numeric process outcome at its first failure. No extra invocation, retry, preflight, fallback,
version-pin change or native execution is added.
This follow-up passed 349 affected tests across twelve suites, scoped lint, final typecheck, syntax and YAML checks;
the 120 focused capture/diagnostic/build cases include real fixed Node process faults, not a PowerShell or Windows run.

Portable source, recipe, decoder, actual observer C-shim and native-owner fault tests are implemented. The Linux shim
uses test-only Win32 declarations around the production observer; it is not Windows ABI, policy or native evidence.
The initial frozen affected batch passed 263 tests across ten suites with no skips. Scoped ESLint, final `tsc --noEmit`,
YAML/action pins/job-scope and diff checks passed. New source preparation against the existing authenticated archive also passed: both 155-file
stock/working trees were independently revalidated against the exact manifests above, without a download or build.
The Windows build/emission verification and all native outcomes remain pending. The reviewed workflow may
compile and publish only the public fixed PE, licence, compact receipt and closed unreviewed emission metadata.
