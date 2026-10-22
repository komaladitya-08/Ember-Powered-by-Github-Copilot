/**
 * The remote agent, `ember-remote` (§5.3; owned by package SB): Ember's eyes, hands and command runner on a computer
 * reached over SSH, under that computer's admin policy and audit. Plain Node: built to dist/remote/ember-remote.cjs and
 * run by the Node runtime Ember brings; nothing in its import graph may load Electron, sharp or the Copilot SDK.
 * STUB from Step 0a: it says it isn't built (the bootstrap's own error form) and exits 2.
 */

/** Runs the agent (this stub: refuses). */
export function main(): void {
  process.stderr.write("EMBER-ERROR not-built\n");
  process.exit(2);
}

// Only when run as dist/remote/ember-remote.cjs (esbuild's CommonJS entry), never when a test imports the module.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) main();
