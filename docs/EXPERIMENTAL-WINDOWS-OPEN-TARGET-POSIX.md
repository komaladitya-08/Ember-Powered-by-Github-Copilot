# Pinned POSIX replacement control

This is a separate ordinary-host, fixed-program experiment based on commit
`0a86cfb1682075fa1683ce335f51e053290195e8` (#248). It does not change the original
MoveFileEx proof, the production Native factory, Node, command admission or any
product gate. The completed original host comparison, run `43940899008`, observed
A success and B `ERROR_ACCESS_DENIED` (5) on Server 2022 and Server 2025 while
retaining the same target metadata parameters. That result does not establish
LPAC behaviour without pins or generic Node compatibility.

The new C program uses the reviewed SDK's user-mode `FileRenameInfoEx` (22),
`FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS` (3), and a
bounded, aligned `FILE_RENAME_INFO` buffer. Static SDK assertions bind its x64
layout and the exact 64-bit `BY_HANDLE_FILE_INFORMATION` index/32-bit volume
serial/creation-time layout. The target is an ordinary fixed absolute name on
the same NTFS volume. A source is opened once with DELETE | FILE_READ_ATTRIBUTES (`0x10080`), share 7,
OPEN_EXISTING and OPEN_REPARSE_POINT, queried once before rename and positively
closed once after the single setter. There is no retry, MoveFileEx fallback,
readonly override, privilege change or extra capability. An uncertain close
prevents publication and leaves the fixed process for the parent's deadline and
known Stop. A must succeed before B becomes an observation.

Both fresh targets receive byte-identical owner, DACL, LOW label, inheritance,
attributes and initial bytes. The root and ancestor pins are common. A never
enters a long-lived target-metadata phase. B holds exactly access `0x1e0080`,
share `7`, options `0x200060` through the genuine root-only Stop. This is a
parameter-equivalent control, not a composition of the original tree factory;
that factory always pins staged objects and is unchanged. The ordinary process
is the exact fresh hash-admitted image, with the ordinary token and the same
root-only job and suspended attestation. The five environment entries are fixed,
sorted Unicode and contain no ambient credentials.

The new 160-byte schema-2 report requires complete preparations, two native
attempts, positive source-open/close/identity masks, A success and exact API
identifiers. The private source tuples are captured from each owned source
handle before rename. They are used only after genuine Stop to match each new
target's exact source identity, volume, creation time and fixed replacement
bytes. The decoder projects no tuple, SID, path, handle, PID, timestamp or file
contents. Native retains the exact issued private report through comparison and
cleanup, wipes it after known cleanup, and retains the whole graph on any
uncertainty. The public result contains finite numeric status and match bits.

After Stop, B's still-held old object must keep its original identity, type,
creation time, expected size, owner/DACL/LOW state and sole default stream. Both
reported link counts must agree and be 0 or 1; DeletePending must be 0 or 1.
The public `oldLinks` and `oldDeletePending` values are bounded observations.
`legacyDetached` evaluates the unchanged original detached predicate: links 1
with pending 0 is false; other states require pending 1, and links 1 additionally
requires a positively queried path within the initial captured final path of the
still-held root. A failed path
query is a refusal. Zero links alone is never deletion proof. A known false
predicate may be reported by this fixed ordinary-host control, but never grants
original Native cleanup authority or runtime compatibility. All original
identity/security/link/stream guards remain mandatory before the separate
fixed-tree cleanup; no old target pin is closed before these observations.

The experiment covers fixed regular files only. It does not establish directory
replacement, rename with open descendants, cross-volume moves, streams,
hardlinks, reparse points, readonly overrides, arbitrary project writes, LPAC
success, Node error equivalence or consumer Windows 10/11 compatibility. Even
successful replacement with all pins held is insufficient until the retained
old object's legacy retirement predicate is also observed and a separately
reviewed zero-capability LPAC proof succeeds. No Node patch or rebuild is part
of this branch.

## Source and run authority

`verifyWindowsOpenTargetPosixRun` binds 23 reviewed source inputs, a fixed image
and the actual current compile commit before native admission. The verifier's
own file is deliberately omitted from its hash list; the trusted fresh hosted
checkout supplies the verifier. These hashes bind reviewed bytes and are not
publisher authentication or exclusion of hostile same-user concurrent writers.
The compiled issuer is `ember-ordinary-host-open-target-posix-build-v1`; the run
issuer is `ember-ordinary-host-open-target-posix-run-v1`. Old issuers and receipts
are not reused. The producer rechecks its captured inputs and observed hosted
compiler/recipe/PE fingerprints. Fresh compilation of related source does not
promise identical PE bytes or establish unique flag causality.

The workflow registers portable contracts on the exact new PR branch and runs
native jobs only for explicit workflow_dispatch on that same branch. Its two
fresh Windows workers never run a failing baseline and then reset a fence to
try this variant. It uploads no runtime report, source identity or private
scratch. Unknown ownership prevents cleanup, result publication and later
admission; a disposable hosted worker can then be discarded.

## References

- [Pinned SDK FILE_RENAME_INFO and flags](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h#L9140)
- [Pinned user FILE_INFO_BY_HANDLE_CLASS](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/minwinbase.h#L178)
- [File rename information and POSIX replacement](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
- [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
- [FILE_STANDARD_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)

The POSIX documentation promises continued validity of old target handles. It
does not promise the DeletePending bit returned after replacement. Native
execution of this new control is pending; no compatibility result is claimed.

## Local validation

The four new portable files pass 366 tests, including 32 Linux-only actual-C-body
logic cases. The composed old/new eight-file regression gate passes 665 tests
with no skips. The 32 new C logic cases intentionally skip on Windows; a native
worker therefore expects 334 portable passes and 32 skips before its one
required observation. Scoped lint, producer syntax, YAML and all 23 runtime pins
pass. Explicitly requiring this control on Linux fails before any build scratch
is created. The Linux logic mocks do not establish the Windows SDK ABI or kernel
behaviour. The exact-final `npm run typecheck` passes (session 87901). Native
execution is pending; no Windows compatibility result is claimed.
