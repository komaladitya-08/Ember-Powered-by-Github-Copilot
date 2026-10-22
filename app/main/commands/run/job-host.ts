/**
 * Ember's job host (§3.3; owned by package RUN): Ember's own binary in node mode puts itself in a kill-on-close job
 * object, then runs the command's program inside it. Built to dist/app/job-host.cjs. STUB from Step 0a: run as a
 * program it fails as a job host that couldn't set up its job does (exit 125, `job` on stderr), so a run through it
 * fails to start; imported, it does nothing.
 */

/** The exit code of a job host that couldn't make or join its job: the run failed to start. */
export const JOB_FAILED = 125;

/** Runs the job host (this stub: refuses, as above). */
export function main(): void {
  process.stderr.write("job: not built\n");
  process.exit(JOB_FAILED);
}

// Only when run as dist/app/job-host.cjs (esbuild's CommonJS entry), never when a test imports the module.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) main();
