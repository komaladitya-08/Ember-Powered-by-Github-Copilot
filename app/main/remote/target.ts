/**
 * The PC's side of a remote target (§5.5; owned by package SC): perception, sidecar, apps, the command runner and gate
 * 1 for one live link. STUB from Step 0a: `remoteTargetParts` has its final signature and throws (nothing can use a
 * remote yet).
 */

import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { LoadedAdminPolicy } from "../admin";
import type { WorkerSystem } from "../agent/worker";
import type { CommandRunner } from "../commands/types";
import type { ActStamp, PerceptionPort, SidecarPort } from "../perception/ports";
import type { PolicyEngine } from "../policy/policy";
import type { TargetBinding } from "../targets/types";
import type { RemoteLink } from "./types";

/** What the targets runtime builds for one live link (remoteTargetParts in app/main/remote/target.ts). */
export interface RemoteTargetParts {
  perception: PerceptionPort;
  sidecar: SidecarPort;
  /** The remote's apps: list cached from apps.list (refreshed at most every 60 s); launch through apps.launch. */
  apps: WorkerSystem["apps"];
  runner: CommandRunner;
  /** Gate 1 for this remote (§2.6's table). */
  policy: PolicyEngine;
  system: WorkerSystem;
  binding: () => TargetBinding;
  onAuthorized(stamp: ActStamp): void;
  dispose(): void;
}

/** The parts of a remote target for one live link (this stub: refuses). */
export function remoteTargetParts(_link: RemoteLink, _o: {
  log: Logger;
  settings: SettingsStore;
  /** The PC's admin policy with its source (R5) and the remote's summary combine into gate 1's inputs. */
  localAdmin: () => LoadedAdminPolicy;
  hostLabel: string;
  login: string;
}): RemoteTargetParts {
  throw new Error("remote targets aren't built yet");
}
