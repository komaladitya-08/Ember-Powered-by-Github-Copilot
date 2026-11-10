/**
 * scripts/perf/footprint.mjs's DevTools calls to Ember's pages (devtools.mjs), with a fake socket: a page that closes
 * while the sample waits (listening starting again closes the microphone's) must answer its calls with nothing, or CI's
 * el8 footprint step waits until the job times out. Node's WebSocket neither throws nor answers a send on a closed
 * socket, which the fake does too (reliability-performance-w6-1, reliability-y6-1).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { devtoolsPage } from "../../scripts/perf/devtools.mjs";

const root = path.resolve(__dirname, "../..");

/** A page's DevTools socket, as Node's WebSocket behaves: a send once closed is dropped, never answered. */
class FakeSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: { id: number; method: string; params: unknown }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: never) => void) | null = null;
  send(data: string) { if (this.readyState === WebSocket.OPEN) this.sent.push(JSON.parse(data)); }
  open() { this.readyState = WebSocket.OPEN; this.onopen?.(); }
  answer(id: number, result: unknown) { this.onmessage?.({ data: JSON.stringify({ id, result }) }); }
  /** The page went away (Page.crash, a closed window): the socket closes without a word from the run. */
  gone() { this.readyState = WebSocket.CLOSED; this.onclose?.(); }
}

/** A call's answer, or "still waiting" if it has none by the next turn of the event loop. */
const settled = (p: Promise<unknown>) => Promise.race([p, new Promise(r => setTimeout(() => r("still waiting"), 20))]);

const opened = async () => {
  const ws = new FakeSocket();
  const page = devtoolsPage(ws);
  ws.open();
  return await page;
};

describe("footprint.mjs's DevTools calls to Ember's pages", () => {
  it("relays each call's own result while the page is open (reliability-y6-1)", async () => {
    const { ws, call } = await opened();
    const enable = call("Performance.enable"), metrics = call("Performance.getMetrics");
    expect(ws.sent).toEqual([{ id: 1, method: "Performance.enable", params: {} }, { id: 2, method: "Performance.getMetrics", params: {} }]);
    ws.answer(2, { metrics: [{ name: "TaskDuration", value: 1.5 }] });
    ws.answer(1, {});
    expect(await settled(metrics)).toEqual({ metrics: [{ name: "TaskDuration", value: 1.5 }] });
    expect(await settled(enable)).toEqual({});
  });

  it("answers nothing at once for a call made after the page closed, the usual restart during the sample's wait (reliability-y6-1)", async () => {
    const { ws, call } = await opened();
    expect(await settled(call("Performance.enable"))).toBe("still waiting");
    ws.answer(1, {});
    // The microphone page closes during the 10 s wait, with no call pending; the later getMetrics must not wait for ever.
    ws.gone();
    expect(await settled(call("Performance.getMetrics"))).toBeUndefined();
    expect(ws.sent.map(m => m.method)).toEqual(["Performance.enable"]);
  });

  it("answers nothing for a call still waiting when the page closes (reliability-y6-1)", async () => {
    const { ws, call } = await opened();
    const metrics = call("Performance.getMetrics");
    expect(await settled(metrics)).toBe("still waiting");
    ws.gone();
    expect(await settled(metrics)).toBeUndefined();
  });

  it("fails a page whose socket can't open, as before (reliability-y6-1)", async () => {
    const ws = new FakeSocket();
    const page = devtoolsPage(ws);
    ws.onerror?.({} as never);
    await expect(page).rejects.toEqual({});
  });

  it("is how footprint.mjs opens every page it measures (reliability-y6-1)", () => {
    const script = readFileSync(path.join(root, "scripts/perf/footprint.mjs"), "utf8");
    expect(script).toContain('import { devtoolsPage } from "./devtools.mjs";');
    expect(script).toContain("const open = t => devtoolsPage(new WebSocket(t.webSocketDebuggerUrl));");
    // No call wrapper of its own beside it, whose sends could wait for ever.
    expect(script).not.toMatch(/\.send\(/);
  });
});
