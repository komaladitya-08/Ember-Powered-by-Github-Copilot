/**
 * Ember's askpass helper on Linux and macOS PCs (§5.1.6; owned by package SA): ssh runs it (through the two-line
 * wrapper Ember writes) for a password, passphrase, code or a new host key, with ssh's prompt as its one argument after
 * the script path, so Node never reads the prompt as an option. It asks Ember over the per-run socket named in
 * EMBER_ASKPASS_SOCK, proving itself with EMBER_ASKPASS_NONCE, prints the answer for ssh and exits 0; anything else
 * (no Ember, a cancel, a malformed answer) exits 1, which ssh takes as "cancelled". It logs nothing, writes nothing to
 * disk, and keeps nothing. Built to dist/app/askpass.cjs and run as plain Node (ELECTRON_RUN_AS_NODE=1).
 */

import net from "node:net";

/** The longest prompt sent (ssh's text, cut), and the longest answer line read. */
const PROMPT_MAX = 2048;
const ANSWER_MAX = 64 * 1024;

/** What the helper needs from its process (injected in tests). */
export interface AskpassIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  write(text: string): void;
  connect(path: string): net.Socket;
}

/** Runs the helper: resolves the exit code (0: answered; 1: cancelled or failed). */
export function runAskpass(io: AskpassIo): Promise<number> {
  const sock = io.env.EMBER_ASKPASS_SOCK ?? "";
  const nonce = io.env.EMBER_ASKPASS_NONCE ?? "";
  if (!/^[0-9a-f]{32}$/.test(nonce) || !sock.startsWith("/") || sock.length > 200) return Promise.resolve(1);
  const prompt = io.argv.slice(2).join(" ").slice(0, PROMPT_MAX);
  const hint = io.env.SSH_ASKPASS_PROMPT;
  const mode = hint === "confirm" ? "confirm" : hint === "none" ? "notify" : "secret";
  return new Promise(resolve => {
    let done = false;
    let buf = "";
    const conn = io.connect(sock);
    const finish = (code: number) => {
      if (done) return;
      done = true;
      conn.destroy();
      resolve(code);
    };
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ v: 1, nonce, mode, prompt })}\n`));
    conn.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > ANSWER_MAX) return finish(1);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let answer: unknown;
      try {
        answer = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(1);
      }
      const a = answer as { ok?: unknown; value64?: unknown };
      if (a.ok !== true || typeof a.value64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.value64)) return finish(1);
      io.write(`${Buffer.from(a.value64, "base64").toString("utf8")}\n`);
      finish(0);
    });
    conn.on("error", () => finish(1));
    conn.on("close", () => finish(1));
  });
}

/** Runs the helper as a process. */
export function main(): void {
  void runAskpass({
    argv: process.argv,
    env: process.env,
    write: text => process.stdout.write(text),
    connect: path => net.connect(path),
  }).then(code => {
    // Let stdout flush the answer before the process ends.
    process.stdout.write("", () => process.exit(code));
  });
}

// Only when run as dist/app/askpass.cjs (esbuild's CommonJS entry), never when a test imports the module.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) main();
