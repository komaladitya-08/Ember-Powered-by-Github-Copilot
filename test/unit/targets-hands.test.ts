/**
 * The hands a worker gets on each target (§2.6's table, targets/hands.ts): this screen's own objects for "local" and a
 * WSL distro with unchanged lease keys (critique wsl-13), commands-only hands without a window system whose ports refuse
 * every read and action, and a remote's parts with its own gate 1, keyed grants and leases, no flight and no borrowed
 * mouse (L4).
 */

import { describe, expect, it, vi } from "vitest";
import type { Hands } from "../../app/main/agent/host";
import type { WorkerSystem } from "../../app/main/agent/worker";
import type { CommandService } from "../../app/main/commands/types";
import type { PerceptionPort, SidecarPort } from "../../app/main/perception/ports";
import type { RemoteTargetParts } from "../../app/main/remote/target";
import { hostBinding, localBinding, refusingPerception, refusingSidecar, remoteHands, screenHands, wslBinding } from "../../app/main/targets/hands";

const hands: Hands = {
  perception: { tag: "perception" } as unknown as PerceptionPort, sidecar: { tag: "sidecar" } as unknown as SidecarPort,
  policy: { tag: "policy" } as unknown as Hands["policy"], audit: { tag: "audit" } as unknown as Hands["audit"],
  confirmer: { tag: "confirmer" } as unknown as Hands["confirmer"], flyTo: vi.fn(), currentWindow: () => ({ pid: 4, title: "Notes" }),
  cursor: { tag: "cursor" } as unknown as Hands["cursor"], clipboard: { tag: "clipboard" } as unknown as Hands["clipboard"],
};
const system = { os: "win32" } as unknown as WorkerSystem;
const commands = { tag: "commands" } as unknown as CommandService;

describe("bindings", () => {
  it("binds this computer to its screen, or to commands only without a window system", () => {
    expect(localBinding("linux", true)).toEqual({ id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" });
    expect(localBinding("win32", false)).toMatchObject({ desktop: "none", desktopWhy: "Ember can't use this computer's screen here." });
  });

  it("judges a distro's windows as Windows' and runs its commands in Linux; WSL 1 and Podman are commands only", () => {
    expect(wslBinding({ name: "Ubuntu", version: 2 }, true)).toEqual({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", screenOs: "win32", shellOs: "linux", desktop: "screen" });
    expect(wslBinding({ name: "Old", version: 1 }, true)).toMatchObject({ desktop: "none", desktopWhy: "Old runs WSL 1, which shows no Linux apps." });
    expect(wslBinding({ name: "podman-machine-default", version: 2, tool: "podman" }, true)).toMatchObject({ desktop: "none" });
    expect(wslBinding({ name: "Ubuntu", version: 2 }, false)).toMatchObject({ desktop: "none" });
  });

  it("binds an unconnected host with no desktop and says why", () => {
    expect(hostBinding({ id: "build-01", resolved: { user: "deploy", hostname: "b", port: 22, jump: [] } }))
      .toEqual({ id: "ssh:build-01", kind: "ssh", label: "build-01", login: "deploy", screenOs: "linux", shellOs: "linux", desktop: "none", desktopWhy: "build-01 isn't connected." });
  });
});

describe("this screen's hands (local and WSL)", () => {
  it("are main's own objects with the binding, system and commands added, grants lower-case and leases unchanged", () => {
    const h = screenHands({ hands, base: null, binding: localBinding("linux", true), system, commands })!;
    // (Its perception and sidecar are main's, telling whether the task used them: see below.)
    for (const k of Object.keys(hands) as (keyof Hands)[]) if (k !== "perception" && k !== "sidecar") expect(h[k]).toBe(hands[k]);
    expect(h.system.os).toBe("win32");
    expect(h.commands).toBe(commands);
    expect(h.grantKey("GEdit")).toBe("gedit");
    expect(h.leaseKey("100:notes")).toBe("100:notes");
    expect(h.onAuthorized).toBeUndefined();
  });

  it("give a WSL task the same window lease keys as a local one, so the two exclude each other (critique wsl-13)", () => {
    const local = screenHands({ hands, base: null, binding: localBinding("win32", true), system, commands: null })!;
    const wsl = screenHands({ hands, base: null, binding: wslBinding({ name: "Ubuntu", version: 2 }, true), system, commands })!;
    expect(wsl.leaseKey("0x1234:gedit")).toBe(local.leaseKey("0x1234:gedit"));
    expect(wsl.binding.id).toBe("wsl:Ubuntu");
    expect(wsl.grantKey("wsl:ubuntu:gedit")).toBe("wsl:ubuntu:gedit");
  });

  it("tell whether their own task used this screen: a read, a picture, a step, an app opened, Ember's desk (review #81)", async () => {
    const read = vi.fn(async () => "seen"), perceive = vi.fn(async () => "picture"), doAction = vi.fn(async () => true);
    const launch = vi.fn(), desk = vi.fn(async () => "place");
    const mine = { ...hands, perception: { ...refusingPerception("no"), read, perceive }, sidecar: { ...refusingSidecar("no"), doAction }, desk } as unknown as Hands;
    const sys = { os: "linux", apps: { list: () => [], launch } } as unknown as WorkerSystem;
    const make = (binding = localBinding("linux", true)) => screenHands({ hands: mine, base: null, binding, system: sys, commands })!;
    const reads = make(), pictures = make(wslBinding({ name: "Ubuntu", version: 2 }, true)), steps = make(), opens = make(), desks = make(), commandsOnly = make();
    expect(reads.usedDesktop?.()).toBe(false);
    await expect(reads.perception.read({})).resolves.toBe("seen");
    expect(reads.usedDesktop?.()).toBe(true);
    await expect(pictures.perception.perceive({ image: true, scope: "screen" })).resolves.toBe("picture");
    expect(pictures.usedDesktop?.()).toBe(true);
    steps.sidecar.scaleOf(1);
    steps.sidecar.stop();
    expect(steps.usedDesktop?.()).toBe(false);
    await expect(steps.sidecar.doAction(3, "click")).resolves.toBe(true);
    expect(doAction).toHaveBeenCalledWith(3, "click");
    expect(steps.usedDesktop?.()).toBe(true);
    opens.system.apps.launch({ id: "gedit.desktop", name: "Text Editor" } as never);
    expect(launch).toHaveBeenCalledWith({ id: "gedit.desktop", name: "Text Editor" });
    expect(opens.usedDesktop?.()).toBe(true);
    await expect(desks.desk?.()).resolves.toBe("place");
    expect(desks.usedDesktop?.()).toBe(true);
    // Commands and listing the apps aren't this screen: such a task goes on when it locks. Each task's hands speak only
    // for that task.
    expect(commandsOnly.commands).toBe(commands);
    commandsOnly.system.apps.list();
    expect(commandsOnly.usedDesktop?.()).toBe(false);
  });

  it("keep this screen's reason for its system-dialog check (secure keyboard entry, Wayland), which counts as a use", async () => {
    const why = "secure keyboard entry is on in Terminal";
    const mine = { ...hands, perception: { ...refusingPerception("no"), systemDialogReason: vi.fn(async () => why) } } as unknown as Hands;
    const h = screenHands({ hands: mine, base: null, binding: localBinding("darwin", true), system, commands })!;
    await expect(h.perception.systemDialogReason?.()).resolves.toBe(why);
    expect(h.usedDesktop?.()).toBe(true);
    const plain = screenHands({ hands: { ...hands, perception: refusingPerception("no") }, base: null, binding: localBinding("linux", true), system, commands })!;
    expect(plain.perception.systemDialogReason).toBeUndefined();
  });

  it("without a window system carry commands only: every read and action refuses, nothing flies, no window starts a task", async () => {
    const base = { audit: hands.audit, confirmer: hands.confirmer, policy: hands.policy };
    const h = screenHands({ hands: null, base, binding: localBinding("linux", false), system, commands })!;
    expect(h.audit).toBe(hands.audit);
    expect(h.currentWindow()).toBeNull();
    expect(() => h.flyTo({ x: 1, y: 1, width: 5, height: 5 })).not.toThrow();
    expect(h.cursor).toBeUndefined();
    await expect(h.perception.perceive({ image: true, scope: "screen" })).rejects.toThrow(/no desktop to work in on this computer/);
    await expect(h.sidecar.doAction(1, "click")).rejects.toThrow(/run_command/);
    expect(() => h.sidecar.stop()).not.toThrow();
    expect(screenHands({ hands: null, base: null, binding: localBinding("linux", false), system, commands })).toBeNull();
  });

  it("refusing ports refuse every call", async () => {
    const p = refusingPerception("no");
    for (const f of [p.focused(), p.read({}), p.atPoint({}, { x: 0, y: 0 }), p.quickContext(), p.describe(), p.perceive({ image: false, scope: "window" }), p.systemDialogOpen(), p.windows()]) {
      await expect(f).rejects.toThrow("no");
    }
    const s = refusingSidecar("no");
    for (const f of [s.readElement(1), s.canDo(1, "click"), s.doAction(1), s.setText(1, "x"), s.setValue(1, 2), s.selectOption(1, "a"), s.listOptions(1)]) {
      await expect(f).rejects.toThrow("no");
    }
    expect(s.scaleOf(1)).toBe(1);
  });
});

describe("a remote's hands", () => {
  const onAuthorized = vi.fn();
  const remotePerception = { read: vi.fn(async () => "seen"), windows: vi.fn(async () => []), perceive: vi.fn(async () => "picture") };
  const remoteSidecar = { doAction: vi.fn(async () => true), readElement: vi.fn(async () => null), scaleOf: vi.fn(() => 1), stop: vi.fn() };
  const launch = vi.fn(async () => undefined);
  const parts = {
    perception: remotePerception, sidecar: remoteSidecar, policy: { tag: "remote-policy" },
    system: { os: "linux", keys: { tag: "keys" }, apps: { list: () => [], launch } },
    binding: () => ({ id: "ssh:build-01", kind: "ssh", label: "build-01", login: "deploy", screenOs: "linux", shellOs: "linux", desktop: "text" }),
    onAuthorized,
  } as unknown as RemoteTargetParts;

  it("use the remote's perception, sidecar, gate 1 and system with main's audit and Confirmer", async () => {
    const h = remoteHands({ hostId: "build-01", parts, base: { audit: hands.audit, confirmer: hands.confirmer }, commands });
    await expect(h.perception.read({} as never)).resolves.toBe("seen");
    expect(remotePerception.read).toHaveBeenCalled();
    await expect(h.sidecar.doAction(3, "click")).resolves.toBe(true);
    expect(remoteSidecar.doAction).toHaveBeenCalledWith(3, "click");
    await h.system.apps.launch({ id: "gedit.desktop", name: "Text Editor" } as never);
    expect(launch).toHaveBeenCalledWith({ id: "gedit.desktop", name: "Text Editor" });
    expect(h.system.os).toBe("linux");
    expect(h.system.keys).toBe(parts.system.keys);
    expect(h.policy).toBe(parts.policy);
    expect(h.audit).toBe(hands.audit);
    expect(h.confirmer).toBe(hands.confirmer);
    expect(h.binding.desktop).toBe("text");
  });

  it("tell whether their own task used the remote's desktop: a read, a picture, a step or an app opened (§5.3.4 step 8)", async () => {
    const make = () => remoteHands({ hostId: "build-01", parts, base: { audit: hands.audit, confirmer: hands.confirmer }, commands });
    const reads = make(), pictures = make(), steps = make(), opens = make(), commandsOnly = make();
    expect(reads.usedDesktop()).toBe(false);
    await reads.perception.windows();
    expect(reads.usedDesktop()).toBe(true);
    await pictures.perception.perceive({} as never);
    expect(pictures.usedDesktop()).toBe(true);
    steps.sidecar.scaleOf(1);
    steps.sidecar.stop();
    expect(steps.usedDesktop()).toBe(false);
    await steps.sidecar.readElement(1);
    expect(steps.usedDesktop()).toBe(true);
    await opens.system.apps.launch({ id: "gedit.desktop", name: "Text Editor" } as never);
    expect(opens.usedDesktop()).toBe(true);
    // Commands and listing the apps aren't the desktop; and each task's hands speak only for that task.
    expect(commandsOnly.commands).toBe(commands);
    commandsOnly.system.apps.list();
    expect(commandsOnly.usedDesktop()).toBe(false);
  });

  it("key grants and leases by the target, never fly, never start from a window, and borrow nothing (L4)", () => {
    const h = remoteHands({ hostId: "build-01", parts, base: { audit: hands.audit, confirmer: hands.confirmer }, commands: null });
    expect(h.grantKey("GEdit")).toBe("ssh:build-01:gedit");
    expect(h.leaseKey("77:notes")).toBe("ssh:build-01|77:notes");
    expect(h.currentWindow()).toBeNull();
    expect(h.cursor).toBeUndefined();
    expect(h.clipboard).toBeUndefined();
    expect(h.desk).toBeUndefined();
    expect(h.pointer).toBeUndefined();
    expect(h.commands).toBeNull();
  });

  it("hand the worker's authorisation of a step to the remote's parts", () => {
    const h = remoteHands({ hostId: "build-01", parts, base: { audit: hands.audit, confirmer: hands.confirmer }, commands });
    const stamp = { taskId: "t", kind: "click", app: "gedit", window: "w", element: null, verdict: "confirm", approval: { given: true }, ageMs: 5 } as const;
    h.onAuthorized!(stamp);
    expect(onAuthorized).toHaveBeenCalledWith(stamp);
  });
});
