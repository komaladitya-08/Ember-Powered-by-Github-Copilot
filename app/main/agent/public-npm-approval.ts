/** Exact public-lock preparation uses ordinary task policy, without inventing a shell command or launching a runner. */
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { Question } from "./confirm";
import { PUBLIC_NPM_LIMITS, PUBLIC_NPM_REGISTRY, type PublicNpmPreparationRequest } from "./public-npm-lock";
import { wordsRuleOut, type CommandFlowContext } from "../commands/flow";
import { decideCommand } from "../commands/decide";
import { autopilotCommand, autopilotRefuses } from "../commands/autopilot";
import { notReviewable, reviewedDecision } from "../commands/review";
import type { Classification, Finding } from "../commands/types";
import { commandActs, commandNamed, type CommandAsked } from "../policy/refusals";

const OPERATION = "prepare_public_dependencies";
const digestPattern = /^[0-9a-f]{64}$/;
const refusalName = (target: string) => `public-dependencies\n${target}`;
const own = (value: object, name: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(value, name);
  if (!property || !Object.hasOwn(property, "value")) throw new Error("Invalid public dependency preparation.");
  return property.value;
};

/** Copy only the bounded, frozen core projection; never read an arbitrary accessor or include source file contents. */
function projection(value: Readonly<PublicNpmPreparationRequest>): PublicNpmPreparationRequest {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Object.isFrozen(value) || Object.keys(value).sort().join("|") !==
      ["kind", "registry", "packageJsonSha256", "lockSha256", "setSha256", "packages", "packageCount", "compressedByteLimit"].sort().join("|")) throw new Error();
  const kind = own(value, "kind"), registry = own(value, "registry"), packageJsonSha256 = own(value, "packageJsonSha256"),
    lockSha256 = own(value, "lockSha256"), setSha256 = own(value, "setSha256"), count = own(value, "packageCount"),
    maximum = own(value, "compressedByteLimit"), source = own(value, "packages");
  if ((kind !== "baseline" && kind !== "changed") || registry !== PUBLIC_NPM_REGISTRY ||
      ![packageJsonSha256, lockSha256, setSha256].every(hash => typeof hash === "string" && digestPattern.test(hash)) ||
      !Number.isInteger(count) || (count as number) < 0 || (count as number) > PUBLIC_NPM_LIMITS.packages || maximum !== PUBLIC_NPM_LIMITS.compressedBytes ||
      !Array.isArray(source) || types.isProxy(source) || !Object.isFrozen(source) || source.length !== count || Object.keys(source).length !== count) throw new Error();
  const packages: { name: string; version: string }[] = [];
  for (let index = 0; index < (count as number); index++) {
    const entry = own(source, String(index));
    if (!entry || typeof entry !== "object" || types.isProxy(entry) || !Object.isFrozen(entry) || Object.keys(entry).sort().join("|") !== "name|version") throw new Error();
    const name = own(entry, "name"), version = own(entry, "version");
    if (typeof name !== "string" || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
        typeof version !== "string" || version.length > 128 || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error();
    packages.push(Object.freeze({ name, version }));
  }
  return Object.freeze({ kind, registry, packageJsonSha256: packageJsonSha256 as string, lockSha256: lockSha256 as string,
    setSha256: setSha256 as string, packages: Object.freeze(packages), packageCount: count as number, compressedByteLimit: maximum as number });
}

/** The same held request and task context must still be current after every reviewer, question and presentation call. */
export async function authorizePublicNpmPreparation(input: Readonly<PublicNpmPreparationRequest>, ctx: CommandFlowContext,
  projectId: string, signal: AbortSignal): Promise<boolean> {
  signal = AbortSignal.any([signal, ctx.signal]);
  const live = () => !signal.aborted && !ctx.isOver();
  try {
    if (!live() || ctx.service.binding.kind !== "wsl" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) return false;
    const request = projection(input), target = ctx.service.binding.id;
    const sha256 = createHash("sha256").update("Ember/public-npm-preparation/v1\0").update(JSON.stringify({ projectId, target, request })).digest("hex");
    const display = `Prepare ${request.packageCount} locked public packages from ${request.registry}.\n` +
      `package.json SHA-256: ${request.packageJsonSha256}\npackage-lock.json SHA-256: ${request.lockSha256}\n` +
      `Dependency set SHA-256: ${request.setSha256}\nPreparation SHA-256: ${sha256}\n` +
      `Compressed download limit: ${request.compressedByteLimit} bytes.\n` + request.packages.map(pkg => `${pkg.name}@${pkg.version}`).join("\n");
    if (Buffer.byteLength(display) > 256 * 1024) return false;
    const findings: Finding[] = request.packageCount === 0 ? [] : [{ cls: "system", rule: "pkg.install", program: OPERATION, at: 0, widening: [],
      objects: request.packages.map(pkg => ({ kind: "package", text: pkg.name })),
      says: "Downloads the exact locked public packages for later installation in this project's isolated copy. It does not run their code or enable network access in commands." }];
    // This is a semantic tool description for the shared policy/refusal functions, never a parsed or executable command.
    const cls: Classification = { syntax: "argv", family: "posix", findings, refuse: null, probe: [], needsGit: false, downloads: [],
      programs: [OPERATION], commands: [{ program: OPERATION, args: request.packages.map(pkg => pkg.name), wrappers: [], redirects: [], background: false, family: "posix" }] };
    const about: CommandAsked = { sha256, cwd: "/work", command: OPERATION, os: "linux",
      acts: commandActs(findings, "linux"), named: commandNamed(findings, cls.commands) };
    const audit = (phase: string, extra: Record<string, unknown> = {}) => ctx.audit({ event: "command", phase, tool: OPERATION,
      task: ctx.task.id, target, sha256, lockSha256: request.lockSha256, setSha256: request.setSha256, packageCount: request.packageCount, ...extra });
    if (ctx.refusals?.step([refusalName(target)]) || ctx.refusals?.command(about) || ctx.refusals?.commandLike(about)) {
      audit("dependencies-decided", { verdict: "refuse", rules: ["task.refused"] }); return false;
    }
    const facts = await ctx.service.runner.facts();
    if (!live() || facts.os !== "linux" || ctx.service.capability().state !== "on") return false;
    const mode = ctx.service.mode(), userAskEvery = ctx.service.userAskEvery(), cap = ctx.service.capability();
    const words = ctx.task.commandWords(), checkWords = ctx.task.checkWords?.() ?? words;
    const excluded = [words, ctx.task.spokenWords?.() ?? "", checkWords].some(value => wordsRuleOut(findings, value));
    if (excluded) { audit("dependencies-decided", { verdict: "refuse", rules: ["task.ruled-out"] }); return false; }
    let decision = decideCommand({ cls, paths: new Map(), git: null, binding: ctx.service.binding, facts, mode, userAskEvery,
      userWords: words, agreed: ctx.task.agreed(), tainted: ctx.task.tainted() || ctx.state.outputTainted === true, carried: null });
    const policy = { findings, mode, askEvery: cap.askEvery, userAskEvery, ruledOut: excluded };
    if (ctx.autopilot?.()) {
      if (autopilotRefuses(decision, policy)) return false;
      decision = autopilotCommand(decision, policy) ?? decision;
    } else if (ctx.review && ctx.reviewActive?.() && !notReviewable(decision, { ...policy, words: checkWords, command: display })) {
      const asked = Promise.resolve().then(() => live() ? ctx.review!({ userWords: checkWords, command: display, cwd: "/work", where: ctx.service.binding.label,
        os: "linux", why: "Prepare this exact public dependency set for the user's project; no code runs during preparation.", findings: decision.says }, signal) : null).catch(() => null);
      let stop!: () => void;
      const stopped = new Promise<null>(resolve => { stop = () => resolve(null); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop(); });
      const verdict = await Promise.race([asked, stopped]).finally(() => signal.removeEventListener("abort", stop));
      if (!live()) return false;
      if (verdict?.run && ctx.reviewActive?.()) decision = reviewedDecision(decision, verdict);
    }
    if (!live() || ctx.service.capability().state !== "on" || ctx.service.mode() !== mode || ctx.service.userAskEvery() !== userAskEvery) return false;
    audit("dependencies-decided", { verdict: decision.verdict, classes: decision.classes, rules: decision.rules });
    if (!live() || decision.verdict === "refuse") return false;
    if (decision.verdict === "ask") {
      const question: Question = { title: "May I prepare public dependencies?", context: ctx.task.title, task: ctx.task.id,
        ...(decision.unasked || ctx.task.tainted() ? { taskLine: ctx.task.ownWords?.() ?? "" } : {}),
        prompt: `Download this exact public dependency set for ${ctx.service.binding.label}? Commands stay offline and later execution follows its own approval decision.`,
        detail: display, armMs: decision.armMs, ...(decision.classes.length ? { risky: true } : {}),
        options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] };
      const answer = await ctx.confirmer.ask(question, signal);
      if (!live()) return false;
      const how = ctx.confirmer.howAnswered?.(question);
      audit("dependencies-answered", { answer: answer === null ? "expired" : answer === "once" || answer === "deny" ? answer : "invalid",
        ...(how && ["bubble", "key", "panel", "voice"].includes(how.via) ? { via: how.via, verified: how.verified === true } : {}) });
      if (answer !== "once") {
        ctx.onDeclined?.(answer === null);
        ctx.refusals?.noteStep([refusalName(target)], answer === null ? "waiting" : "refused");
        ctx.refusals?.noteCommand(about, answer === null ? "waiting" : "refused");
        return false;
      }
    } else {
      ctx.presenter.workedWithoutAsking(`Preparing ${request.packageCount} locked public dependencies for ${ctx.service.binding.label}. Commands stay offline; Stop cancels preparation.`);
    }
    if (!live() || ctx.service.capability().state !== "on" || ctx.service.mode() !== mode || ctx.service.userAskEvery() !== userAskEvery) return false;
    audit("dependencies-authorized", { verdict: decision.verdict });
    return live();
  } catch { return false; }
}
