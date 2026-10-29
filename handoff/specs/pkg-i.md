# Integration packages I-win and I-mac: make Ember work end to end on Windows / macOS, proven on real CI runners

Read first: /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/pkg-common.md
(conventions, koffi/Electron rules, commit style and trailers, commit early and often), then the design
/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/design.md §1.5, §10,
§11.5 (package I), §12 (risks, the "verify" items, the manual test plan §12.3), plus the sections for your OS (§5–§9).
Also read: specs/ci-findings.md (what real runners already showed), specs/followups.md (items collected from every
package's report — do the ones for your OS; shared items are listed for the lead), and the package reports summarised
there. Everything from Step 0, Phase 1, the FX corrections, WS, MS and V is merged into your base.

## Goal
Your OS (I-win: Windows; I-mac: macOS) works end to end in Ember, proven on GitHub's real runners:
1. I-win only: switch the platforms on in app/main/platform/index.ts (both the win32 and the darwin branch, so
   I-mac needn't touch the file), per §11.5.
2. Every integration suite for your OS passes in your CI job with its env var set (no `--allow-missing`, no
   `--allow-missing-sidecar` left in your job): Windows — win32-desktop, uia-bridge, ax-sidecar, win32-system,
   win32-vocabulary, and a new ember-win32.test.ts with §11.5's Ember-level checks; macOS — darwin-desktop,
   darwin-system, darwin-vocabulary, ax-sidecar (once the AX provider is merged), and a new ember-darwin.test.ts with
   §11.5's checks. Fix the code (or the test, when the test is wrong) until they pass. "Not testable on this runner:
   <reason>" (from the facts the job prints) is acceptable only where §12 says so — never a vacuous pass.
3. The packaged app for your OS launches, and `--doctor` gives a sensible report on the runner.
4. Linux stays byte-for-byte unchanged (run the full local gate before each push).

## Files you own
- I-win: app/main/platform/index.ts, app/main/platform/win32/**, sidecar/uia/**, app/sidecar-host/providers/uia*.ts
  and Windows-only code paths in app/sidecar-host/**, the `windows` job in .github/workflows/ci.yml,
  test/integration/{win32-*,uia-*,ember-win32}.test.ts, Windows test fixtures, test/unit/{platform-win32-*,win32-*}.test.ts.
- I-mac: app/main/platform/darwin/**, app/sidecar-host/providers/ax-*.ts (after AX merges), the `macos` and
  `macos-x64` jobs in ci.yml, test/integration/{darwin-*,ember-darwin}.test.ts, macOS fixtures,
  test/unit/{platform-darwin-*,darwin-*}.test.ts.
- Shared files (app/main/main.ts, policy/**, agent/**, hands/**, perception/**, app/shared/**, app/renderer/**,
  scripts/**): edit only when your OS can't work otherwise, minimally, Linux unchanged, each change listed in your
  report (the other integration package and the SSH/WSL packages may touch them too; the lead merges).

## Running CI yourself
- Your branch is pushed to origin and is yours alone: I-win `ember-improve/20261022-ci-win`, I-mac
  `ember-improve/20261022-ci-mac`. Push with `git push -u origin <branch>` (retry on network errors 2s/4s/8s/16s).
  Never push any other branch. To pick up the lead's newer work: `git fetch origin ember-improve/20261022-windows-macos
  && git merge FETCH_HEAD` (merge, never rebase).
- Load the GitHub tools with ToolSearch ("select:mcp__github__actions_run_trigger,mcp__github__actions_list,
  mcp__github__actions_get,mcp__github__get_job_logs"). Trigger: actions_run_trigger method "run_workflow",
  owner "komaladitya-08", repo "Ember-Powered-by-Github-Copilot", workflow_id "ci.yml", ref <your branch>, inputs
  {"only": "windows"} (I-mac: {"only": "macos"}). Find the run with actions_list list_workflow_runs filtered by your
  branch, wait for it (poll every ~2-3 minutes with sleep-free checks: do useful local work between polls), then read
  failures with get_job_logs (job_id, return_content true, tail_lines 200-400).
- Budget: macOS minutes cost 10x. Batch fixes; verify locally first (tsc, lint, unit tests, the C# harness for the
  bridge); aim for at most ~8 runs. Never upload packages (leave "packages" false).

## Report (<= 70 lines)
Commits; what is now proven on the real runner (suite by suite, counts); what is "not testable on this runner" and
why; shared-file changes; remaining manual checks from §12.3; anything the lead must decide.
