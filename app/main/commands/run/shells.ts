/**
 * The fixed inner launchers every command runs through (§3.3; normative text). The command text never appears on any
 * process's argv: it travels in EMBER_CMD (WSL: EMBER_CMD_B64) and these fixed texts read and unset it before running
 * it. Pure text, so the remote agent bundles the same module and WSL can pass it through wsl.exe unchanged. Landed by
 * Step 0a; owned by RUN afterwards (keep the texts byte-identical unless a CI run proves one wrong).
 */

/** Flags that keep each POSIX shell from reading profile or rc files. */
export const NO_RC: Readonly<Record<"bash" | "zsh" | "sh", readonly string[]>> = { bash: ["--noprofile", "--norc"], zsh: ["-f"], sh: [] };

/**
 * What every POSIX run does first: globbing on, no pager waits for keys (git log in a PTY would otherwise start less),
 * a UTF-8 locale when none is set, then the start marker (an OSC sequence output shaping strips; a run whose output
 * ends without it failed to start: its stderr is the reason, §3.13). One line, no single quote, no tab, no run of
 * spaces: it is embedded in single-quoted -c text and split and re-joined by WSL_EVAL.
 */
export const POSIX_PRELUDE = 'set +f; export PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat MANPAGER=cat; [ -n "$LANG" ] || export LANG=C.UTF-8; printf "\\033]777;ember-start\\007"';

/**
 * How a WSL run ends (from "b64", which only WSL uses). wsl.exe's relay on WSL1 can lose the last 64 KiB of a Linux
 * process's output when it exits (remote.yml's WSL1 job, run 43532157051: 4,128,768 of 4,194,304 bytes back, exit code
 * 0), so the shell wsl.exe started runs the command's text in a fresh shell of the same program and, once that has
 * ended, prints the end marker last: `ESC ] 777;ember-end;<nonce>;<code> BEL`. A run whose output holds no marker with
 * its own nonce lost its end on the way, and is reported so (runner.ts), never as complete.
 * - A fresh shell, not a subshell (review wslio-x-1, -x-2): `$$`, `exit`, `exec`, traps, signals and Ctrl+C mean in it
 *   what they meant in the one shell before. In a subshell `$$` named this outer shell, so `kill $$` ended the run while
 *   the rest of the text went on past it and past Stop, and dash's and busybox's subshells died at a Ctrl+C a program
 *   in them handled.
 * - The text reaches it as EMBER_C, in its environment only (never on an argv), and it unsets it before `eval`, as
 *   this shell did EMBER_CMD_B64; the nonce (EMBER_END, random per run) is read and unset here and never exported, so
 *   neither the command's environment nor anything it prints from elsewhere holds it.
 * - `trap : INT TERM`: a Ctrl+C or the Stop ladder's TERM ends the command, and this shell waits for it and says so,
 *   and a plain `kill $PPID` from the command can't end this shell. A `kill -9 $PPID` can (SIGKILL can't be trapped):
 *   then no marker comes, and the runner ends whatever still carries the run's id before it reports the run
 *   (runner.ts, review wslio-y-1).
 * - This shell's own stderr goes to /dev/null once the command starts, and the fresh shell takes the real one back
 *   from fd 3 (and closes 3) before the command's text: a shell reports a child killed by a signal ("Killed",
 *   "Terminated"), which the one shell before never did, and dash and busybox report it under the redirections of the
 *   command they wait for, so fd 2 can't be given on its command line; `3>&3` is, because mksh opens `exec`'s fds
 *   above 2 close-on-exec.
 * One line, no single quote, no run of spaces: WSL_EVAL's split and posixInner's quotes take it unchanged. `shellPath`
 * must be made only of [A-Za-z0-9/._-] (launchArgv checks it).
 */
export function wslRunEnd(shell: "bash" | "zsh" | "sh", shellPath: string): string {
  if (!/^\/[A-Za-z0-9/._-]*$/.test(shellPath)) throw new Error("a shell path WSL's launcher can't hold");
  const fresh = [shellPath, ...NO_RC[shell]].join(" ");
  return `n=$EMBER_END; unset EMBER_END; trap : INT TERM; exec 3>&2 2>/dev/null; EMBER_C=$c ${fresh} -c "exec 2>&3 3>&-; c=\\$EMBER_C; unset EMBER_C; eval \\"\\$c\\"" 3>&3; e=$?; printf "\\033]777;ember-end;%s;%s\\007" "$n" "$e"; exit $e`;
}

/** What posixBody reads the command from: EMBER_CMD (Linux, macOS, a remote), or EMBER_CMD_B64 with WSL's end. */
export type BodyFrom = { pty: boolean; from: "env" } | { pty: boolean; from: "b64"; shell: "bash" | "zsh" | "sh"; path: string };

/**
 * The body every POSIX run executes: the prelude, the command text read and unset first (from EMBER_CMD, or decoded
 * from EMBER_CMD_B64 for WSL), the PTY's size set inside script(1) (whose PTY starts without one), then `eval "$c"`,
 * which runs the text exactly as `bash -c "$c"` would (same parser, here-docs and `exit` included); WSL's runs it in
 * wslRunEnd's fresh shell and ends with its marker.
 */
export function posixBody(o: BodyFrom): string {
  return [
    POSIX_PRELUDE,
    o.from === "env" ? "c=$EMBER_CMD; unset EMBER_CMD" : 'c=$(printf %s "$EMBER_CMD_B64" | base64 -d) || exit 126; unset EMBER_CMD_B64',
    // No hidden code at start: bash (non-interactive) and sh read these as start-up files.
    "unset BASH_ENV ENV",
    // script(1)'s PTY starts without a size: the tab's, fixed for the run (§3.10).
    ...(o.pty ? ['stty cols "$EMBER_COLS" rows "$EMBER_ROWS" 2>/dev/null; unset EMBER_COLS EMBER_ROWS'] : []),
    o.from === "b64" ? wslRunEnd(o.shell, o.path) : 'eval "$c"',
  ].join("; ");
}

/**
 * The text script(1) runs with /bin/sh -c: exec the chosen shell (its absolute path from RunnerFacts.shellPaths, made
 * only of [A-Za-z0-9/._-], else the run fails to start) without rc files on posixBody({ pty: true, from }).
 */
export function posixInner(shell: "bash" | "zsh" | "sh", shellPath: string, from: "env" | "b64"): string {
  const body = from === "b64" ? posixBody({ pty: true, from, shell, path: shellPath }) : posixBody({ pty: true, from });
  return `exec ${shellPath} ${NO_RC[shell].join(" ")} -c '${body}'`.replace(/ {2,}/g, " ");
}

/**
 * What WSL runs as its -c text: no quote or backslash in it, so Windows' argument quoting and wsl.exe's own parsing
 * can't change it (critique wsl-18). EMBER_INNER (posixInner(…, "b64") or posixBody({ pty: false, from: "b64" }))
 * arrives through WSLENV; `set -f` keeps the split words from globbing before eval re-parses them.
 */
export const WSL_EVAL = "set -f; eval $EMBER_INNER";

/**
 * What a WSL run's EMBER_INNER starts with: the shell goes to the run's folder (EMBER_CWD) itself, and fails before the
 * start marker when it isn't there (so the run failed to start, its stderr the reason). wsl.exe's own --cd can't be
 * trusted with it: the inbox wsl.exe can't take "~", and the Store one runs the command in the home folder when the
 * folder is missing (CI's WSL runners); so wsl.exe always starts the shell in /. Single spaces only (WSL_EVAL's split).
 */
export const WSL_CD = 'cd -- "$EMBER_CWD" || exit 97';

/**
 * How a macOS run starts BSD script(1), run by bash or zsh (-c): script's stdin must be a real pipe. Node gives a child
 * a socket for "pipe", and BSD script's tcgetattr on a socket fails with EOPNOTSUPP (not ENOTTY, the one error it
 * tolerates), so every run failed to start (remote.yml's first macOS run). The process substitution makes that pipe and
 * keeps script in the foreground (exec), so Ctrl+C typed into the PTY still reaches the command; its cat relays the
 * user's typing and ends at stdin's end, and carries neither the command nor the run's marker (never named as left
 * running). EMBER_SCRIPT is RunnerFacts.script.path; EMBER_INNER is posixInner(…, "env").
 */
export const BSD_SCRIPT_LAUNCH =
  's=$EMBER_SCRIPT i=$EMBER_INNER; unset EMBER_SCRIPT EMBER_INNER; exec "$s" -q /dev/null /bin/sh -c "$i" < <(unset EMBER_RUN_ID EMBER_CMD; exec /bin/cat)';

/**
 * PowerShell's fixed launcher (§3.3, critique integration-10). A cmdlet's non-terminating error ends the run with 1: it
 * lands in $Error, while `$?` after `& $s` stays true (windows-2022, Windows PowerShell 5.1). $Error.Count, not a method
 * call, so Constrained Language Mode allows it.
 */
export const PS_INNER =
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = New-Object Text.UTF8Encoding $false }; " +
  "$s = [ScriptBlock]::Create($env:EMBER_CMD); Remove-Item Env:\\EMBER_CMD -ErrorAction SilentlyContinue; " +
  "$global:LASTEXITCODE = 0; $n = $Error.Count; & $s; $ok = $?; $c = $LASTEXITCODE; if ($c) { exit $c } elseif (-not $ok -or $Error.Count -ne $n) { exit 1 }";
