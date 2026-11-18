/** Deterministic model replies only. Production Host, policy, Windows custody, WSL and HTTPS remain real. */
// @ts-expect-error -- fixed local JavaScript provider, never a live account
import { startMockLlm } from "../mock-llm/server.mjs";
import { sourceCommandKind } from "./wsl-coding-product-observation";
import type { WslSourceCase } from "./wsl-coding-product-contract";

export const WSL_PRODUCT_CHECK = "npm ci --offline && npm run build && npm test";
export const WSL_PRODUCT_WRITER = "node writer.cjs";
export const WSL_PRODUCT_WRITER_READY = "EMBER_WSL_PRODUCT_WRITERS_READY";
export const WSL_PRODUCT_TOOLS = Object.freeze(["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding", "ask_coding_question", "run_command", "run_node"]);
export const WSL_PUBLIC_PRODUCT_TOOLS = Object.freeze([...WSL_PRODUCT_TOOLS, "prepare_public_dependencies"]);
const pico = { version: "1.1.1", resolved: "https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz", integrity: "sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==" };
const yocto = { version: "0.1.0", resolved: "https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz", integrity: "sha512-rVksvsnNCdJ/ohGc6xgPwyN8eheCxsiLM8mxuE/t/mOVqJewPuO1miLpTHQiRgTKCLexL4MeAFVagts7HmNZ2Q==" };
export function wslProductProject(publicDependencies = false, changed = false): Readonly<Record<string, string>> {
  const dependencies = publicDependencies ? { picocolors: pico.version, ...(changed ? { "yocto-queue": yocto.version } : {}) } : {};
  const pkg = { name: "windows-wsl-product-proof", version: "1.0.0", private: true,
    scripts: { postinstall: "node hook.cjs", build: "tsc -p tsconfig.json", test: "node --test test.cjs" }, dependencies };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version, dependencies },
    ...(publicDependencies ? { "node_modules/picocolors": pico } : {}), ...(publicDependencies && changed ? { "node_modules/yocto-queue": yocto } : {}) } };
  return Object.freeze({
    "package.json": JSON.stringify(pkg), "package-lock.json": JSON.stringify(lock),
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "CommonJS", outDir: "dist", strict: true, esModuleInterop: true }, include: ["src/*.ts"] }),
    "src/result.ts": (publicDependencies ? "import colors from 'picocolors'; export const result = colors.createColors(false).green('wrong');\n" : "export const result: string = 'wrong';\n"),
    "hook.cjs": "require('node:fs').writeFileSync('hook-ran','inside');\n",
    "test.cjs": "const {test}=require('node:test'),a=require('node:assert/strict'),f=require('node:fs');a.equal(process.platform,'linux');a.equal(process.env.EMBER_WSL_PRODUCT_HOST_CANARY,undefined);a.equal(f.existsSync('/mnt/c'),false);test('copied WSL result',()=>a.equal(require('./dist/result.js').result,'ready'));\n",
    "writer.cjs": "const f=require('node:fs'),{spawn}=require('node:child_process');\nif(process.argv[2]==='child'){f.appendFileSync('child-counter','x');process.stdout.write('child-ready\\n');setInterval(()=>f.appendFileSync('child-counter','x'),10)}\nelse{const c=spawn(process.execPath,[__filename,'child'],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>{f.appendFileSync('parent-counter','x');process.stdout.write('" + WSL_PRODUCT_WRITER_READY + "\\n');setInterval(()=>f.appendFileSync('parent-counter','x'),10)})}\n",
    "README.txt": "Fixed public Windows-to-WSL product fixture. Original files must stay unchanged.\n",
  });
}
export interface WslProductScenario {
  readonly key: string; readonly kind: "repair" | "continuation" | "denied" | "writer" | "public-repair" | "public-continuation" | "public-denied";
  readonly request: string; readonly goal: string; readonly publicDependencies: boolean;
}
export function wslProductScenarios(kind: WslSourceCase): readonly WslProductScenario[] {
  const scenario = (key: string, type: WslProductScenario["kind"], request: string, goal: string, publicDependencies = false) => Object.freeze({ key, kind: type, request, goal, publicDependencies });
  const repair = scenario("repair", "repair", `In this project's explicitly chosen WSL coding folder, run ${WSL_PRODUCT_CHECK} in /work, fix the copied failing result, rerun the identical command and prepare a review. Leave the Windows original unchanged.`, "Repair the copied offline TypeScript check and rerun its identical command");
  const continuation = scenario("continuation", "continuation", `Continue the reviewed result in a fresh WSL copy. Read src/result.ts to verify the previous fix, run ${WSL_PRODUCT_CHECK} in /work, rename its copied test and rerun the identical check. Leave the Windows original unchanged.`, "Continue the reviewed WSL fix in a fresh session and verify the identical check again");
  if (kind === "repair") return Object.freeze([repair, continuation]);
  if (kind === "denied") return Object.freeze([scenario(kind, "denied", `Offer exactly one copied WSL check ${WSL_PRODUCT_CHECK} in /work. Respect my command-card decision, do not retry after Not now, and leave the original unchanged.`, "Offer the copied WSL check once and respect its command decision")]);
  if (kind === "public-denied") return Object.freeze([scenario(kind, "public-denied", "Offer preparation of this project's exact public package-lock set. Respect Not now without downloading or running a command, and leave the original unchanged.", "Offer the exact public dependency set once and respect its decision", true)]);
  if (kind === "public-repair") return Object.freeze([
    scenario(kind, "public-repair", `Prepare this project's exact public package-lock set, run ${WSL_PRODUCT_CHECK} in /work, fix the copied failing result and rerun the identical command. Then add the fixed yocto-queue package/lock set, request fresh exact-set preparation and rerun that same offline command. Prepare a private review; leave the original unchanged.`, "Prepare baseline and changed locked public sets, repair the copied check and rerun its identical offline command", true),
    scenario("public-continuation", "public-continuation", `Continue the reviewed public-dependency result in a fresh WSL copy. Verify src/result.ts and prepare its current exact lock set again, then run ${WSL_PRODUCT_CHECK} in /work and prepare the cumulative review. Leave the original unchanged.`, "Continue the public-dependency review in a fresh WSL session without reusing an old cache authority", true),
  ]);
  const keys = kind === "revocation" ? ["mode", "forget"] : [kind];
  return Object.freeze(keys.map(key => scenario(key, "writer", `For the ${key} revocation check, start ${WSL_PRODUCT_WRITER} in this project's isolated WSL copy at /work. It writes only the private parent/child counters until I stop or revoke the request. Never retry or fall back to this computer after revocation.`, `Start both copied WSL writers for ${key} and respect Stop or revoked ownership`)));
}
interface Message { role: string; content: unknown }
interface Reply { text?: string; tool?: { name: string; args: Record<string, unknown> } }
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return JSON.stringify(value) ?? "";
}
export async function createWslProductModel(scenarios: readonly WslProductScenario[], target: string) {
  const dispatched = new Set<string>(), steps = new Map<string, number>(), results = new Map<string, string[]>();
  const lastCommands = new Map<string, number>();
  const inventories: string[][] = [], failures: number[] = [];
  const refusal = (code: number): Reply => { failures.push(code); return { tool: { name: "finish_coding", args: { success: false, summary: "The fixed WSL fixture could not verify its expected step." } } }; };
  const command = (text = WSL_PRODUCT_CHECK): Reply => ({ tool: { name: "run_command", args: { target, command: text, shell: "bash", cwd: "/work", why: "Verify only the explicitly requested copied WSL fixture" } } });
  const prepare = (): Reply => ({ tool: { name: "prepare_public_dependencies", args: {} } });
  const finish = (): Reply => ({ tool: { name: "finish_coding", args: { success: true, summary: "Verified the copied WSL result. Review its private changes before applying them." } } });
  const model = await startMockLlm({ delayMs: 0, respond(messages: Message[], tools: string[]): Reply {
    const said = (text: string) => messages.some(message => message.role === "user" && textOf(message.content).includes(text));
    if (tools.includes("start_coding")) {
      const next = scenarios.find(value => !dispatched.has(value.key) && said(value.request));
      if (next) { dispatched.add(next.key); return { tool: { name: "start_coding", args: { goal: next.goal, sessionName: "WSL " + next.key } } }; }
      return { text: "The WSL session has its own project, review and Stop." };
    }
    if (!tools.includes("finish_coding")) return { text: "Ready for the requested private WSL review." };
    inventories.push([...tools]); const scenario = [...scenarios].reverse().find(value => said(value.goal));
    if (!scenario) return refusal(1);
    const expected = scenario.publicDependencies ? WSL_PUBLIC_PRODUCT_TOOLS : WSL_PRODUCT_TOOLS;
    if ([...tools].sort().join("\0") !== [...expected].sort().join("\0")) return refusal(2);
    const step = steps.get(scenario.key) ?? 0; steps.set(scenario.key, step + 1);
    const lastTool = messages.findLast(message => message.role === "tool");
    const last = JSON.stringify(lastTool?.content ?? "");
    if (scenario.kind === "repair" && step === 3 || scenario.kind === "continuation" && step === 4) {
      lastCommands.set(scenario.key, sourceCommandKind(lastTool?.content));
    }
    const history = results.get(scenario.key) ?? []; history.push(last); results.set(scenario.key, history);
    if (scenario.kind === "denied") return step === 0 ? command() : refusal(3);
    if (scenario.kind === "public-denied") return step === 0 ? prepare() : refusal(4);
    if (scenario.kind === "writer") return step === 0 ? command(WSL_PRODUCT_WRITER) : refusal(5);
    if (scenario.kind === "repair") {
      if (step === 0 || step === 2) return command();
      if (step === 1) return last.includes("ERR_ASSERTION") ? { tool: { name: "coding_replace", args: { path: "src/result.ts", oldText: "'wrong'", newText: "'ready'" } } } : refusal(6);
      return step === 3 ? finish() : refusal(7);
    }
    if (scenario.kind === "public-repair") {
      if (step === 0 || step === 6) return prepare();
      if (step === 1 || step === 3 || step === 7) return command();
      if (step === 2) return last.includes("ERR_ASSERTION") ? { tool: { name: "coding_replace", args: { path: "src/result.ts", oldText: "'wrong'", newText: "'ready'" } } } : refusal(8);
      if (step === 4 || step === 5) { const name = step === 4 ? "package.json" : "package-lock.json"; return { tool: { name: "coding_write", args: { path: name, text: wslProductProject(true, true)[name] } } }; }
      return step === 8 ? finish() : refusal(9);
    }
    if (step === 0) return { tool: { name: "coding_read", args: { path: "src/result.ts" } } };
    if (step === 1 && (!last.includes("'ready'") || last.includes("'wrong'"))) return refusal(10);
    if (scenario.kind === "public-continuation") return step === 1 ? prepare() : step === 2 ? command() : step === 3 ? finish() : refusal(11);
    if (step === 1 || step === 3) return command();
    if (step === 2) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "copied WSL result", newText: "continued WSL result" } } };
    return step === 4 ? finish() : refusal(12);
  } });
  function terminalEvidence(episode: number) {
    const scenario = scenarios[episode - 1];
    if (!scenario) return { steps: 0, command: 0 };
    const finishStep = episode === 1 ? 4 : 5;
    return { steps: Math.min(steps.get(scenario.key) ?? 0, finishStep + 1), command: lastCommands.get(scenario.key) ?? 0 };
  }
  return { ...model, dispatched, steps, results, inventories, failures, terminalEvidence };
}
