/** Select a fixed host capability by platform, before any request or model can choose a backend. */
import { HOST_PLATFORM } from "../platform/os";
import { ProjectCodingResources, type ProjectCodingResourcesOptions } from "./coding-resources";
import { WindowsProjectCodingResources } from "./windows-coding-resources";
import type { CodingCommandWorkspace, CodingPlatformAdapter } from "./coding-platform";
import type { ScopedCodingHost, ScopedCodingCapability } from "./host";
import { ScopedCodingFileError, type CodingReviewWorkspace } from "./coding-platform";
import type { TaskSpec } from "./worker";

export type ProjectCodingResourcesPort = Pick<ProjectCodingResources, "folders" | "reviewBase" | "results" |
  "validateSource" | "workspace" | "captureContinuation" | "continuationCurrent" | "publish" | "invalidate" | "close"> & {
  /** Display only. This argument grants no workspace or execution authority. Linux keeps its existing disclosure. */
  availability(disclosure?: "files-only" | "commands"): ReturnType<ProjectCodingResources["availability"]> & { canContinue?: boolean };
};
type CommonHost = Omit<ScopedCodingHost, "mode" | "platform" | "createWorkspace" | "captureCapability" | "toolchain" | "current">;
export interface ProjectCodingBackend {
  readonly ready: Promise<ProjectCodingResourcesPort>;
  host(common: CommonHost, localCommandsEnabled?: () => boolean): ScopedCodingHost;
}

export function createProjectCodingBackend(options: ProjectCodingResourcesOptions): ProjectCodingBackend {
  if (HOST_PLATFORM === "win32") {
    const ready = WindowsProjectCodingResources.createNode(options);
    return Object.freeze({ ready, host(common: CommonHost, localCommandsEnabled?: () => boolean): ScopedCodingHost {
      const select = localCommandsEnabled, nodes = new WeakMap<CodingReviewWorkspace, CodingPlatformAdapter>(),
        files = new WeakMap<CodingReviewWorkspace, Pick<CodingPlatformAdapter, "files">>();
      const nodePlatform: CodingPlatformAdapter = Object.freeze({
        facts(workspace: CodingCommandWorkspace, facts: Parameters<CodingPlatformAdapter["facts"]>[1]) {
          const platform = nodes.get(workspace); if (!platform) throw new ScopedCodingFileError("boundary");
          return platform.facts(workspace, facts);
        },
        files: (workspace: CodingReviewWorkspace, signal: AbortSignal) => {
          const platform = nodes.get(workspace); if (!platform) return Promise.reject(new ScopedCodingFileError("boundary"));
          return platform.files(workspace, signal);
        },
      });
      const filePlatform = Object.freeze({ files: (workspace: CodingReviewWorkspace, signal: AbortSignal) => {
        const platform = files.get(workspace); if (!platform) return Promise.reject(new ScopedCodingFileError("boundary"));
        return platform.files(workspace, signal);
      } });
      return Object.freeze({ ...common, mode: "commands", get reviewBase() { return common.reviewBase; },
        // No caller may bypass intake selection by using the static compatibility surface directly.
        createWorkspace: () => Promise.reject(new ScopedCodingFileError("boundary")),
        captureCapability(): ScopedCodingCapability | null {
          let on: unknown; try { on = select?.(); } catch { return null; }
          if (on !== true && on !== false) return null;
          if (!on) return Object.freeze({ mode: "files-only", platform: filePlatform,
            createWorkspace: async (spec: TaskSpec, signal: AbortSignal, admit: () => boolean) => {
              if (!admit() || signal.aborted) throw new ScopedCodingFileError("cancelled");
              const resource = await ready;
              if (!admit() || signal.aborted) throw new ScopedCodingFileError("cancelled");
              const workspace = await resource.createFileWorkspace(spec, signal, admit); files.set(workspace, resource.filePlatform); return workspace;
            } });
          let live = true;
          const current = () => {
            if (!live) return false;
            try { live = select?.() === true; } catch { live = false; }
            return live;
          };
          return Object.freeze({ mode: "commands", toolchain: "windows-node", platform: nodePlatform, current,
            createWorkspace: async (spec: TaskSpec, signal: AbortSignal, admit: () => boolean) => {
              const admitted = () => current() && admit();
              if (!admitted() || signal.aborted) throw new ScopedCodingFileError("cancelled");
              const resource = await ready;
              if (!admitted() || signal.aborted) throw new ScopedCodingFileError("cancelled");
              const workspace = await resource.createNodeWorkspace(spec, signal, admitted); nodes.set(workspace, resource.nodePlatform); return workspace;
            } });
        },
      });
    } });
  }
  const ready = ProjectCodingResources.create(options);
  return Object.freeze({ ready, host(common: CommonHost): ScopedCodingHost {
    return { ...common, mode: "commands", get reviewBase() { return common.reviewBase; },
      createWorkspace: async (spec, signal, admit) => (await ready).createWorkspace(spec, signal, admit) };
  } });
}
