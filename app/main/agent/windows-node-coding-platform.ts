/** Opt-in adapter only. The product Windows selector remains files-only. */
import type { PathFact, RunnerFacts } from "../commands/types";
import { ScopedCodingFileError, type CodingFileBroker, type CodingPlatformAdapter, type CodingCommandWorkspace, type CodingReviewWorkspace } from "./coding-platform";
import { windowsCodingRelative } from "./windows-coding-policy";
import { WindowsNodeWorkspace } from "./windows-node-workspace";

export const WINDOWS_NODE_CODING_CONSTRAINTS = "Only bundled Node is supplied. Use run_node with literal argv and /work as cwd. /work names the folder in Ember's tools; use relative script and file paths in argv. No shell, npm or dependencies are supplied. Package installation, network access and child processes are unavailable. Supply --preserve-symlinks and --preserve-symlinks-main explicitly; with --test, also supply --experimental-test-isolation=none. No flags are added automatically.";
const nodeAvailable = Object.getOwnPropertyDescriptor(WindowsNodeWorkspace.prototype, "nodeAvailable")!.get!;
const filesBroker = WindowsNodeWorkspace.prototype.filesBroker;
const unknown = (): PathFact => ({ exists: null, real: null });

function requireWorkspace(value: unknown): WindowsNodeWorkspace {
  try { if (value instanceof WindowsNodeWorkspace && nodeAvailable.call(value) === true) return value; } catch { /* Prototype/Proxy claims carry no private brand. */ }
  throw new ScopedCodingFileError("boundary");
}
/** Logical paths only: drive, UNC, device and escaping forms never reach the file broker. */
function logical(value: string, cwd = "/work"): string | null {
  if (typeof value !== "string" || !value) return null;
  const slash = value.replace(/\\/g, "/");
  if (slash.startsWith("//") || slash.includes(":")) return null;
  const candidate = slash.startsWith("/") ? slash.replace(/^\/work(?=\/|$)/i, "/work") : `${cwd}/${slash}`;
  try { const relative = windowsCodingRelative(candidate); return relative ? `/work/${relative}` : "/work"; } catch { return null; }
}
function policyFact(value: PathFact): PathFact {
  if (!value || ![true, false, null].includes(value.exists) || typeof value.real !== "string" ||
      !(value.real === "/work" || value.real.startsWith("/work/"))) return unknown();
  const real = logical(value.real);
  return real === null ? unknown() : { exists: value.exists, real: real.replace(/\//g, "\\"), ...(value.dir === true ? { dir: true } : {}) };
}
function wrapFiles(broker: CodingFileBroker): CodingFileBroker {
  const inspect = broker.inspect.bind(broker);
  const mappedInspect = async (paths: readonly string[], cwd = "/work"): Promise<PathFact[]> => {
    if (!Array.isArray(paths) || paths.length > 200) throw new ScopedCodingFileError("limit");
    const captured = [...paths], folder = logical(cwd), result = captured.map(unknown);
    if (folder === null) return result;
    const queries: string[] = [], positions: number[] = [];
    for (let index = 0; index < captured.length; index++) {
      const path = logical(captured[index], folder); if (path !== null) { queries.push(path); positions.push(index); }
    }
    if (!queries.length) return result;
    const facts = await inspect(queries, folder);
    if (!Array.isArray(facts) || facts.length !== queries.length) return result;
    for (let index = 0; index < facts.length; index++) result[positions[index]] = policyFact(facts[index]);
    return result;
  };
  return new Proxy(broker, { get(target, key) {
    if (key === "inspect") return mappedInspect;
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

export const windowsNodeCodingPlatform: CodingPlatformAdapter = Object.freeze({
  facts(workspace: CodingCommandWorkspace, hostFacts: RunnerFacts): RunnerFacts {
    requireWorkspace(workspace);
    return { os: "win32", shells: [], shellPaths: {}, script: null, home: "/work", user: "", privileged: hostFacts.privileged,
      pty: false, ember: structuredClone(hostFacts.ember), extraPath: [] };
  },
  async files(workspace: CodingReviewWorkspace, signal: AbortSignal): Promise<CodingFileBroker> {
    const owner = requireWorkspace(workspace);
    return wrapFiles(await filesBroker.call(owner, signal));
  },
});
