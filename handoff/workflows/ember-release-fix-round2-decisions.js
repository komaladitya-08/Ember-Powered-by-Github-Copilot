export const meta = {
  name: 'ember-release-fix-round2-decisions',
  description: "Build the owner's round-2 decisions that can start now (RunAsNode off on macOS, typed-ahead): fix, verify independently, repair; one agent at a time",
  phases: [
    { title: 'Fix', detail: 'one agent per package, test first, in its own worktree' },
    { title: 'Verify', detail: 'an independent agent checks the work against the base and the decision' },
    { title: 'Repair', detail: 'the package agent addresses what the verifier found' },
  ],
}

const SP = '/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad'
const BASE = 'bbe8ab2'
const KEYS = ['runasnode2', 'typeahead2']

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
// One agent at a time: another round-2 workflow is running three.
const L = limiter(1)
const run = (prompt, opts) => L(() => agent(prompt, opts))

const FIX = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['sha', 'subject', 'items'] } },
    items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['fixed', 'partial', 'not-reproduced', 'left'] },
      how: { type: 'string' },
      test: { type: 'string' },
    }, required: ['id', 'status', 'how', 'test'] } },
    checks: { type: 'string' },
    sharedHunks: { type: 'array', items: { type: 'string' } },
    forDocs: { type: 'array', items: { type: 'string' } },
    ciOnly: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['branch', 'commits', 'items', 'checks', 'sharedHunks', 'forDocs', 'ciOnly'],
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

const wt = key => `/home/user/wt/fx2-${key}`
const fixPrompt = key => `You are the fix agent for package "${key}" of Ember's release fixes, round 2: an owner decision to build.
Read ${SP}/specs/relfix2/common.md first (binding), ${SP}/specs/relfix2/decisions.md (the owner's decisions), then ${SP}/specs/relfix2/pkg-${key}.json (your item and what you own).
Worktree: ${wt(key)}, branch fix2/${key}, base ${BASE}.
Build it as common.md says: read the code first, write tests that fail on the current code, make the change, show the tests passing, commit in reviewable steps. Run every check common.md lists before your last commit. What only real Windows/macOS CI can prove goes in ciOnly, exactly (which job, which step, what it must print).
Your return value is the report: the item's status, the commits, the checks with exact counts, every shared hunk, exact lines for the docs, and ciOnly.`
const verifyPrompt = (key, fix) => `You are an independent verifier for package "${key}" of Ember's release fixes, round 2 (an owner decision). Do not trust the fix agent's report: check the code.
Read ${SP}/specs/relfix2/common.md, ${SP}/specs/relfix2/decisions.md and ${SP}/specs/relfix2/pkg-${key}.json.
The work: \`git -C ${wt(key)} log --oneline ${BASE}..fix2/${key}\` and \`git -C ${wt(key)} diff ${BASE}..fix2/${key}\`. Do not edit, commit or stash in that worktree.
Check: the decision is built as written (and anything the agent narrowed is justified); the new tests fail on the base (throwaway worktree: \`git -C ${wt(key)} worktree add ${SP}/relfix2-verify/${key}/base ${BASE}\`, symlink node_modules from /home/user/Ember-Powered-by-Github-Copilot/node_modules, copy the tests in, run, remove it); \`npx tsc --noEmit\`, \`npm run lint\`, the full \`npm test\`, \`npm run build\` and the smoke test pass in ${wt(key)}; nothing regresses on any OS (read the diff for per-OS paths and Electron APIs: utilityProcess, setActivationPolicy, BrowserWindow focus routes, fuses per platform); workflow YAML parses and its run blocks pass bash -n; security: nothing fails open (for RunAsNode: no remaining macOS launch with ELECTRON_RUN_AS_NODE, the askpass mode can't be driven to do anything but answer one prompt for the running Ember with its nonce, the CI check really proves node mode is refused).
Fix agent's report, for reference only: ${JSON.stringify(fix).slice(0, 12000)}
Return every problem (must-fix / should-fix) with a concrete fix, and the ids you verified.`
const repairPrompt = (key, fix, v) => `You are the fix agent for package "${key}" of Ember's release fixes, round 2, back for a second pass.
Read ${SP}/specs/relfix2/common.md, ${SP}/specs/relfix2/decisions.md and ${SP}/specs/relfix2/pkg-${key}.json again. Worktree ${wt(key)}, branch fix2/${key}, base ${BASE}.
An independent verifier found the problems below. Address every one (fix with a test that fails first, or say why the verifier is wrong, with evidence). Commit, re-run every check.
Problems: ${JSON.stringify(v.problems)}
Your first report, for reference: ${JSON.stringify(fix).slice(0, 8000)}
Return the report for the WHOLE package in its final state.`

const chain = key => run(fixPrompt(key), { label: `fix:${key}`, phase: 'Fix', schema: FIX })
  .then(fix => fix ? run(verifyPrompt(key, fix), { label: `verify:${key}`, phase: 'Verify', schema: VERIFY }).then(v => ({ fix, v })) : { fix: null, v: null })
  .then(({ fix, v }) => fix && v && v.problems.length
    ? run(repairPrompt(key, fix, v), { label: `repair:${key}`, phase: 'Repair', schema: FIX }).then(r => ({ key, fix, verify: v, repair: r }))
    : { key, fix, verify: v, repair: null })

const results = (await parallel(KEYS.map(k => () => chain(k)))).filter(Boolean)
for (const r of results) log(`${r.key}: ${r.fix ? (r.repair || r.fix).items.map(i => i.id + ' ' + i.status).join(', ') : 'fix agent failed'}; verifier problems ${r.verify ? r.verify.problems.length : 'n/a'}`)
return results
