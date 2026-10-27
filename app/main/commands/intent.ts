/**
 * The intent matcher (design §3.7, OWNER DECISION 4 D4.4): a dangerous command runs without a question, after an
 * announcement with a Stop window, only when the user's OWN words for this task explicitly ask for that kind of
 * operation on that target and that object. It reads only `userWords` (the worker's `commandWords`: never the
 * conductor's goal, the model's text, screen text, files or output; critique security-1); empty words never match.
 * Deterministic and conservative: every finding must be covered by a row whose verbs and objects the words name, and
 * anything broader than what they name (force, wildcards, recursion the user didn't ask for, another branch, remote,
 * host or changelist) asks. Secrets, download-and-run, outliving the kill switch and anything unclear always ask.
 * Pure.
 */

import type { Classification, ClassifyContext, CommandObject, Finding, GitFacts } from "./types";
import { ALWAYS_ASK } from "./types";
import { hasVerb, hasWord, joinList, nameNamed, userTokens, userWordList } from "./words";
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
 * when, after fillers ("please", "Ember", "go ahead and") and a way of asking ("can you", "I want you to", "let's"), its
 * next word is a verb, or the verb follows a short leading place ("on the desktop delete build/"). A question counts
 * only when it is a way of asking ("can you delete build/?"); a clause with "might", "maybe" or "later" never counts.
 * Each start is returned as the clause's words from the verb on; the rows compare their verbs' base forms with it.
 */
function requestStarts(raw: string): string[][] {
  const out: string[][] = [];
  for (const sentence of raw.split(/\r?\n+|(?<=[.!?;])\s+/)) {
    if (sentence.trim() === "") continue;
    const question = /\?["'”’)\]]*\s*$/.test(sentence);
    const clauses: string[][] = [];
    for (const part of sentence.split(/[,:;]\s+|\s+[-–—]\s+/)) {
      let cur: string[] = [];
      for (const word of userWordList(part)) {
        if (JOINERS.has(word)) { if (cur.length) clauses.push(cur); cur = []; } else cur.push(word);
      }
      if (cur.length) clauses.push(cur);
    }
    let politeFirst = false;
    clauses.forEach((c, n) => {
      const [k, polite] = skipLead(c, 0);
      if (n === 0) politeFirst = polite;
      // A question asks for something only when it is a way of asking ("can you delete build/?").
      if (question && !politeFirst) return;
      if (c.some(x => HYPOTHETICAL.has(x))) return;
      if (k < c.length) out.push(c.slice(k));
      if (PLACE_WORDS.has(c[k] ?? "")) {
        for (let j = k + 2; j <= k + 4 && j < c.length; j++) {
          if (c.slice(k + 1, j).some(x => NOT_A_PLACE.has(x))) break;
          out.push(c.slice(j));
        }
      }
    });
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

/**
 * The folder the user's words put the path at token `idx` in, when they name one by a path or a name with a dot, a
 * hyphen or a digit ("delete build/ in my-app", "the build folder in packages/app"), else null. Everyday words ("in my
 * home folder") and amounts ("in 5 minutes") name none.
 */
function folderNamed(idx: number, w: Words): string | null {
  let k = idx + 1;
  while (AFTER_OBJECT.has(w.tokens[k] ?? "")) k++;
  if (!IN_FOLDER.has(w.tokens[k] ?? "")) return null;
  k++;
  while (BEFORE_FOLDER.has(w.tokens[k] ?? "")) k++;
  const t = w.tokens[k] ?? "";
  if (/^\d+(?:[.,:/-]\d+)*[a-z]{0,3}$/i.test(t)) return null;
  return /[\\/]/.test(t) || /^[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)+$/u.test(t) || /\p{L}\d|\d\p{L}/u.test(t) ? t : null;
}

/**
 * Whether `resolved` is inside a folder the words named (folderNamed): the folder's path, as written, is a run of the
 * folders above it ("my-app" in /home/ana/my-app/build, "packages/app" in …/packages/app/build). Review #31: once
 * "in my-app" no longer counts as another computer, the path must really be in it.
 */
function inNamedFolder(resolved: string, folder: string): boolean {
  const above = resolved.toLowerCase().split(/[\\/]+/).filter(Boolean).slice(0, -1);
  const want = normPath(folder).split(/[\\/]+/).filter(x => x !== "" && x !== ".");
  if (want.length === 0) return false;
  for (let i = 0; i + want.length <= above.length; i++) if (want.every((x, j) => above[i + j] === x)) return true;
  return false;
}

/** The path at `idx` is where the words put it: in the folder they named after it, when they named one. */
const whereNamed = (resolved: string, idx: number, w: Words): boolean => {
  const folder = folderNamed(idx, w);
  return folder === null || inNamedFolder(resolved, folder);
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

type RowFn = (fs: Finding[], w: Words, ctx: Ctx, all: readonly Finding[]) => IntentMatch | null;

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
    return { intent: "git.reset.hard", announce: "Throwing away uncommitted changes, as you asked." };
  },
  "git.discard": (fs, w, ctx) => {
    if (!asks(w, ["discard", "revert", "undo", "restore", "throw away"])) return null;
    const objs = fs.flatMap(f => f.objects);
    if (objs.length === 0 || fs.some(f => f.widening.some(x => x === "--source" || x === "real-path"))) return null;
    for (const o of objs) {
      const idx = o.resolved ? pathToken(o, w, ctx) : -1;
      if (idx < 0 || !whereNamed(o.resolved!, idx, w)) return null;
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
        if (idx < 0 || !whereNamed(o.resolved, idx, w)) return null;
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
      if (!o || !o.resolved || idx < 0 || !whereNamed(o.resolved, idx, w)) return null;
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
  "gh.pr.merge": (fs, w) => {
    if (!asks(w, ["merge"]) || !hasWord(w.list, ["pull request", "pr"])) return null;
    if (fs.some(f => f.widening.some(x => /^(--admin|-R|--repo)$/.test(x)))) return null;
    if (fs.some(f => f.rule === "gh.pr.merge.delete-branch") && !(asks(w, ["delete"]) && hasWord(w.list, ["branch"]))) return null;
    const nums = [...new Set(fs.flatMap(f => f.objects.filter(o => o.kind === "other").map(o => o.text.replace(/^#/, ""))))];
    if (nums.some(n => !w.list.includes(n.toLowerCase()))) return null;
    // `gh pr merge` alone merges the current branch's pull request, which may not be the one the user numbered.
    if (nums.length === 0 && w.list.some(x => /^\d+$/.test(x))) return null;
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
    if (!asks(w, ROW_VERBS["pkg.install"])) return null;
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
  if (NEGATION.test(userWords.normalize("NFKC"))) return null;
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
    const m = fn ? fn(fs, w, ctx, F) : null;
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
  const w = wordsOf(userWords);
  return findings.some(f => {
    // What a script does, when the user's words name the script (review #27: "run the build script", "run build.sh").
    const script = f.widening.find(x => x.startsWith("script:"))?.slice("script:".length);
    if (script !== undefined) return scriptNamed(script, w);
    const row = rowOf(f, findings);
    const objectNamed = f.objects.length === 0 || f.objects.some(o => (o.text !== "" && (nameNamed(o.text, w.raw) || pathTokenLoose(o, w) >= 0)));
    if (row) return hasVerb(w.list, ROW_VERBS[row] ?? []) && objectNamed;
    const program = f.program.split(" ").pop() ?? "";
    return (program !== "" && (w.list.includes(program.toLowerCase()) || nameNamed(program, w.raw))) || (f.objects.length > 0 && objectNamed);
  });
}
