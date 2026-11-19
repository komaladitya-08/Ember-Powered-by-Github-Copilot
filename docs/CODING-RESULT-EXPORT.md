# Isolated coding review exports

The Linux isolation experiment can now stop its runtime, capture its completed workspace and export a review without
writing to the original project. This is an offline experiment, not the enabled product coding path or an automatic
apply facility. The coding gate remains closed.

`ExperimentalIsolatedRuntime.exportReview(privateExportFolder)` produces a private directory containing
`review.json` and `changes.patch`. Call it after the current request finishes. Export stops the runtime before
reading its completed workspace, so that instance accepts no further requests. A successful export removes its
runtime copies; a failed export keeps the original disposable result available for diagnosis or a retry.
An external `close()` waits for any export and its readers/cleanup to settle. If that explicit close was requested,
it then discards a failed result too. The export's own cleanup uses a separate shared promise, so it cannot deadlock
by waiting for its public-close waiter. A committed artifact's path remains available with `cleanup: "retained"` if
temporary-file cleanup fails afterwards.

The JSON document retains every captured baseline, proposed and current file as base64 bytes with its SHA-256 hash,
along with directory entries, changes, conflict reasons and patch omissions. The baseline bytes are captured before
the runtime starts and never mounted into its namespace. Current-source capture failure is explicit: `current` is
null, proposed changes are conflicts and no text hunks are presented as ready. Nothing is silently treated as an
unchanged or empty original. All retained content is untrusted project data.

The text patch covers ordinary UTF-8 files, additions, edits, deletions, empty files and executable-bit changes.
Missing final newlines are preserved. Binary/non-printing content, directory/type changes and filenames outside the
supported patch syntax remain explicit JSON entries. A conflict's original, current and proposed bytes remain in
JSON and its hunk is left out of the patch. `patchComplete` distinguishes a complete supported patch from a partial
one. No code in this export path applies the patch.

## Namespace shutdown receipt

Bubblewrap writes its host namespace-init PID and namespace identifiers to a private `--info-fd` file. Before accepting
requests, the host validates that receipt against `/proc`: namespace PID 1, PID start time, and PID/mount namespace
identities must match. Additional IPC, network and UTS identifiers, when present, are checked too. The info and seccomp
file descriptors are consumed by Bubblewrap; a real native-shell regression verifies that neither descriptor reaches
the tool process.

After the SDK stops, the original namespace init must be absent, or be the same start-time process in the terminal
zombie state with no live mount-namespace association. A reused PID, changed namespace, unreadable state or live init
refuses export and retains the copies. The zombie case matters in containers whose PID 1 does not reap orphaned
children: Linux has already terminated a PID namespace's descendants before its init reaches that state. A real
regression starts a background writer, observes it changing a file, then verifies the init and descendant have exited
before capturing the result. An SDK idle event or successful stop return alone is not this receipt.

After that receipt, the existing Linux snapshotter validates the entire result through open directory handles and
mount IDs: no symbolic links, hardlinks, special files, mount crossings, unsupported names or exceeded bounds are
accepted. Even unchanged entries are visited. Captured copies use fresh inodes. Empty directories are now part of the
snapshot manifest. The selected original is read only for the current comparison; it is never written.

## Portable layer and remaining boundaries

`createCodingReviewExport()` is a synchronous, portable formatter over host-captured byte manifests. It performs no
filesystem access and certifies no process or filesystem boundary. It validates the account/session/snapshot binding,
entry types, names, case aliases across all trees, parent relationships and byte/output bounds. It does not accept a
caller-supplied `stopped: true` as evidence of anything.

The portable format represents content, entry type, empty directories and executable bits. Ownership, ACLs, other
permission bits, timestamps, extended attributes and inode-only replacement are explicitly outside that format. A
comparison is a point-in-time observation, not an exclusion of writers or an authorization for automatic apply.
The original and copied baseline can contain changes made between independent reads; the snapshotter detects changes
it observes but does not create a transactional source snapshot. Other hostile processes running as the host user,
privileged mutation and races in the experiment's trusted asset setup remain outside the experiment's guarantees.

The filesystem and stop-receipt implementations currently require Linux. Windows needs a corresponding verified
process-tree boundary, handle-relative traversal with reparse/mount checks, and a protected capture/export lifecycle;
macOS needs its own equivalents. Those are OS-level software boundaries and can be exercised on suitable CI runners.
They are separate from physical-laptop checks such as focus, cursor takeover, mixed DPI and real audio.

The experiment's fixed toolchain, credential/broker framing boundaries, supported-provider compatibility, crash
recovery and production integration still require their own verification. This export facility does not enable
native coding, prove a complete sandbox, or satisfy the automatic-copy-back design in
[CODING-COPYBACK-DESIGN.md](CODING-COPYBACK-DESIGN.md).

The optional bounded host RPC helper is described in [CODING-RPC-FRAMING.md](CODING-RPC-FRAMING.md). Its real transport
and no-network host-broker regression is separate from the portable formatter and filesystem shutdown tests.
