/**
 * The intent matcher (design §3.7, OWNER DECISION 4 D4.4): a dangerous command runs without a question, after an
 * announcement with a Stop window, only when the user's OWN words for this task explicitly ask for that kind of
 * operation on that target and that object. It reads only `userWords` (the worker's `commandWords`: never the
 * conductor's goal, the model's text, screen text, files or output; critique security-1); empty words never match.
 * Deterministic and conservative: every finding must be covered by a row whose verbs the words ask for and whose
 * objects that verb acts on (actedOn: never a thing only placed, described or kept by other words), and
 * anything broader than what they name (force, wildcards, recursion the user didn't ask for, another branch, remote,
 * host or changelist) asks. Secrets, download-and-run, outliving the kill switch and anything unclear always ask.
 * Pure.
 */

import type { Classification, ClassifyContext, CommandObject, Finding, GitFacts } from "./types";
import { ALWAYS_ASK, PKG_CLEANS, PKG_PRUNES, PKG_REMOVES } from "./types";
import { hasVerb, hasWord, joinList, nameNamed, userTokens, userWordList, verbForms } from "./words";
import { homeDotFile, isBroadPath, isUnder, pathEnv, flavourOf, resolveTargetPath, type PathEnv } from "./paths";

/** The target's OS (the contract's own type, so this file imports nothing outside the commands package). */
type OS = ClassifyContext["os"];

/** What a match says and which row matched. */
export interface IntentMatch {
  /** The intent row (below). */
  intent: string;
  /** What the bubble says before it runs: "Pushing feature-x to origin, as you asked." */
  announce: string;
}

/** The user's words, prepared once. */
interface Words {
  raw: string;
  /** Plain words (letters and digits), lower case. */
  list: string[];
  /** Whitespace tokens with edge punctuation trimmed, lower case (paths stay as written). */
  tokens: string[];
  /** The plain words from each place a request's verb stands (requestStarts): only a verb there asks for anything. */
  asked: string[][];
}

type Ctx = ClassifyContext & { git: GitFacts | null };

/** The finding rules each intent row covers (§3.7's "Covers" column). */
const ROW_OF: Readonly<Record<string, string>> = {
  "git.push": "git.push",
  "git.push.force": "git.push.force",
  "git.branch.D": "git.branch.delete",
  "git.reset.hard": "git.reset.hard",
  "git.checkout.paths": "git.discard",
  "git.restore": "git.discard",
  "git.clean": "git.clean",
  "git.stash.drop": "git.stash.drop",
  "git.stash.clear": "git.stash.drop",
  "posix.rm": "delete.paths",
  "posix.rmdir": "delete.paths",
  "posix.unlink": "delete.paths",
  "ps.Remove-Item": "delete.paths",
  "cmd.del": "delete.paths",
  "cmd.rd": "delete.paths",
  "redirect.overwrite": "overwrite.file",
  "posix.tee": "overwrite.file",
  "ps.Out-File": "overwrite.file",
  "ps.Set-Content": "overwrite.file",
  "posix.cp": "overwrite.file",
  "posix.mv": "overwrite.file",
  "ps.Copy-Item": "overwrite.file",
  "ps.Move-Item": "overwrite.file",
  "p4.submit": "p4.submit",
  "p4.shelve": "p4.shelve",
  "p4.revert": "p4.revert",
  "gh.pr.create": "gh.pr.create",
  "gh.pr.merge": "gh.pr.merge",
  "gh.pr.merge.delete-branch": "gh.pr.merge",
  "npm.publish": "pkg.publish",
  "pnpm.publish": "pkg.publish",
  "yarn.publish": "pkg.publish",
  "twine.upload": "pkg.publish",
  "cargo.publish": "pkg.publish",
  "gem.push": "pkg.publish",
  "poetry.publish": "pkg.publish",
  "docker.push": "docker.push",
  "pkg.system": "pkg.install",
  "pkg.language": "pkg.install",
  "service.unit": "service.restart",
  "upload.scp": "upload.host",
  "upload.rsync": "upload.host",
  "upload.sftp": "upload.host",
  "upload.curl": "upload.host",
  "kill.process": "kill.process",
};

/** The verbs of pkg.install that take packages away: only they cover a removal, and only the others an install. */
const REMOVE_WORDS: readonly string[] = ["remove", "uninstall"];

/** Each row's verbs (§3.7's "The user's words must contain" column), also used to tell whether the user named it. */
const ROW_VERBS: Readonly<Record<string, readonly string[]>> = {
  "git.push": ["push"],
  "git.push.force": ["push"],
  "git.branch.delete": ["delete", "remove"],
  "git.reset.hard": ["reset", "discard", "throw away"],
  "git.discard": ["discard", "revert", "undo", "throw away", "restore"],
  "git.clean": ["clean"],
  "git.stash.drop": ["drop", "delete", "clear"],
  "delete.paths": ["delete", "remove", "rm", "erase", "clean up", "get rid of", "trash", "wipe"],
  "overwrite.file": ["overwrite", "replace", "save", "write", "update", "put", "store", "output"],
  "p4.submit": ["submit"],
  "p4.shelve": ["shelve"],
  "p4.revert": ["revert", "discard", "undo"],
  "gh.pr.create": ["open", "create", "make", "raise", "file"],
  "gh.pr.merge": ["merge"],
  "pkg.publish": ["publish", "release", "upload"],
  "docker.push": ["push"],
  "pkg.install": ["install", "add", "upgrade", "update", "remove", "uninstall"],
  "service.restart": ["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask"],
  "upload.host": ["copy", "upload", "send", "sync", "transfer"],
  "kill.process": ["kill", "stop", "end", "quit", "close"],
};

/** The row a finding belongs to, or null (no row: it always asks). */
function rowOf(f: Finding, all: readonly Finding[]): string | null {
  if (f.rule === "git.push" && all.some(g => g.rule === "git.push.force" && g.at === f.at)) return "git.push.force";
  return ROW_OF[f.rule] ?? null;
}

/** "my branch", "this branch", "the current branch", "the changes", "my commits". */
const MY_BRANCH = /\b(my|this|the current|the)\s+(branch|changes|commits)\b/i;

/** A path as the matcher compares it: lower case, `./` and a trailing separator dropped. */
function normPath(p: string): string {
  return p.toLowerCase().replace(/^\.[\\/]/, "").replace(/[\\/]+$/, "") || p.toLowerCase();
}
const lastSegment = (p: string): string => normPath(p).split(/[\\/]/).pop() ?? "";

/** Where the user's words name a path, loosely (for "You didn't ask for this" only): by path or last segment, or -1. */
function pathTokenLoose(obj: CommandObject, w: Words): number {
  const text = normPath(obj.text);
  const last = lastSegment(obj.text);
  return w.tokens.findIndex(t => {
    const n = normPath(t);
    return n === text || (obj.kind !== "glob" && (n === last || lastSegment(t) === text || (lastSegment(t) === last && last !== "")));
  });
}

/**
 * Where the user's words name exactly this path (§3.7), or -1: written the same; a path in the words (it holds a
 * separator or starts with `~`) that resolves to the same place; or a bare name equal to its last segment, for an
 * operand inside the task's folder reached without `..` ("delete build" names `build` and `src/build`, never
 * `../build`, `~/build` or another folder's `build`).
 */
function pathToken(obj: CommandObject, w: Words, ctx: Ctx): number {
  const text = normPath(obj.text);
  const last = lastSegment(obj.text);
  const env = envOf(ctx);
  return w.tokens.findIndex(t => {
    const n = normPath(t);
    if (n === text) return true;
    if (obj.kind === "glob" || !obj.resolved) return false;
    const bare = n.replace(/[\\/]+$/, "");
    if (/[\\/]/.test(bare) || bare.startsWith("~")) {
      if (!ctx.cwd) return false;
      const abs = resolveTargetPath(bare, { os: ctx.os, home: ctx.home, cwd: ctx.cwd });
      return abs.toLowerCase() === obj.resolved.toLowerCase();
    }
    if (n !== last || last === "" || !ctx.cwd) return false;
    return isUnder(obj.resolved, ctx.cwd, env) && !/(^|[\\/])\.\.([\\/]|$)/.test(obj.text);
  });
}

/** Words before a request's verb that change nothing: "please", "now", "hey Ember", "go ahead and". */
const FILLERS = new Set([
  "please", "pls", "kindly", "now", "then", "and", "also", "just", "ok", "okay", "so", "first", "next", "finally", "lastly", "hey", "hi",
  "ember", "go", "ahead", "quickly", "right", "alright", "yes", "yeah", "sure",
]);
/** Ways of asking Ember to do something (as plain words): "can you", "could you", "I want you to", "let's", "help me". */
const POLITE: readonly (readonly string[])[] = [
  ["can", "you"], ["could", "you"], ["would", "you"], ["will", "you"], ["can", "u"], ["could", "u"],
  ["i", "want", "you", "to"], ["i", "need", "you", "to"], ["i", "d", "like", "you", "to"], ["i", "would", "like", "you", "to"],
  ["i", "want", "to"], ["i", "need", "to"], ["i", "d", "like", "to"], ["i", "would", "like", "to"],
  ["let", "s"], ["let", "us"], ["lets"], ["help", "me"],
];
/** Words that make a clause a maybe rather than a request ("I might delete build/ later"). */
const HYPOTHETICAL = new Set(["might", "maybe", "perhaps", "possibly", "later", "whether", "eventually", "someday"]);
/** A leading place ("on the desktop delete build/") is skipped, unless it is really a question ("on what to delete"). */
const PLACE_WORDS = new Set(["on", "in", "inside", "at", "from", "within", "for", "over"]);
const NOT_A_PLACE = new Set(["what", "which", "how", "why", "whether", "when", "where", "who", "to", "if"]);
/** Words that join two requests in one sentence ("commit and push", "list the files, then delete build/"). */
const JOINERS = new Set(["and", "then", "but", "or", "so", "plus"]);

/** Skips fillers from `k`; then, when `polite`, one way of asking and the fillers after it. Returns [index, polite?]. */
function skipLead(c: readonly string[], k: number): [number, boolean] {
  while (k < c.length && FILLERS.has(c[k])) k++;
  const p = POLITE.find(ws => ws.every((x, j) => c[k + j] === x));
  if (!p) return [k, false];
  k += p.length;
  while (k < c.length && FILLERS.has(c[k])) k++;
  return [k, true];
}

/**
 * Where a request's verb can stand in the user's words (review #28: "should I delete build/?", "how do I push my
 * branch", "I deleted build/ yesterday" and "the script that deletes build/" ask for nothing). The words are cut into
 * sentences and each sentence into clauses (at commas, colons and "and", "then", "but"…); a clause asks for something
 * when, after fillers ("please", "Ember", "go ahead and") and a way of asking ("can you", "I want you to", "I want to",
 * "let's"), its next word is a verb, or the verb follows a short leading place ("on the desktop delete build/"). A
 * question counts only when it is a way of asking ("can you delete build/?"); a clause with "might", "maybe" or
 * "later" never counts.
 * Each start is returned as the clause's words from the verb on; the rows compare their verbs' base forms with it.
 */
function requestStarts(raw: string): string[][] {
  const out: string[][] = [];
  for (const sentence of sentencesOf(raw)) {
    const question = /\?["'”’)\]]*\s*$/.test(sentence);
    const clauses: string[][] = [];
    for (const part of sentence.split(/[,:;]\s+|\s+[-–—]\s+/)) {
      let cur: string[] = [];
      for (const word of userWordList(part)) {
        if (JOINERS.has(word)) { if (cur.length) clauses.push(cur); cur = []; } else cur.push(word);
      }
      if (cur.length) clauses.push(cur);
    }
    const polite = { first: false };
    clauses.forEach((c, n) => out.push(...clauseStarts(c, n, question, polite)));
  }
  return out;
}

/** The sentences of the user's words (at line breaks and after ".", "!", "?" or ";"). */
const sentencesOf = (raw: string): string[] => raw.split(/\r?\n+|(?<=[.!?;])\s+/).filter(s => s.trim() !== "");

/** Where a request's verb can stand in clause `n` of a sentence (requestStarts), as the words from there on. */
function clauseStarts(c: readonly string[], n: number, question: boolean, polite: { first: boolean }): string[][] {
  const out: string[][] = [];
  const [k, isPolite] = skipLead(c, 0);
  if (n === 0) polite.first = isPolite;
  // A question asks for something only when it is a way of asking ("can you delete build/?").
  if (question && !polite.first) return out;
  if (c.some(x => HYPOTHETICAL.has(x))) return out;
  if (k < c.length) out.push(c.slice(k));
  if (PLACE_WORDS.has(c[k] ?? "")) {
    for (let j = k + 2; j <= k + 4 && j < c.length; j++) {
      if (c.slice(k + 1, j).some(x => NOT_A_PLACE.has(x))) break;
      out.push(c.slice(j));
    }
  }
  return out;
}

/**
 * Words that may begin a clause that only names more of what the verb before it acts on ("delete build/ and the dist
 * folder", "kill 1234 and 5678"): a determiner, an adjective or a plural noun, never a word that is also a verb
 * ("branch", "stash", "pull", "process", "file"), so "stop apache and check nginx" ends the list at "check".
 */
const LISTS_MORE = new Set([
  "the", "my", "our", "your", "their", "its", "this", "that", "these", "those", "both", "all", "a", "an", "any", "each",
  "every", "other", "old", "unused", "stale", "temp", "temporary", "untracked", "ignored", "generated", "extra",
  "folders", "directories", "dirs", "files", "branches", "stashes", "packages", "images", "changelists", "prs", "processes",
]);
/** Words between a thing and what is said of it ("build itself stays", "the build folder is huge"). */
const OF_THING = new Set(["itself", "themselves", "too", "also", "still", "folder", "directory", "dir", "file", "branch", "service", "process", "package", "image"]);
/**
 * Words that say something of the thing before them rather than ask for anything ("1234 is my editor", "main stays",
 * "postgresql has to stay up", "nginx is fine"): that thing isn't what the verb acts on.
 */
const PREDICATE = new Set([
  "is", "are", "was", "were", "isn", "aren", "wasn", "weren", "stays", "stay", "stayed", "remains", "remain", "must",
  "mustn", "should", "shouldn", "has", "have", "needs", "need", "keeps", "can", "cannot", "will", "won", "shall",
  "belongs", "belong", "matters", "means", "holds", "contains", "runs", "looks", "seems", "sits", "lives", "does",
  "doesn",
]);
const RELATIVE = new Set(["that", "which", "who"]);

/**
 * The parts of the user's words a row's verb acts on (commands-remote-c3-1): each clause that asks for one of `verbs`
 * (as requestStarts reads it), with the clauses after it that only list more things for it ("delete build/, dist/ and
 * the cache folder", "kill these processes: 1234 and 5678"), up to the next verb, a new sentence, a dash, "then",
 * "but" or "so". What the words say
 * of a thing (its subject before "is", "stays", "must", "has to" and the like: "kill 5678, 1234 is my editor") is cut
 * out, so it never counts as named. Each part is returned as words of its own for the row to read. Conservative: a
 * clause that begins with any other word ends the list, and only makes the step ask.
 */
function actedOn(raw: string, verbs: readonly string[], names: (token: string) => boolean): string[] {
  const out: string[] = [];
  const asksVerb = (starts: readonly string[][]) => verbs.some(v => {
    const parts = v.split(" ");
    return starts.some(s => parts.every((p, j) => s[j] === p));
  });
  const nounish = (t: string): boolean => {
    const ws = userWordList(t);
    if (ws.length === 0) return false;
    if (ws.every(x => LISTS_MORE.has(x) || OF_THING.has(x)) || /^#?\d+$/.test(t)) return true;
    return /[\\/*~]|\p{L}\.\p{L}|^\.\p{L}/u.test(t) || names(t);
  };
  for (const sentence of sentencesOf(raw)) {
    const question = /\?["'”’)\]]*\s*$/.test(sentence);
    // Clauses as written: [tokens, whether a list joined it to the clause before ("," "and" "or" "plus")].
    const clauses: [string[], boolean][] = [];
    const pieces = sentence.split(/([,:;]\s+|\s+[-–—]\s+)/);
    let list = false;
    for (let p = 0; p < pieces.length; p++) {
      // A colon after the verb's clause lists what it acts on ("delete these folders: build/ and dist/").
      if (p % 2 === 1) { list = /^[,:]/.test(pieces[p]); continue; }
      let cur: string[] = [];
      for (const t of pieces[p].split(/\s+/).filter(x => x !== "")) {
        const ws = userWordList(t);
        if (ws.some(x => JOINERS.has(x))) {
          if (cur.length) clauses.push([cur, list]);
          cur = [];
          list = ws.length === 1 && ["and", "or", "plus"].includes(ws[0]);
          continue;
        }
        cur.push(t);
      }
      if (cur.length) clauses.push([cur, list]);
    }
    const polite = { first: false };
    let chain: string[] | null = null;
    const end = () => { if (chain) out.push(chain.join(" and ")); chain = null; };
    clauses.forEach(([tokens, listed], n) => {
      const starts = clauseStarts(userWordList(tokens.join(" ")), n, question, polite);
      const leads = asksVerb(starts);
      const first = tokens.find(t => !userWordList(t).every(x => FILLERS.has(x)));
      if (!leads && !(chain && listed && first !== undefined && nounish(first))) { end(); return; }
      if (leads) end();
      // Cut from the thing something is said of ("…, 1234 is my editor"), and end the list there.
      let cut = tokens.length;
      const word = (k: number) => userWordList(tokens[k] ?? "")[0] ?? "";
      for (let k = 0; k < tokens.length && cut === tokens.length; k++) {
        const ws = userWordList(tokens[k]);
        // "main's sacred" says it in one word; otherwise a word such as "is" or "must" right after a thing ("1234 is my
        // editor", "build itself stays"). "can you", "I need to" and "it is huge" say nothing of a thing the step names.
        const says = ws.length === 2 && ws[1] === "s" && names(ws[0]);
        if (!says && !(PREDICATE.has(ws[0] ?? "") && k > 0 && nounish(tokens[k - 1]))) continue;
        // "the build folder that is in dist" says where it is (folderNamed), not something of it.
        if (RELATIVE.has(word(k - 1)) && IN_FOLDER.has(word(k + 1))) continue;
        let j = k;
        while (j > 0 && !RELATIVE.has(word(j - 1)) && nounish(tokens[j - 1])) j--;
        // "the build folder that is huge": what follows "that" is about it, the folder before it is still asked for.
        if (j > 0 && RELATIVE.has(word(j - 1))) j--;
        cut = j;
      }
      const kept = tokens.slice(0, cut).join(" ").replace(/\?+(?=["'”’)\]]*$)/, "");
      chain = [...(chain ?? []), ...(kept.trim() !== "" ? [kept] : [])];
      if (cut < tokens.length) end();
    });
    end();
  }
  return out;
}

/** Whether the user's words ask for one of these verbs (base form, multi-word verbs as consecutive words). */
function asks(w: Words, verbs: readonly string[]): boolean {
  return verbs.some(v => {
    const parts = v.split(" ");
    return w.asked.some(c => parts.every((p, j) => c[j] === p));
  });
}

/** The user's words as the matcher reads them. */
function wordsOf(userWords: string): Words {
  const raw = userWords.normalize("NFKC");
  return { raw, list: userWordList(userWords), tokens: userTokens(userWords), asked: requestStarts(raw) };
}

/** Words that say which folder a named path is in ("build/ in my-app", "the build folder inside packages/app"). */
const IN_FOLDER = new Set(["in", "inside", "within", "under"]);
const AFTER_OBJECT = new Set(["folder", "folders", "directory", "directories", "dir", "file", "files"]);
const BEFORE_FOLDER = new Set(["the", "my", "our", "your", "this", "that"]);
/** "the build folder that is in dist", "which sits inside docs". */
const SAYS_WHERE = new Set(["that", "which", "that's", "is", "are", "sits", "lives"]);
/** Words after "in" that say when or how, not which folder ("in a moment", "in the background", "in place"). */
const NOT_A_FOLDER = new Set([
  "a", "an", "one", "minute", "minutes", "moment", "second", "seconds", "sec", "hour", "hours", "bit", "while",
  "background", "parallel", "order", "case", "turn", "time", "advance", "full", "go", "bulk", "meantime", "future",
  "place", "general", "fact", "particular", "short",
]);
/** Words after "in" that name the task's own folder ("in this folder", "in the repo", "in here"): no other one. */
const HERE_FOLDER = new Set(["folder", "directory", "dir", "repo", "repository", "project", "here", "current", "workspace", "checkout"]);

/**
 * The folder the user's words put the path at token `idx` in ("delete build/ in my-app", "the build folder in
 * packages/app", "the build folder in dist"), "~" for the home folder ("in my home folder"), else null. Any word
 * there names a folder (commands-remote-c3-1: "the build folder in dist" is dist/build, never ./build); amounts ("in 5
 * minutes"), times and ways ("in a moment", "in the background") and the task's own folder ("in this repo") name none.
 */
function folderNamed(idx: number, w: Words): string | null {
  let k = idx + 1;
  while (AFTER_OBJECT.has(w.tokens[k] ?? "") || SAYS_WHERE.has(w.tokens[k] ?? "")) k++;
  if (!IN_FOLDER.has(w.tokens[k] ?? "")) return null;
  k++;
  while (BEFORE_FOLDER.has(w.tokens[k] ?? "")) k++;
  const t = w.tokens[k] ?? "";
  if (t === "" || /^\d+(?:[.,:/-]\d+)*[a-z]{0,3}$/i.test(t)) return null;
  if (NOT_A_FOLDER.has(t) || HERE_FOLDER.has(t)) return null;
  if (t === "home" || t === "~") return "~";
  return t;
}

/**
 * Whether `resolved` is directly in a folder the words named (folderNamed): the folder's path, as written, ends the
 * folders above it ("my-app" in /home/ana/my-app/build, "packages/app" in …/packages/app/build), or "~" is the home
 * folder itself. Review #31: once "in my-app" no longer counts as another computer, the path must really be in it, and
 * not in a folder further down (/home/ana/my-app/packages/core/build is not "build/ in my-app").
 */
function inNamedFolder(resolved: string, folder: string, home: string): boolean {
  const above = resolved.toLowerCase().split(/[\\/]+/).filter(Boolean).slice(0, -1);
  const want = folder === "~"
    ? home.toLowerCase().split(/[\\/]+/).filter(Boolean)
    : normPath(folder).split(/[\\/]+/).filter(x => x !== "" && x !== ".");
  if (want.length === 0 || want.length > above.length || (folder === "~" && want.length !== above.length)) return false;
  const tail = above.slice(above.length - want.length);
  return want.every((x, j) => tail[j] === x);
}

/** The path at `idx` is where the words put it: in the folder they named after it, when they named one. */
const whereNamed = (resolved: string, idx: number, w: Words, ctx: Ctx): boolean => {
  const folder = folderNamed(idx, w);
  return folder === null || inNamedFolder(resolved, folder, ctx.home);
};

/**
 * Whether the user's words name a script: its file name ("build.sh", "./ci/test.sh"), or its name without the
 * extension with the word "script" ("run the build script"), or a name without one ("gradlew").
 */
function scriptNamed(name: string, w: Words): boolean {
  const lower = name.toLowerCase();
  if (w.tokens.some(t => lastSegment(t) === lower) || nameNamed(name, w.raw)) return true;
  const stem = lower.replace(/\.[a-z0-9]{1,4}$/, "");
  return stem !== lower && nameNamed(stem, w.raw) && hasWord(w.list, ["script", "scripts"]);
}

/**
 * Words that keep something or leave it out ("delete everything but build/", "delete dist/ and keep build/", "other
 * than", "instead of"): nothing announces then, as with NEGATION, since the step may be on what they keep.
 */
const KEEPS = /(^|[^\p{L}\p{N}])((everything|anything|all)\s+but|other\s+than|apart\s+from|aside\s+from|excluding|besides|instead\s+of|rather\s+than|keep|keeping|leave|leaving|spare|sparing|preserve|preserving)(?=$|[^\p{L}\p{N}])/iu;

/** Words that turn a request around ("don't delete build", "never push to main"): nothing announces then. */
const NEGATION = /(^|[^\p{L}\p{N}])(not|never|no|none|nothing|don['’]?t|doesn['’]?t|didn['’]?t|won['’]?t|wouldn['’]?t|shouldn['’]?t|mustn['’]?t|isn['’]?t|aren['’]?t|can['’]?t|cannot|without|except|avoid|neither|nor|unless)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Widening any row refuses: a differing real path, a variable set in the text, options before the program's verb, and
 * a finding that came from inside a script Ember read (the user's words name the command, never the script's text).
 */
const ALWAYS_BROADER = new Set(["real-path", "env", "global-option", "in-script"]);

/** Recursion words near the operand the user named (§3.7 delete.paths). */
const RECURSION = ["folder", "folders", "directory", "directories", "dir", "dirs", "tree", "recursively", "everything", "all"];
function recursionNear(idx: number, w: Words): boolean {
  if (idx < 0) return false;
  const raw = w.raw.split(/\s+/).filter(t => t !== "");
  if (/[\\/][)"'`”’\]}>.,;:!?]*$/.test(raw[idx] ?? "")) return true;
  for (let k = Math.max(0, idx - 3); k <= Math.min(w.tokens.length - 1, idx + 3); k++) {
    if (k === idx) continue;
    const t = w.tokens[k];
    if (RECURSION.slice(0, 8).includes(t)) return true;
    if (t === "everything" && w.tokens[k + 1] === "in") return true;
    if (t === "all" && w.tokens[k + 1] === "of") return true;
  }
  return false;
}

/** The path rules the matcher needs (the work tree, broad paths, home dot files). */
function envOf(ctx: Ctx): PathEnv {
  return pathEnv({ flavour: flavourOf(ctx.os), os: ctx.os, home: ctx.home || null, cwd: ctx.cwd || null, ember: [] });
}

/** A row: its announcement when the part of the words its verb acts on (`w`) covers the findings, else null. */
type RowFn = (fs: Finding[], w: Words, ctx: Ctx, all: readonly Finding[], whole: Words) => IntentMatch | null;

/** git push (critique security-8): bare pushes need single-branch git facts; explicit refspecs must be named. */
function gitPush(force: boolean): RowFn {
  return (fs, w, ctx, all) => {
    const branches: string[] = [];
    let remoteShown = "";
    for (const f of fs.filter(g => g.rule === "git.push")) {
      if (!asks(w, ["push", "force push"])) return null;
      if (force && !hasWord(w.list, ["force"])) return null;
      const forced = all.some(g => g.rule === "git.push.force" && g.at === f.at);
      if (forced !== force) return null;
      const broader = ["--all", "--tags", "--follow-tags", "--mirror", "--prune", "--delete", ":ref", "-C", "--git-dir", "--work-tree", "--namespace", "--repo", "--receive-pack", "url-remote", "real-path"];
      if (f.widening.some(x => broader.includes(x) || x.startsWith("?"))) return null;
      if (!force && f.widening.some(x => /^(--force|--force-with-lease|--force-if-includes|\+ref)$/.test(x))) return null;
      const remoteObj = f.objects.find(o => o.kind === "remote");
      const refs = f.objects.filter(o => o.kind === "branch" || o.kind === "tag");
      if (refs.some(r => r.kind === "tag")) return null;
      const remote = remoteObj?.text ?? null;
      const git = ctx.git;
      const upstreamRemote = git?.upstream ? git.upstream.split("/")[0] : null;
      const upstreamBranch = git?.upstream ? git.upstream.split("/").slice(1).join("/") : null;
      const bare = refs.length === 0 || (refs.length === 1 && /^\+?HEAD$/.test(refs[0].text));
      let target: string;
      let pushed: string[];
      if (bare) {
        if (!git || !git.branch) return null;
        const pd = git.pushDefault ?? "simple";
        if (!["simple", "current", "upstream"].includes(pd)) return null;
        if (!remote && pd !== "current") {
          if (!git.upstream || upstreamBranch !== git.branch) return null;
        }
        target = remote ?? upstreamRemote ?? "origin";
        if (!(nameNamed(git.branch, w.raw) || MY_BRANCH.test(w.raw))) return null;
        pushed = [git.branch];
      } else {
        if (!remote) return null;
        target = remote;
        pushed = [];
        for (const r of refs) {
          const text = r.text.replace(/^\+/, "");
          if (/[*?]/.test(text)) return null;
          const [srcRaw, dstRaw] = text.split(":");
          const src = srcRaw.replace(/^refs\/heads\//, "");
          const dst = dstRaw === undefined ? src : dstRaw.replace(/^refs\/heads\//, "");
          if (src === "HEAD") return null;
          const named = nameNamed(src, w.raw) || (git?.branch === src && MY_BRANCH.test(w.raw));
          if (!named) return null;
          if (dst !== src && !nameNamed(dst, w.raw)) return null;
          pushed.push(dst === src ? src : `${src} as ${dst}`);
        }
      }
      if (target === "origin") {
        if (!(nameNamed("origin", w.raw) || hasWord(w.list, ["github"]) || upstreamRemote === "origin")) return null;
      } else if (!nameNamed(target, w.raw)) return null;
      branches.push(...pushed);
      remoteShown = target;
    }
    if (branches.length === 0) return null;
    return {
      intent: force ? "git.push.force" : "git.push",
      announce: `${force ? "Force-pushing" : "Pushing"} ${joinList(branches)} to ${remoteShown}, as you asked.`,
    };
  };
}

const ROWS: Readonly<Record<string, RowFn>> = {
  "git.push": gitPush(false),
  "git.push.force": gitPush(true),
  "git.branch.delete": (fs, w) => {
    if (!asks(w, ["delete", "remove"]) || !hasWord(w.list, ["branch", "branches"])) return null;
    const names = fs.flatMap(f => f.objects.map(o => o.text));
    if (names.length === 0 || names.some(n => !nameNamed(n, w.raw))) return null;
    return { intent: "git.branch.delete", announce: `Deleting the branch ${joinList(names)}, as you asked.` };
  },
  "git.reset.hard": (fs, w) => {
    const said = (asks(w, ["reset"]) && hasWord(w.list, ["hard"])) || (asks(w, ["discard", "throw away"]) && hasWord(w.list, ["changes"]));
    if (!said) return null;
    for (const f of fs) for (const o of f.objects) if (o.text !== "HEAD" && !nameNamed(o.text, w.raw) && !w.tokens.includes(o.text.toLowerCase())) return null;
    // To another commit the branch moves too (commands-remote-r1).
    const to = [...new Set(fs.flatMap(f => f.objects.map(o => o.text)).filter(t => t !== "HEAD" && t !== "@"))];
    if (to.length) return { intent: "git.reset.hard", announce: `Moving the branch to ${joinList(to)} and throwing away uncommitted changes, as you asked.` };
    return { intent: "git.reset.hard", announce: "Throwing away uncommitted changes, as you asked." };
  },
  "git.discard": (fs, w, ctx) => {
    if (!asks(w, ["discard", "revert", "undo", "restore", "throw away"])) return null;
    const objs = fs.flatMap(f => f.objects);
    if (objs.length === 0 || fs.some(f => f.widening.some(x => x === "--source" || x === "real-path"))) return null;
    for (const o of objs) {
      const idx = o.resolved ? pathToken(o, w, ctx) : -1;
      if (idx < 0 || !whereNamed(o.resolved!, idx, w, ctx)) return null;
    }
    return { intent: "git.discard", announce: `Discarding changes to ${joinList(objs.map(o => o.text))}, as you asked.` };
  },
  "git.clean": (fs, w, ctx) => {
    if (!asks(w, ["clean"]) || !(hasWord(w.list, ["untracked"]) || /\bgit clean\b/i.test(w.raw))) return null;
    if (fs.some(f => f.widening.some(x => x === "-x" || x === "-X")) && !hasWord(w.list, ["ignored"])) return null;
    if (fs.some(f => f.objects.some(o => !o.resolved || pathToken(o, w, ctx) < 0))) return null;
    return { intent: "git.clean", announce: "Deleting untracked files, as you asked." };
  },
  "git.stash.drop": (fs, w) => {
    if (!asks(w, ["drop", "delete", "clear"]) || !hasWord(w.list, ["stash", "stashes", "stashed"])) return null;
    if (fs.some(f => f.rule === "git.stash.clear") && !(hasWord(w.list, ["all"]) || asks(w, ["clear"]))) return null;
    if (fs.some(f => f.objects.some(o => !w.tokens.includes(o.text.toLowerCase())))) return null;
    return { intent: "git.stash.drop", announce: "Dropping the stash, as you asked." };
  },
  "delete.paths": (fs, w, ctx) => {
    if (!asks(w, ROW_VERBS["delete.paths"])) return null;
    if (!ctx.cwd) return null;
    const env = envOf(ctx);
    const texts: string[] = [];
    for (const f of fs) {
      if (f.objects.length === 0) return null;
      if (f.widening.some(x => x !== "recursive")) return null;
      const recursive = f.widening.includes("recursive");
      for (const o of f.objects) {
        if (!o.resolved || (o.kind !== "path" && o.kind !== "glob")) return null;
        if (["/", "~", ".", "..", "*", "\\"].includes(o.text) || /^[A-Za-z]:\\?$/.test(o.text)) return null;
        if (isBroadPath(o.resolved, env)) return null;
        const idx = o.kind === "glob" ? w.tokens.indexOf(o.text.toLowerCase()) : pathToken(o, w, ctx);
        if (idx < 0 || !whereNamed(o.resolved, idx, w, ctx)) return null;
        const inside = isUnder(o.resolved, ctx.cwd, env) || (ctx.home !== "" && isUnder(o.resolved, ctx.home, env));
        if (!inside && !w.tokens.some(t => normPath(t) === normPath(o.resolved!) || (isAbsoluteText(o.text, ctx.os) && normPath(t) === normPath(o.text)))) return null;
        if (recursive && !recursionNear(idx, w)) return null;
        texts.push(o.text);
      }
    }
    return { intent: "delete.paths", announce: `Deleting ${joinList(texts)}, as you asked.` };
  },
  "overwrite.file": (fs, w, ctx) => {
    if (!asks(w, ROW_VERBS["overwrite.file"])) return null;
    const env = envOf(ctx);
    const texts: string[] = [];
    for (const f of fs) {
      if (f.widening.includes("real-path")) return null;
      const o = f.objects.find(x => x.kind === "path");
      const idx = o?.resolved ? pathToken(o, w, ctx) : -1;
      if (!o || !o.resolved || idx < 0 || !whereNamed(o.resolved, idx, w, ctx)) return null;
      if (homeDotFile(o.resolved, env)) return null;
      texts.push(o.text);
    }
    return { intent: "overwrite.file", announce: `Overwriting ${joinList(texts)}, as you asked.` };
  },
  "p4.submit": p4Row("p4.submit", "submit", "Submitting", "to Perforce"),
  "p4.shelve": p4Row("p4.shelve", "shelve", "Shelving", "in Perforce"),
  "p4.revert": (fs, w) => {
    if (!asks(w, ["revert", "discard", "undo"])) return null;
    const everything = hasWord(w.list, ["everything", "all my", "all"]);
    for (const f of fs) {
      if (f.widening.includes("...") && !everything) return null;
      for (const o of f.objects) {
        if (o.kind === "changelist") { if (!w.list.includes(o.text)) return null; continue; }
        if (/(^|\/)\.\.\.$/.test(o.text) ? !everything : !w.tokens.some(t => normPath(t) === normPath(o.text) || lastSegment(t) === lastSegment(o.text))) return null;
      }
    }
    const what = fs.flatMap(f => f.objects.filter(o => o.kind !== "changelist").map(o => o.text));
    return { intent: "p4.revert", announce: `Reverting ${what.length ? joinList(what) : "your opened files"} in Perforce, as you asked.` };
  },
  "gh.pr.create": (fs, w) => {
    if (!(hasWord(w.list, ["pull request", "pr", "pull requests", "prs"]) && asks(w, ROW_VERBS["gh.pr.create"]))) return null;
    if (fs.some(f => f.widening.some(x => /^(-B|--base|-H|--head|-R|--repo|--web|-w)$/.test(x)))) return null;
    return { intent: "gh.pr.create", announce: "Opening a pull request, as you asked." };
  },
  "gh.pr.merge": (fs, w, _ctx, _all, whole) => {
    // "merge it" refers back to a pull request the words name elsewhere ("pr 45 looks good. merge it").
    if (!asks(w, ["merge"]) || !(hasWord(w.list, ["pull request", "pr"]) || (hasWord(w.list, ["it"]) && hasWord(whole.list, ["pull request", "pr"])))) return null;
    if (fs.some(f => f.widening.some(x => /^(--admin|-R|--repo)$/.test(x)))) return null;
    // Deleting the branch is a request of its own ("merge pr 12 and delete the branch"), so it is read in all the words.
    if (fs.some(f => f.rule === "gh.pr.merge.delete-branch") && !actedOn(whole.raw, ["delete"], () => false).some(p => hasWord(wordsOf(p).list, ["branch"]))) return null;
    const nums = [...new Set(fs.flatMap(f => f.objects.filter(o => o.kind === "other").map(o => o.text.replace(/^#/, "").toLowerCase())))];
    const numbered = (l: readonly string[]) => [...new Set(l.filter(x => /^\d+$/.test(x)))];
    // A number said in another clause ("check pr 45, then merge the pr") counts only when the merge numbers none of its
    // own, only refers back, and it is the one number in all the words (commands-remote-v4-6).
    const said = numbered(whole.list);
    const back = numbered(w.list).length === 0 && !hasWord(w.list, BACK_NOT) && said.length === nums.length && nums.every(n => said.includes(n));
    if (nums.some(n => !w.list.includes(n)) && !back) return null;
    // `gh pr merge` alone merges the current branch's pull request, which may not be the one the user numbered, in
    // any of their words ("look at pull request 45. merge the pr": commands-remote-v4-2).
    if (nums.length === 0 && said.length > 0) return null;
    return { intent: "gh.pr.merge", announce: `Merging pull request ${nums.length ? joinList(nums) : ""}, as you asked.`.replace("request ,", "request,") };
  },
  "pkg.publish": (fs, w) => {
    if (!asks(w, ["publish", "release", "upload"])) return null;
    for (const f of fs) {
      for (const x of f.widening) {
        if (x === "--registry") return null;
        const tag = /^--tag=(.*)$/.exec(x);
        if (tag && !nameNamed(tag[1], w.raw) && !w.tokens.includes(tag[1].toLowerCase())) return null;
        if (x === "--access=public" && !hasWord(w.list, ["public"])) return null;
      }
      const pkg = f.objects.find(o => o.kind === "package")?.text ?? "";
      if (pkg ? !(nameNamed(pkg, w.raw) || w.tokens.includes(pkg.toLowerCase())) : !(/\bthis package\b/i.test(w.raw) || hasWord(w.list, ["it"]))) return null;
    }
    const names = fs.map(f => f.objects.find(o => o.kind === "package")?.text || "this package");
    return { intent: "pkg.publish", announce: `Publishing ${joinList(names)}, as you asked.` };
  },
  "docker.push": (fs, w) => {
    if (!asks(w, ["push"])) return null;
    const images: string[] = [];
    for (const f of fs) {
      if (f.widening.length) return null;
      const img = f.objects.find(o => o.kind === "image")?.text;
      if (!img || img === "the image") return null;
      const name = img.replace(/(:[^/:]+)?(@sha256:[0-9a-f]+)?$/i, "");
      // A registry or namespace in front (`evil/app`) is a different image than the `app` the user named.
      if (!(w.tokens.includes(name.toLowerCase()) || (!name.includes("/") && nameNamed(name, w.raw)))) return null;
      images.push(img);
    }
    return { intent: "docker.push", announce: `Pushing the image ${joinList(images)}, as you asked.` };
  },
  "pkg.install": (fs, w, ctx) => {
    // Words that install never cover a removal, nor words that remove an install (commands-remote-r1).
    const removes = fs.every(f => f.says === PKG_REMOVES);
    if ((!removes && fs.some(f => f.says === PKG_REMOVES)) || fs.some(f => f.says === PKG_PRUNES || f.says === PKG_CLEANS)) return null;
    if (!asks(w, removes ? REMOVE_WORDS : ROW_VERBS["pkg.install"].filter(v => !REMOVE_WORDS.includes(v)))) return null;
    const pkgs: string[] = [];
    for (const f of fs) {
      if (f.widening.includes("--global") && !hasWord(w.list, ["global", "globally"])) return null;
      const objs = f.objects;
      if (objs.length === 0 && !hasWord(w.list, ["dependencies", "deps", "requirements", "packages", "modules"])) return null;
      for (const o of objs) {
        if (o.kind === "path") { if (pathToken(o, w, ctx) < 0) return null; pkgs.push(o.text); continue; }
        if (o.kind !== "package" || !(nameNamed(o.text, w.raw) || w.tokens.includes(o.text.toLowerCase()))) return null;
        pkgs.push(o.text);
      }
    }
    if (removes) return { intent: "pkg.install", announce: `Removing ${pkgs.length ? joinList(pkgs) : "the packages"}, as you asked.` };
    return { intent: "pkg.install", announce: `Installing ${pkgs.length ? joinList(pkgs) : "the project's dependencies"}, as you asked.` };
  },
  "service.restart": (fs, w) => {
    const units: string[] = [];
    for (const f of fs) {
      const verb = f.widening[0] ?? "";
      if (!["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "try-restart", "reload-or-restart", "force-reload"].includes(verb)) return null;
      if (!asks(w, [verb.replace(/^(try-|force-)/, "").replace(/-or-restart$/, "")])) return null;
      if (f.objects.length !== 1) return null;
      const unit = f.objects[0].text.replace(/\.service$/, "");
      if (!nameNamed(unit, w.raw)) return null;
      units.push(unit);
    }
    const verb = fs[0]?.widening[0] ?? "restart";
    const ing = { start: "Starting", stop: "Stopping", restart: "Restarting", reload: "Reloading", enable: "Enabling", disable: "Disabling", mask: "Masking", unmask: "Unmasking" }[verb.replace(/^(try-|force-)/, "").replace(/-or-restart$/, "")] ?? "Restarting";
    return { intent: "service.restart", announce: `${ing} ${joinList(units)}, as you asked.` };
  },
  "upload.host": (fs, w, ctx) => {
    if (!asks(w, ROW_VERBS["upload.host"])) return null;
    let host = "";
    const files: string[] = [];
    for (const f of fs) {
      const h = f.objects.find(o => o.kind === "host");
      if (!h || !nameNamed(h.text, w.raw)) return null;
      host = h.text;
      for (const o of f.objects.filter(x => x.kind === "path")) {
        if (pathToken(o, w, ctx) < 0) return null;
        files.push(o.text);
      }
    }
    if (files.length === 0) return null;
    return { intent: "upload.host", announce: `Copying ${joinList(files)} to ${host}, as you asked.` };
  },
  "kill.process": (fs, w) => {
    if (!asks(w, ROW_VERBS["kill.process"])) return null;
    const names: string[] = [];
    for (const f of fs) {
      if (f.objects.length === 0 || f.widening.length) return null;
      for (const o of f.objects) {
        if (!o.text || o.text === "?" || !(w.list.includes(o.text.toLowerCase()) || nameNamed(o.text, w.raw))) return null;
        names.push(o.text);
      }
    }
    return { intent: "kill.process", announce: `Stopping ${joinList(names)}, as you asked.` };
  },
};

/** Words that point a merge at some pull request other than the one the words number ("merge the other pr"). */
const BACK_NOT: readonly string[] = ["other", "another", "next", "previous", "first", "second", "last", "both", "all", "each", "every", "prs", "pull requests", "them"];

/** Whether a token of the user's words names this object (its text, its last segment or its name without a suffix). */
function namesObject(o: CommandObject, token: string): boolean {
  const t = token.replace(/^[("'`“‘[{<]+|[)"'`”’\]}>.,;:!?]+$/g, "");
  if (t === "" || o.text === "") return false;
  const forms = [o.text, o.text.replace(/\.service$/i, ""), o.text.replace(/(:[^/:]+)?(@sha256:[0-9a-f]+)?$/i, "")];
  return forms.some(x => x !== "" && (normPath(x) === normPath(t) || (lastSegment(x) !== "" && lastSegment(x) === lastSegment(t)) || nameNamed(x, t)));
}

function isAbsoluteText(p: string, os: OS): boolean {
  return os === "win32" ? /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(p) : p.startsWith("/");
}

/** p4 submit and shelve: the changelist named (or "my|this|default changelist" for the default one). */
function p4Row(intent: string, verb: string, ing: string, where: string): RowFn {
  return (fs, w) => {
    if (!asks(w, [verb])) return null;
    const cls: string[] = [];
    for (const f of fs) {
      if (f.widening.some(x => x !== "-d" && !(intent === "p4.shelve" && x === "-f" && hasWord(w.list, ["force"])))) return null;
      const cl = f.objects.find(o => o.kind === "changelist")?.text;
      const files = f.objects.filter(o => o.kind === "path");
      if (files.some(o => !w.tokens.some(t => normPath(t) === normPath(o.text) || lastSegment(t) === lastSegment(o.text)))) return null;
      if (cl) {
        if (!(hasWord(w.list, ["changelist", "change", "cl", "changelists"]) && w.list.includes(cl))) return null;
        cls.push(`changelist ${cl}`);
      } else {
        if (!/\b(my|this|the|default)\s+(default\s+)?(changelist|changes|change)\b/i.test(w.raw)) return null;
        cls.push("the default changelist");
      }
    }
    return { intent, announce: `${ing} ${joinList(cls)} ${where}, as you asked.` };
  };
}

/**
 * Matches a dangerous command against the user's own words (§3.7): the row's announcement when every finding is
 * covered by a row the words name, else null (the command asks). Empty or whitespace words never match.
 */
export function matchIntent(cls: Classification, userWords: string, ctx: ClassifyContext & { git: GitFacts | null }): IntentMatch | null {
  if (!userWords || userWords.trim() === "") return null;
  if (cls.refuse) return null;
  const F = cls.findings;
  if (F.length === 0) return null;
  if (F.some(f => ALWAYS_ASK.has(f.cls))) return null;
  if (F.some(f => f.widening.some(x => ALWAYS_BROADER.has(x)))) return null;
  if (NEGATION.test(userWords.normalize("NFKC")) || KEEPS.test(userWords.normalize("NFKC"))) return null;
  const groups = new Map<string, Finding[]>();
  for (const f of F) {
    const row = rowOf(f, F);
    if (!row) return null;
    groups.set(row, [...(groups.get(row) ?? []), f]);
  }
  const w = wordsOf(userWords);
  const parts: IntentMatch[] = [];
  for (const [row, fs] of groups) {
    const fn = ROWS[row];
    if (!fn) return null;
    // Each row reads only what its verb acts on (commands-remote-c3-1): "kill 5678, 1234 is my editor" never covers
    // `kill 1234`, nor "stop apache and check nginx" `systemctl stop nginx`.
    const names = (t: string) => fs.some(f => f.objects.some(o => namesObject(o, t)));
    const verbs = row.startsWith("git.push") ? ["push", "force push"] : ROW_VERBS[row] ?? [];
    let m: IntentMatch | null = null;
    const acted = actedOn(w.raw, verbs, names);
    for (const part of acted) if ((m = fn(fs, wordsOf(part), ctx, F, w))) break;
    // The verb said again ("delete build/ and delete dist/", "kill 1234. Kill 5678 too."): the parts that ask for that
    // same verb are read together, so each thing is still named where the verb asks for it (commands-remote-v4-6), and
    // never parts with another verb ("stop apache and restart nginx" never covers `systemctl restart apache`).
    for (const v of verbs) {
      if (m) break;
      const same = acted.filter(p => asks(wordsOf(p), [v]));
      if (same.length > 1) m = fn(fs, wordsOf(same.join("\n")), ctx, F, w);
    }
    if (!m) return null;
    parts.push(m);
  }
  if (parts.length === 1) return parts[0];
  // git.push.force covers git.push's finding too: keep one announcement per command.
  const uniq = parts.filter((p, k) => parts.findIndex(q => q.announce === p.announce) === k);
  return { intent: uniq.map(p => p.intent).join("+"), announce: uniq.map(p => p.announce).join(" ") };
}

/**
 * Whether the user's words name any of these dangerous findings at all (a row's verbs with one of its objects, or a
 * finding's program or object): when none, the card says "You didn't ask for this." (§3.8.2 rule 11).
 */
export function mentioned(findings: readonly Finding[], userWords: string): boolean {
  if (!userWords || userWords.trim() === "") return false;
  const w = wordsOf(affirmed(userWords));
  // What Ember can't follow in a script, when the user's words name the script ("run the build script", "run build.sh"):
  // they asked for it (review #27). Only when that is all the card says: what a script does that is dangerous is asked
  // for only when the words name that, as for the command's own findings.
  const scriptOf = (f: Finding) => (f.cls === "unclear" ? f.widening.find(x => x.startsWith("script:"))?.slice("script:".length) : undefined);
  if (findings.length > 0 && findings.every(f => { const s = scriptOf(f); return s !== undefined && scriptNamed(s, w); })) return true;
  return findings.some(f => {
    if (leftOut(f, userWords)) return false;
    const row = rowOf(f, findings);
    const objectNamed = f.objects.length === 0 || f.objects.some(o => (o.text !== "" && (nameNamed(o.text, w.raw) || pathTokenLoose(o, w) >= 0)));
    // A program and its subcommand named in full ("run npm ci", "docker push it"): the user asked for it (commands-remote-v2).
    if (subcommandNamed(f, w)) return true;
    // Removing what the project doesn't list is named only as a prune (commands-remote-r3-2: "install the dependencies"
    // doesn't ask for it).
    if (f.says === PKG_PRUNES) return hasVerb(w.list, ["prune"]);
    if (f.says === PKG_CLEANS) return hasVerb(w.list, ["autoclean"]);
    if (row) return hasVerb(w.list, ROW_VERBS[row] ?? []) && objectNamed;
    const program = f.program.split(" ").pop() ?? "";
    return (program !== "" && (w.list.includes(program.toLowerCase()) || nameNamed(program, w.raw))) || (f.objects.length > 0 && objectNamed);
  });
}

/**
 * Where a request's clauses part: list punctuation, a full stop or colon before a space (never inside a file's name,
 * "config.json"), dashes between words, brackets, and "but".
 */
const CLAUSE_BREAK = /[;!?,\n()[\]]+|[.:]+(?=\s|$)|\s+[-–—]+\s+|[–—]+|\s+but\s+/iu;
/** Negated words that ask for what follows ("don't forget to push", "don't stop until it's published"). */
const AFFIRMING = /(^|[^\p{L}\p{N}])(?:don['’]?t|do not|never)\s+(?:(?:ever\s+)?forget(?:\s+to)?|hesitate(?:\s+to)?|fail\s+to|stop\s+(?:until|till))(?=$|[^\p{L}\p{N}])/giu;
/**
 * Words that start a condition, a reason or an exception ("push if the tests don't fail", "delete it since I no longer
 * need it", "publish unless the build fails"): a "not" after one is about that part, not the step before it.
 */
const SUBORDINATE = /(^|[^\p{L}\p{N}])(if|unless|except|without|since|because|as|once|when|whenever|until|till|while|whilst|though|although|after|before|so|provided|whether)(?=$|[^\p{L}\p{N}])/giu;
/** A relative "that", "which" or "who" before the "not" ("the files that aren't needed", "the ones that I don't need"). */
const RELATIVE_NOT = /(^|[^\p{L}\p{N}])(that|which|who)\s+(?:(?:i|you|we|they|he|she|it)\s+)?$/iu;
/** Words after which "that" says what to make sure of, not which thing ("make sure that you don't push"). */
const SAYS_THAT = /(^|[^\p{L}\p{N}])(sure|ensure|certain|careful|check|say|said|tell|told|mean|know|think|remember|promise|confirm|guarantee|insist)\s+$/iu;

/** Words that leave something out of a request ("delete everything except .gitkeep", "commit without pushing"). */
const EXCLUDES = /(^|[^\p{L}\p{N}])(except|excepting|excluding|without|other\s+than|apart\s+from|aside\s+from|besides|instead\s+of|rather\s+than)(?=$|[^\p{L}\p{N}])/iu;

/**
 * One clause, split into what it asks for and what it leaves out by name. From a word that leaves something out
 * ("except .gitkeep", "without running the linter") to the clause's end is left out. A "not" in a condition, a reason
 * or a relative clause cuts there ("push my changes if the tests don't fail" asks for "push my changes"); a "not"
 * about the clause's own step drops the clause ("don't git push yet", "I don't want you to push", "push nothing", "a
 * push isn't needed").
 */
function sortClause(clause: string): { asked: string; leftOut: string; ruled: string } {
  const neg = new RegExp(NEGATION.source, "iu").exec(clause);
  const exc = EXCLUDES.exec(clause);
  const at = neg ? neg.index + neg[1].length : clause.length;
  const excAt = exc ? exc.index + exc[1].length : clause.length;
  if (exc && excAt <= at) return { asked: clause.slice(0, excAt), leftOut: clause.slice(excAt), ruled: "" };
  if (!neg) return { asked: clause, leftOut: "", ruled: "" };
  // "delete build/, not src/": what follows the "not" is left out.
  if (/^\s*not\s/iu.test(clause)) return { asked: "", leftOut: clause, ruled: "" };
  if (neg[2].toLowerCase() === "unless") return { asked: clause.slice(0, at), leftOut: "", ruled: "" };
  const before = clause.slice(0, at);
  const rel = RELATIVE_NOT.exec(before);
  if (rel) {
    const start = rel.index + rel[1].length;
    if (!SAYS_THAT.test(before.slice(0, start))) return { asked: clause.slice(0, start), leftOut: "", ruled: "" };
  }
  let cut = -1;
  for (const m of before.matchAll(SUBORDINATE)) cut = m.index + m[1].length;
  // The step a "not" turns round ("don't publish", "no force push"): ruled out (ruledOut), not only unasked.
  return { asked: cut < 0 ? "" : clause.slice(0, cut), leftOut: "", ruled: cut < 0 ? clause.slice(at) : "" };
}

/**
 * An aside in brackets or between two dashes ("don't (ever) delete build", "don't — and I mean it — push"): a clause of
 * its own, and the words around it joined, so a "not" before it still turns round the verb after it (commands-remote-c1-2).
 */
const ASIDE = /\(([^()]*)\)|\[([^[\]]*)\]|\s[-–—]+\s+([^-–—]*?)\s+[-–—]+\s/gu;

/** The user's words as clauses, sorted (sortClause). */
function sorted(userWords: string): { asked: string; leftOut: string; ruled: string }[] {
  const asides: string[] = [];
  const text = userWords.normalize("NFKC").replace(AFFIRMING, "$1")
    // "everything but build" leaves build out; "but" parts clauses otherwise.
    .replace(/(^|[^\p{L}\p{N}])(everything|anything|all)\s+but(?=\s)/giu, "$1$2 except")
    .replace(ASIDE, (_m, a?: string, b?: string, c?: string) => { asides.push(a ?? b ?? c ?? ""); return " "; });
  return [...text.split(CLAUSE_BREAK), ...asides.flatMap(a => a.split(CLAUSE_BREAK))].map(sortClause);
}

/**
 * The user's words without what they say not to do ("don't git push yet", "never force push", "whatever you do, do not
 * push"): a step they ruled out is never one they asked for, so its card keeps "You didn't ask for this." and never says
 * they asked by voice (commands-remote-c1-2). A "not" in a condition, an exception or a reminder leaves the step they
 * asked for as asked ("push if the tests don't fail", "delete build except .gitkeep", "don't forget to push":
 * commands-remote-r2-1). Only the card's words follow from it: any "not" still keeps a step from being announced.
 */
function affirmed(userWords: string): string {
  return sorted(userWords).map(c => c.asked).filter(c => c.trim() !== "").join(". ");
}

/**
 * Whether the words leave out what a finding acts on by name ("delete everything except build/" for `rm -r build`):
 * that step wasn't asked for, whatever else the words ask (commands-remote-r2-1).
 */
function leftOut(f: Finding, userWords: string): boolean {
  const out = sorted(userWords).map(c => c.leftOut).filter(c => c.trim() !== "").join(". ");
  if (out === "") return false;
  const w = wordsOf(out);
  return f.objects.some(o => o.text !== "" && (nameNamed(o.text, w.raw) || pathTokenLoose(o, w) >= 0));
}

/** Words a part that rules a step out may hold besides the step ("don't force it", "never, ever push", "no pushing yet"). */
const RULED_FILLER = new Set([
  "not", "never", "no", "don", "t", "do", "does", "doesn", "didn", "won", "without", "except", "nor", "neither", "avoid",
  "it", "them", "this", "that", "anything", "ever", "yet", "now", "please", "just", "at", "all", "again", "i", "you", "we",
  "repeat", "mean", "want", "to", "a", "an", "the", "any", "and", "or", "s", "under", "circumstances", "whatever", "with", "using",
]);

/**
 * Whether the words rule out one of these findings (commands-remote-c1-2): they leave out what it acts on by name
 * (leftOut), or a part that says not to, or leaves out, names its kind of step or what it adds ("push without force"
 * for a force push, "prepare the release (don't publish)" for `npm publish`) and nothing else, so "delete build/ but
 * don't delete src/" rules out only src's delete. Its card then says "You didn't ask for this.", whatever else the words
 * asked. Card words only: any "not" already keeps a step from being announced.
 */
export function ruledOut(findings: readonly Finding[], userWords: string): boolean {
  if (!userWords || userWords.trim() === "") return false;
  const parts = sorted(userWords).flatMap(c => [c.ruled, c.leftOut]).filter(c => c.trim() !== "");
  return findings.some(f => {
    if (leftOut(f, userWords)) return true;
    const row = rowOf(f, findings);
    const verbs = [...(row ? KIND_VERBS[row] ?? [] : []), ...(RULE_KIND_VERBS[f.rule] ?? [])];
    // A flag's words: `--force` (and `--force-with-lease`) is "force".
    const flags = f.widening.filter(x => /^--?[a-z]/i.test(x)).map(x => userWordList(x)[0] ?? "").filter(x => x.length > 2);
    const forms = new Set(verbs.flatMap(v => v.split(" ").flatMap(verbForms)));
    return parts.some(p => {
      const ws = userWordList(p);
      if (!hasVerb(ws, verbs) && !ws.some(x => flags.includes(x))) return false;
      return ws.every(x => RULED_FILLER.has(x) || forms.has(x) || flags.includes(x));
    });
  });
}

/** Whether the words name a finding's program with its subcommand, in full and in order ("npm ci", "git push"). */
function subcommandNamed(f: Finding, w: Words): boolean {
  const parts = userWordList(f.program);
  return parts.length >= 2 && hasWord(w.list, [parts.join(" ")]);
}

/**
 * The verbs that say what kind of step a finding is, for its card's line only (never for announcing): each row's own
 * verbs without the everyday ones ("update", "save", "open", "stop" and the like), and those of a few findings without
 * a row. A dangerous step named this way but not exactly ("push my changes" for `git push origin main`) says
 * LINES.inexact, not "You didn't ask for this." (commands-remote-v2).
 */
const KIND_VERBS: Readonly<Record<string, readonly string[]>> = {
  "git.push": ["push"],
  "git.push.force": ["push", "force push"],
  "git.branch.delete": ["delete", "remove"],
  "git.reset.hard": ["reset", "discard", "throw away"],
  "git.discard": ["discard", "revert", "undo", "throw away", "restore"],
  "git.clean": ["clean"],
  "git.stash.drop": ["drop"],
  "delete.paths": ROW_VERBS["delete.paths"],
  "overwrite.file": ["overwrite", "replace"],
  "p4.submit": ["submit"],
  "p4.shelve": ["shelve"],
  "p4.revert": ["revert", "discard", "undo"],
  "gh.pr.merge": ["merge"],
  "pkg.publish": ["publish", "release"],
  "docker.push": ["push"],
  "pkg.install": ["install", "reinstall", "uninstall", "upgrade"],
  "service.restart": ["restart", "reload"],
  "upload.host": ["upload", "sync", "transfer"],
  "kill.process": ["kill"],
};
/**
 * Kind verbs by a finding's own rule: a copy or a move that replaces a file, find's deleting, removing scheduled jobs,
 * replacing them from a file ("schedule the jobs in jobs.txt"; "install my cron jobs" is KIND_PHRASES').
 */
const RULE_KIND_VERBS: Readonly<Record<string, readonly string[]>> = {
  "system.schedule": ["schedule", "reschedule"],
  "system.unschedule": ["remove", "delete", "clear", "cancel"],
  "posix.cp": ["copy"],
  "ps.Copy-Item": ["copy"],
  "posix.mv": ["move", "rename"],
  "ps.Move-Item": ["move", "rename"],
  "posix.find.delete": ROW_VERBS["delete.paths"],
};

/**
 * Whether the user's words, though they don't name any of these findings (mentioned), ask for that kind of step: one of
 * its kind's verbs (KIND_VERBS). Only the card's words follow from it; the decision doesn't.
 */
export function namedKind(findings: readonly Finding[], userWords: string): boolean {
  if (!userWords || userWords.trim() === "") return false;
  const w = wordsOf(affirmed(userWords));
  return findings.some(f => {
    if (leftOut(f, userWords)) return false;
    if (f.says === PKG_PRUNES || f.says === PKG_CLEANS) return hasVerb(w.list, PRUNE_KIND_VERBS);
    if (KIND_PHRASES[f.rule]?.(w.list)) return true;
    const row = rowOf(f, findings);
    return hasVerb(w.list, [...(row ? KIND_VERBS[row] ?? [] : []), ...(RULE_KIND_VERBS[f.rule] ?? [])]);
  });
}

/** A prune's kind (commands-remote-r3-2): pruning, removing or cleaning up packages, or installing them as a project lists them. */
const PRUNE_KIND_VERBS: readonly string[] = ["prune", "remove", "uninstall", "clean up", "clean", "tidy", "install", "reinstall"];

/** Kinds said with a noun of their own ("install my cron jobs from jobs.txt", "set up the crontab"; commands-remote-r3-2). */
const KIND_PHRASES: Readonly<Record<string, (list: readonly string[]) => boolean>> = {
  "system.schedule": l => hasWord(l, ["cron", "crontab", "cronjob", "cronjobs", "cron job", "cron jobs"]) && hasVerb(l, ["install", "add", "set up", "load", "replace", "update", "change", "put"]),
};
