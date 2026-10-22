/**
 * The SSH connections (§5.1; owned by package SA). STUB from Step 0a: `createConnections` has its final signature and
 * refuses every connection, resolution and removal (a ConnectError "not-built"); it never starts ssh.
 */

import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { LoadedAdminPolicy } from "../admin";
import type { AuditLog } from "../policy/audit";
import type { JobHostRef } from "../commands/types";
import type { TargetsDeps } from "../targets/types";
import type { WslService } from "../wsl/types";
import { ConnectError, type Connections, type PromptUi } from "./types";

/** Why every call fails here, in Ember's words. */
const NOT_BUILT = "Ember can't connect to other computers yet.";

/** The SSH connections (this stub: none, ever). */
export function createConnections(_o: {
  log: Logger; os: OS; userData: string; appDir: string; execPath: string; resourcesPath: string; settings: SettingsStore;
  admin: () => LoadedAdminPolicy; prompts: PromptUi; fetch: TargetsDeps["fetch"]; allowLoopback: boolean;
  audit: () => AuditLog | null; pcId: () => string; wsl: () => WslService | null; jobHost: JobHostRef | null;
}): Connections {
  const refuse = () => Promise.reject(new ConnectError(NOT_BUILT, "not-built"));
  return {
    connect: refuse,
    disconnect: async () => undefined,
    link: () => null,
    uninstall: refuse,
    resolve: refuse,
    onProgress: () => () => undefined,
    stopAll: async () => undefined,
    dispose: async () => undefined,
  };
}
