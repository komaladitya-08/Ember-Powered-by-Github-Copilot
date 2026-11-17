# Windows Node product candidate

This unpublished candidate starts at workspace foundation `68860d557ea95ad538babb4133b6330804a67e87`.
It includes the exact worker-startup cleanup correction `bec2e6ad`, packaging foundation `f934068f`,
and output-redaction correction `f6a5b209`. The existing three-patch Node manifest stays unchanged until
the replacement producer's archive, members, source recipe and ABI receipt have been authenticated.
No Windows execution or public selector activation is authorized by this document.

## Host and resource boundary

Main passes its trusted `process.resourcesPath`; no model, task, installed Node search or environment fallback
can choose the executable. `WindowsProjectCodingResources.createNode` owns fresh copies, reviews and assets
roles under its protected process namespace. Each role retains its own native creation, identity and closure
receipts. The earlier `create` factory remains files-only and owns two roles; no missing third-role receipt is
invented when those genuine earlier owners close. Unknown pre-existing namespaces stay retained.

The resource owner records exact wrapped-workspace to genuine-Node-workspace relationships in a private WeakMap.
Its fixed adapter resolves only those exact wrappers before calling the unchanged private-brand Node adapter.
Foreign objects, clones, new Proxies and prototype claims cannot obtain facts or files. The selector also records
its own created wrappers. Native failure closes admission and retains every unresolved owner; it cannot grant
a files-only fallback or permit registry/role cleanup to continue behind a native failure fence.

The host atomically captures a complete fixed capability before an accepted request waits: commands OFF selects
the genuine files-only factory and adapter; commands ON selects the genuine Node factory and adapter. An OFF
request cannot upgrade when the setting later changes, and disabling commands retires an admitted Node request.
Only the captured `toolchain: "windows-node"` inserts the fixed `WINDOWS_NODE_CODING_CONSTRAINTS` into conductor
and worker context. Task goals,
files, model responses and RunnerFacts cannot supply the constraints. The actual initialized runner must have
genuine Node availability, Windows facts and zero shells. The initial policy cwd is `\work`; file tools retain
their logical `/work` spelling. No argv rewriting, implicit flags or host-path substitution is introduced.
The legacy native-SDK `codingAvailable()` gate stays false.

## Protected command-parent allocation

Canonical protection retains the entire original protected-path set, including the private COMMON root. A private
resource-issued reference permits fresh command allocation only beneath the exact owned copies role when COMMON
is its strict protected ancestor. It authenticates actual COMMON, process and three-role identities, ACLs and exact
namespace membership. Canonical capture binds a child reference to its held base identity, complete protected set,
content revision and genuine input. The Native factory also requires that input's exact opaque intake and live
preparing producer. Foreign, serialized, proxied, stale, replayed and concurrently swapped references refuse.

After its final admission callback, the Native factory refreshes resource ownership, compares its actual held
parent and COMMON pins, and consumes the child reference immediately before fresh creation. Equal or reversed
overlap, external protected ancestors and sibling placement remain refused. The historical no-reference factories
keep their original overlap checks. This reference is host-only scratch-placement authority bound to task lifetime;
it grants no source access and makes no exclusive canonical-receiver claim. Canonical source, privacy, review and
revision checks independently govern the bytes. Resource `current()` does not continuously revalidate storage:
the explicit issuance, capture and final consumption checks provide those ownership checks.

Node availability separately reports cached metadata presence for only the fixed packaged `node.exe`, `LICENSE`
and `build-receipt.json` members. It grants no integrity authority. Missing members refuse Node creation before
profile or canonical allocation; commands-OFF file access remains independent. Present but changed bytes reach
the real asset hash/attestation checks and retain the resulting failure without a files-only fallback.

## Required build and package changes

The local candidate includes the fixed dev stager and required Windows package flag. Activation still requires
the following complete validation:

- `scripts/build-app.mjs` and `scripts/package/windows-node-toolchain-dev.mjs` verify the producer cache and stage
  only the three shipped members into the development Electron installation's actual resources directory. The
  explicit staging command is strict; an ordinary development build may leave commands unavailable when the
  cache is absent. Present invalid bytes refuse. Runtime code never downloads assets or searches installed Node.
- `package.json` must require `--with-windows-node-toolchain` for Windows packages.
- The required reusable `.github/workflows/windows-node-product.yml` must authenticate the fixed producer archive
  and exact member set before its native, source Home and packaged Home journeys on both Windows images. The helper's unit tests and real
  asset staging/tamper integration must cover both layouts.
- `test/integration/project-coding-windows-node-electron.test.ts` must exercise the actual Home/preload/IPC/Host
  Node-only journey: a failed check, copied-file repair, the exact same passing check, review/source preservation,
  denial and commands-off behavior, active Stop, selective/global Forget, account changes and continuation.
  The earlier commands-OFF Home test keeps its exact files-only inventory assertions.
- The packaged Windows journey must run that same host path using the extracted ZIP's actual resources and
  asset bytes. A helper-only packaged probe or the portable DLL models cannot satisfy this gate.

The new four-patch producer and the separate seven-case native asset/MIC proof remain independent required
dependencies. A proof bound to the earlier three-patch Node artifact does not authenticate the replacement.
After those inputs freeze, the candidate needs exact source review, semantic TypeScript, portable preservation,
real SDK and sandboxed Electron regression checks, followed by explicit Windows product proof authorization.

## Current verification boundary

The real pinned Linux SDK/controller tests use a local deterministic provider and the actual Windows workspace,
profile, asset, Copy, Stop and output issuers over DLL models. They cover failed-check repair, active Stop and
retained startup uncertainty without provider credentials or issuing-API mocks. Windows execution, kernel access
control and asset hash streams are explicitly modeled. Their passing result does not establish native Windows
enforcement or the Home/IPC/Host packaged product journey.

The final protected-parent/import/adapter/workspace/CJS gate passed 74 tests across five suites (session `78697`,
one worker, original 5-second default). The separate readiness/resource gate passed all 14 cases (session `43459`,
the same default). Scoped lint passed (`7286`). An earlier combined run passed 73/74 with the unchanged active-Stop
case exceeding its 5-second bound; the isolated unchanged case then passed in 2.75 seconds, and the final 74-case
gate passed without changing source or deadlines. The subsequent typing-correction gate passed controller 68 and
resource 14; its parent suite passed 40/41 with a different unchanged source-selection case exceeding 5 seconds
(`27721`). That isolated case passed at its original bound (`89663`, 2.55 seconds for the invocation). No cause is
claimed for these timeouts, and no test deadline was increased. Earlier multi-worker timeouts and fixture-expectation
failures are not counted as passing validation.

The final pinned SDK/default Windows-DLL worker gate passed all three cases (`16164`, 9.35 seconds, original
60/60/45-second case limits); the Host correction gate passed 53 (`87122`). These remain portable modeled-Windows
checks. The first full integrated normal `npm run typecheck` exited 2 with eight candidate typing errors (`40794`);
its 1,468-file Type source catalog was unchanged during compilation. The corrected normal compiler run passed
(`87796`), with the same 1,468 files unchanged before and after (catalog SHA-256
`533a19f88aa6c80db02e52b277dc10a05f22eddec9203569ea58fa6032e15da5`). Existing Linux SDK/isolation preservation
also passed all 12 cases across two suites (`53088`, 15.49 seconds, one worker and original case limits).
The packaged normal-UI source was added after that compiler catalog and requires another final compiler check.
Its scoped lint passed (`86893`); Linux collected one optional skip (`35058`), while explicitly requiring the
Windows journey failed at fixed phase 1 (`24075`). Those results establish the platform guard only. Native product,
source Home and packaged Home results remain unverified.

## Packaged normal-UI coverage

`test/integration/windows-node-packaged-product.test.ts` launches the extracted shipped executable normally with
unchanged fuses. The external driver uses the shipped UIA bridge and ordinary Win32 input. It completes first run,
types and saves a synthetic custom-provider key through Settings, and observes real approval cards and OS folder
dialogs. It covers copied repair and identical passing checks, export and fresh continuation, denial, a real writer
Stop, a mode change and provider-key rotation. No debugger, injected app code, development provider variable, direct
test IPC or issuing-API replacement is used. API keys are typed into the actual password field and never read back.

The test respects existing UI limits: live folder/project Forget is disabled, and fresh BYOK exposes neither GitHub
Sign out nor memory's Forget everything. It uses ordinary post-stop Forget and names live key rotation as provider
revocation. The source journey separately tests the public preload revocation APIs. Packaged cleanup requires normal
exit plus absence of the owned private coding root, empty controller storage, unchanged executable/assets/source and
a positively closed UIA observer. A forced stop, failed assertion or uncertain close retains quarantine. Native UI
control exposure and geometry still require the actual Windows run on both supported images.
