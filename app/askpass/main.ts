/**
 * Ember's askpass helper on Linux and macOS PCs (§5.1.6; owned by package SA): ssh runs it for a password, passphrase,
 * code or host key, and it asks Ember's prompt window. Built to dist/app/askpass.cjs. STUB from Step 0a: it answers
 * nothing and exits 1, which ssh takes as "cancelled".
 */

/** Runs the helper (this stub: cancels). */
export function main(): void {
  process.exit(1);
}

// Only when run as dist/app/askpass.cjs (esbuild's CommonJS entry), never when a test imports the module.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) main();
