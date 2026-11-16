/** Fresh protected NTFS storage for the trusted SDK only. SDK descendants are audited/deleted only after SDK exit. */
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import type { PrivateControllerPaths, PrivateControllerStorage } from "./private-controller-storage";
import { ScopedCodingFileError } from "./coding-platform";
import { loadWindowsCodingNative, retireWindowsCodingNative, type WindowsCodingNative, type WindowsCodingHandle, type WindowsCodingInfo, type WindowsCodingPin } from "./windows-coding-native";
import { loadWindowsControllerNative, type WindowsControllerNative, type WindowsControllerObject } from "./windows-controller-native";
import { windowsCodingFold, windowsCodingSame, windowsCodingYield } from "./windows-coding-policy";

const roles = ["cwd", "home", "state", "tmp"] as const;
/** Earlier SDK/storage ownership cannot be proved retired; callers must preserve their task disposal barrier. */
export class WindowsControllerStorageCleanupError extends Error {
  readonly code = "windows-controller-storage-unverified";
  constructor() { super("A previous coding controller has not been verified as stopped."); this.name = "WindowsControllerStorageCleanupError"; }
}
const unavailable = () => new Error("The private coding controller folder is unavailable.");
const unverified = () => new WindowsControllerStorageCleanupError();
const active = new Map<string, Map<string, WindowsCodingInfo>>();
const uncertain = new Set<string>();
const uncertaintyKey = (parent: string, name: string) => `${parent}\0${name}`;
let allocating: Promise<void> = Promise.resolve();
interface Owned { handle: WindowsCodingHandle; info: WindowsCodingInfo }

class WindowsControllerStorage implements PrivateControllerStorage {
  readonly paths: PrivateControllerPaths;
  #api: WindowsCodingNative; #security: WindowsControllerNative; #root: Owned; #common: Owned;
  #pins: WindowsCodingPin[]; #commonCreated: WindowsCodingHandle | undefined; #fixed: Map<string, Owned>;
  #parentKey: string; #name: string; #closing: Promise<void> | null = null; #closed = false;
  constructor(api: WindowsCodingNative, security: WindowsControllerNative, root: Owned, common: Owned, pins: WindowsCodingPin[], commonCreated: WindowsCodingHandle | undefined,
    fixed: Map<string, Owned>, parentKey: string, name: string, logical: string) {
    this.#api = api; this.#security = security; this.#root = root; this.#common = common; this.#pins = pins; this.#commonCreated = commonCreated;
    this.#fixed = fixed; this.#parentKey = parentKey; this.#name = name;
    this.paths = Object.freeze({ root: logical, cwd: path.join(logical, "cwd"), home: path.join(logical, "home"), state: path.join(logical, "state"), temporary: path.join(logical, "tmp") });
  }
  verify(): void {
    if (this.#closed) throw unavailable();
    if (!windowsCodingSame(this.#common.info, this.#api.info(this.#common.handle), false)) throw unavailable();
    this.#security.assertFixed(this.#api.info(this.#common.handle));
    for (const owned of [this.#root, ...this.#fixed.values()]) {
      this.#api.assertPrivate(owned.handle);
      if (!windowsCodingSame(owned.info, this.#api.info(owned.handle), false)) throw unavailable();
    }
    const parent = this.#api.list(this.#common.handle, 10_000).find(entry => entry.name === this.#name);
    if (!parent || parent.id !== this.#root.info.id) throw unavailable();
    const children = this.#api.list(this.#root.handle, 10_000);
    for (const [name, owned] of this.#fixed) if (children.find(entry => entry.name === name)?.id !== owned.info.id) throw unavailable();
  }
  retire(): void { if (!this.#closed) uncertain.add(uncertaintyKey(this.#parentKey, this.#name)); }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.retire();
    this.#closing = Promise.resolve().then(() => this.#dispose());
    return this.#closing;
  }
  async #dispose(): Promise<void> {
    this.verify();
    const api = this.#api, boundary = this.#security.boundary(api, this.#root.handle), opened = new Set<WindowsCodingHandle>();
    const objects: { object: WindowsControllerObject; handle: WindowsCodingHandle; fixed?: string }[] = [];
    const names = new Set<string>(), ids = new Set<string>(); let count = 0, bytes = 0, problem: unknown;
    const walk = async (parent: WindowsCodingHandle, prefix: string, depth: number): Promise<void> => {
      if (depth > 64) throw unavailable();
      const before = api.info(parent);
      for (const listed of api.list(parent, 10_000 - count)) {
        if (++count > 10_000 || (bytes += listed.size) > 128 * 1024 * 1024) throw unavailable();
        const relative = prefix ? `${prefix}/${listed.name}` : listed.name, alias = windowsCodingFold(relative);
        if (names.has(alias)) throw unavailable(); names.add(alias);
        const known = !prefix ? this.#fixed.get(listed.name) : undefined;
        let handle: WindowsCodingHandle;
        if (known) handle = known.handle;
        else { handle = api.open(parent, listed.name, listed.attributes & 0x10 ? "directory" : "file", "copy"); opened.add(handle); }
        const info = api.info(handle);
        if (info.id !== listed.id || ids.has(info.id) || known && !windowsCodingSame(known.info, info, false)) throw unavailable(); ids.add(info.id);
        if (known) api.assertPrivate(handle);
        const object = boundary.claim(handle, parent); objects.push({ object, handle, ...(known ? { fixed: listed.name } : {}) });
        if (info.kind === "directory") await walk(handle, relative, depth + 1);
        if (count % 16 === 0) await windowsCodingYield();
      }
      if (!windowsCodingSame(before, api.info(parent))) throw unavailable();
    };
    try {
      await walk(this.#root.handle, "", 0); this.verify();
      // Audit every object before the first deletion. Removal retains exact held identities through native cleanup.
      for (const owned of objects.slice().reverse()) {
        owned.object.remove(); api.close(owned.handle); opened.delete(owned.handle);
        if (owned.fixed !== undefined) this.#fixed.delete(owned.fixed);
      }
    } catch (error) { problem = error; }
    let closeFailed = false;
    for (const handle of [...opened].reverse()) { try { api.close(handle); } catch { closeFailed = true; } }
    if (closeFailed) throw retireWindowsCodingNative();
    if (problem) throw problem;
    if (this.#fixed.size) throw unavailable();
    api.remove(this.#root.handle); api.close(this.#root.handle);
    if (this.#commonCreated !== undefined) api.close(this.#commonCreated);
    for (const pin of this.#pins.slice().reverse()) for (const handle of pin.handles.slice().reverse()) api.close(handle);
    active.get(this.#parentKey)?.delete(this.#name); uncertain.delete(uncertaintyKey(this.#parentKey, this.#name)); this.#closed = true;
  }
}

/** Existing storage is adopted only after exact ACL and active/empty namespace checks; no ACL is changed. */
export async function allocateWindowsControllerStorage(userData: string, signal?: AbortSignal): Promise<PrivateControllerStorage> {
  const security = loadWindowsControllerNative(); // Captures this process token's real user/default owner before allocation.
  const api = loadWindowsCodingNative();
  const previous = allocating; let release!: () => void;
  allocating = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const pins: WindowsCodingPin[] = [], fixed = new Map<string, Owned>();
  let commonCreated: WindowsCodingHandle | undefined, root: Owned | undefined, storage: WindowsControllerStorage | undefined;
  let parentKey: string | undefined, name: string | undefined;
  try {
    signal?.throwIfAborted();
    if (api.ownerSid !== security.ownerSid) throw unavailable();
    const user = api.pin(userData, "base"); pins.push(user);
    let common: Owned;
    try {
      commonCreated = api.create(user.handle, "coding-controllers", "directory");
      common = { handle: commonCreated, info: api.info(commonCreated) };
    } catch (error) {
      if (commonCreated !== undefined || !(error instanceof ScopedCodingFileError) || error.code !== "exists") throw error;
      const pin = api.pin(path.join(userData, "coding-controllers"), "base"); pins.push(pin);
      common = { handle: pin.handle, info: api.info(pin.handle) };
    }
    parentKey = windowsCodingFold(common.info.finalPath);
    const live = active.get(parentKey) ?? new Map<string, WindowsCodingInfo>(), entries = api.list(common.handle, 10_000);
    if ([...uncertain].some(value => value.startsWith(parentKey + "\0")) || entries.some(entry => !live.has(entry.name)) || [...live.keys()].some(value => !entries.some(entry => entry.name === value))) throw unverified();
    security.assertFixed(common.info);
    for (const entry of entries) {
      const expected = live.get(entry.name)!;
      if (entry.id !== expected.id) throw unverified();
      const pin = api.pin(path.join(userData, "coding-controllers", entry.name), "read");
      try { const info = api.info(pin.handle); security.assertFixed(info); if (!windowsCodingSame(expected, info, false)) throw unverified(); }
      finally { for (const handle of pin.handles.slice().reverse()) api.close(handle); }
    }
    signal?.throwIfAborted(); name = `controller-${randomUUID()}`;
    const handle = api.create(common.handle, name, "directory");
    // Track the newly created handle before its next metadata query.
    root = { handle, info: common.info };
    root.info = api.info(handle); live.set(name, { ...root.info }); active.set(parentKey, live);
    for (const role of roles) {
      const child = api.create(handle, role, "directory"), owned: Owned = { handle: child, info: root.info }; fixed.set(role, owned);
      owned.info = api.info(child);
    }
    storage = new WindowsControllerStorage(api, security, root, common, pins, commonCreated, fixed, parentKey, name, path.join(userData, "coding-controllers", name));
    storage.verify(); signal?.throwIfAborted(); return storage;
  } catch (error) {
    if (parentKey && name && root) uncertain.add(uncertaintyKey(parentKey, name));
    if (storage) { try { await storage.close(); } catch { throw retireWindowsCodingNative(); } }
    else {
      let failed = false;
      for (const child of [...fixed.values()].reverse()) { try { api.remove(child.handle); api.close(child.handle); } catch { failed = true; } }
      if (root) { try { api.remove(root.handle); api.close(root.handle); } catch { failed = true; } }
      if (commonCreated !== undefined) { try { api.close(commonCreated); } catch { failed = true; } }
      for (const pin of pins.slice().reverse()) for (const handle of pin.handles.slice().reverse()) { try { api.close(handle); } catch { failed = true; } }
      if (failed) throw retireWindowsCodingNative();
      if (parentKey && name) { active.get(parentKey)?.delete(name); uncertain.delete(uncertaintyKey(parentKey, name)); }
    }
    throw error;
  } finally { release(); }
}
