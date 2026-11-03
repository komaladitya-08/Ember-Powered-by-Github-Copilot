/** Short writes must finish byte for byte before settings or retained audit entries replace a valid file. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";

const dirs: string[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-short-write-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Inject a short filesystem write, including splits inside UTF-8 characters, without filling a disk. */
function shortWrites(failAfter?: number, code?: string) {
  const real = fs.writeSync;
  let calls = 0;
  return vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: string | Buffer, offset: number = 0, length?: number) => {
    if (failAfter !== undefined && calls++ >= failAfter) {
      if (code) throw Object.assign(new Error(code), { code });
      return 0;
    }
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    return real(fd, bytes, offset, Math.min(7, length ?? bytes.length - offset));
  }) as typeof fs.writeSync);
}

function settings() {
  const dir = directory();
  const file = path.join(dir, "settings.json");
  const store = new SettingsStore(file);
  store.load();
  store.update({ size: 70 });
  return { dir, file, store };
}

describe("complete settings writes (platform resilience PR2)", () => {
  it("finishes partial writes by byte offset, including multibyte settings, before publishing", () => {
    const { dir, file, store } = settings();
    const write = shortWrites();
    store.update({ privacy: { neverLook: ["秘密🔒café"] }, size: 80 });
    expect(write.mock.calls.length).toBeGreaterThan(1);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(JSON.stringify(store.own(), null, 2) + "\n"));
    expect(new SettingsStore(file).load().settings).toEqual(store.get());
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
  });

  it.each([
    ["zero progress", 0, undefined],
    ["partial then zero progress", 1, undefined],
    ["partial then ENOSPC", 1, "ENOSPC"],
  ] as const)("keeps the old file and memory on %s, reports failure and can retry", (_name, count, code) => {
    const { dir, file, store } = settings();
    const before = fs.readFileSync(file);
    const previous = store.get();
    const changes = vi.fn();
    const problems = vi.fn();
    store.onChange(changes);
    store.onProblem(problems);
    const write = shortWrites(count, code);
    const rename = vi.spyOn(fs, "renameSync");
    const sync = vi.spyOn(fs, "fsyncSync");
    expect(() => store.update({ size: 80 })).toThrow();
    expect(write).toHaveBeenCalledTimes(count + 1);
    expect(rename).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(store.get()).toBe(previous);
    expect(changes).not.toHaveBeenCalled();
    expect(store.lastProblem).toMatch(/couldn't save.*Your change wasn't kept/);
    expect(problems).toHaveBeenCalledWith(store.lastProblem);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
    expect(new SettingsStore(file).load().settings.size).toBe(70);
    write.mockRestore();
    store.update({ size: 80 });
    expect(new SettingsStore(file).load().settings.size).toBe(80);
    expect(store.lastProblem).toBeNull();
  });

  it("keeps a deferred slider change pending after a short write fails, then flushes it successfully", () => {
    vi.useFakeTimers();
    const { file, store } = settings();
    const write = shortWrites(1, "ENOSPC");
    store.update({ size: 80 }, { soon: true });
    vi.advanceTimersByTime(400);
    expect(store.get().size).toBe(80);
    expect(new SettingsStore(file).load().settings.size).toBe(70);
    expect(store.lastProblem).toMatch(/try again with your next change/);
    write.mockRestore();
    store.flush();
    expect(new SettingsStore(file).load().settings.size).toBe(80);
    expect(store.lastProblem).toBeNull();
  });
});

function audit() {
  const dir = directory();
  let now = new Date("2026-10-01T09:00:00Z");
  const log = new AuditLog(dir, () => now);
  log.write({ event: "task", task: "old" });
  now = new Date("2026-10-05T09:00:00Z");
  log.write({ event: "task", task: "秘密🔒café" });
  now = new Date("2026-10-09T09:00:00Z");
  return { dir, log, file: log.file };
}

describe("complete audit retention writes (platform resilience PR2)", () => {
  it("preserves whole retained entries on partial writes", () => {
    const { log, file } = audit();
    shortWrites();
    log.prune(7);
    expect(fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l).task)).toEqual(["秘密🔒café"]);
  });

  it.each([undefined, "ENOSPC"])("preserves the old audit file when writing the replacement stops (%s)", code => {
    const { dir, log, file } = audit();
    const before = fs.readFileSync(file);
    const write = shortWrites(1, code);
    expect(() => log.prune(7)).toThrow(/Couldn't prune/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
    write.mockRestore();
    log.prune(7);
    expect(log.recent().map(e => e.task)).toEqual(["秘密🔒café"]);
  });

  for (const when of ["before", "after"]) {
    it.skipIf(process.platform === "win32" && when === "after")(`copies a concurrent append whole across partial writes ${when} replacement`, () => {
      const { log, file } = audit();
      const line = JSON.stringify({ t: "2026-10-09T09:00:00Z", event: "task", task: "追加🔒" }) + "\n";
      // Keep the source descriptor open across replacement, like a writer that already opened the old file.
      const writer = fs.openSync(file, "a");
      const realWrite = fs.writeSync;
      let appended = false;
      const append = () => { if (!appended) { appended = true; realWrite(writer, line); if (when === "before") fs.closeSync(writer); } };
      if (when === "before") {
        const read = fs.readFileSync;
        vi.spyOn(fs, "readFileSync").mockImplementation(((...args: unknown[]) => {
          const result = (read as (...a: unknown[]) => unknown)(...args);
          append();
          return result;
        }) as typeof fs.readFileSync);
      } else {
        const rename = fs.renameSync;
        vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { rename(from, to); append(); });
      }
      shortWrites();
      try { log.prune(7); } finally { if (when === "after" || !appended) fs.closeSync(writer); }
      vi.restoreAllMocks();
      expect(log.recent().map(e => e.task)).toEqual(["追加🔒", "秘密🔒café"]);
    });
  }
});
