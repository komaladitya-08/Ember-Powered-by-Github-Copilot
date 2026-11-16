# Isolated command workspaces

`IsolatedCommandWorkspace` is the Linux command backend for a trusted custom-tool coding controller. The Copilot SDK,
model credentials and policy checks stay in the host. No SDK, plugin server, authentication material or host home
directory enters a command namespace. The caller must send commands through Ember's existing command policy/flow
before calling this backend; this class is not a permission decision.

Creation takes an explicitly selected source, private snapshot base, protected paths and host-created
account/session/snapshot binding. Its default copies the whole accepted project to fresh inodes and retains independent
baseline bytes before any command can run. A host may explicitly opt into `scope.excludeRoots` containing `.git`
and/or `node_modules`; the fixed disclosure from `codingProjectScopeDisclosure` must be shown before starting.
The snapshot records each omitted root's type, and every source capture/export uses the same declared scope.
The original project is never writable through this API. Known credential paths and recognised secret text in the
accepted tree cause refusal before execution; nothing is silently excluded. The same admission
check runs again before each command and before exporting its proposed result, so a preceding command cannot place a
known credential file in the copy and have another command encode it. This detection is best effort, using the shared
scoped-file credential policy; binary content and arbitrary encodings are not a complete secret detector.

Complete UTF-8 privacy checks run in a fixed, trusted worker thread using the existing `memoryRefusal` rules over
the entire accepted file, without chunk gaps or truncation. Project text is data, never worker code, a path, an
import or a process argument. The bounded worker queue, cancellation and checks after each awaited result let Stop
remain responsive while a complete 4 MiB source or 8 MiB dependency file is checked. This thread is a computation
boundary, not an OS sandbox. Ordinary task scans close on Stop; an inert partial export uses a separate short lifetime.
Global Forget retires the captured privacy generation so an old workspace cannot reopen a fresh export scanner.
The independent owner/project review capability also fences per-project Forget without stopping other projects.
An unverified worker exit blocks later work and prevents a fully-closed cleanup receipt.
Forget everything also waits for the captured trusted coding controller's disposal, including its private SDK session.
The existing five-second retirement timeout reports failure; a later retry retains only disposal witnesses for an old connection.
Terminal workspace close drops its owned baseline and cached review references after in-flight work settles; this does not erase other retained copies.

Each `run(command, cwd, onOutput, signal)` uses a new Bubblewrap user/PID/mount/network namespace with only the private
project copy and a copied minimal toolchain. The virtual root is `/work`. The namespace receives fixed non-secret
environment values, a private `/proc` and an ephemeral `/tmp`. It has no network or broad host filesystem mounts.
The exact command is executed by `/usr/bin/bash --noprofile --norc -c`; no profile, shell history, host environment or
SDK tools are loaded. A trusted stdin barrier holds the command until the host records the namespace PID1 identity.

The Linux x64 seccomp policy also denies `add_key`, `request_key` and `keyctl` with `EPERM`; the offline toolchain
needs none of these kernel key APIs. A new user or terminal session does not discard an inherited session keyring:
the [kernel's credential-copy and exec paths](https://github.com/torvalds/linux/blob/v6.12/kernel/cred.c) and
[user-namespace setup](https://github.com/torvalds/linux/blob/v6.12/kernel/user_namespace.c) retain that subscription,
while [Bubblewrap's `--new-session`](https://github.com/containers/bubblewrap/blob/v0.12.0/bwrap.xml)
creates a terminal session with `setsid()`. These denials block the key APIs without erasing inherited references
or claiming complete kernel-key metadata isolation. No readable host-key canary was demonstrated in this review.
Tests evaluate the generated BPF independently of ambient policy, then exercise raw syscalls and ordinary Node/Bash
commands in a real workspace; a surrounding container may already deny the key APIs.

The host verifies PID start time and namespace identities, then releases the barrier. On completion or Stop, it
requires that same namespace init to have exited before another operation can access files. Linux terminates its
remaining namespace descendants when PID1 exits, so a background process cannot continue writing during the next
file callback or export. An SDK event or a shell exit code alone is not the completion witness. An unknown shutdown
permanently fences commands, file callbacks, export and automatic cleanup; its private copies remain for diagnosis.

`files(operation)` is a trusted host callback, not a model tool. It provides an exclusive, quiescent lease over the
private copy. The scoped file broker independently validates paths, types and handles during that callback. Commands
and file callbacks share one queue; re-entrant operations are refused. Stop cancels queued model/file operations,
kills an active namespace and waits for the stop witness. Cancelling the signal of one `run` stops only that command,
leaving diagnostic file leases available after verified shutdown. Task-wide `stop()` permanently retires normal work.
An optional host-only `admit()` capability is checked at admission, after preflight and immediately before releasing
the command barrier; false or a thrown check permanently retires normal work. A host-owned `exportReview` remains available after a
verified Stop and can preserve partial work as inert review data. A model cannot use that method to restore execution.

The command result reports `observed: true` only after the namespace shutdown witness, or when cancellation prevented
any process from starting. This means writers have stopped, not that the requested code or its tests are correct.
Output callbacks receive bounded raw bytes and their stdout/stderr stream; the result's `output` is a derived UTF-8
view. Command size, raw output and elapsed time have explicit hard limits. Output overflow and timeouts kill the
namespace, and Stop can cancel it while output is streaming.

The toolchain initially contains bash, cat and sleep. An optional host-selected Node binary is accepted only with
verified root ownership/permissions and bounded ELF dependency metadata. A byte parser finds its interpreter and
required libraries without executing `ldd` or inspecting project executables. Assets are copied to fresh inodes;
custom loader paths, unsafe libraries and unavailable toolchains are explicit errors. Node can run ordinary scripts
and built-in `node --test` tests. npm, Git, arbitrary compilers, network installs and a general development environment
are not supplied. Accepted source remains limited to 10 MiB, 10,000 entries and 4 MiB per file; links outside declared
omissions and unsupported paths/types are refused. Review formatting/storage has its own bounded output budget.

An explicit scope can provide a separately validated dependency-folder grant. Dependencies are copied to fresh
inodes, checked for recognised credential paths/text, and mounted read-only at `/work/node_modules`; no original
dependency tree is mounted. In-root links are materialised with relative link receipts. Escaping/cyclic links,
hardlinked files, special objects, mount crossings and changes detected during copying are refused. The copy is bounded
to 128 MiB, 50,000 entries, 8 MiB per file, depth 64 and 1,000 links. This supports existing compatible installed
packages; it does not install dependencies. A project `node_modules` link outside the source is not an implicit grant.
Without a separate grant, an excluded dependency root is empty and unavailable. All omitted roots are read-only
inside commands and withheld from file tools, including the private empty mount points.

`exportReview(privateFolder)` preserves baseline/proposed/current data and conflicts using
[CODING-RESULT-EXPORT.md](CODING-RESULT-EXPORT.md)'s JSON and supported text patch. It does not apply changes to the
original. Public close waits for queued leases/export before cleanup; export uses private cleanup to avoid a
self-wait. Current-source capture failure or replacement of the accepted source inode is explicit and leaves proposed
changes marked as conflicts. Optional `review.scope` preserves the omission/dependency manifest and its disclosure.
Excluded paths and dependency trees are not automatically archived. Commands can copy or derive dependency bytes
into ordinary source outputs, which are captured/exported. The dependency digest is a receipt rather than an archive
from which that environment can be reconstructed.

The current implementation requires Linux x64 with supported Bubblewrap/user namespaces. The asset resolver includes
the common Debian and RHEL library directories, but supported packaged systems still require native verification.
Windows and macOS need their own process-tree and filesystem boundaries. This backend does not enable the legacy
native-SDK coding gate or make the experimental whole-SDK runtime a product execution path.
