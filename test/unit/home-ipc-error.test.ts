/**
 * The settings window shows what main said when a request failed (a refused setup fix, a sign-in, adding a computer) in
 * main's own words: Electron's "Error invoking remote method '<channel>': Error: " prefix never reaches the user.
 */

import { describe, expect, it } from "vitest";
import { ipcErrorText } from "../../app/renderer/home/copy";

describe("ipcErrorText", () => {
  it("drops Electron's IPC prefix from a handler's error, leaving its own words", () => {
    const refused = new Error("Error invoking remote method 'ember:apply-fix': Error: Start Ubuntu first: Ember doesn't start a distro to change its settings.");
    expect(ipcErrorText(refused)).toBe("Start Ubuntu first: Ember doesn't start a distro to change its settings.");
    expect(ipcErrorText(new Error("Error invoking remote method 'ember:sign-in': TypeError: fetch failed"))).toBe("fetch failed");
    expect(ipcErrorText(new Error("Error invoking remote method 'ember:apply-fix': Your organisation has turned this off."))).toBe("Your organisation has turned this off.");
  });

  it("leaves any other message as it is", () => {
    expect(ipcErrorText(new Error("WSL isn't turned on for Ember."))).toBe("WSL isn't turned on for Ember.");
    expect(ipcErrorText(new Error("Note: Error invoking remote method 'x': Error: y"))).toBe("Note: Error invoking remote method 'x': Error: y");
    expect(ipcErrorText("plain text")).toBe("plain text");
  });
});
