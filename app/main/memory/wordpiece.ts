/**
 * BERT's uncased WordPiece tokenizer, for the memory embedding model (./embed.ts, docs/MEMORY.md §2): the text a fact or
 * a question is cut into the vocabulary ids the model reads. It does what Hugging Face's `tokenizers` does for
 * bert-base-uncased's tokenizer.json (BertNormalizer with lowercasing and accent stripping, BertPreTokenizer, WordPiece
 * with "##" continuations, [CLS] … [SEP]), checked token for token against it in test/unit/wordpiece.test.ts.
 *
 * In TypeScript rather than a package: it is about a hundred lines, has no dependencies, and runs the same in the
 * memory process on every OS. Pure: the vocabulary is passed in.
 */

/** The ids a model reads for one text, without padding. */
export interface Encoded { ids: number[]; mask: number[]; types: number[] }

/** How long a word may be before it is [UNK] (BERT's max_input_chars_per_word). */
const MAX_WORD_CHARS = 100;

/** Unicode's punctuation, plus ASCII's symbols (BERT treats "$", "+", "^" … as punctuation too). */
const PUNCTUATION = /[\p{P}!-/:-@[-`{-~]/u;
/** The CJK ideographs BERT puts spaces around (its _is_chinese_char ranges). */
const CJK = /[一-鿿㐀-䶿\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}豈-﫿\u{2F800}-\u{2FA1F}]/u;
/** Control and format characters, unassigned and private-use code points: dropped (tab and newlines are spaces). */
const CONTROL = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}]/u;

/**
 * BertNormalizer: drops NUL, U+FFFD and control characters, turns every kind of space into " ", puts spaces round CJK
 * ideographs, strips accents (NFD without its combining marks) and lowercases.
 */
export function normalise(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\0" || ch === "�") continue;
    // Tab and newlines are spaces; other control characters go, even the ones Unicode counts as spaces (\v, \f, U+0085),
    // as the tokenizers library drops them before it maps spaces.
    if (ch === "\t" || ch === "\n" || ch === "\r") { out += " "; continue; }
    if (CONTROL.test(ch)) continue;
    if (/\s/u.test(ch)) { out += " "; continue; }
    out += CJK.test(ch) ? ` ${ch} ` : ch;
  }
  return out.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}

/** BertPreTokenizer: words split on spaces, each punctuation character a word of its own. */
export function preTokenize(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.split(" ")) {
    let word = "";
    for (const ch of chunk) {
      if (PUNCTUATION.test(ch)) {
        if (word) words.push(word);
        words.push(ch);
        word = "";
      } else word += ch;
    }
    if (word) words.push(word);
  }
  return words;
}

export class WordPiece {
  private vocab = new Map<string, number>();
  readonly cls: number;
  readonly sep: number;
  readonly unk: number;

  /** `vocab`: vocab.txt, one token a line, its line number its id. */
  constructor(vocab: string) {
    vocab.split(/\r?\n/).forEach((t, i) => { if (t && !this.vocab.has(t)) this.vocab.set(t, i); });
    const need = (t: string) => {
      const id = this.vocab.get(t);
      if (id === undefined) throw new Error(`the vocabulary has no ${t}`);
      return id;
    };
    this.cls = need("[CLS]");
    this.sep = need("[SEP]");
    this.unk = need("[UNK]");
  }

  get size(): number { return this.vocab.size; }

  /** One word's pieces, longest first from the left ("embeddings" → embed ##ding ##s), or [UNK] whole. */
  private pieces(word: string): number[] {
    const chars = [...word];
    if (chars.length > MAX_WORD_CHARS) return [this.unk];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
        found = this.vocab.get(sub);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unk];
      out.push(found);
      start = end;
    }
    return out;
  }

  /** The ids of `text` between [CLS] and [SEP], at most `maxTokens` in all (the rest is cut off, as truncation does). */
  encode(text: string, maxTokens = 128): Encoded {
    const ids = [this.cls];
    for (const w of preTokenize(normalise(text))) {
      for (const id of this.pieces(w)) {
        if (ids.length >= maxTokens - 1) break;
        ids.push(id);
      }
      if (ids.length >= maxTokens - 1) break;
    }
    ids.push(this.sep);
    return { ids, mask: ids.map(() => 1), types: ids.map(() => 0) };
  }
}
