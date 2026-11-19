/** Real canonical copy/broker over the low-level file model; no native Windows execution claim. */
import { afterEach, expect, it, vi } from "vitest";
import { setupWindowsCodingSealedCopy } from "../fixtures/windows-coding-sealed-copy-fake";

afterEach(() => {
  vi.doUnmock("../../app/main/platform/os"); vi.doUnmock("../../app/main/agent/windows-coding-native");
  vi.restoreAllMocks(); vi.resetModules();
});
async function setup() {
  const f = await setupWindowsCodingSealedCopy();
  f.directory("C:\\project\\Src"); f.put("C:\\project\\Src\\Keep.ts", "ordinary source\n");
  f.directory("C:\\project\\node_modules"); f.put("C:\\project\\node_modules\\hidden.ts", "omitted source\n");
  const copy = await f.create(["node_modules"]), broker = await f.WindowsScopedCodingFiles.create({ copy, signal: copy.signal });
  const close = async () => { await broker.close(); await copy.close(); await f.store.close(); };
  return { ...f, copy, broker, close };
}

it("reports actual existing file and directory identities for Windows case variants", async () => {
  const f = await setup();
  expect(await f.broker.inspect(["/work/APP.TS", "/work/sRC", "/work/SRC/kEEP.TS"])).toEqual([
    { exists: true, real: "/work/app.ts" }, { exists: true, real: "/work/Src", dir: true }, { exists: true, real: "/work/Src/Keep.ts" },
  ]);
  await f.close();
});
it("resolves case-variant cwd and preserves canonical existing prefixes in missing-path facts", async () => {
  const f = await setup();
  expect(await f.broker.inspect(["KEEP.ts", "New/child.ts"], "/work/sRC")).toEqual([
    { exists: true, real: "/work/Src/Keep.ts" }, { exists: false, real: "/work/Src/New/child.ts" },
  ]);
  expect(await f.broker.inspect(["/work/sRc/Absent.ts"])).toEqual([{ exists: false, real: "/work/Src/Absent.ts" }]);
  await f.close();
});
it("never reports a missing child below an existing case-variant file prefix", async () => {
  const f = await setup();
  expect(await f.broker.inspect(["/work/APP.TS/child", "/work/sRC/KEEP.TS/child"])).toEqual([
    { exists: null, real: null }, { exists: null, real: null },
  ]);
  await f.close();
});
it("keeps private and excluded prefixes unknown under every case variant", async () => {
  const f = await setup();
  await f.copy.files(async () => f.copy.withTree(async tree => {
    const handle = tree.api.create(tree.root, "Hidden", "directory"), info = tree.api.info(handle);
    f.nodes.get(info.finalPath.toLowerCase())!.info.attributes |= 2; tree.api.close(handle);
  }));
  expect(await f.broker.inspect(["/work/hIDDEN", "/work/HIDDEN/new.txt", "/work/NODE_MODULES", "/work/Node_Modules/new.txt"])).toEqual([
    { exists: null, real: null }, { exists: null, real: null }, { exists: null, real: null }, { exists: null, real: null },
  ]);
  await f.close();
});
