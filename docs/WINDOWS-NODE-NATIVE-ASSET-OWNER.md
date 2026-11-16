# Disabled Windows Node asset owner

This foundation starts from canonical transfer `d526b644582c8cc3d234e5e045ec48ecdeae990e`. It copies the exact shared
manifest reviewed with the packaging foundation, without changing a backend selector, model tool or runtime pin.
No Windows command capability is enabled by this module.

The fixed Win64 factory takes host-selected resources/private-parent paths and a genuinely fresh creator-profile
reference. It reads only the three packaged `coding/windows-node-x64` members: Node, its complete licence and the
original producer receipt. They retain their literal hashes and sizes. The 120,219,136-byte Node image has its own
128 MiB class; project-file limits and the historical 16 MiB proof reader remain unchanged. Packaged originals are
opened read-only and receive no ACL change. There is no installed-Node search or runtime download.

Native component-relative opens check local fixed NTFS, ordinary objects, identities, link counts and streams.
Only a newly created tools root and `node.exe` receive protected host/SYSTEM full access, exact package-SID RX,
OWNER_RIGHTS READ_CONTROL and a Low no-write-up label. Native readback checks the exact owner, ACE set and label.
The fresh owner binds the profile independently of its command tree, so profile deletion refuses while assets remain.

The borrowed private parent is never relabelled or granted package rights. Its owner/DACL and actual label are read
at preparation and again before Resume. An explicit label must be Medium or higher with no-write-up; positively
verified absent/empty label uses Windows' documented Medium/no-write-up default. Low, malformed or ambiguous labels
refuse before a fresh asset is created. Both the primary and impersonation tokens must have enabled Low integrity
(`SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED`, `0x60`) and identical valid mandatory policies with
`TOKEN_MANDATORY_POLICY_NO_WRITE_UP` set. This contract depends on native MIC enforcement as well as DACL checks.

Hashing and copying use at most 64 KiB per operation and yield during preparation. The final executable hash is
computed through the actual write-denying runtime pin after every staging writer closes. Metadata-reference and
runtime-pin handovers compare the original created object before adoption. All large reads finish before any
suspended process is created; pre-Resume checks use only bounded identity, image and token queries.

The owner preserves literal argv and supplies no implicit compatibility flags. Its real output factory creates the
suspended PI. Copy's genuine witness hook checks asset-handle aliases, the exact held process image and token user,
package, capabilities, Low label and primary/duplicate restricting-SID facts. AccessCheck uses an owned impersonation
duplicate: RX succeeds, WRITE_DAC and WRITE_OWNER fail on both host-owned assets. A separate own-package-positive and
All Application Packages-negative descriptor pair checks behavioural AAP exclusion; it is not a formal class-46 query.
These checks precede Resume. DACL observations do not replace actual native MIC or write-denial tests.

Each asset use remains owned until its exact run/completed references authenticate genuine Stop/revoke and the real
output owner returns matching EOF/close evidence. A profile's assets may be reused only sequentially after each use
finishes. Closure removes only the known fresh objects through held identities and positively closes their owners.
No callback, Boolean, similarly named record or serialized receipt can attest native Stop or disposal. Unknown calls,
allocation overlap, reentry or cleanup retain owners behind a private permanent first-failure barrier.

Known task loss at authenticated clean boundaries uses a separate opaque two-phase cancellation claim. The real asset state, genuine Copy context,
monotonic native-entry history and a catch-local Stop phase authenticate it. Before PI creation, only an actual
empty-job Stop and completed revocation permit initial no-run recovery. A prior real generation stays stale. After
PI creation, a private successful asset-use registry binds the context, profile, generation and exact returned PI.
Stop checks its held PID/thread/job identities and issues a separate cleanup-only returned-root capability before
assignment, then probes at completed native boundaries before Resume. Copy's pure admission gates can use only
that same authentic frozen root and binding; no generic callback exception becomes a cancellation claim. A normally
returned attester can retire cleanly; its own thrown errors remain terminal.

The cleanup-only output match starts bounded drains for both streams even when the shared signal was already
aborted, and never publishes bytes. Actual root/job Stop and revocation finish before Copy returns the issued cancelled run. That run can close its exact output and assets,
but its failed asset attestation never becomes execution authority. Swallowed, forged, foreign or replayed claims
and every uncertain native operation remain terminal.

A returned-point cancellation may precede the native creator-token capture. Its positive stopped receipt records
no creator-attestation witness consumed and no Resume attempted. The native tree independently requires its exact
grant to remain prepared (real capture entry changes it to capturing), with no root/creator-owner claim. Before any
ACL mutation it checks the complete original post-grant ID set, freshly read metadata including the root, streams
and security. Added, removed, replaced or changed entries refuse. Callback entry or a generic root-present receipt
cannot substitute for this combined proof. Both EOFs, every settled read and positive output-handle/allocation
closure remain required before asset usage is released.

Genuine WindowsCodingCleanupError values from task admission poison the Copy, native tree and asset boundaries;
they cannot be downgraded to ordinary cancellation or authorise file revocation/closure after uncertainty. Ordinary
admission errors and false values still retire work when the private native ledgers are known clean.

Portable ABI tests stream synthetic marker bytes at the real fixed sizes. Their node:crypto boundary mock recognises
only exact marker content and length, with real UUIDs and no production manifest/hash override. They exercise actual
profile, Copy, Stop and output owners over injectable DLL boundaries; they do not run Windows APIs or the Node PE.
The separate packaging gate checks the real authenticated public artifact bytes. Neither establishes this new native
owner's Windows enforcement or product acceptance.

The CJS provenance gate bundles the real cyclic production graph with the production main build's Node22/CommonJS
settings, checks one instance of each issuer, and runs both known-cancellation phases over ABI models. A separately
evaluated graph rejects genuine foreign claims and run/completed/output references. No issuing API is substituted.

Microsoft contracts consulted: [Mandatory integrity control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control),
[TOKEN_MANDATORY_POLICY](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_mandatory_policy),
[SID_AND_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-sid_and_attributes), and
[MandatoryIntegrityCheck](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/ae69a089-473d-4c23-bf3d-7a12a9d11123).
Portable AccessCheck observations cannot prove the kernel's parent write-up denial. Exact-source Windows tests must
still attempt WRITE_DAC/WRITE_OWNER on the Medium borrowed parent and both Low host-owned assets, with genuine
Node execution and output, natural exit, overflow/explicit cancellation, precreate/pre-Resume cancellation, complete
Stop/revoke/output closure and known cleanup on both supported images before product admission.

The initial `5ef8b2fc88e5f9f83b941ead57bada5d7c6b64c3` foundation's affected validation passed 1,104 tests in 19 suites with two workers and unchanged 5-second test deadlines;
scoped ESLint and whitespace checks passed, and Root plus independent source review closed clean. An initial two-case
cancellation check hit that deadline; the isolated phase1 rerun and later nine-case focused batch passed. An earlier
unrestricted affected aggregate recorded 1,100 passes and four deadline failures; no source or deadline changed
before the passing bounded-worker aggregate. Full semantic TypeScript session 3065 exited 2 for six local typing
errors. Explicit option-value narrowing (including a redundant numeric guard) and erased method-parameter types
corrected them without changing accepted inputs or authority. All 90 focused asset/transfer/CJS cases then passed
with the same bounds; both reviews reclosed on those exact bytes. Final unchanged `npm run typecheck` session
96111 exited 0.

The additive returned-root/shared-signal correction passed 1,142 tests in 19 suites (session 18043, two workers,
unchanged 5-second test deadlines), including 128 asset/transfer/CJS cases and 38 new regressions. Root and two
independent source reviewers closed clean; scoped source/test ESLint and whitespace checks passed. An initial
23-case focused run recorded 19 passes and four deadline failures; its four-case serial retry recorded three
further deadline failures and one `missing` setup failure. The isolated removed-member case then passed, the full
15-case canonical transfer run passed, and the final 1,142-case aggregate passed. No cause is attributed to the
intermediate timing/setup failures and no deadline was increased.

Full semantic TypeScript session 28761 exited 2 for one test-only Buffer generic mismatch. An equivalent
`Buffer.from(file.bytes)` at the already-cloning replacement fixture boundary corrected it; that exact regression
passed separately (72384), with lint/whitespace checks passing and production hashes unchanged. Final unchanged
`npm run typecheck` session 31020 exited 0. No native execution, selector change or historical runtime-pin refresh
follows from this correction; its new Windows enforcement graph and coordinator acceptance remain separate gates.
