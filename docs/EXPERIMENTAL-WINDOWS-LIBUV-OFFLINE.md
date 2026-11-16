# Fixed libuv initialization feasibility probe

This is a separate trusted C program, not Node, a project-code runner or a general offline-runtime boundary.
Server 2022 has compiled both programs; useful native operation results remain pending. It does not enable any Windows coding gate.

The first [Server 2022/2025 run](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43804801904)
at `28ecd028` passed 315 contracts per job (one symlink-privilege case skipped) and verified/extracted the exact source.
Server 2022 selected the pinned tools, then stopped during stock CMake configuration because a backslash `-D` path
was parsed as an escape. Typed PATH/FILEPATH definitions now receive forward slashes after strict local-path validation.
Server 2025 stopped at tool selection; its actual published image contains VS2026 and CMake 4.4.5, differing from
the initial VS2022 recipe. Separate explicit image recipes now retain the same v143 compiler pin while selecting
the published Visual Studio/CMake family for each server. Neither C program was compiled or launched in that run.

At `0d938c14`, [the next run](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43805335292)
compiled both C programs on Server 2022 after 316 passing contracts (one expected symlink skip). Its native harness
then failed during the host phase without an exit/report receipt; no useful-work or LPAC success was established.
The harness now distinguishes fixed host substages and retains only stopped numeric host/report facts in a branded
failure receipt, after verified teardown. Missing stopped reports are explicit rather than losing the observed exit.

At `3780c8ae`, [both servers](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43806418378)
compiled both programs with the selected v143 family (observed compiler servicing versions 19.44.35229.0 and
19.44.35230.0, separately hash-recorded). All 318 contracts passed per server, with the one expected symlink skip.
Both ordinary-host variants exited 10 with no report, which identifies the C program's compound pre-libuv bootstrap
guard, not a libuv/LPAC outcome. That guard now has fixed distinct exits: 10 for argument count; 100/200 plus a
closed directory-validation reason for work/state; 300 for equal folders. Reasons identify missing/oversized values,
root/component/character rules, fixed-drive type or directory attributes without returning paths or argument text.
The original validation predicates are unchanged.

Run [43807658696](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43807658696)
at `f7a7bc363112980c89cb9ad79b684fc293f36cc9` built both programs on both images; each job passed 318 portable
contracts with one platform privilege skip. Both ordinary-host variants then exited 132 with no report: work
directory `GetFileAttributesW` returned `INVALID_FILE_ATTRIBUTES`, after the syntax and fixed-drive checks passed.
No LPAC process launched. Its immediate Win32 error is now encoded as `0xe1010000 | error` for work or
`0xe1020000 | error` for state when the error fits 16 bits; larger errors produce the fixed `0xe1ffffff` or
`0xe2ffffff` refusal. These stopped numeric bootstrap diagnostics expose no path or native message and do not
change any acceptance check.

Probe-only run [43808299610](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43808299610)
at `0aa005e26b64f460e7299840bdca8acb237d6e2d` returned `0xe1010005` for all four ordinary-host variants:
the immediate work-directory error is `ERROR_ACCESS_DENIED` (5). Both images built successfully and each passed
318 contracts with one privilege skip. No LPAC process launched. Subsequent diagnostics preserve that refusal
and add only fixed token predicates and failure-path directory facts. Exit bits 18 through 22 record successful
current-directory query, its equality to the selected directory, an exact attributes-only directory open,
ordinary non-reparse directory metadata, and successful handle close. The alternate open requests the same
attributes access and read/write sharing as the retained parent pins; its result never authorizes useful work.
The exact suspended host's token is also compared with the parent process token using query-only handles:
receipts contain only user-equality, restriction/AppContainer booleans and integrity RIDs. SID pointers must be
wholly contained in their bounded token buffers; raw SIDs are never returned. Unknown token ownership or close
failure quarantines the diagnostic. Facts are published only after native root/job stop and verified fixture cleanup.
No path, SID, native text, ACL or privilege change is involved. The access-denial cause remains pending.

The official Node experiment identified `WSAStartup / 10107` on both pinned versions and both Windows Server images,
with successful ordinary-host controls. See [the bounded native receipts](WINDOWS-NODE-LPAC-PROOF.md).
The immediate question is whether a few useful local libuv operations can run in the same capability-free LPAC
when unused Winsock initialization is omitted at compile time. Ignoring a failed attempted initialization, spoofing
Safe Mode, adding capabilities or changing host resource permissions would answer a different question.

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

Stock and offline host/LPAC pairs are separate. Each host uses an ordinary inspected token and its own private job;
its complete useful-work record and zero private stdio bytes are prerequisites for its LPAC launch. The LPAC root is
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
