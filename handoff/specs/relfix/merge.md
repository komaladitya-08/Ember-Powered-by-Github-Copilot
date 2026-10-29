# Release fixes: merging one package into the integration branch

The 21 fix packages (one branch each, `fix/<key>`, based on 1b39bb3) are verified on their own. They are now merged one
at a time into the integration branch `ember-improve/20261027-release-fixes`, worktree `/home/user/wt/relfix-int`,
which starts at 63b88cd (1b39bb3 plus later CI fixes on the SSH/WSL branch). Your task names ONE package to merge.

## Read first
- `specs/relfix/common.md`: the rules every package worked under (commit style and trailers, UI copy, checks).
- `specs/relfix/reports/<key>.json` for your package: every finding, how it was fixed, the commits, the files it shares
  with other packages (`sharedHunks`), and what only real CI can prove. For each conflict, also read the report of the
  package that changed the other side (`git log --oneline 63b88cd..HEAD -- <file>` shows which merges touched it; each
  merge commit names its package).
- `specs/relfix/pkg-<key>.json`: the findings themselves.

## Merge
1. `git -C /home/user/wt/relfix-int merge --no-ff --no-commit fix/<key>`.
2. Resolve every conflict so BOTH sides' fixes survive. Never drop a fix, a test or a doc line from either side. Where
   both changed the same logic, write the version that does what both reports describe. Where both edited the same
   sentence or test pin, keep the meaning of each; when they truly clash (two different wordings of one message), take
   the later finding's intent and say so in the merge message. Generated or pinned test expectations (copy pins,
   contract pins) follow the merged code.
3. Make the merged tree build and pass: `npx tsc --noEmit`, `npm run lint`, then `npx vitest run` on every test file
   your package added or changed AND every test file of the conflicted modules (`git diff --name-only` helps). Fix any
   failure the combination causes, smallest change, in the merge commit itself.
4. Commit the merge: subject `Merge fix/<key>: <the package's title in a few words>`, body listing each conflicted file
   and how it was resolved (one line each), the checks with counts, then the two trailer lines from common.md.
5. Do not push. Do not touch other worktrees or the fix branches.

## Return
The merge commit hash; each conflicted file and its resolution; any interaction you fixed; the checks with counts; and
anything you could not reconcile (with why), so the lead can decide.
