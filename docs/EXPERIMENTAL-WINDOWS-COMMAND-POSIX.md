# LPAC pinned POSIX workspace witness

This is a separate fixed-C experiment from original creator-owner commit
`49600efcec35ba644b98c9b0a25576c6dfc9c670` (#241). The original C program, parser,
observer, builder, integration assertions and all app code are unchanged. The
new C program substitutes only operation 9's replacement helper, using the
user-mode SDK FileRenameInfoEx (22) and flags REPLACE_IF_EXISTS | POSIX_SEMANTICS
(3). Its source handle has DELETE | FILE_READ_ATTRIBUTES (`0x10080`), share 7,
OPEN_EXISTING and OPEN_REPARSE_POINT. One setter call is followed by one positive
source close. The immediate failure DWORD is captured before close and passed
through a fixed out parameter; the caller never queries last-error after the
helper closes its owner. Unknown ownership prevents publication. There is no
retry, MoveFileEx fallback, target-pin closure, new permission or privilege.

The ordinary-host prerequisite, #254 run `43949773571`, passed on Server 2022
and Server 2025. In each image, both unpinned A and pinned B replaced; the old B
object had links 0, DeletePending 1 and legacyDetached 1. Identity, security,
streams, source matching, root-only Stop and fixed-tree cleanup passed. That
regular-file result alone does not establish this LPAC witness or Node support.

This run reuses the original TypeScript observer and 128-byte schema-2 parser
without substitutions. The exact integration result still requires all eight
useful operations, twelve protected denials, three revoked-work denials, four
ordinary-host ACL controls and four in-run WRITE_DAC/WRITE_OWNER denials, genuine
suspended creator capture, private owner transfer, stable stopped snapshot,
writer Stop, retired-admission refusal, unchanged source, tree cleanup, profile
cleanup and emitted-CJS coverage. ACTIVE_PROCESS=1, no inherited parent handles, the
fresh top-level profile, same held metadata pins, strict inherited ACL/LOW and
all original Native.detached checks remain unchanged.

Ordinary rename-to-absent and ready-file publication retain their original
MoveFileEx calls. Removal retains the original POSIX-disposition helper. The
full useful-operation order, feature bits and report format are unchanged.
Exit 211 still means replacement preparation refused. Under the NEW compiled
issuer, exit 212 means the replacement helper refused; this can include source
open or setter refusal. The old observer's numeric replacementStage 2 is only
a pipeline label in this new issuer, not proof of a particular underlying API
failure. Any nonzero exit still refuses success; failed-report observation
still needs genuine Stop/revoke and unchanged pins. No new report can turn a
failed operation into a completed useful proof.

The producer starts from the reviewed current 246-line fixed-control builder,
including its permanent unknown-FD-close fence, captured-input reconciliation,
exact environment/tool checks and private compiler output. Its wrapper exports
exactly the original nineteen observer functions and constructors in one CJS
profile/token graph. New assets, destination prefix, compiled issuer
`ember-root-only-creator-posix-observed-build-v1` (scope 2), and run issuer
`ember-root-only-creator-posix-run-v1` distinguish the POSIX operation from old
MoveFileEx semantics even though the report body is reused. Old compiled
receipts are not admitted. The 28 runtime pins bind the actual reviewed C,
producer, original observer/parser/core, integration and workflow. The verifier
itself is intentionally not self-hashed; the fresh trusted CI checkout is its
authority. Source hashes are not publisher authentication or hostile-writer
exclusion. Fresh builds do not promise identical PE bytes.

The workflow registers the portable contracts on the exact new PR head.
Native execution requires a separate explicit manual dispatch on that exact
branch and two fresh Windows workers. A worker never fails the old proof then
resets its fence to try this variant. No private runtime scratch or report is
uploaded. An unknown owner keeps the graph retained until disposable-worker
teardown; the test does not recursively remove uncertain runtime scratch.

This is fixed root-only LPAC code, not an executable project backend. It does
not claim generic descendants, shell grammar, arbitrary Node/toolchain support,
directory replacement or consumer Windows compatibility. No Node patch or
rebuild is part of this branch. Native execution is pending.

- [Pinned SDK FILE_RENAME_INFO and flags](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h#L9140)
- [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
- [POSIX rename semantics](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)

## Local validation

The three new unit files pass 117 tests. The full 22-file original/new gate
passes 1,717 tests with no skips on Linux. It includes actual helper/useful/failed
C-body logic mocks, private build/FD-close fences and the original nineteen-export
CJS/profile/token graph. These mocks do not establish Windows ABI or LPAC
behaviour. Eighteen new C logic cases intentionally skip outside Linux; all
original skip rules remain unchanged. Scoped lint, producer syntax, YAML and all
28 runtime pins pass. Explicitly requiring the native integration on Linux
refuses before any build scratch. Exact-final `npm run typecheck` passes
(session 5021). Native execution remains pending.
