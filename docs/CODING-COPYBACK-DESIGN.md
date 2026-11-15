# Isolated coding: proposed copy-back boundary

This is a design and test plan, not an implemented copy-back facility. The coding entry points remain unavailable.
The existing Linux snapshot is a fresh-inode copy; it is not a transactional snapshot and its current manifest does
not contain enough original-file and directory identity to authorize replacing files.

## Required behavior

The agent works only on its isolated copy. It cannot modify the original project directly. The broker compares the
baseline snapshot with the completed copy and presents additions, edits and deletions, including their paths and
content changes. A path the broker cannot read or represent safely is an explicit error, never silently omitted.
Once a safe automatic-apply implementation exists, the chosen approval mode determines whether a non-conflicting
change proceeds or asks; this design does not add a universal confirmation. A conflicting or ambiguous path
must be left untouched and surfaced to the user with the corresponding proposed change preserved separately.

## Important limitation: concurrent writers

An ordinary `stat` or hash check followed by `rename` does **not** guarantee preservation of a user's edit: another
process can write between the check and rename, or can continue writing to an already-open descriptor of the old inode
after the replacement. An advisory lock does not help if the editor does not take it. Even an exchange followed by a
post-swap check cannot safely undo the swap in the presence of further concurrent writes without a stronger contract.

Until the implementation has a boundary that excludes or coordinates **all** writers for the complete check and
commit, automatic writes and deletes cannot claim to preserve concurrent edits. A safe initial delivery is a
broker-generated, reviewable patch or export in a separate location: producing it does not modify the original
project. The user can apply it with their own tools. A future automatic-apply feature must state the actual writer
coordination contract and demonstrate it under real editor and process races; neither a quick second `stat` nor a
workspace setting should be described as a lock.

## Broker design to verify before any automatic apply

1. The host, never the model, owns a private baseline manifest bound to the selected source root, account, session and
   snapshot. Record root and directory identity and mount identity, every file's relative path, inode identity,
   type, ownership, mode, link count, size, timestamps and content digest, and empty directories. Establish explicit
   limits and reject unsupported names, links, hardlinks, special files and mount crossings. The current snapshot
   entries include paths, hashes, sizes and executable bits only; extending them is necessary but does not by itself
   solve concurrent writes.
2. After the sandbox is stopped and can no longer mutate its copy, traverse the result through opened directory
   handles with no-follow and beneath-root enforcement. Revalidate the complete result tree, including unchanged files,
   path types, bounds and mounts. Treat sandbox paths and file contents as untrusted. Do not follow links or accept a
   path derived from model text as authority to write to the host.
3. Compute an explicit change set: create, modify, delete and directory changes. Compare every relevant original
   object and parent against the baseline, including identity and digest; treat replacement, new links, added children,
   mode changes, missing files and inaccessible paths as conflicts. Preserve the original and proposed bytes for
   review without placing them in logs. A clean comparison is only a point-in-time observation, not writer exclusion.
4. If an enforceable writer-exclusion mechanism is established, stage replacements on the destination filesystem in
   private files, preserve approved metadata, flush contents and directories, and use handle-relative operations that
   reject path substitution. New files require no-replace semantics; existing files and deletions require verified
   identity at commit. Refuse any operation that cannot meet those conditions. A project with no such mechanism must
   remain patch/export-only.
5. Journal intent, preconditions, original recovery data, each completed operation and durable completion before
   discarding backups. Specify exactly when each file and containing directory is flushed. A multi-file operation is
   not atomic merely because each individual rename is atomic. Recovery must recheck the live state and retain both
   recovery and user data on conflict; it must never blindly roll back over an edit made after the crash. Expose
   partial completion and recovery locations to the user. Test quota, full disk, permission denial and interrupted
   cleanup. Journaling does not replace writer exclusion.
6. Keep authentication and other Ember-private data outside the runtime and its descendants. SDK path denials alone
   do not block pre-existing hardlink aliases, and the current client-level token is inherited by native shell
   processes. The execution boundary and credential separation require independent real-runtime tests on each
   supported OS before enabling coding.

## Minimum acceptance tests

- Edits, additions, deletions, directory additions/deletions, executable mode changes, empty files and empty directories.
- Original file edited or replaced before review; during staging; between final validation and commit; and through an
  already-open descriptor after a replacement. Each must preserve the user's edit or be excluded by a demonstrated
  writer-coordination boundary, never be silently overwritten.
- Parent-directory rename/replacement, symlink and hardlink insertion, mount/bind mount substitution, case aliases on
  case-insensitive platforms, malformed names, special files and untrusted sandbox changes during result traversal.
- Two editors and two attempted applies, queued cancellation and Stop at every stage, mode or workspace change,
  process termination at every journal/flush boundary, restart recovery, disk full and partial failure. Recovery must
  keep both versions where it cannot prove a safe outcome.
- A real SDK native file tool and shell in the same production isolation boundary, plus credential and protected-file
  canaries. Test each platform and packaged runtime; skip or refuse the feature when the necessary boundary is not
  supported. A mocked filesystem test alone cannot establish these guarantees.
