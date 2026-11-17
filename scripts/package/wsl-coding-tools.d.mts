export const WSL_CODING_TOOLS: Readonly<{
  schema: number; version: string; url: string; integrity: string; filename: string; bytes: number; sha256: string;
  license: string; licenseBytes: number; licenseSha256: string; noticeBytes: number; noticeSha256: string;
}>;
export const WSL_CODING_TOOLS_DIRECTORY: "wsl-coding";
export function readWslCodingTypeScriptArchive(target: string): Buffer;
export function verifyWslCodingTools(source: string): Readonly<{ schema: 1; version: string; files: number }>;
export function stageWslCodingTools(source: string, destination: string): Readonly<{ schema: 1; version: string; files: number }>;
export function prepareWslCodingTools(root: string): Promise<Readonly<{ schema: 1; version: string; files: number }>>;
