/**
 * Bundle the classifier and full flow from the selected worktree, with no shell or network runner.
 * usage: built by compare.mjs; its three comparison imports are aliases, never installed packages.
 */
import fs from "node:fs";
import { runCase, contextOf, factsOf } from "@comparison/corpus";
import { runCommandTool, setCommandJudge } from "@comparison/flow";
import { resolveTargetPath } from "@comparison/paths";
const quiet = { debug() {
}, info() {
}, warn() {
}, error() {
}, child() {
  return quiet;
} };
async function flowProbe(c, shell, name) {
  setCommandJudge(null);
  const source = contextOf(name, c.downloaded);
  const facts = factsOf(name, { privileged: c.privileged });
  const actualShell = shell === "cmd" ? "powershell" : shell;
  if (!facts.shells.includes(actualShell)) facts.shells.push(actualShell);
  const binding = { id: "local", kind: "local", label: "This computer", screenOs: facts.os, shellOs: facts.os, desktop: "screen" };
  const missing = new Set((c.missing ?? []).map((p) => resolveTargetPath(p, source)));
  let asked = 0, starts = 0, cwdChanges = 0;
  const decisions = [];
  const abort = new AbortController();
  const runner = {
    target: "local",
    facts: async () => facts,
    inspect: async (paths) => paths.map((p) => ({ exists: !missing.has(p), real: p })),
    gitFacts: async () => c.git ?? null,
    readScript: async (p) => typeof c.script === "string" ? c.script : c.script?.[p] ?? null,
    start(spec) {
      starts++;
      return {
        runId: spec.runId,
        interactive: true,
        onOutput: () => () => void 0,
        input() {
        },
        typedLines: () => [],
        forgetTyped() {
        },
        stop() {
        },
        done: Promise.resolve({ code: 0, signal: null, ended: "exit", ms: 1 })
      };
    },
    stopAll: async () => void 0,
    get running() {
      return 0;
    }
  };
  const state = { cwd: source.cwd, downloaded: new Set(c.downloaded ?? []), running: false };
  const ctx = {
    task: { id: "comparison", title: "Check this command", commandWords: () => c.words ?? "", ownWords: () => c.words ?? "", agreed: () => [], tainted: () => false, taint() {
    }, readFrom: () => [] },
    service: {
      binding,
      capability: () => ({ state: "on", askEvery: null }),
      shells: () => facts.shells,
      runner,
      window: { showCard() {
      }, hideCard() {
      }, cardReady: () => false, announce: async () => true, cancelAnnounce() {
      }, attach() {
      } },
      consented() {
      },
      userAskEvery: () => c.askEvery ?? false,
      mode: () => c.mode ?? "on"
    },
    confirmer: { ask: async () => {
      asked++;
      return "deny";
    } },
    presenter: { announce() {
    }, endAnnouncement() {
    } },
    audit: (e) => {
      if (e.phase === "decided") decisions.push(e);
      if (e.phase === "cd") cwdChanges++;
    },
    log: quiet,
    signal: abort.signal,
    isOver: () => abort.signal.aborted,
    state,
    size: () => ({ cols: 100, rows: 30 }),
    emberPids: () => [4242, 4243],
    onDeclined() {
    }
  };
  const commands = c.sequence ?? [shell === "cmd" ? `cmd /c ${c.cmd}` : c.cmd];
  const outcomes = [];
  for (const command of commands) {
    const beforeAsked = asked, beforeStarts = starts, beforeCwd = cwdChanges, beforeDecisions = decisions.length;
    const result = await runCommandTool({ target: "this computer", command, shell: actualShell, why: "to check the command" }, ctx);
    const outcome = asked > beforeAsked ? "ASKED" : starts > beforeStarts || cwdChanges > beforeCwd ? "RAN" : result.resultType === "denied" ? "REFUSED" : "ERROR";
    outcomes.push({ command, outcome, rules: [...new Set(decisions.slice(beforeDecisions).flatMap(d => d.rules ?? []))], type: result.resultType, text: result.textResultForLlm, downloads: [...state.downloaded] });
  }
  return { outcome: outcomes.at(-1)?.outcome, outcomes, decisions: decisions.map((d) => ({ verdict: d.verdict, rules: d.rules })) };
}
async function main() {
  const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = [];
  for (const c of cases) {
    const shell = c.shell ?? "bash", context = c.context ?? "linux";
    let classifier, flow;
    try {
      const r = runCase({ ...c, verdict: "run" }, { shell, context });
      classifier = { verdict: r.decision.verdict, rules: r.decision.rules, classes: r.decision.classes, downloads: r.cls.downloads, refuse: r.cls.refuse };
    } catch (err) {
      classifier = { verdict: "ERROR", message: String(err) };
    }
    try {
      flow = await flowProbe(c, shell, context);
    } catch (err) {
      flow = { outcome: "ERROR", message: String(err) };
    }
    out.push({ classifier, flow });
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(`Probed ${out.length} cases`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
