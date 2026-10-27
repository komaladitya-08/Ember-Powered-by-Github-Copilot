// Types for licences.mjs (the unit tests import it).
export declare const spdxIds: (expr: string | null | undefined) => string[];
export declare const specLicenceIds: (spec: string) => string[];
export declare const BUNDLED_LIBRARIES: { package: RegExp; libraries: Record<string, string[]> }[];
export declare function readmeLibraries(readme: string | null | undefined): [string, string][];
export declare const LICENCE_TEXTS: { package: RegExp; version?: string; texts: string[] }[];
export declare function suppliedLicence(name: string, version: string): { texts: string[] } | { error: string };
export declare function uncoveredLicences(packages: { name: string; license: string | null | undefined; readme: string | null }[], specIds: string[]): string[];
