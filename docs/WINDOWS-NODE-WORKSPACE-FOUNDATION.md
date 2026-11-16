# Unregistered Windows Node workspace

`WindowsNodeWorkspace` coordinates the existing canonical copied workspace, its original review/store binding,
a fresh native profile and fixed Node assets. It is not selected by the product. The existing Windows
`WindowsFileOnlyWorkspace` and platform selector remain unchanged; Linux command behavior is unchanged.
No source writeback, shell, installation, network, additional executable or model-selected host path is granted.

The host supplies the existing copied-workspace input plus `resourcesPath`, `assetsParent` and `reviewBase`.
The workspace creates the real fresh profile and fixed native asset owner itself. Callers cannot inject a profile,
asset owner, native factory, command-copy dependency or stopped receipt. `nodeAvailable` becomes true only after
these owners initialize positively, and its private-field getter is the adapter's genuine-instance check.

## Tools and logical paths

The command port supplies only `runNode(argv, cwd, output, signal)`. It captures arguments through the shared
`copyNodeArgv` bounds before any queue wait. Strings, argument boundaries, empty arguments and punctuation
are preserved. It adds no flags and does not reinterpret npm, user CLI text or shell source. The shell `run` port
always refuses. The same original-request policy, exact Node approvals, refusals, redaction and failed-check
accounting remain owned by the existing command flow and runner.

The initial execution cwd is the copied root only. `/work` and the Windows policy spelling `\work` identify that
logical root; child cwd and caller-supplied native host paths are refused. Node receives the caller's literal argv,
so callers must supply required module-loader/test-isolation flags explicitly and use suitable relative paths.
Logical `/work` file-tool paths are not silently substituted inside Node arguments.

The opt-in adapter advertises Windows facts with an empty shell inventory, no PTY or inherited PATH, and a logical
home. It does not invent a ShellId or a new RunnerFacts field. Fixed toolchain constraints are host context for
later reviewed selector/controller integration, rather than a model-controlled capability or implementation UI.

Inspection translates only logical `/work` and `\work` paths to the existing broker. Drive, UNC, device, ADS and
escaping paths receive unknown facts without host filesystem probes. The broker resolves existing Windows names
with the existing fold rule under the same exclusive lease, returns canonical actual case, and preserves exclusion,
privacy and file-parent guards for missing paths. No inspection changes argv or grants command cwd authority.

## One owned lifecycle

Files and Node runs share one outer queue. Reentrant file/run operations refuse rather than waiting on their own
lease. Each run captures a complete privacy-scanned canonical input, creates the fixed command-copy owner and
launches through the asset owner's genuine native output factory. Its automatic Copy witness attests the actual
held image/token before Resume; a caller callback cannot replace that proof.

The run then awaits genuine same-run Stop/revoke, asset/output closure, the command owner's complete stopped
snapshot and a one-shot canonical claim. Complete natural exits adopt through the existing fresh-root
materialize/readback/retire/commit protocol. Known nonzero exits may contribute repairable working-tree edits;
the observed exit code remains nonzero and the existing failed-check ledger is not reset.

Stop revokes admission and the stable lifetime signal synchronously. A constructor-captured neutral AsyncResource
requests actual command Stop outside both the outer queue and inherited canonical/command async leases. Stop
can therefore reach the live root while the outer run is waiting. A reentrant caller receives a boundary rejection
while the real private Stop/cleanup proof remains recorded and observed.

Cancelled or incomplete-output adoption stays private. Only `sealForReview`, called by the host after awaited
controller disposal, closes the sole file broker, waits the outer run and Stop proofs, and enables the original
publication guard. It can then apply the held adoption for review. It never replaces the signal, restores execution,
turns an incomplete command into a passing check, or revives a revoked account/project/privacy scope.

## No-run recovery

Cancellation can leave a complete capture without a launched command. The canonical review-only release has
two distinct genuine cases: its private untouched `ready` capture with no intake, or an exact command owner that
closed positively without ever retaining a run or issuing a snapshot. The latter uses the private producer ledger;
missing objects, caller booleans and similarly named receipts prove nothing.

Both cases require permanent execution retirement, trusted controller/broker closure, the original publication and
privacy scope, unchanged content revision, exact receiver and root checks. Untouched detached bytes are erased;
a taken input stays consumed. Reservation release changes only the lease epoch and preserves existing canonical
edits, baseline, source identity and binding for review. Live, previous-run, validating and unknown owners cannot
use this path. It creates no Stop receipt, stopped snapshot, imported entries or new execution authority.

## Closure and publication

Seal and close publish their actual cached proof before dispatching any public abort callback, so reentrant listeners
cannot start duplicate disposal. A file callback is rejected before it can await a cached seal that depends on that
callback. Close waits an already-started seal. Private cleanup rejections remain observed even when a reentrant
caller receives a different boundary rejection.

The asset owner must close positively and release its profile binding before the genuine profile is deleted/freed.
Those operations precede review artifact creation. The exact review producer and source-boundary capability are
retained before awaiting canonical copy cleanup. Only positive closure permits `cleanup: complete`; exact output
transfer and unclaimed artifact disposal follow the existing store ownership rules.

Unknown native, profile, privacy or artifact cleanup permanently fences this coordinator and retains its owners.
It does not retry an ambiguous close, issue a successful observation/publication, or continue native file operations
behind the failure fence. Captured execution and publication guards preserve genuine cleanup exceptions,
including a callback which swallows a reentrant owner failure; neither a later `true` nor ordinary cancellation
can erase the first private failure. Ordinary known cancellation remains distinct from cleanup uncertainty.

## Validation scope

The foundation projects reviewed native asset owner `5ef8b2fc88e5f9f83b941ead57bada5d7c6b64c3` and its
shared-task cancellation/cleanup correction `46fed893c4479893cdbc64a2960be42212401e3b` onto canonical transfer
`d526b644582c8cc3d234e5e045ec48ecdeae990e`. The command-copy no-run ledger is merged additively; the other
native dependency files retain the immutable source bytes. Historical proof issuers, pins and selectors are unchanged.

The final four-suite command used `npx vitest run` with the workspace, unstarted-review, coding-platform and
broker-inspect units plus `--maxWorkers=2`. It passed 38/38 cases (session 24484), with the original Linux five-second
case deadlines and no override: 16 actual default-factory coordinator cases, eight real canonical/profile/command-owner
no-run cases, ten logical adapter cases and four actual-broker cases. They cover literal argv, genuine nonzero
repair, active Stop, precreate and returned-PI cancellation, one-shot/reentrant closure, review ownership,
foreign/live/previous-run refusal and retained typed resource uncertainty.

A separate affected/preservation gate passed 1,210/1,210 cases in 23 suites (session 51377), also using
`--maxWorkers=2` and the original five-second deadlines. Its set is the 20 units changed by canonical transfer and
the two immutable asset commits, plus project-coding-backend, Windows resources and files-only workspace units.
Together the two disjoint gates passed 1,248 cases in 27 suites on the final source. This is not a full-repository
unit result. Scoped ESLint for all changed TypeScript files and whitespace checks passed. The unchanged normal
`npm run typecheck` (`tsc --noEmit`, session 48575) exited 0; all 25 frozen input hashes matched before and after it.
Only these documentation receipts changed afterwards. Actual source review closed clean on the final coordinator,
canonical/no-run, broker, default-factory composition and exact reviewed native dependency graph.

Earlier evidence remains distinct: the first coordinator gate passed eleven of thirteen cases; its precreate test
needed a genuine directory-reader observation seam, while returned-PI cancellation exposed the native correction.
The swallowed reentrant cleanup regression also failed before that correction. The first post-integration two-case
run hit the unchanged five-second deadline in the returned-PI case (session 80661); the isolated case and exact
unmodified two-case rerun passed at that same bound, before the final 38-case gate. No causal explanation for that
timeout or passing original full-repository gate is claimed.

These tests execute real workspace/profile/assets/Copy/Stop/output issuers over DLL boundary models. Only exact
synthetic asset-read buffers at the fixed complete lengths receive published hash substitutions; ordinary project
and stamp hashes remain real. The tests run neither Windows APIs nor the Node executable. No provider credential
is needed. Separate exact-source Windows enforcement and actual packaged product/controller journeys remain required
before selector enablement; the existing Windows files-only product path remains selected.
