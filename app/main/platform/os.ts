/** Process platform facts read at the platform boundary. Other main-process modules consume these instead of probing the host. */
import type { OS } from "../../shared/shortcuts";

/** Exact Node platform and architecture: use these when unsupported systems must fail closed. */
export const HOST_PLATFORM: NodeJS.Platform = process.platform;
export const HOST_ARCH: string = process.arch;

/** "linux" for anything that isn't Windows or macOS (they fail the environment's platform check, as today). */
export const HOST_OS: OS = HOST_PLATFORM === "win32" ? "win32" : HOST_PLATFORM === "darwin" ? "darwin" : "linux";
