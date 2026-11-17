/** Modeled negative UID controls; never a claim that a mocked owner qualifies trusted root assets or WSL. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, it } from "vitest";
import { serveWslCodingGuest } from "../../app/main/agent/wsl-coding-guest";
import { WslCodingConnection } from "../../app/main/agent/wsl-coding-connection";

it.each([0, -1, undefined])("independently refuses provisioning for actual uid %s and closes without a workspace", async uid => {
  const prior = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { value: () => uid, configurable: true, writable: true });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const connection = new WslCodingConnection(child as unknown as ChildProcessWithoutNullStreams);
  const serving = serveWslCodingGuest({ stdin: child.stdin, stdout: child.stdout, nodePath: process.execPath });
  void serving.then(() => setImmediate(() => { child.stdout.end(); child.emit("close", 0, null); }), () => child.emit("close", 1, null));
  try {
    expect(await connection.call("hello")).toMatchObject({ uid: uid ?? null, provisioned: false });
    await expect(connection.call("provision", { typescript: "" })).rejects.toThrow("could not be verified");
    await connection.close(); await serving;
  } finally {
    if (prior) Object.defineProperty(process, "getuid", prior); else delete process.getuid;
  }
});
