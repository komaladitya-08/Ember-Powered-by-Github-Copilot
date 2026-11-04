/** Exercises main's actual sign-out handler without starting Electron or accessing real credentials. */
import fs from "node:fs";
import { expect, it, vi } from "vitest";

it("disconnects and clears credentials even when memory erasure fails, while rejecting the sign-out promise", async () => {
  const main = fs.readFileSync("app/main/main.ts", "utf8");
  const start = main.indexOf("ipcMain.handle(IPC.signOut,");
  const end = main.indexOf("ipcMain.handle(IPC.cancelSignIn,", start);
  const failure = new Error("Ember couldn't finish deleting memory.");
  const agent = { forgetConversation: vi.fn(async () => { throw failure; }), start: vi.fn(async () => "signed-out") };
  const tokens = { clear: vi.fn() }, keeper = { use: vi.fn() }, providers = { forget: vi.fn() }, refusedTokens = { clear: vi.fn() };
  const resetAnswerSpeech = vi.fn();
  let run!: () => Promise<void>;
  const install = new Function("ipcMain", "IPC", "guard", "agent", "tokens", "keeper", "providers", "refusedTokens", "resetAnswerSpeech", `
    let signOuts = 0, accountErasures = 0, signInAbort = null, currentToken = "fake", askHistory = ["fake"];
    ${main.slice(start, end)}
    return () => ({ signOuts, accountErasures, currentToken, askHistory });
  `);
  const state = install({ handle: (_channel: string, handler: () => Promise<void>) => { run = handler; } }, { signOut: "sign-out" }, (fn: unknown) => fn, agent, tokens, keeper, providers, refusedTokens, resetAnswerSpeech);
  await expect(run()).rejects.toBe(failure);
  expect(tokens.clear).toHaveBeenCalledOnce(); expect(keeper.use).toHaveBeenCalledWith(null);
  expect(providers.forget).toHaveBeenCalledOnce(); expect(refusedTokens.clear).toHaveBeenCalledOnce();
  expect(agent.start).toHaveBeenCalledWith(null);
  expect(resetAnswerSpeech).toHaveBeenCalledTimes(2);
  expect(resetAnswerSpeech.mock.invocationCallOrder[0]).toBeLessThan(agent.forgetConversation.mock.invocationCallOrder[0]);
  expect(state()).toEqual({ signOuts: 1, accountErasures: 0, currentToken: null, askHistory: [] });
});
