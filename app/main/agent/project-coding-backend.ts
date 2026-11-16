/** Select a fixed host capability by platform, before any request or model can choose a backend. */
import { HOST_PLATFORM } from "../platform/os";
import { ProjectCodingResources, type ProjectCodingResourcesOptions } from "./coding-resources";
import { WindowsProjectCodingResources } from "./windows-coding-resources";
import { WindowsFileOnlyWorkspace } from "./windows-file-only-workspace";
import type { ScopedCodingHost } from "./host";
import { ScopedCodingFileError, type CodingReviewWorkspace } from "./coding-platform";

export type ProjectCodingResourcesPort = Pick<ProjectCodingResources, "folders" | "reviewBase" | "results" | "availability" |
  "validateSource" | "workspace" | "captureContinuation" | "continuationCurrent" | "publish" | "invalidate" | "close">;
type CommonHost = Omit<ScopedCodingHost, "mode" | "platform" | "createWorkspace">;
export interface ProjectCodingBackend {
  readonly ready: Promise<ProjectCodingResourcesPort>;
  host(common: CommonHost): ScopedCodingHost;
}

export function createProjectCodingBackend(options: ProjectCodingResourcesOptions): ProjectCodingBackend {
  if (HOST_PLATFORM === "win32") {
    const ready = WindowsProjectCodingResources.create(options), owned = new WeakSet<CodingReviewWorkspace>();
    return Object.freeze({ ready, host(common: CommonHost): ScopedCodingHost {
      return { ...common, mode: "files-only", get reviewBase() { return common.reviewBase; },
        createWorkspace: async (spec, signal, admit) => {
          const workspace = await (await ready).createWorkspace(spec, signal, admit); owned.add(workspace); return workspace;
        },
        platform: { files: (workspace, signal) => {
          if (!owned.has(workspace) || !(workspace instanceof WindowsFileOnlyWorkspace)) return Promise.reject(new ScopedCodingFileError("boundary"));
          return workspace.filesBroker(signal);
        } },
      };
    } });
  }
  const ready = ProjectCodingResources.create(options);
  return Object.freeze({ ready, host(common: CommonHost): ScopedCodingHost {
    return { ...common, mode: "commands", get reviewBase() { return common.reviewBase; },
      createWorkspace: async (spec, signal, admit) => (await ready).createWorkspace(spec, signal, admit) };
  } });
}
