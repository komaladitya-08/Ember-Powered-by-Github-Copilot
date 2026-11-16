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

The workspace authenticated GitHub's run/artifact metadata and API redirect, but its proxy denied the separate
Azure-blob CONNECT with 403 before any ZIP byte arrived. No local member hash was invented. The fixed outer ZIP
digest authenticates every contained byte. Windows CI must verify that digest through the same held archive
before strict four-member extraction, then validate the original source/tool/compile-recipe receipt and both
PEs. Public member hashes can be derived only after those checks. This is a network-access limitation here;
it does not require a user's Windows laptop or relax artifact authenticity.

The native-only workflow retains the original four controls and required LPAC useful-work assertion. Its
observations remain pending. It intentionally skips a fresh source compile only for the fixed
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
