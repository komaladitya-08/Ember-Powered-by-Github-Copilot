/** User-facing words that differ per OS (persona, tool descriptions, perception notes, copy). Linux values are today's text, verbatim. */
import type { OS } from "./shortcuts";

/** The words that differ per OS, one field per place they are used. */
export interface PlatformWords {
  /** persona.ts IDENTITY: "…on their ${desktop}." */
  readonly desktop: string;
  /** worker-persona.ts WORKER_IDENTITY / GUIDE_IDENTITY: "…in the user's real ${apps}…". */
  readonly apps: string;
  /** persona.ts TOOL_RULES "(the terminal, ${fileManager}, a browser)". */
  readonly fileManager: string;
  readonly settingsApp: string;
  /** worker.ts open_app description: "(for example ${openAppExamples})". */
  readonly openAppExamples: string;
  /** worker.ts press_keys description examples. */
  readonly keyExamples: string;
  /** worker.ts:1655 tail. */
  readonly fileDialogPathHint: string;
  /** conductor.ts describe_screen fallback "(${noScreen})". */
  readonly noScreen: string;
  /** host.ts explainStartError, doctor.ts runtime fix. */
  readonly reinstall: string;
  /** perception/index.ts:422 (shell_overlays incomplete). */
  readonly shellUnchecked: string;
  /** perception/index.ts:424 (an overview of every window is open). */
  readonly overviewOpen: string;
  /** main.ts:887-889: why a sign-in can't be kept ("No keyring is available"). */
  readonly keyringMissing: string;
  /** home/index.html:91 consent copy. */
  readonly micIndicator: string;
  /** home/index.html:31 consent copy, after "through the desktop's accessibility service": what the OS will ask for ("" when nothing). */
  readonly permissionsNote: string;
}

/** The words for each OS. The Linux row is today's text, verbatim. */
export const PLATFORM_WORDS: Readonly<Record<OS, PlatformWords>> = {
  linux: {
    desktop: "Linux desktop (RHEL, GNOME)", apps: "Linux desktop applications (RHEL, GNOME)", fileManager: "Files",
    settingsApp: "Settings", openAppExamples: "Text Editor, Files, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
    fileDialogPathHint: "in a file dialog press Ctrl+L (or use its name field) and type the file's name",
    noScreen: "no X11 display or accessibility service", reinstall: "Reinstall Ember (sudo dnf reinstall ember).",
    shellUnchecked: "GNOME Shell didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "the Activities overview or the window switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "No keyring is available", micIndicator: "GNOME shows a microphone icon while Ember listens.", permissionsNote: "",
  },
  win32: {
    desktop: "Windows PC", apps: "Windows applications", fileManager: "File Explorer", settingsApp: "Settings",
    openAppExamples: "Notepad, File Explorer, Settings", keyExamples: "\"ctrl+s\", \"Return\", \"ctrl+shift+t\"",
    fileDialogPathHint: "in a file dialog type the file's full path in the File name box",
    noScreen: "the accessibility helper isn't running", reinstall: "Reinstall Ember.",
    shellUnchecked: "Windows didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    // The accessibility host reports Start and Search as overviews too (they can show any window's preview).
    overviewOpen: "Task View, the window switcher, Start or Search is open (they can show any window), so Ember looks away until it's closed",
    keyringMissing: "Windows couldn't protect the sign-in on this computer",
    micIndicator: "Windows shows a microphone icon in the taskbar while Ember listens.", permissionsNote: "",
  },
  darwin: {
    desktop: "Mac", apps: "Mac applications", fileManager: "Finder", settingsApp: "System Settings",
    openAppExamples: "TextEdit, Finder, System Settings", keyExamples: "\"cmd+s\", \"Return\", \"cmd+shift+t\"",
    fileDialogPathHint: "in a file dialog press Command+Shift+G, type the folder's path, then choose the file",
    noScreen: "Ember doesn't have Accessibility permission", reinstall: "Install Ember again (drag a fresh Ember.app into Applications).",
    shellUnchecked: "macOS didn't answer in time, so Ember can't tell whether a system dialog (a password prompt) is open; try again in a moment",
    overviewOpen: "Mission Control or the app switcher is open (it shows every window), so Ember looks away until it's closed",
    keyringMissing: "Keychain access was denied",
    micIndicator: "macOS shows an orange dot in the menu bar while Ember listens.",
    // Input Monitoring too: keyboard borrowing needs it until CI shows key-state polling doesn't (design Q10).
    permissionsNote: "macOS will ask you to allow Accessibility, Screen Recording and Input Monitoring for Ember.",
  },
};
