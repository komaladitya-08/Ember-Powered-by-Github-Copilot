# Windows project file resources

`WindowsProjectCodingResources` is a host resource owner for fresh Windows copied-file sessions. It mirrors the
project folder, account, task, result publication and Forget interfaces used by the Linux owner. The owner itself
does not select a backend, discover a toolchain or execute a command. The mode is always `files-only`; commands,
tests and dependency installation remain unavailable. Public `7eabd077` availability reports `canContinue: true`
after the real Home continuation proof below. The legacy native-SDK gate remains false.

The development product candidate connects this owner through `project-coding-backend.ts` and the ordinary main/Host
interfaces. Selection is fixed by platform, captures no model-supplied mode, and never falls back after initialization
failure. Only workspaces minted by that selector may open its file broker. The live review-base getter survives
asynchronous initialization. Windows uses the separately protected trusted controller; Linux keeps its command
backend. Current consent version 14 describes copied-folder review and retention. Native SDK tools/configuration
loading remain disabled; trusted controller storage has its separate Windows native ownership checks.

Source capture uses the native NTFS read-only boundary and excludes `.git` and `node_modules`. File tools operate
only in the fresh owner/SYSTEM copy. The host must finish controller disposal and close the file broker before
attesting the adapter's review seal. A sealed review compares baseline, proposed and current source; publishing
requires the original task object, original account/project epochs, original source identity and exact transferred
artifact capability. Stopping ordinary file access does not itself revoke an otherwise current review. Account,
project and privacy revocation do. Review exports include unchanged captured files and remain an explicit user action.

The resource keeps ordinary canonical drive paths for host folder selection and native Copy/Store API inputs.
Native Volume GUID paths, volume IDs and file IDs are identity receipts, used for alias and overlap checks. They are
never substituted for the public drive paths. Protected application files and directories remain pinned throughout
the resource lifetime.

Private allocation starts with a fresh common directory created through the native COPY capability under a pinned
local NTFS parent. The fresh common, process, copies and reviews directories retain their exact owner/SYSTEM handles.
Any pre-existing common path, including an empty directory, has no owned creation/cleanup receipt and prevents
admission. This owner neither adopts it, changes its ACL, reads old content nor removes it. It does not trust a
pathname or a marker file as proof of previous shutdown.

Forget revokes task/publication authority before awaiting work. It drains pending creation, file access, exports,
publication and privacy workers before discarding its exact artifacts and checking role emptiness. Final close also
closes the registry/store's independent native pins before removing each known empty role, process and fresh common
through its original COPY handle. A successful final close leaves the common path absent, allowing a fresh resource
to allocate there. An unknown namespace or unverifiable cleanup retains private data and refuses further coding;
there is no path-based recovery or best-effort recursive deletion.

The implemented continuation foundation captures the original same-store source boundary before loading the complete
prior artifact. Copy creation compares a fresh native source identity with that exact receipt while the original
source pin remains held. An opaque predecessor reference stays current through copy admission. Both complete trees are cloned,
rebound, checked against current Windows limits and fully privacy-scanned before fresh owner/SYSTEM descendants are
materialised under the held new copy root. Executable/dependency metadata and invalid names, aliases or exclusions are
refused. The cumulative original baseline is retained; proposed clones and decoded caller buffers are cleared. After
admission the new copy is independent of predecessor Forget. Account/project/privacy/global erasure still revoke it.
A new source capture cannot silently replace a missing or revoked predecessor. See
[continuation materialisation](CODING-CONTINUATION-MATERIALIZATION.md).

At public `7eabd077`, [run 43813240393](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43813240393)
passed on Server 2022 and Server 2025: 147 portable, 30 artifact, 23 sealed-copy/review and five resource cases per
server, 410 total with zero skips. This is actual native continuation evidence, not a public Continue-control pass.

The separate controller/product head `0f70a7f7` passed
[run 43812314219](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812314219) on both
servers: 97 portable, three native controller cases including the actual SDK contract, and one real Electron journey
per server, zero skips. Two fresh sessions verified zero checks, source preservation, export, selective/global Forget
and normal exit in 13.267/14.744 seconds. Actual process metrics confirmed the normal OS sandbox and absent Node
globals; no bypass was supplied. The provider and picker answers are fixtures.

The actual Home continuation form and three fresh sessions at `fac7c0a3` passed
[run 43812927368](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43812927368) on both
servers: 97 portable, three native controller and one actual Electron case per image, zero skips/failures. Electron
completed in 16.393/15.970 seconds with the normal OS sandbox, sender guards and unforced exit `0`. Continue read
prior proposal `43`, produced `44` with cumulative baseline/current `41`, survived predecessor Forget and preserved
completed `42`/`44` exports after global erasure. Public PR #223 advanced to `7eabd077` with the same production
source and `canContinue: true`. Its exact-head native matrix above is green; ordinary CI is blocked by the known Windows LPAC child-launch case.
These results do not certify a merge, live provider, native picker UI or Windows 10/11 laptop.

Portable resource tests exercise the host ledgers and lifecycle using a native model that distinguishes drive paths
from GUID receipts and BASE/read handles from COPY handles. The real suite uses actual project folder binding,
protected files, copied edits, stopped-review publication, export, Forget and final native removal. The continuation
case additionally edits the prior proposal, preserves the original cumulative baseline and proves predecessor Forget
does not revoke the newly admitted copy:

```bash
node node_modules/vitest/vitest.mjs run test/unit/windows-coding-resources.test.ts
EMBER_WINDOWS_CODING_RESOURCES_TEST=1 node scripts/run-integration.mjs test/integration/windows-coding-resources-native.test.ts
```

The native suite runs on Windows x64. It skips only off Windows unless explicitly required; setting its variable on
an unsupported host fails. Native failures remain failures. Deliberately pre-existing synthetic namespaces are
retained outside the automatically removed test temporary directory. These checks establish the files-only host
seam on the tested Windows environment, not command isolation, SDK/controller disposal or Windows client acceptance.
