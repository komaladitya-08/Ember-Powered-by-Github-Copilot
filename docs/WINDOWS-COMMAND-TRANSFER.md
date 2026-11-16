# Canonical stopped-command transfer

This is a host-only ownership foundation on product `a970a98388d8f8df3e805a518c498571cb37335b`.
The existing Windows adapter remains files-only. This change registers no Windows command tool or backend,
writes nothing back to the original source project, and grants no network, installation, executable, shell or model-selected path authority.
It does not establish actual Windows enforcement or Node compatibility.

The prerequisite projection contains six runtime modules, twelve preservation units and four fixtures from
`1fe1a9683f012192199052a8b9a974e493481992`; the command native implementation also matches
`49600efcec35ba644b98c9b0a25576c6dfc9c670` exactly. It adds reviewed output `41a365fd05189cc24df68ac1a58cd1245b1bcb74` and correction
`e9deced4e3538549d85a6501aa3b5f5206bf0d2d` as separate deltas. It does not merge the sixteen
experimental commits. Historical runtime verifiers, source pins and issuers remain unchanged.

## Host sequence

1. Keep the existing `WindowsCodingCopy`, `WindowsScopedCodingFiles`, signal and original review authority.
   `captureCommandInput()` captures and privacy-scans the entire bounded private tree and reserves that content
   revision against ordinary file leases. The opaque input contains no public bytes or filesystem handles.
2. `WindowsRootOnlyCommandCopy.createFromInput(input, hostOptions)` consumes the genuine input once.
   Its host options contain only the actual sealed fresh creator profile, matching package SID and profile-current
   callback. Source, parent, protected paths, entries, limits, privacy scope and work/publication callbacks derive
   from the input. This path uses the fixed native and Stop factories; structural dependency injection is refused.
3. Launch through `launchRootOnlyWithOutput` and the real output owner. Host image/token/toolchain and exact
   command policy remain separate prerequisites. The output factory and Stop owner must agree on the actual PI,
   profile, context and handles before Resume.
4. Await genuine same-run Stop and revoke via `completeRootOnly`, then genuine output closure via
   `closeOutputAfterStopped`. The latter requires both EOFs, every pending native operation settled and every
   owned output close positive. Native closure can be genuine while cancelled/overflowed output remains incomplete.
5. The exact command owner calls `captureStoppedSnapshot(run, completed, closedOutput)`. Only the latest run
   of a canonical-input owner can issue this reference. It seals further generations, scans the full native snapshot,
   closes the scanner and positively retires its native tree before issuing detached snapshot ownership.
6. `canonical.acceptStoppedCommand(snapshot)` synchronously consumes that snapshot into one private adoption.
   The receiver, original input and content revision must match. Forged, foreign, validating, stale and used references
   cannot move bytes. Metadata observation exposes only bounded outcome facts and the opaque input reference.
7. `canonical.applyStoppedCommand(adoption)` validates and rescans the complete snapshot, materializes a fresh
   private root, verifies full contents and exact entries, retires the old root, then synchronously commits the new root.
   The same canonical object and existing broker continue to represent the workspace.

The full snapshot replaces the tree, including deletions and empty directories. It is not an overlay. Every path,
parent directory, folded alias, exclusion, kind and size must be valid; executable entries and secret paths/content
are refused. Fresh file creation handles close positively before the complete readback walk. No caller-provided
entry list, callback result or stopped boolean can issue transfer authority.

## Revisions and cancellation

The private content revision advances after every positively applied broker replace, delete or mkdir, before a
subsequent cancellation check can throw. Reads do not advance it. Root adoption advances it once. The file-lease
epoch is a separate invalidator and does not stand in for content identity.

Normal adoption requires natural completion and complete output. A known nonzero exit may contribute private
working-tree changes; its failed-check/repair accounting remains the command controller's obligation. Adoption
never reports command success or grants approval.

Before old-root retirement starts, cancellation preserves the old canonical root and the one consumed adoption.
After permanent task retirement, `applyStoppedCommandForReview` can resume it only under the original live
account/project/privacy publication authority and trusted controller-closed attestation. It does not replace or reset
the signal, reopen the broker, restore execution, or revive account authority.

All admission and staging checks finish before the first old-root deletion. Once that irreversible cleanup starts,
the owner completes only its known native cleanup. Final positive old-root removal/close and root/revision commit
share one synchronous segment. Stop during that interval stays permanently latched; the newly owned root remains
private and publication still requires its separate authority. There is no fallible task-current callback after old-root
retirement and before ownership commit.

## Disposal and uncertainty

Wrong-order canonical close requests Stop but refuses canonical native cleanup until the genuine input producer
has closed positively. The host can await Stop/output/producer settlement and retry close. An unused canonical
input is erased by its owner. An issued but unclaimed stopped snapshot is erased only through the exact canonical
cleanup receiver after positive producer closure; revoked publication does not prevent erasure. Moved buffers
belong to the canonical adoption and are erased on commit or known disposal.

Unknown native, output or privacy shutdown retains its actual ownership and closes further admissions. It issues
no usable snapshot or cleanup receipt, retries no ambiguous close and performs no later native operation behind
that failure fence. A failed root retirement never reports a successful canonical commit. Borrowed creator-profile
lifetime and assets remain the host's separate obligations.

## Validation scope

Portable tests exercise the actual canonical, input, profile, native tree, Stop, completion and output issuers over
fixed low-level file/DLL models. Those models do not establish Windows ACL, sharing, child-process or toolchain
behavior. The new coverage includes real same-owner composition, complete deletion, empty directories, existing
broker continuity, source/baseline preservation, foreign/stale/used references, concurrent application, cancellation
on both sides of retirement, controller-gated review, complete late-content scanning, explicit byte erasure and
unknown shutdown retention.

The final affected gate passed **55/55 tests in four suites, zero skips**, using
`npx vitest run test/unit/windows-coding-command-adoption.test.ts test/unit/windows-coding-command-input.test.ts test/unit/windows-command-transfer-producer.test.ts test/unit/windows-coding-sealed-copy.test.ts --maxWorkers=1 --no-file-parallelism`.
The Linux framework bound remained the repository default **5 seconds per case**; no timeout override or product
Stop deadline changed. Final scoped lint and diff checks passed. Independent source review closed after the
admission, first-create, privacy-error and detached-disposal corrections.

An earlier broader gate passed 1,197 cases and failed two across 27 suites. One existing sealed-tree case timed out
at its original 5-second bound. The second exposed a transfer-only COM fixture that incorrectly treated a new
profile-path allocation as an already freed allocation on a second launch. The final affected gate includes both
cases at the original bounds, with distinct allocation/free assertions. The broader gate preceded the final local
review corrections; it is not represented as a passing final 27-suite gate. An interrupted run during a source
correction has no counted result. The twelve projected preservation suites had separately passed 856/856 before
transfer changes; upstream corrected output validation remains recorded in its own foundation document.

The final full-tree check `node node_modules/typescript/bin/tsc --noEmit` passed with exit 0. All 1,482 captured
source/configuration inputs matched before and after the check (catalog SHA-256
`68a10e575fd2478c9984e1fb654ceb2d9f46583b96397dabf4bba9fae88f52ae`). The initial full check found two
unit-only missing type annotations; their correction produces byte-identical executable JavaScript and passed
scoped lint. After Type capture, two new fixtures had only surplus final blank lines removed; their emitted JavaScript
also remained byte-identical, and the complete final diff check passed. No production runtime or assertion changed
after the final 55-case behavioral gate. Root and independent actual-source reviews closed clean. No TSX component changed.

No native Windows execution, source writeback, provider credentials, backend enablement, publication or main merge
was performed by this transfer work.
