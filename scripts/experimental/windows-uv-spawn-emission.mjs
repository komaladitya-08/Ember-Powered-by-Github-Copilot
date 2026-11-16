/** Closed first-emission observations only. Recognised assembly syntax is an unproven hypothesis, never native admission. */
import { createHash } from "node:crypto";

const issuer = "ember-experimental-windows-uv-spawn-fixed-probe";
export const emissionLimits = Object.freeze({ bytes: 256 * 1024, lines: 10_000, lineBytes: 1024, artifactBytes: 8192 });
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const functions = ["ember_uv_spawn_CreateNamedPipeA", "ember_uv_spawn_CreateFileA", "ember_uv_spawn_ConnectNamedPipe",
  "ember_uv_spawn_CreateIoCompletionPort", "ember_uv_spawn_CreateProcessW", "ember_uv_spawn_translate_sys_error"];
const delegates = ["__imp_CreateNamedPipeA", "__imp_CreateFileA", "__imp_ConnectNamedPipe", "__imp_CreateIoCompletionPort", "__imp_CreateProcessW", "uv_translate_sys_error"];
const empty = functionId => ({ functionId, delegateId: 0, delegateCalls: 0, callCount: 0, postDelegateCalls: 0, unknownCalls: 0, callMask: 0 });
const result = (status, listing, records = functions.map((_, index) => empty(index + 1))) => freeze({ schema: 1, issuer, review: "not-reviewed", status, listing, functions: records });
const candidate = item => item.delegateId === item.functionId && item.delegateCalls === 1 && item.callCount === 1 && item.postDelegateCalls === 0 && item.unknownCalls === 0 && item.callMask === 1 << (item.functionId - 1);

/** Inspect at most six fixed wrappers. No source line, symbol, path, operand, address or exception leaves this function. */
export function inspectWindowsUvSpawnEmission(bytes) {
  let listing = null;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > emissionLimits.bytes) return result("refused", null);
    listing = { bytes: bytes.length, sha256: hash(bytes) };
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes) || bytes.some(code => code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)) || /\r(?!\n)/.test(text)) return result("refused", listing);
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    if (lines.length > emissionLimits.lines || lines.some(line => line.length > emissionLimits.lineBytes)) return result("refused", listing);
    const bodies = new Map(); let active = null, body = [];
    for (const raw of lines) {
      const line = raw.replace(/;.*$/, "").trim();
      const begin = /^([A-Za-z_?$@.][A-Za-z0-9_?$@.]*)\s+PROC(?:\s+.*)?$/.exec(line);
      const end = /^([A-Za-z_?$@.][A-Za-z0-9_?$@.]*)\s+ENDP$/.exec(line);
      if (begin) {
        if (active !== null || bodies.has(begin[1])) return result("refused", listing);
        active = begin[1]; body = [];
      } else if (end) {
        if (active !== end[1]) return result("refused", listing);
        bodies.set(active, body); active = null; body = [];
      } else if (active !== null) body.push(line);
      else if (/\b(?:PROC|ENDP)\b/.test(line)) return result("refused", listing);
    }
    if (active !== null || !functions.every(name => bodies.has(name))) return result("refused", listing);
    const records = [];
    for (const [index, name] of functions.entries()) {
      const record = empty(index + 1), body = bodies.get(name);
      const labels = new Set(body.map(line => /^([A-Za-z_?$@.][A-Za-z0-9_?$@.]*)\s*:$/.exec(line)?.[1]).filter(Boolean));
      for (const line of body) {
        const call = /^call\s+(.+)$/i.exec(line);
        if (call) {
          record.callCount++;
          if (record.delegateCalls) record.postDelegateCalls++;
          const operand = call[1].replace(/^QWORD\s+PTR\s+/i, "").trim(), delegate = delegates.indexOf(operand);
          if (delegate < 0) record.unknownCalls++;
          else {
            record.callMask |= 1 << delegate;
            if (delegate === index) record.delegateCalls++;
          }
        } else {
          // MSVC /FA is expected to emit one instruction per line. Inline/indirect transfers remain refused.
          if (/\bcall\b/i.test(line)) return result("refused", listing);
          const branch = /^(?:j[a-z]+|loop[a-z]*)\s+(.+)$/i.exec(line);
          if (branch && !labels.has(branch[1].replace(/^(?:SHORT|NEAR\s+PTR)\s+/i, "").trim())) return result("refused", listing);
        }
      }
      if (record.delegateCalls === 1 && record.callCount === 1 && !record.postDelegateCalls && !record.unknownCalls && record.callMask === 1 << index) record.delegateId = index + 1;
      records.push(record);
    }
    return result(records.every(candidate) ? "candidate" : "refused", listing, records);
  } catch { return result("refused", listing); }
}

const strict = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= emissionLimits.lines;
/** Parse only the closed public artifact. Candidate status recognises syntax; review remains explicitly pending. */
export function parseWindowsUvSpawnEmission(bytes) {
  const fail = () => { throw new Error("The fixed observer emission metadata was refused."); };
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > emissionLimits.artifactBytes) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) fail(); const value = JSON.parse(text);
    if (!strict(value, ["schema", "issuer", "review", "status", "listing", "functions"]) || value.schema !== 1 || value.issuer !== issuer ||
        value.review !== "not-reviewed" || !["candidate", "refused"].includes(value.status) || !Array.isArray(value.functions) || value.functions.length !== 6) fail();
    if (value.listing !== null && (!strict(value.listing, ["bytes", "sha256"]) || !Number.isSafeInteger(value.listing.bytes) || value.listing.bytes < 1 || value.listing.bytes > emissionLimits.bytes ||
        typeof value.listing.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.listing.sha256))) fail();
    for (const [index, item] of value.functions.entries()) {
      if (!strict(item, ["functionId", "delegateId", "delegateCalls", "callCount", "postDelegateCalls", "unknownCalls", "callMask"]) || item.functionId !== index + 1 ||
          ![0, index + 1].includes(item.delegateId) || ![item.delegateCalls, item.callCount, item.postDelegateCalls, item.unknownCalls].every(bounded) ||
          !Number.isInteger(item.callMask) || item.callMask < 0 || item.callMask > 63 || item.delegateCalls > item.callCount || item.postDelegateCalls > item.callCount || item.unknownCalls > item.callCount ||
          (item.delegateCalls > 0) !== !!(item.callMask & 1 << index) || item.delegateId !== 0 && !candidate(item)) fail();
    }
    if (value.status === "candidate" && (value.listing === null || !value.functions.every(candidate)) || value.status === "refused" && value.functions.every(candidate) ||
        value.listing === null && value.functions.some(item => item.delegateId || item.delegateCalls || item.callCount || item.postDelegateCalls || item.unknownCalls || item.callMask)) fail();
    return freeze(value);
  } catch { fail(); }
}
