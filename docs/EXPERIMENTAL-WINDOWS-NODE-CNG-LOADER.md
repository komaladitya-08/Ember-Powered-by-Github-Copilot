# Fixed source Node module-loader observations

This separate diagnostic reuses the unchanged authenticated CNG source artifact and the same read-only literal
`module.exports = 42;` module used by [the in-process experiment](EXPERIMENTAL-WINDOWS-NODE-CNG-INPROCESS.md).
It does not change that experiment's CLI arguments/assertions, the six original source/default-child assertions,
the source build receipt, artifact pin/extractor/stager or any product gate.

The third in-process [run 43923940767](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43923940767)
at `db48c586dcf65b55fc8977c544251d0c2cc8733d` passed 748 portable tests with one expected skip per Windows image.
Both ordinary-host tests passed. Both LPAC tests still exited 1 without a fixed report, now with zero private output
bytes and discovery enum 0; root/jobs stopped and known cleanup completed. The relative route removed the exact
discovery message, but did not establish successful import or identify the remaining failure. No TAP was viewed.

Pinned [CJS loader source](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/internal/modules/cjs/loader.js#L747)
normally calls [toRealPath](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/internal/modules/helpers.js#L60).
The default [Windows realpath implementation](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/fs.js#L2757)
queries the drive root and path components. This motivates observing loader operations separately; it is not a
diagnosis of the earlier CLI result. No preserve-symlink flag or host-ancestor permission is introduced.

The separate issuer is `ember-experimental-source-node-cng-loader`. An ordinary-host control must succeed first,
with its parent's observed token context unchanged. The zero-capability/AAP-opt-out LPAC then runs its own fixed
`--eval` body. Each independently attempts three operations on the same pinned read-only copied module:

| Operation | Positive value |
| --- | --- |
| 1: read and verify the exact source bytes | 21 bytes |
| 2: default `fs.realpathSync`, matching the known canonical module path | 1 |
| 3: default CommonJS `require` | 42 |

One refusal does not skip the later observations. The exact 96-byte completed report admits only status 1 (success),
2 (known failure) or 3 (unknown failure). Success has code 0 and its fixed value. Known failure codes 1–8 map to
EACCES, EPERM, ENOENT, ENOTDIR, EINVAL, MODULE_NOT_FOUND, ERR_MODULE_NOT_FOUND and ERR_ACCESS_DENIED. Unknown failure
has code/value 0. Only an own data property named `code` is inspected; error getters, messages, stacks, syscall text
and paths never enter a report. The final masks, operation values and successful flag must agree exactly. All
published reports, rows and arrays are frozen. A failed operation leaves root exit 1 and the native success assertion
failed; closed observations cannot confer compatibility.

The harness retains exact immutable receipt/image/bootstrap checks, suspended image/token admission, the clean
credential-free environment, two private inherited I/O handles, held asset/report pins, real root/job Stop and
complete profile/handle/pin/fresh-tree cleanup before publication. Unknown ownership/stop/read/close/deletion fences
later invocations. This is the existing fixed-source fixture, not a proof of the stricter root-only project backend.
No test runner or TAP is generated; raw output remains private and success requires zero output bytes.

The 17-file portable gate passed all 725 tests with zero skips. The final 52 new cases cover the fixed operations,
known errors and getter refusal, strict reports and composed lifecycle faults. Scoped lint, YAML/matrix/permission/
activation checks, and unchanged tracked-baseline checks passed. An earlier focused batch recorded three test
deadline failures and one null-report assertion; all 15 lifecycle cases passed alone and the final 52 plus full 725
passed with no assertion or deadline change. The required Linux invocation failed before native binding as intended.
Root and independent reviews of the actual final nine-file scope closed clean, and the exact-final TypeScript check
passed. Actual Windows outcomes remain pending.

Even a passing pair would establish only these fixed operations;
arbitrary project code, command workspace transfer, policy/controller integration, broader tooling and real
provider/client-Windows acceptance remain separate work.
