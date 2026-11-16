# Ordinary-host open-target replacement control

This separate manual experiment localises an observed compatibility boundary.
The fifth creator-owner matrix, [43927686126](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43927686126),
failed `MoveFileExW(REPLACE_EXISTING)` with error 5 on both Server images after
temporary-file preparation and genuine first Stop/revoke/private readback.
The original eight-operation proof remains failed and unchanged.

The control reproduces the target open parameters using a limited test-only
FFI binder. It is **parameter-equivalent**, not original-factory composition.
The original factory always holds staged-file metadata handles; it receives no
unpin option. Original C, Node, permissions and product command gates are unchanged.

One fresh NTFS root holds A and B with identical known bytes, owner SID, full
DACL, LOW label ACL, inheritance control and attributes. The same held root and
ancestor handles apply to both cases. Each object is checked against the intended
host+SYSTEM full/package-modify ACL, not merely against the other object. Temporary
creator/security/data handles positively close for both before the comparison.
A never receives a persistent target metadata pin. Only B opens with access
`0x1e0080`, share 7, `FILE_OPEN`, options `0x200060`, relative root and object
flags `0x1040`, matching the original target pin. It remains held through Stop.

A separate verified fixed C image runs in its parent's observed ordinary host
context, with an exact private root-only job, suspended image/token checks,
ACTIVE_PROCESS_LIMIT 1 and DETACHED startup. Both temporary replacement files
finish create/write/flush/positive-close before A's rename. The program calls
only the original `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` path. There is no
POSIX variant, retry, LPAC execution or fallback. Invalid A prevents a B observation.

Natural exit zero, same-binding genuine Stop and positive held-process completion
precede report and file reads. The 64-byte schema-1 report contains preparation
bits, attempt/success bits and immediate DWORD errors only. Failed BOOL with
error zero remains an honest failure. B denial is a measured outcome, never
original-proof or product success. Unknown native, close, authority or lifecycle
outcomes permanently retain the graph; no recursive unknown cleanup runs.
Complete known cleanup closes B only after Stop and verifies postconditions.
Build attestations must return exactly undefined synchronously at every existing
checkpoint. A Promise, boolean or foreign object cannot authorise code loading,
launch, readout or cleanup; its properties and error text are never inspected.
The five fixed environment entries use case-insensitive name order in a Unicode
double-NUL block, as required by the Windows environment contract. Ambient fields
and credentials are absent.

The public build/run identities are separate from the old issuer and bind the
fixed C, recipe, graph, PE, tools and checkout inputs. Source hashes describe
reviewed trusted hosted checkout bytes; they are not publisher authentication or
a claim of exclusion against a hostile concurrent same-user writer. Windows
execution is manual-only after review; PRs run portable contracts without running
the Windows control, loading a driver, publishing raw private output or uploading artifacts.

If A succeeds and held B fails, the control supports an ordinary-host held-target
compatibility boundary in these conditions. If B succeeds, the LPAC failure needs
separate investigation. Names, file IDs and operation order necessarily differ;
neither outcome proves every cause or general runtime compatibility. A restricted
Node subset that excludes replacement would need its own explicit capability
contract and would not satisfy normal project coding. The bundled
[write-file-atomic](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/npm/node_modules/write-file-atomic/lib/index.js#L142)
uses temporary-file rename, so the exclusion affects ordinary tooling.

Primary references:

- [CreateFile share-delete](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) permits subsequent delete-access opens; it does not promise replacement semantics.
- [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile) defines the exact access, sharing and synchronous/reparse options.
- [Windows environment blocks](https://learn.microsoft.com/en-us/windows/win32/procthread/changing-environment-variables) require case-insensitive Unicode name order.
- [FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information) explicitly assigns replacement with existing handles to POSIX rename semantics.
- [Pinned Node libuv rename](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/uv/src/win/fs.c#L2266) calls MoveFileEx with REPLACE_EXISTING and no POSIX fallback. Its regular opens already use share 7.

The four affected portable suites pass 299 cases with zero skips: 85 Native
ownership/alias/deletion cases, 72 orchestration/run-identity cases, 70 decoder/C
logic cases and 72 producer/CJS cases. The 19 actual-C-body Linux mock cases
provide logic evidence only and intentionally skip on Windows. The producer's
actual emitted graph has exactly 13 exports; both run identities rehash all 23
fixed runtime inputs. Initial full TypeScript session 6234 reported five typing
errors, corrected with an explicit failure return and parameter annotations.
The exact-final full TypeScript check, session 84929, passed after those fixes
and the documented environment-order correction. Scoped lint, syntax, diff,
runtime pins and independent source reviews pass. Actual Windows execution remains pending.
