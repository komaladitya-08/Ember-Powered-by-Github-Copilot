// Types for release.mjs (the unit tests import it).
export declare function releaseFiles(version: string): string[];
export declare function releaseNotes(changelog: string, version: string, o: { repo: string; ref: string }): string;
export declare function releaseProblems(present: string[], version: string): string[];
export declare function unwrap(lines: string[]): string[];
