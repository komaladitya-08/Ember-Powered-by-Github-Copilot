/** Fixed host computation, never project code. It validates complete drafts off the main event loop. */
import { parentPort } from "node:worker_threads";
import { prepareCodingDraftImportData } from "./coding-draft-import-data";
import { CodingDraftError, validateCodingDraft } from "./coding-draft-format";
const port = parentPort;
if (!port) throw new Error("The coding draft worker requires its host port.");
port.once("message", (input: unknown) => {
  try {
    const value = input as { metadata?: unknown; document?: unknown; decode?: unknown; fresh?: { metadata?: unknown; document?: unknown } } | null;
    if (!value || !["decode,document,metadata", "decode,document,fresh,metadata"].includes(Object.keys(value).sort().join(",")) || !(value.document instanceof Uint8Array) || typeof value.decode !== "boolean") throw new CodingDraftError("invalid");
    const document = Buffer.from(value.document.buffer, value.document.byteOffset, value.document.byteLength);
    const result = validateCodingDraft(value.metadata, document);
    if (value.fresh) {
      if (Object.keys(value.fresh).sort().join(",") !== "document,metadata" || !(value.fresh.document instanceof Uint8Array)) throw new CodingDraftError("invalid");
      const source = value.fresh.document, fresh = validateCodingDraft(value.fresh.metadata, Buffer.from(source.buffer, source.byteOffset, source.byteLength));
      port.postMessage({ ok: true, metadata: result.metadata, imported: prepareCodingDraftImportData(result.decoded, fresh.decoded) });
    } else port.postMessage({ ok: true, metadata: result.metadata, preview: result.preview, ...(value.decode ? { decoded: result.decoded } : {}) });
  } catch (error) {
    port.postMessage({ ok: false, code: error instanceof CodingDraftError ? error.code : "invalid" });
  } finally { port.close(); }
});
