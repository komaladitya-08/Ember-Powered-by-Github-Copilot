/**
 * Chromium journeys include page startup, layout and several UI interactions. Activity pagination and extension
 * review each exhausted the five-second whole-test default in full runs; Windows already allows fifteen seconds.
 * Change only renderer-file defaults, preserving explicit case, assertion, product and native-test deadlines.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";

const integration = path.resolve(fileURLToPath(new URL("./integration/", import.meta.url)));
const test = expect.getState().testPath;
if (test && path.isAbsolute(test) && path.dirname(path.resolve(test)) === integration && /-renderer\.test\.ts$/.test(path.basename(test))) {
  vi.setConfig({ testTimeout: 15_000 });
}
