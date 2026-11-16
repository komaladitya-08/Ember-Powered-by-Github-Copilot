# Continue from a coding result

On an available continuation backend, open a coding review in Home, choose Continue from this result, and type a new request. Sending it goes through the
ordinary conductor and approval flow. Selecting the result alone runs nothing. The host captures an opaque result
reference and the selected project/folder before the request can wait; the model never chooses a result id or path.
The new request supplies its own permission words. Earlier tasks, files, retry wording and answers grant no authority.

Continuation tokens retain only opaque ids and an empty generation marker, so a retained task cannot keep a forgotten
predecessor's private preview alive. The registry resolves the live record again for every use and rejects a different
generation, including reuse of an id. In-flight reads remain inside the cleanup barrier.

The result registry reads the complete pinned review only while its account, project, epoch and original source identity
remain current. Preview text cannot seed execution. Replaced sources, forgotten results and stale queued requests are
refused. A successfully admitted new copy has its own lifetime: forgetting the predecessor then preserves that active
copy. Global Forget still revokes pending reads, waits for creation and execution cleanup, and removes private reviews.
Checkpoints retain inert project history, never continuation tokens, private files or resumed worker conversations.

Public Windows `7eabd077` availability reports `canContinue: true` after the native and real Home continuation
proofs below. The earlier two-fresh-session Windows Electron pass remains separate evidence. Commands, tests and
dependency installation remain unavailable on Windows; the legacy native-SDK gate stays false.

## Linux command workspace

`IsolatedCommandWorkspace.create` accepts an optional host-only `continuation` containing the original baseline,
prior proposed tree, declared source scope and a live admission callback. Both old trees must have the same original
binding and owner as the new task. Their portable paths, metadata, aliases, sizes and source exclusions are validated
before the first asynchronous source operation. The new baseline retains the original bytes under the new task binding.

The real chosen source is still captured and verified. The proposed tree is then written to a second fresh private
root through held directory descriptors, exclusive no-follow file creation and full hash readback. Binary files,
executable bits, empty directories and unchanged files are retained. Neither root is the original source folder.
New source omissions and a fresh validated dependency copy come from the current real source; old dependency receipts
never supply executable dependency bytes. Review compares the cumulative original baseline, new proposal and a fresh
capture of that real source.

Complete baseline and proposed privacy scans use the task's captured privacy generation before any namespace can run.
Admission is checked across asynchronous materialization and later workspace operations. Once the host accepts the
new copy it may release the predecessor dependency; the new copy then has its own task lifetime. Private proposed
clones are wiped after creation, and baseline clones are wiped on failed creation or workspace close.

Cleanup follows verified stopped writers. It uses the held private root and base identities, refuses changed ancestry
or external mounts, and unlinks symbolic links without following them. Unverified removal or close produces
`CodingSeedCleanupError`; the resource owner must retain that failure as a barrier to further coding.

Real Linux namespace tests cover two sessions, cumulative review, fresh dependencies, source preservation, credential
refusal and cleanup after predecessor revocation. The combined TypeScript, full ESLint and application build pass.
The consolidated twelve-suite gate passes 319 cases with two platform skips; the five-file native Linux gate passes
30 cases with zero skips. Host/IPC and renderer cases are included or separately verified. After the token-retention
repair, 56 registry/resource cases pass with two platform skips, and full types, build and the changed-file lint pass.

The genuine Linux Electron journey passes again in 19.64 seconds with the normal sandbox after that repair: the first session repairs a failing
Node check; the actual continuation form starts a second controller whose first check already passes, then renames
the test and passes again. Four native approval cards, cumulative baseline/proposed review, selective Forget of both
results, history/export retention, main global erasure and normal exit are verified. Only the model and native picker
selections are fixtures. This supplies no live-provider, Windows runtime or physical laptop acceptance claim.

## Windows copied-file workspace

The Windows resource captures a same-store native source boundary before `loadContinuation` reads a complete pinned
review. `WindowsCodingCopy.create` calls `prepareWindowsCodingContinuation` synchronously before its first await;
the opaque seed owns cloned baseline/proposed buffers under the new binding. Scope, owner, complete parents, Windows
names/case aliases, source exclusions, executable/dependency metadata and current smaller limits are checked before
native writes. Fixed caps are 10 MiB per tree, 4 MiB per file, 10,000 entries and 64 path components.

Both complete trees, including unchanged files, pass full-content privacy admission under the original generation.
Binary content retains the existing capture policy; a text scan cannot certify arbitrary binary contents. A native
materialiser creates only fresh owner/SYSTEM directories/files beneath the caller's held empty COPY root, checks
volume/identity/parent/one-link/reparse receipts, writes once, flushes and verifies stable readback. It never opens an
original source path, adopts an old file, changes an ACL or grants command access. The retained baseline belongs to
the new copy before formatter validation; decoded caller and proposed buffers are erased on every exit.

Rollback removes only exact ledger creations, closes children before their parents, and leaves the borrowed root to
its owner. Unverified close, removal or namespace data retires native admission and retains uncertainty. A successful
copy drops the predecessor callback and keeps its own lifetime; predecessor Forget does not erase its fresh files.
Global erasure still drains scans, creation, controller/file ownership and private reviews. Checkpoints do not retain
the seed or revive an SDK conversation. Current consent version 14 covers the copied-folder review/retention flow.

Public `7eabd077` passed [native run 43813240393](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813240393)
on Server 2022 and Server 2025: 147 portable, 30 artifact, 23 sealed-copy/review and five resource cases per server,
410 total with zero skips. Separately, `0f70a7f7` passed the two-fresh-session controller/product
[run 43812314219](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812314219), including
three native controller cases and one genuine Electron case per server. That pass supplies no continuation-UI proof.

The actual Home form and three fresh sessions at `fac7c0a3` passed
[run 43812927368](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812927368) on both
Server images: 97 portable, three native controller and one genuine Electron case per image, zero skips/failures.
Electron completed in 16.393/15.970 seconds, retaining the normal OS sandbox, sender guards and unforced exit `0`.
Continuation first read the prior `43` proposal, then produced `44` against cumulative baseline/current `41`.
Predecessor Forget preserved the independent copy; global erasure preserved only completed `42`/`44` user exports.
Public PR #223 advanced to `7eabd077` with the same production source and `canContinue: true`; its exact-head native
matrix above is green while ordinary full CI remains in progress.
No live-provider, physical Windows client, Windows command-runtime, merge or release acceptance is claimed.
