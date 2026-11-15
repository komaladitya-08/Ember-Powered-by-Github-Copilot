// Types for check-client-id.mjs (the unit tests import it).
export declare const TRIES: number;
export declare function deviceCodeVerdict(answer: { status?: number; body?: string; failed?: string }): { verdict: "pass" | "retry" | "fail"; says: string };
export declare function checkClientId(o: {
  id: string;
  ask: (body: URLSearchParams) => Promise<{ status: number; body: string }>;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
}): Promise<number>;
