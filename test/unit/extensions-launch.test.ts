/** A real launcher loses its authority with its lease, without signalling any pid from a persisted file. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { build } from "esbuild";

let dir: string;
let launcher: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-launch-lease-"));
  launcher = path.join(dir, "launch.cjs");
  await build({ entryPoints: ["app/main/extensions/launch.ts"], outfile: launcher, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["koffi"], logLevel: "silent" });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function launch(revoked = false, ignoresStop = false) {
  const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
  if (!revoked) fs.writeFileSync(leaseFile, "", { mode: 0o600 });
  const spec = { command: process.execPath, args: ["-e", `${ignoresStop ? 'process.on("SIGTERM", () => {});' : ""}process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`], env: {}, cwd: dir, runDir: dir, leaseFile, group: os.platform() !== "win32" };
  const child = spawn(process.execPath, [launcher], { env: { ...process.env, NODE_PATH: path.resolve("node_modules"), EMBER_MCP_SPEC: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "pipe"] });
  return { child, leaseFile };
}

describe("extension launch leases", () => {
  it("refuses a server whose lease was removed before the runtime started its launcher", async () => {
    const { child } = launch(true);
    let output = "";
    child.stdout.on("data", data => { output += data; });
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(output).toBe("");
  });

  it.each([false, true])("ends a running server promptly when removed, even if it ignores Stop: %s", async ignoresStop => {
    const { child, leaseFile } = launch(false, ignoresStop);
    const exited = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const start = performance.now();
      fs.rmSync(leaseFile);
      await exited;
      // The kill-switch budget is 300 ms; allow scheduling slack on shared CI machines.
      expect(performance.now() - start).toBeLessThan(1500);
    } finally {
      fs.rmSync(leaseFile, { force: true });
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});
