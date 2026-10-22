/**
 * Remote surfaces: windows that show another computer's screen, or a Linux app's, as pixels only. On Windows these
 * are the windows of Windows' own Remote Desktop clients, and WSLg's: WSLg draws every Linux app's window as an RDP
 * "RAIL" window of msrdc.exe. Ember names a window by its program, so whatever runs inside one (a Linux terminal, a
 * polkit or pinentry prompt, a whole remote desktop) is just "msrdc" or "mstsc" to it: the terminal, security-window
 * and never-look checks can't see in, one grant would cover every Linux app, and the borrow's pointer check takes any
 * window of the process for the target. Until a window inside can be identified (the WSL work), Ember acts in none
 * of them (policy.ts) and blacks them out of every screenshot (perception). Reading stays as it is: accessibility
 * sees nothing inside, only the title, which the security and never-look checks still read.
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
 * - RdClient.Windows: the Microsoft Store's Remote Desktop app, which draws its sessions itself.
 */
export const REMOTE_SURFACE: Readonly<Record<OS, RegExp | null>> = {
  linux: null,
  win32: /^(?:msrdc|mstsc|msrdcw|windows365|rdclient\.windows)(?:\.exe)?$/i,
  darwin: null,
};

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
 * (verify). For the WSL work, which must tell WSLg's windows from a remote desktop's; nothing decides on it yet,
 * because every msrdc window is a remote surface either way.
 */
export function isWslgImage(imagePath: string): boolean {
  return /[\\/]program files[\\/]wsl[\\/]msrdc\.exe$|[\\/]windowsapps[\\/]microsoftcorporationii\.windowssubsystemforlinux_[^\\/]*[\\/](?:[^\\/]+[\\/])*msrdc\.exe$/i
    .test(imagePath.trim());
}
