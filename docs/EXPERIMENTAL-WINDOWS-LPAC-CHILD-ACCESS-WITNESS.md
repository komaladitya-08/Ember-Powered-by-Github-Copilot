# Manual fixed C child access witness

This draft is stacked on the inherited-child probe at `a1f10fc515d312d8ae28970712fbc9f02064d9d2` (#224).
[Run 43838983895](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43838983895)
passed 194 portable tests and both denial controls on Server 2022/2025. All six native creation comparisons returned
stage 18 / Win32 5 / `0xc0000022` with independently stopped retained handles and known cleanup. The phase-5 cause
in an earlier run remains unidentified. None of those outcomes proves child creation impossible or Node compatibility.

The next slice observes exactly one unchanged `aap-inherit-console` C program. Original C sources, six-case tests,
creation flags/arguments/environment, zero capabilities, fresh package, own-package/AAP witnesses, ACLs and product
gates are unchanged. No project input, provider credentials, injected service, JIT switch or policy bypass is used.

## Registration and execution

The new workflow's PR job runs portable parser/provenance/injected native/watchdog contracts on Linux. Its entire
Windows driver job is guarded by `github.event_name == 'workflow_dispatch'`; there is no automatic driver job.
It requires administrator elevation, x64 Windows, `GITHUB_ACTIONS=true`, the manual event, an exact source commit
and one declared disposable Server runner. An explicitly enabled wrong host refuses; it never silently skips.

Open this draft against `ember-experiment/20261116-lpac-inherited-child`, rather than main or #223, to exclude
ancestor changes matching the old automatic trace workflow. No old `windows-lpac-*` script, original C/test or
automatic trace workflow is modified. The final changed-path set must be checked before the first push/PR.
Root reviews the concrete draft before its first manual dispatch. No collector, driver or tool download has run
as part of developing the portable implementation.

## Issuer and provenance

The separate issuer is `ember.experimental.fixed-c-child-access-witness.v1`. Three source hashes are pinned to #224's
unchanged C/header bytes and checked before copying them into fresh build scratch. The exact reviewed compile recipe
selects only AAP opt-out plus inherited console, with the original CRT-free flags and libraries. The internal manifest
binds those hashes, base/current commits, recipe hash and produced PE hash. A forged JSON manifest/source-map copy is
refused. This issuer does not replace the official OpenJS verifier or establish a production runtime.

Procmon comes only from the existing official ZIP URL, archive SHA-256 and executable SHA-256 in
`scripts/experimental/windows-lpac-procmon-pin.json`. Download size/time, ZIP directory/entry/inflate size, CRC,
regular-file shape and the exact executable hash are checked. Only the fixed `Procmon64.exe` entry is written;
archive paths are never extraction destinations. Valid Microsoft Authenticode is separately required through a
fixed clean host signature helper. Immutable no-write/delete pins remain held on executable inputs.
The same strict pin currently requires a single-link System32 PowerShell helper. A runner may expose that OS image
through WinSxS hardlinks; that has not been measured here and is not silently accepted. First native preflight records
only its bounded link count on refusal. A multi-link or otherwise unpinnable helper stops setup before any collector
execution, pending an evidence-based separate review; private trace/asset single-link checks are not weakened.

## Ownership and bounds

The LPAC root retains its original native owner. Before its actual Resume, the harness rechecks the same held root's
PID, exact immutable image, private job and fresh-package/zero-capability/AAP token witnesses. The owned collector
and readiness helper must pass first. A PID in a filter or CSV is metadata; it never creates native authority.

Collector/control/export helpers are created suspended with clean environment and zero inherited handles, assigned
to private kill-on-close jobs, and verified through retained exact image/PID/token handles before resume. Every
observed job member is retained and independently stopped. Creation followed by assignment contains descendants
launched after resume; it does not attest arbitrary OS helpers born during CreateProcess or external services.

Exclusivity is an explicit fresh disposable hosted-VM assumption, not a hostile-same-user exclusion guarantee.
Preexisting or unexpected Procmon instances refuse. An exited singleton-forwarding launch cannot satisfy readiness.
The global vendor `/Terminate` command is used only while the actual held collector remains alive and exclusively
owned. Name/PID filters confer no kill authority; failure paths never issue a global/name-based termination.

The collector has a fixed 12-second vendor runtime. Exact helper waits retain their own bounds; native whole-job
and held-handle Stop uses one monotonic 15-second deadline per operation, with late/unknown completion terminal.
An independent fixed worker watches PML/CSV type/link/size metadata (64/32 MiB) and a 60-second overall deadline,
even while the main thread blocks in native waits. It can request cleanup only through exact borrowed owned-job
handles. All borrowed handles stay held until natural watchdog shutdown is positively verified. File-size polling
is not an atomic disk quota; a limit breach invalidates collection and publishes no data.
An active filesystem-metadata fault also requests Stop once for every validated registered job, independently of
the main thread's native wait. A failed/thrown/unknown native Stop ends that sequence immediately without retry or
further owner queries; no death proof or publication follows. Loader failure cannot start a capture because readiness
precedes every collector launch. The main wait remains bounded by its original deadline; unverified completion
retains owners for disposable-VM teardown. No finite kernel/driver teardown guarantee is claimed.

## Readout and privacy

After native root/job/retained-handle Stop and owned collector/helper completion, the harness opens PML through a
disk/ordinary/single-link read pin sharing READ only. A surviving ordinary writer makes that pin fail. The pin stays
held during export; refusal to export under it is an unavailable witness, never a fallback that releases exclusion.
After exporter completion, CSV gets the same finalized read pin. All writers and the watchdog must be stopped before
even fixed C control bytes or CSV are decoded. Original C denial checks must still match before trace interpretation.

The strict UTF-8/CRLF seven-column CSV parser caps bytes, rows and fields. It selects only the held root's metadata,
requires exact image-success and synthetic ordinary-AAP-canary-denial events, and requires one successful final
Process Exit with no later same-PID row. This does not make CSV metadata a token/isolation proof. Missing controls,
malformed data or contradictory lifetime evidence produce only a fixed refusal.

Successful output consists only of fixed schema/status/coverage numbers and sorted
`[operationId, resultId, pathClass, count]` tuples. Exact controls use classes 1–4; public registry families use 10–13;
Windows library families use 20–22; unknown strings map to 0. No captured string, PID, SID, nonce, private path,
command line, registry value, Detail field or stack frame is printed. No raw artifact is uploaded. Pins and exact
native owners must close and known owned scratch must be removed before aggregate counts return.

Any uncertain ownership, stop, collector/export, writer pin, watchdog or close retains the private graph, blocks
decoding/publication and prevents recursive cleanup. The scratch lives outside Vitest's automatic temporary wiper.
Signed vendor driver, EULA and configuration state may persist until the disposable hosted VM is torn down;
successful `/Terminate` and frontend exit do not attest driver unload, restoration or uninstall. OS driver/HVCI
policy is not weakened. A controlled trace can miss the decisive kernel object/policy check; even complete controls
and no observed denied I/O do not establish the cause or a compatibility result.

## Validation

The six portable suites in the workflow pass **361 tests** with one worker. They exercise the strict parser, actual
manual-entry refusal on PR events, provenance/archive bounds, injected native ownership/faults, watchdog protocol
and stopped readout ordering. Scoped ESLint and the fresh exact-final full `tsc --noEmit` pass. The Linux integration
import succeeds and skips its one manual-only native case. Native-owner and coordinator/readout reviews found and
closed the retired-PID, first-close ownership-reference, readiness and watchdog metadata-failure gaps. The full
changed-path set has no match against the historical automatic driver workflow's trigger patterns.

These portable checks load no collector/driver, run no real Worker/native binding, and perform no tool download.
Native execution is pending Root's review and first manual dispatch. No source-built Node, production gate,
desktop acceptance or physical client compatibility is claimed here.
