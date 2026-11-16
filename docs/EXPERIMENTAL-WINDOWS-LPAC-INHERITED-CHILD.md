# Separate inherited-token LPAC child experiment

This fixture tests a specific child-creation hypothesis. It changes no product gate, existing process token, capability,
existing ACL, registry policy or desktop permission. The original explicit-attribute C fixture and acceptance test
remain unchanged and are compiled as a separate observed failure control.

The original root successfully starts in zero-capability LPAC, but repeating AppContainer construction attributes
inside that root fails at ordinary child creation with Win32 error 5 and native status `0xc0000022`. The image is
readable/executable, self `PROCESS_CREATE_PROCESS` access succeeds, child-process mitigation flags are zero and the
token-default-DACL diagnostic succeeds. Those facts do not identify the failing operation.

Microsoft documents [ordinary AppContainer child token inheritance](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-#unpackaged-apps).
It separately restricts [NtCreateLowBoxToken callers](https://learn.microsoft.com/en-us/windows/win32/secauthz/ntcreatelowboxtoken#remarks)
to medium-or-higher integrity. Reconstructing an AppContainer from an already low-integrity LPAC is therefore a
testable hypothesis, not an established explanation of the exact internal `CreateProcessW` branch.

The separate fixture includes the original helpers and preserves its complete assertion body. Its default branch
substitutes a plain `STARTUPINFOW` launch for the two child attempts and adds a host admission gate before resuming the ordinary child.
Image, writable command line, explicit new-process/thread security, current directory, environment, no-window and
suspended creation, breakaway attempt and zero inherited handles remain the same. There is no runtime fallback to
ordinary AppContainer, a different package or a broader capability set.
The host also retains a read-only image handle denying write/delete sharing from staged hash readback through child
admission, job Stop and report inspection; it releases that pin before verified fixture cleanup and retains it on uncertainty.
To reuse that existing test-only pin implementation, `nativeChecks` is exported from `windows-node-lpac-proof.ts`;
its implementation is unchanged. The original C fixture and original acceptance test remain byte-unchanged.

Before the first child instruction, the LPAC root still requires its original exact-package, AppContainer,
zero-capability and own-package-versus-AAP access witnesses. The host enumerates its complete private-job list,
bounded to eight processes including the root, and retains query/synchronize handles for every observed member.
It selects exactly one image matching the still-pinned staged fixture path, verifies its exact PID and same fresh
LPAC token, and checks every member's `IsProcessInJob` against that exact job. New members require another bounded
poll and a stable complete set before admission. A disappearing live member, reused signalled PID, duplicate candidate,
unknown acquisition or invalid membership refuses admission. It writes only an eight-byte magic/PID admission acknowledgement
for the intended child. The fixture bounds, verifies and
closes that ordinary no-reparse file before `ResumeThread`. No result report is read for admission.

Auxiliary members receive no acknowledgement or resume authority. Their names, including `conhost.exe`, confer no
trust. They are accounted contained writers, not evidence of generic descendant token isolation. The observer retains
at most seven member handles plus the borrowed root across the entire fixture lifetime, including exited members.

Success still requires all original twelve report checks, including the denied breakaway attempt, original host
process denials, copied-image read, workspace write and redirected profile temporary-file write. The admitted child
must outlive the root inside the same private job. Root exit cannot release a result.
The intended child's liveness and complete stable membership are checked again after the 100ms job-not-stopped
observation; an auxiliary remaining alive cannot supply that child-survival proof. Stop must observe empty native
job accounting and process list, and independently observe the borrowed root and every retained member handle signalled.
Result/failure/path reports are read only after that stopped receipt. Each retained member closes exactly once before
the staged-image pin and fixture owner close. Only fixed
numeric/boolean facts leave the fixture after verified cleanup. Unknown setup, token-query cleanup, process stop or
handle close retains the fixture rather than triggering recursive cleanup.

Run the separate suite on Windows x64 with the VS 2022 x64 C++ component (the default local compiler range):

```powershell
$env:EMBER_LPAC_INHERITED_CHILD_TEST = "1"
node scripts/run-integration.mjs test/integration/windows-lpac-inherited-child-native.test.ts
```

`experimental-windows-lpac-inherited-child.yml` runs all three variants on Server 2022 and 2025. An explicitly configured
unsupported host, missing compiler, unexpected original-control outcome or failed inherited assertion fails; none is
converted into a skip. Native outcomes remain pending until an exact workflow commit completes. A positive result
would establish this fixed inherited-child sequence, not arbitrary Node child-process, named-pipe or toolchain support.

CI declares `EMBER_LPAC_INHERITED_CHILD_RUNNER` as exactly `windows-2022` or `windows-2025`. Those select the reviewed
VS 17 `[17.0,18.0)` and VS 18 `[18.0,19.0)` installation ranges respectively; no arbitrary version fallback is used.
The Server 2025 image's installed VS 2026 version is recorded in the runner manifest
[`win25-vs2026/20261103.298`](https://github.com/actions/runner-images/blob/win25-vs2026/20261103.298/images/windows/Windows2025-VS2026-Readme.md).

Setup refusals print only fixed numeric operation/domain/code fields and `launchAttempted:false`. Build stages are
1 scratch, 2 environment/image declaration, 3 compiler discovery, 4 discovery-path validation, 5 fixed batch creation,
6 compiler child completion, and 7 executable readback. Variant 1 is the original control, 2 plain inherited and 3 AAP-only.
Preparation operation 1 is volume type, 2 ancestor pin, 3 profile creation, 4 owner query, 5 directory creation,
6 fixed executable creation, 7 handle close and 8 profile removal; operation 0 means an unclassified host validation.
Domain 0 is unknown, 1 is the fixed Node errno ordinal (EACCES, EPERM, ENOENT, EEXIST, ENOTDIR, ELOOP, ETIMEDOUT,
ENOBUFS), 2 is Win32, 3 HRESULT, 4 compiler C and 5 linker LNK. Original messages, paths, compiler output and identities
remain private. These setup receipts do not claim cleanup or successful native launch.

On a stopped, cleaned-up inherited-case refusal, the host also reports its fixed operation (1 staged pin/canary,
2 root launch, 3 root/deadline observation, 4 child admission, 5 root-exit observation, 6 remaining descendant check).
The observer operation is 1 input contract, 2 initial currency, 3 job-list query, 4 complete header, 5 bounded PID
decoding, 6 root-containing set, 7 member open, 8 exact PID, 9 image query, 10 image comparison, 11 exact private-job
membership, 12 token witness, 13 final currency, 14 final process set, 15 acknowledgement and 16 handle close.
Operation 17 is native process signalling, 18 active-job accounting and 19 unique candidate selection. `tracked` and
`candidates` contain only bounded counts. The first refusal snapshot survives later Stop/cleanup observations.
Only explicit native FALSE/NULL captures immediate `GetLastError`; malformed ABI/error metadata stays domain 0.
The snapshot contains no PID, image, token, raw native output or exception text. It adds no admission fallback.
After a successful image-name query, `image` reports only returned-length validity/uint32 shape and count,
path shape (0 other, 1 drive, 2 extended drive, 3 native device, 4 UNC), basename class (0 other, 1 `fixture.exe`,
2 `conhost.exe`), presence of a DOS short-name component, exact spelling equality and extended-prefix equality.
Those are diagnostic facts; only the original exact image comparison admits the child. No spelling class or
prefix equivalence bypasses image verification.

The third, separately compiled `aap-only` variant selects `EMBER_LPAC_CHILD_AAP_ONLY=1`. It uses `STARTUPINFOEXW`
with exactly one AAP opt-out attribute set to 1, without a `SECURITY_CAPABILITIES` attribute or new token construction.
All arguments, process/thread security, inherited-handle denial, current directory, environment, no-window/suspended
flags, breakaway attempt, child attestations and Stop/readout rules remain the same. Both controls compile with no
override: explicit uses the original source and plain uses the default launch branch. Only the AAP-only inherited
build adds `EXTENDED_STARTUPINFO_PRESENT`.

Microsoft documents [generic AppContainer child inheritance](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-)
and the [separate LPAC AAP opt-out creation attribute](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer#launching-the-appcontainer-or-lpac).
Neither establishes that an already-LPAC caller must repeat that attribute or that omission necessarily escalates a
child. Microsoft's [OpenVMM implementation](https://github.com/microsoft/openvmm/blob/e6b458cc032208448d16c529ef973f0cee7c23e1/support/pal/src/windows/process.rs#L873)
supports AAP opt-out independently of an existing/default token, without constructing security capabilities. This
is precedent for the API combination, not a guarantee of LPAC-parent compatibility. The third variant tests that
single remaining creation-policy combination; success or failure must be established by its exact native run.

Attribute setup or cleanup cannot masquerade as a `CreateProcessW` denial. AAP-only setup failures terminate with
stage 32. If process creation succeeds and later attribute memory cleanup fails, the fixture strictly terminates,
waits for and closes that exact known child, then exits with refusal 30 instead of returning FALSE. This also keeps
an unexpected breakaway creation from becoming an apparent access-denied control. Any unverified born-child stop
or handle close exits 31; the host's additional readout gate blocks every report/path reader and retains all owners
and pins on that status. The ordinary child never resumes after such a cleanup failure.

Each of the three compiler children retains its 60-second bound. Setup allows their combined bounds plus discovery;
root, acknowledgement, admission, independent-stop and runtime test deadlines remain unchanged.

The two instrumented variants additionally write a separate 80-byte child-object diagnostic only after the ordinary
`CreateProcessW` call returned FALSE and its original Win32/NT statuses were saved. Creation inputs, object security,
labels, flags, token and capabilities remain unchanged. The original explicit source remains untouched.
The helper copies the exact supplied process/thread DACLs, preserving ACE order, types, flags and SID bytes, then
expands only their known GA masks on those in-memory copies using the SDK's concrete process/thread ALL_ACCESS.
Unexpected generic read/write/execute or ACE forms refuse diagnostic setup instead of guessing a mapping.
[MS-DTYP Access Mask rules](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-dtyp/7a53f60e-e730-4dfe-bbe9-b21b62eb790b)
explain why generic ACE masks require this expansion; the earlier raw `0x10000000` maximum-allowed result is not
evidence of concrete process/thread rights. The descriptor passed to `CreateProcessW` is never modified.

Each absolute diagnostic copy uses the actual caller token's `TokenOwner` (class 4) and `TokenPrimaryGroup` (class 5)
defaults and the actual token duplicated for query-only impersonation-token AccessCheck; the process never impersonates.
Owner/group/SID/ACL buffers remain alive through the checks and are wiped before publication. This isolates DACL
access in memory, without modeling kernel process creation, mandatory labels, console allocation or all launch policy.
Node's NULL process/thread `SECURITY_ATTRIBUTES` path uses default object security and is not this explicit-SD path.

The 20 DWORDs are magic/schema, setup stage/error, process requested/checked/allowed/granted/API error, thread
requested/checked/allowed/granted/API error, owner/group source classes, copied-DACL bitmask, primary/duplicate
known-close flags and reserved zero. API failure and a completed denial remain distinct; no identity bytes or strings
leave the C program. Stage 8 denotes complete setup/checks and known cleanup, while a setup failure retains its
actual stage/error. The host reads this file only for an instrumented root's ordinary stage-18 producer outcome,
after whole-job and independent-handle Stop. Writer failure 33 prevents invoking its reader even if 80 bytes exist;
it remains an ordinary failed experiment with known cleanup. Uncertain native close 31 blocks all payload readers
and retains owners/pins. Existing launch and positive confinement assertions remain mandatory.

At `5dff8e203462e6f3f65ffcfc461cbc4013142f39`, [run 43819235798](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43819235798)
passed 82 portable tests and the original explicit-attribute denial control on each Server image. Both inherited
cases stopped cleanly after a host-side admission refusal, with no C result/failure report. That outcome establishes
the negative control and cleanup, but supplies no successful inherited-child proof; the operation receipt above
exists to identify that refusal before changing any admission or creation rule.
At `7e1cbb5ad698ad9e4387df2056dc8b83dbd1a8ec`, [run 43821023494](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43821023494)
passed 99 portable tests and both original controls. Both refused the first extra job member at image comparison;
its closed basename class identified the Windows console helper. The bounded multi-member owner above preserves
the actual launch flags and intended-child attestations while accounting for that helper. Native success for this
owner remains pending until its exact workflow revision completes.
At `c4fad9a996532703f29ad4f92def99d6937d9b47`, [run 43823916066](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43823916066)
passed 108 portable tests per image and the original control. After accounting for auxiliary members, the plain
inherited call itself exited naturally at stage 18 with error 5 and status `0xc0000022` on both images. All contained
processes and retained handles stopped and closed before that receipt. Plain inheritance alone therefore did not
resolve creation. The original and plain outcomes are retained as explicit negative controls for the AAP-only test.
At `5c04bf33961ce0a4b8d0f34e2a71e2706907a152`, [run 43826611127](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43826611127)
passed 119 portable tests and both denial controls per image. The AAP-only call also naturally returned stage 18,
error 5 and status `0xc0000022` on both images, with the same root checks and known Stop/cleanup. This policy-only
combination did not resolve creation; no child admission or Node compatibility was established.
