export interface WindowsNodeToolchainMember { readonly source: string; readonly name: string; readonly bytes: number; readonly sha256: string; readonly ship: boolean }
export const WINDOWS_NODE_TOOLCHAIN: Readonly<{
  schema: 1; issuer: "ember-windows-node-toolchain-v1"; platform: "win32"; arch: "x64"; version: string;
  sourceCommit: string; sourceArchiveSha256: string; producerCommit: string; producerRun: number; producerArtifact: number;
  scope: "offline-root-only-node";
  compatibility: Readonly<{ moduleResolutionFlags: readonly string[]; testIsolationFlag: string; implicitArguments: false; shell: false; children: false; network: false; dependencyInstallation: false }>;
  files: readonly WindowsNodeToolchainMember[];
}>;
export const WINDOWS_NODE_TOOLCHAIN_DIRECTORY: "coding/windows-node-x64";
export function verifyWindowsNodeToolchain(directory: string, kind?: "producer" | "package"): Readonly<{ schema: 1; issuer: string; files: number }>;
export function stageWindowsNodeToolchain(source: string, destination: string): Readonly<{ schema: 1; issuer: string; files: number }>;
