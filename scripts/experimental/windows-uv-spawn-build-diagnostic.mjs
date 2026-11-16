/** Per-invocation, privately branded build checkpoints. Foreign errors contribute no properties or text to diagnostics. */
import { powerShellProcessDiagnostic } from "./windows-uv-spawn-powershell.mjs";
import { classifyWindowsUvSpawnFileVersionFailure } from "./windows-uv-spawn-file-version.mjs";
import { classifyWindowsUvSpawnProjectFailure } from "./windows-uv-spawn-project-diagnostic.mjs";
export const uvSpawnBuildCheckpoints = Object.freeze({
  unknown: 0, input: 1, setup: 2, python: 3, source: 4, visualStudio: 5, tools: 6, versions: 7, sourceBefore: 8,
  configure: 9, compilerSelection: 10, generatedProject: 11, msbuild: 12, sourceAfter: 13, postValidation: 14,
  listing: 15, emission: 16, object: 17, pe: 18, readback: 19, receipt: 20,
});
export const uvSpawnVersionSubcheckpoints = Object.freeze({
  // Codes 1–3 retain their historical names; the current recipe replaces the PowerShell dependency with the fixed Python VERSION reader.
  unknown: 0, powershellCall: 1, powershellJson: 2, powershellShape: 3, cmakeCall: 4, cmakeBanner: 5, visualStudioCall: 6, msbuildCall: 7,
  visualStudioFormat: 8, compilerFormat: 9, linkerFormat: 10, msbuildFormat: 11, pythonFormat: 12, cmakeFormat: 13,
  visualStudioPrefix: 14, compilerPrefix: 15, linkerPrefix: 16, msbuildPrefix: 17, pythonPin: 18, cmakePin: 19,
});
const brands = new WeakMap();
const brand = error => error !== null && (typeof error === "object" || typeof error === "function") ? brands.get(error) : undefined;
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const emptyTools = () => Array.from({ length: 6 }, (_, index) => ({ toolId: index + 1, state: 0, components: [] }));
const output = record => Object.freeze({ schema: 1, status: "failed", checkpoint: record?.checkpoint ?? uvSpawnBuildCheckpoints.unknown,
  ...(record?.checkpoint === uvSpawnBuildCheckpoints.versions ? { versionDiagnostic: record.versionDiagnostic,
    ...(record.powerShellDiagnostic ? { powerShellDiagnostic: record.powerShellDiagnostic } : {}),
    ...(record.fileVersionDiagnostic ? { fileVersionDiagnostic: record.fileVersionDiagnostic } : {}) } : {}),
  ...(record?.checkpoint === uvSpawnBuildCheckpoints.generatedProject && record.projectDiagnostic ? { projectDiagnostic: record.projectDiagnostic } : {}) });

function projectedVersion(toolId, value) {
  if (typeof value !== "string" || value.length > 64) return { toolId, state: 2, components: [] };
  const match = (toolId === 6 ? /^cmake version ([0-9]{1,6}(?:\.[0-9]{1,6}){1,3})$/ : /^([0-9]{1,6}(?:\.[0-9]{1,6}){1,3})$/).exec(value);
  return match && match[0] === value ? { toolId, state: 1, components: match[1].split(".").map(Number) } : { toolId, state: 2, components: [] };
}

/** Only errors created by this module carry a checkpoint. No message, cause, status, signal, stack or getter is read. */
export function classifyUvSpawnBuildFailure(error) { return output(brand(error)); }

/** The first failure belongs to this invocation; a different invocation's branded error is foreign input here. */
export function createUvSpawnBuildDiagnostic() {
  const owner = Symbol("fixed-build-invocation");
  let current = uvSpawnBuildCheckpoints.unknown, subcheckpoint = uvSpawnVersionSubcheckpoints.unknown, tools = emptyTools(), powerShellDiagnostic, fileVersionDiagnostic, first;
  return Object.freeze({
    checkpoint(code) {
      if (!Number.isInteger(code) || code < uvSpawnBuildCheckpoints.unknown || code > uvSpawnBuildCheckpoints.receipt) {
        throw new Error("The fixed build checkpoint was refused.");
      }
      current = code;
      subcheckpoint = uvSpawnVersionSubcheckpoints.unknown; tools = emptyTools(); powerShellDiagnostic = undefined; fileVersionDiagnostic = undefined;
    },
    subcheckpoint(code) {
      if (current !== uvSpawnBuildCheckpoints.versions || !Number.isInteger(code) || code < uvSpawnVersionSubcheckpoints.unknown || code > uvSpawnVersionSubcheckpoints.cmakePin) {
        throw new Error("The fixed version checkpoint was refused.");
      }
      subcheckpoint = code;
    },
    observeVersion(toolId, value) {
      if (current !== uvSpawnBuildCheckpoints.versions || !Number.isInteger(toolId) || toolId < 1 || toolId > 6) {
        throw new Error("The fixed version observation was refused.");
      }
      tools[toolId - 1] = projectedVersion(toolId, value);
    },
    observePowerShell(token) {
      if (current !== uvSpawnBuildCheckpoints.versions || subcheckpoint !== uvSpawnVersionSubcheckpoints.powershellCall) {
        throw new Error("The fixed PowerShell observation was refused.");
      }
      powerShellDiagnostic = powerShellProcessDiagnostic(token);
    },
    observeFileVersionFailure(error) {
      if (current !== uvSpawnBuildCheckpoints.versions || subcheckpoint !== uvSpawnVersionSubcheckpoints.powershellCall) {
        throw new Error("The fixed VERSION observation was refused.");
      }
      fileVersionDiagnostic = classifyWindowsUvSpawnFileVersionFailure(error);
    },
    failure(error) {
      if (first !== undefined) return first;
      const existing = brand(error);
      if (existing?.owner === owner) first = error;
      else {
        first = new Error("The fixed uv_spawn build failed its closed checkpoint contract.");
        const versionDiagnostic = current === uvSpawnBuildCheckpoints.versions ? freeze({ schema: 1, subcheckpoint,
          tools: tools.map(item => ({ ...item, components: [...item.components] })) }) : undefined;
        const projectDiagnostic = current === uvSpawnBuildCheckpoints.generatedProject ? classifyWindowsUvSpawnProjectFailure(error) : undefined;
        brands.set(first, Object.freeze({ owner, checkpoint: current, ...(versionDiagnostic ? { versionDiagnostic,
          ...(powerShellDiagnostic ? { powerShellDiagnostic } : {}), ...(fileVersionDiagnostic ? { fileVersionDiagnostic } : {}) } : {}),
          ...(projectDiagnostic ? { projectDiagnostic } : {}) }));
      }
      return first;
    },
    classify(error) {
      const existing = brand(error);
      return output(existing?.owner === owner ? existing : undefined);
    },
  });
}
