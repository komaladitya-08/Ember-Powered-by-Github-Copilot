export const meta = {
  name: 'ember-release-fix-round2',
  description: 'Fix the cross-review findings and follow-ups in package worktrees, verify each independently, repair, write the docs, merge sequentially, then gate and review the merged round',
  phases: [
    { title: 'Fix', detail: 'one agent per package, test first, in its own worktree' },
    { title: 'Verify', detail: 'an independent agent checks every item against the base and looks for regressions' },
    { title: 'Repair', detail: 'the package agent addresses what the verifier found' },
    { title: 'Docs', detail: 'the docs package applies every forDocs line from both rounds' },
    { title: 'Merge', detail: 'one package at a time into the integration branch' },
    { title: 'Final', detail: 'full gate and an adversarial read of the merged round' },
  ],
}

const SP = '/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad'
const BASE = 'bbe8ab2'
const KEYS = ['auth2', 'lifecycle2', 'perception2', 'css2', 'ship2', 'bubble2']
const MERGE_ORDER = ['auth2', 'lifecycle2', 'perception2', 'css2', 'ship2', 'bubble2', 'docs2']

// At most three agents at a time (the owner asked for moderate concurrency).
function limiter(n) {
  let active = 0
  const q = []
  const next = () => {
    if (active >= n || !q.length) return
    active++
    const { fn, res, rej } = q.shift()
    fn().then(res, rej).finally(() => { active--; next() })
  }
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next() })
}
const L = limiter(3)
const run = (prompt, opts) => L(() => agent(prompt, opts))

const FIX = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['sha', 'subject', 'items'] } },
    items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['fixed', 'partial', 'not-reproduced', 'left'] },
      how: { type: 'string', description: 'what you changed, or why nothing (with evidence)' },
      test: { type: 'string', description: 'the test that failed before and passes now, or why there is none' },
    }, required: ['id', 'status', 'how', 'test'] } },
    checks: { type: 'string', description: 'each check command and its exact counts' },
    sharedHunks: { type: 'array', items: { type: 'string' } },
    forDocs: { type: 'array', items: { type: 'string' }, description: 'exact README/CHANGELOG/DEVELOPING/COMMANDS-WSL-SSH lines for the docs package' },
    ciOnly: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['branch', 'commits', 'items', 'checks', 'sharedHunks', 'forDocs', 'ciOnly'],
}

const VERIFY = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: { type: 'object', properties: {
      id: { type: ['string', 'null'], description: 'the item id, or null for a regression or a problem outside any item' },
      severity: { type: 'string', enum: ['must-fix', 'should-fix'] },
      what: { type: 'string', description: 'concrete scenario or evidence' },
      fix: { type: 'string' },
    }, required: ['id', 'severity', 'what', 'fix'] } },
    verifiedFixed: { type: 'array', items: { type: 'string' } },
    checks: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['problems', 'verifiedFixed', 'checks'],
}

const MERGE = {
  type: 'object',
  properties: {
    commit: { type: 'string' },
    conflicts: { type: 'array', items: { type: 'string' } },
    interactions: { type: 'string' },
    checks: { type: 'string' },
    unreconciled: { type: 'string' },
  },
  required: ['commit', 'conflicts', 'checks'],
}

const FINAL_GATE = {
  type: 'object',
  properties: {
    head: { type: 'string' },
    green: { type: 'boolean' },
    checks: { type: 'string', description: 'every command and its exact counts' },
    fixes: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, what: { type: 'string' } }, required: ['sha', 'what'] } },
    notes: { type: 'string' },
  },
  required: ['head', 'green', 'checks', 'fixes'],
}

const REVIEW = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
      file: { type: 'string' }, line: { type: 'number' }, scenario: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' },
    }, required: ['title', 'severity', 'file', 'scenario', 'evidence', 'fix'] } },
    notes: { type: 'string' },
  },
  required: ['findings'],
}

const wt = key => `/home/user/wt/fx2-${key}`

const fixPrompt = (key, extra = '') => `You are the fix agent for package "${key}" of Ember's release fixes, round 2.
Read ${SP}/specs/relfix2/common.md first (binding), then ${SP}/specs/relfix2/pkg-${key}.json (your items and what you own).
Worktree: ${wt(key)}, branch fix2/${key}, base ${BASE}.
Fix every item in your package file as common.md says: check it against the code, reproduce it with a test that fails first, fix the root cause, show the test passing, commit (one commit per item or tightly related group). Run every check common.md lists before your last commit.${extra}
Your return value is the report: one entry per item id in your package file (all of them), the commits, the checks with exact counts, every shared hunk, exact lines for the docs package, and what only real Windows/macOS/WSL/SSH CI can prove.`

const verifyPrompt = (key, fix) => `You are an independent verifier for package "${key}" of Ember's release fixes, round 2. Do not trust the fix agent's report: check the code.
Read ${SP}/specs/relfix2/common.md (the rules the fix agent worked under) and ${SP}/specs/relfix2/pkg-${key}.json (the items; cross-review items carry the reviewer's scenario, evidence and repro paths).
The work: \`git -C ${wt(key)} log --oneline ${BASE}..fix2/${key}\` and \`git -C ${wt(key)} diff ${BASE}..fix2/${key}\`. Do not edit, commit or stash in that worktree.
For every item:
- Is its scenario really gone? Re-run the cross-reviewer's repro (paths in the item's evidence, under ${SP}/xreview/) or write your own scratch test under ${SP}/relfix2-verify/${key}/.
- Does the new test fail on the base? Make a throwaway worktree: \`git -C ${wt(key)} worktree add ${SP}/relfix2-verify/${key}/base ${BASE}\` (remove a stale one first with git worktree remove --force), symlink node_modules (ln -s /home/user/Ember-Powered-by-Github-Copilot/node_modules), copy the new or changed test files in, run them there, then \`git worktree remove --force\` it.
- An item marked not-reproduced or left: is that right? Check the evidence yourself.
Then look for regressions: run \`npx tsc --noEmit\`, \`npm run lint\`, the full \`npm test\` and \`npm run build\` in ${wt(key)} (a timing-sensitive test that fails under load: re-run it alone), plus the smoke test or commands integration suites if the diff touches their areas (common.md "Checks"). Read the diff for behaviour changed beyond the items, safety that now fails open, code that breaks on Windows or macOS (paths, per-OS Electron APIs, koffi), copy that breaks the UI copy rules, workflow YAML that won't parse or run, and shared hunks wider than needed.
Fix agent's report, for reference only: ${JSON.stringify(fix).slice(0, 12000)}
Return every problem (must-fix: the item isn't fixed, a regression, a safety hole, a failing check; should-fix: weak or missing test, copy, scope) with a concrete fix, and the ids you verified fixed.`

const repairPrompt = (key, fix, v) => `You are the fix agent for package "${key}" of Ember's release fixes, round 2, back for a second pass.
Read ${SP}/specs/relfix2/common.md again (binding) and ${SP}/specs/relfix2/pkg-${key}.json. Worktree ${wt(key)}, branch fix2/${key}, base ${BASE}.
An independent verifier checked your work and found the problems below. Address every one (must-fix and should-fix): fix it with a test that fails first, or, if the verifier is wrong, say why with evidence. Commit, and re-run every check common.md lists.
Problems: ${JSON.stringify(v.problems)}
Your first report, for reference: ${JSON.stringify(fix).slice(0, 8000)}
Return the report for the WHOLE package in its final state (every item id, all commits so far, the final checks, all forDocs lines).`

const finalOf = r => (r && (r.repair || r.fix)) || null

const packageChain = key => run(fixPrompt(key), { label: `fix:${key}`, phase: 'Fix', schema: FIX })
  .then(fix => fix
    ? run(verifyPrompt(key, fix), { label: `verify:${key}`, phase: 'Verify', schema: VERIFY }).then(v => ({ fix, v }))
    : { fix: null, v: null })
  .then(({ fix, v }) => fix && v && v.problems.length
    ? run(repairPrompt(key, fix, v), { label: `repair:${key}`, phase: 'Repair', schema: FIX }).then(r => ({ key, fix, verify: v, repair: r }))
    : { key, fix, verify: v, repair: null })

phase('Fix')
// Every package's chain runs on its own; the limiter keeps three agents at a time.
const results = (await parallel(KEYS.map(key => () => packageChain(key)))).filter(Boolean)
for (const r of results) log(`${r.key}: ${r.fix ? r.fix.items.filter(i => i.status === 'fixed').length + '/' + r.fix.items.length + ' fixed' : 'fix agent failed'}; verifier problems ${r.verify ? r.verify.problems.length : 'n/a'}; repaired ${r.repair ? 'yes' : 'no'}`)

// The docs package needs every package's forDocs lines: after all of them (a real barrier).
phase('Docs')
const round2Docs = results.map(r => ({ package: r.key, forDocs: (finalOf(r) || {}).forDocs || [] }))
const docsExtra = `\nThis round's packages' forDocs lines (item F-fordocs-round2): ${JSON.stringify(round2Docs).slice(0, 30000)}`
const docs = await packageChain2('docs2', docsExtra)
function packageChain2(key, extra) {
  return run(fixPrompt(key, extra), { label: `fix:${key}`, phase: 'Docs', schema: FIX })
    .then(fix => fix
      ? run(verifyPrompt(key, fix) + `\nFor docs: every line must match what the code does on the merged branches (check the code, not the reports), and the round-2 forDocs given to the fix agent were: ${JSON.stringify(round2Docs).slice(0, 12000)}`, { label: `verify:${key}`, phase: 'Docs', schema: VERIFY }).then(v => ({ fix, v }))
      : { fix: null, v: null })
    .then(({ fix, v }) => fix && v && v.problems.length
      ? run(repairPrompt(key, fix, v), { label: `repair:${key}`, phase: 'Docs', schema: FIX }).then(r => ({ key, fix, verify: v, repair: r }))
      : { key, fix, verify: v, repair: null })
}
const all = [...results, docs].filter(Boolean)

phase('Merge')
const merges = []
for (const key of MERGE_ORDER) {
  const r = all.find(x => x.key === key)
  const report = finalOf(r)
  if (!report) { log(`${key}: no report, not merged`); continue }
  const m = await run(`You merge ONE package of Ember's release fixes, round 2, into the integration branch.
Read ${SP}/specs/relfix2/merge.md (binding) and follow it for package "${key}" (branch fix2/${key}).
The package's final report: ${JSON.stringify(report).slice(0, 14000)}
Merges already done in this round, in order: ${JSON.stringify(merges.map(x => ({ key: x.key, commit: x.m && x.m.commit })))}`, { label: `merge:${key}`, phase: 'Merge', schema: MERGE })
  merges.push({ key, m })
  log(`merge ${key}: ${m ? m.commit + ', conflicts ' + m.conflicts.length : 'failed'}`)
}

phase('Final')
const [gate, review] = await parallel([
  () => run(`You run the final gate on Ember's integration branch after round 2's merges. Worktree /home/user/wt/relfix-int (branch ember-improve/20261027-release-fixes); round 2 started at ${BASE}.
Read ${SP}/specs/relfix2/common.md (rules, commit style and trailers). Run, and report exact counts: \`npx tsc --noEmit\`, \`npm run lint\`, \`npm test\` (full; a timing-sensitive failure under load: re-run that file alone and report both), \`npm run build\`, \`xvfb-run -a npm run test:smoke\`, and \`EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts\`. Parse the workflow files with python3 yaml.
If anything fails, find the cause, fix it with the smallest change in a new commit (never rewrite history, never push), and run the checks again until green. Return the head commit, whether it is green, the checks, and each fix.`, { label: 'final:gate', phase: 'Final', schema: FINAL_GATE }),
  () => run(`You are an adversarial reviewer of Ember's round-2 release fixes, merged on /home/user/wt/relfix-int (branch ember-improve/20261027-release-fixes). Read only; do not edit or commit there.
The round's diff: \`git -C /home/user/wt/relfix-int diff ${BASE}..HEAD\` (and log). The items it fixes are in ${SP}/specs/relfix2/pkg-*.json.
Look for real bugs this round introduced or left: an item whose scenario still happens, safety that fails open (the command classifier and approval gates, the screen-lock and policy gates, secret fields, sign-in tokens), races and leaks (timers, listeners, processes), behaviour that breaks on Windows or macOS (paths, per-OS Electron APIs), merges that dropped one side's fix, and docs that say something the code doesn't do. For each finding, trace a concrete path from a real input to the failure and check it against the code (write a scratch test under ${SP}/relfix2-review/ when you can). Report only findings you have evidence for; none is a fine answer.`, { label: 'final:review', phase: 'Final', schema: REVIEW }),
])

return { packages: all.map(r => ({ key: r.key, fix: r.fix, verify: r.verify, repair: r.repair })), merges, gate, review }
