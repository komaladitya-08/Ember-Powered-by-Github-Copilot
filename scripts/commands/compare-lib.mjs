/** The audit comparison's closed verdict ordering and narrow, whole-command job-count exception. */
const RANKS = { classifier: { run: 0, announce: 1, ask: 2, refuse: 3 }, flow: { RAN: 0, ASKED: 2, REFUSED: 3 } };

/** Parse arithmetic made only from integer literals, parentheses and ordinary arithmetic operators; never evaluate it. */
function numericArithmetic(value) {
  const match = /^\$\(\((.*)\)\)$/.exec(value);
  const text = match?.[1].replace(/\s/g, "");
  if (!text || text.length > 256 || !/^[\d()+*/%-]+$/.test(text) || /\+\+|--/.test(text)) return false;
  let at = 0;
  const operand = () => {
    if (text[at] === "+" || text[at] === "-") at++;
    if (text[at] === "(") {
      at++;
      if (!expression() || text[at++] !== ")") return false;
      return true;
    }
    const number = /^\d+/.exec(text.slice(at));
    if (!number) return false;
    at += number[0].length;
    return true;
  };
  const expression = () => {
    if (!operand()) return false;
    while (at < text.length && /[+*/%-]/.test(text[at])) { at++; if (!operand()) return false; }
    return true;
  };
  return expression() && at === text.length;
}

/** A count is exempt only as the sole job-count option of a known tool; no appended target, pipeline or variable. */
export function isAllowedJobCount(command) {
  const match = /^(?:(?:make|gmake|ctest) -j\s*|cmake --build build -j\s*|pytest -n\s*|sort --parallel=|\.\/gradlew --max-workers=)(.+)$/.exec(command);
  if (!match) return false;
  let value = match[1];
  if (value.startsWith("'")) return /^'\d+'$/.test(value);
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return false;
    value = value.slice(1, -1);
  }
  return /^\d+$/.test(value) || /^\$\((?:nproc|getconf _NPROCESSORS_ONLN|sysctl -n hw\.ncpu)\)$/.test(value)
    || numericArithmetic(value);
}

/** Compare every classifier decision and every flow stage. Missing/unknown results fail closed, never acquire a rank. */
export function compareResults(cases, before, after) {
  const changes = [], errors = [];
  let decisions = 0;
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== cases.length || after.length !== cases.length) errors.push({ why: "incomplete probe output" });
  const compare = (c, index, kind, beforeRow, afterRow, stage, command = c.cmd) => {
    const key = kind === "classifier" ? "verdict" : "outcome";
    const b = beforeRow?.[key], n = afterRow?.[key];
    decisions++;
    const ranks = RANKS[kind];
    if (!Object.hasOwn(ranks, b) || !Object.hasOwn(ranks, n)) { errors.push({ index, kind, stage, before: b, after: n, why: "unknown decision" }); return; }
    if (ranks[b] === ranks[n]) return;
    const direction = ranks[n] < ranks[b] ? "looser" : "stricter";
    const asked = kind === "classifier" ? b === "ask" : b === "ASKED";
    const runs = kind === "classifier" ? n === "run" : n === "RAN";
    const rules = beforeRow?.rules;
    const countOnly = Array.isArray(rules) && rules.length > 0 && rules.every(r => ["unclear.unresolved-arg", "unclear.make-variable", "unclear.target"].includes(r));
    const allowed = direction === "looser" && asked && runs && countOnly && isAllowedJobCount(command);
    changes.push({ index, kind, ...(stage === undefined ? {} : { stage, command }), direction, allowed, case: c, before: b, after: n });
  };
  for (let index = 0; index < cases.length; index++) {
    const b = before?.[index], n = after?.[index], c = cases[index];
    compare(c, index, "classifier", b?.classifier, n?.classifier);
    const expected = c.sequence ?? [c.shell === "cmd" ? `cmd /c ${c.cmd}` : c.cmd];
    const bs = b?.flow?.outcomes, ns = n?.flow?.outcomes;
    if (!Array.isArray(expected) || !expected.length || expected.some(command => typeof command !== "string")
      || !Array.isArray(bs) || !Array.isArray(ns) || bs.length !== expected.length || ns.length !== expected.length) {
      errors.push({ index, why: "incomplete flow stages" }); continue;
    }
    for (let stage = 0; stage < expected.length; stage++) {
      if (bs[stage]?.command !== expected[stage] || ns[stage]?.command !== expected[stage]) {
        errors.push({ index, stage, why: "flow stage command differs from its input" }); continue;
      }
      compare(c, index, "flow", bs[stage], ns[stage], stage, expected[stage]);
    }
  }
  return { changes, errors, summary: {
    totalCases: cases.length, decisions, errors: errors.length,
    allowedLooser: changes.filter(c => c.direction === "looser" && c.allowed).length,
    forbiddenLooser: changes.filter(c => c.direction === "looser" && !c.allowed).length,
    stricter: changes.filter(c => c.direction === "stricter").length,
  } };
}
