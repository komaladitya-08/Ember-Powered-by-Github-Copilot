/** Per-invocation, privately branded build checkpoints. Foreign errors contribute no properties or text to diagnostics. */
export const uvSpawnBuildCheckpoints = Object.freeze({
  unknown: 0, input: 1, setup: 2, python: 3, source: 4, visualStudio: 5, tools: 6, versions: 7, sourceBefore: 8,
  configure: 9, compilerSelection: 10, generatedProject: 11, msbuild: 12, sourceAfter: 13, postValidation: 14,
  listing: 15, emission: 16, object: 17, pe: 18, readback: 19, receipt: 20,
});
const brands = new WeakMap();
const brand = error => error !== null && (typeof error === "object" || typeof error === "function") ? brands.get(error) : undefined;
const output = checkpoint => Object.freeze({ schema: 1, status: "failed", checkpoint });

/** Only errors created by this module carry a checkpoint. No message, cause, status, signal, stack or getter is read. */
export function classifyUvSpawnBuildFailure(error) { return output(brand(error)?.checkpoint ?? uvSpawnBuildCheckpoints.unknown); }

/** The first failure belongs to this invocation; a different invocation's branded error is foreign input here. */
export function createUvSpawnBuildDiagnostic() {
  const owner = Symbol("fixed-build-invocation");
  let current = uvSpawnBuildCheckpoints.unknown, first;
  return Object.freeze({
    checkpoint(code) {
      if (!Number.isInteger(code) || code < uvSpawnBuildCheckpoints.unknown || code > uvSpawnBuildCheckpoints.receipt) {
        throw new Error("The fixed build checkpoint was refused.");
      }
      current = code;
    },
    failure(error) {
      if (first !== undefined) return first;
      const existing = brand(error);
      if (existing?.owner === owner) first = error;
      else {
        first = new Error("The fixed uv_spawn build failed its closed checkpoint contract.");
        brands.set(first, Object.freeze({ owner, checkpoint: current }));
      }
      return first;
    },
    classify(error) {
      const existing = brand(error);
      return output(existing?.owner === owner ? existing.checkpoint : uvSpawnBuildCheckpoints.unknown);
    },
  });
}
