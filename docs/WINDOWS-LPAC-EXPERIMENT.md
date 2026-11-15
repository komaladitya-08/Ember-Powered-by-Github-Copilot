# Offline Windows LPAC fixture experiment

This is an experimental native-process foundation, separate from the product coding path. Native coding remains
unavailable. The full Windows runtime/broker design is in [WINDOWS-CODING-BOUNDARY-PLAN.md](WINDOWS-CODING-BOUNDARY-PLAN.md).

## What exists

`experimental-windows-lpac-api.ts` binds the Win64 APIs through koffi. `ExperimentalWindowsLpacFixture.prepare()`
accepts a host-selected native executable as bytes and creates fresh scratch tools/work/state objects with protected
package-specific ACLs. It checks for a fixed NTFS volume, pins the original directory ancestry without delete sharing,
and refuses reparse objects before resolving case/short names. It never changes ACLs on an existing source project,
user profile or system root. Tool access is read/execute; workspace/state access excludes write-DAC and write-owner.

Preparation creates a unique AppContainer profile. `launch()` requires both security-capabilities and LPAC opt-out
attributes. It supplies zero capabilities, an explicit clean environment and no inherited handles. The process starts suspended,
joins a private kill-on-close job with neither breakaway flag, and has its package SID, AppContainer/LPAC flags and
zero capability count checked before its first thread resumes. Unsupported APIs and failed checks have no ordinary
AppContainer fallback. A post-create failure kills and observes the suspended process before releasing its handles;
unverified cleanup preserves diagnostics and blocks further experiments in that host process.

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
only kernel32/advapi32 imports. GitHub's `windows-2022` runner is the initial CI target. Non-Windows runs skip this
native case. A missing compiler, unsupported LPAC configuration, missing report or failed native assertion on Windows
fails the test; none is converted into a skip or a broader grant.

The native fixture checks its token, confirms a synthetic host token variable was not inherited, reads its copied
executable, writes its workspace, and is denied a canary readable by ordinary All Application Packages. The host first
reads that canary as a positive control. The fixture separately probes denied VM-read, handle-duplication and
parent-process rights on its host, alongside a successful self-process query. It attempts breakaway creation, then
starts an ordinary child which outlives the root. The test observes root exit before verifying that a result receipt
is still unavailable until Stop ends the child. Reports contain numeric fixture results, not secrets.

Portable failure/order tests run with:

```text
npx vitest run test/unit/experimental-windows-lpac.test.ts test/unit/experimental-windows-lpac-api.test.ts
```

## Evidence and remaining boundaries

The portable tests pass in the Linux workspace. Windows compilation and native enforcement are pending CI evidence;
portable mocks are not LPAC certification. Record the exact commit and native result before making enforcement claims.

This fixture does not run the pinned Copilot runtime, Node, a shell or a general toolchain. It has no credential broker,
model transport or real provider authentication. Zero capabilities are configured and checked, but network connection,
LAN/loopback/SMB, COM/WMI/services and other escape routes still need independent probes. It sets process containment,
not CPU/memory quotas or a complete resource policy. Its receipt covers contained job members, not unproven escaped
brokers or external writers. It does not implement recursive project capture, handle-relative hostile result traversal,
result export, automatic apply, or crash-safe session ownership recovery. The tiny fixture supplies no evidence of
whole-runtime compatibility, Windows 10/11 parity, ARM64, packaging or other operating-system enforcement.
