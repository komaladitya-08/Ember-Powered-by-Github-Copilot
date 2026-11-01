/**
 * The development memory report (app/main/memory-report.ts, EMBER_MEMORY_LOG): each renderer named after its page and
 * window, private bytes summed only where every process has them, and the platform's "name=value" Chromium switches.
 */

import { describe, expect, it } from "vitest";
import { memoryReport, pageOf } from "../../app/main/memory-report";
import { switchArgs } from "../../app/main/platform";

describe("the memory report", () => {
  it("names each renderer after its page and window title, largest private bytes first", () => {
    const r = memoryReport([
      { pid: 1, type: "Browser", memory: { workingSetSize: 140_000, privateBytes: 70_000 } },
      { pid: 2, type: "Tab", memory: { workingSetSize: 85_000, privateBytes: 33_000 } },
      { pid: 3, type: "Utility", name: "Ember voice", memory: { workingSetSize: 200_000, privateBytes: 148_000 } },
      { pid: 4, type: "Tab", memory: { workingSetSize: 50_000, privateBytes: 10_000 } },
    ], [
      { pid: 2, url: "file:///C:/Program%20Files/Ember/renderer/mic/index.html", title: "Ember microphone" },
    ]);
    expect(r.rows.map(x => x.kind)).toEqual(["utility Ember voice", "browser", "renderer mic Ember microphone", "renderer (no page)"]);
    expect(r.rows[0]).toEqual({ pid: 3, kind: "utility Ember voice", privateMb: 144.5, workingSetMb: 195.3 });
    expect(r.privateMb).toBe(254.9); // 144.5 + 68.4 + 32.2 + 9.8
  });

  it("gives no private total where the OS reports none (Linux and macOS)", () => {
    const r = memoryReport([{ pid: 1, type: "Browser", memory: { workingSetSize: 1024 } }], []);
    expect(r).toEqual({ rows: [{ pid: 1, kind: "browser", privateMb: null, workingSetMb: 1 }], privateMb: null, workingSetMb: 1 });
  });

  it("reads the page from a bundled URL, with a query, and nothing from any other", () => {
    expect(pageOf("file:///opt/ember/resources/app/dist/app/renderer/ask/index.html?opaque=1")).toBe("ask");
    expect(pageOf("https://github.com/login")).toBe("");
  });
});

describe("a platform's Chromium switch", () => {
  it("is passed as a name, or a name and its value", () => {
    expect(switchArgs("enable-speech-dispatcher")).toEqual(["enable-speech-dispatcher"]);
    expect(switchArgs("enable-features=RunVideoCaptureServiceInBrowserProcess")).toEqual(["enable-features", "RunVideoCaptureServiceInBrowserProcess"]);
  });
});
