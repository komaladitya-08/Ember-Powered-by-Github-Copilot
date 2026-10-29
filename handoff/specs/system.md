# Spec: OS integration outside windows/input (Linux → Windows 10/11 + macOS 13+)

Repo: `/home/user/Ember-Powered-by-Github-Copilot` (HEAD `b67b02e`). All `file:line` references are to that tree.
Scope: apps catalog and launching, comfort settings, user settings and paths, admin policy, autostart, audit sink,
GitHub sign-in (gh, safeStorage), Copilot runtime location, logging, environment checks, `ember --doctor`, the
screen-reader and reduced-motion probes, voice (models, speaker monitor, mic, TTS), prompt and UI copy, never-look,
security-window and terminal vocabularies, and shortcut wording. Windows, input, capture, the sidecar protocol and the
desk are covered by the sibling specs (`window-system.md`, `input.md`, `sidecar-*.md`). Where this subject depends on
their choices, it says so.

Naming assumptions shared with the sibling specs:
- **Sidecar `app`** (AxWindow.app, used as `ActionRequest.app`): Windows = image file name **with** `.exe`
  (`notepad.exe`, UWP: the hosted CoreWindow's exe such as `CalculatorApp.exe`). macOS = `localizedName`
  (`TextEdit`, `iTerm2`). See `sidecar-consumers.md` §9.
- **Window stack `wmClass`**: Windows = `"<exe base> <window class>"` (`"notepad Notepad"`). macOS =
  `"<bundle id> <app name>"`. See `window-system.md` §450-453.
- Every vocabulary below must therefore match `cmd`, `cmd.exe`, `CMD.EXE`, `com.googlecode.iterm2` and `iTerm2`
  alike. Matching is lower-cased and done on `.`/`-`/`_`/space-split words.

Legend: **[W]** Windows, **[M]** macOS, **[L]** Linux (unchanged), **verify** = must be confirmed on a real machine
before it ships.

---

## 1. The interface

Put every OS-specific piece below behind one object chosen at start-up by `process.platform`
(`app/main/platform/index.ts` → `linux.ts`, `win32.ts`, `darwin.ts`). Pure helpers (desktop-file parsing,
`execArgv`, terminal heuristics) stay where they are and stay unit-tested on every OS, because their inputs are
injected.

```ts
// app/main/platform/system.ts
export type OS = "linux" | "win32" | "darwin";

export interface SystemPlatform {
  readonly os: OS;
  /** Wording for prompts, UI and doctor (section 13). */
  readonly words: PlatformWords;
  /** Global shortcuts: Electron accelerators plus how to show and say them (section 14). */
  readonly shortcuts: ShortcutTable;
  readonly paths: SystemPaths;                    // section 3
  readonly apps: AppCatalog;                      // section 2
  /** Empty map = no change_setting tool at all (z.enum([]) throws). Section 2.6. */
  readonly settings: SystemSettings;
  readonly adminPolicy: AdminPolicySource;        // section 4
  readonly autostart: Autostart;                  // section 5
  /** undefined: no system log copy here. Section 6. */
  auditSink(onError: (err: unknown) => void): ((line: string) => void) | undefined;
  /** Absolute path of a usable `gh` (or null). Section 7. */
  ghCliPath(): string | null;
  /** Cross-platform which: path.delimiter, PATHEXT on win32, extra dirs on darwin. Section 7.3. */
  which(cmd: string, o?: { extraDirs?: string[] }): string | null;
  /** Default options for every execFile/spawn of a helper (win32: { windowsHide: true }). Section 15. */
  readonly spawnDefaults: { windowsHide?: boolean };
  /** Inputs for inspectEnvironment (section 9). Must be cheap: getStatus calls it every time. */
  environment(): EnvInputs;
  /** Setup-check fixes this platform offers, and how to apply them (section 9.4). */
  readonly fixes: { ids: readonly FixId[]; apply(fix: FixId): Promise<void> };
  /** Extra probes for `ember --doctor` (section 10). */
  doctorProbes(): Promise<PlatformDoctorProbes>;
  readonly a11y: {
    /** A real screen reader is running (Orca/Narrator/NVDA/JAWS/VoiceOver). Cached ≤ 60 s. Section 11.1. */
    screenReaderOn(): boolean;
    /** The OS asks for less motion. Section 11.2. */
    systemReducedMotion(): boolean;
  };
  readonly voice: VoicePlatform;                  // section 12
  /** never-look defaults and their on-screen names (section 16). */
  readonly privacy: { neverLookDefaults: readonly string[] };
}

export interface AppCatalog {
  list(): DesktopApp[];                           // cached; ≤ 1 s cold on every OS
  launch(app: DesktopApp): void;                  // throws for terminals; detached; never inherits Ember's env
  isTerminalApp(app: AppIdentity): boolean;       // section 2.4 / 16.3
  hasBuiltInShell(app: AppIdentity): boolean;
  /** Lower-case names this app's windows report as `app`/`wmClass` words (worker.ts:698 programsOf). */
  programsOf(app: DesktopApp): Set<string>;
}

export interface SystemSettings {
  /** name → description shown to the model (worker.ts:964). Only names this OS can really change. */
  readonly available: Partial<Record<SettingName, string>>;
  /** Same contract as hands/system.ts:87: set, read back, return decoded before/after. Throws a plain-words Error. */
  change(name: SettingName, value: string): Promise<{ before: string; after: string }>;
}

export interface AdminPolicySource {
  /** Where the doctor and settings window say the policy lives ("/etc/ember/policy.json", "HKLM\\…", …). */
  readonly location: string;
  /** Same result shape as admin.ts:83 loadAdminPolicy (fail closed on anything untrusted). */
  load(devOverride?: string): LoadedAdminPolicy;
}

export interface Autostart {
  /** Make the OS state match `on`. Returns true when it changed something. Never called if already in step. */
  sync(on: boolean): boolean;
  /** Was this run started at login? (argv --autostart, or macOS wasOpenedAtLogin). */
  launchedAtLogin(argv: string[]): boolean;
  /** For the settings window: e.g. macOS "requires-approval", Windows "disabled in Task Manager". */
  status?(): { on: boolean; note?: string };
}
```

`DesktopApp` (hands/system.ts:97-105) gains two optional fields. Old callers keep working.

```ts
export interface DesktopApp {
  id: string; name: string; file: string; keywords: string[]; exec?: string;
  generic?: string; categories?: string[]; terminal?: boolean;
  /** Pre-split argv. On win32/darwin it is ALWAYS set and `exec` is left undefined (see 2.3). */
  argv?: string[];
  /** Window-name words for programsOf (win32: exe base names; darwin: bundle id, CFBundleName, CFBundleExecutable). */
  programs?: string[];
}
type AppIdentity = Pick<DesktopApp, "id" | "name"> & Partial<Pick<DesktopApp, "exec" | "argv" | "categories" | "terminal">>;
```

**Invariant:** every consumer that calls `execArgv(app.exec)` today must use `app.argv ?? execArgv(app.exec ?? "")`:
`programsOf` (worker.ts:699), `hasBuiltInShell` (system.ts:306), `isTerminalApp` → `runsTerminal`
(system.ts:322), the `launchApp` fallback (system.ts:486) and `deskRecipe` (desk/place.ts:146, Linux only).
`execArgv` uses GLib rules: a backslash outside quotes escapes the next character, so `C:\Windows\notepad.exe`
becomes `C:Windowsnotepad.exe`, and `"\\server\share"` loses a backslash. Never feed it a Windows command line.

---

## 2. Apps and comfort settings: `app/main/hands/system.ts`

### 2.1 What is there and who calls it

| Export | Lines | Linux-specific part | Callers |
|---|---|---|---|
| `SETTINGS`, `SettingName` | 15-24 | GNOME names ("top bar") | worker.ts:29, :964-972 (tool text, `z.enum(Object.keys(SETTINGS))`, the audit value `${SETTINGS[a.setting]} → ${value}`) |
| `changeSetting` | 86-95 (+ `run` 11-13, `hasKey` 28-30, `locate` 33-59, `darkTheme` 65-73, `installedThemes` 76-84) | `gsettings` CLI, GNOME schemas, GTK theme dirs | worker.ts:970 |
| `parseDesktopFile` | 113-133 | XDG Desktop Entry | `listApps`, tests (desk.test.ts, tasks.test.ts) |
| `TERMINALS`, `SHELLS`, `INTERPRETERS`, `SHELL_MODULES`, `SHELL_APP*`, `WRAPPERS`, `REFUSED`, `FLATPAK_VALUE` | 136-187 | Linux program names | `isTerminalApp`, `hasBuiltInShell` |
| `hasBuiltInShell` | 303-308 | — | desk/place.ts:144 |
| `isTerminalApp` | 317-323 | — | worker.ts:979, :1007 (open_on_desk/open_app refusal), main.ts:1251 (policy `isTerminalApp: name => isTerminalApp({ id: name, name })` with the sidecar's `app`), desk/place.ts:145, `findApp` scoring :399 |
| `listApps` | 325-342 | `$XDG_DATA_HOME`/`$XDG_DATA_DIRS`/applications/*.desktop | worker.ts:977, :1005 |
| `findApp` | 364-408 | ranks on GenericName/Keywords/Categories (XDG) | worker.ts:977, :1005 |
| `appEnv` | 425-432 (+ `KEEP` 411, `SESSION` 413, `NEVER` 415) | Linux variable names; regexes are case-sensitive | `launchApp`, desk/desk.ts:22, eval/src/gates.ts:16, eval/src/runner.ts:24 |
| `execArgv` | 439-472 | GLib `g_shell_parse_argv` rules | programsOf (worker.ts:699), place.ts:146, `runsTerminal`, `envCommand` |
| `launchApp` | 483-495 (+ `launchCwd` 480) | `gtk-launch <id>`, fallback spawn of Exec | worker.ts:1017 |

Invariants the callers rely on:
- `launchApp` throws **synchronously** for terminals (system.ts:484). It is fire-and-forget: errors after spawn are
  swallowed (:489). The worker polls `perception.windows()` 40 × 250 ms for a new window whose `app.toLowerCase()`
  is in `programsOf(app)`, or whose title contains `app.name` (worker.ts:1011-1024). After 8 polls it accepts an
  existing window of the program.
- `cwd` is the user's home (system.ts:480; test/unit/launch-app.test.ts:15-26).
- The child gets **only** `appEnv()`. Ember's tokens (`GH_*`, `GITHUB_*`, `COPILOT_*`, `*_TOKEN`), `EMBER_*` and
  `ELECTRON_*` never reach an app (system.ts:415-428; desk.test.ts:442-470).
- `findApp` never lets a terminal win a tie (score −2, system.ts:399).
- The policy treats `kind: "setting"` and `"open_app"` as **reversible, allowed without asking** (policy.ts:1852).
  Every setting offered must stay a harmless comfort setting. Never add anything security-relevant.

### 2.2 App catalog [W]

Sources, merged by display name. Earlier sources win.
1. **Start Menu shortcuts**: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\**\*.lnk` (per user) and
   `%ProgramData%\Microsoft\Windows\Start Menu\Programs\**\*.lnk` (all users). Use `app.getPath("appData")`
   for the first, `process.env.ProgramData` for the second (read-only listing, so trusting the variable is fine
   here). For each `.lnk` call `shell.readShortcutLink(path)` (Electron, Windows only; electron.d.ts:14079), which
   returns `{ target, args, cwd, description, appUserModelId }`. Skip shortcuts whose target is not `.exe`
   (uninstallers: names matching `/^uninstall|uninstall$/i`, targets `unins\d+\.exe`, `msiexec.exe`), and
   `.url` files.
   - `id` = the lnk path relative to Programs, without `.lnk`, with `\` → `/` (stable and unique). `name` = the
     lnk base name. `file` = the lnk path. `keywords` = `[description]` lower-cased.
     `argv` = `[target, ...CommandLineToArgvW(args)]` (a small TS port of the MSVCRT rules: `\` is literal unless
     it precedes `"`). `programs` = `[basename(target) without .exe]` lower-cased.
2. **Packaged (UWP/MSIX) apps and system apps** that have no `.lnk` (Settings, Calculator, Notepad and Paint on
   Windows 11, Photos, Terminal, Store): `Get-StartApps` (PowerShell 5.1, StartLayout module). It returns
   `Name` and `AppID` for every Start entry, Win32 included. Run once with
   `powershell.exe -NoProfile -NonInteractive -Command "Get-StartApps | ConvertTo-Json -Compress"`
   (`windowsHide: true`, ~1 s) and cache it for 5 minutes. A better option: let the UIA sidecar expose a
   `list_apps` method (`Shell.Application` → `NameSpace("shell:AppsFolder").Items()`) so no second PowerShell is
   started. `id` = AppID (e.g. `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`), `file` = `shell:AppsFolder\<AppID>`,
   `argv` = `[]`. Optionally fill `programs` from the package's `AppxManifest.xml` `<Application Executable=…>`
   (`Get-AppxPackage`). Without it, open_app falls back to the title match, which works for "Calculator".
3. Add `generic` for well-known apps so the model's everyday words resolve (findApp tiers 95/90 use it):
   explorer → "file manager" (with keywords "files", "folders"), notepad → "text editor", msedge/chrome/firefox →
   "web browser", outlook/olk → "email", winword → "word processor", excel → "spreadsheet", powerpnt →
   "presentation", mspaint → "image editor", `windows.immersivecontrolpanel…` (Settings) → "settings",
   CalculatorApp → "calculator".

Launch (replaces `gtk-launch`): **ask the running shell to launch it**, as gtk-launch asks the desktop:
`spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [app.file], { detached: true, stdio: "ignore", windowsHide: true, cwd: os.homedir(), env: appEnv() })`.
`app.file` is the `.lnk` path or `shell:AppsFolder\<AppID>`. The new explorer.exe hands the request to the
running Explorer and exits (exit code 1 is normal: ignore it). The app then starts with **Explorer's**
environment, not Ember's. That keeps the "no tokens to apps" invariant and honours the lnk's working directory,
arguments and run-as settings. **Do not use `shell.openPath`/`ShellExecute`** from Ember's process: the child
would inherit Ember's environment block (the token and EMBER_* variables). Alternative with the same
property: the sidecar calls `Shell.Application.ShellExecute` (it runs inside Explorer). **verify** with Process
Explorer that the started app's environment has no `EMBER_*`/`GH_TOKEN`. There is no pid. That is fine: open_app
matches by program and title, and open_on_desk is Linux-only.

`appEnv` on win32 (still used by the explorer.exe spawn and the eval harness):
- The regexes must be **case-insensitive** on win32. `Object.entries(process.env)` returns the stored case
  (`Path`, `SystemRoot`), so `KEEP.test("Path")` is false today and an app would start **without PATH**.
- Add to KEEP: `SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles(\(x86\))?|CommonProgramW6432|PUBLIC|ALLUSERSPROFILE|OS|PROCESSOR_[A-Z_]+|NUMBER_OF_PROCESSORS|COMPUTERNAME|SESSIONNAME|LOGONSERVER|USERDNSDOMAIN|DriverData|OneDrive(Commercial|Consumer)?`.
- SESSION adds nothing on win32. NEVER stays (with `/i`).

### 2.3 App catalog [M]

Sources: `/Applications`, `/Applications/Utilities`, `/System/Applications`, `/System/Applications/Utilities`,
`~/Applications`, `/System/Library/CoreServices/Finder.app` (one level deep, plus `*.app` inside one sub-folder
such as `/Applications/Microsoft Office/`). For each `*.app` read `Contents/Info.plist`. It is often a **binary
plist**: add a small reader for both `bplist00` and XML (about 150 lines), or call
`/usr/bin/plutil -convert json -o - <file>` (one process per app, about 2 s for 200 apps, so cache it). Fields:
`CFBundleIdentifier`, `CFBundleDisplayName`/`CFBundleName`, `CFBundleExecutable`, `LSApplicationCategoryType`,
`LSUIElement`/`LSBackgroundOnly` (skip those).
- `id` = bundle id, `name` = the `.app` file name without the extension (Finder shows the localized name, but the
  file name is stable and English for Apple apps). `file` = the `.app` path.
  `argv` = `[<app>/Contents/MacOS/<CFBundleExecutable>]`.
  `programs` = `[bundleId, CFBundleName, CFBundleExecutable]` lower-cased, so it matches both `localizedName`
  (sidecar) and the bundle-id word of `wmClass`.
- `generic`: Finder → "file manager", TextEdit → "text editor", Safari → "web browser", Mail → "email",
  System Settings → "settings", Numbers → "spreadsheet", Pages → "word processor", Keynote → "presentation",
  Preview → "document viewer", Calculator → "calculator".
- Spotlight (`mdfind`) is an alternative, but it may be disabled on managed Macs. Do not depend on it.

Launch: `execFile("/usr/bin/open", ["-a", app.file], { env: appEnv() })`. LaunchServices starts the app with
launchd's environment, never `open`'s own, so the env invariant holds by construction. A non-zero exit code means
not found. Report it through the existing "window hasn't appeared" path. A downloaded app's first launch shows
the Gatekeeper prompt (CoreServicesUIAgent). That window is security-only (16.2).

### 2.4 Terminal and shell detection on Windows and macOS

`isTerminalApp`/`hasBuiltInShell` keep their structure. Changes:
- `named()` (system.ts:190) also strips `/\.(exe|com|bat|cmd|ps1|lnk|app)$/i`.
- `idIsTerminal` (:295) also tests `SHELLS` and `INTERPRETERS` on each id word. Today a window whose app is `pwsh`,
  `bash` or `powershell` is **not** a terminal: `SHELLS` is only consulted on Exec argv (:278).
- `idWords` (:294) also splits on `!` and `_` (UWP AppIDs: `Microsoft.WindowsTerminal_8wekyb3d8bbwe!App`).
- The name test (:321) becomes `/\b(terminal|console|command prompt|powershell|anaconda prompt|git bash|developer (command prompt|powershell))\b/i`.
- The vocabulary additions are in section 16.3. `REFUSED` additions [W] (argv[0] base names): `runas|psexec(64)?|mshta|wscript|cscript|regsvr32|msiexec|cmstp|installutil|msbuild|forfiles|pcalua|schtasks|at|sc|reg|bitsadmin|certutil|wmic|conhost`.
  [M]: `osascript|open|launchctl|automator|shortcuts`.
- `runsTerminal` (:255-292) is mostly moot on Windows and macOS: there is no Exec line. On Windows, apply it to the
  lnk `argv` (a shortcut to `cmd.exe /k vsdevcmd.bat` is then refused through `named("cmd")`).
- `LAUNCHERS` (worker.ts:412, used by `programsOf` to drop names any window could share): add [W]
  `rundll32|dllhost|applicationframehost|javaw|pythonw|py|wscript|cscript|msiexec` and [M] `open|osascript|java`.
  **Do not** add `explorer`: File Explorer's windows belong to explorer.exe.

### 2.5 Windows File Explorer can run commands
Typing `cmd`, `powershell` or `wt` into File Explorer's **address bar** and pressing Enter starts a shell in that
folder. The same goes for the Run dialog, Task Manager's "Run new task", and Start/Search (type a name, then Enter).
GNOME has no such path, so the policy has no rule for it. Required (policy/worker owner):
- treat as terminal-equivalent (`never`): window title `Run` owned by `explorer` (class `#32770`), app
  `SearchHost`/`SearchApp`/`StartMenuExperienceHost`/`SearchUI`, app `Taskmgr` (or only its "Create new task"
  dialog), and on macOS app `Spotlight` and `Script Editor`/`Automator`/`Shortcuts` (16.3);
- refuse `type_text`/`fill` into File Explorer's address box (UIA AutomationId `41477`, or name "Address" inside
  `Address Band Root`) when the text, trimmed, is a bare program name or ends in an executable extension, or
  refuse typing into that box altogether (navigation still works by clicking).

### 2.6 Comfort settings: `changeSetting` / `SETTINGS`

Linux keeps gsettings (system.ts:28-95). Per platform, `SystemSettings.available` holds only what really works,
and the worker builds the tool only when the map is not empty (worker.ts:964-972). `z.enum([])` throws at
construction. The value grammar stays: `"on"/"off"/"true"/"false"/"yes"/"no"/"1"/"0"` or a number for
`text_size`. Results are `"true"`/`"false"` or the number.

| Setting | [W] | [M] |
|---|---|---|
| `dark_style` | **Yes.** `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` DWORD `AppsUseLightTheme` (0 = dark). Then broadcast `SendMessageTimeoutW(HWND_BROADCAST=0xFFFF, WM_SETTINGCHANGE=0x001A, 0, L"ImmersiveColorSet", SMTO_ABORTIFHUNG=2, 5000, &res)` so running apps switch. Read back with RegGetValueW. Leave `SystemUsesLightTheme` (the taskbar) alone. | **Yes.** `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'`. Needs **Automation** consent for Ember → System Events (TCC prompt on first use), Info.plist `NSAppleEventsUsageDescription`, and entitlement `com.apple.security.automation.apple-events` (hardened runtime). Read back with `/usr/bin/defaults read -g AppleInterfaceStyle` (`Dark`, or exit 1 = light). Don't trust `systemPreferences.getUserDefault` right after a change (cached). Map a denied consent (`-1743`) to "Ember isn't allowed to change the appearance: allow it in System Settings > Privacy & Security > Automation". |
| `text_size` | **verify.** `HKCU\Software\Microsoft\Accessibility` DWORD `TextScaleFactor` 100-225, so the range is 1-2.25 (reject < 1). It is unclear whether it applies without the Settings app's private broadcast. If not, leave it out. | No global equivalent: leave it out. |
| `night_light` | Leave it out. The state is an undocumented binary blob in CloudStore (`…bluelightreductionstate\Data`). | Leave it out. Night Shift is only reachable through the private `CoreBrightness` `CBBlueLightClient`. |
| `do_not_disturb` | **verify.** `HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications` DWORD `ToastEnabled`=0 hides all banners (it matches the description "hide notification banners"). Windows 11's own Do Not Disturb has no public API. Leave it out if the change doesn't apply live. | Leave it out. Focus has no public API. |
| `battery_percentage` | Leave it out (the Windows 11 toggle is not documented). | Leave it out. `defaults -currentHost write com.apple.controlcenter …` needs ControlCenter restarted. |
| `clock_seconds` | **verify.** `HKCU\…\Explorer\Advanced` DWORD `ShowSecondsInSystemClock`=1 plus a `WM_SETTINGCHANGE "TraySettings"` broadcast. Windows 11 23H2+ applies it live. Windows 10 needs Explorer restarted, so leave it out there. | Leave it out. `com.apple.menuextra.clock` needs ControlCenter restarted. |

Registry access [W]: use **koffi + advapi32**, not `reg.exe`. The "Prevent access to registry editing tools"
policy also blocks `reg.exe`, and each `reg.exe` call is a process start.
`RegGetValueW(HKEY, LPCWSTR subKey, LPCWSTR value, DWORD flags=RRF_RT_REG_DWORD(0x18)|RRF_RT_REG_SZ(0x2), DWORD* type, void* data, DWORD* cb)`,
`RegSetKeyValueW(HKEY, LPCWSTR subKey, LPCWSTR value, DWORD type=REG_DWORD(4), const void* data, DWORD cb)`.
**Gotcha:** predefined HKEYs are sign-extended pointers on 64-bit. Pass `HKEY_CURRENT_USER` as intptr
`-2147483647` (`0xFFFFFFFF80000001`) and `HKEY_LOCAL_MACHINE` as `-2147483646`, not `0x80000001`.

The tool description (worker.ts:964) and WORKER_RULES item 3 (worker-persona.ts:11) must be built from
`available`. Today the rule names all six settings unconditionally. SETTINGS descriptions say "top bar"
(system.ts:20-21), which is GNOME wording.

---

## 3. Paths and user settings: `app/main/settings.ts`, `app/main/main.ts:74-79`, `app/main/logger.ts`

| Item | Where | [L] | [W] | [M] |
|---|---|---|---|---|
| userData | main.ts:75-77 `app.setPath("userData", EMBER_USER_DATA ?? appData/ember)` | `~/.config/ember` | Today `%APPDATA%\ember` (Roaming). **Recommend `%LOCALAPPDATA%\Ember`** (`process.env.LOCALAPPDATA ?? home\AppData\Local`; Electron has no `getPath("localAppData")`). userData holds Chromium caches, `copilot/` session data (host.ts `baseDirectory`), logs, audit, `models/` (126 MB, voice.ts → main.ts:162) and desk profiles. All of that bloats roaming profiles. | `~/Library/Application Support/ember` (fine, or "Ember") |
| settings file | settings.ts:1-2 comment, home/main.ts:217 hard-codes `"~/.config/ember/settings.json"` in "facts" | — | real path | real path |
| logs | logger.ts:61 `<userData>/logs/ember.log` | ok | ok | optional `app.getPath("logs")` = `~/Library/Logs/ember` |
| File modes 0o700/0o600 | main.ts:79, settings.ts:355/359, logger.ts:65/90, audit.ts:23/37, auth.ts:49 | enforced | **ignored**: Windows has only the read-only bit. `%LOCALAPPDATA%` is per-user ACL'd, so nothing to do, but don't claim "0600" in docs. | enforced |

`SettingsStore.save` (settings.ts:354-373) on [W]:
- `fs.renameSync(tmp, file)` over an existing file fails with `EPERM`/`EBUSY`/`EACCES` while another process holds
  it without `FILE_SHARE_DELETE` (antivirus scans, sync clients, some editors). Retry 5× with a 50 ms backoff on
  win32 before throwing.
- The directory fsync (:371, `fs.openSync(dir, "r")`) throws `EISDIR` on Windows. It is already caught.
- mtime polling (`watch`, :284-288) works on NTFS.

Defaults that are Linux-specific (settings.ts):
- :46-47 `privacy.neverLook` default `["keepassxc","seahorse","passwords and keys","1password","bitwarden","polkit"]`
  must come from `platform.privacy.neverLookDefaults` (section 16.1). settings.ts is imported by renderers only as a
  type (overlay/main.ts:14, home/main.ts:11, handle/main.ts:8, preload/home.ts:3, shared/ipc.ts:4,
  shared/overlay.ts:5), so `process.platform` is safe there. Keep `DEFAULT_SETTINGS` (:62) computed once.
- :31 `voice.speakerRejection` default true, with the comment "(needs parec)". Keep the field. VoiceService
  ignores it where unsupported (12.2).
- :32 comment "(Ctrl+Alt+M)", :40 comment "XDG autostart entry".
- `repairObject` (:70-83) and `salvageNeverLook` (:136-141) don't depend on the platform.
- The copy of the defaults in `app/renderer/home/copy.ts:6` is pinned equal to the settings default by
  test/unit/ui-copy.test.ts:52. Move both into `app/shared/never-look.ts` (`NEVER_LOOK_DEFAULTS: Record<OS, readonly string[]>`
  plus a merged `NEVER_LOOK_NAMES`) and send `os` to the renderer in `Status` (13.3).

---

## 4. Admin policy: `app/main/admin.ts`

Today: `ADMIN_POLICY_FILE = "/etc/ember/policy.json"` (admin.ts:14). `loadAdminPolicy(file, { requireRootOwned })`
(:83-107) requires `st.uid === 0 && (st.mode & 0o022) === 0` when `file === ADMIN_POLICY_FILE` (:91-98). Anything
unreadable, untrusted or invalid gives `LOCKDOWN` (:71-75). `EMBER_ADMIN_POLICY` is honoured only unpackaged
(main.ts:60, :173, :210). Callers: main.ts:173 (doctor), :210 (start). `admin.source`/`error` go to the settings
window (main.ts:306) and the doctor (doctor.ts:85-87).

Why ownership matters: the policy is **more trusted than user settings**. `provider` (admin.ts:48-55) redirects
every model request, with screen contents, to `baseUrl`, and `apiKeyFile` is read as-is (:137-140). A policy
planted by a non-admin process would redirect Ember's traffic.

**Security finding: the POSIX check is meaningless on Windows.** Node reports `st.uid === 0` for every file, and
`st.mode` comes only from the read-only attribute (0o666, or 0o444 when read-only). If the constant were kept,
`/etc/ember/policy.json` would resolve to `C:\etc\ember\policy.json`. Authenticated Users may create folders in
`C:\`, so any standard user could create that file, set it read-only, and **pass the check**
(uid 0, mode 0o444), gaining the `provider` redirect. The Windows path must use its own trust check.

### 4.1 [W]
Preferred: **`HKLM\SOFTWARE\Policies\Ember`**, REG_SZ value `Policy` holding the same JSON, read with
`RegGetValueW(HKLM, "SOFTWARE\\Policies\\Ember", "Policy", RRF_RT_REG_SZ, …)` (note: `RRF_RT_REG_SZ` doesn't
expand REG_EXPAND_SZ). Only administrators can write under `SOFTWARE\Policies` by default, so it needs no ACL
logic. It is what GPO/Intune admins expect (an ADMX can come later). Missing key or value → `{ policy: {}, source: null }`.
Read error other than not-found → LOCKDOWN.

Optional file source: `%ProgramData%\Ember\policy.json`.
- Resolve ProgramData with `SHGetKnownFolderPath(FOLDERID_ProgramData)` (shell32 via koffi), **not**
  `process.env.ProgramData`, which a user can override in `HKCU\Environment`.
- **ProgramData's default ACL lets Users create sub-folders** (`BUILTIN\Users:(CI)(WD,AD,WEA,WA)`). If the
  installer didn't create `Ember\`, a user can. So check **both the directory and the file**:
  `GetNamedSecurityInfoW(path, SE_FILE_OBJECT=1, OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION (0x1|0x4), &owner, null, &dacl, null, &sd)`.
  - The owner SID must be one of `S-1-5-18` (SYSTEM), `S-1-5-32-544` (Administrators),
    `S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464` (TrustedInstaller). Use
    `ConvertSidToStringSidW`.
  - `dacl == NULL` (a NULL DACL means full access for everyone) → reject.
  - For each ACE (`GetAclInformation(AclSizeInformation=2)` → `AceCount`; `GetAce(i)`): skip
    `AceFlags & INHERIT_ONLY_ACE (0x08)`. For `ACCESS_ALLOWED_ACE_TYPE (0)` whose SID is not one of the three
    above, reject if `Mask & (FILE_WRITE_DATA 0x2 | FILE_APPEND_DATA 0x4 | FILE_WRITE_EA 0x10 | FILE_DELETE_CHILD 0x40 | FILE_WRITE_ATTRIBUTES 0x100 | DELETE 0x10000 | WRITE_DAC 0x40000 | WRITE_OWNER 0x80000 | GENERIC_ALL 0x10000000 | GENERIC_WRITE 0x40000000)`.
  - `LocalFree(sd)`.
  - Use SIDs only. Account names are localized ("VORDEFINIERT\Administratoren"). Don't shell out to `icacls`
    (localized output) or `Get-Acl` (method calls on its objects are blocked in Constrained Language Mode).
- The installer creates `%ProgramData%\Ember` with a protected DACL: SYSTEM/Administrators full, Users read.
- If both sources exist, the registry wins. `source` = `"HKLM\\SOFTWARE\\Policies\\Ember"` or the file path.

### 4.2 [M]
`/Library/Application Support/Ember/policy.json`. POSIX holds, so keep `uid === 0 && (mode & 0o022) === 0`, and
apply the same check to the directory `/Library/Application Support/Ember`. (`/Library/Application Support` is
`root:admin 0755`, so creating `Ember/` needs sudo.) Extended ACLs (`chmod +a`) could grant writes despite the
mode bits, but only root can add them to a root-owned file. Optional later: an MDM configuration profile for the
app's bundle id with key `PolicyJSON` (lands in `/Library/Managed Preferences/<bundle-id>.plist`, root-owned),
read through `CFPreferencesCopyAppValue`.

### 4.3 Shared
- Rename `ADMIN_POLICY_FILE` → `platform.adminPolicy.location`. The doctor line (doctor.ts:87
  `"None (optional: /etc/ember/policy.json)."`) and the settings.ts:6, host.ts:117 comments follow it.
- `apiKeyFile` (admin.ts:51, :137-139): no permission check today. The comment says "A file only Ember's users can
  read". Paths are OS paths: on Windows the JSON needs `\\`. Keep the behaviour and document an ACL'd file under
  `%ProgramData%\Ember\`.
- packaging/policy.example.json and docs/DEVELOPING.md mention only `/etc/ember`.

---

## 5. Autostart: `app/main/autostart.ts`

Today: `autostartFile` (:11-13) = `$XDG_CONFIG_HOME/autostart/ember.desktop`. `launchCommand` (:16-22) picks
`$APPIMAGE`, `/usr/bin/ember` (when execPath is under `/opt/ember/`), `execPath`, or `[execPath, appPath]` in dev.
`autostartEntry` (:31-45) writes `X-GNOME-Autostart-*`. `syncAutostart` (:48-60) is idempotent by comparing file
contents. Caller: main.ts:967-975. It runs **on every settings change** (`settings.onChange(autostart)`), and the
argv flag `--autostart` decides whether settings opens (main.ts:976, :1374-1376). Tests: test/unit/packaging.test.ts:86-105.

[W] `app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args })` writes
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<name>` (name defaults to the AppUserModelId).
- Packaged: `args: ["--autostart"]`. Dev: `args: [`"${app.getAppPath()}"`, "--autostart"]`. **Quote paths
  yourself**: Electron joins `args` with spaces (electron.d.ts:23958-23964 "Take care to wrap paths in quotes").
- Idempotence: compare `app.getLoginItemSettings({ path, args }).openAtLogin` with `on` first, and pass the
  **same** `path`/`args` when reading (electron.d.ts:1257).
- The user can disable the entry in Task Manager > Startup: `launchItems[].enabled === false` /
  `executableWillLaunchAtLogin === false` while `openAtLogin` stays true. Surface that as `status().note`.
- `launchedAtLogin(argv) = argv.includes("--autostart")`.

[M] `app.setLoginItemSettings({ openAtLogin: on })` (default `type: "mainAppService"` = `SMAppService.mainApp`, macOS 13+).
- **No `args` on macOS**, so `--autostart` never arrives. Use `app.getLoginItemSettings().wasOpenedAtLogin`
  (**verify** it works with SMAppService on 13/14/15). Otherwise register an `agentService` LaunchAgent plist
  bundled in `Contents/Library/LaunchAgents/` whose `ProgramArguments` include `--autostart` (packaging).
- `status` can be `"requires-approval"` (the user must allow it in System Settings > General > Login Items). Show
  it next to the switch (home/index.html:47, home/main.ts:113/131).
- **Each register call shows the "Background Items Added" notification**, so never call it when already in step.
  Compare `getLoginItemSettings().status === "enabled"` first.
- Requires a stable app path. A translocated app (run from the DMG or Downloads) registers a path that vanishes.
  Pair it with the doctor's "Move to Applications" fix (10).

Shared: `main.ts:1374` must use `platform.autostart.launchedAtLogin(process.argv)` instead of
`process.argv.includes("--autostart")`. Otherwise macOS opens settings at every login.

---

## 6. Audit system-log copy: `app/main/policy/audit.ts`

Today: `AuditLog` (:21-72) writes JSON lines to `<userData>/audit/audit-YYYY-MM.jsonl` and is portable.
`journalSink` (:78-95) spawns **`systemd-cat -t ember-audit -p info`** (not `logger`) once, only if
`/usr/bin/systemd-cat` or `/bin/systemd-cat` and `/run/systemd/journal/stdout` exist. On Windows and macOS it
already returns `undefined`, because those paths don't exist (on Windows `/usr/bin/…` resolves against the current
drive). `journalLine` (:107-128) redacts for a log more people can read. Keep it for every OS sink (tests:
policy.test.ts:173-185, :375-383, :491-516, :737+). Caller: main.ts:1189.

[W] Windows Event Log, Application log, source `Ember`, through koffi advapi32:
`RegisterEventSourceW(null, L"Ember")` once; per line
`ReportEventW(h, EVENTLOG_INFORMATION_TYPE=4, 0, 1000, null, 1, 0, [journalLine(line)], null)`;
`DeregisterEventSource` on quit.
- Only when the source is registered: `RegOpenKeyExW(HKLM, "SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Ember")`
  succeeds. A per-machine installer (admin) creates it with `EventMessageFile` (REG_EXPAND_SZ) pointing at a
  message DLL with a `%1` message, e.g. `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\EventLogMessages.dll`
  (**verify**). Without registration Event Viewer shows "description … cannot be found". Per-user install → no sink.
- Don't use `EventLog.SourceExists` (it throws SecurityException for non-admins). Don't use `eventcreate`/
  `Write-EventLog` (a process per line).
- One string is limited to 31 839 chars, and lines are far smaller. The Application log is readable by every
  local user, so `journalLine` redaction applies unchanged.

[M] Unified log through `/usr/bin/logger -t ember-audit` as one long-lived child with lines on stdin (BSD logger
reads stdin lines when given no message). This is the same pattern as the systemd-cat child (:83-89). The default
priority `user.notice` is persisted. Admins read it with `log show --predicate 'process == "logger" AND eventMessage CONTAINS "ember-audit"'`.
Redaction applies unchanged.

---

## 7. GitHub sign-in: `app/main/agent/auth.ts`

### 7.1 Token store (`TokenStore`, auth.ts:29-56; main.ts:178, :1154)
- `canPersist()` (:33-35) = `isEncryptionAvailable() && getSelectedStorageBackend?.() !== "basic_text"`.
  `getSelectedStorageBackend` is **Linux-only** (electron.d.ts:12126 `@platform linux`). The optional call already
  makes it `undefined` elsewhere, so the logic holds.
- [W] safeStorage = DPAPI-protected key in `<userData>/Local State`. No prompt. It roams with the profile if userData
  roams, and deleting `Local State` loses the token (load returns null, so the user signs in again).
- [M] safeStorage = Keychain item "`<app name>` Safe Storage". **Unsigned or re-signed builds trigger a Keychain
  prompt**, and the user may click Deny. Then `decryptString` throws (load → null, fine), but
  **`encryptString` throws inside `save` (auth.ts:49)**. That escapes into the sign-in flow (main.ts:886, inside
  the try at :876) and is shown as a confusing error. Wrap `save` in try/catch → `false` (the "no keyring" path at
  main.ts:887-889).
- File mode 0o600 (:49) is ignored on Windows, which is fine.

### 7.2 `ghCliToken` (auth.ts:58-65)
`execFile("gh", ["auth","token"], { timeout })`:
- [W] libuv's PATH search appends `.com`/`.exe` itself, so `gh.exe` on PATH is found. Add
  **`windowsHide: true`**: otherwise a console window flashes on every `resolveToken` call, and the sign-in loop
  calls it every 3 s for up to 10 minutes (main.ts:862-871). Fallback candidates when not on PATH:
  `%ProgramFiles%\GitHub CLI\gh.exe`, `%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe`,
  `%USERPROFILE%\scoop\shims\gh.exe`, `%ProgramData%\chocolatey\bin\gh.exe`. Never accept `gh.cmd`/`gh.bat`: since
  CVE-2024-27980 Node refuses to spawn `.bat`/`.cmd` without a shell (EINVAL).
- [M] **Apps started from Finder, the Dock or a login item get launchd's PATH `/usr/bin:/bin:/usr/sbin:/sbin`.**
  Homebrew's `gh` (`/opt/homebrew/bin/gh` on Apple Silicon, `/usr/local/bin/gh` on Intel) and MacPorts
  (`/opt/local/bin/gh`) are **not found**, so "Check again" says no sign-in. Resolve an absolute path through
  `platform.ghCliPath()` = `which("gh", { extraDirs: [those three, ~/.local/bin] })` and `execFile(abs, …)`.
  Don't source the login shell for PATH (slow, and runs user dotfiles).
- The sign-in wording "In a terminal, run “gh auth login”" (main.ts:860, :872, :832; copy.ts:51; doctor.ts:82;
  host.ts explainStartError) is fine on every OS.

### 7.3 `which` (main.ts:165)
`(PATH ?? "/usr/bin:/bin").split(":")` + `X_OK`. On Windows the separator is `;`, entries may be quoted, `X_OK`
is only an existence check, and extensions come from `PATHEXT`. Today it is used only for `pactl` and
`speech-dispatcher` (doctor, Linux). desk/desk.ts has its own `which` (Linux only). Replace both with
`platform.which` (path.delimiter, quote stripping, PATHEXT limited to `.EXE;.COM` for anything Ember will
execFile, darwin extra dirs).

---

## 8. Copilot runtime: `app/main/agent/runtime.ts`

Today: `RELATIVE = node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/copilot-runtime` (:9). Candidates
are `EMBER_COPILOT_RUNTIME` (dev only: main.ts:174/1164 pass `env: {}` when packaged),
`<resourcesPath>/app.asar.unpacked/<RELATIVE>` and `<appPath>/<RELATIVE>` (:16-30). `ensureExecutable` (:32-39)
chmods +x. Callers: main.ts:174 (doctor), :1164-1165 → `AgentHost.runtimePath` → host.ts:689
`RuntimeConnection.forStdio({ path })`. Test: test/unit/agent-misc.test.ts:114-119.

Platform packages (lockfile package-lock.json:704-712, 715-816; `os`/`cpu` gated, so **npm installs only the
host's own**: on this Linux box only `copilot-sdk-linux-x64` and `-linuxmusl-x64` are present). File names come
from the SDK's own resolver `node_modules/@github/copilot-sdk/dist/runtimeArtifacts.js:163-174` (`getRuntimePlatform`)
and :208-210 (`wrapperName = platform.startsWith("win32") ? "copilot-runtime.exe" : "copilot-runtime"`, plus
`runtime.node` beside it, validated non-empty at :47-58). That resolver isn't exported (index.js exports don't
include it), so mirror it:

```ts
const plat = process.platform === "linux" ? (isMusl() ? "linuxmusl" : "linux") : process.platform; // isMusl: !process.report.getReport().header.glibcVersionRuntime
const id = `${plat}-${process.arch}`;                                  // win32-x64 | win32-arm64 | darwin-x64 | darwin-arm64 | linux-x64 …
const exe = process.platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime";
const RELATIVE = path.join("node_modules", "@github", `copilot-sdk-${id}`, "prebuilds", id, exe);
```

- `ensureExecutable`: skip on win32. The SDK's `makeExecutable` skips it too (runtimeArtifacts.js:100-108). On
  Windows, `chmodSync(…|0o755)` only clears the read-only bit.
- [M] The binary and `runtime.node` must be signed with the app (hardened runtime, notarization). See the
  packaging spec. The SDK spawns with `windowsHide: true` already (client.js:2317-2329).
- Packaging (stage.mjs:103-105) prunes `ripgrep, tgrep, plugins, builtin-skills` from the linux package only. Do
  the same for the win32 and darwin packages. Building a Windows or macOS package needs `npm ci` on that OS (or
  `npm install --os=win32 --cpu=x64`).
- Wording: host.ts:281 and doctor.ts:77 say "Reinstall Ember (sudo dnf reinstall ember)" →
  `platform.words.reinstall`.

---

## 9. Environment checks: `app/main/environment.ts` + `readEnvironment`/`probeAccessibility` (main.ts:121-156)

### 9.1 Today
`inspectEnvironment(EnvInputs)` is pure (environment.ts:60-130). Its inputs are Linux-shaped (:6-19):
`osRelease` (/etc/os-release, main.ts:143), `glibc` (process.report, :144), `accessibility` (Linux only, :152),
`x11` (DISPLAY reachable), `shortcutsTaken`.
- `platform` check (:67-69): **fails anything but linux/x64**. On Windows and macOS, `failing > 0` makes the
  settings tagline say "needs a couple of things fixed" (copy.ts:60) and opens the setup fold (home/main.ts:204),
  and `ember --doctor` exits 1 (main.ts:205).
- `os` (:71-77) warns unless RHEL 8. `session` (:79-91) fails without X11. `desktop` (:93-95) warns unless GNOME.
  `glibc` (:97-101) Linux only. `accessibility` (:103-112) offers fix `"enable-accessibility"`.
  `shortcuts` (:114-119) has hard-coded "Ctrl+Alt+…" text.
- Consumers: main.ts:150-155 (`readEnvironment`, called by `getStatus` main.ts:303 on **every** settings-window
  status request, by `applyFix` :328, by runDoctor :171, and at ready :1050 for the log line :1063-1072), the
  renderer (home/main.ts:167-207 lists checks, :212-218 versions), `doctorChecks` (doctor.ts:44-53 for
  `platform, os, glibc, session, desktop`, :61-68 for accessibility). `EnvReport.sessionType/desktop/display/glibc`
  are used only in the main log line.

### 9.2 New inputs
Keep `inspectEnvironment` pure. Add optional per-OS inputs and branch on `i.platform`:

```ts
interface EnvInputs {
  /* existing … */
  windows?: { build: number; productName: string;            // process.getSystemVersion() "10.0.22631" → build 22631 (Windows 11 if ≥ 22000; os.version() says "Windows 10 Pro" on 11)
              powershell: "full" | "constrained" | "missing" | "unknown";   // from the sidecar status / one cached probe
              elevated: boolean;                               // shell32 IsUserAnAdmin() or GetTokenInformation(TokenElevation=20)
              session: "console" | "rdp" | "service" };        // SESSIONNAME "Console" / "RDP-Tcp#n" / session 0
  mac?: { version: string;                                    // process.getSystemVersion() "14.6.1"
          accessibility: boolean;                              // systemPreferences.isTrustedAccessibilityClient(false)
          screen: MediaAccess; microphone: MediaAccess;        // systemPreferences.getMediaAccessStatus('screen'|'microphone')
          inApplications: boolean;                             // app.isInApplicationsFolder()
          root: boolean };                                     // process.getuid() === 0
}
```

| Check id | [W] | [M] |
|---|---|---|
| `platform` | ok for win32 x64/arm64 | ok for darwin x64/arm64 |
| `os` | ok if build ≥ 17763 (1809). Else fail ("Windows 10 1809 or newer"). | ok if ≥ 13.0, else fail |
| `session` | ok for console/RDP; fail for session 0/service ("Start Ember from your desktop") | ok (fail only if `screen.getAllDisplays()` is empty, i.e. run over SSH) |
| `desktop` | omit, or ok "Windows" | omit, or ok "macOS" |
| `glibc` | omitted already (null) | omitted already |
| `accessibility` | `powershell !== "full"` → **warn**: "Windows PowerShell is restricted on this computer (Constrained Language Mode), so Ember can't read apps." Missing → fail. No fix button. | `!accessibility` → **fail**: "Ember needs Accessibility permission to read and use apps." Fix `"open-accessibility-settings"`. |
| `screen-recording` (new) | — | `screen !== "granted"` → warn: screenshots **and other apps' window titles** (kCGWindowName is empty without it) are unavailable. Fix `"open-screen-recording-settings"`. macOS only applies the grant **after Ember restarts**: say so. |
| `elevated` (new) | warn if Ember runs elevated: apps it starts run as admin, and its own windows can't be read from non-elevated helpers. Fix: start normally. | `root` → warn |
| `location` (new) | — | `!inApplications` → warn. Fix `"move-to-applications"` (`app.moveToApplicationsFolder()`). TCC grants and login items are tied to the path. |
| `shortcuts` | text from `platform.shortcuts` | same |

The renderer's `Status.environment` is rendered generically, so new ids need no renderer change beyond the fix label (9.4).

### 9.3 `probeAccessibility` (main.ts:121-139)
It runs `gsettings get org.gnome.desktop.interface toolkit-accessibility` and `python -c "import pyatspi"`
(30 s re-probe). It is called only on linux (main.ts:152). On [W], derive `powershell` from the UIA sidecar's
`status` (sidecar spec) or one cached probe:
`powershell.exe -NoProfile -NonInteractive -Command "$ExecutionContext.SessionState.LanguageMode"`
→ `FullLanguage`/`ConstrainedLanguage`. Cache it for the session: `readEnvironment` runs on every status request.
**`Add-Type` is blocked in Constrained Language Mode** (WDAC/AppLocker), so the UIA sidecar design fails on such
machines. On [M], everything is a cheap Electron call.

### 9.4 Fixes (main.ts:324-329, environment.ts:29, shared/ipc.ts:113, home/main.ts:182-194)
- `Check.fix` union → `"enable-accessibility" | "open-accessibility-settings" | "open-screen-recording-settings" | "open-microphone-settings" | "move-to-applications"`.
- main.ts:325 allows only `"enable-accessibility"` (and runs gsettings at :326). Replace it with
  `if (!platform.fixes.ids.includes(fix)) throw …; await platform.fixes.apply(fix)`.
  - [L] `enable-accessibility`: gsettings, as today.
  - [M] `open-accessibility-settings`: `systemPreferences.isTrustedAccessibilityClient(true)` (shows the system
    prompt once) plus `shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")`.
    `open-screen-recording-settings`: `…?Privacy_ScreenCapture`. `open-microphone-settings`:
    `systemPreferences.askForMediaAccess("microphone")` if `not-determined`, else `…?Privacy_Microphone`.
    `move-to-applications`: `app.moveToApplicationsFolder()` (it relaunches).
  - [W] `open-microphone-settings`: `shell.openExternal("ms-settings:privacy-microphone")`.
- The button text is hard-coded "Turn on" (home/main.ts:186). Make it per fix: "Turn on" / "Open Settings" /
  "Open System Settings" / "Move to Applications".
- After an "open settings" fix the state changes later. Have the renderer call `getStatus` again on window
  `focus` (or main pushes `environment` on `browser-window-focus`).

---

## 10. `ember --doctor`: `app/main/doctor.ts`, `runDoctor` (main.ts:167-206)

Probes gathered in main.ts and their portability:

| Probe | Line | [L] | [W] | [M] |
|---|---|---|---|---|
| X11 open / compositor | :169-170, :195 | Xlib | DWM is always on (Windows 8+) → `compositor: true` | always compositing → `true` |
| XTest (`xtest`) | :172, :195 | `openXInput()` | SendInput is always there → true. Add a note: elevated windows refuse input (UIPI). | true only if Accessibility is trusted (CGEventPost needs it) |
| auth | :175-182 | portable (safeStorage, `resolveToken`) | ok | ok (Keychain prompt possible, 7.1) |
| microphones | :183-187 `pactl list short sources` | pactl | `systemPreferences.getMediaAccessStatus("microphone")`. A device count needs a renderer (`enumerateDevices` in a hidden window). Else report "not checked". | same, plus TCC status |
| voice models | :188, :198 | portable | portable | portable |
| user namespaces | :189-191 `/proc/sys/user/max_user_namespaces`, `unprivileged_userns_clone` | Linux | omit the `sandbox` check | omit |
| chrome-sandbox suid | :192-193 | Linux | omit | omit |
| speech-dispatcher | :197 (`which` + `libspeechd.so.2` paths) | Linux | ok "Uses Windows voices" | ok "Uses macOS voices" |
| desk | :199 `DeskManager.available()` | Xvfb/xauth/dbus-daemon | **gate on linux**: with XQuartz plus Homebrew dbus on PATH (Ember started from Terminal), `available()` can return ok on macOS | omit check |
| inotify | :200 `inotifyUse()` (host.ts:197-216, reads /proc) | Linux | returns null → check omitted already | same |

`doctorChecks` text that must become per OS: :49-51 session fixes (GNOME on Xorg, DISPLAY/XAUTHORITY),
:56-59 compositor, :63-66 pyatspi/gsettings fixes, :74 `sudo dnf install libXtst`, :77 reinstall, :82
"(Ctrl+Alt+E)", :87 policy path, :91 pactl/pulseaudio-utils, :94 "(Ctrl+Alt+Space)", :100 speech-dispatcher,
:104 desk dnf line, :108 chrome-sandbox, :112 sysctl. Build the platform-free part (copilot, policy,
voice-models) once and add per-OS check builders.

[W] stdout: Electron attaches to the parent console by default (`ELECTRON_NO_ATTACH_CONSOLE` exists to turn that
off), but cmd and PowerShell **don't wait** for a GUI-subsystem exe. The report prints after the prompt returns,
and the exit code (main.ts:205) is lost. Ship `ember-doctor.cmd` (`start "" /wait "%~dp0Ember.exe" --doctor`), or
document `Ember.exe --doctor | more`. [M] `/Applications/Ember.app/Contents/MacOS/Ember --doctor` works in
Terminal.

---

## 11. Screen reader and reduced motion (main.ts)

### 11.1 `screenReaderOn` (main.ts:605-613)
Today: `gsettings get org.gnome.desktop.a11y.applications screen-reader-enabled`, cached 60 s,
`|| app.isAccessibilitySupportEnabled()`. Users: `maySpeak()` (:616) → speaks every answer, task result and
question (:594-597, :1290, :1306) even with "Speak replies" off.

**Finding:** on Windows and macOS, `app.isAccessibilitySupportEnabled()` (electron.d.ts:1400-1410,
`@platform darwin,win32`) turns true whenever **any** UIA/AX client touches Ember's Chromium windows. That
includes **Ember's own sidecar** if it ever enumerates Ember's windows, Windows' text-cursor indicator, Voice
Access, password managers, Grammarly, and on macOS window managers (Rectangle, Magnet) that set
`AXEnhancedUserInterface`/`AXManualAccessibility`. Ember would then start speaking everything. Replace it with a
real screen-reader signal and drop the `isAccessibilitySupportEnabled()` term on win32/darwin:
- [W] `SystemParametersInfoW(SPI_GETSCREENREADER = 0x0046, 0, &BOOL, 0)` (user32 via koffi). Narrator, NVDA and
  JAWS set it.
- [M] `NSWorkspace.sharedWorkspace.isVoiceOverEnabled` (macOS 10.13+): koffi + `libobjc` `objc_msgSend`, or
  `osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.voiceOverEnabled'` (no Apple
  Events, so no Automation prompt). Keep the 60 s cache. Avoid `defaults read com.apple.universalaccess` (that
  domain is TCC-protected on recent macOS: **verify** before relying on it).
- Also: the sidecars must skip Ember's own pid (Linux already passes `ownPid`, perception/index.ts:573).

### 11.2 `systemReducedMotion` (main.ts:1076-1077 → overlay.ts:110, :331)
Today: `gsettings get org.gnome.desktop.interface enable-animations` == false, read once per overlay creation.
[W]/[M]: `systemPreferences.getAnimationSettings().prefersReducedMotion` (electron.d.ts:14272, :20814; no platform
tag. Windows maps it to `SPI_GETCLIENTAREAANIMATION`, macOS to `accessibilityDisplayShouldReduceMotion`). The
renderers already follow `matchMedia("(prefers-reduced-motion: reduce)")` (home/main.ts:37-45,
overlay/main.ts:41/78, handle/main.ts:24), and Chromium maps that natively on both. `nativeTheme.prefersReducedTransparency`
is a different preference: don't use it for motion. Optionally re-read on `nativeTheme.on("updated")`.

---

## 12. Voice

### 12.1 What is Linux-specific
| Item | Where | [W] | [M] |
|---|---|---|---|
| `enable-speech-dispatcher` switch | main.ts:71-72 (already guarded by `process.platform === "linux"`) | none: Chromium speaks through SAPI5 voices ("Microsoft David/Zira Desktop") | none: Chromium uses the system synthesizer |
| speechSynthesis in the mic page | renderer/mic/main.ts:62-72 | works. `u.lang = navigator.language`: with no voice for that language, Chromium uses the default voice | works |
| Self-speech handling (`voice:speaking` → `self-speaking`) | voice.ts:101-111, :195-201; mic/main.ts:52-60 | still **needed**: OS speech plays outside Chromium's echo canceller, as speech-dispatcher does | still needed |
| Speaker monitor (`parec --device=@DEFAULT_MONITOR@ --format=float32le --rate=16000`) | voice/speakers.ts:30, :44 ("parec isn't installed (pulseaudio-utils)"); started at voice/process.ts:54 when `init.monitor`; sherpa adds `spotMonitor` when `monitor` (process.ts:52, sherpa.ts:181-185) | **none: speaker rejection off**. Phase 2 option: WASAPI loopback through Chromium (`session.setDisplayMediaRequestHandler(… audio: "loopback")`), with frames sent to the voice process on a second port | **none: off**. Phase 2: ScreenCaptureKit loopback (`audio: "loopback"`, macOS 13+, needs Screen Recording) |
| mic indicator wording | voice.ts:5 comment, home/index.html:91 "GNOME shows a microphone icon" | "Windows shows a microphone icon in the taskbar while Ember listens." | "macOS shows an orange dot in the menu bar while Ember listens." |
| microphone permission | none on Linux | global privacy switch "Let desktop apps access your microphone". `systemPreferences.getMediaAccessStatus("microphone")`. getUserMedia fails `NotAllowedError` → micHelp (voice.ts:343-348) | **TCC**: Info.plist `NSMicrophoneUsageDescription`, hardened-runtime entitlement `com.apple.security.device.audio-input`. Call `await systemPreferences.askForMediaAccess("microphone")` when the user clicks the consent "Yes" (home/main.ts:763-769 → `updateSettings({ voice:{consent:true} })` → main), **before** the hidden mic window opens (voice.ts:251-260). Otherwise the prompt comes from an invisible window without context. |
| model unpacking `tar -xjf` | voice/models.ts:98 | `tar` on PATH may be **Git-for-Windows GNU tar**, which treats `C:\…` as a remote host `C:`. `%SystemRoot%\System32\tar.exe` (bsdtar, Windows 10 1803+) has bzip2 support in current builds, but early Windows 10 builds may lack it (**verify** on 1809). | `/usr/bin/tar` (bsdtar) handles bzip2 |
| curl downloader | voice/models.ts:115-117 | scripts/CI only. `curl.exe` ships with 1803+ | ok |

**Recommendation for models.ts:98:** replace the `tar` child with an in-process extractor: a vendored bzip2
decoder (e.g. `seek-bzip`, MIT, pure JS) plus a 60-line ustar reader that rejects absolute paths, `..`
components, links and device entries, and writes only under `root/<target>`. It removes the external dependency on
all three OSes and the PATH ambiguity. Keep an error message containing "tar" (or change the mapping) so
`downloadHelp` (voice.ts:339 `/\btar\b/`) still says "couldn't be unpacked". If you keep a child process instead:
[W] use the absolute `System32\tar.exe` with `windowsHide: true`, [M] `/usr/bin/tar`.

### 12.2 Wiring changes
- main.ts:1349 `monitor: settings.get().voice.speakerRejection` → `&& platform.voice.speakerMonitor`.
  Otherwise the voice process spawns parec (ENOENT, logged as "parec isn't installed (pulseaudio-utils)") and
  sherpa builds a monitor stream branch for nothing. The engine is safe without frames (engine.ts:711, :757), but
  don't depend on that.
- The consent copy home/index.html:91 says "Ember also listens to what your speakers play". Show that sentence only
  when `speakerMonitor` is true. home/main.ts:765 always sets `speakerRejection: true`. That is harmless.
- `micHelp` (voice.ts:343-348): add platform hints and a fix id (`open-microphone-settings`) to the voice status
  detail.
- Voice models root (main.ts:158-163) is `[EMBER_VOICE_MODELS (dev), "/usr/share/ember/voice-models", resourcesPath/voice-models]`,
  else `userData/models`.
  - [W]: `[resourcesPath\voice-models, <FOLDERID_ProgramData>\Ember\voice-models]`.
  - [M]: `[Contents/Resources/voice-models, /Library/Application Support/Ember/voice-models]`.
  - **Packaging must keep the `.<target>.ok` marker dot-files** (`modelsReady`, models.ts:58-71). Some packagers
    drop dot-files from extra resources. **verify**.
- sherpa-onnx is the WebAssembly build (sherpa.ts:1-8; no native addon), so the voice process works on every OS
  unchanged. `utilityProcess.fork` and `MessageChannelMain` are portable.
- Doctor microphone and speech probes: section 10.

---

## 13. Prompt, tool and UI copy

### 13.1 Platform words
```ts
interface PlatformWords {
  desktop: string;           // L "Linux desktop (RHEL, GNOME)" · W "Windows desktop" · M "Mac"
  apps: string;              // L "Linux desktop applications (RHEL, GNOME)" · W "Windows applications" · M "Mac applications"
  fileManager: string;       // "Files" · "File Explorer" · "Finder"
  textEditor: string;        // "Text Editor" · "Notepad" · "TextEdit"
  settingsApp: string;       // "Settings" · "Settings" · "System Settings"
  micIndicator: string;      // see 12.1
  fileDialogPathHint: string;// L "in a file dialog press Ctrl+L (or use its name field) and type the file's name"
                             // W "in a file dialog type the file's full path in the File name box"
                             // M "in a file dialog press Cmd+Shift+G, type the folder's path, then choose the file"
  noScreen: string;          // L "no X11 display or accessibility service" · W "the accessibility helper isn't running"
                             // M "Ember doesn't have Accessibility permission"
  reinstall: string;         // L "Reinstall Ember (sudo dnf reinstall ember)." · W "Reinstall Ember." · M "Install Ember again (drag a fresh Ember.app into Applications)."
  keyExample: string;        // "ctrl+s" · "ctrl+s" · "cmd+s" (must match the input spec's key grammar)
}
```

### 13.2 Model-facing text (exact places)
| Place | Text today | Change |
|---|---|---|
| persona.ts:11 `IDENTITY` | "…next to the user's mouse cursor on their Linux desktop (RHEL, GNOME)." | `words.desktop` |
| persona.ts:25 `TOOL_RULES` | "(the terminal, Files, a browser)" | `words.fileManager` |
| worker-persona.ts:6 `WORKER_IDENTITY` | "…user's real Linux desktop applications (RHEL, GNOME)…" | `words.apps` |
| worker-persona.ts:11 rule 3 | names all six settings | build from `platform.settings.available`. Drop the rule when the map is empty |
| worker-persona.ts:12-13 rule 4 | always mentions `open_on_desk` and `~/Ember` | include only when the desk tool exists (Linux with Xvfb), which matters already on Linux hosts without a desk |
| worker-persona.ts:29 `GUIDE_IDENTITY` | "…Linux desktop applications (RHEL, GNOME)…" | `words.apps` |
| worker.ts:964 `change_setting` | "Change a desktop setting directly: …" (from SETTINGS) | from `available`. Omit the tool when it is empty |
| worker.ts:1003 `open_app` | "(for example Text Editor, Files, Settings)" | `${textEditor}, ${fileManager}, ${settingsApp}` |
| worker.ts:1030 `press_keys` | `e.g. "ctrl+s", "Return", "ctrl+shift+t"` | `words.keyExample` plus macOS equivalents if the key grammar maps cmd |
| worker.ts:1082 | "Pick one in settings (Ctrl+Alt+E)." | `shortcuts.settings.label` |
| worker.ts:1655 | "…in a file dialog press Ctrl+L (or use its name field)…" | `words.fileDialogPathHint` |
| conductor.ts:108 | "(no X11 display or accessibility service)" | `words.noScreen` |
| presenter.ts:45 | "Pick another one in settings (Ctrl+Alt+E)." | shortcut label |
| host.ts:281 | "Reinstall Ember (sudo dnf reinstall ember)." | `words.reinstall` |
| host.ts:30-32 `TERMINAL` (user asked for a terminal) | covers gnome/kde/xfce terminal, "command prompt" | add `powershell|pwsh|cmd(?:\.exe)?|windows terminal|wsl|iterm2?|warp` |

Persona strings are `const`s used by `emberSystemMessage`/`workerSystemMessage`/`guideSystemMessage`. Turn them
into functions of `PlatformWords` (no test pins their text; eval may compare transcripts).

### 13.3 Settings window and other UI
Add to `Status` (shared/ipc.ts:64): `platform: { os: OS; settingsFile: string; shortcuts: Record<ShortcutId, string>; micIndicator: string; speakerRejection: boolean; fixLabels: Record<FixId,string> }`.
`settingsFile` comes from the real `settings.file` (`SettingsStore.file`, settings.ts:165).

| Place | Today | Change |
|---|---|---|
| home/main.ts:217 | `"~/.config/ember/settings.json"` | `status.platform.settingsFile` |
| home/main.ts:186 | "Turn on" | per-fix label (9.4) |
| home/main.ts:731 | "Microphone off (Ctrl+Alt+M to turn on)" | shortcut label |
| copy.ts:6-16 | Linux never-look defaults and names ("Password prompts (polkit)") | `shared/never-look.ts` keyed by OS. `missingDefaults(list, os)`, `neverLookLabel` gets the merged names |
| copy.ts:66 `tagline` | "Press Ctrl+Alt+Space…" | take the ask label as a parameter |
| copy.ts:99 `KEY_NAMES` | `super`/`meta` → "Super" | W "Win", M "Cmd". M also alt → "Option", ctrl → "Control" |
| copy.ts:167 | `"Ctrl+Alt+X"` | stop label |
| index.html:31 | "through the desktop's accessibility service" | fine. M: add "macOS will ask you to allow Accessibility and Screen Recording for Ember." |
| index.html:33, 54, 77, 91, 138 | `<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>X/E/Space/M/Y/N</kbd>` | fill the `.chord` spans from `status.platform.shortcuts` (give them ids/data-attributes) |
| index.html:91 | "…Ember also listens to what your speakers play… GNOME shows a microphone icon…" | conditional sentence plus `micIndicator` |
| index.html:47 | "Start Ember when I log in" | fine. Show `autostart.status().note` under it |
| index.html:54 | "…click Ember's handle in the bottom-right corner" | fine if the handle stays there (window spec) |
| environment.ts:118 | "Ctrl+Alt+Space ask · Ctrl+Alt+X stop · Ctrl+Alt+E settings · Ctrl+Alt+M microphone" | from the table |
| main.ts:368-375 greet | "Press Ctrl+Alt+Space…; Ctrl+Alt+X stops me." "(Ctrl+Alt+E)" | from the table |
| main.ts:444 menu labels | `accel.replace("Control","Ctrl")` | `shortcuts.*.label` |
| main.ts:565-568 `QUESTION_KEYS` | accel, hint and spoken text for Y/N | from the table |
| doctor.ts:82, :94 | "(Ctrl+Alt+E)", "(Ctrl+Alt+Space)" | from the table |
| shared/apps.ts:4-26 `APP_NAMES`, :34-47 `friendlyApp` | GNOME ids. `notepad.exe` stays "notepad.exe" (the capitalise rule needs `^[a-z][a-z0-9-]*$`) | strip `/\.exe$/i` first. W map: winword→Word, excel→Excel, powerpnt→PowerPoint, outlook/olk→Outlook, msedge→Microsoft Edge, chrome→Google Chrome, explorer→File Explorer, notepad→Notepad, mspaint→Paint, systemsettings→Settings, calculatorapp→Calculator, windowsterminal→Terminal, code→Visual Studio Code, ms-teams/teams→Teams, applicationframehost→"" (shouldn't surface). M: names are already friendly. Bundle ids: com.apple.systempreferences→System Settings, com.apple.finder→Finder, org.libreoffice.script→LibreOffice (the bundle-id branch would say "Script") |

`CONSENT_VERSION` (shared/consent.ts:2) needs **no bump**. Consent is per settings file, and a fresh Windows or macOS
install starts at version 0, so it is asked anyway. The consent text itself is per platform. Bump only if a
platform adds a new data flow (e.g. phase-2 speaker loopback).

---

## 14. Global shortcuts (cross-cutting: input/hotkey owners decide; this subject owns the wording)

Today: `Control+Alt+E/Space/X/M` (main.ts:1122-1136, registered :1137-1151) and `Control+Alt+Y/N` while a question
is up (main.ts:565-576). The policy's `isSystemKey` blocks a task from pressing Ember's own chords
(policy.ts:556-572: `ctrlAlt && /^(…|y|n|a|x|space|e|m|end)$/`). That list must always match the chosen table.

Collisions that make a copy-paste of the Linux table wrong:
- **[W] Ctrl+Alt is AltGr.** `RegisterHotKey(MOD_CONTROL|MOD_ALT, 'E')` swallows AltGr+E. Polish: AltGr+E = ę,
  AltGr+N = ń, AltGr+X = ź. German: AltGr+E = €, AltGr+M = µ. A Polish or German user could no longer type those
  letters while Ember runs.
- **[M] Control+Option is VoiceOver's "VO" modifier.** Ember targets screen-reader users (spoken questions, Y/N
  keys, main.ts:562-563).

Proposal (**verify** each against the OS shortcut lists before shipping):

```ts
type ShortcutId = "ask" | "stop" | "settings" | "mute" | "allow" | "deny";
interface ShortcutTable { [id: string]: { accel: string; label: string; say: string } }
// L: Control+Alt+{Space,X,E,M,Y,N}                         (unchanged)
// W: Super+Alt+{Space,X,E,M,Y,N}   label "Win+Alt+…"       (the Windows key never types a character. Check Game Bar's Win+Alt+R/G/T/K/B/M; RegisterHotKey fails if taken → existing shortcutsTaken path)
// M: Control+Shift+Command+{Space,X,E,M,Y,N} label "⌃⇧⌘…"   (avoids ⌃⌥ = VO, ⌃⌘Space = Character Viewer, ⌥⌘Space = Finder search)
```

If Windows uses `Super+…`, `isSystemKey`'s `mods.has("super")` already blocks tasks from pressing them. **But on
macOS `LOGO_KEY` (policy.ts:531) maps `cmd`/`command` to `super`, so every Cmd shortcut would be a "system key"
and refused.** The input/policy owners must give macOS a separate primary-modifier mapping (and separate
`SAFE_COMBOS`/`DESTRUCTIVE_KEYS`, policy.ts:576-583: cmd+q/w/delete, Finder's cmd+delete = move to Trash,
cmd+shift+delete = empty Trash). They must also block [W] `ctrl+esc` (Start menu → type a program), `ctrl+shift+esc`,
`alt+space`, and [M] `cmd+space` (Spotlight → Terminal), `cmd+option+esc`, `ctrl+cmd+q`.

---

## 15. Spawning helpers on Windows
Every `execFile`/`spawn` of a console program from the GUI process flashes a console window unless it passes
`windowsHide: true`. Places in this subject: auth.ts:60 (gh, every 3 s during sign-in), system.ts:11-13 (`run`,
gsettings on Linux only), models.ts:98/116 (tar/curl), main.ts:125/132/185/326/609/1077 (Linux-only calls),
audit.ts:84 (Linux only), any new `powershell.exe`/`osascript`/`defaults`/`open` calls. On Windows,
`detached: true` gives a console child a **new visible console**. Use `windowsHide: true` with it. Put both in
`platform.spawnDefaults` and spread them into every call.

---

## 16. never-look, security-window and terminal vocabularies

Matching facts: `isNeverLook` is a case-insensitive **substring** test on `${app} ${title}` (perception/elements.ts:440-443).
`isSecurityWindow` tests `SECURITY_APP` on `app` and `SECURITY_TITLE` on the normalized (lower-cased) title, anchored
at the start (policy.ts:398-407). perception/index.ts:323 also tests each word of `wmClass`. `isTerminalApp` works
on id words and names (system.ts:294-323).

### 16.1 never-look defaults (settings.ts:46-47, copy.ts:6-16)
| OS | Stored entries (lower case, substrings) | Shown as |
|---|---|---|
| L | `keepassxc, seahorse, passwords and keys, 1password, bitwarden, polkit` | unchanged |
| W | `keepass` (also covers KeePassXC), `1password`, `bitwarden`, `lastpass`, `dashlane`, `nordpass`, `roboform`, `enpass`, `keeper`, `credentialuibroker` | KeePass, 1Password, Bitwarden, LastPass, Dashlane, NordPass, RoboForm, Enpass, Keeper, "Password prompts (Windows Security)" |
| M | `keepassxc, 1password, bitwarden, lastpass, dashlane, enpass, strongbox, macpass, keychain access, securityagent` | …, "Keychain Access", "Password prompts (SecurityAgent)" |

Avoid generic words such as "passwords" (Apple's Passwords app) or "windows security" as never-look substrings.
They would hide every document titled "passwords policy.docx". Put those in `isSecurityWindow` as exact app or
title matches.

### 16.2 `isSecurityWindow` additions (policy.ts:398-400). The perception sidecar's `shell_overlays` should report them too.
`SECURITY_APP` (anchored per word, optional `.exe`):
- [W] `credentialuibroker` (Windows Security credential prompt), `consent` (UAC, visible when the secure desktop is
  off), `logonui`, `lockapp`, `sechealthui` / `securityhealthhost` (Windows Security app, the analogue of
  firewall-config), `smartscreen` ("Windows protected your PC" → Run anyway), `bdeunlock` / `bdeuisrv` (BitLocker
  unlock), `microsoft.aad.brokerplugin` (work/school sign-in), `wwahost` (Microsoft account web sign-in),
  `pinenrollmentbroker`, `bioenrollmenthost` (Windows Hello setup), `credentialenrollmentmanager`.
- [M] `securityagent` (admin/keychain prompts), `coreautha` / `coreauthd` (Touch ID and LocalAuthentication
  sheets), `loginwindow`, `screensaverengine`, `coreservicesuiagent` (Gatekeeper "downloaded from the Internet…
  Open"), `keychain access` / `com.apple.keychainaccess`, `passwords` / `com.apple.passwords` (exact app only),
  `ticket viewer`, `certificate assistant`.

`SECURITY_TITLE` additions (start of title, whole title where noted):
- [W] `^(windows security|user account control|enter network credentials|windows hello|making sure it's you|credential manager|stored user names and passwords|bitlocker drive encryption|windows defender firewall with advanced security)$`.
- [M] `^(privacy & security|passwords|touch id & password|users & groups|login password)$` (System Settings pane
  titles), `^.* wants to (use your confidential information|make changes)` (SecurityAgent prompt text when read as a
  title).
- `RUN_FILE_DIALOG`/`RUNS_PROGRAM` (policy.ts:625-645): add "run anyway" (SmartScreen), "open file - security
  warning" (W), "are you sure you want to open it" (Gatekeeper, M).

Today none of `CredentialUIBroker`, `consent`, `SecurityAgent`, `coreautha`, "Windows Security", "User Account
Control" match (confirmed in sidecar-consumers.md §8.6).

### 16.3 Terminal and built-in-shell vocabulary (system.ts:136-162)
- `TERMINALS` [W]: `cmd, powershell, pwsh, pwsh-preview, windowsterminal, wt, openconsole, conhost, wsl, wslhost, bash, ubuntu, ubuntu2004, ubuntu2204, ubuntu2404, debian, kali, mintty, git-bash, cmder, conemu, conemu64, conemuc, conemuc64, fluentterminal, mobaxterm, securecrt, xshell, termius` (putty, kitty, alacritty, wezterm-gui, hyper, tabby are already there).
- `TERMINALS` [M]: `iterm, iterm2, warp, xquartz, x11` (terminal, ghostty, kitty, alacritty, wezterm, hyper, tabby, rio are already there).
- `SHELL_APP_ID` [W] AppIDs: `^microsoft\.windowsterminal.*|^microsoft\.powershell.*|^canonicalgroup.*ubuntu.*|^thedebianproject\..*|^kalilinux\..*|^microsoftcorporationii\.windowssubsystemforlinux.*` (the `!App` suffix is split off by idWords).
- `SHELL_APP_ID` [M] bundle ids: `com\.apple\.terminal|com\.googlecode\.iterm2|dev\.warp\..*|org\.xquartz\..*|org\.macosforge\.xquartz\..*`
  (terminals), and shell apps `com\.apple\.scripteditor\d*|com\.apple\.automator|com\.apple\.shortcuts|com\.apple\.dt\.xcode|com\.microsoft\.vscode.*|com\.barebones\.bbedit|com\.macromates\.textmate|com\.panic\.nova|org\.vim\.macvim|com\.google\.android\.studio`.
- `SHELL_APP` names [W]: `devenv` (Visual Studio), `powershell_ise`, `notepad\+\+` (Run > Run… executes any
  command line), `cursor`, `windsurf`. [M]: `xcode`, `bbedit`, `textmate`, `nova`, `macvim`, `script ?editor`,
  `automator`, `shortcuts`, `cursor`.
- `SHELL_APP_NAME` additions: `windows powershell ise|visual studio(?! code)|notepad\+\+|script editor|automator|shortcuts|xcode|bbedit|textmate|macvim|cursor|windsurf|microsoft visual basic for applications`
  (the VBA editor window).
- Name regex (system.ts:321): section 2.4. Note that macOS's log viewer "Console" then counts as a terminal (a harmless refusal).
- Also refuse: [W] Run dialog, Start/Search hosts, Task Manager, File Explorer address bar (2.5). [M] Spotlight.

---

## 17. Other details in scope

- **Notifications [W]** (main.ts:602-604 `new Notification`): Windows only shows toasts for an app whose
  AppUserModelID matches a Start Menu shortcut. Call `app.setAppUserModelId("<appId>")` early in main, matching the
  installer's shortcut. Without it, "Ember needs your OK" toasts (main.ts:598) and task-finished toasts (:1307)
  silently never appear.
- **macOS app lifecycle** (window owners): without an app menu Electron supplies Cmd+Q, which quits **without**
  the busy-task question (`quitEmber`, main.ts:390-404). Handle `before-quit` or set a custom menu. Use
  `LSUIElement` (no Dock icon) or handle `activate` → `showHome`.
- `app.setName("ember")` (main.ts:75) also names the macOS Keychain item (7.1) and the default Windows Run value.
  Decide on "Ember" vs "ember" once: changing it later orphans the stored token and the login item.
- `bringToFront`/`getNativeWindowHandle().readUInt32LE(0)` (main.ts:238, :501, :1017) is X11-shaped. A macOS
  NSView* is 64-bit. That belongs to the window spec.
- host.ts `runtimeEnv` (:947-981) copies `process.env` and sets both `NO_PROXY` and `no_proxy`. On Windows env names
  are case-insensitive. Node passes both and the child sees one (Node sorts keys, the first case-insensitive match
  wins). The values are equal, so it is harmless. `resolveProxy` follows WinINET/PAC on Windows and system proxy
  settings on macOS. The comments say "GNOME's settings".
- Corporate TLS inspection is more common on Windows fleets. The Copilot runtime may not trust the Windows or macOS
  certificate store (unknown runtime build). Consider passing `NODE_USE_SYSTEM_CA=1` in `runtimeEnv` (**verify**
  the runtime honours it). explainStartError's certificate message already covers the failure.
- Logger (logger.ts): portable. Rotation `renameSync` (:73-75) can hit EBUSY on Windows while a concurrent
  `--doctor` run appends. That is caught (:91).
- DeskManager (desk/desk.ts:369-372): gate `available()` on `process.platform === "linux"` (see 10). `hands.desk`
  (main.ts:1270) and `--doctor` follow.
- `inotifyUse`/`inotifyUsedUp` (host.ts:197-222): return null/false off Linux already. `NO_WATCHERS_WHY` (:182) is
  Linux wording that is never shown elsewhere.
- policy.ts:670 `shortTitle` only shortens `/` paths, and :668 `TABBED_APP` lacks `msedge|outlook|olk|safari`.
  These belong to the policy owners but affect app names discussed here.

---

## 18. Tests that encode Linux behaviour (must stay green on Linux CI; add OS-parameterized twins)
- test/unit/launch-app.test.ts:14-27 (gtk-launch + Exec fallback). Add a win32 explorer.exe test and a darwin
  `open -a` test with injected platform.
- test/unit/desk.test.ts:10, :442-470 (appEnv allow/deny), :472+ (GNOME 3.32 dark theme). Add a win32 case-insensitive `Path` test.
- test/unit/tasks.test.ts:7, :269 (findApp/listApps/execArgv).
- test/unit/packaging.test.ts:9, :86-105 (launchCommand, autostartEntry, syncAutostart).
- test/unit/agent-misc.test.ts:114-119 (locateRuntime finds the linux runtime in this checkout).
- test/unit/environment.test.ts (RHEL 8.4 GNOME fixture). Add Windows and macOS input fixtures.
- test/unit/ui-copy.test.ts:52-57 (never-look defaults equality). Parameterize by OS.
- test/unit/policy.test.ts:23, :363 (polkit security windows), :173+ (journalLine). Add Windows and macOS security-window rows from 16.2.
- test/unit/voice-models.test.ts, voice-speakers.test.ts (tar, parec).
- test/unit/settings.test.ts:70-76 (speakerRejection default).

---

## 19. Riskiest findings (ranked)
1. **Admin policy trust bypass on Windows** if the POSIX check is kept (uid is always 0, read-only attribute → mode
   0o444, and users can create `C:\etc\…` and `%ProgramData%\Ember`). Use `HKLM\SOFTWARE\Policies\Ember`, or a
   SID-based owner+DACL check on the file **and** its folder (4.1).
2. **Terminal and security-prompt refusal is name-based and doesn't know Windows or macOS names** (16.2/16.3). Also,
   File Explorer's address bar, the Run dialog, Start search and Spotlight run commands from typed text (2.5).
3. **Launching apps from Ember's process leaks Ember's environment** on Windows (`shell.openPath` inherits it).
   On win32 `appEnv`'s regexes are case-sensitive and drop `Path`. Delegate to explorer.exe / `open` (2.2, 2.3).
4. **`isAccessibilitySupportEnabled()` false positives** make Ember speak everything on Windows and macOS (11.1).
5. **Shortcuts:** Ctrl+Alt = AltGr on Windows (ę ń ź € µ). ⌃⌥ = VoiceOver on macOS. `LOGO_KEY` maps cmd → super,
   so every macOS Cmd shortcut becomes a refused "system key" (14).
6. **`execArgv` corrupts Windows paths.** Add `DesktopApp.argv` and use it everywhere (1).
7. **The macOS GUI PATH lacks Homebrew**, so `gh` sign-in is never found (7.2). **Console flashes** without
   `windowsHide` (15).
8. **Autostart on macOS can't pass `--autostart`**, and every SMAppService register shows a notification. Don't
   call it on every settings change (5).
9. **`tar -xjf`** on Windows may hit Git's GNU tar or an old bsdtar without bzip2. Prefer a JS extractor (12.1).
10. The `platform` check fails non-Linux, which marks the whole setup as failing (9.1). The macOS TCC permissions
    (Accessibility, Screen Recording with a restart, Microphone, Automation for dark mode) need checks and fixes (9.2-9.4, 2.6, 12.1).
