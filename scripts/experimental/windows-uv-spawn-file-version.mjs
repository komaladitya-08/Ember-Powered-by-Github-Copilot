/** One fixed isolated Python VERSION-reader invocation; only admitted numeric strings or privately branded closed failures leave this module. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { classifyOwnedPowerShellResult as classifyOwnedProcessResult } from "./windows-uv-spawn-powershell.mjs";

const script = fileURLToPath(new URL("./windows-uv-spawn-file-version.py", import.meta.url));
const trustedPython = "C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe";
const failures = new WeakMap();
const object = value => value !== null && (typeof value === "object" || typeof value === "function");
const unknown = Object.freeze({ schema: 1, outcome: 0, status: null, signal: 255, errorPresence: 2, errorCode: 0 });
const numeric = value => typeof value === "string" && /^[0-9]{1,6}(?:\.[0-9]{1,6}){2,3}$/.exec(value)?.[0] === value;
const strict = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ordinary = value => typeof value === "string" && /^[A-Za-z]:\\/.test(value) && !/[^\x20-\x7e]|[%!^&|<>";]/.test(value) && !value.slice(2).includes(":") &&
  path.win32.normalize(value) === value && value.slice(3).split("\\").every(part => part !== "." && part !== ".." && !/[. ]$/.test(part));

function refuse(process = unknown, stage = 0) {
  const error = new Error("The fixed VERSION reader was refused.");
  failures.set(error, Object.freeze({ schema: 1, stage, process }));
  throw error;
}

/** Foreign exceptions, including proxies and accessors, supply no diagnostic facts. */
export function classifyWindowsUvSpawnFileVersionFailure(error) { return object(error) ? failures.get(error) : undefined; }

/** The reader and fixture are recipe-bound. Caller tools must be the same fingerprinted cl/link pair; no override, retry or PowerShell fallback exists. */
export function readWindowsUvSpawnFileVersions(pythonPath, compiler, linker, env, cwd) {
  if (!ordinary(pythonPath) || pythonPath.toLowerCase() !== trustedPython.toLowerCase() || !ordinary(compiler) || !ordinary(linker) ||
      path.win32.basename(compiler).toLowerCase() !== "cl.exe" || path.win32.basename(linker).toLowerCase() !== "link.exe" ||
      path.win32.dirname(compiler).toLowerCase() !== path.win32.dirname(linker).toLowerCase() || !ordinary(cwd)) refuse();
  let result;
  try {
    result = spawnSync(pythonPath, ["-I", "-B", script, "--compiler", compiler, "--linker", linker],
      { env, cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch { refuse(); }
  // This existing classifier reads only own-data status/signal/error/code (and success stdout), never error text or stderr.
  const process = classifyOwnedProcessResult(result);
  if (process.signal !== 0 || process.errorPresence !== 0 || ![0, 1].includes(process.status) || ![1, 2].includes(process.outcome)) refuse(process);
  let body, value;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, "stdout");
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string" || descriptor.value.length > 512 ||
        Buffer.byteLength(descriptor.value, "utf8") > 512 || [...descriptor.value].some(character => {
          const code = character.charCodeAt(0); return code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126);
        })) refuse(process);
    body = descriptor.value.trim(); value = JSON.parse(body);
    if (JSON.stringify(value) !== body) refuse(process);
  } catch { refuse(process); }
  if (process.status === 1) {
    if (strict(value, ["schema", "status", "stage"]) && value.schema === 1 && value.status === "failed" && Number.isInteger(value.stage) && value.stage >= 0 && value.stage <= 15) refuse(process, value.stage);
    refuse(process);
  }
  if (!strict(value, ["compilerVersion", "linkerVersion"]) || !numeric(value.compilerVersion) || !numeric(value.linkerVersion)) refuse(process);
  return Object.freeze({ compilerVersion: value.compilerVersion, linkerVersion: value.linkerVersion });
}
