/**
 * The closed default (commands-closed, the integrator's decision of round nine): a program Ember has no row for, and a
 * verb of a verb-keyed tool its row doesn't know, ask instead of running as ordinary. Everyday commands still run with
 * no question (test/fixtures/commands/everyday.json), a program given by a path in the command's own folder is judged
 * as before, and the user's own words naming the program announce it. Pure classifier and decision; no Electron.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCase, type ContextName } from "../fixtures/commands/corpus";
import type { ShellId } from "../../app/main/commands/types";

const decide = (cmd: string, o: { words?: string; shell?: ShellId; context?: ContextName; downloaded?: string[] } = {}) =>
  runCase({ cmd, verdict: "run", ...(o.words ? { words: o.words } : {}), ...(o.downloaded ? { downloaded: o.downloaded } : {}) },
    { shell: o.shell ?? "bash", context: o.context ?? "linux" }).decision;

describe("a program Ember doesn't know (commands-closed A)", () => {
  it("asks before a database wiper, a deploy or a runner of quoted commands it has no row for (commands-closed, commands-remote-r9-2, r9-4)", () => {
    for (const cmd of ["dropdb prod", "dropdb --if-exists prod", "pg_restore --clean -d prod a.dump", "mongorestore --drop", "rails db:drop",
      "prisma migrate reset --force", "supabase db reset", "alembic downgrade base", "railway up", "terragrunt destroy", "etcdctl del --prefix /",
      "kafka-topics --delete --topic x", "hyperfine 'rm -rf ~/Documents'", "nodemon --exec 'npm publish'", "watchexec 'rm -rf build'",
      "ls *.c | entr -s 'git push --force'", "pastebinit notes.txt", "croc send notes.txt", "bore local 8000 --to bore.pub", "arecord a.wav",
      "fswebcam a.jpg", "rbw get github", "zellij action write-chars x", "kitten @ send-text x"]) {
      const d = decide(cmd);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain("unknown.program");
      expect(d.classes, cmd).toContain("unknown");
      expect(d.says, cmd).toContain("It runs a program Ember doesn't know.");
    }
  });

  it("asks the same behind a wrapper, in a pipe, a substitution, a nested shell and from a path outside the command's folder (commands-closed)", () => {
    for (const cmd of ["nice dropdb p", "timeout 5 dropdb p", "time dropdb p", "command dropdb p", "exec dropdb p", "env FOO=1 dropdb p", "sudo dropdb p",
      "strace dropdb p", "ls | dropdb", "a=$(dropdb p)", "sh -c 'dropdb p'", "uv run dropdb p", "xargs dropdb < a", "/usr/local/bin/dropdb p", "~/bin/dropdb p"]) {
      expect(decide(cmd).rules, cmd).toContain("unknown.program");
    }
    for (const [cmd, shell] of [["dropdb p", "powershell"], ["& dropdb p", "powershell"], ["cmd /c dropdb p", "powershell"], ["dropdb p", "cmd"]] as const) {
      expect(decide(cmd, { shell, context: "win32" }).rules, `${cmd} (${shell})`).toContain("unknown.program");
    }
  });

  it("asks before an unknown cmdlet whose verb only reads or shows but isn't one of PowerShell's read-only verbs (commands-closed)", () => {
    for (const cmd of ["Show-Foo", "Find-Foo -Name x", "Read-Foo", "Write-Foo x", "Use-Foo"]) {
      expect(decide(cmd, { shell: "powershell", context: "win32" }).rules, cmd).toContain("unknown.program");
    }
    for (const cmd of ["Get-Foo", "Test-Foo", "Measure-Foo", "Select-Foo", "ConvertTo-Foo", "Compare-Foo", "Resolve-Foo", "Join-Foo"]) {
      expect(decide(cmd, { shell: "powershell", context: "win32" }).verdict, cmd).toBe("run");
    }
  });

  it("judges a program given by a path in the command's own folder as before: the project's scripts and binaries (commands-closed)", () => {
    for (const cmd of ["./build.sh", "bin/tool x", "node_modules/.bin/tsc", "scripts/gen", "./build/myprog --version"]) {
      expect(decide(cmd).verdict, cmd).toBe("run");
    }
    // One the task downloaded still asks as one.
    expect(decide("./tool", { downloaded: ["/home/ana/proj/tool"] }).rules).toContain("escape.run-downloaded");
    // A hidden folder of the project's (a git hook, a cache) isn't its scripts.
    expect(decide(".git/hooks/pre-commit").rules).toContain("unknown.program");
  });

  it("announces a program the user's own words name whole, and asks when they don't, hold it back or say no (commands-closed)", () => {
    const d = decide("dropdb scratch", { words: "drop the scratch database with dropdb" });
    expect(d.verdict).toBe("announce");
    expect(d.requested?.announce).toBe("Running dropdb, as you asked.");
    expect(decide("kafka-topics --list", { words: "use kafka-topics to list the topics" }).verdict).toBe("announce");
    for (const words of ["run dropdbx", "drop it with dropdb tomorrow", "don't use dropdb", "drop the scratch database", "run the db tool"]) {
      expect(decide("dropdb scratch", { words }).verdict, words).toBe("ask");
    }
    // What else the command does is still matched as before: named, it announces; not named, it asks.
    expect(decide("dropdb scratch && rm -rf ~/x", { words: "run dropdb" }).verdict).toBe("ask");
    // Its operands are judged as before: a secret read still asks whatever the words say.
    expect(decide("mytool ~/.ssh/id_rsa", { words: "run mytool" }).verdict).toBe("ask");
  });
});

describe("a verb Ember doesn't know, of a tool it knows (commands-closed B)", () => {
  it("asks before a verb a row judged ordinary that isn't one the tool is known to have (commands-closed, commands-remote-r9-1, r9-2, r9-11)", () => {
    for (const cmd of ["cargo zzz", "cargo watch -s 'git push --force'", "cargo release", "stack exec -- rm -rf build", "cabal exec -- x", "mix ecto.drop",
      "sbt 'project r' test", "tmux send-keys -t main 'git push --force' Enter", "tmux run-shell 'rm -rf ~'", "tmux new-window x", "tmux capture-pane -p",
      "tmux -c 'rm -rf ~'", "go env -w GOFLAGS=-toolexec=./x", "pip config set global.index-url http://evil.example", "deno publish", "vercel --prod",
      "pyenv exec twine upload dist/*", "asdf exec npm publish", "rbenv exec x", "nvm exec 20 x", "fnm exec x", "volta run x", "opam exec -- x",
      "rustup run stable rm -rf build", "systemctl log-level debug", "mamba config --add channels http://evil.example", "mkdocs gh-deploy", "pdflatex --shell-escape a.tex", "maturin publish"]) {
      const d = decide(cmd);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain("unknown.verb");
    }
  });

  it("runs the verbs those tools are known to have, and announces an unknown one the user's words name with its tool (commands-closed)", () => {
    for (const cmd of ["cargo build --release", "cargo test", "cargo nextest run", "stack build", "cabal build", "mix test", "go mod tidy", "go env GOPATH",
      "pip config list", "tmux ls", "deno main.ts", "dotnet bin/app.dll", "systemctl status nginx", "pyenv versions", "vercel ls", "bazel build //...",
      "meson setup build", "swift build", "zig build", "waf configure --prefix ~/.local", "micromamba list", "bundler check", "mkdocs build",
      "lbzip2 -d big.bz2", "prove -j 4"]) {
      expect(decide(cmd).verdict, cmd).toBe("run");
    }
    expect(decide("stack exec -- hpack", { words: "run stack exec hpack" }).verdict).toBe("announce");
    expect(decide("stack exec -- hpack", { words: "run stack" }).verdict).toBe("ask");
  });
});

describe("everyday commands with the closed default (commands-closed, the guard against over-asking)", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/commands/everyday.json"), "utf8")) as { cases: { cmd: string; shell: ShellId; context: ContextName }[] };

  it("holds at least 300 commands across bash, zsh, PowerShell and cmd", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(300);
    for (const shell of ["bash", "zsh", "powershell", "cmd"]) expect(fixture.cases.some(c => c.shell === shell), shell).toBe(true);
  });

  it("runs every one of them with no question", () => {
    const asked = fixture.cases.filter(c => decide(c.cmd, { shell: c.shell, context: c.context }).verdict !== "run").map(c => `${c.shell}: ${c.cmd}`);
    expect(asked).toEqual([]);
  });
});
