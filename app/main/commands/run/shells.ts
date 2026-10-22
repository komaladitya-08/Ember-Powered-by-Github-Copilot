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
 * The body every POSIX run executes: the prelude, the command text read and unset first (from EMBER_CMD, or decoded
 * from EMBER_CMD_B64 for WSL), the PTY's size set inside script(1) (whose PTY starts without one), then `eval "$c"`,
 * which runs the text exactly as `bash -c "$c"` would (same parser, here-docs and `exit` included).
 */
export function posixBody(o: { pty: boolean; from: "env" | "b64" }): string {
  return [
    POSIX_PRELUDE,
    o.from === "env" ? "c=$EMBER_CMD; unset EMBER_CMD" : 'c=$(printf %s "$EMBER_CMD_B64" | base64 -d) || exit 126; unset EMBER_CMD_B64',
    // No hidden code at start: bash (non-interactive) and sh read these as start-up files.
    "unset BASH_ENV ENV",
    // script(1)'s PTY starts without a size: the tab's, fixed for the run (§3.10).
    ...(o.pty ? ['stty cols "$EMBER_COLS" rows "$EMBER_ROWS" 2>/dev/null; unset EMBER_COLS EMBER_ROWS'] : []),
    'eval "$c"',
  ].join("; ");
}

/**
 * The text script(1) runs with /bin/sh -c: exec the chosen shell (its absolute path from RunnerFacts.shellPaths, made
 * only of [A-Za-z0-9/._-], else the run fails to start) without rc files on posixBody({ pty: true, from }).
 */
export function posixInner(shell: "bash" | "zsh" | "sh", shellPath: string, from: "env" | "b64"): string {
  return `exec ${shellPath} ${NO_RC[shell].join(" ")} -c '${posixBody({ pty: true, from })}'`.replace(/ {2,}/g, " ");
}

/**
 * What WSL runs as its -c text: no quote or backslash in it, so Windows' argument quoting and wsl.exe's own parsing
 * can't change it (critique wsl-18). EMBER_INNER (posixInner(…, "b64") or posixBody({ pty: false, from: "b64" }))
 * arrives through WSLENV; `set -f` keeps the split words from globbing before eval re-parses them.
 */
export const WSL_EVAL = "set -f; eval $EMBER_INNER";

/** PowerShell's fixed launcher (§3.3, critique integration-10). */
export const PS_INNER =
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = New-Object Text.UTF8Encoding $false }; " +
  "$s = [ScriptBlock]::Create($env:EMBER_CMD); Remove-Item Env:\\EMBER_CMD -ErrorAction SilentlyContinue; " +
  "$global:LASTEXITCODE = 0; & $s; $ok = $?; $c = $LASTEXITCODE; if ($c) { exit $c } elseif (-not $ok) { exit 1 }";
