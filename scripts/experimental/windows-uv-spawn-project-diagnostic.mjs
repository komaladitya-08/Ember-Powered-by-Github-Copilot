/** Closed first-constraint facts from the actual generated-project validator; no XML, paths or foreign exceptions are inspected. */
export const uvSpawnProjectConstraints = Object.freeze({ unknown: 0, read: 1, input: 2, encoding: 3, release: 4,
  clBlock: 5, rcBlock: 6, clDefinitions: 7, rcDefinitions: 8, clMacros: 9, rcMacros: 10, runtime: 11,
  remaining: 12, toolsetSdk: 13, unitMacro: 14, selectedUnit: 15, unexpectedUnit: 16, unitCounts: 17 });
const brands = new WeakMap();
const integer = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;

/** Called only at an owned read/validator refusal. Count 17 means at least seventeen; unit is none/pipe/process/other. */
export function createWindowsUvSpawnProjectFailure(target, constraint, unit = 0, count = 0) {
  const error = new Error("The fixed uv_spawn build failed its exact source, recipe or issuer contract.");
  brands.set(error, Object.freeze({ schema: 1, target: target === "uv_a" ? 1 : target === "ember_uv_spawn_probe" ? 2 : 0,
    constraint: integer(constraint, 17) ? constraint : 0, unit: integer(unit, 3) ? unit : 0,
    count: Number.isInteger(count) && count >= 0 ? Math.min(count, 17) : 0 }));
  return error;
}

/** A structural copy, forged object or accessor cannot carry the private brand. */
export function classifyWindowsUvSpawnProjectFailure(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") ? brands.get(error) : undefined;
}
