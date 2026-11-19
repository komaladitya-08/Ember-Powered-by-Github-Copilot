# Optional WSL2 coding backend

The backend is implemented, but Windows product admission remains closed in
`app/shared/wsl-coding-readiness.ts`. Linux helper tests and mocked Windows argv
tests do not qualify Windows interop isolation. Shipping assets does not enable it.

## Product boundary

The user explicitly selects a discovered WSL2 distro for a Windows project. An
accepted session captures that selection, distro consent, command policy, account,
folder grant and privacy scope. Missing assets, unknown default user, WSL1,
first-run setup, revoked authority or an unqualified build leave commands unavailable.
There is no automatic distro installation, substitution or ordinary-shell fallback.
Before transferring tools or source, the helper's actual positive UID must match
the captured distro user. Provisioning independently refuses root or unknown UIDs.

The controller, model/provider connection and credentials stay in Windows. Native
Windows capture creates an owned copy and genuine host baseline/source boundary.
The credential-free guest receives only portable copied source and authenticated
offline tools over bounded framed stdio. File operations use a remote broker;
`/work` never becomes a Windows filesystem authority.

The guest reuses `IsolatedCommandWorkspace` with an opaque, host-issued WSL tool
profile. The original Linux profile and native Windows LPAC implementation retain
their existing limits. The WSL profile adds Bash, `/bin/sh`, verified root-owned
Linux Node/npm and exact lock-pinned TypeScript. Held verified bytes are copied into
private read-only tool locations. Commands may create Linux children inside
Bubblewrap with private process, mount and network namespaces. There are no host
Windows mounts, WSL sockets, host `/proc`, credentials or network. The WSL syscall
filter additionally denies non-Unix sockets, including `AF_VSOCK`.

Stop permanently retires admission before awaiting accepted provision/open/file/
command work. It drains that queue and the engine's existing namespace-exit checks.
Only an acknowledgement matching the connection episode/request nonce, sealed
admission, drained queue and every launched namespace can mint the private host
stopped receipt. EOF, job close, killed `wsl.exe`, missing replies and helper crashes
leave shutdown unknown. WSL processes can outlive `wsl.exe`.

After positive Stop, the guest proposes copied results only. It never supplies the
trusted baseline/current source or a Windows artifact capability. The helper must
positively close its workspace and exit before Windows captures fresh current
source and mints the final review artifact. Unknown cleanup retains the owner and
blocks review/continuation.

## Offline assets

`app/shared/wsl-coding-tools.json` pins TypeScript 5.9.3 by exact URL, SHA-512 SRI,
SHA-256, archive size and exact Apache-2.0 license digest, agreeing with the existing
package lock. Preparation is an explicit developer/CI operation:

```sh
node scripts/package/wsl-coding-tools.mjs
```

It authenticates before bounded decompression/staging, uses held ordinary files,
checks identity/clocks/EOF/positive close, and stages only a fresh leaf with readback.
The Windows package includes the archive and exact license in `resources/wsl-coding`
with its separately pinned exact `ThirdPartyNoticeText.txt`, and the helper at
`resources/app/dist/app/wsl-coding.cjs`. The legacy experimental
file-only ZIP keeps its independent four-command staging sequence. The controller
imports only `wsl-coding-archive.ts`, without download, installer or CLI code.

The application never fetches tools or accepts a model-selected tool version. The
selected distro must already provide trusted root-owned Node/npm and Bubblewrap.
Windows `node_modules` cannot provide Linux native dependencies. Public dependency
preparation is a separate captured project opt-in. It remains behind the same closed
Windows admission gate. Opt-in alone approves no download: both the accepted baseline
and every changed exact package set use the normal mode-sensitive policy before host
acquisition. Commands, npm lifecycle scripts and children always remain offline.

## Public lockfile preparation

`prepare_public_dependencies` accepts no URLs, package names, versions or shell
commands. Under a held engine file lease, the guest reads the copied `package.json`,
lockfile v3 and declared copied workspace package identities. The Windows host
independently validates the exact bytes, source digests and sorted artifact-set digest.
The lease blocks command/file writers while the normal approval, acquisition and cache
transfer are pending. Neither an SDK idle event nor a Boolean quiescence claim grants
that lease. Original source, credentials and a prior draft receipt never grant a fetch.

Acquisition accepts only exact HTTPS `registry.npmjs.org/<name>/-/<name>-<version>.tgz`
URLs with a canonical single SHA-512 SRI. There are no redirects, credentials, query
parameters, alternate ports, local/git sources, private registries or general fetch RPC.
The registry receives requested names/versions; source files are not uploaded. Normal
host TLS/system proxy settings stay on the host. The host executes no npm, lifecycle
script, package binary or archive member and never extracts packages into its filesystem.

The bounded data-only archive inspector refuses traversal/aliases, links, special files,
PAX/GNU path extensions, bundled node_modules and mismatched package identities.
Limits are 512 artifacts, 16 MiB per compressed archive, 64 MiB compressed and 128 MiB
**full inflated tar bytes** per batch, including headers and zero padding, 50,000 entries,
16 MiB per member and depth 64. The remaining aggregate inflation budget is supplied
before the next gunzip; large scans yield and check cancellation. Inputs are limited to
256 KiB package JSON and 2 MiB lock JSON; duplicate keys, malformed UTF-8 and unsupported
lock layouts fail closed. Linux x64/glibc optional-platform selection is explicit.

An opaque guest-issued runtime owns fresh writable dependency/cache mounts, separate
from the source copy and from the default read-only dependency capability. Only this
profile adds verified root-owned env/mkdir/rm/cp/mv/touch/ls/chmod/ln tools; the default
three-tool set and asset bounds remain unchanged. Authenticated content-only npm cacache
bytes are transferred through bounded fixed-purpose frames, reverified by the guest,
and installed later by the separately checked `npm ci --offline` command inside bwrap.
No tool or dependency acquisition occurs inside a command. Native packages requiring
unprovided compilers/system libraries, install-time network downloads, unsupported tar
formats or private registries remain unsupported.

Stop seals admission, aborts host acquisition, releases the held guest transaction and
drains **all** accepted lease/chunk/commit/file work before a positive stopped receipt.
Accepted cache loans and partial chunks are wiped; lost acknowledgement, inode/close
uncertainty or helper loss prevents positive cleanup/publication. Forget, sign-out,
folder/target/policy/consent changes keep the existing captured capability fences.
Cache and installed dependencies are mutable only inside the private namespace and
excluded from review exports; copied/derived source outputs may contain their bytes.
Host review metadata records verified archive **input provenance**, not a digest of
later command-mutated installed contents. A continuation starts a fresh runtime and
must reapprove its exact set; the old manifest is disclosure only.

## Verification and release gate

Portable units cover protocol/tree bounds, nonce and shutdown faults, actual filter
semantics, Windows argv/environment/path translation and strict archive staging.
Required Linux integration uses the real helper and Bubblewrap: npm invokes
TypeScript, a compiled child test fails, a remote repair makes it pass, native Unix
sockets work while network/VSOCK sockets return EPERM, and Stop drains parent and
detached child writers before host artifact transfer and cleanup. Early Stop also
exercises an accepted provisioning request and a zero-launch drained epoch.
WSL path facts use `/tmp` for HOME, matching Bash and Node child environment and
the classification resolver's expansion of `~/...`.

```sh
EMBER_WSL_CODING_GUEST_TEST=1 EMBER_REQUIRE_CODING_ISOLATION=1 \
EMBER_TEST_CODING_NODE=/absolute/root-owned/node \
EMBER_WSL_TYPESCRIPT_ARCHIVE=/absolute/typescript-5.9.3.tgz \
node scripts/run-integration.mjs test/integration/wsl-coding-guest.test.ts
```

`.github/workflows/wsl-coding-product.yml` registers portable protocol, syscall and
admission contracts on pull requests. Its native qualification remains manual,
restricted to the reviewed integration branch, on Windows 2022 and 2025. Explicit CI setup provisions an existing reviewed Linux
Node pin and compiles a socket fixture. The suite requires real Windows discovery,
job host and helper, offline TypeScript repair/testing, child execution and Stop.
An identical owned PE must first launch through WSL interop outside the sandbox
and change a Windows canary. Inside, direct/forged/fallback interop attempts must
fail, the canary must stay unchanged, and native VSOCK denial must pass. Empty,
skipped or failed evidence fails the job; it cannot automatically open admission.

Linux development proofs do not qualify the separate native Windows workflow.
Before enabling WSL coding, review complete native evidence, refresh the source
inventory and requalify touched existing Node enforcement sources. Final laptop
testing must verify actual Windows desktop/app interaction, distro/tool availability,
consent/revocation, Stop and review in the user's environment before merging main.


The public-dependency integration additionally uses real approved public picocolors
and yocto-queue archives: baseline preparation, offline lifecycle/install/TypeScript
import, a failed child test, repair/pass, denied changed-set preparation with zero
fetch, approved same-session changed-set refresh, descendant Stop and host source-only
review custody. Held-approval, host acquisition and partial-chunk Stop controls verify
queue draining and buffer wiping. Run it with the same trusted Node/TypeScript inputs:

```sh
EMBER_WSL_PUBLIC_DEPENDENCIES_TEST=1 EMBER_REQUIRE_CODING_ISOLATION=1 \
EMBER_TEST_CODING_NODE=/absolute/root-owned/node \
EMBER_WSL_TYPESCRIPT_ARCHIVE=/absolute/typescript-5.9.3.tgz \
node scripts/run-integration.mjs test/integration/wsl-public-dependencies.test.ts
```

This opt-in does not qualify native WSL interop, desktop integration or broad package
compatibility. Keep admission closed until the expanded native/current-source evidence
has been independently reviewed.
