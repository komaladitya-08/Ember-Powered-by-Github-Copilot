/**
 * Fixed trusted worker entry. Project text is data, passed whole to the same privacy guard used elsewhere.
 * The build bundles this entry into a host constant. It imports no filesystem, SDK, account or credential code.
 */
import { parentPort } from "node:worker_threads";
import { memoryRefusal } from "../memory/guard";
import { CODING_PRIVACY_MAX_TEXT_BYTES, codingPrivacyReason, type CodingPrivacyRequest, type CodingPrivacyResponse } from "./coding-privacy-protocol";

const port = parentPort;
if (!port) throw new Error("The coding privacy worker requires its host port.");
port.on("message", (value: unknown) => {
  const input = value as Partial<CodingPrivacyRequest> | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "id,text,type" ||
      input.type !== "scan" || !Number.isSafeInteger(input.id) || input.id! < 1 || typeof input.text !== "string" ||
      Buffer.byteLength(input.text) > CODING_PRIVACY_MAX_TEXT_BYTES) {
    // No caller input, exception or stdout/stderr is reflected to the host.
    port.close(); return;
  }
  const id = input.id!;
  try {
    const reason = memoryRefusal(input.text);
    port.postMessage(codingPrivacyReason(reason) ? { type: "result", id, reason } satisfies CodingPrivacyResponse : { type: "failed", id } satisfies CodingPrivacyResponse);
  } catch {
    port.postMessage({ type: "failed", id } satisfies CodingPrivacyResponse);
  } finally {
    input.text = "";
  }
});
port.postMessage({ type: "ready", version: 1 } satisfies CodingPrivacyResponse);
