# Windows isolated command proof

Status: compatibility prototype; the useful Windows command backend is not ready. The ordinary coding gate remains closed. These experiments do not certify the Copilot SDK, desktop control, or a production sandbox.

## Recorded Windows evidence

The Windows Server 2022 hosted runner (10.0.20348, image `20261112.366.7`, Node 22.23.4) executed both real native tests. Latest recorded uninstrumented run: [coding-boundary 43765356790](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43765356790), job `132969130727`, completed 2026-11-15 21:47 UTC. The PR head was `a3556f23`, including native experiment `e48d8510`. Both native steps failed. Explicit user/SYSTEM/package ACLs on newly created child process/thread objects did not resolve child creation.

| Observation | Recorded result |
| --- | --- |
| Fresh LPAC profile, suspended launch, private job assignment, expected package identity and zero capabilities | Reached and verified before resume |
| LPAC behavior witness | Own-package access succeeded; generic AppContainer access was denied using documented AccessCheck operations |
| Native copied executable startup | Reached C entry point; root later exited `0x12` (decimal 18) |
| Native denial/control checks | Generic AppContainer canary denied; copied image readable; tested host process rights denied; breakaway denied; private work write succeeded |
| Ordinary child creation | `CreateProcessW` failed with Windows error 5 (`ACCESS_DENIED`) |
| Additional child diagnostics | Image read/execute open and self `PROCESS_CREATE_PROCESS` open succeeded; child-policy probe did not produce a successful observation |
| Descendant shutdown and redirected profile TEMP checks | Full fixture not completed because ordinary child creation failed |
| PS7 publisher check | Trusted host Windows PowerShell 5 system security module accepted a valid Microsoft signature on the selected system executable |
| PS7 distribution copy | 1,104 files, 54 directories, 297,260,191 bytes measured and copied into fresh package-specific read/execute files |
| PS7 execution | Verified LPAC root exited `0xe0434352`, a CLR managed-exception status; initial runtime report, later command report and script diagnostic were absent |
| Managed exception attribution | Follow-up StartupHook captured PowerShell ETW-provider registration failing with Windows error 5 during command-line parsing, before the supplied script |

The PS7 manifest SHA256 was `3f1163ddf3b359f16262fe54ed877ede59489a728f8bb02e28941cdcce27f3a0`. This records the measured distribution, rather than a permanent approved-version allowlist. The uninstrumented missing initial output alone did not locate the failure. The instrumented stack below establishes the earlier command-line startup failure; the later `Get-ChildItem` success check was not established.

The follow-up [instrumented run 43765667324](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43765667324), head `b1ce692f`, job `132970071271`, completed 2026-11-15 21:50 UTC. Its fixed host-built .NET StartupHook installed successfully and recorded this unhandled exception in private state:

```text
PSEtwLog type initializer
  -> PSEtwLogProvider type initializer
  -> System.ComponentModel.Win32Exception (5): Access is denied
     at System.Diagnostics.Eventing.EventProvider.EtwRegister()
     at SystemPolicy.SafeWldpGetApplicationSettingBoolean / IsFileOnlyEntryEnabled
     at CommandLineParameterParser.ParseCommand / ParseHelper
     at ConsoleHost.ParseCommandLine -> ManagedPSEntry.Main
```

This proves a PowerShell ETW-registration startup blocker before the supplied script. It does not establish a supported repair under the zero-capability constraint. The strict PID/time/image event-1026 query returned no usable event; the managed hook supplied the actual stack. The hook is compiled against the already-vouched system PS7 runtime, staged as a fresh protected package file, and enabled only by an explicit fixture-local environment variable. It is diagnostic instrumentation, not a production environment default or evidence that the original configuration works. Native child creation remains unresolved; subsequent default-DACL and child-attribute experiments have not established a successful child launch here. A separate [pinned-source ETW experiment](EXPERIMENTAL-POWERSHELL-ETW.md) proposes a reviewable runtime change without opening a product gate.

## Trust and isolation scope

The proof selects the hosted image's system `Program Files\PowerShell\7` distribution explicitly. It does not use PATH, user/MSIX execution aliases, project-selected assets, or a model-selected manifest. The trusted host vouches for the whole installed distribution; a valid signature on its executable alone does not authenticate every companion file. An expected SHA256 manifest binds every staged filename and file body to that host-selected snapshot.

Source ancestry is pinned on local NTFS. Native file handles reject reparse/special files and multiple hardlinks, deny write/delete sharing during reads, and recheck file identity. Enumeration has limits of 4,096 entries, depth 16, 128 MiB per file and 1 GiB total. Files are created fresh with protected package-specific read/execute ACLs; source trees receive no grants. Work and state are disposable, separately writable directories.

The launcher verifies the suspended process before resume, inherits no host handles, copies no host credential environment, requests no capabilities, and keeps a private kill-on-close job. A result lease requires the root handle and both job counters to show stopped writers. Ordinary AppContainer fallback, generic application-package grants, host-tree ACL grants and extra capabilities are not compatibility repairs. Service/broker escape behavior remains outside this prototype's evidence.

## Verification and remaining software work

Portable checks for the asset reader/stager: 17 focused unit tests, focused ESLint and the proof's semantic TypeScript configuration passed. Linux skips the real Windows tests solely by platform; that skip is not native evidence. Windows configuration errors and incompatibilities fail the configured runner.

Reproduce on Windows with:

```sh
node scripts/run-integration.mjs test/integration/experimental-windows-lpac-native.test.ts
node scripts/run-integration.mjs test/integration/isolated-windows-command-powershell-native.test.ts
```

Remaining work that can continue through Windows CI before a physical laptop is needed:

1. Establish and repair the ordinary child-creation denial without weakening the boundary; complete native descendant and profile TEMP observations.
2. Resolve the proven PS7 ETW-registration incompatibility through a supported trusted-toolchain/startup configuration consistent with the zero-capability constraint. Do not convert an ETW registration denial into generic capabilities, global provider ACL changes or an ordinary AppContainer fallback; preserve failure if compatibility cannot be established.
3. After positive compatibility evidence, implement the actual PowerShell-only command backend with bounded output/time, closed stdin, cancellation, verified stop/close and safe private-file/export operations. `cmd.exe` is not a general tool in this version.
4. Verify source isolation, credential/environment denial, concurrent session separation and failure cleanup against the real backend; wire the backend into the custom-tool coding controller only after those checks.

A physical Windows acceptance pass still needs the packaged companion, real Cursor/apps, desktop permission and focus behavior, Stop/takeover, restart recovery and normal user workflows. Current failures are software/compatibility blockers observed on hosted Windows; requesting a laptop does not resolve them.

## Supported opt-out research

PowerShell v7.7.0, commit `5c95ed61735c05eb99543aabf196529b5f267602`, still has no supported ETW-registration opt-out in the reviewed startup path:

- [PSEtwLogProvider constructor](https://github.com/PowerShell/PowerShell/blob/5c95ed61735c05eb99543aabf196529b5f267602/src/System.Management.Automation/utils/tracing/PSEtwLogProvider.cs#L25) unconditionally constructs `EventProvider`.
- [PowerShell's EventProvider implementation](https://github.com/PowerShell/PowerShell/blob/5c95ed61735c05eb99543aabf196529b5f267602/src/Microsoft.PowerShell.CoreCLR.Eventing/DotNetCode/Eventing/EventProvider.cs#L78) unconditionally invokes native `EventRegister` and throws `Win32Exception` for nonzero status. It has no environment or AppContext guard; the runtime's EventSource switch does not control this implementation.
- [Telemetry opt-out](https://github.com/PowerShell/PowerShell/blob/5c95ed61735c05eb99543aabf196529b5f267602/src/System.Management.Automation/utils/Telemetry.cs#L178) controls Application Insights, rather than ETW registration. It should still be disabled for product privacy, separately from this compatibility issue.
- [WDAC query logging](https://github.com/PowerShell/PowerShell/blob/5c95ed61735c05eb99543aabf196529b5f267602/src/System.Management.Automation/security/wldpNativeMethods.cs#L119) invokes `PSEtwLog` regardless of the returned query result, matching the captured exception. `-File` avoids that particular parser branch, but [console startup completion](https://github.com/PowerShell/PowerShell/blob/5c95ed61735c05eb99543aabf196529b5f267602/src/Microsoft.PowerShell.ConsoleHost/host/msh/ConsoleHost.cs#L1834) also logs unconditionally; this is not an established remedy.

A possible upstream repair is to make a denied optional ETW-provider registration a diagnosed unavailable-logging state instead of an unhandled static-constructor failure, while preserving WDAC queries, enforcement and any required-audit behavior. That requires an explicit upstream/security design and real native tests. No reflection mutation, native patch, policy override, global provider ACL change or capability fallback was applied here. The separate pinned-source Eventing experiment now builds successfully and preserves normal host registration, but both EncodedCommand and File entry still stop at required registry-policy queries before the supplied script. That experiment remains failed for runtime compatibility; see its linked design/evidence document.

## Relevant upstream contracts

- [Microsoft: launch AppContainer/LPAC](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer): LPAC restrictions and explicit capabilities.
- [Microsoft: PowerShell ZIP deployment](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows): portable deployment, without a capability-free LPAC support guarantee.
- [PowerShell AppContainer drive issue #27253](https://github.com/PowerShell/PowerShell/issues/27253) and [fix #27266](https://github.com/PowerShell/PowerShell/pull/27266): known drive/cmdlet compatibility issue, not an established cause of this CLR failure.
