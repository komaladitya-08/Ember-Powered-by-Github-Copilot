# Windows project file resources

`WindowsProjectCodingResources` is a host resource owner for fresh Windows copied-file sessions. It mirrors the
project folder, account, task, result publication and Forget interfaces used by the Linux owner. It does not select
a production backend, enable a product gate, discover a toolchain, execute a command or supply Windows SDK/controller
storage isolation. The mode is always `files-only`; availability explicitly reports `canContinue: false`.

The development product candidate connects this owner through `project-coding-backend.ts` and the ordinary main/Host
interfaces. Selection is fixed by platform, captures no model-supplied mode, and never falls back after initialization
failure. Only workspaces minted by that selector may open its file broker. The live review-base getter survives
asynchronous initialization. Windows uses the separately protected trusted controller; Linux keeps its command
backend. This wiring needs the dedicated Windows SDK/native and real Electron tests before merge or client acceptance.

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

The host-only continuation handoff reads a complete verified predecessor artifact through the same Windows store,
bound to the selected project's original source identity before loading. It passes baseline, proposal and scope to
the fresh-file materializer and wipes every caller-owned decoded buffer after admission or failure. The predecessor
must stay current until the fresh copy has been accepted. An admitted independent copy then survives deletion of its
predecessor; account, project, original source, privacy and task revocation still apply. Invalid, forgotten, mismatched
or malformed predecessor capabilities are refused without falling back to a fresh capture of the original folder.
The exposed `canContinue` capability remains false pending integrated native proof and the production controller
boundary. Implementing this internal handoff does not enable the Home continuation action.

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
