/**
 * The words the policy, the worker and the host match against, per OS: which windows are security prompts, which
 * apps are browsers, mail and office suites, which extra labels are risky, which boxes run what is typed into them,
 * how the user names the terminal, and what names a file. Pure data, keyed by OS, read through policy.ts and the
 * agent (one copy for every reader). The Linux rows are the expressions those files held before the port, moved
 * verbatim, and must not change (tests pin them).
 *
 * The Windows and macOS rows are package V's to fill, from names it checks on real windows. Until then a row that
 * only makes Ember more careful when it matches (browsers and chat apps, the user naming the terminal, a file's
 * path) starts as the Linux row, whose words are English and app names that exist there too, and a row whose Linux
 * names mean nothing there (GNOME's and polkit's prompts) starts empty: null or [].
 */

import type { OS } from "../../shared/shortcuts";

/**
 * Programs that only ask for passwords, and the firewall's settings, tested on the window's app (trimmed). Linux:
 * polkit agents, the keyring's and GnuPG's prompts, and GNOME Shell, which draws its own password prompts in its own
 * window (Ember never acts in the shell anyway). null: none known on that OS yet.
 */
export const SECURITY_APP: Readonly<Record<OS, RegExp | null>> = {
  linux: /polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|^firewall-config$|(^|\s)gnome-shell(\s|$)/i,
  win32: null,
  darwin: null,
};

/**
 * Titles of authentication prompts, by how such a title starts (tested on the normalised title): never words that
 * turn up in ordinary titles too ("firewall-notes.txt", a page about sudo), so those windows are read and used as
 * usual. null: none known on that OS yet.
 */
export const SECURITY_TITLE: Readonly<Record<OS, RegExp | null>> = {
  linux: /^\s*(authenticat(e|ion)\b.*\b(required|request)\b|authenticate\s*$|(password|passphrase|pin) (required|request(ed)?)\b|enter (the |your |a )?(password|passphrase|pin)\b|unlock\b.*\b(keyring|private key|password|passphrase)\b|\[sudo\]|sudo password\b)/,
  win32: null,
  darwin: null,
};

/**
 * Window classes of security prompts (lower case, whole), for the backends that report one: perception passes a
 * window's class as its app (WM_CLASS's parts on Linux, the Win32 class on Windows), so it is matched where the app
 * is. Empty on Linux, whose prompts are known by their programs.
 */
export const SECURITY_CLASS: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  win32: [],
  darwin: [],
};

/** Apps whose window shows one page, message or chat after another, its title saying which: there another title is another place. */
export const TABBED_APP: Readonly<Record<OS, RegExp | null>> = (() => {
  const linux = /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|thunderbird|evolution|geary|claws|mail|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram/i;
  return { linux, win32: linux, darwin: linux };
})();

/** Web browsers and the apps built on a web engine (Electron), and chat apps: where Ember can't tell, a field there is a page's. */
export const WEB_APP: Readonly<Record<OS, RegExp | null>> = (() => {
  const linux = /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|electron|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram|whatsapp/i;
  return { linux, win32: linux, darwin: linux };
})();

/** Office suites: Enter in their fields and their documents' text never sends (LibreOffice on Linux). */
export const OFFICE_APP: Readonly<Record<OS, RegExp | null>> = (() => {
  const linux = /soffice|libreoffice/i;
  return { linux, win32: linux, darwin: linux };
})();

/**
 * Labels risky on that OS beyond policy.ts's RISKY (whole words, regular-expression source, matched on the normalised
 * label like RISKY): the system's own words for what can't be undone ("Move to Recycle Bin", "Force Quit").
 */
export const RISKY_EXTRA: Readonly<Record<OS, readonly string[]>> = { linux: [], win32: [], darwin: [] };

/**
 * Controls that run a program or let one run, beyond policy.ts's RUNS_PROGRAM (whole words, regular-expression source,
 * matched on the folded label): "Unblock" on a file's Properties, "Open Anyway", "Run anyway".
 */
export const RUNS_PROGRAM_EXTRA: Readonly<Record<OS, readonly string[]>> = { linux: [], win32: [], darwin: [] };

/**
 * Dialogs asking whether to run a file, beyond policy.ts's RUN_FILE_DIALOG (whole words, regular-expression source,
 * matched on the folded title and text): there the dialog's "Run" or "Open" runs it.
 */
export const RUN_FILE_DIALOG_EXTRA: Readonly<Record<OS, readonly string[]>> = { linux: [], win32: [], darwin: [] };

/** A box where text typed in runs a program (File Explorer's address box runs "cmd" with Enter). */
export interface TypingRefusal {
  /** The app, tested on ActionRequest.app (trimmed). */
  readonly app: RegExp;
  /** The box, tested on its accessible name (ActionRequest.element.name, trimmed). */
  readonly field: RegExp;
  /** The text refused there, tested on the text trimmed; absent: any text. */
  readonly text?: RegExp;
}

/** Boxes where type_text and fill_cells refuse to type a program's name. Empty on Linux: GNOME has no such box. */
export const TYPING_REFUSED: Readonly<Record<OS, readonly TypingRefusal[]>> = { linux: [], win32: [], darwin: [] };

/**
 * Does the user's request name a file (a path or a name with an extension), for the worker's note on a Save dialog's
 * suggestion (worker.ts dialogNote)?
 */
export const FILE_PATH_WORDS: Readonly<Record<OS, RegExp>> = (() => {
  const linux = /[~/][\w.-]|\.\w{1,5}\b/;
  return { linux, win32: linux, darwin: linux };
})();

/** How the user names the terminal as the way to do a task, for the host's refusal (host.ts startTask). */
export interface TerminalRequestWords {
  /**
   * They named the terminal (or a shell) as the way to do it: as what they open or use ("open the terminal", "use the
   * command line"), or where it's done ("run it in a terminal"). Not a word about it ("the terminal font").
   */
  readonly asks: RegExp;
  /** Or said not to use it ("in Files, not in the terminal", "without opening a terminal"): global, for String.replace. */
  readonly refuses: RegExp;
  /** A goal that names it itself. */
  readonly names: RegExp;
}

/** A terminal named as a thing to work in: not GNOME Shell's extensions, nor an app that only has "console" in its name. */
const TERMINAL = String.raw`(?:(?:gnome|kde|xfce)[- ])?(?:terminal|console(?![- ]companion))|command[- ]line|command prompt|shell(?![- ]extensions?\b)`
  // Or one word saying which terminal or shell ("the Linux terminal", "a bash shell", "a new terminal"; not GNOME's Shell).
  + String.raw`|(?!gnome\s)[\w.-]+\s+(?:terminal|shell(?![- ]extensions?\b))`;

/** The user's words for the terminal, per OS. */
export const TERMINAL_REQUEST: Readonly<Record<OS, TerminalRequestWords>> = (() => {
  const linux: TerminalRequestWords = {
    asks: new RegExp(String.raw`\b(?:open|use|launch|start|run|type(?:\s+(?:in|into))?|work\s+in)\s+(?:up\s+)?(?:(?:a|an|the|my|your)\s+)?(?:new\s+)?(?:${TERMINAL})\b|\b(?:in|into|from|via|using|with|through|on)\s+(?:(?:a|an|the|my|your)\s+)?(?:${TERMINAL})\b`, "i"),
    refuses: new RegExp(String.raw`\b(?:not|never|without|instead\s+of|rather\s+than|don['’]?t)\s+(?:(?:use|using|open|opening)\s+)?(?:(?:in|into|from|via|using|with|through|on)\s+)?(?:(?:a|an|the|my|your)\s+)?(?:${TERMINAL})\b`, "gi"),
    names: /\b(?:terminal|shell|command[- ]line|command prompt|console)\b/i,
  };
  return { linux, win32: linux, darwin: linux };
})();
