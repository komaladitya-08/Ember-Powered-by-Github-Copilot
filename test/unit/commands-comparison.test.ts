/** The command comparison fails closed on unknown results and permits only the audit's narrow job-count exception. */
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";

const api = async () => import(pathToFileURL(path.resolve("scripts/commands/compare-lib.mjs")).href) as Promise<{
  isAllowedJobCount: (cmd: string) => boolean;
  compareResults: (cases: { cmd: string; sequence?: string[]; shell?: string }[], before: unknown[], after: unknown[]) => { errors: unknown[]; changes: { allowed: boolean; direction: string }[]; summary: { forbiddenLooser: number } };
}>;
const result = (verdict: string, outcomes: string[] = ["ASKED"], rules = ["unclear.unresolved-arg"], commands = outcomes.map(() => "make -j$(nproc)")) => ({ classifier: { verdict, rules }, flow: { outcome: outcomes.at(-1), outcomes: outcomes.map((outcome, i) => ({ outcome, rules, command: commands[i] })) } });

describe("the audit command comparison", () => {
  it("rejects unknown results instead of ranking one above a refusal (commands-comparison-r7-1)", async () => {
    const { compareResults } = await api();
    for (const unknown of ["ERROR", "unrecognised", "", "REFUSE"]) {
      expect(compareResults([{ cmd: "cd ." }], [result(unknown)], [result("refuse")]).errors).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "classifier", why: "unknown decision" })]));
      expect(compareResults([{ cmd: "cd ." }], [result("refuse")], [result(unknown)]).errors.length).toBeGreaterThan(0);
    }
    expect(compareResults([{ cmd: "ls" }], [result("ask", ["ERROR"])], [result("ask")]).errors.length).toBeGreaterThan(0);
  });

  it("allows only a literal count, a named processor-count substitution or arithmetic of numbers (commands-comparison-r7-1)", async () => {
    const { isAllowedJobCount } = await api();
    for (const cmd of ["make -j4", 'make -j "$(nproc)"', "make -j$(getconf _NPROCESSORS_ONLN)", "ctest -j$(sysctl -n hw.ncpu)", "pytest -n$((2+2))", "sort --parallel=4", "./gradlew --max-workers=4"]) expect(isAllowedJobCount(cmd), cmd).toBe(true);
    for (const cmd of ["make -j$N", "make -j$(cat jobs.txt)", "make -j$(nproc) deploy", "make -j$(nproc); rm -rf build", "make -j$((N+2))", "make -j'$(nproc)'", "xargs -P$(nproc) sh", "make -j$(nproc --all)", "make -j$((()))", "make -j$((2++2))"]) expect(isAllowedJobCount(cmd), cmd).toBe(false);
  });

  it("never exempts a former refusal, and catches a sequence's earlier loosening even if its last step agrees (commands-comparison-r7-1)", async () => {
    const { compareResults } = await api();
    expect(compareResults([{ cmd: "make -j$(nproc)" }], [result("refuse", ["REFUSED"])], [result("run", ["RAN"])]).summary.forbiddenLooser).toBe(2);
    expect(compareResults([{ cmd: "curl -O URL; bash run.sh", sequence: ["curl -O URL", "bash run.sh"] }], [result("ask", ["ASKED", "RAN"], [], ["curl -O URL", "bash run.sh"])], [result("ask", ["RAN", "RAN"], [], ["curl -O URL", "bash run.sh"])]).summary.forbiddenLooser).toBe(1);
    const jobs = compareResults([{ cmd: "make -j$(nproc)" }], [result("ask")], [result("run", ["RAN"])]);
    expect(jobs.errors).toEqual([]);
    expect(jobs.changes).toHaveLength(2);
    expect(jobs.changes.every(c => c.allowed)).toBe(true);
  });

  it("never exempts another security rule merely because the command contains a valid job count (commands-comparison-r7-1)", async () => {
    const { compareResults } = await api();
    for (const rules of [["escape.run-downloaded"], ["system.root"], ["unclear.unresolved-arg", "escape.run-downloaded"], []]) {
      const r = compareResults([{ cmd: "make -j$(nproc)" }], [result("ask", ["ASKED"], rules)], [result("run", ["RAN"], [])]);
      expect(r.summary.forbiddenLooser, rules.join(",")).toBe(2);
    }
  });

  it("recognises only count changes for the reviewed inert operands and job options (commands-comparison-r7-2)", async () => {
    const { isAllowedJobCount, compareResults } = await api();
    for (const count of ["4", "$(nproc)", "$(getconf _NPROCESSORS_ONLN)", "$(sysctl -n hw.ncpu)", "$((2+2))"]) {
      for (const cmd of [`sort --parallel=${count} notes.txt`, `xargs -P${count} echo`, `make --jobs=${count}`, `ninja -j${count}`, `mvn -T${count} package`, `mvn --threads=${count} package`, `rake --jobs=${count}`, `./gradlew --max-workers=${count} build`, `parallel -j${count} echo`]) {
        expect(isAllowedJobCount(cmd), cmd).toBe(true);
        // Main calls xargs/parallel's substituted option an unknown program; only these exact inert commands are exempt.
        const rules = [/^(xargs|parallel) /.test(cmd) ? "unclear.program" : "unclear.unresolved-arg"];
        const report = compareResults([{ cmd }], [result("ask", ["ASKED"], rules, [cmd])], [result("run", ["RAN"], [], [cmd])]);
        expect(report.errors).toEqual([]);
        expect(report.changes).toHaveLength(2);
        expect(report.changes.every(c => c.allowed), cmd).toBe(true);
        const security = compareResults([{ cmd }], [result("ask", ["ASKED"], ["unclear.unresolved-arg", "escape.run-downloaded"], [cmd])], [result("run", ["RAN"], [], [cmd])]);
        expect(security.summary.forbiddenLooser, cmd).toBe(2);
        if (!/^(xargs|parallel) /.test(cmd)) {
          const unknownProgram = compareResults([{ cmd }], [result("ask", ["ASKED"], ["unclear.program"], [cmd])], [result("run", ["RAN"], [], [cmd])]);
          expect(unknownProgram.summary.forbiddenLooser, cmd).toBe(2);
        }
      }
    }
    for (const cmd of ["sort --parallel=$(nproc) private.txt", "sort --parallel=$(nproc) notes.txt extra.txt", "sort --parallel=$(nproc) notes.txt; echo done", "xargs -P$(nproc) echo extra", "xargs -P$(nproc) sh", "xargs -P$(nproc) --process-slot-var=PATH echo", "xargs -n$(nproc) echo", "head -n$(nproc) notes.txt", "xargs -P\n$(nproc) echo", "make -j\n$(nproc)", 'sort --parallel="$(nproc)\n" notes.txt']) expect(isAllowedJobCount(cmd), cmd).toBe(false);
    for (const count of ["`nproc`", "$(nproc --all)", "$(sysctl -n hw.logicalcpu)", "$(cat jobs.txt)", "$N"]) {
      expect(isAllowedJobCount(`sort --parallel=${count} notes.txt`), count).toBe(false);
      expect(isAllowedJobCount(`xargs -P${count} echo`), count).toBe(false);
      expect(isAllowedJobCount(`mvn -T${count} package`), count).toBe(false);
      expect(isAllowedJobCount(`parallel -j${count} echo`), count).toBe(false);
    }
    for (const cmd of ["make --jobs=$(nproc) deploy", "ninja -j$(nproc) install", "mvn -T$(nproc) package deploy", "./gradlew --max-workers=$(nproc) build publish", "parallel -j$(nproc) sh", "parallel -j$(nproc) echo extra", "make -l$(nproc)", "make -I$(nproc)", "ninja -l$(nproc)"]) expect(isAllowedJobCount(cmd), cmd).toBe(false);
  });

  it("binds an exception to the actual stage and rejects a stage with a different command (compare-v7-1)", async () => {
    const { compareResults } = await api();
    const cmd = 'cat "${HOME:?}/notes.txt"';
    const before = result("ask");
    const after = result("run", ["RAN"]);
    Object.assign(before.flow.outcomes[0], { command: cmd });
    Object.assign(after.flow.outcomes[0], { command: cmd });
    expect(compareResults([{ cmd: "make -j$(nproc)", sequence: [cmd] }], [before], [after]).summary.forbiddenLooser).toBe(1);
    Object.assign(after.flow.outcomes[0], { command: "rm -rf build" });
    expect(compareResults([{ cmd, sequence: [cmd] }], [before], [after]).errors.length).toBeGreaterThan(0);
  });

  it("rejects matching truncated probe sequences instead of treating the unreported step as safe (compare-v7-2)", async () => {
    const { compareResults } = await api();
    const before = result("ask"), after = result("run", ["RAN"]);
    Object.assign(before.flow.outcomes[0], { command: "make -j$(nproc)" });
    Object.assign(after.flow.outcomes[0], { command: "make -j$(nproc)" });
    expect(compareResults([{ cmd: "make -j$(nproc)", sequence: ["make -j$(nproc)", "rm -rf build"] }], [before], [after]).errors.length).toBeGreaterThan(0);
  });

  it("fails incomplete output and mismatched sequence lengths instead of silently dropping decisions (commands-comparison-r7-1)", async () => {
    const { compareResults } = await api();
    expect(compareResults([{ cmd: "ls" }], [], [result("run")]).errors.length).toBeGreaterThan(0);
    expect(compareResults([{ cmd: "ls" }], [result("run")], [result("run", ["RAN", "RAN"])]).errors.length).toBeGreaterThan(0);
  });
});


describe("the comparison's immutable baseline", () => {
  const baselineApi = async () => import(pathToFileURL(path.resolve("scripts/commands/baseline.mjs")).href) as Promise<{
    AUDIT_BASELINE: string;
    assertBaseline: (root: string, spawn: (cmd: string, args: string[]) => { status: number; stdout: string }) => void;
  }>;
  const fakeGit = (head: string, configDirty = false, untracked: string[] = []) => (_cmd: string, args: string[]) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: head };
    if (args.includes("diff")) return { status: configDirty && !args.includes("--") ? 1 : 0, stdout: "" };
    if (args.includes("ls-files")) return { status: 0, stdout: untracked.join("\0") + "\0" };
    return { status: 2, stdout: "" };
  };

  it("rejects changed build configuration before probing even when app and fixture paths are clean (comparator-v7-3)", async () => {
    const { AUDIT_BASELINE, assertBaseline } = await baselineApi();
    expect(() => assertBaseline("baseline", fakeGit(AUDIT_BASELINE, true))).toThrow(/verified|clean|changed/i);
  });

  it.each(["app/main/commands/decide.tsx", "tsconfig.local.json", "dist/commands/decide.js"])("rejects untracked or ignored resolver input %s before bundling (comparator-v7-3)", async source => {
    const { AUDIT_BASELINE, assertBaseline } = await baselineApi();
    expect(() => assertBaseline("baseline", fakeGit(AUDIT_BASELINE, false, [source]))).toThrow(/untracked|ignored|clean/i);
  });

  it("permits only the intentional dependencies and model cache, and never excludes ignored source from Git's read (comparator-v7-3)", async () => {
    const { AUDIT_BASELINE, assertBaseline } = await baselineApi();
    const calls: string[][] = [];
    const fake = fakeGit(AUDIT_BASELINE, false, ["node_modules/", ".cache/"]);
    expect(() => assertBaseline("baseline", (cmd, args) => { calls.push(args); return fake(cmd, args); })).not.toThrow();
    expect(calls.some(args => args.includes("ls-files") && args.includes("--others") && !args.includes("--exclude-standard"))).toBe(true);
  });
});
