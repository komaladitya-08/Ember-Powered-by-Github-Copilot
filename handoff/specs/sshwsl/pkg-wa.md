# Package WA: WSL discovery and WSL commands

Read first: `specs/pkg-common.md`, `specs/sshwsl/pkg-common.md`, `specs/sshwsl/decisions.md` (D1, R3, D4.6, D4.8), then
`specs/sshwsl/design.md`: header, "Limitations and departures" (L10, L17, L19, L22), §2.2 (WSL targets), §3.3 (the WSL
rows, `WSL_EVAL`, `EMBER_INNER`, `EMBER_CMD_B64`, the job host), §3.4.5 (what CL does with your `WindowsContext`), §3.6
(`inspect`), §3.7 (`gitFacts`), §3.13 (the WSL ladder and the sweep), §4.1-§4.2, §5.1.14 (the boot-id read SA asks you
for), §8.7-§8.8 (WSL messages and doctor rows), §10.1-§10.2 (WA rows), §11.4 (WA row), "Critique resolutions" rows
naming WA (wsl-1, -4, -7, -12, -16, -17, -18, -19, -21, -22).

## Goal
Know which WSL distros exist and which run, without ever booting one by accident; and run commands inside a distro
exactly like the local runner does (PTY through util-linux `script` when present, the command text never on any argv,
the job host holding wsl.exe, the in-distro sweep before wsl.exe is killed). Windows only at run time; every module
imports cleanly on Linux (tests run there with fakes).

## Start and merge
Starts when S0a has merged. Merges after UI, before SA.

## Files you own
- `app/main/wsl/{service (S0a stub),discover,decode,lxss,runner,doctor}.ts`
- `test/unit/wsl-{decode,discover,lxss,runner}.test.ts`, `test/integration/wsl.test.ts`

## Shared files you may touch
- `.github/workflows/remote.yml`: the `wsl-windows` and `wsl2-windows` jobs' set-up steps only.

## Contracts you implement (normative)

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

```ts
export function createWsl(o: { log: Logger; env: NodeJS.ProcessEnv; os: OS; ember: { winPaths: string[] }; jobHost: JobHostRef | null }): WslService | null;
```

`WslService.runner(distro)` returns a `CommandRunner` (§3.1: `facts`, `inspect`, `gitFacts`, `start`, `stopAll`,
`running`), and `windowsContext()` the `WindowsContext` (§3.1) built from `o.env` and Ember's own Windows paths.

## Contracts you consume (normative)

```ts
/** Flags that keep each POSIX shell from reading profile or rc files. */
export const NO_RC: Readonly<Record<"bash" | "zsh" | "sh", readonly string[]>> = { bash: ["--noprofile", "--norc"], zsh: ["-f"], sh: [] };

/**
 * What every POSIX run does first: globbing on, no pager waits for keys (git log in a PTY would otherwise start less),
 * a UTF-8 locale when none is set, then the start marker (an OSC sequence output shaping strips; a run whose output
 * ends without it failed to start: its stderr is the reason, §3.13). One line, no single quote, no tab, no run of
 * spaces: it is embedded in single-quoted -c text and split and re-joined by WSL_EVAL.
 */
export const POSIX_PRELUDE = 'set +f; export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat; [ -n "$LANG" ] || export LANG=C.UTF-8; printf "\\033]777;ember-start\\007"';

/**
 * The body every POSIX run executes: the prelude, the command text read and unset first (from EMBER_CMD, or decoded
 * from EMBER_CMD_B64 for WSL), the PTY's size set inside script(1) (whose PTY starts without one), then `eval "$c"`,
 * which runs the text exactly as `bash -c "$c"` would (same parser, here-docs and `exit` included).
 */
export function posixBody(o: { pty: boolean; from: "env" | "b64" }): string;
// from "env": 'c=$EMBER_CMD; unset EMBER_CMD'
// from "b64": 'c=$(printf %s "$EMBER_CMD_B64" | base64 -d) || exit 126; unset EMBER_CMD_B64'
// then: 'unset BASH_ENV ENV'; pty: 'stty cols "$EMBER_COLS" rows "$EMBER_ROWS" 2>/dev/null; unset EMBER_COLS EMBER_ROWS'
// then: 'eval "$c"'; joined with "; " after POSIX_PRELUDE.

/**
 * The text script(1) runs with /bin/sh -c: exec the chosen shell (its absolute path from RunnerFacts.shellPaths, made
 * only of [A-Za-z0-9/._-], else the run fails to start) without rc files on posixBody({ pty: true, from }).
 */
export function posixInner(shell: "bash" | "zsh" | "sh", shellPath: string, from: "env" | "b64"): string {
  return `exec ${shellPath} ${NO_RC[shell].join(" ")} -c '${posixBody({ pty: true, from })}'`.replace(/ {2,}/g, " ");
}

/**
 * What WSL runs as its -c text: no quote or backslash in it, so Windows' argument quoting and wsl.exe's own parsing
 * can't change it (critique wsl-18). EMBER_INNER (posixInner(…, "b64") or posixBody({ pty: false, from: "b64" }))
 * arrives through WSLENV; `set -f` keeps the split words from globbing before eval re-parses them.
 */
export const WSL_EVAL = "set -f; eval $EMBER_INNER";

/** PowerShell's fixed launcher (§3.3, critique integration-10). */
export const PS_INNER =
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = New-Object Text.UTF8Encoding $false }; " +
  "$s = [ScriptBlock]::Create($env:EMBER_CMD); Remove-Item Env:\\EMBER_CMD -ErrorAction SilentlyContinue; " +
  "$global:LASTEXITCODE = 0; & $s; $ok = $?; $c = $LASTEXITCODE; if ($c) { exit $c } elseif (-not $ok) { exit 1 }";
```

From RUN (or written directly from §3.3 if RUN hasn't merged: say which): `jobHostArgv`, `commandEnv`, `sweepScript`.
From CL: `trackSecretPrompts` (§3.11).

## What to build
- **Discovery** (§4.1): wsl.exe location; the Lxss registry through your own lazily bound advapi32 functions (koffi,
  read-only, never `koffi.view()`), with `RunOOBE`; the `--list --verbose` fallback with localised headers; the
  running set filtered to known names; `--version`; WSLg availability (Store/MSI WSL only); hidden Docker/Rancher
  distros; Podman as `tool`; 5 s timeouts for listing, 30 s for anything that may boot; UTF-16LE/UTF-8 decoding; the
  60 s cache; `runningNow()` uncached.
- **Facts** (§4.2): the FACTS script on stdin to `wsl.exe -d <d> --cd ~ --exec /bin/sh -s` under the job host;
  `mountRoot` from `wslpath -u 'C:\'`/`findmnt`; `interop` from `WSLInterop*` or `$WSL_INTEROP`; util-linux `script`
  only; `python3` and `base64` flags; the uid from inside becomes `defaultUid` (authoritative); `privileged` = uid 0.
- **Runner**: argv per §3.3's two WSL rows (job host + wsl.exe + `WSL_EVAL`), environment `WSL_UTF8=1`, `EMBER_INNER`,
  `EMBER_CMD_B64`, `EMBER_RUN_ID`, `EMBER_COLS`, `EMBER_ROWS`, `TERM`, and `WSLENV` **replaced** with exactly those; a
  cwd with `"`, `\` or a control character → failed to start; the start marker → started, else `failed-to-start` with
  decoded stderr; `inspect` and `gitFacts` with the fixed stdin scripts of §4.2; the ladder of §3.13 for WSL (`\x03`
  through the job host's stdin, in-distro sweeps INT/TERM/KILL, the job host last); "Starting Ubuntu…" while a distro
  boots.
- **Never** from Ember's own code: `-u/--user`, `--terminate`, `--shutdown`, `--unregister`, `--import`, `--export`,
  `--set-default`; never start a distro with `needsSetup`; never `wsl.exe -u root`.
- **Doctor** (§8.8 `wsl` row; WB owns the per-distro helper rows; the `wsl-a11y` fix runs through your runner's fixed
  argv when WB asks).
- **Boot ids** for SA's same-machine rule: `WslService.bootIds()` for running WSL2 distros (fixed stdin script hashing
  `/proc/sys/kernel/random/boot_id`; never boots a distro).

## Tests
- Unit (OS-neutral; fake spawn and a fake registry): decoding (UTF-16LE with/without BOM, UTF-8, CRLF, empty, error
  exits); `-l -v` with German and Japanese fixtures; the "none running" sentence ignored; hidden and tool distros;
  `RunOOBE`; FACTS parsing (`WSLInterop-late`, mount root, util-linux check, python3/base64); runner argv, environment
  and `WSLENV` replacement, `WSL_UTF8`, the 30 s boot timeout, the start marker; fixed scripts only on stdin; the WSL
  ladder order with fake timers.
- Integration `test/integration/wsl.test.ts` (`EMBER_WSL_TEST=1`; jobs `wsl-windows` (WSL1) and `wsl2-windows` (WSL2,
  non-root default user)): discovery on the real wsl.exe, facts, the runner with `script`, `\x03` and the sweep,
  `inspect`, WSLENV replacement, a multi-line command through `EMBER_CMD_B64`, the uid from inside vs the registry's,
  `RunOOBE`'s value name, interop children inside the job, and L22's check (the framed stream binary-safe through
  `wsl.exe --exec /usr/bin/ssh`, with SA's test file if it has merged).

## Acceptance criteria
- `createWsl` exactly as above (null off Windows); `npx tsc --noEmit`, `npm run lint`, `npm test` pass on Linux.
- No module touches `app/main/platform/win32/**`; koffi only lazily, only on Windows.
- Nothing in discovery boots a distro; a stopped distro starts only for a command the user's task runs there.
