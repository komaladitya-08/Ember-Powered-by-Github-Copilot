/**
 * Remote surfaces: windows that show another computer's screen, or a Linux app's, as pixels only. On Windows these
 * are the windows of Windows' own Remote Desktop clients, and WSLg's: WSLg draws every Linux app's window as an RDP
 * "RAIL" window of msrdc.exe. Ember names a window by its program, so whatever runs inside one (a Linux terminal, a
 * polkit or pinentry prompt, a whole remote desktop) is just "msrdc" or "mstsc" to it: the terminal, security-window
 * and never-look checks can't see in, one grant would cover every Linux app, and the borrow's pointer check takes any
 * window of the process for the target. Ember acts in none of them (policy.ts) and blacks them out of every screenshot
 * (perception). Reading stays as it is: accessibility sees nothing inside, only the title, which the security and
 * never-look checks still read. A WSLg window the WSL router identifies is renamed "wsl:<distro>:<app>"
 * (wsl/routed-windows.ts) and so is no longer one of these: only the ones it can't identify stay remote surfaces.
 * Windows only: the other OSes' rows are null, so Linux and macOS decide exactly as before.
 */

import type { OS } from "../../shared/shortcuts";

/**
 * The programs whose every window is a remote surface, tested on the window's app (trimmed): on Windows its program's
 * file name, with or without ".exe", any case. The clients are refused whole, their lists of desktops and connection
 * dialogs too: some draw sessions in their own windows, and staying out costs only clicks there.
 * - msrdc: WSLg's RAIL windows, and the sessions of the Remote Desktop (Azure Virtual Desktop) and Windows App clients;
 * - mstsc: Remote Desktop Connection, its RemoteApp windows included;
 * - msrdcw: the Remote Desktop client's own window (it starts msrdc for each session);
 * - Windows365: the Windows App (verify on a real install that its sessions are msrdc's);
 * - RdClient.Windows: the Microsoft Store's Remote Desktop app, which draws its sessions itself;
 * - the X servers for Windows that show Linux apps' windows as their own (critique wsl-15): VcXsrv (vcxsrv), X410
 *   (x410), Xming (xming), Cygwin/X (xwin) and GWSL, whose Linux windows belong to its bundled VcXsrv, GWSL_vcxsrv
 *   or GWSL_vcxsrv_lowdpi (GWSL.exe is its dashboard, GWSL_service its tray service: every GWSL_* program is
 *   counted, as the WSL doctor counts them). Nothing tells which Linux app draws which of their windows (WSL 1
 *   users, or WSLg turned off), so they stay remote surfaces; WSLg's windows can be identified (wsl/).
 */
export const REMOTE_SURFACE: Readonly<Record<OS, RegExp | null>> = {
  linux: null,
  win32: /^(?:msrdc|mstsc|msrdcw|windows365|rdclient\.windows|vcxsrv|x410|xming|xwin|gwsl(?:_\w+)?)(?:\.exe)?$/i,
  darwin: null,
};

/** The X servers for Windows among the remote surfaces (the WSL doctor row says their Linux apps can't be used). */
const WINDOWS_X_SERVER = /^(?:vcxsrv|x410|xming|xwin|gwsl(?:_\w+)?)(?:\.exe)?$/i;

/** Is `app` (a window's app) an X server for Windows showing Linux apps (VcXsrv, X410, Xming, Cygwin/X, GWSL)? */
export function isWindowsXServer(app: string, os: OS): boolean {
  return os === "win32" && WINDOWS_X_SERVER.test(app.trim());
}

/** Why Ember refuses to act in one (a "never" reason: the worker says "Not allowed: <reason>."). */
export const REMOTE_SURFACE_REASON = "Ember can't tell what's inside a remote window (a remote desktop, or a Linux app under WSL), so it never acts in one";

/** Is `app` (a window's app, as the policy and perception name it) a remote surface on `os`? Always false off Windows. */
export function isRemoteSurface(app: string, os: OS): boolean {
  return REMOTE_SURFACE[os]?.test(app.trim()) ?? false;
}

/**
 * The check for `os`, for Perception's options: undefined where no window is a remote surface, so Linux and macOS
 * capture exactly as before.
 */
export function remoteSurfaceCheck(os: OS): ((app: string) => boolean) | undefined {
  return REMOTE_SURFACE[os] ? app => isRemoteSurface(app, os) : undefined;
}

/**
 * Is this msrdc.exe WSLg's, not a Remote Desktop or Windows App client's, by its image path (as hwnd.ts programOf
 * reads it, Win32 or device form)? WSL keeps it in its install folder, "C:\Program Files\WSL\" (verify), and the
 * Store's WSL before 2.0 in its package folder "…\WindowsApps\MicrosoftCorporationII.WindowsSubsystemForLinux_…\"
 * (verify). The WSL router (wsl/rail.ts) identifies only windows of such an msrdc: a Remote Desktop client's stay
 * remote surfaces whatever their titles say.
 */
export function isWslgImage(imagePath: string): boolean {
  return /[\\/]program files[\\/]wsl[\\/]msrdc\.exe$|[\\/]windowsapps[\\/]microsoftcorporationii\.windowssubsystemforlinux_[^\\/]*[\\/](?:[^\\/]+[\\/])*msrdc\.exe$/i
    .test(imagePath.trim());
}
