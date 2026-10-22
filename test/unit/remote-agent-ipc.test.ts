import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { IpcError, lineRpc, type LineRpc } from "../../app/remote/desktop-ipc";
import { noticeText } from "../../app/remote/notice";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** Two ends of a JSON-lines link over in-memory pipes. */
function pair(answer: (op: string, a: unknown) => Promise<unknown>) {
  const ab = new PassThrough(), ba = new PassThrough();
  const closed: string[] = [];
  const events: [string, unknown][] = [];
  const a: LineRpc = lineRpc({ input: ba, output: ab, log: quiet, onRequest: async () => ({}), onEvent: (ev, d) => events.push([ev, d]), onClose: why => closed.push(`a: ${why}`) });
  const b: LineRpc = lineRpc({ input: ab, output: ba, log: quiet, onRequest: answer, onEvent: () => {}, onClose: why => closed.push(`b: ${why}`) });
  return { a, b, ab, ba, closed, events };
}

describe("serve ⇄ desktop child lines (desktop-ipc.ts)", () => {
  it("answers requests by id, both kinds of answer, and passes events", async () => {
    const p = pair(async (op, a) => {
      if (op === "fail") throw new IpcError("denied", "no");
      if (op === "boom") throw new Error("internal detail");
      return { echo: a };
    });
    expect(await p.a.request("echo", { x: 1 }, 1000)).toEqual({ echo: { x: 1 } });
    await expect(p.a.request("fail", {}, 1000)).rejects.toMatchObject({ code: "denied", message: "no" });
    await expect(p.a.request("boom", {}, 1000)).rejects.toMatchObject({ code: "internal" });
    p.b.event("stop", {});
    await new Promise(r => setTimeout(r, 10));
    expect(p.events).toEqual([["stop", {}]]);
  });

  it("ends the link on a malformed line, failing what waits with gone", async () => {
    const p = pair(() => new Promise(() => {}));
    const waiting = p.a.request("never", {}, 5000);
    p.ba.write("not json\n");
    await expect(waiting).rejects.toMatchObject({ code: "gone" });
    expect(p.closed).toContain("a: a malformed line");
    await expect(p.a.request("x", {}, 100)).rejects.toMatchObject({ code: "gone" });
  });

  it("fails a request the other side doesn't answer in time", async () => {
    const p = pair(() => new Promise(() => {}));
    await expect(p.a.request("slow", {}, 20)).rejects.toMatchObject({ code: "internal" });
  });

  it("ends when the other side's output ends", async () => {
    const p = pair(async () => ({}));
    p.ba.end();
    await new Promise(r => setTimeout(r, 10));
    expect(p.closed).toContain("a: the other side closed");
  });
});

describe("the notice's words (§5.3.9)", () => {
  it("names the PC as it reported itself", () => {
    expect(noticeText("ana-laptop")).toEqual({
      using: "Ember on ana-laptop is using this screen.",
      asking: "Ember on ana-laptop wants to use this screen.",
      paused: "Ember on ana-laptop lost its connection and isn't using this screen now.",
    });
    expect(noticeText("").using).toBe("Ember on another computer is using this screen.");
  });
});
