import { describe, expect, it } from "vitest";
import { copyNodeArgv, nodeInvocationDisplay, nodeInvocationSha256 } from "../../app/main/commands/node-invocation";
import { classifyNodeArgv, type ClassificationExtra } from "../../app/main/commands/classify";
import { commandSha256 } from "../../app/main/commands/flow";
import { contextOf } from "../fixtures/commands/corpus";

describe("literal direct Node policy", () => {
  it("preserves empty arguments and punctuation without shell expansion or substitution", () => {
    const argv = ["tool.js", "", "a b", "$(rm -rf /)", "*", "~", "$HOME", "a;b", "'\\\""];
    const snapshot = copyNodeArgv(argv); argv[0] = "changed.js";
    expect(snapshot[0]).toBe("tool.js");
    const cls = classifyNodeArgv(snapshot, contextOf("linux"));
    expect(cls.shell).toBeUndefined(); expect(cls.syntax).toBe("argv");
    expect(cls.commands[0]).toMatchObject({ program: "node", args: snapshot });
    expect(cls.commands).toHaveLength(1);
    expect(cls.findings.some(f => f.rule === "escape.background" || f.rule === "unclear.substitution")).toBe(false);
    expect(nodeInvocationDisplay(snapshot)).toBe(`Node arguments: ${JSON.stringify(snapshot)}`);
  });

  it.each([null, {}, [1], ["x\0y"], ["\ud800"], Array(257).fill(""), ["é".repeat(4000)]])("rejects malformed or oversized argv %#", value => {
    expect(() => copyNodeArgv(value)).toThrow();
  });

  it("separates argument boundaries, order, folder, target and shell approval domains", () => {
    const hash = nodeInvocationSha256("local", "/work", ["a", "b"]);
    const alternatives = [nodeInvocationSha256("local", "/work", ["a b"]), nodeInvocationSha256("local", "/work", ["b", "a"]),
      nodeInvocationSha256("local", "/work/other", ["a", "b"]), nodeInvocationSha256("ssh:test", "/work", ["a", "b"]),
      commandSha256("local", "bash", "/work", nodeInvocationDisplay(["a", "b"]))];
    expect(new Set([hash, ...alternatives]).size).toBe(alternatives.length + 1);
  });

  it("retains the native interpreter's inline-code, protected-path and script provenance checks", () => {
    const ctx = contextOf("linux");
    expect(classifyNodeArgv(["-e", "console.log('hello')"], ctx).findings.map(f => f.rule)).toContain("unclear.inline-code");
    expect(classifyNodeArgv(["-e", `require('fs').readFileSync('${ctx.ember.paths[0]}')`], ctx).refuse).not.toBeNull();
    expect(classifyNodeArgv(["--env-file", `${ctx.ember.paths[0]}/settings.json`, "a.js"], ctx).refuse).not.toBeNull();
    const downloaded = classifyNodeArgv(["tool.js"], { ...ctx, downloaded: new Set([`${ctx.cwd}/tool.js`]) });
    expect(downloaded.findings.map(f => f.rule)).toContain("escape.run-downloaded");
    expect((classifyNodeArgv(["tool.js"], ctx) as ClassificationExtra).scripts.some(script => script.as === "code")).toBe(true);
  });
});
