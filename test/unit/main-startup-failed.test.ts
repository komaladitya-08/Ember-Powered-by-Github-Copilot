import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("app/main/main.ts", "utf8");
const start = source.indexOf("function startupFailed(err: unknown): void {");
const code = source.slice(start, source.indexOf("\n}\n", start) + 2)
  .replace("err: unknown", "err").replace("): void", ")");

describe("startup failure", () => {
  it("shows the error but exits only from the next event-loop turn, never inside Electron ready (electron/electron#55011)", async () => {
    expect(start).toBeGreaterThan(-1);
    const calls: string[] = [];
    const later: (() => void)[] = [];
    const context = vm.createContext({
      log: { error: () => calls.push("logged"), file: "/missing" },
      fs: { existsSync: () => false },
      app: { whenReady: () => Promise.resolve(), exit: (code: number) => calls.push(`exit ${code}`) },
      sys: { lifecycle: { focusOwnApp: () => calls.push("focused") } },
      dialog: { showErrorBox: () => calls.push("shown") },
      setImmediate: (fn: () => void) => later.push(fn),
    });
    vm.runInContext(`${code}\nstartupFailed(new Error("could not start"));`, context);
    await Promise.resolve();
    expect(calls).toEqual(["logged", "focused", "shown"]);
    expect(later).toHaveLength(1);
    later[0]();
    expect(calls).toEqual(["logged", "focused", "shown", "exit 1"]);
  });
});
