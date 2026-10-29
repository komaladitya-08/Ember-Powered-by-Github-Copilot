# Release fixes, round 4: merging one package into the integration branch

This round's packages (one branch each, `fix4/<key>`, based on the integration head of the round) are verified on their own. They are merged one at
a time into the integration branch `ember-improve/20261027-release-fixes`, worktree `/home/user/wt/relfix-int`, which
starts at the head your task names. Your task names ONE package to merge and gives its final report.

## Read first
- `specs/relfix4/common.md` (rules, commit style and trailers, UI copy, checks).
- `specs/relfix4/pkg-<key>.json` (the items) and the report in your task text. For each conflict, read the merge commit
  of the package that changed the other side (`git -C /home/user/wt/relfix-int log --oneline <start>..HEAD -- <file>`).

## Merge
1. `git -C /home/user/wt/relfix-int merge --no-ff --no-commit fix4/<key>`.
2. Resolve every conflict so BOTH sides' fixes survive. Never drop a fix, a test or a doc line from either side. Where
   both changed the same logic, write the version that does what both describe. Copy and contract pins follow the
   merged code.
3. Make the merged tree build and pass: `npx tsc --noEmit`, `npm run lint`, then `npx vitest run` on every test file the
   package added or changed AND every test file of the conflicted modules. Fix any failure the combination causes, with
   the smallest change, in the merge commit itself.
4. Commit: subject `Merge fix4/<key>: <the package's title in a few words>`, body listing each conflicted file and how it
   was resolved (one line each), the checks with counts, then the two trailer lines from common.md.
5. Do not push. Do not touch other worktrees or the fix branches.

## Return
The merge commit hash; each conflicted file and its resolution; any interaction you fixed; the checks with counts; and
anything you could not reconcile (with why).
