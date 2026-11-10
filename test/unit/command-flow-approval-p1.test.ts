/**
 * The P1 approval-bypass families of PR #207 (commands-q6-1 empty-variable redis-cli words, commands-q6-2 `env -C`
 * script folder), pinned through the real run_command flow: the real classifier and judge, a stub runner that never
 * executes anything, and a stub readScript returning a destructive-looking script. Each command must ask, and nothing
 * may start unless (and only after) the user's one click approves. Local copy of command-flow.test.ts's harness,
 * which isn't exported.
 */
import { afterEach, describe, expect, it } from "vitest";
import { runCommandTool, setCommandJudge, type CommandFlowContext } from "../../app/main/commands/flow";
import type { CommandCapability, RunExit, RunnerFacts, RunningCommand, RunSpec, CommandService } from "../../app/main/commands/types";
import type { TargetBinding } from "../../app/main/targets/types";
import type { Logger } from "../../app/main/logger";
import { runCase } from "../fixtures/commands/corpus";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const LOCAL: TargetBinding = { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" };
const FACTS: RunnerFacts = {
  os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/bin/bash", sh: "/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
  home: "/home/ana", user: "ana", privileged: false, pty: true, ember: { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ }, extraPath: [],
};

function h(answers: (string | null)[], abort = new AbortController()) {
  const asked: Record<string, unknown>[] = [];
  const starts: RunSpec[] = [];
  const startsAtAsk: number[] = [];
  const reads: string[] = [];
  let isTainted = false;
  const runner = {
    target: "local", facts: async () => FACTS,
    inspect: async (paths: string[]) => paths.map(p => ({ exists: true, real: p })),
    // A destructive-looking script, whatever path is asked for.
    readScript: async (p: string) => { reads.push(p); return "rm -rf ~/work\n"; },
    gitFacts: async () => null,
    start: (spec: RunSpec): RunningCommand => {
      starts.push(spec);
      return { runId: spec.runId, interactive: true, onOutput: () => () => {}, input() {}, typedLines: () => [], forgetTyped() {},
        stop() {}, done: Promise.resolve<RunExit>({ code: 0, signal: null, ended: "exit", ms: 1 }) } as RunningCommand;
    },
    stopAll: async () => undefined, get running() { return starts.length; },
  };
  const service = {
    binding: LOCAL, capability: (): CommandCapability => ({ state: "on", askEvery: null }), shells: () => FACTS.shells, runner,
    window: { showCard() {}, hideCard() {}, cardReady: () => false, announce: async () => true, cancelAnnounce() {}, attach() {} },
    consented() {}, userAskEvery: () => false, mode: () => "on",
  } as unknown as CommandService;
  const ctx = {
    task: { id: "t1", title: "t", commandWords: () => "", agreed: () => [], tainted: () => isTainted, taint: () => { isTainted = true; }, readFrom: () => [] },
    service,
    confirmer: { ask: async (q: Record<string, unknown>) => { startsAtAsk.push(starts.length); asked.push(q); if (answers.length === 0) return "once"; return answers.shift()!; } } as never,
    presenter: { announce() {}, endAnnouncement() {} } as never,
    audit: () => {}, log: quiet, signal: abort.signal, isOver: () => abort.signal.aborted,
    state: { cwd: null, downloaded: new Set(), running: false },
    size: () => ({ cols: 100, rows: 30 }), emberPids: () => [4242], onDeclined() {},
  } as unknown as CommandFlowContext;
  return { ctx, asked, starts, startsAtAsk, reads, abort };
}
const call = (x: ReturnType<typeof h>, command: string) => runCommandTool({ target: "this computer", command, why: "demo" }, x.ctx);

const REDIS = [
  "O=''; redis-cli $O FLUSHALL", "O=''; redis-cli ${O} FLUSHALL", 'O=""; redis-cli "$O" FLUSHALL', "redis-cli $O FLUSHALL",
  "A=''; B=''; redis-cli $A $B FLUSHALL", "O=''; redis-cli -h x $O flushall", "O=''; redis-cli $O FLUSHDB",
];
const ENV_C = [
  "env -C . sh < deploy.sh", "env --chdir=. sh < deploy.sh", "env -C /tmp bash deploy.sh", "env -i -C . sh < deploy.sh",
  "env -C . -- sh -s < deploy.sh", "env -C. sh <deploy.sh", "env -C . sh deploy.sh",
];
const CMDS = [...REDIS, ...ENV_C];

afterEach(() => setCommandJudge(null));

describe("P1 approval-bypass families: the classifier asks (commands-q6-1, commands-q6-2)", () => {
  for (const cmd of CMDS) {
    it(`asks: ${cmd}`, () => {
      const { decision } = runCase({ cmd, verdict: "run", context: "linux" }, { shell: "bash", context: "linux" });
      expect(decision.verdict).toBe("ask");
    });
  }
});

describe("P1 approval flow (real judge, stubbed runner)", () => {
  for (const cmd of CMDS) {
    it(`deny: asks once and never starts: ${cmd}`, async () => {
      setCommandJudge(null);
      const x = h(["deny"]);
      const r = await call(x, cmd);
      expect(x.asked).toHaveLength(1);
      expect(x.starts).toEqual([]);
      expect(r.resultType).toBe("denied");
    });
    it(`once: nothing starts before the answer, one start after: ${cmd}`, async () => {
      setCommandJudge(null);
      const x = h(["once"]);
      await call(x, cmd);
      expect(x.asked).toHaveLength(1);
      expect(x.startsAtAsk).toEqual([0]);
      expect(x.starts).toHaveLength(1);
    });
    it(`expired (no answer): stays blocked: ${cmd}`, async () => {
      setCommandJudge(null);
      const x = h([null]);
      const r = await call(x, cmd);
      expect(x.asked).toHaveLength(1);
      expect(x.starts).toEqual([]);
      expect(r.resultType).not.toBe("success");
    });
    it(`aborted while asking: stays blocked: ${cmd}`, async () => {
      setCommandJudge(null);
      const ac = new AbortController();
      const x = h([]);
      (x.ctx.confirmer as { ask: unknown }).ask = async () => { x.asked.push({}); ac.abort(); return null; };
      (x.ctx as { signal: AbortSignal }).signal = ac.signal;
      (x.ctx as { isOver: () => boolean }).isOver = () => ac.signal.aborted;
      await call(x, cmd);
      expect(x.starts).toEqual([]);
    });
  }
});
