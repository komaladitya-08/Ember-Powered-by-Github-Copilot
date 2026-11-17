/** Duplicate keys are evidence: reject them, escaped aliases and excessive containers before JSON.parse loses them. */
export function parseBoundedCodingJson(text: string, limits: { depth: number; containers: number; keyBytes: number }): unknown {
  const bad = () => new Error("The bounded coding document is invalid.");
  const stack: { kind: "object" | "array"; keys: Set<string>; key: boolean }[] = []; let containers = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i; for (i++; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') break; }
      if (i >= text.length) throw bad();
      const parent = stack.at(-1);
      if (parent?.kind === "object" && parent.key) {
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        if (typeof key !== "string" || Buffer.byteLength(key) > limits.keyBytes || parent.keys.has(key)) throw bad();
        parent.keys.add(key); parent.key = false;
      }
    } else if (c === "{" || c === "[") {
      if (stack.length >= limits.depth || ++containers > limits.containers) throw bad();
      stack.push({ kind: c === "{" ? "object" : "array", keys: new Set(), key: c === "{" });
    } else if (c === "}" || c === "]") {
      if (stack.pop()?.kind !== (c === "}" ? "object" : "array")) throw bad();
    } else if (c === ",") { const parent = stack.at(-1); if (parent?.kind === "object") parent.key = true; }
  }
  if (stack.length) throw bad(); return JSON.parse(text);
}
