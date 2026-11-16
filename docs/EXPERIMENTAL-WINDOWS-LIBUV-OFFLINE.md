# Fixed libuv initialization feasibility probe

The fixed verified-source C program now completes local file, loop, timer, worker and thread operations in
capability-free LPAC on Windows Server 2022 and 2025. This is a bounded C feasibility result. It does not establish
Node compatibility, a project-code runner or a general offline-runtime boundary, and enables no Windows coding gate.

## Completed native evidence

Run [43814351971](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43814351971)
tested exact commit `91de031cad2d53aa014037cd6eb9e8de8743a9fb`. Each Windows image passed **400 portable contracts**
with **one expected symlink-privilege skip**, then **all four native cases**. The separately enabled macOS portable
job was skipped in this run; earlier run [43810605648](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43810605648)
passed 177 portable contracts on macOS, including all 37 source cases.

| Case, on both Windows images | Observed stopped outcome |
| --- | --- |
| Stock host | Exit 0; all six useful features; complete callbacks, loop and cleanup witnesses |
| Offline host | Exit 0; the same complete useful-work witnesses |
| Stock LPAC | Preserved `0x80000003`, closed `WSAStartup / 10107` signature, checkpoint before loop initialization |
| Offline LPAC | Exit 0; all six features (`63`), 24-byte sync/async reads, every callback/join once, loop codes 0, cleanup `15`, zero stdio bytes |

Both ordinary-host controls matched their parents' user, High integrity RID (`12288`), AppContainer absence and
restricting-SID absence. Every result followed root exit, private-job zero and verified fixture cleanup. Raw native
text, private scratch, traces and dumps were not published.

The host control executes the original hash-verified build asset. Earlier run
[43813233759](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813233759)
showed that executing the deliberately LOW-labelled LPAC copy changed an ordinary host from High to Low, after
which work-directory metadata was denied. The [MIC process-creation contract](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)
explains the observed integrity change; the precise access-denial mechanism was not inferred. The corrected host
image selection preserves every LPAC label, ACL, capability, handle and workload.

The token diagnostic uses [IsTokenRestricted](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-istokenrestricted)
only for restricting-SID presence. Both native images returned one byte for `TokenHasRestrictions` in
[43811722242](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43811722242), despite
its documented DWORD description; that layout is not accepted or interpreted. The BOOL query uses the existing
TOKEN_QUERY handles, and FALSE requires immediate zero error after clearing only the thread-local diagnostic error.
SID pointers remain bounded inside token buffers. Unknown ownership or close failure quarantines the diagnostic.
No SID, token, policy, ACL or privilege change is exposed or performed.

The official Node experiment still identifies `WSAStartup / 10107` on both pinned versions and both Windows Server
images, with successful host startup controls. See [the Node receipts](WINDOWS-NODE-LPAC-PROOF.md). The fixed C
result answers whether its small set of local operations survives compile-time omission of unused Winsock
initialization. Ignoring a failed attempted initialization, spoofing Safe Mode, adding capabilities or changing
host resource permissions is outside this experiment.

## Exact source and separate build authority

Node 22.23.5's source archive is pinned to SHA-256
`6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a`.
The official manifest signature and annotated release tag were independently verified with the existing Node
release-key fingerprint `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. The tag resolves to commit
`60553651579ec33ca1aef9e1eedab2c3855f1f7e`. The pin records the key repository, tag object and signature hashes.

Only `node-v22.23.5/deps/uv/` is extracted after the complete archive hash is verified. Extraction accepts only exact
manifest-listed ordinary files and directories, refuses links, special objects, path traversal, Windows device/ADS
names, duplicate/case aliases and unknown entries, and enforces byte/count limits. Actual local preparation verified
155 files and 2,277,779 bytes. A separate offline tree has exactly one changed file, `src/win/core.c`; the fixed
guard omits its `uv__winsock_init()` call only under `EMBER_UV_FIXED_PROBE_OFFLINE=1`. Before/after file hashes and
both complete source manifests are pinned. The stock tree remains unmodified. Every source is revalidated after
its out-of-tree build.

The full PR test run at `f7a7bc3` exposed two macOS source-fixture failures at the strict destination check.
The test now canonicalizes its host-owned temporary base before creating scratch, accounting for Darwin's normal
`/var` alias. A local reproduction through an aliased temporary base and all 37 source contracts pass; the explicit
extractor alias refusal stays intact. Run `43810605648` subsequently passed all 37 source cases on actual macOS.

The new issuer is `ember-experimental-libuv-fixed-probe`. Its receipt binds the checked-out commit, fixed C program,
preparer and CMake recipe, exact source/patch manifests, selected tools and both executable hashes. Both recipes select
x64 v143 toolset 14.44.35207, SDK 10.0.26100.0 and a static runtime/library. Server 2022 uses VS2022/CMake 3.31.6;
the published VS2026 Server 2025 image uses VS2026/CMake 4.4.5 with its explicitly installed legacy v143 component.
Compiler/linker/CMake hashes
and the observed compiler version are recorded. Ambient compiler/toolchain flags, credentials and user build settings
are excluded from the child environment; host build profiles are fresh. The ordinary Windows token and mandatory OS
policy remain in effect. This build does not claim OpenJS Authenticode authority; the official Node verifier is unchanged.

## Fixed useful operations and independent controls

Both executables contain the same fixed C program. Its build-mode field does not change which operations it calls.
It accepts no supplied source, arbitrary argument, dynamic library or network operation. All paths refer to fresh
host-selected local NTFS work/state folders, with only the existing fresh-package grants.

It exercises:

- loop initialization, draining and close;
- synchronous creation, write, read, EOF and removal of one fixed local file;
- one queued file read and callback;
- a timer and its close callback;
- queued worker work and its completion callback;
- explicit thread creation and join, followed by global library shutdown.

The 96-byte report contains only a versioned numeric schema, stage/status/error fields, feature bits, byte counts,
callback counts and cleanup observations. A checkpoint is flushed before loop initialization. It cannot be read while
the program is running. Successful records require all six feature bits, exact fixed byte counts, every callback/join
witness, loop return codes and cleanup flags. Malformed, oversized, wrong-build/token or inconsistent records fail.

Stock and offline host/LPAC pairs are separate. Each host uses the original pinned build image and its own private
job. Exact PID/image checks follow that path; its observed user, integrity and restricting-SID facts must match the
parent. Its complete useful-work record and zero private stdio bytes are prerequisites for its LPAC launch. The LPAC root is
created suspended with zero capabilities and AAP opt-out, assigned to its job, and checked for exact image/PID/token
before resume. Compiled and staged images stay pinned and hash-checked. Exactly two fresh private stdio handles are
inherited; no credential, console, source-project or SDK handle is supplied.

The stock LPAC case preserves the observed Winsock failure as a diagnostic control. The offline case requires actual
successful local work. Reports/output are read only after root exit and job zero, and the outer receipt is returned
only after verified cleanup. Raw native output is never printed: the existing pinned parser can emit only public
source metadata, fixed refusal facts or a closed libuv operation/error code. Unknown host shutdown retains shared
fixture/IO/profile ownership; a known LPAC root/job still receives a non-disposing stop attempt. Unknown cleanup
quarantines owners and blocks later probes in that process. No raw output, private scratch, trace or dump is uploaded.

The dedicated workflow is `experimental-windows-libuv-offline.yml`, on Windows Server 2022 and 2025. Its positive
and negative outcomes must be recorded against the exact build/probe commit. Local platform skips are not native evidence.
Manual dispatch can additionally enable `portable_macos` to verify the portable source/receipt contracts on macOS;
the two native Windows jobs still run unconditionally. A portable-only pass cannot establish native compatibility.

## What this cannot establish

This program exposes no general libuv or Node interface. The linked library still contains networking code; a few
TCP/UDP/DNS denial stubs would not close that surface. The pinned public API also includes socket polling/import,
socketpair, generic stream dispatch, named-pipe socket transfer, interface/hostname queries and socket options.
Filesystem functions separately support UNC paths. Internal request/endgame dispatch retains network handlers.

A generic offline fork needs a complete pinned ABI classification, build failure on unknown additions and enforcement
before every applicable uninitialized network state or remote filesystem operation. A future Node build additionally
needs its own verified asset chain, native useful checks, denied network/host/IPC canaries, runtime and descendant
cleanup, command/file/review integration and supported-client acceptance. None of these follow from a successful
fixed C experiment, and no full Node build is part of this probe.
