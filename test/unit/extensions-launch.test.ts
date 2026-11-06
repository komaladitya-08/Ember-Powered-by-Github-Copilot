/** A real launcher loses its authority with its lease, without signalling any pid from a persisted file. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { build } from "esbuild";
import { appEnv } from "../../app/main/hands/system";

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

describe("extension launch environment (BE audit #1)", () => {
  it("starts the server with only the spec's environment, even when the runtime gives the launcher its whole one, token included", async () => {
    const marks = { COPILOT_SDK_AUTH_TOKEN: "ghu_TESTMARKER_LAUNCH_SDK_0123456789", GITHUB_TOKEN: "ghp_TESTMARKER_LAUNCH_GH_0123456789", GH_ENTERPRISE_TOKEN: "ghe_TESTMARKER_LAUNCH_ENT_0123456789", MY_SERVICE_KEY: "ghu_TESTMARKER_LAUNCH_ODD_0123456789" };
    const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
    fs.writeFileSync(leaseFile, "", { mode: 0o600 });
    const out = path.join(dir, "server-env.json");
    // The spec's environment is built as the extensions service builds it: appEnv() over Ember's (here marker-filled) environment.
    const spec = {
      command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv, env: process.env }))`],
      env: { ...appEnv({ ...process.env, ...marks }, { session: false }) as Record<string, string>, ELECTRON_RUN_AS_NODE: "1" },
      cwd: dir, runDir: dir, leaseFile, group: os.platform() !== "win32",
    };
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, ...marks, NODE_PATH: path.resolve("node_modules"), EMBER_MCP_SPEC: JSON.stringify(spec) }, stdio: "ignore" });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    const server = fs.readFileSync(out, "utf8");
    for (const v of Object.values(marks)) expect(server).not.toContain(v);
    for (const k of Object.keys(marks)) expect(Object.keys((JSON.parse(server) as { env: object }).env)).not.toContain(k);
  });
});
