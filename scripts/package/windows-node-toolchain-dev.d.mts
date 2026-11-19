import type fs from "node:fs";
export type WindowsNodeToolchainDevelopmentResult = Readonly<{ status: "skipped-platform" | "skipped-absent" | "staged" | "verified"; files: number }>;
export interface WindowsNodeToolchainDevelopmentOptions { required?: boolean }
export function stageWindowsNodeToolchainDevelopment(options?: WindowsNodeToolchainDevelopmentOptions): WindowsNodeToolchainDevelopmentResult;
export function bindWindowsNodeToolchainDevelopment(dependencies?: {
  files?: typeof fs; root?: string; platform?: NodeJS.Platform; arch?: string;
  resolvePackage?(): string;
  verifyToolchain?(directory: string, kind: "producer" | "package"): Readonly<{ files: number }>;
  stageToolchain?(source: string, destination: string): unknown;
  fence?: object;
}): (options?: WindowsNodeToolchainDevelopmentOptions) => WindowsNodeToolchainDevelopmentResult;
