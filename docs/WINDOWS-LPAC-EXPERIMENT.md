# Offline Windows LPAC fixture experiment

This is an experimental native-process foundation, separate from the product coding path. Windows native coding remains
unavailable. The full Windows runtime/broker design is in [WINDOWS-CODING-BOUNDARY-PLAN.md](WINDOWS-CODING-BOUNDARY-PLAN.md).

## What exists

`experimental-windows-lpac-api.ts` binds the Win64 APIs through koffi. `ExperimentalWindowsLpacFixture.prepare()`
accepts a host-selected native executable as bytes and creates fresh scratch tools/work/state objects with protected
package-specific ACLs. It checks for a fixed NTFS volume, pins the original directory ancestry without delete sharing,
and refuses reparse objects before resolving case/short names. It never changes ACLs on an existing source project,
user profile or system root. Tool access is read/execute; workspace/state access excludes write-DAC and write-owner.

Preparation creates a unique AppContainer profile. `launch()` requires both security-capabilities and LPAC opt-out
attributes. It supplies zero capabilities, an explicit clean environment and no inherited handles. The process starts suspended,
joins a private kill-on-close job with neither breakaway flag, whose exact limits are read back as kill-only with
no active-process quota or UI restrictions, and has its package SID, AppContainer flag and
zero capability count checked before its first thread resumes. A query-only impersonation duplicate must pass a
synthetic own-package access check and be denied an otherwise identical All Application Packages access check.
Both `AccessCheck` calls must succeed; an API error never counts as denial. Unsupported APIs and failed checks have no ordinary
AppContainer fallback. A post-create failure kills and observes the suspended process before releasing its handles;
unverified cleanup preserves diagnostics and blocks further experiments in that host process.

Windows also creates this session's own disposable profile beneath its managed Packages directory. The launcher
queries that profile through `GetAppContainerFolderPath`, validates the exact newly created profile name, and supplies
the preceding local-app-data base as the required `LOCALAPPDATA` entry. Windows redirects the child's `LOCALAPPDATA`,
`TEMP` and `TMP` into that isolated profile. This passes a path string, not inherited environment contents or an ACL
grant on the user's profile, the local-app-data base, or shared Packages directory. The launcher deletes its profile
after verified process shutdown; its work/state paths remain the explicit copied scratch directories.

`waitRootExited()` observes the exact root process handle but supplies no result authority. `waitStopped()` and
`stop()` issue a scoped receipt only after root exit and empty job accounting plus an empty process list. A root PID
exit alone is insufficient. Concurrent Stop/close calls share their pending operation; closing invalidates receipts.
Scratch directories are never recursively deleted by this launcher. Restart/crash recovery of unknown old sessions
is not implemented.

## Run the native fixture

On Windows x64 with Visual Studio's C++ x64 build tools installed:

```text
node scripts/run-integration.mjs test/integration/experimental-windows-lpac-native.test.ts
```

The test locates Visual Studio with `vswhere`, calls `vcvars64.bat`, and compiles the small C fixture with no CRT and
only kernel32/advapi32 imports. The dedicated CI matrix uses GitHub's `windows-2022` and `windows-2025` runners. Non-Windows runs skip this
native case. A missing compiler, unsupported LPAC configuration, missing report or failed native assertion on Windows
fails the test; none is converted into a skip or a broader grant.

The native fixture checks its token, confirms a synthetic host token variable was not inherited, reads its copied
executable, writes its workspace, and is denied a canary readable by ordinary All Application Packages. The host first
reads that canary as a positive control. The fixture separately probes denied VM-read, handle-duplication and
parent-process rights on its host, alongside a successful self-process query. Its required success path attempts breakaway creation, then
starts an ordinary child which outlives the root; the observed failure below prevents that success path today. Both attempts use the same explicit, noninheritable security
attributes for their new process/thread objects, granting only the user, SYSTEM and exact session package SID.
This does not change the host token or any existing object. The test observes root exit before verifying that a result receipt
is still unavailable until Stop ends the child. Reports contain numeric fixture results, not secrets.
The fixture's child launches explicitly repeat the exact parent package SID, zero capabilities and LPAC AAP opt-out,
then start suspended. The child's exact parent
package SID, zero capabilities and own-package/AAP access witness must pass before its first thread is resumed.
This tests explicit propagation; it does not establish compatibility with tools that launch their own subprocesses
using default startup attributes. Failed creation records Win32 and immediate native thread status for diagnosis.
After verified Stop, the test also compares the child's actual local-app-data and temporary paths with the fresh
OS-managed profile and confirms that its temporary directory was writable. Those disposable path reports contain
only the test profile's paths and are removed with test scratch.

The native Server 2022 runner rejected the Win32 `TokenIsLessPrivilegedAppContainer` query (class 46) with error 87.
The experiment therefore checks the LPAC creation opt-out and the observed own-package/AAP access behavior before
resume and again inside the fixture, plus the actual file canary. This is a behavioral witness, not a documented
user-mode LPAC identity-query contract. [Microsoft's LPAC launch documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
describes the AAP exclusion; [AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck)
defines the authorization operation. The distinction and unsupported class-46 result are discussed in this
[Microsoft Q&A investigation](https://learn.microsoft.com/en-us/answers/questions/6011619/gettokeninformation-supported-contract-for-tokenis).

Portable failure/order tests run with:

```text
npx vitest run test/unit/experimental-windows-lpac.test.ts test/unit/experimental-windows-lpac-api.test.ts
```

## Evidence and remaining boundaries

The portable tests pass in the Linux workspace; portable mocks are not LPAC certification. The native matrix at
`2e36bcb2003858ad1768c618455921072f01b91f`, run `43768393425`, compiled and launched the root fixture on both
Windows Server 2022 (kernel 20348) and Windows Server 2025 (kernel 26100). Both runs failed at ordinary child
creation, fixture stage 18: `CreateProcessW` returned error 5 and immediate native status `0xc0000022`.
The root's AppContainer/zero-capability/own-package-versus-AAP checks, clean token-marker environment, copied-image
read, host-process-right denials and workspace write had passed before that failure. Its image was openable for
read/execute, its self process allowed `PROCESS_CREATE_PROCESS`, the observed child-process mitigation flags were
zero, and a read-only check of the token's default DACL did not show an access denial. None of these observations
establish why process creation failed. No capability or existing-object ACL was broadened to bypass it.

Consequently there is no successful descendant-containment, child-token propagation or actual redirected temporary
path/write result yet. A breakaway failure cannot prove the job blocked escape while the equivalent ordinary child
also fails. The experiment remains failing on Windows and is unavailable to the product. These server runs do not
certify Windows 10/11 desktops even where kernel families overlap. The separate hosted-CI diagnostic workflow uses a
hash-pinned, Microsoft-signed Process Monitor and publishes only this exact fixture PID/image's bounded operation,
result and masked path fields; raw traces, details and unrelated process rows are deleted without upload.

The own-PID trace at `2c31989d5d598fb1f7d329aa672eae90ceb54626`, run `43770802690`, captured 33 events for the
Server 2025 fixture. It observed denied `RegOpenKey` operations at `HKLM\System\CurrentControlSet\Control\Nls\CodePage`,
`HKLM\System\CurrentControlSet\Control\Session Manager` and twice at
`HKLM\Software\Microsoft\Windows NT\CurrentVersion\Image File Execution Options`. These are candidate dependencies,
not a demonstrated causal call stack for the child-creation failure. The same run's Server 2022 export contained no
events and failed its positive control, so it supplies no registry evidence. Further stack export remains diagnostic;
it does not authorize adding `registryRead`, modifying existing registry ACLs or bypassing process/security policy.

This fixture does not run the pinned Copilot runtime, Node, a shell or a general toolchain. It has no credential broker,
model transport or real provider authentication. Zero capabilities are configured and checked, but network connection,
LAN/loopback/SMB, COM/WMI/services and other escape routes still need independent probes. It sets process containment,
not CPU/memory quotas or a complete resource policy. Its receipt covers contained job members, not unproven escaped
brokers or external writers. It does not implement recursive project capture, handle-relative hostile result traversal,
result export, automatic apply, or crash-safe session ownership recovery. The tiny fixture supplies no evidence of
whole-runtime compatibility, Windows 10/11 parity, ARM64, packaging or other operating-system enforcement.
