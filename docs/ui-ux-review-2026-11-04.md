# Ember UI and UX review and implementation

4 November 2026. Review baseline: Ember 0.1.1, main `27e0c7977f74656130acaef6018d35b3cbac4b48`.
The owner authorised implementation and merging after the initial review. This records the resulting changes and
validation boundaries. The complete initial review, source-inspection notes and screenshots are retained with the
working evidence outside the repository; repeatable regression tests are committed in the standard test directories.

The design direction is a quiet desktop companion with a complete conversation/work view behind it. The work
concentrates on reliable controls, truthful acknowledgements, continuity, readability and recovery, while keeping
Ember's existing dark appearance, no-blur performance budget, consent and action policy.

## Review basis

All eight renderers were reviewed: Home, Ask, overlay, handle, mic, prompt, command and desk, with onboarding,
models/providers, projects, voice, memory, reminders, privacy and extensions. Research used current official Apple
Human Interface Guidelines and testing documentation, plus documented ChatGPT, Claude, Gemini, Perplexity and
Microsoft Copilot patterns. Competitor claims are documentation comparisons, not signed-in hands-on certification.

- [Apple design and testing evidence](reviews/2026-11-04/apple-research.md)
- [AI chat and desktop companion comparison](reviews/2026-11-04/chat-benchmarks.md)
- [Speech research, accuracy and resource evidence](voice-review-2026-11-04.md)

Apple guidance supports predictable focus, user control of AI outcomes, restrained materials, understandable
permissions and task-based accessibility testing. It does not imply a universal mobile 44-point desktop rule,
require blur on unsupported hardware, or establish accessibility from a token/audit check alone.
[Apple accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) ·
[Apple generative AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai) ·
[Apple accessibility testing](https://developer.apple.com/documentation/accessibility/performing-accessibility-testing-for-your-app)

## Findings and implemented response

| ID | Initial priority and problem | Result |
| --- | --- | --- |
| UX01 | P1: Undo claimed Forgotten before deletion succeeded | Pending/retryable deletion; explicit owner refusal; success only after acknowledgement |
| UX02 | P1: background memory updates detached focused controls | Keyed stable rows, refreshed labels/source, ownership fallback and guarded asynchronous recovery |
| UX03 | P1: approval activated on pointer-down | Release-inside activation, cancellation on outside/changed/hidden target, stable native routing and keyboard single activation |
| UX04 | P1: no pointer Send for typed Ask | Labelled Send with Enter/Return, multiline and IME safeguards preserved |
| UX05 | P1: Show the question opened directions | Open approval reaches the exact current focusable card or existing command/consent panel, retaining main-owned gates |
| UX06 | P2: tiny/clipped Ask controls | Scaled 28px controls, wrapping suggestions, measured rows and a scroll fallback for capped work areas |
| UX07 | P2: details expired while being read | More time applies to cards; renewable per-renderer reading leases and post-reading grace; exact task controls in Home |
| UX08 | P2: silent 4,000-character transcript cuts | Complete retained answers up to an explicit 131,072-character bound, truncation markers, current-session search and disclosed latest-60 retention |
| UX09 | P2: read-only conversation reached through settings language | Inline Home composer, Copy, explicit Edit then Send, scoped Stop response, Open conversation, draft/account/load guards |
| UX10 | P2: project work buried in configuration | Projects pane separate from Models & connections; stable internal routes retained |
| UX11 | P2: inconvenient file/result handling | Individual Remove and size feedback; immutable running request/provider snapshot; inert code/diffs, Copy and explicit native export |
| UX12 | P2: reminders absent from their inventory | Upcoming local-time/persistence list, exact-record Edit/Cancel, seconds preserved, save-before-timer mutation and scoped bulk confirmation |
| UX13 | P2: retrieval and correction at scale | Memory query/source filters and pages of 50, source-preserving durable correction, labelled selectable settings results |
| UX14 | P2: desk content was only pixels | Explicit bounded read-only accessibility contents with secret/withheld omission, consent/lock/epoch checks and unchanged worker IDs |
| UX15 | P3: first-use personalisation effort | Six essential steps with optional character/introduction detours; consent/setup and actual Stop rehearsal retained |

UX15 is an implemented usability hypothesis, not evidence of improved human task completion. UX14 provides readable
semantics; it does not claim a complete interactive remote accessibility bridge.

### Conversation and work continuity

Home sends an explicitly typed request without capturing a foreground window. Edit fills a draft and never resends
by itself; a fresh Send goes through the existing request and policy path. Stop response is separate from Stop
everything. Source/voice/suggestion provenance is retained in the existing retry path, and no conversation input
answers a formal approval. Transient drafts, retained content and last-answer references clear on authoritative
account reset; delayed initial reads and acknowledgements cannot restore another account's content.

Projects keeps the selected context and request visible, including while work is running. Choosing/removing a file
does not erase the authored request. Previous output survives a failed new request. Applying a patch keeps the
existing exact destination/freshness/confirmation boundary. Native export uses only main-owned displayed output,
checks the chosen destination and refuses selected source files and Ember's private data; export cannot substitute
for Apply patch. Saving/exporting is deliberate and does not introduce automatic conversation retention.

These choices adapt quick-entry continuity and reusable output patterns from
[Claude quick entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac),
[Claude artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) and
[ChatGPT's macOS companion/draft history](https://help.openai.com/en/articles/9703738-chatgpt-macos-app-release-notes).
The OpenAI notes now identify the earlier app as ChatGPT Classic; the comparison does not describe every current
ChatGPT installation or authorise adopting cloud audio/storage behaviour.

### Approvals and focus

An ordinary question still appears without stealing focus. A deliberate Open approval reaches a keyboard-focusable
presentation of the exact live main-process question. The same arming, whole-text, freshness, borrowing and answer
rules apply. Existing command and consent questions stay in their own panels. Pointer-down begins a gesture;
release inside the unchanged target commits it. Moving away, cancellation, replacement or hiding cancels it.
[W3C pointer cancellation](https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html)

Task capability hints never authorise an action: main rechecks exact task IDs, retained retry provenance and native
window identity. Remote/desk/stale/locked/borrowing cases fail closed for Show app. Reader leases expire if a renderer
crashes; after the last reader leaves there is at least five seconds of grace. Explicit Close and Stop remain usable.

### Memory, reminders and desk access

Memory correction is one explicitly submitted local draft, bounded to 400 characters and the exact account view,
record revision and original source. A secret/stale/unavailable-owner request is rejected. Durable save precedes
publication, the original source authority remains unchanged, and stale learning/recall/vector work is invalidated.
A failed save retains the draft. A correction is labelled Corrected by you without promoting an observed/task fact
to trusted user authority.

Reminder edits bind the exact original reminder and save persistence before changing its timer. A failed write
leaves the original intact; editing only words preserves seconds. Later list reads cannot replace a newer pushed
list or an account reset, and acknowledgements do not steal focus from another row/pane. Bulk deletion identifies
both routines and waiting reminders before the second explicit choice.

Desk contents are inert app roles/names/text, with private fields, secret descendants and leaked values omitted.
A fresh user request performs the read; it does not scan continuously, capture an extra image or send data to a
provider. Consent, a known unlocked screen, visibility and the same desk epoch are checked around the read.
`keep:false` leaves identifiers supporting worker actions and approvals untouched. Partial/stale snapshots are
identified and refreshed manually. Interactive semantic takeover and native reader acceptance remain separate work.

## Speech follow-up

The recogniser default remains Moonshine v2 Tiny. Narrower cleanup preserves intended dictation and repeated numeric
spans while recovering whole-sentence decoder loops. Targeted synthetic repeat/number errors improved from 64 to 35
on 146 reference words; three additional model insertion tokens remain. That is regression evidence, not general
microphone WER. Wake/Stop, Voice Match and action thresholds are unchanged.

The original review kept Piper Kristin as default and made Kitten Nano 0.8 FP32 optional. The owner's later
explicit override supersedes that choice: pinned Kitten Nano is now the default production voice, on one CPU
thread with the same real-time-factor gate. Optional Kokoro remains an explicit choice; unavailable or too-slow
default neural speech uses a local system voice. WebAssembly recognition remains supported without neural speech.
The preference remains inspectable, model downloads remain explicit and named by size, and idle neural generation
releases after two minutes. Naturalness still requires listening comparisons; the default change is a user decision.

See [the speech review](voice-review-2026-11-04.md) for exact sources, artifact SHA, comparative metrics and limits.

## Verification and remaining acceptance

Regression suites include actual built Chromium renderers with mocked preload boundaries, real Electron approval
and task interactions, native X11 input-shape/Ask/layout flows, project renderer-to-IPC-to-runtime-to-filesystem
journeys, pure scheduling/ownership tests and actual pinned native voice synthesis. Mocks are explicitly limited to
their boundary; source/colour assertions are not treated as native accessibility or acoustic certification.

The CI checks job runs the new browser journeys with required flags after building. Linux desktop CI runs the
focusable approval/task controls and existing native suites. Pinned Kitten synthesis is required on native Linux,
Windows and macOS speech jobs. The PR records exact final commands, pass/skip counts, operating environment and CI
head alongside these committed tests.

Manual release acceptance still includes:

- VoiceOver, NVDA/Narrator and Orca completing Ask, approval, Stop, failure recovery and result reading.
- Native window activation/focus return, permission revoke/regrant, mixed DPI/monitors and lock/sleep/device recovery.
- Real microphones, accents/noise, wake misses/false wakes, independent correction harm and actual audible Stop timing.
- Blinded voice listening for pronunciation, prosody, fatigue and preference.
- Formative usability comparison of the first-run/navigation changes and understanding of data sharing/action scope.

No telemetry, cloud audio transmission, broader desktop authority, default appearance change or automatic persistent
conversation history was introduced. Merge validation and release acceptance are reported separately.
