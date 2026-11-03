const words = (text: string): string[] => text.toLowerCase().replace(/’/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** The edit distance and which reference words matched along one minimum-edit alignment. */
function align(reference: string[], spoken: string[]): { errors: number; matched: Set<number> } {
  const d = Array.from({ length: reference.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= spoken.length; j++) d[0][j] = j;
  for (let i = 1; i <= reference.length; i++) {
    for (let j = 1; j <= spoken.length; j++) {
      const substitution = reference[i - 1] === spoken[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + substitution);
    }
  }

  const matched = new Set<number>();
  let i = reference.length, j = spoken.length;
  const errors = d[i][j];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && reference[i - 1] === spoken[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      matched.add(--i);
      j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return { errors, matched };
}

export function recognitionScore(expected: string, raw: string, corrected = raw) {
  const reference = words(expected);
  const before = align(reference, words(raw));
  const after = corrected === raw ? before : align(reference, words(corrected));
  const changed = (from: Set<number>, to: Set<number>) => [...from].filter(i => !to.has(i)).length;
  return {
    errors: after.errors,
    words: reference.length,
    harmed: changed(before.matched, after.matched),
    improved: changed(after.matched, before.matched),
  };
}
