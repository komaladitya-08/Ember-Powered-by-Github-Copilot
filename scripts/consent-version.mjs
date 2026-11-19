// Desktop test profiles represent a user who agreed to this checkout's current global consent card.
// Read the TypeScript source without executing it, so plain Node scripts follow future card changes too.
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/shared/consent.ts", import.meta.url), "utf8");
const match = /^export const CONSENT_VERSION = (\d+);\r?$/m.exec(source);
export const consentVersion = Number(match?.[1]);
if (!Number.isSafeInteger(consentVersion) || consentVersion < 1) {
  throw new Error("Can't read CONSENT_VERSION from app/shared/consent.ts.");
}
