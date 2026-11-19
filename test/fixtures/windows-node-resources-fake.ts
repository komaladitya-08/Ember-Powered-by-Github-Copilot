/** Real resource/folder/workspace issuers over the shared Windows DLL models; no kernel or executable runs. */
import fs from "node:fs";
import path from "node:path";
import win from "node:path/win32";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { TaskSpec } from "../../app/main/agent/worker";
import { setupWindowsNodeWorkspace } from "./windows-node-workspace-fake";

// node:path is the win32 object on Windows; capture before a bind spy can replace that shared property.
const windowsIsAbsolute = win.isAbsolute;
export const NODE_PROJECT = "11111111-1111-4111-8111-111111111111";
export async function setupWindowsNodeResources() {
  const f = await setupWindowsNodeWorkspace(); await f.canonical.store.close();
  const common = "C:\\temporary\\ember-coding", volume = f.canonical.location("C:\\");
  const identifier = (value: string) => (0x100000000n + BigInt(value)).toString(16).padStart(16, "0");
  const originalInfo = f.canonical.api.info, originalList = f.canonical.api.list;
  // The real two native APIs expose the same 16-hex file IDs. Keep this representation change
  // in the DLL fixture, including list records; production identity comparators stay exact.
  f.canonical.api.info = handle => { const info = originalInfo(handle); return { ...info, id: identifier(info.id) }; };
  f.canonical.api.list = (handle, maximum) => originalList(handle, maximum).map(row => ({ ...row, id: identifier(row.id) }));
  for (const folder of ["C:\\temporary", "C:\\data", "C:\\Ember", "C:\\Ember\\resources"]) f.canonical.directory(folder);
  // Each Native module has its own DLL model. Mirror only namespace occupancy into the canonical
  // reader so a retained command/tool tree cannot appear empty to resource cleanup.
  const mirror = (name: string, kind: "file" | "directory", removed: boolean) => {
    if (!name.startsWith(common + "\\")) return;
    const key = f.canonical.location(name).toLowerCase();
    if (removed) f.canonical.nodes.delete(key);
    else if (!f.canonical.nodes.has(key)) {
      if (kind === "directory") f.canonical.directory(name); else f.canonical.put(name, Buffer.alloc(0));
    }
  };
  const oldAfter = f.asset.state.afterCall;
  f.asset.state.afterCall = (name, args, result) => {
    const forwarded = oldAfter ? oldAfter(name, args, result) : result;
    if (forwarded === 0 && ["NtCreateFile", "NtSetInformationFile"].includes(name)) for (const row of f.asset.nodes.values()) mirror(row.name, row.kind, row.removed);
    return forwarded;
  };
  for (const name of ["NtCreateFile", "NtSetInformationFile"]) {
    const original = f.io.source.handlers[name];
    f.io.source.handlers[name] = (...args) => {
      const result = original(...args);
      if (result === 0) for (const row of f.io.source.objects.values()) mirror(row.name, row.kind, row.removed === true);
      return result;
    };
  }
  const state = { owner: "a".repeat(64), project: true, source: true };
  const { ProjectCodingWorkspaces } = await import("../../app/main/agent/project-coding-workspaces"),
    { WindowsProjectCodingResources } = await import("../../app/main/agent/windows-coding-resources");
  const options = { userData: "C:\\data", protectedPaths: ["C:\\data"], resourcesPath: "C:\\Ember\\resources",
    currentOwner: () => state.owner, projectExists: (id: string) => state.project && id === NODE_PROJECT,
    env: {}, execPath: "C:\\Ember\\Ember.exe", isElectron: true, storage: { common, protectedPaths: [common] } };
  const folders = new ProjectCodingWorkspaces(options); Object.assign(options, { folders });
  vi.spyOn(fs.realpathSync, "native").mockImplementation(value => String(value));
  const lstat = fs.lstatSync, metadata = lstat(process.execPath);
  vi.spyOn(fs, "lstatSync").mockImplementation(((value: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
    const name = String(value);
    if (name.startsWith("C:\\Ember\\resources\\coding\\windows-node-x64\\")) {
      const row = f.asset.nodes.get(name); if (!row || row.removed) throw Object.assign(new Error("Synthetic missing packaged member"), { code: "ENOENT" });
      return { ...metadata, size: row.size, nlink: row.links, isFile: () => row.kind === "file", isSymbolicLink: () => !!(row.attributes & 0x400) };
    }
    return lstat(value, options);
  }) as typeof fs.lstatSync);
  const seed = () => {
    for (const row of f.canonical.nodes.values()) if (row.info.kind === "directory") {
      const absolute = "C:\\" + row.info.finalPath.slice(volume.length);
      if (!f.io.source.objects.has(absolute)) f.io.source.add(absolute, "directory");
      if (!f.asset.nodes.has(absolute)) f.asset.add(absolute, "directory");
      for (const native of [f.io.source.objects.get(absolute)!, f.asset.nodes.get(absolute)!]) {
        native.id = BigInt("0x" + identifier(row.info.id)); native.created = BigInt(row.info.created);
      }
    }
  };
  const bind = async (owner: Awaited<ReturnType<typeof WindowsProjectCodingResources.createNode>>) => {
    const selected = await owner.validateSource({ path: "C:\\project", current: () => state.source });
    // Pure path grammar is the Windows boundary here; the actual folder issuer performs every bind/current check.
    const absolute = vi.spyOn(path, "isAbsolute").mockImplementation(windowsIsAbsolute);
    try { folders.bind(NODE_PROJECT, selected, folders.ownerCurrent(NODE_PROJECT)); } finally { absolute.mockRestore(); }
  };
  const spec = (owner: Awaited<ReturnType<typeof WindowsProjectCodingResources.createNode>>): TaskSpec => ({ id: randomUUID(),
    goal: "Repair the copied file and verify it with Node", target: {}, codingWorkspace: owner.workspace(NODE_PROJECT)! });
  return { ...f, common, state, options, folders, seed, bind, spec, WindowsProjectCodingResources,
    open: async (node = true) => {
      const owner = await (node ? WindowsProjectCodingResources.createNode(options) : WindowsProjectCodingResources.create(options)); seed(); return owner;
    } };
}
