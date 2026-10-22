/** The OS this process runs on, for data defaults that are read at module load (settings' never-look default). Everything else asks the Platform object (D1). */
import type { OS } from "../../shared/shortcuts";

/** "linux" for anything that isn't Windows or macOS (they fail the environment's platform check, as today). */
export const HOST_OS: OS = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
