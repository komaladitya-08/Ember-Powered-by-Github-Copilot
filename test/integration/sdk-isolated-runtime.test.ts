// Experiment only: the whole pinned runtime runs in a Linux namespace over a fresh project copy.
// This is not the production coding path and does not establish an authentication or copy-back boundary.
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CopilotClient, RuntimeConnection, type CopilotSession } from "@github/copilot-sdk";
import { createCodingSnapshot, type CodingSnapshot } from "../../app/main/agent/coding-snapshot";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
// @ts-expect-error -- the offline model helper is plain JavaScript
import { startMockLlm } from "../mock-llm/server.mjs";

const BWRAP = "/usr/bin/bwrap";
const baseArgs = ["--unshare-user", "--unshare-pid", "--die-with-parent", "--ro-bind", "/usr", "/usr",
  "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];

it.skipIf(process.platform !== "linux")("runs the whole SDK runtime over an isolated project copy, not the host project", async ctx => {
  // Container hosts and hardened Linux installations may lack bubblewrap or allow no unprivileged namespaces.
  if (!fs.existsSync(BWRAP) || !fs.existsSync("/lib") || !fs.existsSync("/lib64")) { ctx.skip(); return; }
  const probe = spawnSync(BWRAP, [...baseArgs, "--", "/usr/bin/true"], { timeout: 5_000, stdio: "ignore" });
  if (probe.status !== 0) { ctx.skip(); return; }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-sdk-runtime-isolation-"));
  const source = path.join(root, "project"), privateDir = path.join(root, "private"), copies = path.join(root, "copies");
  const state = path.join(root, "state"), privateFile = path.join(privateDir, "vault.txt");
  for (const dir of [source, privateDir, copies, state]) fs.mkdirSync(dir, { mode: 0o700 });
  const privateCanary = "ISOLATED_PRIVATE_CANARY", projectCanary = "ISOLATED_PROJECT_CANARY";
  fs.writeFileSync(privateFile, privateCanary);
  fs.writeFileSync(path.join(source, "readme.txt"), projectCanary);
  const hardlink = path.join(source, "private-alias.txt");
  fs.linkSync(privateFile, hardlink);
  let snapshot: CodingSnapshot | undefined;
  let client: CopilotClient | undefined;
  let session: CopilotSession | undefined;
  let mock: Awaited<ReturnType<typeof startMockLlm>> | undefined;
  try {
    await expect(createCodingSnapshot(source, copies, [privateDir])).rejects.toThrow(/linked|changed/i);
    fs.unlinkSync(hardlink);
    snapshot = await createCodingSnapshot(source, copies, [privateDir]);
    expect(fs.statSync(path.join(snapshot.directory, "readme.txt")).ino).not.toBe(fs.statSync(path.join(source, "readme.txt")).ino);

    mock = await startMockLlm({ delayMs: 0 });
    const { id, exe } = runtimeFor("linux", process.arch);
    const runtime = locateRuntime({ appPath: process.cwd(), runtimeId: id, exe });
    expect(runtime.exists).toBe(true);
    const args = [...baseArgs, "--dir", "/work", "--bind", snapshot.directory, "/work",
      "--dir", "/runtime", "--ro-bind", path.dirname(runtime.path), "/runtime",
      "--dir", "/state", "--bind", state, "/state", "--chdir", "/work", "--", `/runtime/${exe}`];
    // Explicit environment, no token and no host home. Network is deliberately shared only for the loopback mock.
    client = new CopilotClient({ mode: "empty", baseDirectory: "/state", useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ path: BWRAP, args }),
      env: { HOME: "/state", PATH: "/usr/bin:/bin", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" } });
    await client.start();
    session = await client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: mock.baseUrl, apiKey: "test" },
      workingDirectory: "/work", enableConfigDiscovery: false, availableTools: ["builtin:*"],
      onPermissionRequest: () => ({ kind: "approve-once" } as never) });

    await session.sendAndWait({ prompt: `CALLTOOL:view${JSON.stringify({ path: "/work/readme.txt" })}` }, 15_000);
    expect(JSON.stringify(mock.requests)).toContain(projectCanary);
    await session.sendAndWait({ prompt: `CALLTOOL:view${JSON.stringify({ path: privateFile })}` }, 15_000);
    expect(JSON.stringify(mock.requests)).not.toContain(privateCanary);

    // Shell can change the copy, but cannot read either the original project or the host's private directory.
    const command = `if test -e '${privateFile}'; then printf true > /work/shell.txt; else printf false > /work/shell.txt; fi`;
    await session.sendAndWait({ prompt: `CALLTOOL:bash${JSON.stringify({ command })}` }, 15_000);
    expect(fs.readFileSync(path.join(snapshot.directory, "shell.txt"), "utf8")).toBe("false");
    expect(fs.existsSync(path.join(source, "shell.txt"))).toBe(false);
    expect(fs.readFileSync(privateFile, "utf8")).toBe(privateCanary);
  } finally {
    await session?.disconnect().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    await mock?.close().catch(() => undefined);
    await snapshot?.dispose().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
