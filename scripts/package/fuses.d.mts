// Types for fuses.mjs (the unit tests import it).
export type FuseValue = boolean | string;
export declare const SENTINEL: string;
export declare const WIRE_VERSION: number;
export declare const FUSES: string[];
export declare const EMBER_FUSES: Record<string, boolean>;
export declare function fatArchCount(bin: Buffer): number;
export declare function findWire(bin: Buffer): { start: number; length: number };
export declare function readFuses(bin: Buffer): Record<string, FuseValue>;
export declare function setFuses(bin: Buffer, config: Record<string, boolean>): Record<string, FuseValue>;
export declare function fuseMismatches(fuses: Record<string, FuseValue>, config: Record<string, boolean>): string[];
export declare function flipFuses(file: string, config: Record<string, boolean>): Record<string, FuseValue>;
