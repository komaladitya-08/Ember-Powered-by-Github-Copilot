/**
 * Windows' Run dialog in the policy (vocabulary.ts READ_ONLY_WINDOW): its OK and Enter run whatever its box holds, the
 * last command included, so on Windows Ember only reads it, in each of Windows' main languages; other explorer.exe
 * windows (a folder named "Run" too, once it is known to be a frame, not a dialog) and other apps' "Run" windows are
 * judged as before, and Linux and macOS have no such window.
 */

import { describe, expect, it } from "vitest";
import { KEYS } from "../../app/shared/shortcuts";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { READ_ONLY_WINDOW } from "../../app/main/policy/vocabulary";

const engine = (os: "linux" | "win32" | "darwin") => new PolicyEngine({ neverLook: () => [], grants: () => ({}), keys: KEYS[os], os });
const click = (app: string, window: string): ActionRequest => ({ taskId: "t", kind: "click", app, window, element: { role: "push button", name: "OK" } });

describe("the Run dialog on Windows", () => {
  it("refuses every action but reading in explorer.exe's Run dialog, whatever its language", () => {
    const win = engine("win32");
    for (const title of ["Run", "Ausführen", "Exécuter", "Ejecutar", "Esegui", "Executar", "Uitvoeren", "ファイル名を指定して実行", "运行", "執行", "실행"]) {
      const d = win.decide(click("explorer", title));
      expect(d, title).toMatchObject({ tier: "never", verdict: "deny" });
      expect(d.reason).toMatch(/Run dialog/);
      expect(win.decide({ ...click("explorer.exe", title), kind: "read" }).verdict).toBe("allow");
    }
    expect(win.decide({ taskId: "t", kind: "text", app: "explorer", window: "Run", element: { role: "combo box", name: "Open:" }, value: "notepad" }).tier).toBe("never");
  });

  it("judges other windows as before: File Explorer's folders, another app's \"Run\" window", () => {
    const win = engine("win32");
    expect(win.decide(click("explorer", "Documents")).tier).not.toBe("never");
    expect(win.decide(click("explorer", "Run options")).tier).not.toBe("never");
    expect(win.decide(click("vlc", "Run")).tier).not.toBe("never");
  });

  it("tells a File Explorer folder named \"Run\" (a frame) from the Run dialog (a dialog), and refuses a window whose role isn't known", () => {
    const win = engine("win32");
    const inWindow = (title: string, role?: string): ActionRequest => ({ ...click("explorer", title), windowId: { pid: 4321, path: "65812", ...(role !== undefined ? { role } : {}) } });
    for (const title of ["Run", "Ausführen", "ファイル名を指定して実行"]) {
      expect(win.decide(inWindow(title, "frame")).tier, title).not.toBe("never");
      for (const role of ["dialog", "alert", "window", ""]) expect(win.decide(inWindow(title, role)), `${title} ${role}`).toMatchObject({ tier: "never", verdict: "deny" });
      expect(win.decide(inWindow(title)).tier, title).toBe("never");
    }
    expect(READ_ONLY_WINDOW.win32[0]?.otherRole?.test("frame")).toBe(true);
  });

  it("has no such window on Linux or macOS", () => {
    expect(READ_ONLY_WINDOW.linux).toEqual([]);
    expect(READ_ONLY_WINDOW.darwin).toEqual([]);
    expect(engine("linux").decide(click("explorer", "Run")).tier).not.toBe("never");
    expect(engine("darwin").decide(click("explorer", "Run")).tier).not.toBe("never");
  });
});
