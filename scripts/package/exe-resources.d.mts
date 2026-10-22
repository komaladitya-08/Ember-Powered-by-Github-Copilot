// Types for exe-resources.mjs (stage.mjs and the unit tests import it).

export interface ExeResources {
  /** Whether the file has a certificate table (an Authenticode signature, valid or not). */
  signed: boolean;
  versions: {
    lang: string | number;
    fileVersion: number[];
    productVersion: number[];
    strings: { lang: number; codepage: number; values: Record<string, string> }[];
  }[];
  iconGroups: {
    id: string | number;
    lang: string | number;
    icons: { width: number; height: number; bitCount: number; dataSize: number }[];
  }[];
}

export declare function numericVersion(version: string): [number, number, number, number];
export declare function exeVersionStrings(o: { version: string; company: string; exe?: string }): Record<string, string>;
export declare function certificateTable(bin: Buffer): { offset: number; size: number };
export declare function rewriteExeResources(bin: Buffer, o: { version: string; company: string; ico: Buffer }): Buffer;
export declare function readExeResources(bin: Buffer): ExeResources;
export declare function exeResourceMismatches(read: ExeResources, o: { version: string; company: string; ico: Buffer }): string[];
