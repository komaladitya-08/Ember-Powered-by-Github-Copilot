/** Manual-only disposable hosted-runner driver witness; automatic PR CI imports and skips without loading native code. */
import { describe, expect, it } from "vitest";
import { childAccessWitnessReceipt, runWindowsLpacChildAccessWitness } from "../fixtures/windows-lpac-child-access-witness";

const required = process.env.EMBER_LPAC_CHILD_ACCESS_TEST === "1";
describe.skipIf(!required)("manual fixed C child access witness", () => {
  it("publishes only bounded numeric trace classes after complete native writer Stop and cleanup", async () => {
    try {
      const result = await runWindowsLpacChildAccessWitness();
      console.info("Fixed child-access numeric witness", JSON.stringify(result));
      expect(result.schema).toBe(1); expect(result.status).toBe(1); expect(result.coverage).toBe(7);
    } catch (error) {
      console.info("Fixed child-access refusal", JSON.stringify(childAccessWitnessReceipt(error) ?? { phase: 0 }));
      // eslint-disable-next-line preserve-caught-error -- Captured tool/parser/native errors may carry trace paths or private data; only branded numeric receipts may leave.
      throw new Error("The manual fixed child-access witness did not establish complete bounded evidence.");
    }
  }, 180_000);
});
