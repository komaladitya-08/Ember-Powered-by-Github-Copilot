# Fixed Windows creator-owner experiment

This is a fixed-C experiment for a root-only copied work tree. It
does not enable a command backend, a shell, Node project execution, or descendant
processes. Native acceptance on both hosted Windows images remains pending.

The preceding DETACHED comparison, draft #239 at
`3afc9828168031bff6aaee46402397cecafea9f3`, reached a strict owner refusal on both
Server 2022 and Server 2025 in run `43894369833`. The finite observation was
Native stage 7, operation 24, predicate 7, owner class 4, file kind, non-root,
inherited ACL, and not detached. Class 4 identifies the public Builtin
Administrators SID. That observation does not establish the creator token's
default owner or the failing C operation. No useful-work, revoke, or cleanup
success was accepted.

The first creator-owner matrix, run `43910559432` at head
`3871b17f0d2e5075219c9fe12e0428bb5b6153ae`, compiled the new producer on both
images and passed 1,437 portable contracts with one expected skip per image.
The ordinary-host four-access control completed and the creator-enabled launch
returned. The useful C root then exited 1, and revoke stopped at Native stage 7,
GetAce operation 27, predicate 7. The receipt was phase 3, subphase 4, with no
accepted failed report, useful completion, private owner readback or cleanup.
That shared ACL predicate does not identify a particular ACE or permission
failure. The C failure remains unclassified because failed-report acquisition
requires a complete positive Stop and revoke.

An evidence-only follow-up preserves every ACL predicate and native call, adding
the first failed ACE constraint after refusal:

| ID | Original failed condition |
| --- | --- |
| 1–4 | DACL header length, type, flags, size, in that order |
| 5 | Exact DACL SID/mask set |
| 6–11 | Mandatory-label header length, type, flags, mask, size, LOW SID, in that order |

An exactly eight-byte returned header may contribute its type and flags
(0–255), size (0–65,535), mask (DWORD), and already computed expected flags.
Constraint 5 instead projects the two or three already decoded DACL rows as a
known SID class (host user, package, SYSTEM, public builtin Administrators, or
other) plus DWORD mask. Node kind, root status, ACL provenance and detached
status describe the existing check. Every published record, header, row and
array is frozen. No SID, path, file data, pointer, new query or repeated SID
decode is added. The final LOW-SID constraint is inferred only after the earlier
arms of the unchanged original predicate passed. These facts grant no cleanup
or permission authority, and the first failure remains authoritative.

The second matrix, run `43913675852` at head
`2025830b91bffdc50155fac44a53656751faaa13`, passed 1,471 contracts with one
expected skip on each image, then failed its native test. Both receipts identify
constraint 3 on a non-root, current file tagged as inherited by the tree walk:
type 0, flags 0, size 36, mask `0x1f01ff`, expected flags 16. That tag describes
the unknown-ID provenance; it does not prove Windows' inheritance control state.
The remaining ACL rows and C exit 1 are still unclassified. There is no accepted
failed report, useful completion, owner normalisation or cleanup result.

## Establishing the parent inheritance model

The original construction uses `D:P` and `NtSetSecurityObject`. `P` means
protected, while `AR` and `AI` are distinct automatic-inheritance request and
model bits. Merely adding `AI` text or accepting ACE flags 0 would not prove the
intended conversion. Microsoft documents that `SetSecurityInfo` imposes the
current inheritance model on an NTFS hierarchy; the raw native setter has no
equivalent documented conversion promise:

- [SDDL control flags](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-string-format)
- [Automatic propagation](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces)
- [SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)
- [NtSetSecurityObject](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetsecurityobject)

The local correction is opt-in to the creator-profile grant. Before any root
launch, the complete bounded tree must be private, host-owned and protected,
with no previous untrusted writer remaining. Each held object receives the same
protected grant DACL and LOW label through `SetSecurityInfo(SE_FILE_OBJECT)`
using the unchanged `0x80000014` mask and null owner/group parameters. Existing
metadata handles already have WRITE_DAC and WRITE_OWNER; no privilege is enabled.
Default unprofiled grants and every post-Stop native owner-transfer/revoke
operation retain their original route and masks.

The converted descriptor remains one owned allocation. Its length is bounded
to 20–65,536 bytes. `GetSecurityDescriptorDacl` and `GetSecurityDescriptorSacl`
use 32-bit BOOL outputs with unwritten sentinels; both ACLs must be present and
nondefaulted. The nonnull aligned views and complete ACL spans must lie inside
that allocation and be disjoint. ACL headers must have the fixed expected
three/one ACE counts and enough space for those entries. The views are borrowed
and never independently freed. Uncertain extraction or setter completion
retains the descriptor and tree.

`SetSecurityInfo` can propagate into existing descendants. Every staged child
has a protected DACL and was included in the preflight; LOW-label propagation
remains confined to that same entirely known, stopped tree. Every object is
explicitly set and strictly revalidated. Before admission, the returned control
must show both DACL and SACL `AUTO_INHERITED` bits (`0x0c00`) alongside all
original owner, DACL, label, protection and identity checks. A complete second
walk must retain every ID and the pregrant size, write time and attributes,
with no new or replaced entry. The original required child ACE flags 16/19 and
full SID/mask checks remain unchanged.

New operation IDs 28–31 identify descriptor length, DACL view, SACL view and
`SetSecurityInfo`. Domain 3 reports only an actual bounded DWORD status returned
by the setter; it performs no GetLastError query. A failed automatic-control
readback may report the already returned valid control WORD and existing node
context. No such fact permits Resume, bytes, revocation or cleanup. The native
outcome of this correction remains pending.

## Authority and normalisation

The new path is opt-in and uses a separately compiled C program, report schema,
run issuer and build issuer. Existing root-copy and DETACHED build authority is
unchanged. The root remains subject to `ACTIVE_PROCESS_LIMIT=1`, lifetime
accounting, the original exact token/image/job attestation, deadlines and Stop
conditions. The fixed DETACHED loader still changes only the original root
CreateProcessW flags `0x08080404` to `0x0008040c`.

The default native profile factory creates a fresh top-level AppContainer
profile and issues an opaque reference from a private WeakMap. Callers cannot
mint a reference from a supplied SID or an injected API claim. The profile can
bind to one live tree. Unknown allocation, alias, deletion or FreeSid completion
permanently fences its native ownership universe; no later profile/tree
admission or retry can clear that uncertainty.

Only the fresh top-level SID shape is accepted: revision 1, authority 15, base
RID 2, eight subauthorities, and 40 bytes. Builtin package SIDs, restricted
all-packages SIDs, child-package SIDs and other shapes refuse without adopting
or deleting an uncertain result. The pinned Microsoft SDK header defines
`SECURITY_BUILTIN_APP_PACKAGE_RID_COUNT=2`,
`SECURITY_APP_PACKAGE_RID_COUNT=8`, and
`SECURITY_CHILD_PACKAGE_RID_COUNT=12`:
[winnt.h at 15fc870a5e96df7c560877ff30136c0fb5a21e9b](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/winnt.h#L11086).

After the original suspended-root attestation succeeds, Stop issues a private,
synchronous, one-use attesting reference bound to that same held root and copy
run. Before Resume, Native captures TokenUser (class 1), AppContainerSid (class
31), and TokenOwner (class 4) through one TOKEN_QUERY handle. User and package
must match the already admitted host user and fresh profile. Each returned SID
must lie inside the actual returned buffer, with its revision and full
subauthority extent validated. TokenOwner is captured independently; it is not
inferred from TokenUser, group membership or the preceding public owner class.
The token handle must close positively before Resume. Every capture operation
rechecks the original admission callback and both native ownership fences.
Capture failure, cancellation, asynchronous attestation, alias or uncertain
close retains ownership and refuses Resume.

Revoke authenticates the original private Stop receipt against the exact run
binding before permitting any non-host owner. A receipt for an empty job cannot
stand in for a launched root with missing capture. Without a captured creator,
new, replaced or detached IDs are refused. Root, initial and previously known
IDs retain strict host ownership; renaming an existing ID cannot make it new.

For an unknown current ID only, the exact captured creator owner may pass the
preflight together with the unchanged inherited DACL, LOW label, regular NTFS
type, stream, identity, link and resource bounds. Every object is checked before
the first ACL mutation. Detached original objects retain strict host ownership.
An exact creator-owned new object is then normalised through the already held
WRITE_OWNER/WRITE_DAC metadata handle using `0x80000015` (OWNER, DACL, LABEL and
protected DACL). Host-owned objects retain the original `0x80000014` mask.
Readback requires the host TokenUser owner, private host/SYSTEM DACL with no
package grant, LOW label and unchanged object identity. A complete second walk
must agree before a detached snapshot or another generation can be admitted.
Unknown or partial transfer/readback failures retain the graph and expose no
work bytes.

## In-run confinement controls

The new C report is exactly 128 bytes, schema 2. Before the original eight useful
operations, C creates a file and directory, then tries WRITE_DAC and WRITE_OWNER
on each. Every LPAC open must fail with access denied. An ordinary-host control
uses the same four access requests on its own fresh objects and must succeed.
An unexpected LPAC grant is closed once if ownership is known and remains a
failed observation; no ACL mutation is attempted. Unknown handle close waits
for Stop and cannot publish a completed report. Post-Stop normalisation cannot
turn an in-run permission failure into success.

The existing protected source/canary denials, useful edits and creation,
rename/deletion, revoked-package denials, writer Stop, stable snapshot,
retired-admission refusal, source equality and complete cleanup assertions
remain required. Natural exit and genuine complete Stop/revoke precede report
reads. Fixed numeric reports carry no private paths, SIDs, PIDs, file contents,
or security descriptors.

## Build and run identity

The compiled issuer is
`ember-root-only-creator-owner-observed-build-v1`, scope 2; the run issuer is
`ember-root-only-creator-owner-run-v1`, schema 2. The new producer bundles 19
fixed exports in one emitted CJS module so profile, token and Stop WeakMaps share
one module graph. The original C source, producer and 12-export authority remain
separate. The actual new compile commit and Windows image are recorded. A fresh
compile does not imply identical PE bytes to an earlier experiment.

The run verifier binds 28 fixed public runtime input hashes from the reviewed
checkout. Its own source is covered by the reviewed commit rather than a
self-referential hash. Held-file reads are bounded, each API's own metadata
clocks are checked independently, and a failed descriptor close permanently
refuses later verification. These hashes identify code under the trusted fresh
CI checkout; they are not independent publisher authentication or a claim of
exclusion against a hostile concurrent same-user writer. The producer separately
reconciles consumed sources, tool/recipe receipts and the resulting x64 PE.

The dedicated workflow uses a fresh job on each hosted Windows image and runs
only for this exact experiment head or explicit dispatch. It never retries a
failed baseline by resetting a worker. There is no native success receipt yet;
the experiment must remain a draft until the actual controls and cleanup pass.

## Portable verification

The final 18-file affected contract batch passed 1,533 tests with no skips,
including the emitted 19-export CJS graph, bounded token ABI, actual
coordinator/Native/Stop composition, strict report decoder and source verifier.
The historical DETACHED verifier's positive unit cases use three bounded,
independently hash-checked public baseline source blobs as test data. Its runtime
verifier, 18 source pins and issuer remain unchanged, and a separate case proves
that it refuses the changed Creator checkout. No baseline source is executed or
given authority over the new run. Scoped TypeScript/MJS lint, workflow YAML
parsing and diff checks passed. An
explicitly required run on Linux failed in `beforeAll` with the Windows-x64
requirement before preparation or native acquisition; its test was skipped by
the failed suite, so this is refusal coverage, not a native pass. Independent
read-only reviews closed the producer, main harness, host control, profile,
Stop, coordinator and Native ownership scope. The first full TypeScript check
reported four return-narrowing/test-double typing findings. After those narrow
fixes, the six affected suites passed 458 tests, lint passed, and a fresh full
`npm run typecheck` passed for the ownership implementation. The exact-final
full TypeScript check including the historical-test follow-up also passed.
The ACE diagnostic adds 34 passing boundary cases; its exact-final full
TypeScript check also passed.
The automatic-grant correction adds 61 passing API, ownership, refusal and
rewalk cases; its exact-final full TypeScript check also passed. Both native matrices
failed as recorded above. The automatic-grant correction has not yet run on
Windows.
