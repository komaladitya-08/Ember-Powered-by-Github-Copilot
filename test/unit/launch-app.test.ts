import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { launchApp } from "../../app/main/hands/system";
import type { DesktopApp } from "../../app/main/hands/system";

const app = (more: Partial<DesktopApp> = {}): DesktopApp => ({ id: "org.xfce.mousepad", name: "Mousepad", exec: "mousepad %U", file: "", keywords: [], ...more });
const child = () => Object.assign(new EventEmitter(), { unref: vi.fn() });

describe("launchApp", () => {
  it("starts an app in the user's home, not Ember's working folder", () => {
    spawn.mockReturnValue(child());
    launchApp(app());
    expect(spawn).toHaveBeenCalledWith("gtk-launch", ["org.xfce.mousepad"], expect.objectContaining({ cwd: os.homedir(), detached: true }));
  });

  it("uses the Exec line as a fallback, still in the user's home", () => {
    const first = child();
    spawn.mockReturnValueOnce(first).mockReturnValue(child());
    launchApp(app());
    first.emit("error", new Error("gtk-launch is missing"));
    expect(spawn).toHaveBeenLastCalledWith("mousepad", [], expect.objectContaining({ cwd: os.homedir() }));
  });
});
