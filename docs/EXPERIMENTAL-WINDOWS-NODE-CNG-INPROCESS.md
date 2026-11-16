# Fixed source Node in-process tests

This separate experiment reuses the exact authenticated CNG source artifact from draft #237. The source image,
artifact pin, extractor, stager, build receipt and original six native assertions are unchanged. In particular,
default three-pipe spawning and default `node --test` process isolation remain unresolved. No coding gate changes.

Pinned [Node 22.23.5 CLI documentation](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/doc/api/cli.md#L1180)
supports `--experimental-test-isolation=none`, added in 22.8.0. It imports test files into the runner process rather
than creating one process per file. Tests share global state and run with file concurrency one; this does not have
the semantics of default process isolation. The flag is explicit in this new fixed invocation, never inserted into
an existing approved command or used to reinterpret an npm script.

The issuer is `ember-experimental-source-node-cng-inprocess`, distinct from official OpenJS authority, the source
compiler and the artifact stager. The native harness also checks the exact existing compile commit and immutable
receipt, Node and bootstrap sizes/hashes before launch, under retained native asset pins. The original receipt
continues to describe the original source build; the new test bodies have separate role-specific runtime hashes.

An ordinary-host control must pass first using the original verified image, preserving its parent's observed token
context. A separate read-only LOW-labelled image runs under the existing zero-capability/AAP-opt-out LPAC profile.
Both use a fixed read-only `node:test` file, explicit in-process CLI, copied CommonJS module, async read and timer.
They retain suspended exact-image/token admission, clean credential-free environment, two private inherited I/O
handles and private jobs from the existing source-pair lifecycle. This fixture's job witnesses are distinct from
the stricter root-only command backend and do not establish arbitrary-code or general subprocess containment.

TAP goes to fresh private files, is never read or decoded, and is deleted with the known fixture tree. Only exact
64-byte numeric reports can describe the one fixed test. Every report read follows root/job stop and acquires a
native pin excluding writers/deletion before bounded I/O. Private stdout/stderr must be empty for success and are
never published. Full fixture/profile/handle/pin closure and removal of the fresh known scratch tree precede the
public result. Unknown stop, close, pin or deletion retains owners and blocks another invocation.

The dedicated workflow runs this new pair on Server 2022 and 2025 with the unchanged authenticated artifact loader.
It does not rebuild Node, run the old six assertions with changed flags, upload TAP or enable product commands.
The complete 17-file portable gate passed 716 tests with zero skips. The new 43 cases include actual Node CLI
success/failure/collision controls, report bounds and composed stop/pin/read/close/deletion faults; the final 14-case
lifecycle rerun also passed after adding failure-buffer erasure assertions. Scoped lint, JavaScript syntax, YAML,
action/matrix/permission checks and final TypeScript passed. Root and independent reviews closed. One earlier full
batch recorded 715 passes and an unchanged source-fixture subprocess returning null status under its existing
five-second bound; the complete affected 52-case suite passed alone, then the full 716 passed with no assertion or
deadline change. An explicitly required Linux invocation failed before native binding, as intended.

Actual Windows verification remains pending. Even successful fixed tests would only advance feasibility:
product work still needs root-only command ownership, canaries, bounded execution/output, stopped-tree transfer,
policy and controller integration, review/erasure and real provider/native desktop acceptance.
