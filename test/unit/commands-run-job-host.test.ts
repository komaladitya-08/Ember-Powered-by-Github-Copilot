import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SpawnOptions } from "node:child_process";
import { isJobHostProcess, JOB_FAILED, parseJobHostArgs, runJobHost, type JobChild, type JobHostDeps } from "../../app/main/commands/run/job-host";
import {
  bindJobApi, EXTENDED_LIMIT_INFORMATION_SIZE, JOB_FUNCTIONS, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  jobHostArgv, killOnCloseInfo, type JobApi,
} from "../../app/main/commands/run/win32-job";

const REF = { execPath: "C:\\Program Files\\Ember\\Ember.exe", script: "C:\\Program Files\\Ember\\resources\\app\\dist\\app\\job-host.cjs" };
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("the job host's argv", () => {
  it("is Ember's binary on job-host.cjs, the mode, --, then the program and its arguments (§3.3)", () => {
    expect(jobHostArgv(REF, PS, ["-NoLogo", "-Command", "x"], false)).toEqual([REF.execPath, REF.script, "--batch", "--", PS, "-NoLogo", "-Command", "x"]);
    expect(jobHostArgv(REF, "C:\\Windows\\System32\\wsl.exe", ["-d", "Ubuntu"], true)).toEqual([REF.execPath, REF.script, "--interactive", "--", "C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu"]);
  });

  it("runs as a program only when started on job-host.cjs, never inside another bundle that took the module in", () => {
    expect(isJobHostProcess({ isMain: true, script: REF.script })).toBe(true);
    expect(isJobHostProcess({ isMain: true, script: "/opt/Ember/resources/app/dist/app/job-host.cjs" })).toBe(true);
    expect(isJobHostProcess({ isMain: true, script: "C:\\Program Files\\Ember\\resources\\app\\dist\\app\\main.cjs" })).toBe(false);
    expect(isJobHostProcess({ isMain: true, script: "C:\\x\\not-job-host.cjs.js" })).toBe(false);
    expect(isJobHostProcess({ isMain: true, script: undefined })).toBe(false);
    expect(isJobHostProcess({ isMain: false, script: REF.script })).toBe(false);
  });

  it("parses back what jobHostArgv wrote and nothing else", () => {
    expect(parseJobHostArgs(jobHostArgv(REF, PS, ["-a", "--", "b"], true).slice(2))).toEqual({ interactive: true, program: PS, args: ["-a", "--", "b"] });
    expect(parseJobHostArgs(["--batch", "--", PS])).toEqual({ interactive: false, program: PS, args: [] });
    for (const bad of [[], ["--batch"], ["--batch", PS], ["--detach", "--", PS], ["--interactive", "--"]]) expect(parseJobHostArgs(bad)).toBeNull();
  });
});

/** A fake job API that records the order of every call. */
function fakeApi(fail: { create?: boolean; assign?: boolean } = {}): JobApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    createKillOnCloseJob: () => {
      calls.push("create");
      if (fail.create) throw new Error("CreateJobObjectW failed (error 5)");
      return "job-1";
    },
    assignSelf: job => {
      calls.push(`assign ${String(job)}`);
      if (fail.assign) throw new Error("AssignProcessToJobObject failed (error 5)");
    },
    terminate: (job, code) => {
      calls.push(`terminate ${String(job)} ${code}`);
      return true;
    },
  };
}

function host(api: JobApi | null, o: { spawnThrows?: boolean } = {}) {
  const calls = api && "calls" in api ? (api as { calls: string[] }).calls : [];
  const stdin = new EventEmitter() as EventEmitter & { resume(): void; resumed: boolean };
  stdin.resumed = false;
  stdin.resume = () => { stdin.resumed = true; };
  const events = new EventEmitter();
  const childIn: Buffer[] = [];
  const child: JobChild & { emit: EventEmitter["emit"] } = {
    stdin: { write: (b: Uint8Array) => childIn.push(Buffer.from(b)), on: () => undefined },
    on: (e: string, fn: (...a: never[]) => void) => events.on(e, fn as (...a: unknown[]) => void),
    emit: events.emit.bind(events),
  } as JobChild & { emit: EventEmitter["emit"] };
  const spawned: { program: string; args: string[]; options: SpawnOptions }[] = [];
  const exits: number[] = [];
  let stderr = "";
  const deps: JobHostDeps = {
    job: () => api,
    spawn: (program, args, options) => {
      calls.push(`spawn ${program}`);
      if (o.spawnThrows) throw new Error("EINVAL");
      spawned.push({ program, args, options });
      return child;
    },
    stdin,
    stderr: { write: t => { stderr += t; } },
    exit: code => { exits.push(code); },
    env: { Path: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1", Electron_Run_As_Node: "1", EMBER_CMD: "Write-Output hi", EMBER_RUN_ID: "0123456789abcdef" },
  };
  return { deps, calls, stdin, child, childIn, spawned, exits, stderr: () => stderr };
}

describe("the job host", () => {
  it("makes its kill-on-close job and joins it before it starts anything (critique integration-9)", () => {
    const api = fakeApi();
    const h = host(api);
    runJobHost(["--batch", "--", PS, "-NoProfile"], h.deps);
    expect(api.calls).toEqual(["create", "assign job-1", `spawn ${PS}`]);
    expect(h.spawned[0].args).toEqual(["-NoProfile"]);
    expect(h.spawned[0].options).toMatchObject({ windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    expect(h.stdin.resumed).toBe(true);
  });

  it("gives the program the environment without its own node-mode switch", () => {
    const h = host(fakeApi());
    runJobHost(["--batch", "--", PS], h.deps);
    expect(h.spawned[0].options.env).toEqual({ Path: "C:\\Windows", EMBER_CMD: "Write-Output hi", EMBER_RUN_ID: "0123456789abcdef" });
  });

  it("exits with the program's code", () => {
    const h = host(fakeApi());
    runJobHost(["--batch", "--", PS], h.deps);
    h.child.emit("exit", 3, null);
    expect(h.exits).toEqual([3]);
    const big = host(fakeApi());
    runJobHost(["--batch", "--", PS], big.deps);
    big.child.emit("exit", 0xc000013a, null);
    expect(big.exits).toEqual([0xc000013a]);
    const killed = host(fakeApi());
    runJobHost(["--batch", "--", PS], killed.deps);
    killed.child.emit("exit", null, "SIGTERM");
    expect(killed.exits).toEqual([1]);
  });

  it("ends the whole job when its own stdin ends (Ember quit, crashed or stopped the run)", () => {
    for (const event of ["end", "close", "error"]) {
      const api = fakeApi();
      const h = host(api);
      runJobHost(["--batch", "--", PS], h.deps);
      h.stdin.emit(event, new Error("EPIPE"));
      expect(api.calls.slice(-1)).toEqual(["terminate job-1 1"]);
      expect(h.exits).toEqual([1]);
      // Once only, and nothing after the program's own exit.
      h.stdin.emit("close");
      h.child.emit("exit", 0, null);
      expect(api.calls.filter(c => c.startsWith("terminate"))).toHaveLength(1);
      expect(h.exits).toEqual([1]);
    }
  });

  it("relays its stdin to the program only when interactive (Ctrl+C and typing for WSL's script)", () => {
    const h = host(fakeApi());
    runJobHost(["--interactive", "--", "C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu"], h.deps);
    expect(h.spawned[0].options.stdio).toEqual(["pipe", "inherit", "inherit"]);
    h.stdin.emit("data", Buffer.from("\x03"));
    h.stdin.emit("data", Buffer.from("typed\r"));
    expect(Buffer.concat(h.childIn).toString()).toBe("\x03typed\r");
    const batch = host(fakeApi());
    runJobHost(["--batch", "--", PS], batch.deps);
    batch.stdin.emit("data", Buffer.from("ignored"));
    expect(batch.childIn).toEqual([]);
  });

  it("exits 125 with job: on stderr and starts nothing when the job can't be made or joined", () => {
    for (const api of [fakeApi({ create: true }), fakeApi({ assign: true }), null]) {
      const h = host(api);
      runJobHost(["--batch", "--", PS], h.deps);
      expect(h.exits).toEqual([JOB_FAILED]);
      expect(h.stderr()).toMatch(/^job: /);
      expect(h.spawned).toEqual([]);
    }
    expect(JOB_FAILED).toBe(125);
    const unloadable = host(null);
    unloadable.deps.job = () => { throw new Error("Failed to load shared library"); };
    runJobHost(["--batch", "--", PS], unloadable.deps);
    expect(unloadable.stderr()).toBe("job: job objects aren't available here (Failed to load shared library)\n");
  });

  it("exits 125 with job: when the program can't start, or its arguments aren't its own", () => {
    const thrown = host(fakeApi(), { spawnThrows: true });
    runJobHost(["--batch", "--", PS], thrown.deps);
    expect(thrown.exits).toEqual([125]);
    expect(thrown.stderr()).toMatch(/^job: can't start/);
    const missing = host(fakeApi());
    runJobHost(["--batch", "--", "C:\\nope.exe"], missing.deps);
    missing.child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    expect(missing.exits).toEqual([125]);
    expect(missing.stderr()).toBe("job: can't start C:\\nope.exe: ENOENT\n");
    const bad = host(fakeApi());
    runJobHost(["--now", PS], bad.deps);
    expect(bad.exits).toEqual([125]);
    expect(bad.calls).toEqual([]);
  });
});

describe("the job object's koffi bindings", () => {
  /** A fake kernel32 recording each bound function's calls. */
  function kernel32(results: Partial<Record<string, unknown>> = {}) {
    const calls: [string, unknown[]][] = [];
    const bound: string[] = [];
    const libraries: string[] = [];
    const load = (library: string) => {
      libraries.push(library);
      return {
        func: (declaration: string) => {
          const name = /(\w+)\s*\(/.exec(declaration)?.[1] ?? "";
          bound.push(name);
          return (...args: unknown[]) => {
            calls.push([name, args]);
            const defaults: Record<string, unknown> = { CreateJobObjectW: { job: 1 }, SetInformationJobObject: 1, AssignProcessToJobObject: 1, GetCurrentProcess: { process: -1 }, TerminateJobObject: 1, GetLastError: 5 };
            return name in results ? results[name] : defaults[name];
          };
        },
      };
    };
    return { load, calls, bound, libraries };
  }

  it("binds the five job calls (and GetLastError) from kernel32 once, in a 64-bit process", () => {
    const k = kernel32();
    bindJobApi({ sizeof: () => 8 }, k.load);
    expect(k.libraries).toEqual(["kernel32.dll"]);
    expect(k.bound).toEqual(["CreateJobObjectW", "SetInformationJobObject", "AssignProcessToJobObject", "GetCurrentProcess", "TerminateJobObject", "GetLastError"]);
    expect(JOB_FUNCTIONS.every(d => d.includes("__stdcall"))).toBe(true);
    expect(() => bindJobApi({ sizeof: () => 4 }, k.load)).toThrow(/64-bit/);
  });

  it("creates the job with only KILL_ON_JOB_CLOSE set in JOBOBJECT_EXTENDED_LIMIT_INFORMATION", () => {
    const k = kernel32();
    const api = bindJobApi({ sizeof: () => 8 }, k.load);
    const job = api.createKillOnCloseJob();
    expect(job).toEqual({ job: 1 });
    expect(k.calls[0]).toEqual(["CreateJobObjectW", [null, null]]);
    const [name, [handle, infoClass, info, size]] = k.calls[1] as [string, [unknown, number, Buffer, number]];
    expect([name, handle, infoClass, size]).toEqual(["SetInformationJobObject", { job: 1 }, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, EXTENDED_LIMIT_INFORMATION_SIZE]);
    expect(info.length).toBe(144);
    expect(info.readUInt32LE(16)).toBe(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    expect(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000);
    expect([...info].filter(b => b !== 0)).toEqual([0x20]);
    expect(killOnCloseInfo()).toEqual(info);
  });

  it("assigns the current process itself, terminates by job, and says why a call failed", () => {
    const k = kernel32();
    const api = bindJobApi({ sizeof: () => 8 }, k.load);
    api.assignSelf({ job: 1 });
    expect(k.calls.map(c => c[0])).toEqual(["GetCurrentProcess", "AssignProcessToJobObject"]);
    expect(k.calls[1][1]).toEqual([{ job: 1 }, { process: -1 }]);
    expect(api.terminate({ job: 1 }, 1)).toBe(true);
    expect(k.calls[2]).toEqual(["TerminateJobObject", [{ job: 1 }, 1]]);

    expect(() => bindJobApi({ sizeof: () => 8 }, kernel32({ CreateJobObjectW: null }).load).createKillOnCloseJob()).toThrow("CreateJobObjectW failed (error 5)");
    expect(() => bindJobApi({ sizeof: () => 8 }, kernel32({ SetInformationJobObject: 0 }).load).createKillOnCloseJob()).toThrow("SetInformationJobObject failed (error 5)");
    expect(() => bindJobApi({ sizeof: () => 8 }, kernel32({ AssignProcessToJobObject: 0 }).load).assignSelf({})).toThrow("AssignProcessToJobObject failed");
    expect(bindJobApi({ sizeof: () => 8 }, kernel32({ TerminateJobObject: 0 }).load).terminate({}, 1)).toBe(false);
  });
});

describe("the runner's modules", () => {
  it("load koffi only lazily and never import electron (a macOS remote ships no koffi)", () => {
    const dir = fileURLToPath(new URL("../../app/main/commands/run/", import.meta.url));
    for (const file of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
      const source = readFileSync(`${dir}${file}`, "utf8");
      expect(source, file).not.toMatch(/^\s*import\s[^;]*["']koffi["']/m);
      expect(source, file).not.toMatch(/from\s+["']electron["']/);
      // Only inside a function, as loadJobApi does: never at the top level.
      for (const line of source.split("\n").filter(l => /\(\s*["']koffi["']\s*\)/.test(l))) expect(line, file).toMatch(/^\s{4,}/);
    }
  });
});
