// Types for mac-bundle.mjs (stage.mjs and the unit tests import it).
export type RunResult = { status: number | null; stdout: string; stderr: string };
export declare const BUNDLE_ID: string;
export declare const EXECUTABLE: string;
export declare const INFO_PLIST_DROP: string[];
export declare const ENTITLEMENTS: string[];
export declare const FORBIDDEN_ENTITLEMENTS: string[];
export declare function entitlementsPlist(): string;
export declare function infoPlistValues(version: string): [string, "string" | "bool", string | boolean][];
export declare function finishMacBundle(o: {
  app: string;
  version: string;
  svg: string;
  tmp: string;
  run?: (file: string, args: string[]) => RunResult;
  writeIconset: (svg: string, dir: string) => Promise<void>;
  log?: (line: string) => void;
}): Promise<void>;
