# Fixed libuv initialization feasibility probe

This is a separate trusted C program, not Node, a project-code runner or a general offline-runtime boundary.
Native Windows compilation and results are pending. It does not enable any Windows coding gate.

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
preparer and CMake recipe, exact source/patch manifests, selected tools and both executable hashes. The recipe selects
VS2022 x64 toolset 14.44.35207, SDK 10.0.26100.0, CMake 3.31.6 and a static runtime/library. Compiler/linker/CMake hashes
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
