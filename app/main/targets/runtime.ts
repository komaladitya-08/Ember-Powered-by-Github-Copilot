/**
 * The targets runtime (§2; owned by package TG). STUB from Step 0a: a local-only runtime with the final exported
 * signatures. It knows only this computer: `handsFor("local")` gives today's hands with no commands, `caps()` is all
 * false (so the prompts keep today's exact texts), nothing is listed, offered, connected or shown, and no doctor row is
 * added. Main doesn't build it yet (Step 0b wires it); TG replaces this file with the real runtime.
 */

import type { OS } from "../../shared/shortcuts";
import type { TargetId, TargetSummary } from "../../shared/targets";
import type { LoadedAdminPolicy } from "../admin";
import type { PlatformDoctorRow, SystemPlatform } from "../platform/types";
import type { TargetBinding, TargetHands, TargetsDeps, TargetsForAgent, TargetsRuntime } from "./types";

/** This computer's label everywhere a target is named (§8.1). */
const LOCAL_LABEL = "This computer";
/** What the model hears when it names a computer the user didn't (§2.3). */
const NOT_NAMED = "The user didn't name that computer. Use the one they chose, or ask them.";
/** The words that name this computer (§2.3 rule 4, without the OS-specific ones). */
const LOCAL_WORDS = /^(local|here|locally|(this|my) (computer|pc|mac|laptop|machine))$/;

/** The targets runtime main builds once: this stub knows only this computer (see the module comment). */
export function createTargets(deps: TargetsDeps): TargetsRuntime {
  const binding = (): TargetBinding => ({
    id: "local", kind: "local", label: LOCAL_LABEL, screenOs: deps.os, shellOs: deps.os,
    desktop: deps.localHands ? "screen" : "none",
    ...(deps.localHands ? {} : { desktopWhy: "Ember can't use this computer's screen here." }),
  });
  const handsFor = (id: TargetId): { ok: true; hands: TargetHands } | { ok: false; why: string } => {
    if (id !== "local") return { ok: false, why: "Ember works only on this computer for now." };
    if (!deps.localHands) return { ok: false, why: "Ember can't use this computer's screen here, and commands aren't available yet." };
    return {
      ok: true,
      hands: {
        ...deps.localHands, binding: binding(), system: deps.sys, commands: null,
        grantKey: app => app.toLowerCase(), leaseKey: key => key,
      },
    };
  };
  const agent: TargetsForAgent = {
    active: "local",
    bind: o => {
      const choice = o.choice?.trim().toLowerCase().replace(/\s+/g, " ");
      if (choice && !LOCAL_WORDS.test(choice)) return { ok: false, why: NOT_NAMED };
      return { ok: true, binding: binding() };
    },
    handsFor,
    describeTargets: () => `<computers>\n- ${LOCAL_LABEL}: ${deps.localHands ? "apps" : "no desktop"}; no commands\n</computers>`,
    describeScreen: id => (id === "local" || id.startsWith("wsl:") ? null : Promise.resolve("That computer isn't connected.")),
    offerConnect: () => "Ember can't connect to other computers yet. Tell the user.",
    activeLine: () => "",
    caps: () => ({ commands: false, targets: false }),
  };
  const summary = (): TargetSummary => ({
    id: "local", kind: "local", label: LOCAL_LABEL, state: "ready", can: deps.localHands ? "apps" : "no desktop", active: true,
  });
  return {
    agent,
    wsl: null,
    stopAll: async () => undefined,
    busy: () => ({ commands: 0, connections: 0 }),
    menuItems: () => [],
    bubbleAction: () => false,
    quickContext: () => null,
    questionChanged: () => undefined,
    panelReady: () => false,
    questionWords: () => null,
    doctorRows: async () => [],
    summaries: () => [summary()],
    dispose: async () => undefined,
  };
}

/** The doctor's and setup check's target rows (§8.8): none from this stub. */
export async function targetDoctorRows(_o: { os: OS; sys: SystemPlatform; admin: () => LoadedAdminPolicy; resourcesPath: string; packaged: boolean }): Promise<PlatformDoctorRow[]> {
  return [];
}
