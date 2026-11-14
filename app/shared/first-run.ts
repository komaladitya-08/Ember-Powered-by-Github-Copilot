/**
 * First run's one agreement (owner decision of 2026-11-12, CLAUDE.md "Consent"): the consent step shows five rows, each
 * with its own switch, on by default, and its own card's full text, and agreeing records CONSENT_VERSION and then,
 * for each row left on, what agreeing to that row's own card records. Which rows are shown and which can be turned on
 * is decided here, from facts main reads (the organisation's policy, the speech models, what the user agreed to before),
 * so Home and main can't disagree about it. Pure: no DOM, no Electron, no Node.
 */

/** The rows, in the order the page shows them. */
export const FIRST_RUN_ROWS = ["commands", "memory", "voice", "screenshots", "interactive"] as const;
export type FirstRunRow = (typeof FIRST_RUN_ROWS)[number];

/** The switches as the user left them: true is on. */
export type FirstRunChoice = Readonly<Record<FirstRunRow, boolean>>;

/** What main reads before the rows are drawn and again when they are agreed to. */
export interface FirstRunFacts {
  /** The user agreed to an earlier CONSENT_VERSION: their own settings stand, and only Interactive's row is shown. */
  returning: boolean;
  /** The organisation's policy can't be used (or changed while Ember ran): every row is off and managed. */
  locked: boolean;
  /** What the organisation allows: false is a feature it turned off (commands: commands on this computer aren't "off"). */
  allowed: Readonly<Record<FirstRunRow, boolean>>;
  /** The speech models are on this computer, so listening can start; otherwise they must be downloaded first. */
  modelsReady: boolean;
  /** Interactive's card is agreed to as it reads now: nothing to ask a returning user. */
  interactiveAgreed: boolean;
  /** Main could build this computer's commands card (its text and hash) to show. */
  commandsCard: boolean;
}

/** Why a shown row can't be turned on here. */
export type FirstRunWhy = "organisation" | "locked" | "models" | "unavailable";

/** One row as the page draws it. */
export interface FirstRunRowState {
  row: FirstRunRow;
  /** Its switch can be turned on (and starts on); otherwise it is off, and `why` says why. */
  offered: boolean;
  why: FirstRunWhy | null;
}

/**
 * The rows the consent step shows, in order: all five for someone new; for someone who agreed to an earlier version,
 * Interactive's alone while its card isn't agreed to (they are below Interactive until they agree to it), and none
 * once it is. A row the organisation turned off (every row under a lockdown) is shown off and managed; listening
 * without the speech models is shown off, saying they must be downloaded first.
 */
export function firstRunRows(f: FirstRunFacts): FirstRunRowState[] {
  const rows = f.returning ? (f.interactiveAgreed ? [] : (["interactive"] as const)) : FIRST_RUN_ROWS;
  return rows.map(row => {
    const why: FirstRunWhy | null = f.locked ? "locked" : !f.allowed[row] ? "organisation"
      : row === "voice" && !f.modelsReady ? "models" : row === "commands" && !f.commandsCard ? "unavailable" : null;
    return { row, offered: why === null, why };
  });
}

/** The switches' starting positions: every offered row on, the rest off. */
export function firstRunDefaults(rows: readonly FirstRunRowState[]): FirstRunChoice {
  const on = new Set(rows.filter(r => r.offered).map(r => r.row));
  return Object.fromEntries(FIRST_RUN_ROWS.map(r => [r, on.has(r)])) as Record<FirstRunRow, boolean>;
}

/**
 * What the agreement does, from the facts as they are when it is pressed (read again then, not taken from the page):
 * `on`, the rows to turn on with their own consent, in order; `off`, a new user's rows that a fresh settings file
 * would otherwise start on (spoken replies and screenshots) and that aren't turned on here, switched off or not
 * offered, so each stays off as its row says. A row that isn't shown, isn't offered or was turned off gets no consent,
 * and a returning user's own settings are never touched but for Interactive's row.
 */
export function firstRunPlan(f: FirstRunFacts, choice: FirstRunChoice): { on: FirstRunRow[]; off: FirstRunRow[] } {
  const rows = firstRunRows(f);
  const on = rows.filter(r => r.offered && choice[r.row] === true).map(r => r.row);
  // One not offered is written off too: its row says it stays off, and spoken replies would otherwise speak through the
  // system's voices without the speech models (slice4-x9-2).
  const off = f.returning ? [] : rows.filter(r => !on.includes(r.row) && (r.row === "voice" || r.row === "screenshots")).map(r => r.row);
  return { on, off };
}

/**
 * Whether the organisation leaves the listening row's two parts to the user: it turns on listening and spoken replies
 * together, so a policy that turned either off shows it managed (slice4-x9-2).
 */
export function firstRunAllowsVoice(features: { voice?: boolean; speak?: boolean }): boolean {
  return features.voice !== false && features.speak !== false;
}

/**
 * What the “Hey Ember” card's yes records in the voice settings, over what is there (Home's consent-yes and first run's
 * listening row both use it, so the two can't differ, slice4-x9-4): the consent, and nothing heard over Ember's own
 * voice taken as the user's.
 */
export const HEY_EMBER_YES = { consent: true, speakerRejection: true } as const;

/** Main's answer to the agreement. */
export interface FirstRunDone {
  /** CONSENT_VERSION was recorded: false, nothing was recorded or turned on (the notice says why). */
  ok: boolean;
  /** The rows that were left on but couldn't be turned on (a save or the audit log failed): each is off, without consent. */
  failed: FirstRunRow[];
}

/** This computer's commands card as main builds it (app/main/targets/consent.ts commandsConsent), shown whole in its row. */
export interface FirstRunCard { title: string; body: string[]; sha256: string }

/** What the consent step is told: the rows, and the commands card's text when its row is shown. */
export interface FirstRunView { rows: FirstRunRowState[]; commands: FirstRunCard | null }

/** Home's channels for first run's agreement: main takes them only from the settings window (app/main/first-run.ts). */
export const FIRST_RUN_IPC = {
  /** The rows to draw (FirstRunView). */
  view: "first-run:view",
  /**
   * The agreement: the switches as left and the hash of the commands card the row showed (null without it). Main
   * records CONSENT_VERSION, then each row left on through its own card's record, and answers FirstRunDone.
   */
  agree: "first-run:agree",
} as const;
