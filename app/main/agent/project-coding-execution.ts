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
  constructor(private readonly o: ProjectCodingExecutionOptions) { this.refresh(); }
  /** Synchronous notifications latch change-and-restore before a queued model/task resumes. */
  refresh(): void {
    let owner: string | null = null, next: string;
    try {
      owner = this.o.owner();
      const facts = this.o.facts();
      next = key({ owner, policy: this.o.policy(), exe: facts?.wslExe, distros: facts?.distros.map(d => ({ name: d.name, version: d.version, defaultUid: d.defaultUid, needsSetup: d.needsSetup, tool: d.tool })) });
    } catch { next = "unavailable"; }
    if (owner !== this.owner) { this.owner = owner; this.choices.clear(); this.publicDependencies.clear(); this.projectRevisions.clear(); }
    if (next !== this.observed) { this.observed = next; this.revision++; }
    for (const id of new Set([...this.choices.keys(), ...this.projectRevisions.keys(), ...this.publicDependencies])) if (!this.o.projectExists(id)) { this.choices.delete(id); this.publicDependencies.delete(id); this.projectRevisions.delete(id); }
  }
  reset(): void { this.choices.clear(); this.publicDependencies.clear(); this.projectRevisions.clear(); this.revision++; }
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
    if (distro.defaultUid === null) return "Open this distro once so Ember can verify its non-root user, then refresh Computers.";
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
    const choices = [{ id: "local", label: "This computer", selectable: true, ready: true,
      message: "Use the available Windows coding tools and this computer's command settings." }];
    for (const distro of facts?.distros ?? []) {
      const id = `wsl:${distro.name}` as const;
      if (parseTargetId(id)?.kind !== "wsl") continue;
      const message = this.reason(id);
      choices.push({ id, label: `${distro.name} (WSL${distro.version})`, selectable: distro.version === 2 && !distro.needsSetup && !distro.tool,
        ready: message === null, message: `${message ?? "Commands use this distro's consent and approval settings."} ${id === selected && this.publicDependencies.has(projectId)
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
