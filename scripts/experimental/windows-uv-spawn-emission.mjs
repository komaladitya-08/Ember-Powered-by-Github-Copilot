/** Closed first-emission observations only. Recognised assembly syntax is an unproven hypothesis, never native admission. */
import { createHash } from "node:crypto";

const issuer = "ember-experimental-windows-uv-spawn-fixed-probe";
export const emissionLimits = Object.freeze({ bytes: 256 * 1024, lines: 10_000, lineBytes: 1024, artifactBytes: 8192 });
export const emissionRefusalReasons = Object.freeze({ unknown: 0, inputType: 1, inputBytes: 2, utf8: 3, byteClass: 4,
  loneCarriage: 5, lineCount: 6, lineBytes: 7, nestedProc: 8, duplicateProc: 9, unmatchedEnd: 10, boundarySyntax: 11,
  unterminatedProc: 12, missingWrappers: 13, callSyntax: 14, externalTransfer: 15, callContract: 16, internal: 17 });
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const functions = ["ember_uv_spawn_CreateNamedPipeA", "ember_uv_spawn_CreateFileA", "ember_uv_spawn_ConnectNamedPipe",
  "ember_uv_spawn_CreateIoCompletionPort", "ember_uv_spawn_CreateProcessW", "ember_uv_spawn_translate_sys_error"];
const delegates = ["__imp_CreateNamedPipeA", "__imp_CreateFileA", "__imp_ConnectNamedPipe", "__imp_CreateIoCompletionPort", "__imp_CreateProcessW", "uv_translate_sys_error"];
const empty = functionId => ({ functionId, delegateId: 0, delegateCalls: 0, callCount: 0, postDelegateCalls: 0, unknownCalls: 0, callMask: 0 });
const result = (status, listing, records = functions.map((_, index) => empty(index + 1))) => freeze({ schema: 1, issuer, review: "not-reviewed", status, listing, functions: records });
const candidate = item => item.delegateId === item.functionId && item.delegateCalls === 1 && item.callCount === 1 && item.postDelegateCalls === 0 && item.unknownCalls === 0 && item.callMask === 1 << (item.functionId - 1);

/** Inspect at most six fixed wrappers. No source line, symbol, path, operand, address or exception leaves this function. */
function inspectOriginalEmission(bytes) {
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

const phase = reason => reason === 0 || reason === 17 ? 0 : reason <= 2 ? 1 : reason <= 5 ? 2 : reason <= 7 ? 3 : reason <= 13 ? 4 : reason <= 15 ? 5 : 6;
const refusal = (reason, functionId = 0, count = 0, mask = 0) => freeze({ schema: 1, phase: phase(reason), reason, functionId,
  count: Math.min(count, emissionLimits.lines), mask });
const fixedId = name => functions.indexOf(name) + 1;
const wrapperMask = bodies => functions.reduce((mask, name, index) => mask | (bodies.has(name) ? 1 << index : 0), 0);
const contractMask = (record, index) => (record.delegateCalls === 0 ? 1 : 0) | (record.delegateCalls > 1 ? 2 : 0) |
  (record.callCount !== 1 ? 4 : 0) | (record.postDelegateCalls ? 8 : 0) | (record.unknownCalls ? 16 : 0) | (record.callMask !== 1 << index ? 32 : 0);
const prefixMask = bytes => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 4 :
  bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 8 : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? 16 : 0;

/** Evidence replay only AFTER the unchanged predicate refuses. It neither changes acceptance nor emits any source or transfer text. */
function diagnoseRefusal(bytes) {
  try {
    if (!Buffer.isBuffer(bytes)) return refusal(1);
    if (bytes.length < 1 || bytes.length > emissionLimits.bytes) return refusal(2);
    const text = bytes.toString("utf8"), prefix = prefixMask(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) return refusal(3, 0, 0, prefix);
    let badBytes = 0, classes = 0;
    for (const code of bytes) {
      if (code > 126) { badBytes++; classes |= 1; }
      else if (code !== 9 && code !== 10 && code !== 13 && code < 32) { badBytes++; classes |= 2; }
    }
    if (badBytes) return refusal(4, 0, badBytes, classes | prefix);
    const carriages = [...text.matchAll(/\r(?!\n)/g)].length;
    if (carriages) return refusal(5, 0, carriages);
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    if (lines.length > emissionLimits.lines) return refusal(6, 0, lines.length);
    const longLine = lines.find(line => line.length > emissionLimits.lineBytes);
    if (longLine !== undefined) return refusal(7, 0, longLine.length);
    const bodies = new Map(); let active = null, body = [];
    for (const raw of lines) {
      const line = raw.replace(/;.*$/, "").trim();
      const begin = /^([A-Za-z_?$@.][A-Za-z0-9_?$@.]*)\s+PROC(?:\s+.*)?$/.exec(line);
      const end = /^([A-Za-z_?$@.][A-Za-z0-9_?$@.]*)\s+ENDP$/.exec(line);
      if (begin) {
        if (active !== null) return refusal(8, fixedId(active), 0, wrapperMask(bodies));
        if (bodies.has(begin[1])) return refusal(9, fixedId(begin[1]), 0, wrapperMask(bodies));
        active = begin[1]; body = [];
      } else if (end) {
        if (active !== end[1]) return refusal(10, fixedId(active ?? end[1]), 0, wrapperMask(bodies));
        bodies.set(active, body); active = null; body = [];
      } else if (active !== null) body.push(line);
      else if (/\b(?:PROC|ENDP)\b/.test(line)) return refusal(11, 0, 0, wrapperMask(bodies));
    }
    if (active !== null) return refusal(12, fixedId(active), 0, wrapperMask(bodies));
    const missing = 63 ^ wrapperMask(bodies);
    if (missing) return refusal(13, functions.findIndex((_, index) => missing & 1 << index) + 1,
      functions.filter((_, index) => missing & 1 << index).length, missing);
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
          else { record.callMask |= 1 << delegate; if (delegate === index) record.delegateCalls++; }
        } else {
          if (/\bcall\b/i.test(line)) return refusal(14, index + 1);
          const branch = /^(?:j[a-z]+|loop[a-z]*)\s+(.+)$/i.exec(line);
          if (branch && !labels.has(branch[1].replace(/^(?:SHORT|NEAR\s+PTR)\s+/i, "").trim())) return refusal(15, index + 1);
        }
      }
      if (record.delegateCalls === 1 && record.callCount === 1 && !record.postDelegateCalls && !record.unknownCalls && record.callMask === 1 << index) record.delegateId = index + 1;
      records.push(record);
    }
    // Transfer refusals above retain priority over the original final all-records predicate.
    const index = records.findIndex(record => !candidate(record));
    return index < 0 ? refusal(0) : refusal(16, index + 1, records[index].callCount, contractMask(records[index], index));
  } catch { return refusal(17); }
}

/** Artifact schema 2 adds closed refusal evidence; the original status and function observations are preserved verbatim. */
export function inspectWindowsUvSpawnEmission(bytes) {
  const previous = inspectOriginalEmission(bytes);
  return freeze({ ...previous, schema: 2, refusal: previous.status === "refused" ? diagnoseRefusal(bytes) : null });
}

const strict = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= emissionLimits.lines;
const integer = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum;
function validRefusal(value, metadata) {
  if (!strict(value, ["schema", "phase", "reason", "functionId", "count", "mask"]) || value.schema !== 1 || !integer(value.reason, 17) ||
      value.phase !== phase(value.reason) || !integer(value.functionId, 6) || !bounded(value.count) || !integer(value.mask, 63)) return false;
  const r = value.reason, f = value.functionId, c = value.count, m = value.mask;
  const byteMinimum = (m & 4 ? 3 : m & 1 ? 1 : 0) + (m & 2 ? 1 : 0);
  if (r === 0 || r === 17) return f === 0 && c === 0 && m === 0;
  if ((r === 1 || r === 2) !== (metadata.listing === null)) return false;
  if ([4, 5, 6, 7, 16].includes(r) && c > metadata.listing.bytes || r === 3 && (m === 4 && metadata.listing.bytes < 4 ||
      (m === 8 || m === 16) && metadata.listing.bytes < 2)) return false;
  if (r <= 7 && f !== 0) return false;
  if (r <= 2 && (c || m) || r === 3 && (c || ![0, 4, 8, 16].includes(m)) || r === 4 && (!c || !(m & 3) || m > 7 || m & 4 && !(m & 1) || c < byteMinimum) ||
      r === 5 && (!c || m) || r === 6 && (c !== emissionLimits.lines || m) || r === 7 && (c <= emissionLimits.lineBytes || m)) return false;
  if (r >= 8 && r <= 12 && c !== 0) return false;
  if (r === 11 && f !== 0 || r === 9 && f !== 0 && !(m & 1 << (f - 1)) ||
      (r === 8 || r === 12) && f !== 0 && !!(m & 1 << (f - 1))) return false;
  if (r === 13 && (!m || c !== functions.filter((_, index) => m & 1 << index).length || f !== functions.findIndex((_, index) => m & 1 << index) + 1)) return false;
  if ((r === 14 || r === 15) && (!f || c || m)) return false;
  if (r === 16) {
    const index = metadata.functions.findIndex(record => !candidate(record));
    if (index < 0 || f !== index + 1 || c !== metadata.functions[index].callCount || m !== contractMask(metadata.functions[index], index) || !m) return false;
  }
  if (r < 16 && metadata.functions.some(record => Object.keys(empty(record.functionId)).some(key => record[key] !== empty(record.functionId)[key]))) return false;
  return true;
}
/** Parse only the closed public artifact. Candidate status recognises syntax; review remains explicitly pending. */
export function parseWindowsUvSpawnEmission(bytes) {
  const fail = () => { throw new Error("The fixed observer emission metadata was refused."); };
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > emissionLimits.artifactBytes) fail();
    const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes)) fail(); const value = JSON.parse(text);
    if (!strict(value, ["schema", "issuer", "review", "status", "listing", "functions", "refusal"]) || value.schema !== 2 || value.issuer !== issuer ||
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
    if (value.status === "candidate" ? value.refusal !== null : !validRefusal(value.refusal, value)) fail();
    return freeze(value);
  } catch { fail(); }
}
