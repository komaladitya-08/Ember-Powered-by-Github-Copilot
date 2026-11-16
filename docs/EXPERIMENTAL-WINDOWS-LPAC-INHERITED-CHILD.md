# Separate inherited-token LPAC child experiment

This fixture tests a specific child-creation hypothesis. It changes no product gate, process token, capability,
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

The separate fixture includes the original helpers and preserves its complete assertion body. It substitutes a plain
`STARTUPINFOW` launch for the two child attempts and adds a host admission gate before resuming the ordinary child.
Image, writable command line, explicit new-process/thread security, current directory, environment, no-window and
suspended creation, breakaway attempt and zero inherited handles remain the same. There is no runtime fallback to
ordinary AppContainer, a different package or a broader capability set.
The host also retains a read-only image handle denying write/delete sharing from staged hash readback through child
admission, job Stop and report inspection; it releases that pin before verified fixture cleanup and retains it on uncertainty.
To reuse that existing test-only pin implementation, `nativeChecks` is exported from `windows-node-lpac-proof.ts`;
its implementation is unchanged. The original C fixture and original acceptance test remain byte-unchanged.

Before the first child instruction, the LPAC root still requires its original exact-package, AppContainer,
zero-capability and own-package-versus-AAP access witnesses. The host discovers the one child using its owned private
job's native process list, verifies the exact PID/image and same fresh LPAC token, and checks `IsProcessInJob` against
that exact job. It writes only an eight-byte magic/PID admission acknowledgement. The fixture bounds, verifies and
closes that ordinary no-reparse file before `ResumeThread`. No result report is read for admission.

Success still requires all original twelve report checks, including the denied breakaway attempt, original host
process denials, copied-image read, workspace write and redirected profile temporary-file write. The admitted child
must outlive the root inside the same private job. Root exit cannot release a result; Stop must observe empty native
job accounting and process list. Result/failure/path reports are read only after that stopped receipt, and only fixed
numeric/boolean facts leave the fixture after verified cleanup. Unknown setup, token-query cleanup, process stop or
handle close retains the fixture rather than triggering recursive cleanup.

Run the separate suite on Windows x64 with the VS 2022 x64 C++ component (the default local compiler range):

```powershell
$env:EMBER_LPAC_INHERITED_CHILD_TEST = "1"
node scripts/run-integration.mjs test/integration/windows-lpac-inherited-child-native.test.ts
```

`experimental-windows-lpac-inherited-child.yml` runs both variants on Server 2022 and 2025. An explicitly configured
unsupported host, missing compiler, unexpected original-control outcome or failed inherited assertion fails; none is
converted into a skip. Native outcomes remain pending until an exact workflow commit completes. A positive result
would establish this fixed inherited-child sequence, not arbitrary Node child-process, named-pipe or toolchain support.

CI declares `EMBER_LPAC_INHERITED_CHILD_RUNNER` as exactly `windows-2022` or `windows-2025`. Those select the reviewed
VS 17 `[17.0,18.0)` and VS 18 `[18.0,19.0)` installation ranges respectively; no arbitrary version fallback is used.
The Server 2025 image's installed VS 2026 version is recorded in the runner manifest
[`win25-vs2026/20261103.298`](https://github.com/actions/runner-images/blob/win25-vs2026/20261103.298/images/windows/Windows2025-VS2026-Readme.md).

Setup refusals print only fixed numeric operation/domain/code fields and `launchAttempted:false`. Build stages are
1 scratch, 2 environment/image declaration, 3 compiler discovery, 4 discovery-path validation, 5 fixed batch creation,
6 compiler child completion, and 7 executable readback. Variant 1 is the original control and 2 is inherited.
Preparation operation 1 is volume type, 2 ancestor pin, 3 profile creation, 4 owner query, 5 directory creation,
6 fixed executable creation, 7 handle close and 8 profile removal; operation 0 means an unclassified host validation.
Domain 0 is unknown, 1 is the fixed Node errno ordinal (EACCES, EPERM, ENOENT, EEXIST, ENOTDIR, ELOOP, ETIMEDOUT,
ENOBUFS), 2 is Win32, 3 HRESULT, 4 compiler C and 5 linker LNK. Original messages, paths, compiler output and identities
remain private. These setup receipts do not claim cleanup or successful native launch.
