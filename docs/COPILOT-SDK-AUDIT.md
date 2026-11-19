# Copilot SDK capability audit

This audit covers `@github/copilot-sdk` 1.0.21 and its bundled runtime 1.0.97. The npm release 1.0.34 was also inspected, but has not been adopted or validated with Ember. Experimental SDK APIs and behavior can change with the runtime.

## Approval and agent modes

The SDK exposes experimental session permission modes `manual`, `assisted`, and `allow-all`, and a separate agent mode `autopilot`. Assisted provides a recommendation; it does not promise that every provider supplies an automatic approval. The agent mode is independent of permission mode. GitHub also documents autonomous continuation, approval, and suppression of user questions as separate controls in its [Autopilot guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/use-autopilot-mode).

Ember registers its worker and conductor tools with `skipPermission: true` and applies its policy inside tool handlers. The real-runtime offline tests in `test/integration/sdk-permission-modes.test.ts` show that native permission mode alone does not gate those handlers. In that test's BYOK environment the runtime declined Assisted mode; this is not evidence that Assisted is unavailable with GitHub Copilot or other providers. Removing Ember's policy or simply setting an SDK mode would change behavior without establishing equivalent coverage.

The pinned native Autopilot mode requires a separate lifecycle migration. A controlled offline probe observed that it tells the model to resolve ambiguity without asking, and asks it to call the SDK's `task_complete` tool, which Ember's tool allowlist currently excludes. Without that tool, the runtime made repeated model requests. Allowing it produced a task-complete event, but its summary and success result do not carry Ember's failure and result-view information. An override was rejected by Ember's existing permission handler. Ember currently finishes worker tasks with its own `finish_task` and interprets `session.idle` as completion. A migration needs compatible completion tools, bounded continuation, mode-change and Stop handling, and tests against the selected SDK and supported providers. It must also distinguish an agent's choice from an answer supplied by the user.

## Other SDK features

Ember already uses SDK sessions, resumption, model selection, tool registration, streaming, cancellation, compaction and MCP transport. Structured output is a preview whose availability depends on runtime, model and provider; an unconditional switch would narrow Ember's BYOK support. Native memory and project agents do not by themselves establish Ember's existing account ownership, deletion controls, selected-file boundary or recovery behavior. They need capability and product-equivalence tests before replacing those features.

Before adopting a newer SDK, verify its bundled runtime, supported operating systems and provider compatibility, and run the permission, mode-switch, Stop, desktop, command, remote and voice journeys. Do not infer that a native capability applies to custom actions without testing those actions through the real runtime.
