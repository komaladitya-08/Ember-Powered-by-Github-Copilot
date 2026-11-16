# Continue from a coding result

Open a coding review in Home, choose Continue from this result, and type a new request. Sending it goes through the
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

The genuine Electron journey passes again in 19.64 seconds with the normal sandbox after that repair: the first session repairs a failing
Node check; the actual continuation form starts a second controller whose first check already passes, then renames
the test and passes again. Four native approval cards, cumulative baseline/proposed review, selective Forget of both
results, history/export retention, main global erasure and normal exit are verified. Only the model and native picker
selections are fixtures. This supplies no live-provider, Windows runtime or physical laptop acceptance claim.
