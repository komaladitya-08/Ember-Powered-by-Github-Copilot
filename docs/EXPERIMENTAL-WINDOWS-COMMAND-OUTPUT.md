# Fixed LPAC command-output API witness

This is a separate first native witness for the disabled production output owner, based on output foundation
`41a365fd` plus the reviewed sealed-profile environment prerequisite `e9deced4`. It uses an independently built fixed C image, a new build issuer
`ember-root-only-output-observed-build-v1` and run issuer `ember-root-only-output-run-v1`. No original runtime
verifier, source pin, ordinary-host mode or product capability is changed.

One emitted CJS graph contains the actual fresh profile, Native work tree, Copy, root-only Stop, exit observation
and output factories. The harness uses their real default Koffi implementations. Before Resume it verifies the
exact staged C image/PID and fresh zero-capability LPAC token, while the production lifecycle authenticates its
returned PI, creator witness and private output match. Only the actual returned Stop promise is observed: its
opaque receipt must authenticate against the exact binding before a private observation flag changes. No callback
claims that a process stopped. Overflow and cancellation must have produced that genuine receipt before the
harness invokes completion; no explicit Stop rescue can turn either case into success.

The C source accepts only three fixed modes. Every mode reads the copied fixed seed and requires zero-byte stdin
EOF, writes distinct constant stdout/stderr readiness frames, then remains live long enough for a held-root native
observation. Natural output spans multiple reads, creates one known file without rename/replacement, and exits 17.
Its genuine natural completion and complete output receipt must preserve that nonzero status and exact byte frames.
Overflow writes a fixed amount beyond the shared 256 KiB limit; cancellation waits after readiness until the host's
fixed AbortController is triggered. Both must stop automatically and produce authenticated incomplete output with
the appropriate finite reason. A child close uncertainty waits for termination and cannot certify further progress.

Each case uses a fresh sealed profile and separate synthetic tree outside the framework's recursively removed temp
directory. Genuine Stop/revoke and output EOF/drain/positive-close precede snapshot checks. The seed remains exact;
only the natural case may contain the fixed created file. Copy close, every file/directory pin close, native output
allocation release and real profile close must succeed before exact known scratch paths are removed. Any uncertain
operation permanently retains the whole graph and blocks later cases. Only completed finite facts after full known
cleanup are logged; raw bytes, error messages, private paths and reports are never published.

The producer captures exact source bytes and compiler inputs before bundling, reconciles every actual consumed
module, fixes MSVC arguments and verifies its new same-worker branded PE/module receipt. The separate run verifier
pins every bundled runtime input plus its public harness/recipe/workflow dependencies. These hashes identify a
reviewed trusted hosted checkout; they do not authenticate a publisher or establish exclusion against a hostile
same-user writer. Historical verifiers continue to refuse the changed lifecycle.

The workflow registers portable contracts on the fixed branch. Native execution requires explicit dispatch on
that branch and separate fresh Windows Server 2022/2025 jobs, with no automatic retry of a failed native boundary.
There is no actual native success receipt yet. TypeScript, native execution and publication require Root review.

The exact scoped portable batch passed 201 cases across four suites with zero skips: 99 output-owner cases,
73 producer/build cases, 19 fixed-frame/Stop/authentication/admission cases and 10 exact-source/unknown-close cases.
Scoped lint, whitespace checks and workflow YAML/activation/permissions/matrix/no-upload checks passed. The new
22-export emitted graph's portable test verifies genuine output quarantine, retained allocations and refusal of
forged Stop/completion/closure claims. These tests execute no C compiler or Windows payload and provide no native
success evidence. Exact semantic verification and independent Root review remain pending.

This witness deliberately avoids the independent open-target replacement blocker (#241). It cannot establish a
replacement repair, stopped snapshot transfer into product state, repair/rerun/review/export/Forget journey, desktop
behavior or Windows 10/11 compatibility. Source-built Node 22.23.5 and the explicit preserved-loader invocation from
#245 (`08594084415ff80d29607c411c9fa5f6380b39fd`) remain separate toolchain prerequisites. No Node image is downloaded or
admitted by this first C-only witness. Keep Windows product commands disabled.
