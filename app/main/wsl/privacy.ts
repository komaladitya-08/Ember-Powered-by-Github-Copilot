/**
 * WSL-aware privacy and system (§4.5, §4.8; owned by package WB). STUB from Step 0a: both functions return what they
 * are given, so the PC's own checks and app catalogue stay exactly as they are.
 */

import type { AppIdentity, PrivacyVocabulary, SystemPlatform } from "../platform/types";

/** The PC's privacy and terminal checks, extended so a `wsl:<distro>:<app>` window is also judged as a Linux app. */
export function wslAwarePrivacy(p: { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean }):
  { isSecurityWindow: PrivacyVocabulary["isSecurityWindow"]; isTerminalApp: (app: AppIdentity) => boolean } {
  return p;
}

/** The system with WSLg apps in its catalogue (withWslApps, §4.8). */
export function wslAwareSystem(sys: SystemPlatform): SystemPlatform {
  return sys;
}
