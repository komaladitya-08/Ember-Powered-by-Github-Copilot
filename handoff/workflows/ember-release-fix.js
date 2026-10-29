export const meta = {
  name: 'ember-release-fix',
  description: 'Fix every pre-release review finding in its package worktree, verify each package independently, repair what the verifier finds',
  phases: [
    { title: 'Fix', detail: 'one agent per package fixes its findings in its own worktree, test first' },
    { title: 'Verify', detail: 'an independent agent checks every finding is fixed, tested against the base and regression-free' },
    { title: 'Repair', detail: 'the package agent addresses what the verifier found' },
  ],
}

// args: array of package keys (see specs/relfix/packages.mjs)
const SP = '/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad'
const BASE = '1b39bb3'

const FIX = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'object', properties: { sha: { type: 'string' }, subject: { type: 'string' }, ids: { type: 'array', items: { type: 'number' } } }, required: ['sha', 'subject', 'ids'] } },
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'number' },
      status: { type: 'string', enum: ['fixed', 'partial', 'not-reproduced', 'left'] },
      how: { type: 'string', description: 'what you changed, or why nothing (with evidence)' },
      test: { type: 'string', description: 'the test that failed before and passes now, or why there is none' },
    }, required: ['id', 'status', 'how', 'test'] } },
    checks: { type: 'string', description: 'each check command and its exact counts' },
    sharedHunks: { type: 'array', items: { type: 'string' }, description: 'every hunk in a file another package owns: file and what' },
    forDocs: { type: 'array', items: { type: 'string' }, description: 'README/install/CHANGELOG lines the docs package should write' },
    ciOnly: { type: 'array', items: { type: 'string' }, description: 'what only real Windows/macOS/WSL/SSH CI can prove' },
    notes: { type: 'string' },
  },
  required: ['branch', 'commits', 'findings', 'checks', 'sharedHunks', 'ciOnly'],
}

const VERIFY = {
  type: 'object',
  properties: {
    problems: { type: 'array', items: { type: 'object', properties: {
      id: { type: ['number', 'null'], description: 'the finding id, or null for a regression or a problem outside any finding' },
      severity: { type: 'string', enum: ['must-fix', 'should-fix'] },
      what: { type: 'string', description: 'concrete scenario or evidence' },
      fix: { type: 'string' },
    }, required: ['id', 'severity', 'what', 'fix'] } },
    verifiedFixed: { type: 'array', items: { type: 'number' } },
    checks: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['problems', 'verifiedFixed', 'checks'],
}

const wt = key => `/home/user/wt/fx-${key}`

const fixPrompt = key => `You are the fix agent for package "${key}" of Ember's release fixes.
Read ${SP}/specs/relfix/common.md first (binding), then ${SP}/specs/relfix/pkg-${key}.json (your findings and what you own).
Worktree: ${wt(key)}, branch fix/${key}, base ${BASE}.
Fix every finding in your package file as common.md says: check it against the code, reproduce it with a test that fails first, fix the root cause, show the test passing, commit (one commit per finding or tightly related group; cite the ids as "(review #N)" in the body). Run every check common.md lists before your last commit.
Your return value is the report: one entry per finding id in your package file (all of them), the commits, the checks with exact counts, every shared hunk, lines for the docs package, and what only real Windows/macOS/WSL/SSH CI can prove.`

const verifyPrompt = (key, fix) => `You are an independent verifier for package "${key}" of Ember's release fixes. Do not trust the fix agent's report: check the code.
Read ${SP}/specs/relfix/common.md (the rules the fix agent worked under, including the owner's decisions V1 and S1) and ${SP}/specs/relfix/pkg-${key}.json (the findings).
The work: \`git -C ${wt(key)} log --oneline ${BASE}..fix/${key}\` and \`git -C ${wt(key)} diff ${BASE}..fix/${key}\`. Do not edit, commit or stash in that worktree.
For every finding in the package file:
- Is its scenario really gone? Re-run the reviewer's repro (${SP}/release-review/<lens>/) or write your own scratch test under ${SP}/relfix-verify/${key}/.
- Does the new test fail on the base? Make a throwaway worktree: \`git -C ${wt(key)} worktree add ${SP}/relfix-verify/${key}/base ${BASE}\`, symlink node_modules (ln -s /home/user/Ember-Powered-by-Github-Copilot/node_modules), copy the new or changed test files in, run them there, then \`git worktree remove --force\` it.
- A finding marked not-reproduced: is that right? Check the evidence yourself.
Then look for regressions: run \`npx tsc --noEmit\`, \`npm run lint\`, the full \`npm test\` and \`npm run build\` in ${wt(key)} (a timing-sensitive test that fails under load: re-run it alone), the smoke test or the commands integration suites if the diff touches their areas (see common.md "Checks"). Read the diff for behaviour changed beyond the findings, safety that now fails open, code that breaks on Windows or macOS (paths, Electron APIs per OS, koffi), copy that breaks the UI copy rules, and shared hunks wider than needed.
Fix agent's report, for reference only: ${JSON.stringify(fix).slice(0, 12000)}
Return every problem (must-fix: the finding isn't fixed, a regression, a safety hole, a failing check; should-fix: weak or missing test, copy, scope) with a concrete fix, and the ids you verified fixed.`

const repairPrompt = (key, fix, v) => `You are the fix agent for package "${key}" of Ember's release fixes, back for a second round.
Read ${SP}/specs/relfix/common.md again (binding) and ${SP}/specs/relfix/pkg-${key}.json. Worktree ${wt(key)}, branch fix/${key}, base ${BASE}.
An independent verifier checked your work and found the problems below. Address every one (must-fix and should-fix): fix it with a test that fails first, or, if the verifier is wrong, say why with evidence. Commit, and re-run every check common.md lists.
Problems: ${JSON.stringify(v.problems)}
Your first report, for reference: ${JSON.stringify(fix).slice(0, 8000)}
Return the report for the WHOLE package in its final state (every finding id, all commits so far, the final checks).`

const results = await pipeline(
  args,
  key => agent(fixPrompt(key), { label: `fix:${key}`, phase: 'Fix', schema: FIX }),
  (fix, key) => fix
    ? agent(verifyPrompt(key, fix), { label: `verify:${key}`, phase: 'Verify', schema: VERIFY }).then(v => ({ fix, v }))
    : { fix: null, v: null },
  ({ fix, v }, key) => fix && v && v.problems.length
    ? agent(repairPrompt(key, fix, v), { label: `repair:${key}`, phase: 'Repair', schema: FIX }).then(r => ({ key, fix, verify: v, repair: r }))
    : { key, fix, verify: v, repair: null },
)
for (const r of results.filter(Boolean)) log(`${r.key}: ${r.fix ? r.fix.findings.filter(f => f.status === 'fixed').length + ' fixed' : 'fix agent failed'}; verifier problems ${r.verify ? r.verify.problems.length : 'n/a'}; repaired ${r.repair ? 'yes' : 'no'}`)
return results