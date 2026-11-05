import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseStartApps, startAppsReader } from "../../app/main/platform/win32/system/start-apps";

describe("the Store apps on the Start menu (ChatGPT “wasn't installed”, audit of 2026-11-02)", () => {
  const CHATGPT = { Name: "ChatGPT", AppID: "OpenAI.Codex_2p2nqsd0c76g0!App" };

  it("finds packaged apps, and leaves out shortcuts, uninstallers and anything it can't read", () => {
    expect(parseStartApps(JSON.stringify([CHATGPT, { Name: "Paint", AppID: "C:\\paint.lnk" }, { Name: "Uninstall Foo", AppID: "Foo.Bar_2p2nqsd0c76g0!App" }, { Name: 3 }, null]))).toEqual([{ name: "ChatGPT", aumid: CHATGPT.AppID }]);
    expect(parseStartApps("not json")).toEqual([]);
  });

  it("reads one app as Get-StartApps gives it (an object, not a list)", () => {
    expect(parseStartApps(JSON.stringify(CHATGPT))).toHaveLength(1);
  });

  const fakeSpawn = () => {
    const runs: { child: EventEmitter & { stdout: EventEmitter } }[] = [];
    return { runs, spawn: () => { const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() }); runs.push({ child }); return child as never; } };
  };

  it("reads in the background, once at a time, and says when the list changed", () => {
    const { runs, spawn } = fakeSpawn();
    let changes = 0, t = 0;
    const list = startAppsReader(spawn, () => changes++, () => t);
    expect(list()).toEqual([]);
    expect(list()).toEqual([]);
    expect(runs).toHaveLength(1);
    runs[0].child.stdout.emit("data", JSON.stringify([CHATGPT]));
    runs[0].child.emit("close", 0);
    expect(list()).toHaveLength(1);
    expect(changes).toBe(1);
    t += 11 * 60_000;
    list();
    expect(runs).toHaveLength(2);
  });

  it("keeps what it had when a read fails", () => {
    const { runs, spawn } = fakeSpawn();
    let t = 0;
    const list = startAppsReader(spawn, () => undefined, () => t);
    list();
    runs[0].child.stdout.emit("data", JSON.stringify([CHATGPT]));
    runs[0].child.emit("close", 0);
    t += 11 * 60_000;
    list();
    runs[1].child.emit("error", new Error("no powershell"));
    expect(list()).toHaveLength(1);
  });
});
