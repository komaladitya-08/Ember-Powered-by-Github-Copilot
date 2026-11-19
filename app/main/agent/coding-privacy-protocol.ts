/** Fixed data-only protocol shared by the trusted coding privacy worker and its host. */
export const CODING_PRIVACY_MAX_TEXT_BYTES = 8 * 1024 * 1024;
export const CODING_PRIVACY_REASONS = Object.freeze([
  "it holds a password, token or key",
  "it holds a private key",
  "it holds a password, PIN or code",
  "a login said that way may be its password",
  "it holds a card number",
  "it holds an account or ID number",
  "it holds a security question's answer",
] as const);
export type CodingPrivacyReason = typeof CODING_PRIVACY_REASONS[number];
export interface CodingPrivacyRequest { type: "scan"; id: number; text: string }
export type CodingPrivacyResponse = { type: "ready"; version: 1 } |
  { type: "result"; id: number; reason: CodingPrivacyReason | null } | { type: "failed"; id: number };
export function codingPrivacyReason(value: unknown): value is CodingPrivacyReason | null {
  return value === null || (typeof value === "string" && (CODING_PRIVACY_REASONS as readonly string[]).includes(value));
}
