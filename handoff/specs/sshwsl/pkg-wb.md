# Package WB: Linux GUI apps under WSLg (identify, read, act, capture, launch)

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (D1, R3, R12), then
`specs/sshwsl/design.md`: header, "Limitations and departures" (L7, L17), §2.6 (WSL hands; lease identity), §4.3-§4.11,
§8.7-§8.8 (WSL helper rows), §10.1-§10.2 (WB rows; `wslg-probe`), §11.3 (the hooks S0b gave you), §11.4 (WB row),
"Critique resolutions" rows naming WB (wsl-2, -7, -8, -9, -10, -11, -15, -16, -20, -23, integration-13, -17, -20).

## Goal
Replace R12's blanket refusal of WSLg windows with real identification: an in-distro AT-SPI sidecar per distro with a
Linux app on screen, a router that merges its windows into the Windows perception with mapped coordinates, the Linux
vocabulary for WSLg apps, launching WSLg apps through their shortcuts, and tier 1 actions and screenshots in them, with
every unidentified RAIL window (and every Windows X server's window) still refused and masked.

## Start and merge
Starts when S0b has merged (its sidecar, perception and policy hooks are yours to use). Use a fake `WslService` until WA
merges. Merges after SC, before AG.

## Files you own
- `app/main/wsl/{routed-sidecar,routed-windows,privacy}.ts` (S0a stubs), `app/main/wsl/{router,launch-sidecar,match,rail,apps}.ts`
- `app/main/policy/target-rules.ts` (S0a stub)
- `test/unit/wsl-{match,router,routed-sidecar,routed-windows,privacy,apps,rail}.test.ts`, `test/unit/target-rules.test.ts`

## Shared files you may touch (minimally; list every hunk)
- `sidecar/atspi/ember_atspi.py` and `sidecar/atspi/test_ember_atspi.py`: the opt-in additions of §4.3 only (behind
  `EMBER_ATSPI_FIND_BUS`; the Linux sidecar is byte-for-byte unchanged without it): `find_bus`, the probe child mode,
  `program`/`argv0`/`argv1`/`comm`, `status` fields, the POLLHUP watchdog.
- `app/main/policy/remote-surface.ts` (+ `test/unit/remote-surface.test.ts`): `vcxsrv`, `x410`, `xming`, `xwin`, `gwsl`
  in `REMOTE_SURFACE.win32`.
- `app/shared/apps.ts`: `friendlyApp` for `wsl:<distro>:<app>`.
- `scripts/package/layout.mjs` + `test/unit/layout.test.ts`: the win32 `sidecarFiles` entry for `ember_atspi.py`
  (I-win's packaging path: two lines, agreed through the lead; integration-13).
- `.github/workflows/remote.yml`: the `wslg-probe` job's set-up only.

## Contracts you implement (normative)

```ts
/** UIA's sidecar, or one that also reads WSLg windows through each distro's sidecar. */
export function wrapForWsl(base: AtspiSidecar, o: WrapForWslOptions): PerceptionSidecar & SidecarPort;

/**
 * The Windows window system, with the program name (`wmClass`) of every RAIL window the router identified rewritten to
 * "wsl:<distro>:<app>" (critique wsl-2). Main passes the result as Perception's `x11`, to the hands' window lists and to
 * `currentWindow`/`activeWindow`. Unidentified RAIL windows keep "msrdc", so the existing `isRemoteSurface` check keeps
 * masking and refusing exactly those. A Proxy like `platform/compose.ts`'s system-dialog wrapper: every other member is
 * the backend's own (I-win's extras survive).
 */
export function wrapWindowsForWsl(ws: WindowSystem, o: WrapForWslOptions): WindowSystem;

export interface WrapForWslOptions {
  os: OS;
  log: Logger;
  /** The Windows window system (its stack: HWND, pid, title, bounds, owner). */
  ws: () => PerceptionWindows | null;
  wsl: () => WslService | null;
  settings: SettingsStore;
}
```

```ts
/** The PC's privacy and terminal checks, extended so a `wsl:<distro>:<app>` window is also judged as a Linux app. */
export function wslAwarePrivacy(p: { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean }):
  { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean };
```

```ts
export function wslAwareSystem(sys: SystemPlatform): SystemPlatform;   // swaps in withWslApps (§4.8)
export function withWslApps(apps: AppCatalog, o: { wsl: () => WslService | null; log: Logger }): AppCatalog;
export function wslgLaunch(argv: string[]): { distro: string | null; cwd: string | null; argv: string[] } | null;
export function targetRules(r: ActionRequest, os: OS): Decision | null;     // the wsl: tier-3 refusal (§4.5)
```

## Contracts you consume

```ts
/** One WSL distro as Ember sees it. */
export interface WslDistro {
  name: string;
  /** 1 or 2 (WSL1 runs no WSLg). */
  version: 1 | 2;
  isDefault: boolean;
  /**
   * The distro's default user id **as the distro itself reports it** (`id -u` in the facts script, or the in-distro
   * sidecar's status): 0 means root (WSLg acting refused, every command asks). null: not known yet (not running since
   * Ember started). The registry's DefaultUid is a hint for listing only: an imported distro's /etc/wsl.conf
   * `[user] default=` wins over it (critique wsl-7).
   */
  defaultUid: number | null;
  running: boolean;
  /** Its first-run set-up (user creation) hasn't happened yet: Ember never starts it (critique wsl-19f). */
  needsSetup: boolean;
  /** A tool's own distro: "podman" (commands only, every command asks). Docker's and Rancher's are never listed. */
  tool?: "podman";
}

/** What WSL looks like on this PC. */
export interface WslFacts {
  installed: boolean;
  /** The wsl.exe Ember runs (Store/MSI WSL's, else the inbox one). */
  wslExe: string | null;
  /** docker-desktop*, rancher-desktop* are never listed. */
  distros: WslDistro[];
  /**
   * WSLg can be there: the Store/MSI WSL (wslVersion !== null), some distro of version 2, and no `guiApplications=false`;
   * confirmed per distro by the sidecar's `status.wslg` (/mnt/wslg exists). The inbox WSL never has WSLg (critique wsl-21).
   */
  wslg: { available: boolean; disabledByUser: boolean; version: string | null };
  /** "2.3.26.0" from `wsl --version`; null for the inbox WSL. */
  wslVersion: string | null;
}

/** WSL for Ember (createWsl in app/main/wsl/service.ts; null off Windows). */
export interface WslService {
  facts(o?: { refresh?: boolean }): Promise<WslFacts>;
  /** Cheap: the last facts' running set, refreshed at most every 2 s on demand. */
  isRunning(distro: string): boolean;
  /** The running set read now, uncached (`wsl --list --running --quiet`, filtered to known names). */
  runningNow(): Promise<Set<string>>;
  /** The command runner for a distro (§4.2). */
  runner(distro: string): CommandRunner;
  /** The distro's default uid as the distro reports it; asked only when it is running (never boots it). */
  defaultUid(distro: string): Promise<number | null>;
  /** The Windows side's facts for nested cmd/PowerShell and Windows-form paths (§3.4.5). */
  windowsContext(): WindowsContext;
  /** sha256 of /proc/sys/kernel/random/boot_id of each running WSL2 distro (SA's same-machine rule, §5.1.14). */
  bootIds(): Promise<string[]>;
  onChange(fn: (f: WslFacts) => void): () => void;
  doctorRows(): Promise<PlatformDoctorRow[]>;
  dispose(): void;
}
```

`SidecarLaunch.mayStart`/`noRevive` and `AtspiSidecar.ownsId` (S0b), `PerceptionSidecar`/`SidecarPort` (S0a ports),
`isWslgImage` (`remote-surface.ts`), the win32 window stack (`PerceptionWindows`), `win32/system/lnk.ts`'s parser
(imported, never edited), `hands/terminals.ts`'s `WRAPPERS`, `linuxIsTerminal`, `isSecurityWindow`.

## What to build
- **Launch and lifecycle** (§4.3): one `AtspiSidecar` per distro with a WSLg window on screen, the exact `SidecarLaunch`
  (under the job host, `python3 -I`, `WSLENV=EMBER_ATSPI_ID_BASE/u`, `mayStart`, `noRevive`), the script path through
  `wslpath` on stdin, never started for a uid-0 distro (the sidecar's own `status.uid`), stopped after 60 s without a
  RAIL window, never revived until an uncached `runningNow()` lists the distro.
- **Bus** (§4.3 item 1): candidates from environs, runtime sockets and X root properties; no activation; scoring by
  RAIL title matches through `find_bus { titles }`; `bus: "none"` otherwise; re-scan on unmatched RAIL windows.
- **Router** (§4.4): `listWindows`, `readWindow`, element methods by `ownsId`, `atPoint` with the inverse map,
  `secretFields` mapped; never a Windows pid into a distro; `wrapWindowsForWsl` rewriting `wmClass` of identified RAIL
  HWNDs (unidentified stay "msrdc", still masked by `isRemoteSurface`).
- **Matching** (§4.9): normalised titles (`[WARN:…]`, trailing ` (<distro>)`, NFC, long-title prefix), the content box,
  the inset model, k in [0.5, 4] snapped to 1/8 with both axes agreeing, the self-check, ambiguity → identity only or
  unidentified, 2 s cache; popups inherit identity for masking and covering only (§4.6).
- **Identity and policy** (§4.5): `wsl:<distro>:<exe basename>`; the privacy union over every Linux name (exe,
  argv0/argv1, AT-SPI name, comm, 15-byte truncations); never-look defaults; the tier-3 refusal in `targetRules`.
- **Capture** (§4.7): masks with mapped bounds; a window without a transform masked whole only when it has (or may have)
  secret fields.
- **Launching** (§4.8): `withWslApps` judging `wslg.exe` shortcuts' Linux argv (the token rule after `--`), launching
  via `explorer.exe "<.lnk>"`.
- **Doctor rows** `wsl-helper:<distro>` and `wsl-a11y:<distro>` (§8.8) with their fix (through WA's runner).
- **Needs from I-win** (report it, don't edit): the owner-chain pointer check and the scancode text path for RAIL
  targets (§4.7).

## Tests
- Unit (OS-neutral, fakes for the stack, the sidecars and WSL): §10.1's WB row in full (matcher fixtures: GTK3/GTK4 CSD,
  Weston frames, 100/125/150/200 % and 1.25, negative origins, `[WARN:COPY MODE]`, truncated titles, popups; routing by
  `ownsId`; no Windows pid into a distro; identified unmasked / unidentified masked; the vocabulary union incl.
  `gnome-terminal-`; `wslgLaunch` accept/reject incl. the token rule; tier 3 refused; X servers remote surfaces; uid-0
  sidecars never routed to).
- Python `test_ember_atspi.py`: `find_bus` scoring with fake candidates, the probe child, `program`/`argv*`, `uid`, the
  watchdog with POLLHUP; all behind the variable; the existing tests unchanged.
- `wslg-probe` (records artefacts only, `EMBER_WSL_TEST=1`).

## Acceptance criteria
- `npx tsc --noEmit`, `npm run lint`, `npm test` (incl. the Python sidecar tests) pass on Linux.
- With WSL off, off Windows, or with no WSLg window on screen, every wrapper passes through unchanged and the Linux
  sidecar behaves exactly as before.
- Every unidentified RAIL window and every X server window is still refused (except reading/open_app) and masked.
