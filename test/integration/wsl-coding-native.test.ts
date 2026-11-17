/** Required hosted Windows/WSL2 qualification. Linux/helper mocks never satisfy this gate. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnChild, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, it, onTestFailed } from "vitest";
import { createLogger } from "../../app/main/logger";
import { createWsl } from "../../app/main/wsl/service";
import { connectWslCodingHelper, resolveWslCodingHelperPath } from "../../app/main/agent/wsl-coding-transport";
import { requireWslStoppedReceipt, type WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";
import { decodeWslCodingTree, encodeWslCodingTree } from "../../app/main/agent/wsl-coding-protocol";
import { readWslCodingTypeScriptArchive } from "../../app/main/agent/wsl-coding-archive";

/** Fixed numeric observations of existing qualification operations only; never a connection or Stop receipt.
 * 1facts/2uid/3helper-path/4root-negative/5compile-PE/6PE-path/7positive-interop/8seal-canary/9socket-fixture/
 * 10connect/11archive/12provision/13source-tree/14open/15HOME/16build/17failed-check/18repair/19recheck/
 * 20socket-interop/21canary/22writer-start/23writer-ready/24Stop/25writer-result/26snapshot/27close/28final-canary/
 * 29service-dispose/30owned-root-cleanup. Zero is unmarked; the last marked call is not proof of its cause.
 */
function wslNativeObservation() {
  let stage = 0, captured = false, first: Readonly<{ stage: number; connection: number; closed: number }> | undefined;
  const capture = (connection: unknown, closed: unknown) => {
    if (captured) return; captured = true;
    try { first = Object.freeze({ stage, connection: connection === true ? 1 : 0, closed: closed === true ? 1 : 0 }); }
    catch { /* Do not replace the first snapshot with later cleanup state. */ }
  };
  return {
    update(value: unknown) { if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30) stage = value; },
    capture,
    failure(connection: unknown, closed: unknown, write: (facts: NonNullable<typeof first>) => void) {
      try { capture(connection, closed); if (first) write(first); } catch { /* Preserve the original test failure if observation or output faults. */ }
    },
    value() { return first; },
  };
}

const required = process.env.EMBER_WSL_CODING_NATIVE_TEST === "1";
it.skipIf(!required)("requires real WSL2 child execution, offline TypeScript, PE/interop denial and a drained whole-writer Stop", async () => {
  expect(process.platform).toBe("win32");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-native-proof-"));
  const jobHost = { execPath: process.execPath, script: path.resolve("dist/app/job-host.cjs") };
  const service = createWsl({ env: process.env, jobHost, log: createLogger({ dir: root }), os: "win32", ember: { winPaths: [] } });
  if (!service) throw new Error("The required native Windows WSL service is unavailable.");
  let connection: WslCodingConnection | undefined, closed = false;
  const observation = wslNativeObservation();
  onTestFailed(() => { observation.failure(connection !== undefined, closed, facts => console.info("WSL coding native cached observation", JSON.stringify(facts))); });
  const runProbe = (exe: string, args: string[]) => {
    const found = spawnSync(exe, args, { timeout: 30_000, windowsHide: true, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    if (found.error || found.status !== 0) throw new Error("A required native qualification setup control failed.");
    return found.stdout.trim();
  };
  try {
    observation.update(1); const facts = await service.facts({ refresh: true }), name = process.env.EMBER_WSL_CODING_TEST_DISTRO;
    const selected = facts.distros.find(distro => distro.name === name);
    if (!facts.wslExe || !selected || selected.version !== 2 || selected.needsSetup || selected.tool) throw new Error("The explicitly named qualification WSL2 distro is unavailable.");
    // A qualification setup may explicitly start its dedicated distro; product launch never selects/installs one.
    observation.update(2); const uid = Number(runProbe(facts.wslExe, ["-d", selected.name, "--exec", "/usr/bin/id", "-u"]));
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("The qualification distro requires a real non-root default user.");
    const distro = { ...selected, defaultUid: uid, running: true };
    const input = { wslExe: facts.wslExe, distro, jobHost, env: process.env, current: () => true };
    observation.update(3); const scriptLinuxPath = await resolveWslCodingHelperPath({ ...input, scriptWindowsPath: path.resolve("dist/app/wsl-coding.cjs") });
    // Adversarial setup control: stale non-root discovery must not admit an actually root helper.
    const rootSpawn = ((command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => {
      const at = args.indexOf("--cd"); if (at < 0) throw new Error("The fixed qualification launch changed.");
      return spawnChild(command, [...args.slice(0, at), "-u", "root", ...args.slice(at)], options);
    }) as typeof spawnChild;
    observation.update(4); await expect(connectWslCodingHelper({ ...input, scriptLinuxPath, spawn: rootSpawn })).rejects.toMatchObject({ code: "unavailable" });
    const canary = path.join(root, "windows-canary"), executable = path.join(root, "interop.exe");
    const source = path.join(root, "interop.cs");
    fs.writeFileSync(source, 'using System.IO; class Probe { static void Main(string[] a) { File.WriteAllText(a[0], "escaped"); } }');
    const framework = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    observation.update(5); runProbe(framework, ["/nologo", "/target:exe", `/out:${executable}`, source]);
    observation.update(6); const linuxExe = runProbe(facts.wslExe, ["-d", distro.name, "--exec", "/usr/bin/wslpath", "-a", "-u", executable]);
    // Positive interop control: the identical PE must launch through this WSL distro outside the sandbox.
    observation.update(7); runProbe(facts.wslExe, ["-d", distro.name, "--exec", linuxExe, canary]);
    observation.update(8); expect(fs.readFileSync(canary, "utf8")).toBe("escaped"); fs.writeFileSync(canary, "sealed");
    observation.update(9); const fixture = process.env.EMBER_WSL_CODING_SOCKET_PROBE;
    if (!fixture || !path.isAbsolute(fixture)) throw new Error("The compiled native socket-control fixture is required.");
    observation.update(10); connection = await connectWslCodingHelper({ ...input, scriptLinuxPath });
    observation.update(11); const archive = readWslCodingTypeScriptArchive(path.resolve("dist/wsl-coding-tools/typescript-5.9.3.tgz"));
    observation.update(12); try { await connection.call("provision", { typescript: archive.toString("base64") }); } finally { archive.fill(0); }
    observation.update(13); const binding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() };
    const texts = {
      "package.json": JSON.stringify({ name: "native-wsl-proof", private: true, scripts: { build: "tsc -p tsconfig.json", test: "node --test test.cjs" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", outDir: "dist", strict: true }, include: ["sum.ts"] }),
      "sum.ts": "export const sum=(a:number,b:number):number=>a-b;\n",
      "test.cjs": "const {test}=require('node:test');const a=require('node:assert/strict');test('compiled child',()=>a.equal(require('./dist/sum.js').sum(20,22),42));\n",
      "interop.cjs": `const {spawnSync}=require('node:child_process');const assert=require('node:assert/strict');
for(const env of [{},{WSL_INTEROP:'/run/WSL/1_interop'},{WSL_INTEROP:'/run/WSL/99999_interop',WSL_DISTRO_NAME:'Ubuntu-22.04'}]) {
 const r=spawnSync('./interop.exe',[${JSON.stringify(canary)}],{env:{PATH:'/usr/bin:/bin',...env},timeout:2000});assert.notEqual(r.status,0);
}
const f=require('node:fs');for(const p of ['/mnt/c','/run/WSL','/init','/proc/sys/fs/binfmt_misc/WSLInterop'])assert.equal(f.existsSync(p),false);\n`,
      "writer.cjs": `const f=require('node:fs'),{spawn}=require('node:child_process');
if(process.argv[2]==='child'){f.appendFileSync('child-counter','x');process.stdout.write('child-ready\\n');setInterval(()=>f.appendFileSync('child-counter','x'),10)}
else{const c=spawn(process.execPath,[__filename,'child'],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>{f.appendFileSync('parent-counter','x');process.stdout.write('writers-ready\\n');setInterval(()=>f.appendFileSync('parent-counter','x'),10)})}\n`,
    };
    const tree = { binding, entries: [...Object.entries(texts).map(([name, text]) => ({ path: name, kind: "file" as const, executable: false, bytes: Buffer.from(text) })),
      { path: "interop.exe", kind: "file" as const, executable: true, bytes: fs.readFileSync(executable) },
      { path: "socket-probe", kind: "file" as const, executable: true, bytes: fs.readFileSync(fixture) }] };
    observation.update(14); await connection.call("open", { source: encodeWslCodingTree(tree) });
    const run = (command: string, output?: (bytes: Uint8Array) => void) => connection!.call("run", { command, cwd: "/work", shell: "bash" }, { output: output ?? (() => undefined), timeoutMs: 120_000 });
    observation.update(15); expect(await run("test \"$HOME\" = /tmp && test ~ = /tmp && node -e 'require(\"node:assert/strict\").equal(process.env.HOME,\"/tmp\")'")).toMatchObject({ observed: true, exitCode: 0 });
    observation.update(16); expect(await run("npm run build")).toMatchObject({ observed: true, exitCode: 0 });
    observation.update(17); expect(await run("npm test")).toMatchObject({ observed: true, exitCode: 1 });
    observation.update(18); await connection.call("replaceText", { path: "sum.ts", oldText: "a-b", newText: "a+b" });
    observation.update(19); expect(await run("npm run build && npm test")).toMatchObject({ observed: true, exitCode: 0 });
    observation.update(20); expect(await run("./socket-probe && node interop.cjs")).toMatchObject({ observed: true, exitCode: 0 });
    observation.update(21); expect(fs.readFileSync(canary, "utf8")).toBe("sealed");
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); let seen = "";
    observation.update(22); const running = run("node writer.cjs", bytes => { seen += Buffer.from(bytes).toString(); if (seen.includes("writers-ready\n")) ready(); });
    void running.catch(() => undefined); let timer: ReturnType<typeof setTimeout> | undefined;
    observation.update(23); try { await Promise.race([started, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The native writer control did not start.")), 10_000); })]); }
    finally { clearTimeout(timer); }
    observation.update(24); const receipt = await connection.stop(); requireWslStoppedReceipt(receipt, connection);
    observation.update(25); expect(await running).toMatchObject({ observed: true, stopped: true });
    observation.update(26); const proposed = decodeWslCodingTree(await connection.call("snapshot"));
    for (const name of ["parent-counter", "child-counter"]) expect(proposed.entries.filter(entry => entry.kind === "file").find(entry => entry.path === name)?.bytes.length).toBeGreaterThan(0);
    expect(proposed.entries.filter(entry => entry.kind === "file").find(entry => entry.path === "sum.ts")?.bytes.toString()).toContain("a+b");
    observation.update(27); await connection.close(); closed = true; observation.update(28); expect(fs.readFileSync(canary, "utf8")).toBe("sealed");
  } catch (error) {
    try { observation.capture(connection !== undefined, closed); } catch { /* Preserve the exact thrown error. */ }
    throw error;
  } finally {
    if (!closed && connection) { try { await connection.close(); closed = true; } catch { /* Unknown guest cleanup remains unavailable; no positive native proof. */ } }
    observation.update(29); service.dispose(); if (closed) { observation.update(30); fs.rmSync(root, { recursive: true, force: true }); }
  }
}, 180_000);
