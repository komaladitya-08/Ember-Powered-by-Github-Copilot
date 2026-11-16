# Separate source-built Node feasibility

This experiment builds Node 22.23.5 from its verified release source and runs only two fixed JavaScript literals.
It follows the [completed fixed C feasibility result](EXPERIMENTAL-WINDOWS-LIBUV-OFFLINE.md); it does not enable a
Windows coding backend, accept project code or establish a general offline runtime. The first verified Windows
build and ordinary-host useful-work control passed. The LPAC process aborted before producing a checkpoint;
useful source-built Node work in LPAC is still unproved.

## Source and tool authority

The release archive is the same independently verified OpenJS source used by the C experiment: 50,529,596 bytes,
SHA-256 `6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a`, release commit
`60553651579ec33ca1aef9e1eedab2c3855f1f7e`, and trusted Node signing fingerprint
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. Manifest and annotated-tag signature provenance is pinned.

The full archive contains 29,212 regular files and 3,400 directory entries, including its archive root. No links,
special files, privileged modes or case aliases are accepted. Exactly three pinned Unicode fixture names are
allowed; all other names follow the strict safe relative-path policy. The complete source file/directory manifests,
entry counts and expanded byte limits are pinned. The baseline contains 554,315,497 bytes. Its separate working
copy contains the same source except the one previously tested guard around `uv__winsock_init()`.

Actual local preparation verified both complete trees against their pinned manifests. The baseline stays out of
the build and is checked exactly afterward. Working validation checks every original source input and its ancestry;
it permits generated outputs without traversing or treating them as trusted inputs. Upstream's generated `Release`
junction is not used to select the delivered executable. The source catalog is authenticated by pinned whole-file
and directory digests and lives outside both trees.

NASM 2.16.03 comes from its fixed official Windows x64 ZIP, SHA-256
`3ee4782247bcb874378d02f7eab4e294a84d3d15f3f6ee2de2f47a46aa7226e6`. This matches the independent historical
[Scoop manifest](https://github.com/ScoopInstaller/Main/blob/362b99166f2c5e327aa3439dadbc79f639f96bf3/bucket/nasm.json).
All three archive members are checked; only the exact `nasm.exe` and license are staged. Actual local staging passed.
No NASM signature verification is claimed. Its tool pin remains separate from the Node source GPG trust root.

The issuer is `ember-experimental-source-node-feasibility`. Its receipt binds the release source, one-file patch,
complete input manifests, selected tools, compile recipe, build commit and both resulting image hashes. It does
not claim OpenJS Authenticode authority. The original official Node verifier and its pins are unchanged.

## First build profile

The first build targets Windows Server 2022 with the reviewed VS 2022/v143 toolset and Windows SDK. The upstream
command is `vcbuild.bat x64 vs2022 no-cctest nonpm nocorepack`. Its default Release configuration preserves normal
Node/V8/OpenSSL/Intl, snapshot, JIT and NODE_OPTIONS behavior. No runtime policy or performance workaround is used.
Full ICU is already bundled in the signed archive; no ICU download or feature omission is needed.

The build receives a clean environment and fresh private profiles. The sole compiler macro activates the exact
reviewed libuv guard. Compiler, linker, MSBuild, vcvars, vswhere, Python and NASM identities are captured and checked
around the operation. Python must be attested before source or NASM extraction. Ambient flags, credentials, Python
hooks and user build customization are excluded. The build has its own bounded workflow deadline.

The inert setup executable exists only to use the existing 16 MiB fixture constructor. It is never executed: the
launcher accepts only the fixture's exact setup request and redirects it to the separately staged, hash-checked
Node image. No legacy size limit is raised. The source image has its own explicit 128 MiB bound.

Only the public-source Node image, inert setup image, compact build receipt and Node license may be retained as
build artifacts. Source trees, build profiles, private runtime scratch, process output, reports and dumps are not
uploaded. Compile inputs and fixed runtime literals have separate receipts so later diagnostic code can reuse an
unchanged verified build without pretending it was compiled at a different commit.

## Fixed native program and controls

The first program checks Node startup/version, writes and reads one fixed 24-byte payload, completes one async
read and one timer callback, removes its own work file and exits naturally. It calls no networking, DNS, crypto,
worker-thread, child-process, supplied module or arbitrary CLI interface. Host and LPAC literals differ only in
their fixed role/report names; their exact byte lengths and hashes are recorded for each run.

A fresh 64-byte checkpoint report contains only closed numeric fields. Errors become a fixed failure value and
never print a filesystem exception. Success requires exact payload, callback, cleanup and checkpoint counts.
The role field identifies the fixed literal; native token attestation independently proves process confinement.

The ordinary source-built control executes its original pinned asset. The LPAC executes only its separate
LOW-labelled copy. Both retain exact image/PID checks, private jobs, two private stdio handles and a clean
environment. LPAC still requires the original package/zero-capability/AAP checks before resume. The host must
match the parent's observed context and finish useful work before LPAC admission. No credential or SDK handle is
inherited. Every read follows root exit and private-job zero; outward facts follow verified cleanup.

Source-specific conservative ownership guards fence any ambiguous legacy acquisition or close. They retain known
setup owners and prevent profile/ancestry release; known process/job stop attempts still occur. These guards do
not change the frozen official verifier. The official 22.23.5 stock startup and `WSAStartup / 10107` LPAC refusal
remain separate controls with their original byte and Authenticode checks.

## Evidence and remaining gates

Local source/NASM preparation and portable source, build-receipt, environment, PE, report and ownership contracts
pass. The unchanged fixed literals also complete real local IO and timers in isolated host unit processes, with
synthetic Windows path/version metadata. That is program-logic verification, not Windows execution evidence.
Linux normally skips the native suite; explicitly requiring it on an unsupported host must fail.

The [first Server 2022 run43823648292](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43823648292)
at head `b570de1f700bab85e21b0aa8ebb429b21ad1096e` compiled and completed all source/tool/recipe/PE checks.
Its actual merge compile commit was `2a1d186c44239ef35686e9eefa1e535d71f25344`. The custom Node image was
120,218,624 bytes, the inert bootstrap 2,560 bytes, and compiler version 19.44.35230.0. Portable tests passed 122
cases with one expected privilege skip. The [completed native job133152239151](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43823648292/job/133152239151)
passed three of four cases: the unchanged official host/startup and stock LPAC `WSAStartup / 10107` controls,
and custom source-built ordinary-host useful work. The custom host matched the parent's user, integrity RID 12288,
AppContainer 0 and absent restricting SIDs. It completed all 31 feature bits, 24-byte sync/async operations, one
read callback, one timer, own-file cleanup and six checkpoints, then exited 0 with its job stopped.

The source-built LPAC instead exited 134, produced no fixed report, and left 1,157 bytes of captured output. Only
the original parser's closed `no-location` metadata was returned; captured text, stack paths and arguments were
never printed or uploaded. The private job was stopped and cleanup verified. Its required success assertion
failed and remains in place. This is a startup blocker, not useful Node execution in LPAC.

The build's four public files were uploaded as artifact 14207138723. Its authenticated ZIP is 38,423,911 bytes,
SHA-256 `34fd4ffd22e81b7927b99663f10c06d9a3086782b5462a394d654bb2f998c5be`; it contains no private runtime data.
A [separate native-only reuse lane](EXPERIMENTAL-WINDOWS-NODE-NATIVE-REUSE.md) diagnoses that exact image without
another source build or a source/runtime policy change.

Even eventual fixed-program success would cover only the stated operations.
The binary retains general Node/libuv interfaces, including network and UNC paths whose initialization/denial
behavior is not closed by this guard. General use requires complete applicable API classification and enforcement,
host/IPC/network canaries, ordinary child and default test-runner proof, descendant cleanup, real command/file/review
integration and supported Windows 10/11 acceptance. Files-only or fixed-literal success does not complete the normal
build/test coding-loop goal. No product capability is promoted by this experiment.
