# Fixed native Windows Node asset DACL witness V4

V4 is a separate test-only DACL scope for the actual product candidate. Its run/build issuers end in `-v4`, its
schema and scope are4, and only C exit49 with the exact V4 frames certifies its access prelude. V1/V2/V3 codes,
frames, counters and receipts never satisfy V4. All failed historical runs below remain failures. No production
module, selector, model tool, asset API, stager or public capability is changed by this probe. Product readiness
and native prerequisite flags remain false until their separate reviewed gates pass.

The probe files were brought from immutable `e13766e22d8181cee83b8cc6612dc533f08acb99` into the product worktree
at `89768751435b908826a93ae82adcd089099cea3b`. Old production or packaging files were not copied over the candidate.
The proof bundles the current production factory, Copy, profile, Stop and output owners in one CommonJS graph.
Real esbuild onLoad snapshots and metafile reconciliation cover the actual transitive inputs, including the
current COMMON/resource code. Every emitted input must appear in the exact source-pin catalog with the captured
hash; an old fixed pin count cannot stand in for this closure. Known-source, same-API clock stability, EOF,
private unknown-close fences and source rechecks remain mandatory. Historical foundation commits are provenance,
not authority for a moving product tree. The run receipt binds the exact checkout, compiled source manifest and
hosted image.

Only the newly authenticated fixed producer is admitted: commit `b75c944dec58973d157542e2d4d2db3720667982`, run
`43991252195`, artifact `14289217635`. The ZIP is38,425,334 bytes with SHA256
`cbbbf6c641c41bda8ece457c28a54b9bc4121a068dc376725bcf0e3ac24a2f62`. The current shared manifest binds four
original members; the existing packaging helper verifies all four and ships only its three exact package members.
Node is120,220,672 bytes / `a4ed4d41331cd7886a67aedf1ecc1e8b389f8a48b5f862464eabd123c62ca8d1`;
the receipt is7669 bytes / `cb5f649e1f17a1d025cf98ccc99f65a28e1068934cb1c9c59171341e20584916`;
bootstrap is2560 bytes / `70ea391b8bfac53cf1b5ad54c59e215beac1fdec235cf4f980de441ce242c99e`; LICENSE is unchanged.
Before promotion, review used the exact b75 producer's semantic receipt parser to check source, recipe, four-patch
and ABI evidence. The manifest and V4 workflow pin those authenticated receipt bytes; the existing package helper
enforces byte integrity. No new runtime receipt parser is introduced. Packaging integrity grants no execution. The real factory still selects only its pinned Node image; there is no
caller executable override, live download, arbitrary script or source-folder input.

## The DACL comparison

Microsoft's AppContainer documentation says that a Low AppContainer may read, write or execute a Medium-or-lower
resource when both the user/group and exact package/capability DACL sides grant that access. LPAC excludes broad
ALL_APPLICATION_PACKAGES access; the documentation does not remove explicit package grants. V2/V3's Medium-full
MIC denial expectations were therefore not documented guarantees. V4 makes no MIC differential or generic
Medium-resource write-denial claim. It measures the actual package DACL mask boundary used by the asset owner.

Each natural case creates a fresh genuine profile, real assets and real Copy tree. It first runs a separately
built fixed C prelude through the genuine output/Copy/profile/Stop path. The C executable is test-only and is never
selected by the production Node factory. The eight fixed targets are:

| Object | Label/package grant | READ_CONTROL | WRITE_DAC | WRITE_OWNER |
| --- | --- | --- | --- | --- |
| Actual private parent | Explicit or default Medium, no package ACE | Denied | Denied | Denied |
| Actual asset root | Low, package RX, OWNER_RIGHTS RC | Positive | Denied | Denied |
| Actual pinned Node image | Low, package RX, OWNER_RIGHTS RC | Positive | Denied | Denied |
| Host-only directory control | Low, no package ACE | Denied | Denied | Denied |
| Full-package directory control | Low, package FA, OWNER_RIGHTS RC | Positive | Positive | Positive |
| Full-package file control | Low, package FA, OWNER_RIGHTS RC | Positive | Positive | Positive |
| Read-package directory control | Low, package RX, OWNER_RIGHTS RC | Positive | Denied | Denied |
| Read-package file control | Low, package RX, OWNER_RIGHTS RC | Positive | Denied | Denied |

The first four rows preserve the actual production-boundary expectations. For each fresh full/read directory or
file pair, owner, Low/NW label, security control bits, ACE set/order/flags and padding are identical except the
exact package ACE mask FA versus RX. Strict per-object parsing validates every ACE before a detached DACL copy
normalizes only that validated package mask for pair comparison. The host-only control retains the actual private
parent's owner/DACL. OWNER_RIGHTS RC appears identically on both package-control sides. It removes implicit owner
READ_CONTROL/WRITE_DAC privileges; it is not an explicit deny of the separate host/SYSTEM/package allow ACEs.
The actual C opens must still demonstrate the full-side positives.

The same C process requests FILE_ADD_FILE (0x2) on both package directories and FILE_WRITE_DATA (0x2) on both files.
The FA controls must allow both opens; the RX controls must deny with ERROR_ACCESS_DENIED5. No paired file data is
written. The host pins share write access only for the two test control files (indices5/7); the actual Node image
keeps its write-denying share1 pin. Both exact20-byte control canaries are read through bounded temporary proof
pins and positively closed before C Resume, then read/closed again after genuine C Stop/EOF. Private byte buffers
are wiped. All eight retained identities, security descriptors and file clocks are rechecked. Unknown read/close
retains the private graph and fences the case.

The C child also must deny CREATE_NEW in the actual parent, actual asset root and read-package directory, while
creating, writing, flushing and positively closing one known canary in the full-package directory. All32 checks
must pass:24 security opens (10positive/14denied), four data opens (2positive/2denied) and four creates
(1positive/3denied). Totals are13positive/19denied, masks8191/524287, with `daclPairs=2` and stdin EOF. Success emits
only `EMBER_ASSET_ACCESS_V4:524287:8191:19:13:2:1` and the exact V4 stderr frame, then exits49. Sharing violations,
missing objects, NULL handles and malformed flags never count as denials. Each acquired probe handle must close
positively. No ACL, owner or label is modified after creation, and the child never impersonates.

`natural-default` creates a protected empty-SACL ancestor and a genuinely unlabeled borrowed parent. Native
readback must prove absent/null or valid empty SACL with no mandatory label ACE. The other natural case requires
exact explicit Medium/NW. Neither falls back to the other. These remain parent-admission cases, not a claimed MIC
causal comparison. All actual assets and package controls have their exact explicit Low labels in both cases.

## Token, lifecycle and cleanup

Before Resume, the held C launch must match its genuine process/thread/PID and both PI handles. The private
read-only observation uses TOKEN_QUERY only, real stable bounded LocalAlloc storage, complete SID bounds and exact
policy size. It requires Low2 / attributes2 (exact0x60) / policy1 (NO_WRITE_UP) before the trusted attester returns.
Auxiliary token close and LocalFree must succeed before issuance. Borrowed PI handles are never closed by this
observer and remain reserved until all eight target pins close positively. Unknown native operations, aliases or
reentry retain ownership and permanently fence. There is no new effective-thread query, impersonation or privilege
change. This token admission remains a measured context condition, not a MIC-denial inference.

The genuine returned C run is bound once to the observation and launch. Outward finite token facts require the
same genuine completed/run and closed-output/launch/run references plus authenticated actual Stop. Metadata lookup
or reservation release grants no Stop/disposal authority. Full producer/build scans occur only before a child
exists or after complete native cleanup; held checks stay bounded.

After the C prelude, the real pinned Node owner runs a literal preserved-loader CommonJS programme. Natural exit
checks stdin EOF, creates only one new known workspace file, emits exact72KiB stdout/66KiB stderr and exits17.
Overflow uses fixed X bytes beyond the existing combined256KiB cap; cancellation waits for both exact READY frames.
Both require genuine automatic Stop before completion is requested. `precreate` requires actual empty-job Stop and
revoke without PI/output. `preresume` loses asset-only admission inside the trusted held attester. `sharedcreate`
uses the actual shared admission/signal and aborts after positive suspended creation but before returning the launch
to Copy. The seven modes remain natural, natural-default, overflow, cancel, precreate, preresume and sharedcreate.

Known cleanup requires actual exact-run Stop, complete grant revocation, EOF and positive output close, unchanged
seed/script snapshots, positive asset/control/fixture-pin closes, deletion of only fresh assets, Copy-tree
retirement, fixture-handle closes and genuine profile deletion. Only then are known fixture/build files removed.
A first failure retains its graph and blocks later cases without reset, retry or rescue. Success of one child
cannot certify a different launch, output owner or cleanup. This is an asset-boundary proof; coordinator/Host/SDK,
Home, packaged product and ordinary approval/check-ledger journeys remain separate acceptance requirements.

Only closed finite identity, output/count, DACL-mask, mode, token-enum and cleanup facts leave the fixture. Paths,
handles, SIDs, raw Windows errors, child output, TAP, reports and dumps are not published. Failure505 is separate
from success: genuine exact C completion/closed output/Stop, zero stdout and exact V4 tuple plus28-enum matrix are
required to project diagnostics. Rights1/2/3 are RC/WDAC/WO; right4 is data/add-file only on controls5..8. The first24
matrix entries are eight-by-three security order and the last four are data opens5/6/7/8. Outcomes are1positive,
2access denied,3sharing violation,4other/NULL,5handle-info failure/nonzero flags. The original failure tuple is
preserved before failure-only measurements; both frames wait for every acquired handle to close positively.
Unknown close emits neither. Unlisted versions, exits, malformed frames or mismatched opaque refs remain failures.

Portable C-model compilation is observation-only: its original raw success guard and literal cc arguments remain.
Compiler2500ms, model750ms and default5s test bounds are unchanged, with no retry. Fixed numeric diagnostics expose
only setup stage, returned status classification, signal classification and allowlisted error classification;
no compiler text/path/code string or child stream is exposed. Linux contracts run C alone once/maxWorkers1 and then
six suites once/maxWorkers2; both are mandatory. PR registration starts no native child. The manual Windows pair
is fenced to `ember-improve/20261116-windows-node-product` and remains controlled by Root after source review,
portable registration and exact checkout/producer authentication.

## Immutable failed history

- V1 head `c1be17874ce4b77b90f117f98c4bc53d355331a1`, run43971415844: both images failed natural C phase4.
- Head `34372b2c7e2c34910acc7fa7aa1df1265ca8e18f`, run43973341231: both genuine C205/prelude11.
- Head `140c863c90e0f988fe8471b8784ed11e2b46138b`, run43976314956: both tuple1/1/2, parent RC denied.
- Head `1998beadf41ac0057eb4f562ef8a385b2d4a5a0d`, run43979739808: both matrix parent222/root122/image122/
  Lowhost222/LowfullDir111/LowfullFile111, C205 retained. No production write escalation was observed.
- V2 `bcce66ad1a5809e0d3a3b4f01cdd10efa83ab8ef`, run43983628743: both C305/prelude11/tuple7/2/1 and matrix
  `222122122222111111111111`; Medium full-package controls allowed all security rights. Later cases stayed blocked.
- Held-token append `c49a6d4a8c46d7a18e75c95c0a1c1f298d92485b`, run43989223396: both same C305/matrix plus genuinely
  observed Low2/exact0x60/NW1 primary tokens. This ruled out the earlier unmeasured Medium-token/policy-OFF leads.
  Its Linux C setup also failed with unobserved cause; that earlier failure is not retrospectively classified.
- V3 `e65e50e7cbee146404e9710a32b645453848a40e`, registration43992720501:542passed/241skipped after compiler setup
  returned setup5/compiler1/0/1/1 (null status/SIGTERM/ETIMEDOUT at2500ms). This established the finite timeout outcome,
  not a CPU/load cause. Serial-workflow head `e13766e22d8181cee83b8cc6612dc533f08acb99` then registered783passes.
- V3 manual run43995186426 at that exact head: contracts264+519 passed; both Windows images passed519 portable tests
  and failed all seven native cases after first natural retention. Genuine C405/prelude11/tuple7/4/1 and matrix
  `2221221222221111111111111111` showed all four data opens positive. Tokens were Low2/exact0x60/NW1; C Stop/EOF/close
  authenticated, but no full case/known-cleanup receipt existed. Later cases remained blocked and graphs retained.

- V4 head `5f1cf38917f8286d225d8bbb428d4c301051799e`, run43998770804: contracts256+557 passed. Both images passed557
  portable tests, then reported natural phase5/prelude14/C49/errorclass1, probe000/matrix28zeros and token1/2/2/1.
  The genuine C prelude passed all32 DACL/data/create checks, output/Stop authentication and post-Stop control reads.
  Advancement to Node failed; no full case, seven-case or asset/private/profile cleanup receipt existed. All later
  cases stayed blocked and the private graphs were retained. These remain failed runs, not completed asset proofs.

An evidence-only append adds per-case Node checkpoints without changing C, production APIs, calls, awaits,
arguments, timeouts, success predicates, Stop or cleanup. Checkpoint0 means not entered or prelaunch verification;
1 is immediately before the Copy launch;2 enters the existing creator callback before the real Node factory;
3 is its returned output launch;4 enters the ordinary attester;5 follows its positive image check;6 follows its
pin checks;7 is assigned only after the genuine Copy launch promise resolves its run reference. A checkpoint
is an observed host control-flow position, not proof of Resume, child execution, Stop, output closure or disposal.

The append also records inner class0unknown/1Copy/2nativeCopy/3Stop/4output/5profile/6proof/7enforcementNative/
8NodeToolchain only when the existing creator or ordinary attester throws. Classification uses exact constructors
from the loaded graph, falls back to zero on its own failure and rethrows the identical original value. It reads
no name/message/code/cause/stack or raw native field. Diagnostic storage failure cannot replace the operation's
return or error. Checkpoints and inner classes never decide admission or turn fatal outer Copy class1 into
success. No native query, filesystem action, logging, recovery or retry is added. The failed Node sector remains
unclassified until a separately reviewed diagnostic run supplies evidence.

The Node-checkpoint append at `0553e412060a89513d3191c02cb8bd36a959413f` also failed on both images in run44001782995.
Contracts256+572 passed; each Windows job passed572 portable tests and retained all seven native cases after the
first natural refusal. Both observations remained phase5/prelude14/C49/outerclass1/probe000/matrix28zeros/
token1/2/2/1, with Node checkpoint6/inner0. The real factory had returned a held Node launch, and its ordinary image
and pin checks had passed. The later creator/output/automatic-asset-attestation/postattest/Resume sector remained
unclassified; Node execution and full cleanup were not certified. No one-use-copy defect was established.

A further evidence-only observer forwards the real Stop owner's creator, attester and current callbacks unchanged.
It wraps only a supplied function capture callback, passes the same genuine witness exactly once and returns its
original value, including an invalid object or Promise that the existing Stop guard must reject. Its identical
original exception is rethrown. Capture checkpoint0 is not entered,1 is entered and2 is returned; inner class0..8
uses the same exact-constructor mapping. Per-owner records are separate, and a fresh blank record is installed
before Node-phase verification, so successful C-capture facts cannot be mistaken for a Node callback.

A passive rejection handler reads only the existing exact-graph branded Stop stage0..14, operation0..7,
predicate0..11 and constraint0..21. Zero means unobserved/unknown. Native domain and status/code are neither read
nor published. The original launch Promise is returned unchanged; observer attachment, projection and storage
faults cannot replace its identity, resolution or rejection. The observer introduces no await, native query,
filesystem action, logging, grant, Stop attestation or cleanup action. These values only classify the retained
failure; they cannot change launch admission, Resume or the fatal outer Copy error. The failed runs above remain
failed, with their private owners retained.

V4 neither recertifies those failures nor silently changes a MIC claim into success. Its new same-Low-label,
exact-package FA/RX comparison explicitly measures DACL enforcement on the final product graph.

Primary references:

- [Implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
  describes dual-principal DACL access and Medium-or-lower explicit package grants.
- [TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)
  describes LPAC's exclusion from ALL_APPLICATION_PACKAGES.
- [Security identifiers](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)
  defines OWNER_RIGHTS suppression of implicit owner permissions.
- [DACL access checks](https://learn.microsoft.com/en-us/windows/win32/secauthz/how-dacls-control-access-to-an-object)
  describes explicit allow/deny evaluation.
- [File access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants) defines
  FILE_WRITE_DATA/FILE_ADD_FILE0x2; [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
  documents sharing compatibility. [Token policy](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_mandatory_policy)
  defines the observed primary-token policy. These do not turn the failed MIC expectations into guarantees.
