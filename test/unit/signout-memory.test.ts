/** Exercises main's actual sign-out handler without starting Electron or accessing real credentials. */
import fs from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { isTrustedSender } from "../../app/main/windows";

// windows.ts imports electron at load; only its pure predicate is used here.
vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, Menu: {}, nativeTheme: {}, screen: {}, shell: {}, ipcMain: {}, dialog: {}, session: {} }));

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

it("answers routinesCount only to the live Home window, and only with a tagged count (no path, no raw error)", () => {
  const main = fs.readFileSync("app/main/main.ts", "utf8");
  const g0 = main.indexOf("const guard = <A extends unknown[], R>");
  const guardSrc = main.slice(g0, main.indexOf("return fn(...args);\n    };", g0) + 26);
  const h0 = main.indexOf("ipcMain.handle(IPC.routinesCount,");
  const handlerSrc = main.slice(h0, main.indexOf("\n", main.indexOf("))));", h0)));
  let handler!: (event: unknown) => unknown;
  const logged: unknown[] = [];
  const userData = "/secret/data";
  const home = { isDestroyed: () => false, webContents: { id: "home" } };
  const install = new Function("ipcMain", "IPC", "isTrustedSender", "home", "countStoredRoutines", "userData", "log",
    ts.transpileModule(`${guardSrc}\n${handlerSrc}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  install({ handle: (_c: string, fn: typeof handler) => { handler = fn; } }, { routinesCount: "routines:count" },
    isTrustedSender, home,
    (_dir: string, onFailed: (e: unknown) => void) => { onFailed(new Error(`EACCES: ${userData}/routines.json`)); return { known: false }; }, userData, { warn: (...a: unknown[]) => logged.push(a) });
  const event = (url: string, sender: unknown) => ({ senderFrame: { url }, sender });
  expect(handler(event("file:///app/renderer/home/index.html", home.webContents))).toEqual({ known: false });
  expect(JSON.stringify(handler(event("file:///app/renderer/home/index.html", home.webContents)))).not.toContain(userData);
  expect(() => handler(event("https://evil.example/", home.webContents))).toThrow(/untrusted IPC sender/);
  expect(() => handler(event("file:///app/renderer/ask/index.html", { id: "ask" }))).toThrow(/untrusted IPC sender/);
  expect(() => handler(event("", home.webContents))).toThrow(/untrusted IPC sender/);
  expect(logged.length).toBe(2); // the failure is logged in main, where the path may stay
});
