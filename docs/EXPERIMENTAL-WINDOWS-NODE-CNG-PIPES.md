# Verified-source Node CNG and local-pipe experiment

This separate candidate tests a fixed local coding-loop prerequisite in zero-capability LPAC. It adds three
authenticated source deltas to Node 22.23.5: the existing Winsock initialization call guard, a Windows entropy
selector confined to one OpenSSL translation unit, and the upstream AppContainer local-pipe runtime backport.
The fresh Windows build and all new native outcomes are pending. No product backend is enabled, no project code
is accepted, and no general Node compatibility is claimed.

## Why this candidate exists

The [original one-guard source build](EXPERIMENTAL-WINDOWS-NODE-SOURCE.md) completed its verified build and
ordinary-host FS/async/timer proof. Its authenticated [native replay](EXPERIMENTAL-WINDOWS-NODE-NATIVE-REUSE.md)
identified the LPAC startup assertion at pinned `src/node.cc:1266`, `ncrypto::CSPRNG(nullptr, 0)`. A zero-length
startup check still instantiates and seeds OpenSSL's DRBG. The original PE imports `CryptAcquireContextW`,
`CryptGenRandom` and `CryptReleaseContext`; it does not import `BCryptGenRandom`.

The [separate fixed secure-API witness](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/228), run
[43842034332](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43842034332), passed
333 portable contracts and four native cases on each Server image, plus eight Linux logic cases: 682 passes total,
zero skips. Ordinary-host CryptoAPI and system-preferred CNG both succeeded. In unchanged zero-capability LPAC,
default CSP acquisition returned `0x80090017`, the source-conditional Intel CSP acquisition returned `0x80090019`,
and independent system-preferred `BCryptGenRandom` succeeded with NTSTATUS 0. Buffers were wiped, ownership and
Stop were verified, and no entropy bytes or hashes were published. These observations justify testing the
existing upstream secure CNG branch; they identify neither a particular denied registry key nor FIPS status.

The [fixed pipe namespace comparison](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/226) separately proved ordinary-host
pipe connection in both namespaces, LPAC denial in the existing namespace and LPAC connection under `LOCAL` on
both Server images. This proves a kernel prerequisite; the new Node tests must establish actual runtime behavior.

## Exact source scope and authority

The signed release source and trusted signer remain the original Node 22.23.5 release commit
`60553651579ec33ca1aef9e1eedab2c3855f1f7e`. Both complete inventories contain 29,212 files and 3,399 directories
below the archive root. The baseline manifest remains
`018a89c7504cb7bda4ccf6493f219d2da9344bb2c3f191d5ab7b6216c9049b7f`.
The new working tree is 554,317,214 bytes, manifest
`a3bc33c2eab801055ec81a0dab309ac20407d128ad985c8424811c4429eff4b6`.
Fresh local extraction and complete baseline/working validation passed. The catalog admits exactly these deltas:

- `deps/uv/src/win/core.c`: the existing compile-time guard omits only `uv__winsock_init()` for this probe.
- `deps/openssl/openssl/providers/implementations/rands/seeding/rand_win.c`: the fixed experiment macro selects
  `_WIN32_WINNT=0x0600` before this translation unit's headers when absent, and rejects a conflicting lower
  explicit target. This selects upstream's existing `BCryptGenRandom` branch and existing `bcrypt.lib` pragma.
  OpenSSL configuration, provider, DRBG, reseed, failure checks and Node's CSPRNG assertion remain intact.
- `deps/uv/src/win/pipe.c`: the exact minimal runtime hunk from upstream
  [libuv commit 2cadaa40167050baf7c6905ac897e6fb57afb2c6](https://github.com/libuv/libuv/commit/2cadaa40167050baf7c6905ac897e6fb57afb2c6).
  It detects AppContainer and prefixes generated pipe names with `LOCAL\\`. Its existing TokenQuery failure
  fallback chooses the old namespace, it ignores the token-close return, and the old access-denied retry remains.
  This is an exact upstream backport, with those caveats, rather than a hardened token helper. The parent job
  deadline and positive Stop remain the enforced boundary; a fallback, hang or incomplete witness fails the test.

No upstream AppContainer test runner, broad ACL grant, capability, loopback exception, JIT flag, registry change
or policy bypass is imported. Other source files remain byte-identical. The two compiler macros affect the exact
reviewed guard sites; no global Windows target change or custom entropy fallback is introduced. The OpenSSL TU's
conditional/include/link effects and the final PE's named `bcrypt.dll!BCryptGenRandom` import are checked. A PE
with the legacy `CryptGenRandom` import, a delayed import table or malformed import metadata is refused.

The separate issuer is `ember-experimental-source-node-cng-pipes-feasibility`. The compile receipt binds source
catalog, tool identities, recipe and resulting images. Existing OpenJS asset verification and pins stay unchanged.
Hosted Python/MSVC hashes are observed provenance under the hosted image's authority, rather than independent
upstream binary authentication. Fixed runtime literals have separate byte/hash receipts and a run commit, so
diagnostics can later reuse an authenticated unchanged PE. The old immutable replay skips only this exact new
branch; future source branches continue to build.

## Required native sequence

The original four assertions remain required: signed-stock ordinary startup, signed-stock LPAC Winsock refusal,
source ordinary-host useful work, and source LPAC FS/async/timer useful work. The new operations cannot launch
unless both source useful-work controls pass, including natural exits, complete reports and empty LPAC output.

Two additional fixed tests then run in fresh ordinary-host and LPAC fixtures:

1. Default `child_process.spawn(process.execPath, fixedArguments, {stdio: ['pipe', 'pipe', 'pipe']})` with no
   hidden-console, detached, shell or isolation override. The trusted child waits for a fixed stdin ACK, writes
   one fixed stdout marker and produces no stderr. The parent checks exact bytes and single spawn/exit/close
   events. This exercises three real default libuv pipes, including stdin-to-child and child-to-stdout transport.
2. Default `node --test` on one fixed read-only fixture. Default process isolation remains enabled. Its test child
   waits for the fixed ACK file, runs one assertion and exits naturally. Only bounded exact one-test/one-pass TAP
   is accepted; warning, error, extra or private output is refused and discarded.

Both tests observe an already-running trusted child's initialization. The host retains all members of the exact
private job, at most eight, including auxiliary processes. Only a unique held child with the expected image,
exact PID/job and required ordinary or fresh-package zero-capability/AAP token facts receives the fixed ACK.
Two complete stable job snapshots and current pins are required. The host creates the ACK with `CREATE_NEW`
inside the package-readonly tools directory; no package-writable control path or extra inherited handle is used.
**ACK is fixed-probe token-observation instrumentation. It is not production pre-resume admission and does not
authorize arbitrary project execution.**

The source-only stdio owner retains the same two incoming NUL/output handles and exact rights. Ordinary and LPAC
controls use independent fresh output owners. Reports and TAP are read only after natural successful exit,
whole-job zero and positive completion on every retained process handle. Cleanup uncertainty fences publication
and retains all issued owners; a non-disposing Stop may still run. There are no raw native streams, source paths,
arguments, SIDs, PIDs, nonces, entropy or private artifacts in outward receipts.

Even complete success would establish only these fixed operations. Complete API classification, toolchain/build
behavior, project admission, denial coverage, child lifecycle and production integration remain separate gates.
The product command gate remains false. This work uses hosted Windows CI and does not require a user laptop.

## Local verification

All 539 focused source, build, artifact, literal, report, ownership, observer and stdio contracts pass on this
Linux host. This includes 138 single-role native-binding tests, 107 bounded child-observer tests and two actual
ordinary-process three-pipe transport cases with synthetic version/path metadata. Scoped ESLint and diff checks
pass, and the final complete TypeScript check passes. The native integration imports and skips its six Windows
cases on Linux; explicitly requiring it fails at the Windows-x64 prerequisite. These are portable contract and
program-logic results, with no Windows execution
or compatibility claim. The signed-source full-tree preparation result above is separate from a successful
Windows compile; fresh build and all six native cases remain required.

## Sources

- [Pinned OpenSSL Windows entropy source](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/openssl/openssl/providers/implementations/rands/seeding/rand_win.c)
- [Pinned ncrypto CSPRNG implementation](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/ncrypto/ncrypto.cc)
- [Microsoft BCryptGenRandom system-preferred API](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptgenrandom)
- [Microsoft CryptAcquireContextW flags and errors](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-cryptacquirecontextw)
- [Microsoft named-pipe AppContainer LOCAL namespace rule](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
