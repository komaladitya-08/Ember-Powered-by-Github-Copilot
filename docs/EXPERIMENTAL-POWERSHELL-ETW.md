# Pinned PowerShell ETW compatibility source experiment

This is a reviewable runtime experiment, not a product backend or an approved PowerShell distribution. The normal coding gate stays closed. The existing Microsoft-signed system-runtime proof remains a separate, failed control.

The unmodified runtime's captured failure is `PSEtwLogProvider` initialization → `EventProvider.EtwRegister()` → Windows error 5, during command-line policy-query logging before the supplied script. The proposal handles that specific registration failure without changing the policy query or its result.

## Exact source and build inputs

- PowerShell **7.6.10**, matching the recorded Windows runner image; commit `16ac95d24d87c61a5d8300dae2d0619db06c555c`, annotated tag object `0aadef78a6a2e719671b63ca882331998879124f`.
- SDK **10.0.404**, required by that commit's `global.json`; an absent/different configured SDK fails.
- Official Windows x64 portable archive SHA256 `7d871531806eb1646264e4bbabd9f0c30c23355591bc756bb9909448c29ae166`.
- The pin manifest records original source-file, patch and patched-file SHA256 values. Both source commit/tag and all three content hashes are checked before building.

The script rebuilds only `Microsoft.PowerShell.CoreCLR.Eventing` from the pinned component sources. An isolated SDK project generates neutral resource accessors, preserves the upstream public-key/assembly-version identity, and references the EventLog assembly from the hash-pinned archive. Its NuGet feed list is empty: an unexpected dependency restore fails rather than fetching an unpinned analyzer or package. This checks whether a bounded software-only source build is possible without the full PowerShell packaging pipeline.

The resulting DLL replaces the Eventing component in a **fresh experimental copy** of the pinned portable archive. No binary bytes are edited. No installed PowerShell files are modified. Every WDAC/enforcement assembly remains the official archive's original body. The replacement is source-built and not Microsoft-authenticated; the official archive's signature does not vouch for this modified distribution. Build provenance records both component hashes and the explicit experiment label.

## Restricted failure behavior

The patch changes only `EventProvider.cs`:

1. Native `EventRegister` must actually return `ERROR_ACCESS_DENIED` (5).
2. A separate, query-only `OpenProcessToken(GetCurrentProcess())` / `GetTokenInformation(TokenIsAppContainer=29)` call must return exactly one DWORD with value 1. This is a primary-process token observation, independent of environment variables or caller assertions.
3. Failed/unsupported queries or token-close failure preserve the registration exception. Ordinary host processes and all other registration errors keep the original throw behavior.
4. The recovered instance has registration status 5, no registration handle and `IsRegistrationAvailable=false`. Every direct event-write overload, including protected raw-pointer overloads, returns false and sets `RegistrationUnavailable`; no write is represented as successful.

No token, capability, provider ACL, file ACL outside the fresh fixture, policy setting, security-log field or native code is patched. No reflection mutation is used. WDAC queries and enforcement code are untouched. The package remains capability-free LPAC with the existing native token/job/stop checks.

**The restricted process's PowerShell ETW/audit channel is unavailable.** This does not preserve a required ETW audit guarantee. Ember's trusted host command audit is unchanged, and the experimental test emits an explicit host-side observation with registration status, build pin and manifest after verified process shutdown. Product use must refuse configurations requiring an unsupported ETW audit channel; this experiment grants no production authorization.

## Verification and limitations

The dedicated `experimental-powershell-etw` Windows workflow has a 25-minute job bound, a 12-minute build bound and a 5-minute native-test bound. Actions are pinned. The real test is selected only by an explicit experimental toolchain; a configured job with a missing/unsupported toolchain fails.

It checks normal-host provider registration remains successful, then launches copied source-built assets in actual LPAC. It requires an explicit unavailable-provider marker and false write result under LPAC, then attempts a normal `Get-ChildItem` operation. A remaining command/runtime incompatibility fails and reports the next blocker. A fixed diagnostic StartupHook can record an additional managed failure into private state; all reports are read only after the root and contained descendants are verified stopped.

Portable evidence so far: the patch applies to the exact upstream source; the build script parses in matching PowerShell 7.6.10; all patched component C# sources compile against the matching .NET 10 reference set. That Linux syntax compile omits signing because Add-Type's Linux signing provider is unsupported; the Windows SDK job must still establish the actual component build, identity and runtime compatibility. Native negative coverage for arbitrary non-5 errors/token-query failure is currently source review, not injected Windows fault evidence.

Even a green experiment would establish only this narrow source-build/ETW behavior. Ordinary native child creation, bounded PowerShell command execution, safe file/export operations, durable session isolation and mandatory-audit policy support remain separate gates. Do not weaken those gates to make this experiment green.

## Local or CI invocation

```powershell
./scripts/experimental/build-powershell-lpac-etw.ps1 -Scratch C:\fresh\ember-etw-experiment
$env:EMBER_EXPERIMENTAL_PS7_ROOT = 'C:\fresh\ember-etw-experiment\package'
$env:EMBER_EXPERIMENTAL_PS7_REQUIRED = '1'
node scripts/run-integration.mjs test/integration/experimental-powershell-etw-native.test.ts
```

The scratch directory must be absent. The script creates only that directory, downloads the pinned archive/source, builds and records provenance. It does not install the result or open the coding gate.
