export const meta = {
  name: 'ember-release-fix-round3',
  description: 'Merge the CI-proven decision branches, build the last owner decisions and round-2 leftovers in package worktrees (fix, verify, repair), merge sequentially, then gate and review the whole release from three angles',
  phases: [
    { title: 'Merge in', detail: 'RunAsNode-off-on-macOS and typed-ahead branches, then a gate' },
    { title: 'Fix', detail: 'one agent per package, test first, in its own worktree' },
    { title: 'Verify', detail: 'an independent agent checks every item against the base and looks for regressions' },
    { title: 'Repair', detail: 'the package agent addresses what the verifier found' },
    { title: 'Merge', detail: 'one package at a time into the integration branch' },
    { title: 'Final', detail: 'full gate, and three adversarial reviews of everything since the first review' },
  ],
}

const SP = '/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad'
const START = '9912de5'
const FIRST_REVIEW_BASE = '1b39bb3'
const KEYS = ['offer3', 'confirm3', 'textsize3', 'handle3', 'shortcuts3']
const MERGE_ORDER = ['offer3', 'confirm3', 'textsize3', 'handle3', 'shortcuts3']

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

const gatePrompt = (what) => `You run the gate on Ember's integration branch ${what}. Worktree /home/user/wt/relfix-int (branch ember-improve/20261027-release-fixes).
Read ${SP}/specs/relfix3/common.md (rules, commit style and trailers). Run, and report exact counts: \`npx tsc --noEmit\`, \`npm run lint\`, \`npm test\` (full; a timing-sensitive failure under load: re-run that file alone and report both), \`npm run build\`, \`xvfb-run -a npm run test:smoke\`, and \`EMBER_INTEGRATION=1 EMBER_COMMANDS_TEST=1 npx vitest run test/integration/commands-flow-local.test.ts test/integration/commands-local.test.ts\`. Parse every workflow file with python3 yaml.
If anything fails, find the cause, fix it with the smallest change in a new commit (never rewrite history, never push), and run the checks again until green. Return the head commit, whether it is green, the checks, and each fix.`

// ── Merge in the two branches already proven on real CI ──
phase('Merge in')
const decisions = [
  { key: 'runasnode2', branch: 'fix2/runasnode2', title: 'RunAsNode off on macOS: the accessibility host and SSH askpass stop running Ember\'s binary as plain Node', ci: 'ci.yml runs 143 and 145 (Intel) and remote.yml 17 green on 948a286' },
  { key: 'typeahead2', branch: 'fix2/typeahead2', title: 'Typed-ahead: tell people to wait for the box, and give the box the keyboard sooner', ci: 'ci.yml run 144 green on 51c3825' },
]
const mergedIn = []
for (const d of decisions) {
  const m = await run(`You merge ONE branch into Ember's integration branch. Read ${SP}/specs/relfix2/merge.md (binding; it was written for round 2 but applies as is) and follow it for branch ${d.branch} (package "${d.key}", items in ${SP}/specs/relfix2/pkg-${d.key}.json; its full report is in ${SP}/specs/relfix2/decisions-results.json under key "${d.key}": read its final report, the "repair" one if present, and its forDocs lines). The integration branch is at ${START} plus any merges listed here: ${JSON.stringify(mergedIn)}. The branch was proven on real CI (${d.ci}) against bbe8ab2; round 2's merges have changed main.ts, the overlay, docs and CI files since, so resolve conflicts so both sides survive. The branch's forDocs lines were never applied: write them into README.md / CHANGELOG.md / DEVELOPING.md in the merge commit (check each against the code). Subject: Merge ${d.branch}: <title in a few words> (title: ${d.title}).`, { label: `mergein:${d.key}`, phase: 'Merge in', schema: MERGE })
  mergedIn.push({ key: d.key, commit: m && m.commit })
  log(`merge in ${d.key}: ${m ? m.commit + ', conflicts ' + m.conflicts.length : 'failed'}`)
}
const gate1 = await run(gatePrompt('after merging the RunAsNode and typed-ahead branches into round 2\'s result'), { label: 'gate:merge-in', phase: 'Merge in', schema: GATE })
const BASE = (gate1 && gate1.head) || 'HEAD'
log(`round 3 base: ${BASE} (green ${gate1 && gate1.green})`)

// ── Packages ──
const wt = key => `/home/user/wt/fx3-${key}`
const fixPrompt = key => `You are the fix agent for package "${key}" of Ember's release fixes, round 3.
Read ${SP}/specs/relfix3/common.md first (binding), then ${SP}/specs/relfix3/pkg-${key}.json (your items and what you own).
BASE is ${BASE}. Worktree: ${wt(key)}, branch fix3/${key} (create it from BASE as common.md says if it doesn't exist).
Fix or build every item as common.md says: check it against the code, reproduce or specify it with tests that fail first, make the change, show the tests passing, commit in reviewable steps, update the docs your change makes wrong. Run every check common.md lists before your last commit.
Return the report: one entry per item id, the commits, the checks with exact counts, every shared hunk, and what only real Windows/macOS/WSL/SSH CI can prove (exactly: which job, which step, what it must print).`
const verifyPrompt = (key, fix) => `You are an independent verifier for package "${key}" of Ember's release fixes, round 3. Do not trust the fix agent's report: check the code.
Read ${SP}/specs/relfix3/common.md, ${SP}/specs/relfix2/decisions.md and ${SP}/specs/relfix3/pkg-${key}.json.
The work: \`git -C ${wt(key)} log --oneline ${BASE}..fix3/${key}\` and \`git -C ${wt(key)} diff ${BASE}..fix3/${key}\`. Do not edit, commit or stash in that worktree.
For every item: is it really fixed or built as written (scenarios, the owner's decision, every place it should reach on every OS)? Do the new tests fail on BASE (throwaway worktree: \`git -C ${wt(key)} worktree add ${SP}/relfix3-verify/${key}/base ${BASE}\`, remove a stale one first, symlink node_modules from /home/user/Ember-Powered-by-Github-Copilot/node_modules, copy the tests in, run, remove it)? Then regressions: \`npx tsc --noEmit\`, \`npm run lint\`, the full \`npm test\`, \`npm run build\`, the smoke test, and the commands suites if commands changed, in ${wt(key)}. Read the diff for behaviour changed beyond the items, safety that fails open (approval gates, policy, secrets), per-OS breakage (Electron APIs per platform, paths, packaging files such as the .desktop entry), copy that breaks the UI copy rules (sentence case, British spelling, plain words, the same name for the same thing), accessibility (keyboard and screen-reader routes), docs that say what the code doesn't do.
Fix agent's report, for reference only: ${JSON.stringify(fix).slice(0, 12000)}
Return every problem (must-fix / should-fix) with a concrete fix, and the ids you verified.`
const repairPrompt = (key, fix, v) => `You are the fix agent for package "${key}" of Ember's release fixes, round 3, back for a second pass.
Read ${SP}/specs/relfix3/common.md and ${SP}/specs/relfix3/pkg-${key}.json again. BASE ${BASE}; worktree ${wt(key)}, branch fix3/${key}.
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
  const m = await run(`You merge ONE package of Ember's release fixes, round 3, into the integration branch.
Read ${SP}/specs/relfix3/merge.md (binding) and follow it for package "${key}" (branch fix3/${key}). The round started at ${BASE}.
The package's final report: ${JSON.stringify(report).slice(0, 14000)}
Merges already done in this round, in order: ${JSON.stringify(merges.map(x => ({ key: x.key, commit: x.m && x.m.commit })))}`, { label: `merge:${key}`, phase: 'Merge', schema: MERGE })
  merges.push({ key, m })
  log(`merge ${key}: ${m ? m.commit + ', conflicts ' + m.conflicts.length : 'failed'}`)
}

phase('Final')
const gate = await run(gatePrompt('after round 3\'s merges (the release candidate)'), { label: 'final:gate', phase: 'Final', schema: GATE })
const lenses = [
  { key: 'safety', text: 'safety and privacy: the command classifier and approval gates (D4.4 announcements, cards that arm only once seen), the policy engine and its refusals, screen lock, secret fields and redaction, sign-in tokens and their renewal, SSH host keys and askpass (now Ember itself on macOS), the RunAsNode fuse per OS, anything that fails open' },
  { key: 'ux', text: 'what users see and do: copy (sentence case, British spelling, plain words, one name per thing, no internal terms), keyboard and screen-reader routes, text size and forced colours, the bubble\'s timing and held bubbles, the handle and its position, shortcuts and their fallbacks and every place that names them, onboarding and the setup check, docs that promise what the app doesn\'t do' },
  { key: 'platform', text: 'cross-platform and lifecycle correctness: Windows (UI Automation, job host, paths, jump list), macOS (TCC attribution with the utility-process host, askpass mode, Dock menu, fuses), Linux/RHEL 8 (AT-SPI, .desktop actions, RPM/AppImage, Wayland), WSL and SSH targets, processes/timers/listeners that leak or race, crashes and restarts, CI workflows that would not run or prove nothing' },
]
const reviews = await parallel(lenses.map(l => () => run(`You are an adversarial reviewer of Ember's release candidate. Lens: ${l.text}.
Worktree /home/user/wt/relfix-int (branch ember-improve/20261027-release-fixes). Read only; do not edit or commit there (copy the tree under ${SP}/relfix3-review/${l.key}/ for scratch tests).
Scope: everything changed since the first pre-release review, \`git -C /home/user/wt/relfix-int diff ${FIRST_REVIEW_BASE}..HEAD\` (rounds 1-3 of the release fixes; the review reports are in ${SP}/release-review/ and the cross-review in ${SP}/specs/relfix/xreview.json, so you can see what was meant), with extra care for round 3 (\`git log ${BASE}..HEAD\`) and the decision branches (RunAsNode, typed-ahead).
Find real bugs: trace a concrete path from a real input to the failure, check it against the code, and write a scratch test when you can. Report only findings with evidence; none is a fine answer. Severity: critical (data loss, a safety gate that fails open, a crash on start), major (a feature broken for a common case on one OS), minor.`, { label: `review:${l.key}`, phase: 'Final', schema: REVIEW })))

return { mergedIn, gate1, packages: results, merges, gate, reviews: lenses.map((l, i) => ({ lens: l.key, review: reviews[i] })) }
