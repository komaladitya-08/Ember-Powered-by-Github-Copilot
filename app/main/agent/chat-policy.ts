/**
 * The organisation's policy (app/main/admin.ts) as a native chat session takes it: the SDK's own `managedSettings`
 * where the SDK has a counterpart, the permission modes the policy leaves open, and whether a person may approve for
 * longer than once. It can only tighten (the policy's rule): a policy that can't be used, or one that turns acting
 * off, allows no chat session at all. A field the SDK has nothing for is left out here, never guessed at (the
 * neverLook list, models, the actions-a-minute limit, screenshots, memory, SSH, WSL and the rest): the registry and
 * the report that introduced this say which. Pure.
 */

import type { ManagedSettings } from "@github/copilot-sdk";
import { commandMode, type LoadedAdminPolicy } from "../admin";
import { CHAT_PERMISSION_MODES, type ChatPermissionMode } from "../../shared/chat";

/** What the organisation's policy makes of a chat session. */
export interface ChatPolicy {
  /** Passed to the SDK as the session's `managedSettings` (on create and again on every resume). */
  managedSettings: ManagedSettings;
  /** The permission modes the policy allows; Ember refuses the others itself too, whatever the SDK does. */
  permissionModes: readonly ChatPermissionMode[];
  /** false: a person may only approve once or reject (no session, folder or permanent approval). */
  standing: boolean;
}

/**
 * The SDK's rules for "ask before everything", each checked against the bundled runtime (1.0.97: a malformed rule
 * fails the session's creation). The runtime has no rule that covers every web address (`Domain(*)` matches none),
 * so a URL is held to asking by the bypass being disabled instead: in the manual mode every fetch asks.
 */
export const ASK_EVERYTHING = ["Shell", "Read", "Write", "Mcp(*)", "CustomTool(*)"] as const;

/**
 * The chat policy under `loaded`, or null when the organisation allows no chat session: its policy couldn't be used
 * (LOCKDOWN), it changed while Ember ran (held until a restart), or it turned acting off (`features.actions: false`).
 *
 * - `approvals.maxMode` caps the SDK's modes as it caps Ember's: Interactive allows only manual, Assisted adds
 *   assisted, Autopilot leaves allow-all too (`disableBypassPermissionsMode`, `disableAssistedPermissionsMode`).
 * - `features.aiReview: false` turns the SDK's assisted judge off (`disableAssistedPermissionsMode`).
 * - `features.autonomy: false`, `allowGrants: false` and `confirmEveryAction` keep every request with a person: no
 *   allow-all, no judge, and nothing approved for longer than once (`standing: false`).
 * - `confirmEveryAction` also asks before every command, read, write, MCP and custom tool (ASK_EVERYTHING).
 * - Commands on this computer (`commands.local`, as `commandMode` reads it): "off" denies the shell, "ask" asks for it.
 * - `features.extensions: false` denies every MCP tool.
 */
export function chatPolicy(loaded: LoadedAdminPolicy): ChatPolicy | null {
  if (loaded.error !== undefined || loaded.held) return null;
  const p = loaded.policy;
  if (p.features.actions === false) return null;
  const cap = p.approvals?.maxMode;
  const holds = p.features.autonomy === false || p.allowGrants === false || p.confirmEveryAction;
  const noAllowAll = holds || cap === "interactive" || cap === "assisted";
  const noAssisted = holds || cap === "interactive" || p.features.aiReview === false;
  const ask = new Set<string>();
  const deny = new Set<string>();
  if (p.confirmEveryAction) for (const rule of ASK_EVERYTHING) ask.add(rule);
  const shell = commandMode(loaded, "local");
  if (shell === "off") deny.add("Shell");
  else if (shell === "ask") ask.add("Shell");
  if (p.features.extensions === false) deny.add("Mcp(*)");
  const permissions: NonNullable<ManagedSettings["permissions"]> = {
    ...(noAllowAll ? { disableBypassPermissionsMode: "disable" } : {}),
    ...(noAssisted ? { disableAssistedPermissionsMode: true } : {}),
    ...(ask.size ? { ask: [...ask] } : {}),
    ...(deny.size ? { deny: [...deny] } : {}),
  };
  return {
    managedSettings: Object.keys(permissions).length ? { permissions } : {},
    permissionModes: CHAT_PERMISSION_MODES.filter(m => !(m === "allow-all" && noAllowAll) && !(m === "assisted" && noAssisted)),
    standing: !holds,
  };
}
