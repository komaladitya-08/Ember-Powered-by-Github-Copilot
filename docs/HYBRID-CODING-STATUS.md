# Native coding work in progress

The legacy native-SDK coding entry points are deliberately unavailable. That implementation is not ready to merge or
release. Desktop tasks continue through their existing worker. Do not open the native coding gate merely because the
ordinary unit tests pass.

The development follow-up adds a separate [custom-tool controller and isolated command workspace](ISOLATED-COMMAND-WORKSPACE.md)
on Linux. Native SDK coding tools remain disabled, the trusted controller/credentials stay outside the command
namespace, and results are reviewed/exported without source writes. Its per-project integration and remaining limits
are tracked in [CONDUCTOR-PROGRESS.md](CONDUCTOR-PROGRESS.md); it does not turn this older path into an enforced backend
or establish Windows/macOS coding support.

## Explicit files-only controller capability (16 November 2026)

The custom controller and scoped worker now accept an explicit `mode: "files-only"`. This mode registers the seven
scoped file tools and `finish_coding` (plus the existing optional clarification tool), with no `run_command`, command
service, runner facts or command context. The existing SDK hardening and live inventory verification still apply.
The worker captures that capability before startup waits, so changing caller options later cannot add execution.
An invalid command configuration fails; failed isolation never silently selects files-only mode.

Files-only sessions use the same private-copy, privacy, cancellation, awaited controller/file-broker disposal and
review publication lifecycle. Their host-recorded check counts are zero and the final summary explicitly says no
commands or tests ran. File-edit completion is not evidence that edited code builds or passes tests.

Portable unit tests cover inventory, forced execution-tool rejection, revocation and capability mutation during
startup. Real pinned-SDK Linux integrations exercise read/edit/finish and private-copy cleanup alongside the existing
command and native-tool negative controls. This is a controller/worker foundation: production host availability and
Windows resource/controller-directory integration are still absent. It does not enable Windows coding or prove
Windows SDK native-tool rejection; those require their own native tests before any product gate changes.

The real bundled runtime tests demonstrate two unresolved boundaries:

- The SDK sandbox's path-based denied paths block direct and symbolic-link access but do not block a pre-existing hardlink alias. Native file tools and sandboxed shell commands can read a disposable protected canary through such an alias. `test/integration/coding-native-runtime.test.ts` and `test/integration/sdk-sandbox-protection.test.ts` preserve diagnostic reproductions; the host gate is tested independently.
- With client-level `gitHubToken`, a native shell can inherit a synthetic authentication token. SDK environment masking hid it in the child's environment in a Linux test, but the synthetic token remained accessible through `/proc/1/environ` inside the sandbox. No real credential is used in these tests.

A separate tokenless runtime now passes GitHub credentials only as session configuration. An offline Linux test with synthetic session and provider credentials found neither in accessible process environments or the runtime's persisted files. This is not credential isolation: another Linux probe showed a sandboxed shell could open `/proc/1/mem` in a whole-runtime namespace. Runtime memory, IPC, logs, live GitHub authentication and supported Windows/macOS paths remain unverified. Keep the gate closed until a separate credential boundary has been demonstrated.

Coding runtimes use distinct private directories. An ordinary close removes its directory only after the SDK confirms runtime stop. A failed stop, a stop in progress, or an unknown directory left by a prior process blocks new coding runtimes; no unknown directory is automatically deleted. A parent PID or the SDK runtime PID alone cannot prove that all tool descendants have exited, so safe recovery after a crash still needs process-tree or stronger isolation evidence.

Before enabling coding, establish and verify a boundary for the entire runtime, all native tools and their descendants that protects Ember's private files against aliases and separates credentials from tool processes. A copied workspace alone is insufficient if native tools can still access the host filesystem. An isolated workspace also needs conflict-safe change reconciliation, usable toolchains and explicit network behavior. Validate native platform support on Linux, Windows and macOS rather than treating SDK capability flags as proof of enforcement.

Coding-to-desktop handoff now has a conservative completion witness: the coding model must call `finish_coding` alone with an explicit outcome, and no failed, denied, concurrent, unknown shell exit or subsequent operation may be observed. This is a model attestation plus SDK execution signals, not proof that the code is correct. Offline real-runtime tests exercise the boundary, but the full coding-to-desktop flow remains gated and needs real-provider and native-desktop verification. The first task's summary is passed to the second only as quoted untrusted data; the original user words and Stop state remain separate. Assisted recommendations and provider fallback need real supported-provider validation.

The repository pins SDK 1.0.21 (runtime 1.0.97). An isolated check of SDK 1.0.34 found changed custom-tool admission, message behavior, extension security test failures, and native dependency/type changes. Do not update the pin without resolving these and testing packaged builds and supported platforms.

## Linux isolation experiment

`coding-snapshot.ts` and `experimental-isolated-runtime.ts` are standalone experiments and are not connected to the product coding path. On Linux x64 the snapshot rejects links, protected paths, special files, bind-mount crossings and oversized input; it copies ordinary files to new inodes. The test-only runtime copies a small fixed toolchain and the runtime binaries into a separate root, starts the whole runtime in Bubblewrap with no inherited environment, uses a synthetic `/proc/self/exe`, and defaults to a separate network namespace. Only an explicit test setting shares host networking for a local mock with the literal fake key `test`. The experimental seccomp filter denies ptrace, process-vm, pidfd and several related syscalls on x86-64.

Offline real-runtime tests cover native file and shell operations, an unmounted host canary, an inherited fake environment variable, and denial of selected syscalls. These are not proof of a complete boundary: the syscall filter is a blacklist, system asset validation and same-user races need further review, and the test-only shared network can reach host services. Without the filter, a child could read its runtime parent's memory even with no real procfs. Never pass real credentials into this experiment. It has no safe change reconciliation, does not establish GitHub authentication or general toolchain/network compatibility, and has not been validated on RHEL 8, Windows or macOS. The coding gate remains closed.
