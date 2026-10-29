# Common brief for the second round of packages (Phase 1, Phase 2 system packages, and the FX corrections)

You are one of twelve packages running at the same time on Ember's Windows/macOS port. Everything in
/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/pkg-common.md
still applies (worktree rules, commit early and often, the owner's conventions, koffi and Electron rules, testing, commit
style and trailers, final report format) — read it first.

## Your instructions are in the binding design
/tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/design.md
(revision 2). Read, in this order: the header and "Departures from decisions"; §1 (phases); §11 (find your package's row:
it lists EXACTLY the files you own, the existing tests you may edit and the new tests you must add); then every section
your row and §4/§5–§10 name for your package; and the "Critique resolutions" and "Corrections for running packages"
entries that concern you. The TypeScript in §2 is normative and is already committed (Step 0) — code against the files on
your branch (app/main/platform/types.ts, platform/os.ts, app/shared/shortcuts.ts, app/shared/words.ts).

- **Phase 1 packages (P1-A … P1-E)** must keep Linux byte-for-byte identical except the five allowed changes listed in
  §1.3. Packages that call another Phase 1 package's new functions code against the signatures the design documents;
  the lead merges in the order §11.2 gives and reconciles small signature differences, so state every function you
  expect from another package (name + signature) in your report under "Needs from others".
- **FX packages (FX-PH, FX-PD, FX-PW, FX-PU, FX-PK)** apply exactly the corrections listed for that package in the
  design's "Corrections for running packages" (and any "Critique resolutions" rows pointing at it), touching ONLY the
  files that package owns (§11.1). Verify each correction against the code first; if one is wrong or already done,
  say so in the report rather than forcing it. The C# bridge must keep compiling as C# 5: run the lead's harness
  (`cd /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/cscheck &&
  ../dotnet/dotnet build -p:SrcFile=<abs path to ember_uia.cs> -v q`).
- **WS and MS** build the Windows / macOS SystemPlatform and composition exactly as §7–§9 and §11.3 say, on top of the
  merged port/win32 / port/darwin code (don't edit those packages' files; ask under "Needs from others").
- New dependency (only FX-PK, decision Q8 = yes): `resedit`, pinned exactly, devDependency. Update package.json and
  package-lock.json on your branch with `npm install --save-dev --save-exact resedit@<version> --package-lock-only` run
  in a temporary copy of the repo's package.json/package-lock.json, then copy both files back; to make it importable for
  your local checks, run `npm install --no-save resedit@<same version>` in the MAIN checkout
  (/home/user/Ember-Powered-by-Github-Copilot) — the only exception to "never touch the main checkout", and only that
  command. Check its licence (MIT) is covered by the spec's `License:` line rules in scripts/package (devDependencies are
  not staged, so normally nothing changes there).

Decisions the lead took on the design's open questions (apply them where your package is concerned): Q1–Q6 defaults;
Q7 keep D6's Windows letters; Q8 resedit yes; Q9 no windows-2025 row, the macos-x64 job only on default-branch pushes
and tags; Q10 Input Monitoring required (fail closed) until CI evidence shows otherwise; Q11 the "Unblock it" fix is
offered (user-initiated, only Ember's two helper files, never under AllSigned/Restricted/CLM).

Integration tests for Windows/macOS behaviour go where §11 says, gated by the env var it names (fail when set and the
facility is missing). The lead runs them on real windows-2022 / macos-15 runners after merging, so make them precise.

## Real-runner evidence
FX-PU, FX-PH and FX-PD: CI has already run your package's integration tests on real windows-2022 / macos-15 runners.
The failures are in /tmp/claude-0/-home-user-Ember-Powered-by-Github-Copilot/9df81ff3-d6fa-5078-ac02-9c8dbaa6cb03/scratchpad/specs/ci-findings.md —
fixing them is part of your package (in your own files; tests included), alongside the design's corrections.
