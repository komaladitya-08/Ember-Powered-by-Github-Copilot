/** Executes the real observer C with test-only declarations; this proves portable fault logic, not Windows ABI or policy. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const canCompile = process.platform === "linux" && spawnSync("cc", ["--version"], { stdio: ["ignore", "pipe", "pipe"] }).status === 0;
describe.skipIf(!canCompile)("actual UV-spawn observer C portable fault logic", () => {
  let directory = "";
  let program = "";
  beforeAll(() => {
    directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "ember-uv-observe-"));
    program = path.join(directory, "observer");
    const fixtures = path.resolve("test/fixtures/windows-uv-spawn-shim");
    try {
      execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", "-D_WIN32_WINNT=0x0602", "-I", fixtures,
        path.join(fixtures, "observe-harness.c"), "-o", program], { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch { throw new Error("The fixed observer fault harness did not compile."); }
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  const cases = [
    "forwards every parameter, mutable output and exact native return without altering the error sentinel",
    "preserves all failure sentinels and the one existing error translation",
    "does not record unarmed native or translation calls",
    "marks same-thread re-entry unknown while retaining bounded observations",
    "saturates its ledger without omitting the underlying real call",
    "refuses a nested arm as an unknown observation",
    "delegates every translation once and retains the first when a second makes attribution unknown",
    "marks disagreement between translated and final spawn results unknown",
    "keeps another thread unarmed without changing its native behavior",
    "uses the exact upstream null and invalid-handle predicates",
    "returns a noncanonical true BOOL unchanged",
    "records a translation before any wrapped API at sequence zero",
    "rejects a translated error followed by an alleged successful spawn",
    "marks an end without an armed observation unknown",
    "detaches the ended snapshot from later unarmed calls",
  ];
  it.each(cases.map((name, index) => ({ name, number: index + 1 })))("$name", ({ number }) => {
    const result = spawnSync(program, [String(number)], { timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(result.error === undefined, "The fixed fault case must return without a spawn error.").toBe(true);
    expect(result.signal === null, "The fixed fault case must return naturally.").toBe(true);
    expect(result.status, "The fixed fault case must satisfy its numeric assertions.").toBe(0);
    expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
  });
  const abiCases = [
    ["exact", "", ""],
    ["ANSI pathname", "CreateNamedPipeA(LPCSTR", "CreateNamedPipeA(LPCWSTR"],
    ["handle width", "HANDLE WINAPI CreateFileA", "DWORD WINAPI CreateFileA"],
    ["overlapped pointer", "ConnectNamedPipe(HANDLE, LPOVERLAPPED)", "ConnectNamedPipe(HANDLE, LPVOID)"],
    ["completion key width", "CreateIoCompletionPort(HANDLE, HANDLE, ULONG_PTR", "CreateIoCompletionPort(HANDLE, HANDLE, DWORD"],
    ["mutable command line", "CreateProcessW(LPCWSTR, LPWSTR", "CreateProcessW(LPCWSTR, LPCWSTR"],
    ["translation result", "int uv_translate_sys_error", "long uv_translate_sys_error"],
  ];
  it.each(abiCases)("the production C11 ABI assertions refuse a mismatched declaration: %s", (name, before, after) => {
    const index = abiCases.findIndex(value => value[0] === name), scratch = path.join(directory, `abi-${index}`);
    mkdirSync(scratch);
    const fixtures = path.resolve("test/fixtures/windows-uv-spawn-shim");
    for (const header of ["windows.h", "uv.h"]) {
      const text = readFileSync(path.join(fixtures, header), "utf8");
      writeFileSync(path.join(scratch, header), before && text.includes(before) ? text.replace(before, after) : text);
    }
    const source = path.join(scratch, "check.c"); writeFileSync(source, '#include "windows-uv-spawn-observe.h"\n');
    const result = spawnSync("cc", ["-std=c11", "-fsyntax-only", "-D_WIN32_WINNT=0x0602", "-I", scratch, "-I", path.resolve("test/fixtures"), source],
      { timeout: 15_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] });
    expect(result.error === undefined && result.signal === null, "The fixed ABI fixture must complete normally.").toBe(true);
    if (name === "exact") expect(result.status, "The exact test declarations must match the production assertions.").toBe(0);
    else {
      expect(result.status === 0, "A mismatched test declaration must be rejected.").toBe(false);
      expect(result.stderr.includes(Buffer.from("The fixed spawn SDK/wrapper ABI changed")), "The production assertion must detect the mismatch.").toBe(true);
    }
  });
});
