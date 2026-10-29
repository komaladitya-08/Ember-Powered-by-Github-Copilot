# INT: wire the SSH/WSL packages together and apply every hand-off

Read first: specs/sshwsl/pkg-common.md (and specs/pkg-common.md it points to), specs/sshwsl/decisions.md (OWNER DECISION 4
and the lead rulings), the design specs/sshwsl/design.md (§2.6, §3.8, §5, §7, §11), and above all
specs/sshwsl/handoffs.md: every row in it is a seam between two packages that each built against the other's contract
with fakes. All twelve main packages are now merged on your base (S0a, S0b, MX, AG, UI, WA, SC, WB, SA, SB, CL, RUN,
TG). Your job is to make them one working feature.

Worktree: given in your task (branch sw/int). Never push. Commit early and often, one coherent commit per seam.

## What to do
1. Go through handoffs.md row by row. For each: check the code on your branch; if the seam is already right, note it;
   otherwise make the smallest change that joins the two sides (in either package's file), with a unit test that fails
   without it. Especially:
   - flow.ts DEFAULT_JUDGE → CL's real functions; WA's and SC's stand-in secret trackers → CL's trackSecretPrompts;
     SB's stand-in classifier → CL's classifyCommand; UI's visible.ts → re-export of CL's visible-text.
   - WA/SB → RUN's real commandEnv, sweepScript, launchArgv, localFacts, job host (and settle the job host's stdin-EOF
     semantics between RUN, WA and WB: probes send a script then EOF; interactive runs relay stdin).
   - SA ↔ SB wire details (machineIdHash bytes, hello busy/denied, serve argv, remote-runtime.json, tarball layout);
     the hello timeout vs the agent's takeover wait (make the PC's hello timeout exceed the agent's wait, or shorten the
     wait, so a reconnect can't time out by design).
   - SC ↔ SA RemoteLink semantics (error codes, request order, held bytes for late onBytes listeners with a bound,
     epoch increasing on stop()).
   - TG: every row addressed to TG (kill switch parts: SA stopAll, WSL helpers; emberPids; doctor rows; consent
     re-asks on resolution/machine change; forget after uninstall; wsl.on written with its consent; consentPanel for
     commands; ui:cmdstop routing; onAnswer/onConsent per window). main.ts: emberPids, onAnnounce, AskContext.target,
     admin.commands, sshHostsLimited.
   - AG rows from SC (valueSha256, quoting remote words, rules into stamp.rules).
   - Packaging: ship resources/ssh/ember_askpass.cs (Windows layout), NSLocalNetworkUsageDescription mentions SSH
     computers (macOS bundle), remote parts staged (done in ci.yml by the lead).
   - WRONG-TARGET (safety, from DOC's review; see handoffs.md): when the user's words name any known target other than
     the bound one, D4.4 never announces — every dangerous command asks and the card names the target; test it.
   - Memory bound on lines read by AtspiSidecar (a hostile WSL distro's helper could send an endless line): cap a line
     (e.g. 8 MiB, matching the sidecar's largest legitimate reply), fail closed by restarting the helper.
2. Then prove the whole feature works end to end ON THIS LINUX CONTAINER where it can:
   - local commands: start Ember's command flow headlessly in a unit/integration test with the real classifier, real
     POSIX runner (script(1)) and a fake UI that approves on the card: an ordinary command runs without asking; `rm -r
     build` asks; with the user's words "delete build" it announces then runs; `rm -rf ~` with those words asks; a
     command touching Ember's settings is refused; the kill switch stops a running `sleep 100` within budget.
   - SSH to localhost (sshd is installable here: apt-get install -y openssh-server if not present; use a throwaway
     user or key; the loopback test switch for unpackaged builds): connect, install the remote parts, hello, run an
     ordinary command and a dangerous one (asks), Stop, drop the link (the remote stops), reconnect; run the existing
     integration suites (remote-ssh, ssh-transport, remote-desktop under Xvfb) with their env vars. Remove what you
     installed afterwards.
   Report exactly what ran and its counts.
3. Full gate: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run test:sidecar`, `npm run build`,
   `xvfb-run -a npm run test:smoke`. Linux/Windows/macOS behaviour without SSH/WSL and with commands off must be
   unchanged (prompts byte-identical; run the eval's scripted task suite if it runs here:
   `dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node eval/run.mjs` — needs gedit; skip and say so if
   unavailable).

## Report (<= 60 lines)
Commits; each handoffs.md row: done / already right / not possible and why; the end-to-end runs and their counts; the
gate's counts; what only Windows/macOS/WSL CI can prove.
