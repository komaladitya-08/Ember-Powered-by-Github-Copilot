export const meta = {
  name: 'ember-release-fix-round4',
  description: "Fix the final reviews' findings and round 3's leftovers in package worktrees (fix, verify, repair), merge sequentially, then gate (with the checks job's integration tests) and review the round",
  phases: [
    { title: 'Fix', detail: 'one agent per package, confirm the finding first, test first' },
    { title: 'Verify', detail: 'an independent agent checks every item and looks for regressions' },
    { title: 'Repair', detail: 'the package agent addresses what the verifier found' },
    { title: 'Merge', detail: 'one package at a time into the integration branch' },
    { title: 'Final', detail: 'full gate and two adversarial reviews of the round' },
  ],
}

const SP = '/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad'
const BASE = '0866316'
const KEYS = ['auth4', 'cmdwin4', 'perception4', 'launch4', 'offer4', 'ux4']
const MERGE_ORDER = ['auth4', 'cmdwin4', 'offer4', 'perception4', 'launch4', 'ux4']

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
      id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'partial', 'not-reproduced', 'left'] }, how: { type: 'string' }, test: { type: 'string' },
    }, required: ['id', 'status', 'how', 'test'] } },
    checks: { type: 'string' },
    sharedHunks: { type: 'array', items: { type: 'string' } },
    ciOnly: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['branch', 'commits', 'items', 'checks', 'sharedHunks', 'ciOnly'],
}
const VERIFY = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: { type: 'object', properties: {
      id: { type: ['string', 'null'] }, severity: { type: 'string', enum: ['must-fix', 'should-fix'] }, what: { type: 'string' }, fix: { type: 'string' },
    }, required: ['id', 'severity', 'what', 'fix'] } },
    verifiedFixed: { type: 'array', items: { type: 'string' } },
    checks: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['problems', 'verifiedFixed', 'checks'],
}
const MERGE = {
  type: 'object',
  properties: { commit: { type: 'string' }, conflicts: { type: 'array', items: { type: 'string' } }, interactions: { type: 'string' }, checks: { type: 'string' }, unreconciled: { type: 'string' } },
  required: ['commit', 'conflicts', 'checks'],
}
const GATE = {
  type: 'object',
  properties: {
    head: { type: 'string' }, green: { type: 'boolean' }, checks: { type: 'string' },
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

const wt = key => `/home/user/wt/fx4-${key}`
const fixPrompt = key => `You are the fix agent for package "${key}" of Ember's release fixes, round 4 (the last).
Read ${SP}/specs/relfix4/common.md first (binding), then ${SP}/specs/relfix4/pkg-${key}.json (your items and what you own).
BASE is ${BASE}. Worktree: ${wt(key)}, branch fix4/${key} (create it from BASE as common.md says if it doesn't exist).
For each item: confirm it against the code first (a review item was seen by one reviewer only: if it is wrong, change nothing and say not-reproduced with evidence), then reproduce it with a test that fails first, make the smallest root-cause fix, show the test passing, commit, update any doc your change makes wrong. Run every check common.md lists before your last commit.
Return the report: one entry per item id, the commits, the checks with exact counts, every shared hunk, and what only real Windows/macOS/WSL/SSH CI can prove.`
const verifyPrompt = (key, fix) => `You are an independent verifier for package "${key}" of Ember's release fixes, round 4. Do not trust the fix agent's report: check the code.
Read ${SP}/specs/relfix4/common.md and ${SP}/specs/relfix4/pkg-${key}.json.
The work: \`git -C ${wt(key)} log --oneline ${BASE}..fix4/${key}\` and \`git -C ${wt(key)} diff ${BASE}..fix4/${key}\`. Do not edit, commit or stash in that worktree.
For every item: is the reviewer's scenario really gone (or, if marked not-reproduced, is that right)? Do the new tests fail on BASE (throwaway worktree: \`git -C ${wt(key)} worktree add ${SP}/relfix4-verify/${key}/base ${BASE}\`, remove a stale one first, symlink node_modules from /home/user/Ember-Powered-by-Github-Copilot/node_modules, copy the tests in, run, remove it)? Regressions: \`npx tsc --noEmit\`, \`npm run lint\`, the full \`npm test\`, \`npm run build\`, the smoke test, and the commands suites if commands changed, in ${wt(key)}. Read the diff for behaviour changed beyond the items, safety that fails open, per-OS breakage, copy that breaks the UI copy rules, docs that say what the code doesn't do.
Fix agent's report, for reference only: ${JSON.stringify(fix).slice(0, 12000)}
Return every problem (must-fix / should-fix) with a concrete fix, and the ids you verified.`
const repairPrompt = (key, fix, v) => `You are the fix agent for package "${key}" of Ember's release fixes, round 4, back for a second pass.
Read ${SP}/specs/relfix4/common.md and ${SP}/specs/relfix4/pkg-${key}.json again. BASE ${BASE}; worktree ${wt(key)}, branch fix4/${key}.
An independent verifier found the problems below. Address every one (fix with a test that fails first, or say why the verifier is wrong, with evidence). Commit, re-run every check.
Problems: ${JSON.stringify(v.problems)}
Your first report, for reference: ${JSON.stringify(fix).slice(0, 8000)}
Return the report for the WHOLE package in its final state.`

const chain = key => run(fixPrompt(key), { label: `fix:${key}`, phase: 'Fix', schema: FIX })
  .then(fix => fix ? run(verifyPrompt(key, fix), { label: `verify:${key}`, phase: 'Verify', schema: VERIFY }).then(v => ({ fix, v })) : { fix: null, v: null })
  .then(({ fix, v }) => fix && v && v.problems.length
    ? run(repairPrompt(key, fix, v), { label: `repair:${key}`, phase: 'Repair', schema: FIX }).then(r => ({ key, fix, verify: v, repair: r }))
    : { key, fix, verify: v, repair: null })

phase('Fix')
const results = (await parallel(KEYS.map(k => () => chain(k)))).filter(Boolean)
for (const r of results) log(`${r.key}: ${r.fix ? (r.repair || r.fix).items.map(i => i.id + ' ' + i.status).join(', ') : 'fix agent failed'}; verifier problems ${r.verify ? r.verify.problems.length : 'n/a'}`)

phase('Merge')
const merges = []
for (const key of MERGE_ORDER) {
  const r = results.find(x => x.key === key)
  const report = r && (r.repair || r.fix)
  if (!report) { log(`${key}: no report, not merged`); continue }
  const m = await run(`You merge ONE package of Ember's release fixes, round 4, into the integration branch.
Read ${SP}/specs/relfix4/merge.md (binding) and follow it for package "${key}" (branch fix4/${key}). The round started at ${BASE}.
The package's final report: ${JSON.stringify(report).slice(0, 14000)}
Merges already done in this round, in order: ${JSON.stringify(merges.map(x => ({ key: x.key, commit: x.m && x.m.commit })))}`, { label: `merge:${key}`, phase: 'Merge', schema: MERGE })
  merges.push({ key, m })
  log(`merge ${key}: ${m ? m.commit + ', conflicts ' + m.conflicts.length : 'failed'}`)
}

phase('Final')
const gate = await run(`You run the final gate on Ember's release candidate after round 4's merges. Worktree /home/user/wt/relfix-int (branch ember-improve/20261027-release-fixes).
Read ${SP}/specs/relfix4/common.md (rules, commit style and trailers). Run, and report exact counts: \`npx tsc --noEmit\`, \`npm run lint\`, \`npm test\` (full; a timing-sensitive failure under load: re-run that file alone and report both), \`npm run build\`, \`xvfb-run -a npm run test:smoke\`, \`EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts\`, and \`npm run test:integration\` (ci.yml's checks job list; speech tests skip without the models, which is expected). Parse every workflow file with python3 yaml.
If anything fails, find the cause, fix it with the smallest change in a new commit (never rewrite history, never push), and run the checks again until green. Return the head commit, whether it is green, the checks, and each fix.`, { label: 'final:gate', phase: 'Final', schema: GATE })
const lenses = [
  { key: 'safety-ux', text: 'safety (approval gates and their arming, the policy and never-look lists, secret fields, sign-in tokens and sign-out, the command window and its countdowns) and what users see (copy, keyboard and screen-reader routes, the ask box and its context)' },
  { key: 'platform', text: 'cross-platform and lifecycle correctness (Windows, macOS, Linux/RHEL 8, WSL and SSH targets; argv and relaunches; process scans; timers, listeners and processes that leak or race; CI that proves nothing)' },
]
const reviews = await parallel(lenses.map(l => () => run(`You are an adversarial reviewer of round 4 of Ember's release fixes, the last before release. Lens: ${l.text}.
Worktree /home/user/wt/relfix-int (branch ember-improve/20261027-release-fixes). Read only; do not edit or commit there (copy the tree under ${SP}/relfix4-review/${l.key}/ for scratch tests).
Scope: \`git -C /home/user/wt/relfix-int diff ${BASE}..HEAD\` (the round's items are in ${SP}/specs/relfix4/pkg-*.json), and how it interacts with the code around it.
Find real bugs this round introduced or left: trace a concrete path from a real input to the failure, check it against the code, and write a scratch test when you can. Report only findings with evidence; none is a fine answer.`, { label: `review:${l.key}`, phase: 'Final', schema: REVIEW })))

return { packages: results, merges, gate, reviews: lenses.map((l, i) => ({ lens: l.key, review: reviews[i] })) }
