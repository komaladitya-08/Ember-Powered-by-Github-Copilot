/** Project metadata and immutable WSL execution receipts. A selection never grants command consent. */
import { PUBLIC_DEPENDENCY_DISCLOSURE, type ProjectCodingExecutionState } from "../../shared/project-coding";
import { parseTargetId, type TargetId } from "../../shared/targets";
import { WSL_CODING_READINESS } from "../../shared/wsl-coding-readiness";
import type { CommandService } from "../commands/types";
import type { TargetBinding } from "../targets/types";
import type { WslDistro, WslFacts } from "../wsl/types";
import type { WindowsWslCodingBinding } from "./windows-coding-resources";

export interface CapturedWslCodingExecution extends WindowsWslCodingBinding { readonly target: TargetBinding }
export interface ProjectCodingExecutionOptions {
  owner(): string | null;
  projectExists(id: string): boolean;
  facts(): WslFacts | null;
  commands(id: TargetId): CommandService | null;
  /** Trusted Home selection only: fixed user facts from an already-running distro, never a command or launch. */
  userPreparationAllowed?(target: TargetId): boolean;
  prepareDefaultUser?(input: Readonly<{ distro: Readonly<WslDistro>; wslExe: string; current(): boolean }>): Promise<void>;
  /** Relevant settings/admin/consent values, observed synchronously on every settings notification. */
  policy(): unknown;
  open(distro: WslDistro, wslExe: string, current: () => boolean): ReturnType<WindowsWslCodingBinding["open"]>;
}
const unavailable = "The selected WSL distro is unavailable. Choose a discovered WSL2 distro or This computer.";
const disclosure = "WSL coding supports local, offline package installs inside an isolated copy. Network access and public package downloads are unavailable. Captures and reviews exclude .git and node_modules.";
const key = (value: unknown) => JSON.stringify(value);
export class ProjectCodingExecution {
  private owner: string | null = null;
  private choices = new Map<string, TargetId>();
  private publicDependencies = new Set<string>();
  private revision = 0;
  private projectRevisions = new Map<string, number>();
  private observed = "";
  private preparationObserved = "";
  private preparationRevision = 0;
  constructor(private readonly o: ProjectCodingExecutionOptions) { this.refresh(); }
  /** Synchronous notifications latch change-and-restore before a queued model/task resumes. */
  refresh(): void {
    let owner: string | null = null, next: string, preparation: string;
    try {
      owner = this.o.owner();
      const facts = this.o.facts();
      const policy = this.o.policy();
      next = key({ owner, policy, exe: facts?.wslExe, distros: facts?.distros.map(d => ({ name: d.name, version: d.version, defaultUid: d.defaultUid, needsSetup: d.needsSetup, tool: d.tool })) });
      preparation = key({ owner, policy, exe: facts?.wslExe, distros: facts?.distros.map(d => ({ name: d.name, version: d.version, running: d.running, needsSetup: d.needsSetup, tool: d.tool })) });
    } catch { next = preparation = "unavailable"; }
    if (owner !== this.owner) { this.owner = owner; this.choices.clear(); this.publicDependencies.clear(); this.projectRevisions.clear(); }
    if (next !== this.observed) { this.observed = next; this.revision++; }
    if (preparation !== this.preparationObserved) { this.preparationObserved = preparation; this.preparationRevision++; }
    for (const id of new Set([...this.choices.keys(), ...this.projectRevisions.keys(), ...this.publicDependencies])) if (!this.o.projectExists(id)) { this.choices.delete(id); this.publicDependencies.delete(id); this.projectRevisions.delete(id); }
  }
  reset(): void { this.choices.clear(); this.publicDependencies.clear(); this.projectRevisions.clear(); this.revision++; this.preparationRevision++; }
  selected(projectId: string | null): TargetId { this.refresh(); return projectId ? this.choices.get(projectId) ?? "local" : "local"; }
  private distro(id: string): WslDistro | undefined {
    const parsed = parseTargetId(id);
    return parsed?.kind === "wsl" ? this.o.facts()?.distros.find(d => d.name === parsed.name) : undefined;
  }
  private reason(id: TargetId): string | null {
    const distro = this.distro(id);
    if (!distro) return unavailable;
    if (distro.version !== 2) return "WSL coding requires WSL2. This distro uses WSL1.";
    if (distro.needsSetup) return "Open this distro from the Start menu once to finish its setup.";
    if (distro.tool) return "Choose a personal WSL2 distro. Tool-owned distros cannot host coding sessions.";
    if (distro.defaultUid === null) return "Start this distro if needed, then use Check environment to verify its non-root user.";
    if (distro.defaultUid <= 0) return "WSL coding requires a non-root default user in the selected distro.";
    const commands = this.o.commands(id), binding = commands?.binding;
    if (!commands || binding?.id !== id || binding.kind !== "wsl" || binding.shellOs !== "linux") return "Turn on WSL in Computers and allow commands for this distro.";
    const capability = commands.capability();
    if (capability.state !== "on") return capability.why || "Accept the command consent card for this distro in Computers.";
    if (!WSL_CODING_READINESS.ready) return WSL_CODING_READINESS.message;
    return null;
  }
  state(projectId: string): ProjectCodingExecutionState {
    const selected = this.selected(projectId), facts = this.o.facts();
    const choices: ProjectCodingExecutionState["choices"] = [{ id: "local", label: "This computer", selectable: true, ready: true,
      message: "Use the available Windows coding tools and this computer's command settings." }];
    for (const distro of facts?.distros ?? []) {
      const id = `wsl:${distro.name}` as const;
      if (parseTargetId(id)?.kind !== "wsl") continue;
      const message = this.reason(id);
      choices.push({ id, label: `${distro.name} (WSL${distro.version})`, selectable: distro.version === 2 && !distro.needsSetup && !distro.tool,
        ready: message === null, ...(this.canPrepare(projectId, id) ? { canPrepare: true } : {}), message: `${message ?? "Commands use this distro's consent and approval settings."} ${id === selected && this.publicDependencies.has(projectId)
          ? "Commands stay offline. Locked public dependencies can be prepared for this project under its normal approvals. Captures and reviews exclude .git and node_modules." : disclosure}` });
    }
    if (!choices.some(choice => choice.id === selected)) choices.push({ id: selected, label: "Unavailable WSL selection", selectable: false, ready: false, message: `${unavailable} ${disclosure}` });
    const canSelect = !!this.owner && this.o.projectExists(projectId);
    return { selected, choices, canSelect,
      ...(parseTargetId(selected)?.kind === "wsl" ? { publicDependencies: { enabled: this.publicDependencies.has(projectId),
        canChange: canSelect && (this.publicDependencies.has(projectId) || !this.reason(selected)), message: PUBLIC_DEPENDENCY_DISCLOSURE } } : {}),
      message: choices.find(choice => choice.id === selected)!.message };
  }
  choose(projectId: string, target: string): void {
    const state = this.state(projectId), choice = state.choices.find(value => value.id === target);
    if (!state.canSelect || !choice?.selectable || !parseTargetId(target)) throw new Error(unavailable);
    if (target === "local") this.choices.delete(projectId); else this.choices.set(projectId, target as TargetId);
    this.publicDependencies.delete(projectId);
    this.projectRevisions.set(projectId, (this.projectRevisions.get(projectId) ?? 0) + 1);
  }
  private canPrepare(projectId: string, id: TargetId): boolean {
    try {
      const d = this.distro(id);
      return !!this.o.prepareDefaultUser && this.o.userPreparationAllowed?.(id) === true && !!this.owner && this.o.projectExists(projectId) &&
        !!this.o.facts()?.wslExe && !!d && d.version === 2 && !d.needsSetup && !d.tool && d.running && d.defaultUid === null;
    } catch { return false; }
  }
  /** An explicit trusted Home selection may learn a running distro's user. Facts never become execution authority. */
  async prepareSelected(projectId: string, targetId: string, callerCurrent: () => boolean): Promise<void> {
    this.refresh();
    const target = this.selected(projectId), prepare = this.o.prepareDefaultUser?.bind(this.o), distro = this.distro(target), exe = this.o.facts()?.wslExe;
    if (!prepare || target !== targetId || !this.canPrepare(projectId, target) || !distro || !exe) return;
    const owner = this.owner, revision = this.preparationRevision, projectRevision = this.projectRevisions.get(projectId) ?? 0;
    const current = () => {
      try {
        this.refresh();
        return callerCurrent() === true && this.owner === owner && this.o.owner() === owner && this.o.projectExists(projectId) &&
          this.preparationRevision === revision && (this.projectRevisions.get(projectId) ?? 0) === projectRevision && this.selected(projectId) === target && this.o.userPreparationAllowed?.(target) === true;
      } catch { return false; }
    };
    if (!current()) throw new Error(unavailable);
    await prepare(Object.freeze({ distro: Object.freeze({ ...distro }), wslExe: exe, current }));
    if (!current()) throw new Error(unavailable);
  }
  choosePublicDependencies(projectId: string, enabled: boolean): void {
    const state = this.state(projectId);
    if (typeof enabled !== "boolean" || !state.publicDependencies?.canChange || enabled && this.reason(state.selected as TargetId)) throw new Error(unavailable);
    if (enabled) this.publicDependencies.add(projectId); else this.publicDependencies.delete(projectId);
    this.projectRevisions.set(projectId, (this.projectRevisions.get(projectId) ?? 0) + 1);
  }
  /** undefined preserves the native capability; null refuses the explicitly selected WSL backend. */
  capture(projectId: string | null): CapturedWslCodingExecution | null | undefined {
    const id = this.selected(projectId); if (id === "local") return undefined;
    if (!projectId || !this.owner || !this.o.projectExists(projectId) || this.reason(id)) return null;
    const distro = Object.freeze({ ...this.distro(id)! }), exe = this.o.facts()?.wslExe;
    const service = this.o.commands(id), target = service && Object.freeze(structuredClone(service.binding));
    if (!exe || !target) return null;
    const revision = this.revision, projectRevision = this.projectRevisions.get(projectId) ?? 0, owner = this.owner, binding = key(target); let live = true;
    const current = () => {
      if (!live) return false;
      try {
        this.refresh();
        live = this.revision === revision && (this.projectRevisions.get(projectId) ?? 0) === projectRevision && this.owner === owner && this.o.projectExists(projectId) && this.selected(projectId) === id && !this.reason(id) && key(this.o.commands(id)?.binding) === binding;
      } catch { live = false; }
      return live;
    };
    const publicDependencies = this.publicDependencies.has(projectId);
    return Object.freeze({ target, current, ...(publicDependencies ? { publicDependencies: Object.freeze({ current }) } : {}), open: () => {
      if (!current()) return Promise.reject(new Error("The WSL coding selection changed. Start a new request."));
      return this.o.open(distro, exe, current);
    } });
  }
}
