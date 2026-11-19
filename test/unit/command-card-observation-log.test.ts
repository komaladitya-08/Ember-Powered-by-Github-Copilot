/** Private-log and CI numeric projection contracts; no app, model, commands, desktop input or native proof. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "../../app/main/logger";
import { parseCommandCardObservationLog, readCommandCardObservationLog } from "../fixtures/command-card-observation-log";

const data = { schema: 1, card: 2, sample: 3, source: 1, model: 7, ui: 27, geometry: 215, arm: 2, capped: 0, host: 1 };
const row = (fields: object = data) => JSON.stringify({ ...fields, t: "PRIVATE timestamp", level: "info", msg: "commands.card_observation", scope: "command-window" }) + "\n";
const parse = (text: string) => parseCommandCardObservationLog(Buffer.from(text));
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function profile() { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-card-observation-"))); dirs.push(dir); fs.mkdirSync(path.join(dir, "logs")); return dir; }

it("projects only numeric fields from the actual private Logger format", () => {
  const dir = profile(), log = createLogger({ dir: path.join(dir, "logs") }).child("command-window");
  const main = fs.readFileSync("app/main/main.ts", "utf8");
  expect(main).toContain('const log = createLogger({\n  dir: path.join(userData, "logs"),');
  log.info("unrelated", { text: "PRIVATE code and transcript" }); log.info("commands.card_observation", data);
  const value = readCommandCardObservationLog(dir);
  expect(value).toEqual({ ...data, known: 1, visibility: 3, under: 0, px: 0, py: 0, fx: 0, fy: 0, fw: 0, fh: 0, ox: 0, oy: 0, ow: 0, oh: 0, stack: 0 }); expect(Object.isFrozen(value)).toBe(true);
  expect(JSON.stringify(value)).not.toContain("PRIVATE"); expect(value).not.toHaveProperty("t"); expect(value).not.toHaveProperty("scope");
});
it("keeps last ordered observations and accepts identical duplicate lines without inventing a new sample", () => {
  expect(parse(row({ ...data, sample: 2 }) + row() + row())).toEqual({ ...data, known: 1, visibility: 3, under: 0, px: 0, py: 0, fx: 0, fy: 0, fw: 0, fh: 0, ox: 0, oy: 0, ow: 0, oh: 0, stack: 0 });
  expect(parse(row() + row({ ...data, card: 3, sample: 1 }))).toMatchObject({ known: 1, card: 3, sample: 1 });
});
it.each([
  row({ ...data, schema: 2 }), row({ ...data, source: 0 }), row({ ...data, model: 128 }), row({ ...data, ui: 32 }),
  row({ ...data, geometry: 512 }), row({ ...data, arm: 3 }), row({ ...data, sample: 0 }), row({ ...data, host: 8 }),
  row({ ...data, card: 41 }), row({ ...data, extra: "PRIVATE" }), row({ ...data, capped: "PRIVATE" }),
  '{"msg":"commands.card_observation","PRIVATE":\n', row().trimEnd(),
  row() + row({ ...data, ui: 15 }), row() + row({ ...data, card: 1 }), row() + row({ ...data, sample: 2 }),
])("leaves malformed, partial or conflicting records unknown %#", text => {
  const value = parse(text); expect(value.known).toBe(0); expect(JSON.stringify(value)).not.toContain("PRIVATE");
});
it("treats renderer/host budgets and excessive record counts as unknown rather than current state", () => {
  expect(parse(row({ ...data, capped: 1 }))).toMatchObject({ known: 0, capped: 1, model: 0 });
  expect(parse(row({ ...data, sample: 16 }))).toMatchObject({ known: 0, capped: 1 });
  const many = Array.from({ length: 65 }, (_, index) => row({ ...data, card: Math.floor(index / 15) + 1, sample: index % 15 + 1 })).join("");
  expect(parse(many)).toMatchObject({ known: 0, capped: 1 });
});
it("does not read proxy/getter traps, malformed byte strings or oversized buffers", () => {
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); };
  const value = new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  expect(parseCommandCardObservationLog(value).known).toBe(0);
  const bytes = Buffer.from(row()); Object.defineProperty(bytes, "toString", { get: trap });
  expect(parseCommandCardObservationLog(bytes).known).toBe(0); expect(reads).toBe(0);
  expect(parseCommandCardObservationLog(Buffer.from([0xff])).known).toBe(0);
  expect(parseCommandCardObservationLog(Buffer.alloc(256 * 1024 + 1)).known).toBe(0);
});
it("reads one bounded complete tail and refuses links without consuming their targets", () => {
  const dir = profile(), file = path.join(dir, "logs", "ember.log");
  fs.writeFileSync(file, "x".repeat(256 * 1024) + "\n" + row()); expect(readCommandCardObservationLog(dir).known).toBe(1);
  const other = path.join(dir, "other.log"); fs.renameSync(file, other);
  let linked = false;
  try { fs.symlinkSync(other, file); linked = true; }
  catch (error) { if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  if (linked) {
    const read = vi.spyOn(fs, "readSync"); expect(readCommandCardObservationLog(dir).known).toBe(0); expect(read).not.toHaveBeenCalled(); read.mockRestore(); fs.unlinkSync(file);
  }
  fs.linkSync(other, file); expect(readCommandCardObservationLog(dir).known).toBe(0);
});
it("keeps missing/read/close uncertainty unknown and always attempts to close the held descriptor", () => {
  const dir = profile(); expect(readCommandCardObservationLog(dir).known).toBe(0);
  fs.writeFileSync(path.join(dir, "logs", "ember.log"), row());
  const close = vi.spyOn(fs, "closeSync"), read = vi.spyOn(fs, "readSync").mockImplementationOnce(() => { throw new Error("PRIVATE read"); });
  expect(readCommandCardObservationLog(dir).known).toBe(0); expect(close).toHaveBeenCalledOnce(); read.mockRestore(); close.mockRestore();
  const original = fs.closeSync;
  const failedClose = vi.spyOn(fs, "closeSync").mockImplementationOnce(fd => { original(fd); throw new Error("PRIVATE close receipt"); });
  expect(readCommandCardObservationLog(dir).known).toBe(0); expect(failedClose).toHaveBeenCalledOnce();
});
it("folds the last card's page visibility without keeping any earlier card's", () => {
  const hidden = data.geometry & ~16, at = (sample: number, geometry: number, card = data.card) => row({ ...data, card, sample, geometry });
  expect(parse(at(1, hidden) + at(2, hidden))).toMatchObject({ known: 1, sample: 2, visibility: 0 });
  expect(parse(at(1, hidden) + at(2, data.geometry))).toMatchObject({ visibility: 3 });
  expect(parse(at(1, data.geometry) + at(2, hidden))).toMatchObject({ visibility: 5 });
  expect(parse(at(1, data.geometry) + at(2, hidden) + at(3, data.geometry))).toMatchObject({ visibility: 7 });
  expect(parse(at(1, data.geometry) + at(2, hidden) + at(1, hidden, 3))).toMatchObject({ card: 3, visibility: 0 });
});

const workflow = fs.readFileSync(".github/workflows/windows-node-product.yml", "utf8");
function facts(attempt: unknown) {
  const begin = workflow.indexOf("          const commandFailureFacts ="), end = workflow.indexOf("          const failureFacts =", begin); expect(begin > 0 && end > begin).toBe(true);
  const code = workflow.slice(begin, end) + "\ncommandFailureFacts(attempt);";
  return runInNewContext(code, { attempt, Buffer, require: (name: string) => { expect(name).toBe("node:util"); return { types }; } });
}
const frame = { ...data, known: 1, visibility: 3, under: 0, px: 0, py: 0, fx: 0, fy: 0, fw: 0, fh: 0, ox: 0, oy: 0, ow: 0, oh: 0, stack: 0 };
const attempt = (value: unknown = frame) => ({ stdout: Buffer.from("PRIVATE ordinary child output\nWindows Node packaged command observation " + JSON.stringify(value) + "\n"), stderr: Buffer.from("") });
it("runs the actual workflow projection independently of primary child outcome and prints no child or log text", () => {
  expect(facts({ ...attempt(), status: 1, error: new Error("PRIVATE") })).toEqual(frame);
  expect(JSON.stringify(facts(attempt()))).not.toContain("PRIVATE");
  expect(facts(attempt({ schema: 1, known: 0, card: 0, sample: 0, source: 0, model: 0, ui: 0, geometry: 0, arm: 0, capped: 1, host: 0, visibility: 0, under: 0, px: 0, py: 0, fx: 0, fy: 0, fw: 0, fh: 0, ox: 0, oy: 0, ow: 0, oh: 0, stack: 0 }))).toMatchObject({ known: 0, capped: 1 });
});
it.each([
  { ...frame, known: 2 }, { ...frame, known: 0 }, { ...frame, capped: 1 }, { ...frame, sample: 16 }, { ...frame, card: 0 },
  { ...frame, source: 3 }, { ...frame, model: 128 }, { ...frame, ui: 32 }, { ...frame, geometry: 512 }, { ...frame, arm: 3 },
  { ...frame, host: 8 }, { ...frame, visibility: 8 }, { ...frame, under: 13 }, { ...frame, px: 1024 }, { ...frame, extra: "PRIVATE" },
])("refuses unsupported public numeric frame %#", value => { expect(facts(attempt(value))).toMatchObject({ known: 0, model: 0 }); });
it("refuses contradictory or malformed public records without touching hostile attempt accessors", () => {
  const a = attempt(); a.stdout = Buffer.concat([a.stdout, Buffer.from("Windows Node packaged command observation " + JSON.stringify({ ...frame, ui: 15 }) + "\n")]);
  expect(facts(a)).toMatchObject({ known: 0 });
  expect(facts({ stdout: Buffer.from("Windows Node packaged command observation {PRIVATE\n"), stderr: Buffer.from("") })).toMatchObject({ known: 0 });
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); };
  expect(facts(new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap }))).toMatchObject({ known: 0 });
  expect(facts({ get stdout() { return trap(); }, stderr: Buffer.from("") })).toMatchObject({ known: 0 }); expect(reads).toBe(0);
});
it("the actual packaged failure capture reads once before cleanup and never retries an unknown snapshot", () => {
  const source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
  const method = /^ {2}captureFailure\(\): void \{([^\n]+)\}$/m.exec(source)?.[1]; expect(method).toBeTruthy();
  for (const fault of [false, true]) {
    const calls: string[] = [], read = vi.fn(() => { calls.push("owned-log"); if (fault) throw new Error("PRIVATE"); return frame; });
    const receiver = { failureCaptured: false, commandObservation: undefined as unknown, profile: "/owned/profile", model: { steps: new Map(), results: new Map() },
      observe: () => { calls.push("cached-model"); }, observation: { capture: () => { calls.push("primary-capture"); } } };
    const capture = runInNewContext("(function(){" + method + "})", { readCommandCardObservationLog: read }) as (this: typeof receiver) => void;
    expect(() => capture.call(receiver)).not.toThrow(); receiver.profile = "/later/cleanup"; capture.call(receiver);
    expect(read).toHaveBeenCalledExactlyOnceWith("/owned/profile"); expect(calls).toEqual(["cached-model", "primary-capture", "owned-log"]);
    expect(receiver.commandObservation).toBe(fault ? undefined : frame);
  }
});

it.each(["body", "cleanup"])("uses the actual packaged cleanup wrapper without acquiring a late log after %s failure", async fault => {
  const source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
  const method = /^ {2}captureFailure\(\): void \{([^\n]+)\}$/m.exec(source)?.[1]; expect(method).toBeTruthy();
  const begin = source.indexOf('  } catch { try { fixture?.captureFailure(); } catch { /* Failure observation cannot replace the original path. */ }'),
    end = source.indexOf("  quarantined = false;", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const calls: string[] = [], read = vi.fn(() => { calls.push("owned-log"); return frame; });
  const capture = runInNewContext("(function(){" + method + "})", { readCommandCardObservationLog: read }) as (this: object) => void;
  const cleanupMethod = /^ {2}beginCleanup\(\): void \{([^\n]+)\}$/m.exec(source)?.[1]; expect(cleanupMethod).toBeTruthy();
  const beginCleanup = runInNewContext("(function(){" + cleanupMethod + "})") as (this: object) => void;
  const fixture = { phase: 6, failureCaptured: false, cleanupStarted: false, commandObservation: undefined as unknown, profile: "/owned/profile",
    model: { steps: new Map(), results: new Map() }, observe: () => { calls.push("cached-model"); }, observation: { capture: () => { calls.push("primary-capture"); } },
    captureFailure() { capture.call(this); }, beginCleanup() { calls.push("cleanup-start"); beginCleanup.call(this); },
    async close() { calls.push("fixture-close"); if (fault === "cleanup") throw new Error("PRIVATE cleanup"); return false; },
    failureObservation: () => undefined, commandFailureObservation() { return this.commandObservation; } };
  const model = { async close() { calls.push("model-close"); } };
  const code = "(async function(fixture, model, bodyFailure) { let failed = false, phase = 1, root; try { if (bodyFailure) throw 0;\n" + source.slice(begin, end) + "})";
  const wrapper = runInNewContext(code, { console: { info: vi.fn() }, refusal: () => new Error("expected refusal") }) as (fixture: object, model: object, bodyFailure: boolean) => Promise<void>;
  await expect(wrapper(fixture, model, fault === "body")).rejects.toThrow("expected refusal");
  expect(read).toHaveBeenCalledTimes(fault === "body" ? 1 : 0);
  expect(calls.filter(call => call === "primary-capture")).toHaveLength(1);
  expect(calls).toEqual(fault === "body" ? ["cached-model", "primary-capture", "owned-log", "cleanup-start", "fixture-close", "model-close"]
    : ["cleanup-start", "fixture-close", "model-close", "cached-model", "primary-capture"]);
});
