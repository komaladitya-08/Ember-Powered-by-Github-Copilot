/**
 * Ember's job host (§3.3, §3.13; package RUN), built to dist/app/job-host.cjs: Ember's own binary run as plain Node
 * (ELECTRON_RUN_AS_NODE=1) as `job-host.cjs --interactive|--batch -- <program> <args…>`. Before it starts anything it
 * creates a job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and puts itself in it, so every process the command
 * starts is in the job from birth (critique integration-9); if it can't, it exits 125 with `job:` on stderr and the run
 * fails to start. It then runs the program hidden, relays its own stdin to it when interactive, and exits with the
 * program's code. When its own stdin ends (Ember quit, crashed or stopped the run) it calls TerminateJobObject: the
 * whole tree ends at once. Ember holds its stdin open for the run's life.
 *
 * Never import this module from code bundled into Ember's main process (local.ts takes JOB_FAILED and jobHostArgv from
 * win32-job.ts): its last line runs main() when it is the main module, and inside a bundle `module` is the bundle's.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { JOB_FAILED, JOB_FAILED_PREFIX, jobApiError, loadJobApi, type JobApi, type JobHandle } from "./win32-job";

export { JOB_FAILED };

/** The job host's arguments, or null when they aren't its own form. */
export function parseJobHostArgs(argv: readonly string[]): { interactive: boolean; program: string; args: string[] } | null {
  const [mode, dashes, program, ...args] = argv;
  if ((mode !== "--interactive" && mode !== "--batch") || dashes !== "--" || !program) return null;
  return { interactive: mode === "--interactive", program, args };
}

/** The child the job host starts (a ChildProcess; a fake in the tests). */
export interface JobChild {
  readonly stdin: { write(chunk: Uint8Array): unknown; on(event: "error", fn: (err: Error) => void): unknown } | null;
  on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
}

/** What the job host uses (process-wide things in main(); fakes in the tests). */
export interface JobHostDeps {
  job(): JobApi | null;
  spawn(program: string, args: string[], options: SpawnOptions): JobChild;
  stdin: {
    on(event: "data", fn: (chunk: Uint8Array) => void): unknown;
    on(event: "end" | "close", fn: () => void): unknown;
    on(event: "error", fn: (err: Error) => void): unknown;
    resume(): unknown;
  };
  stderr: { write(text: string): unknown };
  exit(code: number): void;
  env: NodeJS.ProcessEnv;
}

/** Runs the job host on `argv` (the arguments after the script). */
export function runJobHost(argv: readonly string[], deps: JobHostDeps): void {
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    deps.exit(code);
  };
  const fail = (why: string) => {
    if (exited) return;
    deps.stderr.write(`${JOB_FAILED_PREFIX} ${why}\n`);
    exit(JOB_FAILED);
  };

  const parsed = parseJobHostArgs(argv);
  if (!parsed) return fail("bad arguments");
  let api: JobApi | null;
  let why = "";
  try {
    api = deps.job();
  } catch (err) {
    api = null;
    why = err instanceof Error ? ` (${err.message})` : "";
  }
  if (!api) return fail(`job objects aren't available here${why}`);
  let job: JobHandle;
  try {
    job = api.createKillOnCloseJob();
    // Itself first: everything it starts from here on is born inside the job.
    api.assignSelf(job);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const jobApi = api;

  // ELECTRON_RUN_AS_NODE was for the host itself: an Electron app the command starts (`code .`) must start as itself.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(deps.env)) if (k.toUpperCase() !== "ELECTRON_RUN_AS_NODE") env[k] = v;
  let child: JobChild;
  try {
    child = deps.spawn(parsed.program, parsed.args, { windowsHide: true, stdio: [parsed.interactive ? "pipe" : "ignore", "inherit", "inherit"], env });
  } catch (err) {
    return fail(`can't start ${parsed.program}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Only a start failure comes before "exit": the program never ran.
  child.on("error", err => fail(`can't start ${parsed.program}: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
  child.on("exit", (code, signal) => exit(code ?? (signal ? 1 : 0)));

  const childIn = parsed.interactive ? child.stdin : null;
  childIn?.on("error", () => {
    // the program closed its stdin: typing has nowhere to go, which is the program's business
  });
  deps.stdin.on("data", chunk => {
    if (childIn) childIn.write(chunk);
  });
  const endAll = () => {
    if (exited) return;
    // Ends the program's whole tree, and this process with it (it is in the job too).
    jobApi.terminate(job, 1);
    exit(1);
  };
  deps.stdin.on("end", endAll);
  deps.stdin.on("close", endAll);
  deps.stdin.on("error", endAll);
  deps.stdin.resume();
}

/** The job host as a program. */
export function main(): void {
  runJobHost(process.argv.slice(2), {
    job: () => {
      const api = loadJobApi();
      if (!api) throw jobApiError instanceof Error ? jobApiError : new Error("kernel32 couldn't be loaded");
      return api;
    },
    spawn: (program, args, options) => nodeSpawn(program, args, options),
    stdin: process.stdin,
    stderr: process.stderr,
    exit: code => process.exit(code),
    env: process.env,
  });
}

/** Whether this process was started as the job host: its entry module is this one, and the script it was given is job-host.cjs. */
export function isJobHostProcess(o: { isMain: boolean; script: string | undefined }): boolean {
  return o.isMain && /(^|[\\/])job-host\.cjs$/i.test(o.script ?? "");
}

// Only when run as dist/app/job-host.cjs (esbuild's CommonJS entry): never when a test imports the module, nor if a
// bundle that wrongly took this module in (whose `module` is then the bundle's own) is what runs.
if (typeof require !== "undefined" && typeof module !== "undefined" && isJobHostProcess({ isMain: require.main === module, script: process.argv[1] })) main();
