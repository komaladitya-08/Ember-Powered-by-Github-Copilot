# Fresh workspaces from prior proposed files

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

Real Linux namespace tests cover two sessions: implementation produces a proposal, a new session receives it, a Node
check fails, repair and rerun succeed, and the final review preserves the original baseline. They also prove fresh
dependency capture, source preservation, credential refusal and cleanup after predecessor revocation. Host result
selection, artifact provenance, account/project authority and continuation UI are separate integration requirements.
This primitive does not restore an SDK conversation, apply source changes or enable a Windows backend.
