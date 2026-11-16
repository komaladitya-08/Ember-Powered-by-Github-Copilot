# Explicit source Node module-resolution experiment

The fixed loader [matrix 43929283141](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43929283141)
at `c326d6a9c10e9466594a29267b36bec47efa33e9` passed the ordinary-host case on both Server images. LPAC read the exact
21-byte copied CommonJS module, but default `realpathSync` and `require` each returned EPERM. Its completed numeric
report, zero output bytes, genuine job Stop and complete known cleanup passed. The native LPAC success assertion
remains failed. That result does not identify the exact denying native API.

This separate fixed experiment requests Node 22's documented `--preserve-symlinks` and `--preserve-symlinks-main`
alongside the existing explicit `--experimental-test-isolation=none`. The pinned
[CLI documentation](https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/doc/api/cli.md#--preserve-symlinks)
describes preserving module paths rather than dereferencing them; the main module requires its separate flag.
These flags change module-resolution semantics. They are a hypothesis to test, not a permission change or a
diagnosis of every Node failure. No host-ancestor grant or symlink is introduced. The fixed fixture rejects links.

The new issuer is `ember-experimental-source-node-cng-preserve`. Its fixed flags are frozen and appear explicitly
in the result. The ordinary host must first complete the same copied-module, async-read, timer and node:test work
with the identical flags. The LPAC then runs that same workload through the existing exact-image/token, private
job/I/O, writer-excluding pin, Stop and cleanup checks. TAP stays private and is removed without being read.
No user command or npm script is rewritten. The earlier in-process and loader arguments/assertions, source image,
artifact receipt/pin/extractor/stager and product capabilities remain unchanged.

The report/program/route/output helpers are the unchanged in-process helpers. Only the new proof's fixed argument
prefix and separate issuer differ; it retains the previously reviewed lifetime and refusal checks. Separate copied
lifecycle tests verify both exact flag order and cleanup faults. A real local Node CLI control verifies the explicit
relative test, CommonJS import, async read and timer without viewing its TAP; it is not Windows or LPAC evidence.

All 767 portable cases across 21 suites passed with zero skips, including the 18 new CLI/lifetime cases. A mechanical
copy initially failed to parse; that syntax error was corrected before the passing checks. Exact-final semantic
TypeScript, scoped lint, YAML/actions/activation/permissions, unchanged tracked baseline and independent actual
six-file review passed. Actual Windows execution is pending. Even a passing fixed pair would establish only this
declared invocation. Product commands still need bounded live output, genuine
stopped snapshot transfer, shared policy/controller integration and full repair/rerun/review/export/Forget journeys.
The independent open-target replacement failure remains unresolved. Keep all product commands disabled on Windows.
