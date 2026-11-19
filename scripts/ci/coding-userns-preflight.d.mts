export const codingUsernsProfile: string;
export const codingNamespaceProbe: readonly string[];
export function codingBwrapAudit(text: string): Array<{ profile: string; operation: string; capability: number | null; capname: string | null }>;
export function prepareCodingUserns(): Promise<void>;
