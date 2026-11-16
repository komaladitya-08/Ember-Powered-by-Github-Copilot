# Host-only root command lifecycle foundation

This is an additive, disabled foundation atop creator-owner proof `49600efcec35ba644b98c9b0a25576c6dfc9c670`.
Its test-only historical fixture retains the two unchanged public Copy/Stop blobs from `f597a127153acf1936f19c4543a89a2978892703`.
It provides no command grammar, Node asset, source grant, product capability, model tool or IPC message. The existing
`launchRootOnly` and Stop APIs retain their successful native call sequences. The experimental source verifiers and
their runtime pins remain unchanged and must refuse this changed checkout.

`launchRootOnlyWithContext` gives a trusted synchronous process creator a private launch-context capability. The
host-only directory accessor checks current admission and expires when that callback returns or throws; observed
authority loss also retires that exact pending launch and Stop owner. Catching the refusal cannot revive that launch;
an expired or foreign context cannot retire a later generation. The capability exposes no tree or native handle. A caller which receives the
directory can retain that string; expiry prevents later capability reads and is not revocation of already-read data.

The resulting run reference belongs to that exact copy and grant generation. `completeRootOnly` observes the same
held process handle before Stop closes it. The optional observer uses nonblocking waits, a 10 ms polling delay and
immediate abort/Stop wakeup; it never occupies the copy's exclusive queue. Only a signalled process permits the lazy
`GetExitCodeProcess` query. Its unsigned DWORD, including a genuine exit `259`, remains distinct from cancellation
or termination. No process is opened by PID, and successful Stop does not supply an inferred exit code.

A completed reference is issued only after the original genuine root/job Stop receipt and completed package-grant
revocation for that generation. Its immutable facts distinguish natural exit, cancellation and termination; only
natural exit carries an exit code. It is observational metadata, not file, source, publication or launch authority.
It does not prove profile deletion, toolchain cleanup, output-pipe closure, code correctness or useful Node execution.
Those owners and proofs still belong to a future bounded command backend.

An abort affects only its exact live generation; observing an old generation cannot stop newer work. File/review
quiescence and close remain serialised by the existing queue. Reentrant completion inside that queue is refused.
Unknown wait, query, Stop, revoke or close completion permanently retains the native ownership boundary, including
after public diagnostic fence fields are cleared. A known closed generation may return its stopped metadata after
ordinary close, but no failed shared boundary can issue a later completed observation.

Portable composed tests use real coordinator and Stop owners with fixed fake DLL/file boundaries. They exercise
held handles, natural/nonzero exits, Stop and abort races, pending revocation, exact-generation references and first
failure retention. These tests are not Windows enforcement or end-to-end product evidence. The product remains
files-only until the independent native prerequisites and actual complete command journeys pass.

After rebasing onto the parent proof above, local verification passed all 1,702 portable cases across 22 suites,
with zero skips. These include the parent's metadata/snapshot cases, old launch/Stop contracts, and actual
profile/native-tree/Stop compositions covering natural nonzero exit, cancellation and uncertain owner normalisation.
The exact-final semantic TypeScript check, scoped lint and diff checks passed. No native test,
product enablement, publication or runtime-pin update has been performed for this foundation.
