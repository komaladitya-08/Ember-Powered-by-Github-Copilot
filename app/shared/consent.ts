import type { TargetId } from "./targets";

/** Bumped when what Ember does with the screen or data changes: everyone is asked again. */
export const CONSENT_VERSION = 1;

/**
 * The versions of the first-use consent cards for WSL, SSH (per host) and commands (per target), recorded apart from
 * CONSENT_VERSION (L1: the global consent stays true for everything Ember does without them). Bumping one asks that
 * card again, and nothing else.
 */
export const FEATURE_CONSENT_VERSION = { wsl: 1, ssh: 1, commands: 1 } as const;

/**
 * A first-use consent card (§8.4): its exact text, and a hash of it that the yes must carry back. Shown in Ember's
 * prompt window; confirm.ts takes it as a question's panel.
 */
export interface ConsentPanel {
  feature: "commands" | "wsl" | "ssh";
  target: TargetId;
  targetLabel: string;
  title: string;
  body: string[];
  yes: string;
  no: string;
  /** sha256Hex of title + "\n" + body.join("\n"). */
  sha256: string;
}
