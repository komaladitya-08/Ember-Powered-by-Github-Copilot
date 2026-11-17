/** Deterministic provider replies only; no Electron, IPC, workspace, native issuer or execution hook. */
// @ts-expect-error -- local JavaScript HTTP fixture, never a live provider/account
import { startMockLlm } from "../mock-llm/server.mjs";

export const WINDOWS_NODE_TEST_ARGV = Object.freeze(["--preserve-symlinks", "--preserve-symlinks-main", "--experimental-test-isolation=none", "--test", "test.cjs"]);
export const WINDOWS_NODE_WRITER_ARGV = Object.freeze(["--preserve-symlinks", "--preserve-symlinks-main", "writer.cjs"]);
export const WINDOWS_NODE_WRITER_READY = "EMBER_WINDOWS_NODE_SOURCE_WRITER_READY";
export const WINDOWS_NODE_SOURCE_ORIGINAL = "const {test}=require('node:test');const assert=require('node:assert/strict');assert.equal(process.env.EMBER_NODE_SOURCE_CANARY,undefined);test('sum',()=>assert.equal(1 + 1, 3));\n";
export const WINDOWS_NODE_SOURCE_WRITER = "const fs=require('node:fs');let n=0;fs.writeFileSync('heartbeat.txt',String(n++));console.log('" + WINDOWS_NODE_WRITER_READY + "');setInterval(()=>fs.writeFileSync('heartbeat.txt',String(n++)),10);\n";
export const WINDOWS_NODE_PRODUCT_TOOLS = Object.freeze(["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding", "ask_coding_question", "run_node"]);
export type WindowsNodeSourceCase = "repair" | "denied" | "stop" | "source" | "mode" | "forget" | "account";
export interface WindowsNodeJourneyScenario { readonly key: string; readonly request: string; readonly goal: string; readonly kind: "repair" | "continuation" | "denied" | "writer" }
export const WINDOWS_NODE_REPAIR: WindowsNodeJourneyScenario = Object.freeze({ key: "repair", kind: "repair",
  request: "In this project's chosen folder, run bundled Node with literal arguments " + JSON.stringify(WINDOWS_NODE_TEST_ARGV) + " in \\work, fix its assertion in the private copy, rerun the identical check, and prepare a review. Leave the original unchanged.",
  goal: "Repair the copied sum assertion and rerun its identical bundled Node check" });
export const WINDOWS_NODE_CONTINUATION: WindowsNodeJourneyScenario = Object.freeze({ key: "continuation", kind: "continuation",
  request: "Continue this reviewed result in a new private session. First read test.cjs to confirm the reviewed sum is fixed, run bundled Node with literal arguments " + JSON.stringify(WINDOWS_NODE_TEST_ARGV) + " in \\work, rename the sum test to continued sum, rerun the identical check, and prepare a cumulative review. Leave the original unchanged.",
  goal: "Read the reviewed fixed sum in a fresh copy, verify it, rename its test and verify the identical bundled Node check again" });
export function windowsNodeSourceScenarios(kind: WindowsNodeSourceCase): readonly WindowsNodeJourneyScenario[] {
  if (kind === "repair") return Object.freeze([WINDOWS_NODE_REPAIR, WINDOWS_NODE_CONTINUATION]);
  if (kind === "denied") return Object.freeze([Object.freeze({ key: kind, kind: "denied" as const,
    request: "Offer this project's copied bundled Node check with literal arguments " + JSON.stringify(WINDOWS_NODE_TEST_ARGV) + " in \\work. I will decide on its command card. Do not retry if I decline. Leave the original unchanged.",
    goal: "Offer exactly one copied bundled Node check and respect its command decision" })]);
  return Object.freeze([Object.freeze({ key: kind, kind: "writer" as const,
    request: "For the " + kind + " cancellation check, start copied writer.cjs with bundled Node literal arguments " + JSON.stringify(WINDOWS_NODE_WRITER_ARGV) + " in \\work. It writes only the private copy until I stop or revoke this request. Never retry after cancellation. Leave the original unchanged.",
    goal: "Start the copied writer for the " + kind + " cancellation check and respect Stop or revoked authority" })]);
}
interface Message { role: string; content: unknown }
interface Reply { text?: string; tool?: { name: string; args: Record<string, unknown> } }
function textOf(content: unknown): string {
  // Preserve literal argv quotes/backslashes in ordinary strings and OpenAI text-part arrays.
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("\n");
  if (content && typeof content === "object" && "text" in content && typeof content.text === "string") return content.text;
  return JSON.stringify(content) ?? "";
}

/** Public scripted steps are shared with the packaged normal-UI journey; they confer no backend authority. */
export async function createWindowsNodeProductModel(scenarios: readonly WindowsNodeJourneyScenario[]) {
  const dispatched = new Set<string>(), steps = new Map<string, number>(), results = new Map<string, string[]>();
  const inventories: string[][] = [], failures: number[] = [];
  const refuse = (code: number): Reply => { failures.push(code); return { tool: { name: "finish_coding", args: { success: false, summary: "The fixed Windows Node fixture could not verify its expected step." } } }; };
  const run = (argv: readonly string[]): Reply => ({ tool: { name: "run_node", args: { argv: [...argv], cwd: "\\work", why: "Verify the explicitly requested copied Windows Node fixture" } } });
  const model = await startMockLlm({ delayMs: 0, respond: (messages: Message[], tools: string[]): Reply => {
    const said = (text: string) => messages.some(message => message.role === "user" && textOf(message.content).includes(text));
    if (tools.includes("start_coding")) {
      const next = scenarios.find(scenario => !dispatched.has(scenario.key) && said(scenario.request));
      if (next) { dispatched.add(next.key); return { tool: { name: "start_coding", args: { goal: next.goal, sessionName: "Windows Node " + next.key } } }; }
      return { text: "The requested private coding session has its own project card and Stop." };
    }
    if (!tools.includes("finish_coding")) return { text: "Ready for the requested private review." };
    inventories.push([...tools]);
    const scenario = [...scenarios].reverse().find(candidate => said(candidate.goal));
    if (!scenario) return refuse(1);
    if ([...tools].sort().join("\0") !== [...WINDOWS_NODE_PRODUCT_TOOLS].sort().join("\0")) return refuse(2);
    const previous = steps.get(scenario.key) ?? 0, limit = scenario.kind === "continuation" ? 5 : scenario.kind === "repair" ? 4 : 1;
    if (previous >= limit) return { text: "The fixed private session has ended; no further command is authorized." };
    const last = JSON.stringify(messages.findLast(message => message.role === "tool")?.content ?? "");
    const history = results.get(scenario.key) ?? []; history.push(last); results.set(scenario.key, history);
    steps.set(scenario.key, previous + 1);
    if (scenario.kind === "denied") return run(WINDOWS_NODE_TEST_ARGV);
    if (scenario.kind === "writer") return run(WINDOWS_NODE_WRITER_ARGV);
    if (scenario.kind === "repair") {
      if (previous === 0 || previous === 2) return run(WINDOWS_NODE_TEST_ARGV);
      if (previous === 1) {
        if (!last.includes("ERR_ASSERTION")) return refuse(3);
        return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "1 + 1, 3", newText: "1 + 1, 2" } } };
      }
      return { tool: { name: "finish_coding", args: { success: true, summary: "Fixed the copied sum and reran the identical Node check successfully. Review the patch before applying it." } } };
    }
    if (previous === 0) return { tool: { name: "coding_read", args: { path: "test.cjs" } } };
    if (previous === 1) {
      if (!last.includes("1 + 1, 2") || last.includes("1 + 1, 3")) return refuse(4);
      return run(WINDOWS_NODE_TEST_ARGV);
    }
    if (previous === 2) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "test('sum'", newText: "test('continued sum'" } } };
    if (previous === 3) return run(WINDOWS_NODE_TEST_ARGV);
    return { tool: { name: "finish_coding", args: { success: true, summary: "Verified the reviewed sum in a fresh session, renamed its test and reran the identical Node check successfully. Review the cumulative patch." } } };
  } });
  return { ...model, dispatched, steps, results, inventories, failures };
}
