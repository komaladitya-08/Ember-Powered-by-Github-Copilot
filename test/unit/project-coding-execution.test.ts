import { beforeEach, expect, it, vi } from "vitest";
import type { CommandService } from "../../app/main/commands/types";
import type { WslFacts } from "../../app/main/wsl/types";
const gate = vi.hoisted(() => ({ ready: false }));
vi.mock("../../app/shared/wsl-coding-readiness", () => ({ WSL_CODING_READINESS: { get ready() { return gate.ready; }, message: "Windows isolation verification must pass." } }));
import { ProjectCodingExecution } from "../../app/main/agent/project-coding-execution";
const P = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { gate.ready = false; });
function setup() {
  const state = { otherProject: false, owner: "owner" as string | null, policy: "on", consent: true, project: true };
  const facts: WslFacts = { installed: true, wslExe: "C:\\Windows\\System32\\wsl.exe", wslVersion: "2", wslg: { available: false, disabledByUser: false, version: null },
    distros: [{ name: "Ubuntu", version: 2, isDefault: true, defaultUid: 1000, running: false, needsSetup: false }] };
  const binding = { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", shellOs: "linux", screenOs: "win32", desktop: "none" } as const;
  let service = { binding, capability: () => ({ state: state.consent ? "on" : "needs-consent", why: "Accept this distro's command consent.", askEvery: null }) } as unknown as CommandService;
  const open = vi.fn(async () => ({ connection: {} as never, typescriptArchive: Buffer.from("pinned") }));
  const value = new ProjectCodingExecution({ owner: () => state.owner, projectExists: id => state.project && (id === P || state.otherProject && id === "other"),
    facts: () => facts, commands: id => id === "wsl:Ubuntu" ? service : null, policy: () => ({ policy: state.policy, consent: state.consent }), open });
  return { value, state, facts, binding, open, replaceService: (next: CommandService) => { service = next; } };
}
it("keeps the real Windows qualification gate closed while allowing explicit preparation metadata", () => {
  const f = setup(); expect(f.value.selected(P)).toBe("local"); expect(f.open).not.toHaveBeenCalled();
  f.value.choose(P, "wsl:Ubuntu"); expect(f.value.state(P)).toMatchObject({ selected: "wsl:Ubuntu", message: expect.stringContaining("Windows isolation verification must pass.") });
  expect(f.value.state(P).message).toContain("offline package installs"); expect(f.value.state(P).message).toContain("Network access and public package downloads are unavailable");
  expect(f.value.state(P).message).toContain("exclude .git and node_modules"); expect(f.value.state(P).message.length).toBeLessThanOrEqual(512);
  expect(f.value.capture(P)).toBeNull(); expect(f.open).not.toHaveBeenCalled();
});
it("refuses unknown/WSL1/tool-owned/setup-pending choices without launching or installing", () => {
  const f = setup();
  for (const [name, version, tool, needsSetup] of [["Legacy", 1, undefined, false], ["Podman", 2, "podman", false], ["Pending", 2, undefined, true]] as const)
    f.facts.distros.push({ name, version, tool, needsSetup, isDefault: false, running: false, defaultUid: 1000 });
  for (const id of ["wsl:Missing", "wsl:Legacy", "wsl:Podman", "wsl:Pending", "ssh:host", "wsl:../x"]) expect(() => f.value.choose(P, id)).toThrow();
  expect(f.value.selected(P)).toBe("local"); expect(f.open).not.toHaveBeenCalled();
});
it.each([null, 0])("refuses execution with an unknown or root default user (%s)", uid => {
  gate.ready = true; const f = setup(); f.facts.distros[0].defaultUid = uid;
  f.value.choose(P, "wsl:Ubuntu"); expect(f.value.capture(P)).toBeNull(); expect(f.value.state(P).choices[1].ready).toBe(false);
});
it("requires the exact distro's consent and never grants it through selection", () => {
  gate.ready = true; const f = setup(); f.state.consent = false; f.value.choose(P, "wsl:Ubuntu");
  expect(f.value.capture(P)).toBeNull(); expect(f.value.state(P).message).toContain("consent"); expect(f.state.consent).toBe(false);
});
it("captures immutable exact execution authority and preserves local behavior", async () => {
  gate.ready = true; const f = setup(); expect(f.value.capture(P)).toBeUndefined(); f.value.choose(P, "wsl:Ubuntu");
  const receipt = f.value.capture(P); expect(receipt).toBeTruthy();
  expect(f.value.state(P).message).toContain("offline package installs"); expect(f.value.state(P).message).toContain("Network access and public package downloads are unavailable"); expect(receipt!.target).toEqual(f.binding); expect(Object.isFrozen(receipt!.target)).toBe(true);
  await receipt!.open(); expect(f.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "Ubuntu", version: 2 }), f.facts.wslExe, receipt!.current);
  expect(receipt!.current()).toBe(true);
});
it.each(["policy", "consent", "owner", "distro", "selection", "forget", "project", "binding"])("retires a captured receipt after %s changes and cannot revive after restore", async kind => {
  gate.ready = true; const f = setup(); f.value.choose(P, "wsl:Ubuntu"); const receipt = f.value.capture(P)!;
  if (kind === "policy") { f.state.policy = "off"; f.value.refresh(); f.state.policy = "on"; f.value.refresh(); }
  if (kind === "consent") { f.state.consent = false; f.value.refresh(); f.state.consent = true; f.value.refresh(); }
  if (kind === "owner") { f.state.owner = "other"; f.value.refresh(); f.state.owner = "owner"; f.value.refresh(); }
  if (kind === "distro") { f.facts.distros[0].version = 1; f.value.refresh(); f.facts.distros[0].version = 2; f.value.refresh(); }
  if (kind === "selection") { f.value.choose(P, "local"); f.value.choose(P, "wsl:Ubuntu"); }
  if (kind === "forget") f.value.reset();
  if (kind === "project") f.state.project = false;
  if (kind === "binding") f.replaceService({ binding: { ...f.binding, label: "changed" }, capability: () => ({ state: "on", askEvery: null }) } as unknown as CommandService);
  expect(receipt.current()).toBe(false); await expect(receipt.open()).rejects.toThrow("changed"); expect(f.open).not.toHaveBeenCalled();
});
it("keeps a removed distro selected and refused without silently falling back", () => {
  const f = setup(); f.value.choose(P, "wsl:Ubuntu"); f.facts.distros = [];
  expect(f.value.state(P)).toMatchObject({ selected: "wsl:Ubuntu", choices: expect.arrayContaining([expect.objectContaining({ id: "wsl:Ubuntu", ready: false, selectable: false })]) });
  expect(f.value.capture(P)).toBeNull();
});

it("keeps one project's captured execution current when only another project's selection changes", () => {
  gate.ready = true; const f = setup(); f.state.otherProject = true; f.value.choose(P, "wsl:Ubuntu"); const receipt = f.value.capture(P)!;
  f.value.choose("other", "wsl:Ubuntu"); f.value.choose("other", "local"); expect(receipt.current()).toBe(true);
  f.value.choose(P, "local"); expect(receipt.current()).toBe(false);
});

it("captures project public-download intent without launching, approving a set or upgrading an older intake", () => {
  gate.ready = true; const f = setup(); f.value.choose(P, "wsl:Ubuntu"); const offline = f.value.capture(P)!;
  expect(offline.publicDependencies).toBeUndefined();
  expect(f.value.state(P).publicDependencies).toMatchObject({ enabled: false, canChange: true });
  f.value.choosePublicDependencies(P, true); const opted = f.value.capture(P)!;
  expect(offline.current()).toBe(false); expect(opted.publicDependencies?.current()).toBe(true);
  expect(Object.isFrozen(opted.publicDependencies)).toBe(true); expect(f.open).not.toHaveBeenCalled();
  expect(f.value.state(P).message).toContain("normal approvals");
  expect(f.value.state(P).publicDependencies?.message).toContain("Package names and versions");
});
it("latches opt-out and restore without reviving an old public dependency receipt", async () => {
  gate.ready = true; const f = setup(); f.value.choose(P, "wsl:Ubuntu"); f.value.choosePublicDependencies(P, true); const receipt = f.value.capture(P)!;
  f.value.choosePublicDependencies(P, false); f.value.choosePublicDependencies(P, true);
  expect(receipt.current()).toBe(false); expect(receipt.publicDependencies?.current()).toBe(false);
  await expect(receipt.open()).rejects.toThrow("changed"); expect(f.open).not.toHaveBeenCalled();
});
it.each(["owner", "target", "forget", "project"] as const)("does not restore a public dependency opt-in after %s replacement", kind => {
  gate.ready = true; const f = setup(); f.value.choose(P, "wsl:Ubuntu"); f.value.choosePublicDependencies(P, true); const captured = f.value.capture(P)!;
  if (kind === "owner") { f.state.owner = "other"; f.value.refresh(); f.state.owner = "owner"; f.value.refresh(); }
  if (kind === "target") { f.value.choose(P, "local"); f.value.choose(P, "wsl:Ubuntu"); }
  if (kind === "forget") f.value.reset();
  if (kind === "project") { f.state.project = false; f.value.refresh(); f.state.project = true; }
  expect(captured.publicDependencies?.current()).toBe(false);
  if (f.value.selected(P) === "local") f.value.choose(P, "wsl:Ubuntu");
  expect(f.value.state(P).publicDependencies?.enabled).toBe(false); expect(f.value.capture(P)?.publicDependencies).toBeUndefined();
});
it("requires ready consent for opt-in but always permits withdrawal under a newly closed gate", () => {
  const f = setup(); f.value.choose(P, "wsl:Ubuntu"); expect(() => f.value.choosePublicDependencies(P, true)).toThrow();
  gate.ready = true; f.value.choosePublicDependencies(P, true); const receipt = f.value.capture(P)!;
  f.state.consent = false; f.value.refresh(); expect(receipt.publicDependencies?.current()).toBe(false);
  expect(f.value.state(P).publicDependencies?.canChange).toBe(true);
  expect(() => f.value.choosePublicDependencies(P, true)).toThrow(); f.value.choosePublicDependencies(P, false);
  expect(f.value.state(P).publicDependencies).toMatchObject({ enabled: false, canChange: false });
});
