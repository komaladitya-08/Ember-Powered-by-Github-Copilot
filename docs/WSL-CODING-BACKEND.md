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
Public dependency acquisition is a separate, currently unsupported capability:
Windows `node_modules` cannot provide Linux native dependencies. The initially
proven TypeScript project has no external dependencies. Runtime networking is off.

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

`.github/workflows/wsl-coding-product.yml` is a separate manual qualification job
on Windows 2022 and 2025. Explicit CI setup provisions an existing reviewed Linux
Node pin and compiles a socket fixture. The suite requires real Windows discovery,
job host and helper, offline TypeScript repair/testing, child execution and Stop.
An identical owned PE must first launch through WSL interop outside the sandbox
and change a Windows canary. Inside, direct/forged/fallback interop attempts must
fail, the canary must stay unchanged, and native VSOCK denial must pass. Empty,
skipped or failed evidence fails the job; it cannot automatically open admission.

The workflow has not been dispatched or qualified by the Linux development proofs.
Before enabling WSL coding, review complete native evidence, refresh the source
inventory and requalify touched existing Node enforcement sources. Final laptop
testing must verify actual Windows desktop/app interaction, distro/tool availability,
consent/revocation, Stop and review in the user's environment before merging main.
