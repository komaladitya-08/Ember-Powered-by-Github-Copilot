# Direct Node execution in a coding copy

`run_node({ argv, cwd?, timeoutSeconds?, why })` runs the workspace's host-selected Node executable. `argv` contains
only the arguments after that executable; for example, `["--test", "test.cjs"]`. Argument order, empty strings,
spaces and shell punctuation remain literal. The tool accepts at most 256 arguments and 8,000 UTF-8 bytes including
argument terminators, rejects NUL and invalid Unicode, and copies arguments before any wait. The existing folder
resolution and 1–900 second tool timeout rules apply. `why` is model-supplied explanation, never permission.

Availability comes from the captured workspace capability. A shell-capable controller can offer both execution
tools; a Node-only controller offers `run_node` with no shell tool or shell callback. Neither-capability and forged
files-only configurations fail before runtime startup. `run_command` retains its shell behavior; commands, npm
invocations and other CLIs are never rewritten into direct Node requests.

Both tools share the original request context, consent, refusals, taint, policy modes, approval waits, audit,
command window, redaction, Stop and completion accounting. Node arguments enter the existing native argument,
path and script checks without a top-level shell parser or invented `ShellId`. Downloaded-code secret arguments
and recorded wrapper payloads retain the conservative secret/refusal checks, including output withholding.

Node approvals bind a separate versioned hash of the exact target, resolved folder and argument array. The command
window independently validates that identity and displays every argument before Allow; its header says Node.
In-memory refusal matching also recognizes the same single native Node invocation across the two tools, solely to
prevent retrying a denied action. Approval and observed-check identities remain separate across execution types:
a successful shell command cannot clear a failed Node check. No raw argument array is added to the audit or journal.

The Linux backend uses fixed `/usr/bin/node` from the existing validated, read-only toolchain. Both execution types
share the same credential rescan, exclusive workspace lease, namespace/seccomp/network boundary, admission barrier,
output limits and stopped-writer proof. Results remain proposals for review; the source project is preserved.

## Verification on 16 November 2026

- Twelve focused unit files: **1,200 passed, one existing skip**, using `--no-file-parallelism --testTimeout=15000`.
- Real Linux command-workspace integration: **21 passed, zero skips**, including literal argv, mutation isolation,
  unavailable capability, privacy/network/source isolation, descendant-writer Stop, admission revocation and lost-proof fencing.
- Real pinned-SDK scoped-worker integration: **eight passed, zero skips**. The Node-only case deliberately advertises
  empty shell facts over the unchanged real Linux backend and verifies its tool inventory and failed-check repair.
- Built, sandboxed Electron Home journey: **one passed**, with direct-Node approval/repair followed by a fresh shell
  continuation, review/export/Forget and normal exit. Only the offline model and picker selections are fixtures.
- Final application build, changed-file ESLint, diff check and full `tsc --noEmit --pretty false`: **passed**.
  An earlier TypeScript run found a missing fallback `windowsReach` fact and a test mock's `Promise<undefined>`
  inference; both were corrected before the final clean check.

The 15-second unit case bound was a **new CLI override** of Linux's five-second Vitest default, not existing Linux
configuration. The 1,200-case aggregate is not an original-default receipt. No repository deadline, product execution
limit, Stop assertion or shutdown-proof timeout was changed. An earlier intermediate eight-file run without an override
recorded 1,039 passes, one existing skip and one 5,000 ms timeout in the unchanged POSIX corpus case (reported 5,114 ms).
On the final source, a separate serial run without a timeout override selected only that POSIX corpus case and the
12 direct-Node flow regressions: **13 passed, 769 unselected/skipped, zero failures**, 5.29 seconds total. This narrow
receipt does not establish that the full aggregate passes at the original five-second bound.

Native integration used `EMBER_REQUIRE_CODING_ISOLATION=1` and the production-accepted root-owned Node at
`/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node`. Electron used its normal sandbox on an owned
Xorg dummy display. These local proofs use synthetic model responses and credentials; they establish no live-provider,
physical desktop or Windows Node enforcement result. The Windows product selector remains **files-only**. No Windows
execution gate, legacy native-SDK tool gate, network access, dependency installation or automatic source application
is enabled by this change.
