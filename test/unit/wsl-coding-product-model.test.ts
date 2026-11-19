/** Exercise the deterministic provider; these requests confer no backend, model-account or execution authority. */
import { expect, it } from "vitest";
import { createWslProductModel, wslProductScenarios, wslProductProject, WSL_PRODUCT_TOOLS, WSL_PUBLIC_PRODUCT_TOOLS } from "../fixtures/wsl-coding-product-model";

async function reply(model: Awaited<ReturnType<typeof createWslProductModel>>, goal: string, tools: readonly string[], text = "") {
  const response = await fetch(model.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock-model", stream: false, messages: [{ role: "user", content: goal }, { role: "tool", content: text }],
      tools: tools.map(name => ({ type: "function", function: { name } })) }) });
  const value = await response.json() as { choices: { message: { content?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[] };
  const { content, tool_calls: toolsInReply } = value.choices[0].message;
  const call = toolsInReply?.[0]?.function;
  return call ? { name: call.name, args: JSON.parse(call.arguments) } : { name: "", args: { text: content } };
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

it.each([
  ["Observed command exited successfully.\n<coding_command_result untrusted=\"true\">PRIVATE", 1],
  ["Observed command exited unsuccessfully. Fix the copy and rerun this exact check before reporting success.\n<coding_command_result untrusted=\"true\">PRIVATE", 2],
  ["PRIVATE embedded Observed command exited successfully.\n<coding_command_result untrusted=\"true\">", 3],
] as const)("records only the repair command observation while preserving the mock replies (%#)", async (output, kind) => {
  const scenarios = wslProductScenarios("repair"), model = await createWslProductModel(scenarios, "Ubuntu-22.04 (WSL)");
  const goal = scenarios[0].goal;
  try {
    expect(model.terminalEvidence(1)).toEqual({ steps: 0, command: 0 });
    expect((await reply(model, goal, WSL_PRODUCT_TOOLS)).name).toBe("run_command");
    expect((await reply(model, goal, WSL_PRODUCT_TOOLS, "ERR_ASSERTION")).name).toBe("coding_replace");
    expect((await reply(model, goal, WSL_PRODUCT_TOOLS)).name).toBe("run_command");
    expect(model.terminalEvidence(1)).toEqual({ steps: 3, command: 0 });
    expect(await reply(model, goal, WSL_PRODUCT_TOOLS, output)).toMatchObject({ name: "finish_coding", args: { success: true } });
    expect(model.terminalEvidence(1)).toEqual({ steps: 4, command: kind });
    expect(model.terminalEvidence(2)).toEqual({ steps: 0, command: 0 });
    expect(await reply(model, goal, WSL_PRODUCT_TOOLS)).toMatchObject({ name: "finish_coding", args: { success: false } });
    expect(model.terminalEvidence(1)).toEqual({ steps: 5, command: kind });
  } finally { await model.close(); }
});

const acceptedFinish = "Coding result recorded for host review.";

it.each([
  ["repair", 0, 4, 1, "ERR_ASSERTION"],
  ["repair", 1, 5, 1, "'ready'"],
  ["public-repair", 0, 9, 2, "ERR_ASSERTION"],
  ["public-repair", 1, 4, 1, "'ready'"],
] as const)("answers an accepted finish with prose for %s episode index %i", async (kind, episode, steps, checkStep, check) => {
  const scenarios = wslProductScenarios(kind), model = await createWslProductModel(scenarios, "Ubuntu-22.04 (WSL)");
  const scenario = scenarios[episode], tools = scenario.publicDependencies ? WSL_PUBLIC_PRODUCT_TOOLS : WSL_PRODUCT_TOOLS;
  try {
    for (let step = 0; step < steps - 1; step++) {
      expect((await reply(model, scenario.goal, tools, step === checkStep ? check : "")).name).not.toBe("finish_coding");
    }
    expect(await reply(model, scenario.goal, tools)).toMatchObject({ name: "finish_coding", args: { success: true } });
    expect(await reply(model, scenario.goal, tools, acceptedFinish)).toEqual({
      name: "", args: { text: "The copied WSL result is ready for review." },
    });
    expect(model.steps.get(scenario.key)).toBe(steps);
    expect(model.failures).toEqual([]);
  } finally { await model.close(); }
});

it.each([
  "Finish not recorded: an observed command check is still failing.",
  "The coding operation could not be completed safely.",
  "<coding_command_result untrusted=\"true\">" + acceptedFinish,
  acceptedFinish + "\n",
])("keeps fixture failure on an unaccepted finish reply (%#)", async finish => {
  const scenarios = wslProductScenarios("repair"), model = await createWslProductModel(scenarios, "Ubuntu-22.04 (WSL)");
  const { goal } = scenarios[0];
  try {
    expect((await reply(model, goal, WSL_PRODUCT_TOOLS, acceptedFinish)).name).toBe("run_command");
    expect((await reply(model, goal, WSL_PRODUCT_TOOLS, "ERR_ASSERTION")).name).toBe("coding_replace");
    expect((await reply(model, goal, WSL_PRODUCT_TOOLS)).name).toBe("run_command");
    expect(await reply(model, goal, WSL_PRODUCT_TOOLS)).toMatchObject({ name: "finish_coding", args: { success: true } });
    expect(await reply(model, goal, WSL_PRODUCT_TOOLS, finish)).toMatchObject({ name: "finish_coding", args: { success: false } });
    expect(model.failures).toEqual([7]);
  } finally { await model.close(); }
});
