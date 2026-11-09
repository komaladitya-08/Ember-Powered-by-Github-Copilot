/** Execute main's actual injected consent callbacks without loading Electron or opening a network connection. */
import fs from "node:fs";
import vm from "node:vm";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { GrantKeeperDeps } from "../../app/main/agent/auth";

const text = fs.readFileSync("app/main/main.ts", "utf8");
const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const walk = (node: ts.Node) => { if (predicate(node)) found ??= node; if (!found) ts.forEachChild(node, walk); };
  walk(source);
  if (!found) throw new Error("The expected main callback was not found.");
  return found;
}
function evaluate(node: ts.Node, bindings: object): unknown {
  const js = ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(js, bindings);
}

describe("main's consent-bound runtime callbacks", () => {
  it.each(["key", "renewal", "token"] as const)("retires a %s startup continuation across loss and renewal of agreement (extensions-consent-review-2)", async stage => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const providers = { needsRead: () => stage === "key", ensureKey: vi.fn(() => held) };
    const keeper = { freshen: vi.fn(() => stage === "renewal" ? held : Promise.resolve()) };
    const resolveToken = vi.fn(async () => { if (stage === "token") await held; return null; });
    const connectWith = vi.fn();
    const bindings = { consented: () => true, brainStarted: false, brainAgreement: 0, signOuts: 0,
      provider: null, providers, keeper, resolveToken, connectWith, setStatus() {}, platform: { os: "linux" },
      tokens: null, process: { env: {} }, ghOptions: () => ({}), log: { info() {} } };
    const declaration = find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === "startBrain") as ts.VariableDeclaration;
    const start = evaluate(declaration.initializer!, bindings) as () => Promise<void>;
    const pending = start();
    // Let the preceding immediate reads finish, then revoke and renew while this read remains held.
    await Promise.resolve(); await Promise.resolve();
    ++bindings.brainAgreement;
    release(); await pending;
    expect(connectWith).not.toHaveBeenCalled();
    if (stage === "key") expect(keeper.freshen).not.toHaveBeenCalled();
    if (stage !== "token") expect(resolveToken).not.toHaveBeenCalled();
  });

  it("blocks renewal fetch/store/reconnect at the actual outbound wiring (extensions-consent-review-2)", async () => {
    let agreed = false;
    const net = { fetch: vi.fn(async () => new Response("{}")) };
    const agent = { idle: true, start: vi.fn(async () => undefined) };
    const tokens = {};
    const bindings = { consented: () => agreed, net, agent, tokens, currentToken: "fixture-old", log: { info() {} } };
    const call = find(n => ts.isNewExpression(n) && n.expression.getText(source) === "GrantKeeper") as ts.NewExpression;
    const deps = evaluate(call.arguments![0], bindings) as GrantKeeperDeps;
    const request = { method: "POST", headers: {}, body: "fixture" };
    expect(deps.allowed?.()).toBe(false);
    expect(() => deps.fetch("https://fixture.example", request)).toThrow(/setup/i);
    expect(net.fetch).not.toHaveBeenCalled();
    expect(deps.store()).toBeNull(); expect(deps.inUse()).toBeNull();
    await deps.reconnect("fixture-new");
    expect(agent.start).not.toHaveBeenCalled(); expect(bindings.currentToken).toBe("fixture-old");
    agreed = true;
    expect(deps.store()).toBe(tokens); expect(deps.inUse()).toBe("fixture-old");
    await deps.fetch("https://fixture.example", request);
    await deps.reconnect("fixture-new");
    expect(net.fetch).toHaveBeenCalledTimes(1); expect(agent.start).toHaveBeenCalledExactlyOnceWith("fixture-new", "stored");
  });

  it("blocks connection and re-arms first start after agreement is renewed (extensions-consent-review-2)", async () => {
    let agreed = false;
    const stop = vi.fn();
    const pause = vi.fn(async () => undefined);
    const stopEverything = vi.fn();
    const bindings = { consented: () => agreed, admin: {}, modelServiceRefusal: () => null, agent: { pauseForConsent: pause }, log: { warn() {} }, stopEverything, brainStarted: true, brainAgreement: 0, brainAgreed: true,
      keeper: { stop }, brainStart: Promise.resolve(), startBrain: vi.fn(async () => { bindings.brainStarted = true; }) };
    const property = find(n => ts.isPropertyAssignment(n) && n.name.getText(source) === "refuseConnect") as ts.PropertyAssignment;
    const refused = evaluate(property.initializer, bindings) as () => string | null;
    expect(refused()).not.toBeNull(); agreed = true; expect(refused()).toBeNull(); agreed = false;
    const call = find(n => ts.isCallExpression(n) && n.expression.getText(source) === "settings.onChange"
      && n.arguments[0]?.getText(source).includes("brainAgreement")) as ts.CallExpression;
    const changed = evaluate(call.arguments[0], bindings) as () => void;
    changed();
    expect(bindings.brainStarted).toBe(false); expect(bindings.brainAgreement).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1); expect(bindings.startBrain).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(stopEverything).toHaveBeenCalledExactlyOnceWith("settings");
    changed(); expect(pause).toHaveBeenCalledTimes(1);
    agreed = true; changed(); await bindings.brainStart;
    expect(bindings.startBrain).toHaveBeenCalledTimes(1); expect(bindings.brainStarted).toBe(true);
  });
});
