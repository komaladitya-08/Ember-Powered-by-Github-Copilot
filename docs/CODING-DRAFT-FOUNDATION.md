# Explicit saved coding drafts: host-only foundation

This foundation now backs Home's explicit **Save coding draft**, **Open**, **Forget saved draft** and
**Forget all saved drafts** actions. Consent 15 describes encrypted retention of complete captured files,
the bounded actual last request and result summary, and historical check outcomes. Starting a new request
from an imported draft may send that saved request/summary to the connected model as quoted historical data.
Opening and preparing an import start no model request, task or command.

The trusted app build embeds the fixed validation worker; no runtime/project filename or source fallback is
accepted. Only an existing certified stopped artifact receipt can be saved. No SDK session, running process,
source grant, command approval or continuation capability is serialised.

## Implemented host primitives

`CodingDraftStore.capture()` accepts an existing trusted artifact-store receipt, verifies it and reads its exact
`review.json`. It never claims a directory, accepts a stopped boolean or observes process shutdown itself. The
existing producer/registry must have established stopped writers before supplying the review. Capture begins
inside the draft store's current erasure generation, even before a ciphertext file exists.

`save(owner, snapshot, current)` accepts only that process-local branded snapshot. It keeps the full canonical
baseline, proposal, current-source comparison, binary bytes, deletions, executable bits, scope and conflicts.
It refuses oversize data rather than truncating a tree. Metadata is a versioned strict schema with a name of at
most 80 characters, advisory source label, last request and summary of at most 2,000 characters each, and up to
150 historical check outcomes. These are data, not evidence that a fresh check passed or that the saved request
authorises any new action.

`open(owner, id, current)` returns only `metadata()`, `reviewBytes()` and `close()`. Opening a saved document
does not create a task, restore a project ID or send anything to a model. The caller owns any returned byte copy;
closing releases the store's owned bytes and does not promise cryptographic erasure of other copies. `list()`
opens and validates owner-matching records to read their metadata; there is no plaintext name/path index.

`forget()` and `forgetAll()` revoke admitted operations synchronously and await their completion before deleting
exact matching files. A pending capture, encryption, decryption or worker cannot resurrect a forgotten file.
Forget works without the keyring, including files belonging to other disconnected libraries. Unrelated files
are preserved. Account/quit integration must call `close()` and await it. Unknown worker or artifact cleanup
remains a typed failure and fences further draft admission; it must not be reported as successful erasure.

## Custody and bounds

Only a random 32-byte envelope key goes through the system keyring. `basic_text`, unavailable keyrings and
missing asynchronous keyring methods refuse; the implementation never substitutes synchronous keychain calls.
The complete payload uses AES-256-GCM with a fresh key/nonce, and the format prefix and wrapped key are
authenticated. Names, source labels, context and file contents are inside the authenticated ciphertext.

There are at most eight drafts per library, including reserved pending saves, and at most 32 MiB of complete
canonical review JSON per draft. The metadata header is at most 16 KiB; the entire stored file is bounded before
allocation. These bounds are below the existing 64 MiB coding artifact limit. An entry larger than this limit
must be exported through the existing explicit review flow instead; no partial durable draft is saved.

Large encryption/decryption and file IO proceed in bounded chunks. Canonical JSON decode, SHA validation and
complete-file privacy checks run in a fixed trusted worker, at most two admitted operations, with no inherited
environment. The worker uses the existing complete-file credential path/text policy on every baseline,
proposal and current file. Whole-file UTF-8 scanning preserves matches across chunk boundaries. Binary formats
are preserved; this check does not claim to recognise arbitrary secrets inside compressed or binary files.
Thread exit is observed before results or cancellation return. No project text becomes executable code or a
worker filename. The fixed bundle must be supplied by the trusted app build, never by a project or model.

Owner library and exact credential holder must both match before any context/source is exposed. A new key for
the same service cannot read the old draft. Atomic writes, in-memory revisions, directory/file identity checks,
single-link ordinary files and post-await current fences preserve the previous ciphertext on ordinary failure.
As with the existing private stores, a privileged or unrelated same-user process is not an isolated adversary.

## Source reattachment is separate authority

`reattachCodingDraft()` provides a positive live-only data bridge when the original store-issued native source
witness is still current, a new explicit folder grant is current, and `sameSource()` positively attests the fresh
receipt. It returns continuation **data**, never permission to run. The normal fresh request, workspace intake,
account/provider/mode, privacy and stopped-writer boundaries still apply.

After process restart the native witness does not exist. The result is honestly `review-only` with
`source-identity-unknown`; the implementation never deserialises native identities, opaque source/artifact/
continuation capabilities, or treats matching path text as proof. A moved/replaced source is also review-only.

**Use saved draft with newly selected folder** is a separate explicit import. After opening a saved draft,
the user must choose a project folder again through the native picker. The host captures a fresh stopped source
review, verifies/discards its temporary artifact, and compares the saved baseline/proposal with the positively
captured current source in the trusted worker. Changed paths, directory descendants, case aliases, unsupported
merges or unknown current source refuse import. Unrelated current edits are preserved.

A clean comparison produces a one-use process-local import token bound to the exact new store/source receipt,
owner, project and folder grant. Another genuine source receipt must pass `sameSource` before the proposal is
materialised into a new private copy. The final exporter must still observe unchanged complete current source
and no conflicts. Late changes refuse publication and discard the temporary artifact; no automatic retry or
live-source write occurs. Successful preparation publishes a new stopped review, binding, result and task ID,
with zero fresh check outcomes. Saved scope/dependency metadata supplies no permission: the fresh backend
establishes its own source scope and dependency receipts.

The person then reviews the new result and types a **new request** through the ordinary Continue action. That
captures current folder/backend/account/provider/mode authority. Saved request/summary travel through a separate
quoted untrusted-data channel to the conductor and coding controller, never `TaskSpec.userWords`, command words
or approval checks. Historical checks must run again when needed. Forgetting a private imported result/project
also clears its separately held historical context; Forget everything drains storage/import workers and clears
both private reviews and encrypted drafts. Unknown cleanup refuses a successful erasure acknowledgement.

The existing selected-file `ProjectWorkspaceStore` and metadata-only **Save projects** are unchanged. Their
one-MiB schemas are not widened to retain coding source files. No source write or automatic patch application
is introduced.
