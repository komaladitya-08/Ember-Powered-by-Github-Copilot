import { describe, expect, it } from "vitest";
import { AX_ERROR } from "../../app/main/platform/darwin/ax";
import { AxSession, BusyApps, keyboardControl } from "../../app/sidecar-host/providers/ax-darwin-read";
import { FakeAx, type AppSpec } from "./sidecar-host-ax-darwin-fake";

const PID = 4400;
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Runs keyboardControl over `target`, releases whatever the caller still holds, and reports what the fake kept. */
function climb(fake: FakeAx, target: string): { outstanding: number; error?: unknown } {
  const s = new AxSession(fake, PID, new BusyApps(fake.now));
  const el = fake.ref(fake.el(target));
  let error: unknown;
  try {
    const control = keyboardControl(s, el);
    if (control !== el) fake.release(control);
  } catch (err) {
    error = err;
  } finally {
    fake.release(el);
  }
  return { outstanding: fake.outstanding, ...(error === undefined ? {} : { error }) };
}

describe("keyboardControl gives back what it read before it fails", () => {
  it("releases the parent reference when reading the parent's role fails", () => {
    const app: AppSpec = {
      pid: PID,
      owner: "Test",
      windows: [{
        role: "AXWindow", title: "W", id: "window", windowId: 91, frame: at(0, 0, 400, 300),
        children: [{
          role: "AXTextField", id: "field", frame: at(0, 0, 200, 20),
          children: [{ role: "AXTextArea", id: "editor", frame: at(0, 0, 200, 20) }],
        }],
      }],
    };
    const fake = new FakeAx([app]);
    fake.el("field").spec.failOn = { attr: AX_ERROR.cannotComplete };
    const r = climb(fake, "editor");
    expect(r.error).toMatchObject({ code: "busy" });
    expect(r.outstanding).toBe(0);
  });

  it("releases the parent and the climbed element when reading the parent's role fails after a climb", () => {
    const app: AppSpec = {
      pid: PID,
      owner: "Test",
      windows: [{
        role: "AXWindow", id: "window", windowId: 91, frame: at(0, 0, 400, 300),
        children: [{
          role: "AXTextField", id: "field", frame: at(0, 0, 200, 20),
          children: [{ role: "AXTextArea", id: "editor", frame: at(0, 0, 200, 20) }],
        }],
      }],
    };
    const fake = new FakeAx([app]);
    fake.el("window").spec.failOn = { attr: AX_ERROR.cannotComplete };
    const r = climb(fake, "editor");
    expect(r.error).toMatchObject({ code: "busy" });
    expect(r.outstanding).toBe(0);
  });

  it("releases the parent, above and the climbed element when reading above's role fails", () => {
    const app: AppSpec = {
      pid: PID,
      owner: "Test",
      windows: [{
        role: "AXWindow", id: "window", windowId: 91, frame: at(0, 0, 400, 300),
        children: [{
          role: "AXTextField", id: "field", frame: at(0, 0, 200, 20),
          children: [{
            role: "AXScrollArea", id: "scroll", frame: at(0, 0, 200, 20),
            children: [{ role: "AXTextArea", id: "editor", frame: at(0, 0, 200, 20) }],
          }],
        }],
      }],
    };
    const fake = new FakeAx([app]);
    fake.el("field").spec.failOn = { attr: AX_ERROR.cannotComplete };
    const r = climb(fake, "editor");
    expect(r.error).toMatchObject({ code: "busy" });
    expect(r.outstanding).toBe(0);
  });
});
