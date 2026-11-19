/** Separate WSL acceptance inventory. These data checks issue no native resource or readiness authority. */
import path from "node:path";
import { types } from "node:util";

export const WSL_PRODUCT_CASES = Object.freeze({
  resources: Object.freeze(["repair-and-custody", "writer-stop"] as const),
  source: Object.freeze(["repair", "denied", "stop", "source", "selection", "revocation", "account", "public-repair", "public-denied"] as const),
  packaged: Object.freeze(["normal-wsl-home"] as const),
});
export type WslProductJourney = keyof typeof WSL_PRODUCT_CASES;
export type WslSourceCase = typeof WSL_PRODUCT_CASES.source[number];
export const WSL_PRODUCT_FILES = Object.freeze({
  resources: "test/integration/wsl-coding-product-resources.test.ts",
  source: "test/integration/wsl-coding-product-electron.test.ts",
  packaged: "test/integration/wsl-coding-product-packaged.test.ts",
});
const fixed = () => {
  const error = new Error("The required Windows WSL product proof could not be verified.");
  error.stack = "Error: " + error.message; return error;
};
const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") ? field.value : undefined;
};
/** The caller supplies the actual imported production literal. A returned tuple grants no workspace or consent. */
export function requireWslProductAdmission(input: {
  required: unknown; platform: unknown; arch: unknown; image: unknown; commit: unknown; readiness: unknown;
}) {
  try {
    const readiness = own(input, "readiness"), commit = own(input, "commit"), image = own(input, "image");
    const proofCommit = own(readiness, "proofCommit"), proofRun = own(readiness, "proofRun");
    if (own(input, "required") !== true || own(input, "platform") !== "win32" || own(input, "arch") !== "x64" ||
        image !== "windows-2022" && image !== "windows-2025" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) ||
        own(readiness, "ready") !== true || typeof proofCommit !== "string" || !/^[0-9a-f]{40}$/.test(proofCommit) ||
        typeof proofRun !== "number" || !Number.isSafeInteger(proofRun) || proofRun < 1) throw fixed();
    return Object.freeze({ commit, image, nativeProofCommit: proofCommit, nativeProofRun: proofRun });
  } catch { throw fixed(); }
}
export function wslProductTitle(journey: WslProductJourney, name: string): string {
  if (!Object.hasOwn(WSL_PRODUCT_CASES, journey) || !(WSL_PRODUCT_CASES[journey] as readonly string[]).includes(name)) throw fixed();
  return `Windows WSL ${journey}: ${name}`;
}
/** Exact complete Vitest inventory only. A report or this function never enables the production feature. */
export function requireWslProductReport(value: unknown, journey: WslProductJourney, repository: string) {
  try {
    if (!Object.hasOwn(WSL_PRODUCT_CASES, journey) || !path.isAbsolute(repository)) throw fixed();
    const cases = WSL_PRODUCT_CASES[journey], files = own(value, "testResults");
    if (own(value, "success") !== true || own(value, "numTotalTests") !== cases.length || own(value, "numPassedTests") !== cases.length ||
        ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"].some(key => own(value, key) !== 0) ||
        !Array.isArray(files) || types.isProxy(files) || files.length !== 1) throw fixed();
    const suite = own(files, "0"), filename = own(suite, "name"), assertions = own(suite, "assertionResults");
    if (own(suite, "status") !== "passed" || typeof filename !== "string" ||
        path.resolve(filename).toLowerCase() !== path.resolve(repository, WSL_PRODUCT_FILES[journey]).toLowerCase() ||
        !Array.isArray(assertions) || types.isProxy(assertions) || assertions.length !== cases.length) throw fixed();
    const expected = new Set(cases.map(name => wslProductTitle(journey, name)));
    for (let index = 0; index < assertions.length; index++) {
      const assertion = own(assertions, String(index)), title = own(assertion, "fullName");
      if (own(assertion, "status") !== "passed" || typeof title !== "string" || !expected.delete(title)) throw fixed();
    }
    if (expected.size) throw fixed();
    return Object.freeze({ journey, cases: cases.length });
  } catch { throw fixed(); }
}
