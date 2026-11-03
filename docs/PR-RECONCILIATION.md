# Open PR reconciliation: 3 November 2026

This checkout reconciles the four open proposals against current main. It does not claim the original PRs have been merged or closed.

| PR | Resolution in this checkout |
|---|---|
| [#106: Windows window discovery](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/106) | The shared window walk now waits for two matching walks, at most four. Both pure and backend regression tests cover a window raised during enumeration. |
| [#98: slow Kokoro startup](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/98) | Reapplied to the current provider cache, preserving current fallback/status behaviour. A too-slow verdict expires after a week or a model/provider/thread configuration change. |
| [#99: conversational voice plan](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/99) | [ASSISTANT.md](ASSISTANT.md) remains the living roadmap. Acknowledgements, spoken persona, follow-ups, task announcements, interruption and opt-in memory already have implementations; this repair adds per-turn speech ownership and ordinary negative clarification replies. Earlier endpointing and speculative requests remain proposals requiring measurements. The old blanket prohibition on spoken approvals is superseded by PLAN.md's current question-bound rules, without changing those rules here. |
| [#114: read-only connectors](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/114) | Reuse the implemented MCP plugin pipeline rather than merge a second MCP client and management system. Correct availability, tool metadata and recovery advice; retain the existing consent, pinning, gate, untrusted results, audit and Stop behaviour. See the mapping below. |

## Service access through MCP plugins

Only the user adds a marketplace/plugin in Settings. A plugin manifest supplies a server's program and arguments; the model has no management tool. Ember starts stdio servers through its environment-filtering launcher, discovers their tools, and shows the exact tool list for separate agreement before it grants any to the conversation.

An agreed stdio tool marked read-only, with neither destructive nor open-world hints, may run without another question. Changing tools, unknown tools, remote HTTP calls and tainted/stale metadata ask under the existing extension gate. Denied calls never reach the server. Results remain untrusted data, and revocation/Stop ends the servers. The extension integration suite drives this path through the real Copilot runtime and a scripted model/fake MCP server; it does not connect to real mail or calendar accounts.

This preserves #114's service-reading goal through the current architecture, but does not claim its strict read-only-only product mode or raw-program form shipped unchanged. A plugin may expose changing tools, which require approval. A service that must be read-only should use credentials scoped to reading and an MCP server exposing only read tools; tool hints alone cannot constrain a program's account permissions.

GitHub-hosted connectors remain unavailable until their gating can be verified with that service. macOS stdio servers remain disabled while no safe launcher exists; HTTPS MCP plugins are the supported path there. This reconciliation does not weaken either boundary. [DEVELOPING.md](DEVELOPING.md#extensions-the-runtime-and-the-gate) documents supported manifests, transport and permission checks.

## Release preparation

The app and npm launcher are aligned at 0.1.1 with a matching changelog entry. Publishing a tag/release remains a separate step after validation of the exact final commit and the native release gates. Native microphone/playback quality and screen-reader acceptance are not established by scripted fixtures.
