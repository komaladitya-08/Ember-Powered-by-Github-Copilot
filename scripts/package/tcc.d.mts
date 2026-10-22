// Types for tcc.mjs (the unit tests import it).

export type Run = (file: string, args: string[], input?: string) => { status: number | null; stdout: string; stderr: string };
interface Common { run: Run; home: string; uid: number; now: number; log: (line: string) => void; sleep: (ms: number) => void }

export declare const SYSTEM_DB: string;
export declare const SYSTEM_SERVICES: string[];
export declare const APPLE_EVENTS: string;
export declare const SYSTEM_EVENTS: string;
export declare const SYSTEM_EVENTS_REQUIREMENT: string;
export declare const CAPTURE_APPROVED_UNTIL: string;
export declare function userDb(home: string): string;
export declare function captureApprovals(home: string): string;
export declare function appleAnchorRequirement(identifier: string): string;
export declare function grantSql(g: { service: string; client: string; clientType: 0 | 1; csreq?: string | null; target?: string | null; targetCsreq?: string | null; now: number }): string;
export declare function pathGrants(clients: string[], now: number): { system: string[]; user: string[] };
export declare function bundleGrants(bundleId: string, csreq: string, now: number): { system: string[]; user: string[] };
export declare function transaction(statements: string[]): string;
export declare function designatedRequirement(output: string): string;
export declare function showSql(services: string[]): string;
export declare function ancestors(pid: number, ps: (pid: number) => { ppid: number; comm: string } | null): string[];
export declare function parsePs(line: string): { ppid: number; comm: string } | null;
export declare function restartTccd(o: Pick<Common, "run" | "uid" | "log" | "sleep">): void;
export declare function grantPaths(o: Common & { clients: string[] }): void;
export declare function grantBundle(o: Common & { app: string; tmp: string }): { bundleId: string; requirement: string };
export declare function approveCapture(o: Pick<Common, "run" | "home" | "log"> & { binaries: string[] }): void;
export declare function showGrants(o: Pick<Common, "run" | "home" | "log">): void;
