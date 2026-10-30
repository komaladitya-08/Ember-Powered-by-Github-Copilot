/**
 * `ember --doctor` is the supported way to diagnose an install, and its run must end the process: a rejected step
 * (openWindows, doctorHelper, openInput, doctorProbes, targetDoctorRows, …) may have opened the window system or the
 * input backend before it failed, and the global unhandledRejection handler only logs. Without a catch/finally around
 * the check-up, Ember stays alive with its sidecar/X connection open and never prints a final status (issue #53).
 * main.ts can't be loaded in a unit test (it is Electron's entry point), so its doctor is read from the source, as
 * main-more-time.test.ts and main-privacy-wiring.test.ts do.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** The source from `from` up to `to`. */
function between(from: string, to: string): string {
  const start = MAIN.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = MAIN.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(-1);
  return MAIN.slice(start, end);
}

describe("ember --doctor exits when an awaited step rejects (issue #53)", () => {
  const doctor = between("async function runDoctor(): Promise<void> {", "function start(): void {");

  it("catches a rejected step instead of leaving it to the global unhandledRejection log", () => {
    expect(doctor).toContain(" try {");
    expect(doctor).toContain("} catch (err) {");
    expect(doctor).toContain("} finally {");
  });

  it("prints the error in catch and keeps the failure exit code", () => {
    const caught = doctor.slice(doctor.indexOf("} catch (err) {"), doctor.indexOf("} finally {"));
    expect(caught).toContain("log.error(");
    expect(caught).toContain("process.stderr.write(");
    // The default outcome is failure: a step that rejects exits 1, never 0.
    expect(doctor).toContain("let failed = true;");
  });

  it("closes the input and window system in finally, then exits whatever happened", () => {
    const cleanup = doctor.slice(doctor.indexOf("} finally {"));
    expect(cleanup).toContain("input?.close();");
    expect(cleanup).toContain("ws?.close();");
    expect(cleanup).toContain("app.exit(failed ? 1 : 0);");
  });
});
