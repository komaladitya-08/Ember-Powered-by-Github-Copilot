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
The second manual matrix measured two links for the installed System32 PowerShell helper on both Server images.
The separate no-path `pinWindowsPowerShell()` selector now derives the system directory through
[`GetSystemDirectoryW`](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemdirectoryw)
inside the existing x64-only factory. System32 is the [64-bit system directory](https://learn.microsoft.com/en-us/windows/win32/winprog64/file-system-redirector)
for this process. The native result must be bounded, terminated, ordinary and canonical, with an exact System32
basename; UNC/device/stream/dot/short aliases and other directories refuse before helper admission.

Only the fresh native-derived helper handle record may have one or two links. Both its initial admission and every
later held-handle identity check require the same link count; changing 1 to 2 is refused even though either can be
a valid initial count. READ-only access, READ sharing only, ordinary/non-reparse checks and exact final path remain.
The exception cannot be selected by a caller path, flag, filename or reused numeric handle. Generic `pinFile`,
source, staged tool and PML/CSV pins still require exactly one link, even when passed the PowerShell pathname.
Launch binds the opaque pin to the exact native-derived program. The fixed security-module path comes from that
same PowerShell home, without environment/model selection. Module contents remain part of the existing trusted
installed-OS-module assumption; this change does not newly hash or signature-verify that module's contents.

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

The initial `1c1699ae` candidate passed **361 tests** across the six portable suites with one worker. They exercise the strict parser, actual
manual-entry refusal on PR events, provenance/archive bounds, injected native ownership/faults, watchdog protocol
and stopped readout ordering. Scoped ESLint and the fresh exact-final full `tsc --noEmit` pass. The Linux integration
import succeeds and skips its one manual-only native case. Native-owner and coordinator/readout reviews found and
closed the retired-PID, first-close ownership-reference, readiness and watchdog metadata-failure gaps. The full
changed-path set has no match against the historical automatic driver workflow's trigger patterns.

These portable checks load no collector/driver, run no real Worker/native binding, and perform no tool download.
No source-built Node, production gate, desktop acceptance or physical client compatibility is claimed here.

The first manually dispatched [run 43847141883](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43847141883),
at `1c1699aea9f003d64fc8e0141ca6546d6e503efc`, refused on both Server images during phase 4/native stage 3/operation 9
(`SetFilePointerEx`), domain/code 0/0, with helper-link preflight still 0. This was staged-tool readback, before any
PowerShell or Procmon process was launched; no collector/driver execution or trace evidence was established.

The old seek validator accepted only `0n`. The actual pinned Koffi 3.2.1 documentation lists `int64_t` as JS Number,
with BigInt used when necessary for larger values; its [primitive types](https://koffi.dev/primitives),
[decode values](https://koffi.dev/values) and [output parameters](https://koffi.dev/output) documentation describe this
conversion. The repair accepts only literal number `0` or bigint `0n` after a successful seek, with an unset output
sentinel and no coercion. Failed/thrown native calls, nonzero outputs and every unknown shape remain terminal before
content reads; immutable identity, writer exclusion and single-link guards are unchanged. This corrects an ABI
representation mismatch; the first receipt did not record the actual Windows output type or establish an OS denial.
Another manual driver run remains pending review and Root's explicit dispatch.

The repaired candidate passes **387 portable contracts**, including **100 native-owner contracts**, scoped
ESLint and a fresh exact-final full TypeScript check. Both documented zero representations read the same held file;
nonzero, missing, coerced, failed and unknown outputs refuse before `ReadFile` and preserve the terminal ownership
fence. No second driver run was dispatched
while preparing this repair.

The second manually dispatched [run 43851751832](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43851751832)
at `8488a42a032b0ed52385ddc3a5e100e627f20001` passed the repaired staged-tool read and refused on both Server images
at phase 5/native stage 2/operation 7, domain/code 0/0, with `hostHelperLinks: 2`. This is measured preflight metadata,
before any PowerShell or Procmon launch, watchdog or capture. It motivates only the narrowly derived OS-helper role;
it is neither an OS denial code nor evidence about the original LPAC child-creation denial. A third manual matrix
remains pending the corrected candidate's frozen review and Root's explicit dispatch.

The fixed-helper candidate passes **434 portable contracts**, including **147 native-owner contracts**, scoped
ESLint and a fresh exact-final full TypeScript check. The Linux integration imports and skips its one manual case.
Independent native review confirms the record-only role, stable identity/link checks, unchanged generic single-link
rules and exact launch/module binding. These checks execute no Windows API, PowerShell, vendor tool or driver;
the native behavior of the corrected selector remains pending the reviewed manual matrix.
