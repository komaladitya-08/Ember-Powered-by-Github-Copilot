# Exact source-build reuse and closed fatal diagnostics

This lane diagnoses the source-built Node image from the [first completed build](EXPERIMENTAL-WINDOWS-NODE-SOURCE.md).
That image completed its ordinary-host fixed FS/async/timer program but aborted in zero-capability LPAC with
exit 134 before its first report. There is no useful LPAC Node or product-backend success claim.

The fixed source origin is repository `komaladitya-08/Ember-Powered-by-Github-Copilot` (1419326021), workflow
419841405 at `.github/workflows/experimental-windows-node-source.yml`, run 43823648292 attempt 1, original head
`b570de1f700bab85e21b0aa8ebb429b21ad1096e`, and actual merge compile commit
`2a1d186c44239ef35686e9eefa1e535d71f25344`. Only artifact 14207138723 is accepted. Its exact 38,423,911-byte ZIP
has SHA-256 `34fd4ffd22e81b7927b99663f10c06d9a3086782b5462a394d654bb2f998c5be`. No caller-selected run, artifact,
binary, script or native argument is accepted.

The workspace's direct Azure-blob CONNECT was denied with 403 before any ZIP byte arrived. The GitHub artifact
connector subsequently supplied that exact archive through its download service. Its size and complete outer
SHA-256 were verified before inspection. The unchanged Python extractor, original JS compile-receipt verifier
and both strict PE checks then passed locally. No PE was executed and no member hash was guessed. The resulting
four public files have the hashes below. Windows CI retains the same held-archive hash, strict extraction and
receipt checks; the connector route resolves a local download limitation without requiring a Windows laptop.

| Fixed public member | Bytes | SHA-256 |
| --- | ---: | --- |
| LICENSE | 145485 | `c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4` |
| bootstrap.exe | 2560 | `8219130aa9d30e8e2d271323760f7c73fc6b9f93f9ad5da3ea2be2618e4c678e` |
| build-receipt.json | 4858 | `f366c3bd034078537f4cc334e77009ce60beacda2180ccd86a9b64d9fe32bff4` |
| source-node.exe | 120218624 | `c03bb2d43d98260efe194d2026b150e1a492f511ff3cd7667a4b95e8a632e60d` |

The native-only workflow retains the original four controls and required LPAC useful-work assertion. Its
fatal observations remain pending. The [first reuse run43831268214](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43831268214)
passed 194 portable contracts with one expected Windows privilege skip, authenticated the origin/download/ZIP
digest, then refused during Python extraction before original-receipt verification or any native execution.
The unchanged extractor's local success excludes an obvious ZIP-format incompatibility; a Windows-specific
validation stage still needs its closed diagnostic witness. No acceptance rule is relaxed on that inference.
The workflow intentionally skips a fresh source compile only for the fixed
`ember-improve/20261116-source-node-native-reuse` PR head; other source PRs and explicit build dispatch still
compile normally. Skipping a fresh compile is not a new build
result. Compiled source/patch/tool/recipe inputs remain byte-identical to the authenticated build; current runtime
literal receipts and run identity remain separate from its compile identity.

The source-only output classifier preserves the frozen official parser's size, ASCII/control, newline and public
V8-location rules. It adds only fixed numeric format codes for public Node assertion pairs(1), Node fatal
headers (2), native backtraces (3), or ambiguous headers (4). The emitter authority is pinned Node 22.23.5 commit
`60553651579ec33ca1aef9e1eedab2c3855f1f7e`: [node_errors.cc400](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/src/node_errors.cc#L400),
[fatal headers572](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/src/node_errors.cc#L572),
and [debug_utils.cc317](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/src/debug_utils.cc#L317).
Its finite public-site/line/check/frame tables identify only known release-source metadata. Unknown paths,
expressions, symbols, addresses, process names, argv and captured messages are discarded. A matched public
suffix or frame is diagnostic evidence; it does not establish the cause or authorize a policy/runtime change.

Root/token/AAP/zero-capability checks, exact image/PID pins, two incoming private stdio handles, held ancestry,
private job deadlines, Stop and cleanup fences are preserved. Output is parsed only after root exit/job zero and
released only after verified cleanup. No raw stderr, private scratch, reports, paths or dumps are uploaded.

Independent fixed-C namespace evidence is separate: both hosted Server 2022/2025 images refused the original
pipe prefix at `CreateNamedPipeA` with code 5 while the `LOCAL` pair connected and closed, preserving all canary,
parent-right, token and Stop controls. That proves a namespace prerequisite, not Node/libuv byte transport,
child creation, default `node --test` or general offline-runtime compatibility. No pipe backport is in this image.

The pinned default CLI test path also differs from the isolated C child comparisons. Its [test runner](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/internal/test_runner/runner.js#L361)
uses three pipes without `windowsHide` or `detached`; [normalization](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/lib/child_process.js#L737)
makes both false. Ordinary CLI environment flags do not include the embedder-only console-hiding bit.
[libuv process.c1032](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/deps/uv/src/win/process.c#L1032)
therefore uses `CREATE_UNICODE_ENVIRONMENT` by default, with null process/thread descriptors and inherited CRT
stdio metadata. `CREATE_NO_WINDOW` is conditional on explicit hiding; detached mode separately adds
`DETACHED_PROCESS`, a new group and suspension. C results with explicit descriptors, `CREATE_NO_WINDOW` or
detached flags do not establish this full Node path. Actual default child and test-runner proof remains required.
