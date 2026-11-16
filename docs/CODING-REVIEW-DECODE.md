# Complete review decoding

`decodeCodingReviewExport` in `coding-result-export.ts` converts a complete host-held `review.json` buffer into
`CodingExportInput`. The caller supplies the exact expected original owner/session/snapshot binding. The returned
baseline, proposed and optional current trees contain independent buffers; the baseline is not replaced by the proposed
result. This permits later cumulative review work without losing the original comparison point.

The decoder bounds the serialized input before parsing, requires exact UTF-8 and unambiguous JSON keys, and bounds
JSON nesting. It verifies the declared decoded sizes and aggregate budget before allocating file buffers, then checks
canonical base64 and SHA-256. Shared mutable input is refused. Portable path, alias, parent, scope, entry and byte rules
come from the existing formatter. Regenerating the review and comparing its complete semantic document also checks
changes, conflicts, patch completeness, limitations and dependency receipts; object property order is immaterial.
Malformed input produces a fixed error with no document fragments. A canceled signal retains its abort reason.

Decoding validates bytes and their declared structure. The caller must separately establish artifact provenance and
immutability, current account/project authority, the original source receipt, privacy admission and any stopped-writer
proof. A dependency receipt does not contain or authorize a dependency tree. The API neither rebinds a result to a new
session nor creates a workspace, restores permissions, writes source files or enables execution.

This is a foundation for continuing work from a previous proposed tree. Production intake, fresh inode materialization,
new-session bindings, dependency revalidation, lifecycle erasure and a user-visible continuation path are still required.
