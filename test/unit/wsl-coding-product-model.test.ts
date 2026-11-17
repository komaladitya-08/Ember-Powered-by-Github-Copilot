/** Exercise the deterministic provider; these requests confer no backend, model-account or execution authority. */
import { expect, it } from "vitest";
import { createWslProductModel, wslProductScenarios, wslProductProject, WSL_PRODUCT_TOOLS, WSL_PUBLIC_PRODUCT_TOOLS } from "../fixtures/wsl-coding-product-model";

async function reply(model: Awaited<ReturnType<typeof createWslProductModel>>, goal: string, tools: readonly string[], text = "") {
  const response = await fetch(model.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-model", stream: false, messages: [{ role: "user", content: goal }, { role: "tool", content: text }],
      tools: tools.map(name => ({ type: "function", function: { name } })) }) });
  const value = await response.json() as { choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[] };
  const call = value.choices[0].message.tool_calls[0].function; return { name: call.name, args: JSON.parse(call.arguments) };
}
it("uses separate exact Home tool surfaces and preserves baseline/changed public source identities", () => {
  expect(WSL_PRODUCT_TOOLS).toHaveLength(11); expect(WSL_PUBLIC_PRODUCT_TOOLS).toHaveLength(12);
  expect(WSL_PRODUCT_TOOLS).toContain("ask_coding_question"); expect(WSL_PRODUCT_TOOLS).not.toContain("prepare_public_dependencies");
  const base = wslProductProject(true), changed = wslProductProject(true, true);
  expect(base["src/result.ts"]).toBe(changed["src/result.ts"]); expect(base["package-lock.json"]).not.toBe(changed["package-lock.json"]);
  expect(base["package-lock.json"]).toContain("picocolors-1.1.1.tgz"); expect(changed["package-lock.json"]).toContain("yocto-queue-0.1.0.tgz");
});
it.each(["denied", "public-denied"] as const)("offers the exact %s operation once without a retry script", async kind => {
  const scenarios = wslProductScenarios(kind), model = await createWslProductModel(scenarios, "Ubuntu-22.04 (WSL)");
  try {
    const tools = kind === "public-denied" ? WSL_PUBLIC_PRODUCT_TOOLS : WSL_PRODUCT_TOOLS;
    expect((await reply(model, scenarios[0].goal, tools)).name).toBe(kind === "public-denied" ? "prepare_public_dependencies" : "run_command");
    expect((await reply(model, scenarios[0].goal, tools)).name).toBe("finish_coding"); expect(model.failures).toHaveLength(1);
  } finally { await model.close(); }
});
it("requires baseline preparation and a separate changed-set preparation before later offline commands", async () => {
  const scenarios = wslProductScenarios("public-repair"), model = await createWslProductModel(scenarios, "Ubuntu-22.04 (WSL)");
  try {
    const names: string[] = [];
    for (let index = 0; index < 9; index++) names.push((await reply(model, scenarios[0].goal, WSL_PUBLIC_PRODUCT_TOOLS, index === 2 ? "ERR_ASSERTION" : "observed result")).name);
    expect(names).toEqual(["prepare_public_dependencies", "run_command", "coding_replace", "run_command", "coding_write", "coding_write", "prepare_public_dependencies", "run_command", "finish_coding"]);
    expect(model.failures).toEqual([]);
  } finally { await model.close(); }
});
