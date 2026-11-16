# Verified CNG source Node native-only replay

This separate experiment reuses one existing public source-built Node image to diagnose its fixed child-process
failure. It performs no Node build, changes no source patch or compiler input, and enables no product backend.
No arbitrary project, program, artifact, run or commit is accepted. The original six native assertions remain
required: a failure observation cannot make a failed child gate pass.

## Existing evidence and immutable origin

The [source run 43858256344](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43858256344)
at head `e3d5626aab7e731d7102f7804f4bd2bc80f83fe0` compiled merge
`df3d273dc1028f2358a119db0719b4cf2cb471f9` on Windows Server 2022. Its build and public-asset upload steps passed;
the overall job failed two of six native assertions. Signed-stock ordinary startup and its unchanged LPAC
Winsock refusal passed. Source ordinary-host and zero-capability LPAC fixed filesystem, asynchronous I/O and
timer work passed with natural exit 0 and stopped private jobs. Both ordinary child/default-test controls passed;
their LPAC roots exited 1 without accepted child reports or TAP. The 188 byte test output was refused and never
viewed. No failed API, pipe or policy cause was established by those observations.

The new [immutable pin](../scripts/experimental/windows-node-cng-artifact-pin.json) binds repository ID 1419326021,
run 43858256344 attempt 1, workflow ID 419841405 and its exact path, head and compile commits, successful producer
job 133268040660/build step 10/upload step 12, and artifact 14224884648. Its ZIP is 38,424,638 bytes with SHA256
`97d34d7260474d71699f6ebca3a5b4a88e1d3663aa4a817a9f02c43a4ff29234`.
The only four members are `source-node.exe`, `bootstrap.exe`, `build-receipt.json` and `LICENSE`; their literal
lengths and hashes derive from the connector-fetched ZIP after independent full outer-hash verification. Their
canonical manifest is `74696a2ed8435b2f507559b5d7a491e685bef377957fc88a22e5795f0321c12c`.
An expired, absent, foreign, changed or unauthenticated artifact is refused without fallback or an automatic rebuild.

The old #225/#227 artifact pin, extractor and stager remain unchanged. This lane uses the separate issuer
`ember-experimental-source-node-cng-native-reuse`. The current source receipt retains its distinct
`ember-experimental-source-node-cng-pipes-feasibility` issuer. The source workflow and old replay exclude only
this exact new replay head; future source heads and an intentional source-workflow dispatch retain their normal
behavior. A skipped producer job is not a new build proof.

## Trusted staging boundary

Five bounded fixed-origin GitHub metadata requests precede the archive redirect: repository, run, workflow,
artifact and exact-attempt producer jobs. The run may be a native-test failure only with the pinned successful
build and upload observations. API requests retain manual redirects and the scoped API credential. A fresh
unauthenticated HTTPS request fetches the checked Azure blob location, with no forwarded credential, cookies or
referrer and no further redirect.

The trusted hosted Python 3.12.10 path, version and fingerprint are attested before extraction under the fresh
clean build environment. Python runs with `-I -B`. The extractor hashes the entire exact-size archive through
the same held descriptor used by the ZIP parser before creating output. It admits only the four literal regular
files and their exact bytes/hashes, with bounded count/expansion/read limits; aliases, links, special types,
encryption, privilege bits and unsafe ancestry are refused. Cross-API stable file identity and both same-API
ctime mutation guards remain intact. This is a trusted fresh CI staging boundary, not exclusion of a concurrent
same-user local attacker.

JavaScript independently rehashes the four outputs and validates the unchanged complete source/tool/recipe
receipt against the exact compile commit. All six compile-recipe files remain byte-identical to the producer.
Both images must pass bounded x64 PE checks and receipt identity; Node additionally requires exactly one named
`bcrypt.dll!BCryptGenRandom`, no named `CryptGenRandom` and no delayed import table. This is a named-import check,
not a general dynamic-loading or FIPS claim. No downloaded PE is executed locally for preparation or validation.

## Fixed runtime failure observations

Current literal hashes and the current run commit are separate from the unchanged PE's compile commit. The
program still uses default three-pipe spawn and default `node --test` isolation, with the original token,
package/AAP, image, canary, two incoming stdio, private job, child observation and Stop gates.

A fixed literal may write one 48 byte first-failure frame under its existing private state. Only closed operation
and documented Node/libuv code enums plus an independently validated signed32 `errno` data descriptor can enter
it. No error message, path, stack, syscall string, arguments or raw stdout/stderr are inspected or published.
The test runner can fail before its fixture enters; that case remains unknown because no preload, wrapper or
runtime flag is introduced.

Only a naturally exited nonzero LPAC root takes the diagnostic read path, after private-job zero and positive
completion of every retained observer handle. The fixed role/mode filename receives an owned Native pin excluding
writers/deletion before bounded reading. Missing or malformed content supplies no claim; it does not itself
invalidate known cleanup authority. Stop-witness, native pin and read-close uncertainty retain owners. A detached
valid frame stays local until all original pin and cleanup checks succeed. Later uncertainty suppresses it.
Successful native assertions and their reports are unchanged, and all six assertions remain required.

The new extractor and composed JavaScript checks have verified the actual authenticated public archive locally,
including the complete receipt and named crypto import. Portable contracts cover origin/producer mutations,
credential separation, same-descriptor ZIP bounds and identities, forged coherent PE receipts, generated literal
failures and stopped-file read/publication boundaries. Native-only replay outcomes remain pending reviewed CI.
This establishes no general Node compatibility, untrusted-project admission or Windows product enablement.
