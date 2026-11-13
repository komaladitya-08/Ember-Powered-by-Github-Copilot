// Checks that Ember's built-in GitHub App client id (app/main/agent/github-app.ts) still starts a sign-in: asks GitHub
// for a device code with it, as Ember's own device flow does, and prints only whether one came (never the code). The
// last step of ci.yml's checks job, there to catch a dead or misconfigured client id, so a client id or request GitHub
// refuses fails at once with its answer, and GitHub's own passing trouble (a 5xx, a network error, "request_failed",
// "slow_down", a body that isn't JSON) is tried again a few times, some seconds apart, before it fails the job: one
// such answer failed a run whose every test had passed (product-platform-flaky-4).
//   usage: node scripts/check-client-id.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** How many times GitHub is asked at most. */
export const TRIES = 4;
/** The wait before each further try, in ms: 50 s in all, far inside the job's time. */
const PAUSES = [5_000, 15_000, 30_000];
/** Errors that are GitHub's own trouble, or its asking for patience: worth another try. */
const PASSING = new Set(["request_failed", "slow_down"]);

/**
 * What one answer means: `pass` (a device code came), `retry` (GitHub's own trouble) or `fail` (the client id, the
 * scope or the request is wrong), with the line to print. `answer` is `{ status, body }`, or `{ failed }` when no
 * answer came. The line shows the error's name and description only: a device code is never printed.
 */
export function deviceCodeVerdict(answer) {
  if (typeof answer.status !== "number") return { verdict: "retry", says: `GitHub didn't answer: ${String(answer.failed ?? "no answer").slice(0, 200)}` };
  let j = null;
  try { j = JSON.parse(answer.body); } catch { /* not JSON: an error page, GitHub's own trouble */ }
  if (!j || typeof j !== "object") return { verdict: "retry", says: `GitHub answered ${answer.status}: not JSON` };
  const error = typeof j.error === "string" ? j.error : undefined;
  const shown = `GitHub answered ${answer.status}: ${JSON.stringify({ error, error_description: typeof j.error_description === "string" ? j.error_description : undefined })}`;
  if (answer.status >= 500 || (error && PASSING.has(error))) return { verdict: "retry", says: shown };
  const ok = answer.status >= 200 && answer.status < 300 && !error && typeof j.device_code === "string" && typeof j.user_code === "string";
  return ok ? { verdict: "pass", says: `GitHub answered ${answer.status}: a device code (not shown)` } : { verdict: "fail", says: shown };
}

/**
 * Asks for a device code with `id` until an answer passes or fails, at most TRIES times; returns the exit code.
 * `ask(body)` posts the form and resolves to `{ status, body }`; `wait(ms)` and `log(line)` are the clock and the output.
 */
export async function checkClientId({ id, ask, wait, log }) {
  if (!id) { log("no built-in client id (a fork or development build): nothing to check"); return 0; }
  for (let n = 1; ; n++) {
    let answer;
    try { answer = await ask(new URLSearchParams({ client_id: id, scope: "read:user" })); } catch (err) { answer = { failed: err instanceof Error ? err.message : String(err) }; }
    const { verdict, says } = deviceCodeVerdict(answer);
    if (verdict !== "retry") { log(says); return verdict === "pass" ? 0 : 1; }
    if (n >= TRIES) { log(`GitHub's trouble lasted ${TRIES} tries: ${says}`); return 1; }
    log(`${says}; trying again in ${PAUSES[n - 1] / 1000} s (try ${n + 1} of ${TRIES})`);
    await wait(PAUSES[n - 1]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const id = fs.readFileSync(path.join(root, "app/main/agent/github-app.ts"), "utf8").match(/export const GITHUB_CLIENT_ID = "([^"]*)"/)?.[1] ?? "";
  process.exit(await checkClientId({
    id,
    ask: async body => {
      const res = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      return { status: res.status, body: await res.text() };
    },
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    log: line => console.log(line),
  }));
}
