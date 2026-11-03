# Ember status

Where the work stands and what comes next. PLAN.md §10 keeps the detailed progress and departures; this file is the short list to pick up from.

## Next steps

### 1. Quality review across every part of Ember
A broad pass over the whole app, area by area, looking for bugs and for ways to make Ember a more delightful and convenient thing to use. One reviewer per area:

1. first-run setup and consent
2. Home (Settings, Conversation, Memory)
3. the overlay, bubble and handle
4. voice in: wake, listening, Voice Match
5. voice out: speech, the natural voice
6. tasks: the conductor, workers, leases
7. safety: policy, confirmations, the kill switch
8. commands, WSL and SSH
9. memory
10. extensions, connectors and the user's own model provider
11. Windows
12. resilience: restarts, sign-out, failures, low disk

Triage what they find, fix it in small PRs, and keep the eval green.

### 2. Wake to listening time
The eval's "Wake → listening" timing read 321–343 ms against its 300 ms target on branches merged after native Linux speech landed, and 205–234 ms on a quiet machine. Find out whether that is load or a real regression, and fix it if it is real.

### 3. Super agent
Turn Ember into an agent that can run real project work, not only drive apps:
- orchestrate Copilot SDK coding sessions the way other chat-based agents do, so it can work on the user's projects;
- follow the super-agent approach in the design notes;
- work naturally in projects that don't use Git or GitHub (most of the owner's work doesn't).

Waiting on the owner's answers to the design's open decisions (D1–D15) before building.

### 4. Follow-ups noted while merging
- Spoken yes: update CLAUDE.md's "Policy decides" bullet to describe task-scoped voice trust (needs the owner's go-ahead).
- Spoken yes on Windows and macOS: a verified spoken request still grants task trust where Ember can't tell the user from its own speakers. The owner is to decide whether to block it there.
- Defer the exit in `startupFailed()` (app/main/main.ts) out of Electron's "ready" event, as the login-item test was fixed to do.
- Voice smoke: add a multi-turn scenario with Ember speaking in between, and require `killswitch.pulled` in the stop scenario.
- Voice: record real Windows microphones; the measurements so far use synthesised voices. Run `scripts/voice/bench.mjs --kokoro` on the owner's PC for the natural voice's speed check.
- Work without asking: check Pluma, xed, Mousepad and Notepad++ against real accessibility trees (only gedit was); consider message boxes in CJK, Greek, Arabic, Hebrew and Ukrainian.
- Bubble: when a newer request is pending as the previous turn ends, Ember's face briefly turns neutral.
- Tasks: a window closed by keys (Ctrl+W, Ctrl+Q) gets no "closed" note.
- Extensions: consent cards should show the server's tools; stop removed extension servers at once.
- Keep the GitHub token out of the runtime's environment.
- Verify process ids before killing.
- Guard reminder cancellation.
- Releases: decide whether to attach the eSpeak NG source archives.
- Optional: the 20-second extensions integration test failed once on two PRs and passed on re-run; look at it if it fails again.
