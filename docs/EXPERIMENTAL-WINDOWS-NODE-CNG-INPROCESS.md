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

The first [native run 43919095169](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43919095169)
at head `969afb42d97dee156e8217ad3af1c4519c27971d` used runtime merge
`71b5a17e448725372a3382dc4b4751b55007405e`. Both Server images passed 715 portable tests with one expected skip,
authenticated the unchanged artifact and passed the ordinary-host native test. Each LPAC root exited 1 with no
fixed report and 144 private stdout/stderr bytes. Both private jobs stopped and all known cleanup completed.
The LPAC assertion failed on both images; no in-process compatibility or failing API was established. Neither raw
output nor TAP was viewed.

An evidence-only follow-up compares stopped output with the exact pinned Node CLI test-file discovery message
against the already host-selected fixed filename, accepting only its exact UTF-8 LF/CRLF forms. It projects enum 1
for a complete match and 0 for every other representation; it returns no text or path. Pinned
[runner.js](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/internal/test_runner/runner.js#L109)
performs CLI glob discovery before importing any test, including with isolation disabled. A byte count alone does
not identify that branch. Classification occurs only after the existing stop and output-ownership checks, its input
is wiped in `finally`, and later cleanup uncertainty suppresses publication. Original arguments, test failures,
ownership rules and cleanup acceptance remain unchanged. The follow-up passed all 734 affected tests across 18 files
with zero skips, including 32 focused output/lifecycle cases, plus scoped lint, YAML and diff checks. Root independently
reviewed the actual source and pinned Node implementation. The exact-final TypeScript check passed; its second
native outcome is recorded below.

The second [native run 43921520917](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43921520917),
at exact head `5de5556dc7cb19efa09b63f5020750e479e64bb3` and runtime merge
`50578b0daa64252a2e0eaaf2ac6eb8210b4ee8ee`, passed 733 portable tests with one expected skip per image. Both
ordinary-host cases passed. Both LPAC cases still failed with exit 1, no fixed report and 144 private output bytes,
now classified as discovery enum 1. Jobs stopped and known cleanup completed. This establishes the exact CLI
could-not-find branch before test import; it does not identify the particular denied underlying operation.

The narrow routing correction passes `..\tools\<role>-cng-inprocess.test.cjs` from the existing work cwd. A host-only
builder requires the exact sibling work/tools relationship and verifies that this literal pattern resolves to the
same pinned absolute test file. Program bytes, image, copied module, permissions, zero-capability policy, ordinary
control, report/output gates and Stop/cleanup remain unchanged. The classifier compares the actual selected fixed
pattern and retains its absolute-form refusal coverage. No arbitrary user command is rewritten.

Pinned [Glob source](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/internal/fs/glob.js#L372)
routes an absolute Windows pattern through the drive root, while leading `..` visits only the parent of the current
work directory. A local real Node/public-Glob control synthetically denies metadata outside a disposable owned
tree: absolute discovery yields no match, while the relative route finds and imports the identical file. Separate
actual in-process CLI controls exercise the relative pattern. This is a routing simulation, not Windows enforcement
or proof of the next native result. The correction passed 52 focused cases and the full 749-case gate across 19 files
with zero skips, plus scoped lint, YAML and diff checks. The first focused attempt exposed a test-only wrapper dropping
the new pattern parameter; forwarding the parameter restored that coverage without changing production acceptance.
Root's actual final source, test and workflow review closed clean, and the exact-final TypeScript check passed.
The third native outcome remains pending.

Even successful fixed tests would only advance feasibility:
product work still needs root-only command ownership, canaries, bounded execution/output, stopped-tree transfer,
policy and controller integration, review/erasure and real provider/native desktop acceptance.
