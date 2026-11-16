# Separate Node POSIX replacement producer

This branch starts from the exact authenticated producer compile commit
`df3d273dc1028f2358a119db0719b4cf2cb471f9`. Its signed upstream source remains
Node 22.23.5, commit `60553651579ec33ca1aef9e1eedab2c3855f1f7e`, from the same
SHA-pinned archive and verified release-signature provenance. Existing producer,
source pins, three patches, bootstrap, artifacts, official verifier and product
manifests are untouched. Every new producer entry point is a sibling with issuer
`ember-experimental-source-node-cng-pipes-posix-feasibility`.

The prerequisite fixed LPAC witness (#256) passed all three jobs in run
`43956921968`, at `8c893a5291c9172aae02fde56b2973e689d19aed`. Both hosted images
established all eight useful operations, twelve protected denials, three revoked
work denials, four host ACL controls, four in-run ACL denials, genuine Stop,
stable snapshot, unchanged source, private owner verification, tree and profile
cleanup. That fixed-C result justifies a regular-file Node experiment; it does
not establish the new Node image or generic project compatibility.

## Fourth source change

The original three changes remain byte-identical: the fixed offline Winsock
initialisation guard, the OpenSSL rand_win.c translation-unit CNG selector, and
the exact upstream libuv LOCAL pipe-name backport. The fourth and only new
upstream file is `deps/uv/src/win/fs.c`. Its original 105,366 bytes have SHA-256
`60c76976514f427fa0be21c1c7986c2ab1d9e2e77b9d5bcf8c7ab99ed36b0693`.
The working file is 108,216 bytes, SHA-256
`51e2bb1d68f13a2537918e7a945ae7f3b398471c61012ce7b8e035efea1ae22f`.
No other libuv function, Node binding, GYP target or header is changed.

`fs__rename` uses one SetFileInformationByHandle call with user-mode
FileRenameInfoEx 22 and flags REPLACE_IF_EXISTS | POSIX_SEMANTICS (3). A source
opens with DELETE | FILE_READ_ATTRIBUTES (`0x10080`), share 7, OPEN_EXISTING and
OPEN_REPARSE_POINT. There is one close attempt and no MoveFileEx/Nt fallback,
retry, readonly override, privilege or directory override. Genuine source or
setter errors are captured before close/free; an earlier setter error keeps
priority over close failure. Close failure cannot produce success. A failed
BOOL with error 0 becomes explicit EIO/ERROR_GEN_FAILURE, never success.
Allocator and UTF-16 bounds fail before native work where applicable.

The original request lifecycle, UTF-16 capture, sync/async dispatch and existing
nonzero Win32-to-libuv error mapping are unchanged. Captured paths are copied
without additional resolution or normalisation. Relative source-subdirectory
and target-subdirectory literals are covered by actual-body tests. RootDirectory
is NULL, as permitted for paths relative to the process CWD. Directory rename
is unsupported by this experiment; a source-open access error remains its real
error and is never guessed to mean a directory. Existing libuv mapping can map
ERROR_INVALID_FUNCTION to EISDIR; the adapter does not invent a fallback or
reinterpret that native code. A regular-file proof does not claim broad Node
rename equivalence, cross-volume, readonly, symlink or directory support.

The handles belong to the untrusted Node process. A failed close is not retried
or converted into host cleanup authority. The parent job deadline and genuine
process Stop remain the boundary before private output or tree ownership is
accepted. The new producer enables no project backend or tool.

## Mandatory ABI gate and provenance

Libuv's actual GYP target defines `_WIN32_WINNT=0x0602`. The patch does not raise
that target, NTDDI_VERSION or any header selector. A private DWORD/HANDLE/DWORD/
WCHAR layout uses static x64 size/offset assertions. Before vcbuild, the producer
must compile the **actual pinned adapter block** twice: once with the original
Win8 selectors and once with Win10RS1 selectors against SDK 10.0.26100.0. The
latter compares the private layout, enum and flags to the SDK declarations. Both
are `/c` only; neither probe is linked or executed. Objects must be fresh,
bounded x64 COFF. The new receipt requires both target records and hashes of the
actual adapter, ABI fixture and object outputs. Old three-patch or missing-ABI
receipts are refused. Default Node feature/build arguments and trusted toolchain
selection remain unchanged.

The strict extractor allowlist is exactly four ordered paths. Signed stock
counts, bytes and manifest stay unchanged: 29,212 files, 3,399 directories and
554,315,497 bytes. The new working inventory has 554,320,064 bytes and manifest
`57f2e7be04d3f238af4bc97b660d68f42638db81ed3265e86a4f2c3a115de4d8`.
The full source catalog and content are checked before and after compilation;
generated outputs are not original-source authority. Source/preparer/build/ABI
recipe inputs are hashed. Tools are observed under trusted hosted-image
authority; source hashes and receipts are not standalone publisher signatures or
exclusion of hostile concurrent same-user writers.

The new workflow registers portable contracts on the dedicated PR branch.
Dispatch now defaults to the fixed `abi-only` scope. It performs the same attested
source/tool preparation and both mandatory ABI compilations, then returns before
vcbuild, bootstrap compilation, asset staging or upload. A long Windows build
requires an explicit reviewed `source-build` dispatch on that exact branch after
portable success; that route still requires both ABI successes and COFF checks. The ABI gate is mandatory inside the builder
before vcbuild; it cannot be waived by workflow inputs. Existing 60-minute
compiler, 70-minute build-step and 90-minute job budgets are unchanged. Only
source-node.exe, bootstrap.exe, build-receipt.json and LICENSE can be uploaded
under the new artifact-container name. No runtime integration, private reports,
paths, dumps or traces are uploaded. Old artifacts and the existing manifest
remain unchanged until a separately reviewed new image is authenticated.

## Current validation

Full signed-archive extraction and validation passed locally for both complete
stock and four-patch working trees. All 160 new portable contracts pass; the composed five-file old/new gate passes
278 cases with no skips,
including the actual adapter body with fixed Linux Win32/allocator mocks. Those
mocks do not establish Windows SDK ABI or kernel behaviour. Scoped lint, script
syntax, YAML and Python 3.6 AST syntax checks pass; Python 3.6 itself was not
executed. Root and independent source/C/ABI/provenance reviews are closed clean.
The normal full `npm run typecheck` passed (session `12601`). Windows dual-compile,
new Node build and native Node validation remain pending. No compatibility claim
or runtime/backend enablement is made.

Child spawning, default node --test, supported toolchain/project admission and
consumer-laptop acceptance remain separate gates. No test-isolation, module,
console, JIT or other runtime flag is added to bypass those gates.

Primary contracts used by the adapter and gate:

- [Pinned SDK FILE_RENAME_INFO and flags](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h#L9140)
- [Pinned user-mode information class](https://github.com/microsoft/win32metadata/blob/15fc870a5e96df7c560877ff30136c0fb5a21e9b/generation/WinSDK/RecompiledIdlHeaders/um/minwinbase.h#L178)
- [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
- [FILE_RENAME_INFO path forms](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
- [POSIX replacement with existing target handles](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
- [Pinned libuv source rename and target](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/uv/src/win/fs.c#L2266)

## First Windows attempt and ABI-only follow-up

The sole first source attempt was run `43968426268`, compile commit
`4d0522318b6ffdb028e06c5b5c59b43c5a3a8eaf`. Its portable job passed all
160 contracts. The completed Windows job `133654617530` refused at
`compile-rename-abi`, before vcbuild. Captured compiler output had been discarded,
so no compiler or header cause was established and no Node artifact was produced.

The first diagnostic follow-up preserved the actual rename block, both target
selectors, `/W4 /WX`, and the then-current cmd invocation. Each target now has an independent fixed
batch with phase markers before vcvars (1), before cl (2) and after successful
cl (3). Only exact ordered whole stdout lines project a phase; 0 means no such
entry was observed. Failure observations include target ordinal 1/2 (0 when
not target-specific), validated primitive DWORD child exit or null, at most eight
sorted unique numeric C diagnostic IDs, and bounded overflow/unknown-line counts.
`failurePhase` is 1 for child execution, 2 for COFF validation and 3 for copied
source/recipe readback. The first observation is immutable. These fields are
observations only: child exit 0 or phase 3 cannot substitute for positive COFF,
source, tool, recipe or asset checks. Raw lines, symbols, paths and source values
are discarded. ABI-only results have a distinct issuer suffix and no asset
receipt; they cannot admit a Node image.

Pinned source inspection confirms the fixture's request macros match fs.c, while
Node's ordinary GYP warnings differ from this stricter preflight. The original
producer passes a plain batch argument; this preflight uses doubled cmd quotes
without the verbatim-arguments option used by another repository fixture. These
are investigation leads, not observed causes. No warning suppression, quoting
repair or header change is included. The ABI-only Windows outcome remains pending. All 306 composed portable
contracts pass (188 new-producer and 118 unchanged producer cases), as do scoped
lint, script syntax, YAML and Root/independent review. TypeScript session `48709`
was lost during environment migration and is not a pass. The fresh normal full
`npm run typecheck` recapture `38371` passed on the unchanged reviewed code.

The sole ABI-only run `43971356498` at `67c1f0be79ccf838e2c87426a43a56f3efd18ab2`
completed with target 1, phase 0, child exit 1, no C diagnostic codes, overflow 0,
unknown lines 2 and failurePhase 1. Its Linux contracts passed 188/188; Windows
contracts passed 159 with 29 expected environment skips. No batch-entry marker
was observed, and no compiler cause or Node build was established.

The next narrow launcher correction retains the exact doubled-quote final batch
argument and adds `windowsVerbatimArguments: true`, matching successful fixed
repository builders. The actual executor uses a tested fixed invocation helper
with unchanged cmd switches, timeout, output bounds and private pipes. Trusted
space-containing paths are preserved; malformed and command-bearing paths
refuse. No rename, compiler warning, header selector or ABI acceptance check
changes. This corrects invocation semantics under the launcher hypothesis; the
next reviewed ABI-only outcome remains pending. The frozen launcher follow-up
passed all 321 composed contracts (203 new-producer and 118 unchanged producer
cases), scoped lint, syntax, Root/independent review and normal full
`npm run typecheck` (session `39684`).

## Actual compiler refusal and C11 probe correction

The sole corrected-launcher ABI-only run `43973801571` at
`2241f8fffb81f7f4f713ca5c2cb1ad805cec64e2` reached target 1, phase 2 and refused
with child exit 1 and compiler codes C2220/C4210 (overflow 0, unknown lines 6).
Windows contracts passed 174 with 29 expected skips. This establishes compiler
entry and a warning-as-error refusal, not either SDK target or a Node build.
Microsoft documents C4210 as the level-4 block function-declaration extension.
Pinned uv-common.h's non-C11 STATIC_ASSERT fallback declares such a function,
including inside its inline functions and this adapter. This is an evidenced
lead, without an exact compiler-line attribution.

Only the two compile-only ABI probes now explicitly select `/std:c11`, while
retaining `/W4 /WX` and both original Win8/Win10RS1 header selectors. The real
assert.h and uv-common.h remain included; the fixture requires the exact C11
version and an active real static_assert macro, then uses that assertion. No
warning is disabled. Language `c11` is mandatory in the new ABI build pin and
receipt, alongside both object proofs, adapter/source hashes and recipe.
The production Node compiler options and all four patches remain unchanged.
In particular, the stock common.gypi C11 setting is conditional on clang; this
experiment does not claim that the ordinary MSVC producer already uses C11.
Microsoft documents C11 mode as also enabling its conforming preprocessor; that
change is confined to these short compile-only probes. The next ABI-only result
remains pending. The frozen correction passed 324 composed contracts (206 new
producer and 118 unchanged producer cases), scoped lint, syntax, Root/independent
review and normal full `npm run typecheck` (session `25211`).

- [Microsoft C4210](https://learn.microsoft.com/en-us/cpp/error-messages/compiler-warnings/compiler-warning-level-4-c4210)
- [Microsoft C language modes](https://learn.microsoft.com/en-us/cpp/build/reference/std-specify-language-standard-version#c-standards-support)
