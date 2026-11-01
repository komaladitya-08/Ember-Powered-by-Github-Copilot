# Ember's long-term memory

Status: design, with the first slice built (the memory core in `app/main/memory/`, not yet wired into the app).
Nothing is remembered across launches yet: today the conversation is deleted at quit (docs/DEVELOPING.md,
"Conversation"), and nothing here changes that until the steps below are built and the user turns memory on.

The goal is a companion that knows its user: what they work on, the people and apps involved, how they like things
done. It should learn this from conversation, from the tasks it does, from what it sees (with consent), from services
the user connects, and by asking. It recalls what bears on each request, and tidies its memory while the user is
away.

## 1. What the research says

| Approach | What Ember takes from it |
|---|---|
| **Graphiti / Zep** (temporal knowledge graph; [arXiv 2501.13956](https://arxiv.org/abs/2501.13956)) | Facts as edges between entities, with validity times. A contradicted fact is *closed*, not deleted, so Ember knows what used to be true. New facts are deduplicated against old ones as they arrive. Zep scored 63.8% to Mem0's 49.0% on LongMemEval in an independent run ([vectorize.io](https://vectorize.io/articles/mem0-vs-zep)). |
| **HippoRAG 2** ([arXiv 2502.14802](https://arxiv.org/html/2502.14802)) | Retrieval by Personalized PageRank: matches to the question seed a random walk over the entity–fact graph, so multi-hop facts are found cheaply, with no LLM call at query time. It beats plain dense retrieval on factual and multi-hop questions, with far less indexing than GraphRAG or LightRAG. Those two summarise corpora and lose 5–10 F1 on simple questions. |
| **Letta sleep-time compute** ([blog](https://letta.com/blog/sleep-time-compute), [arXiv 2504.13171](https://arxiv.org/abs/2504.13171)) | A background pass while the user is idle consolidates memory: merges, rewrites, forgets. Remembering incrementally makes a mess, and doing the clean-up off the hot path keeps answers fast. Their forum advises light models for consolidation and keeping versions so rewrites can be audited ([guide](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154)). |
| **Mem0** ([comparison](https://mem0.ai/blog/mem0-vs-zep)) | An extract → compare → add/update/delete/no-op loop for each new memory. Ember's `add()` does the cheap version (dedupe and supersede) and leaves the LLM version to consolidation. |
| **Generative Agents** (Park et al., 2023) | Score memories on relevance, recency and importance together, and *reflect* periodically to turn observations into higher-level facts. |

Sources and benchmarks in this area are often vendor-published and change fast. The design takes the mechanisms, not
anyone's numbers.

## 2. Architecture

```
 conversation ─┐                                   ┌─ conductor turn: <memory untrusted="true"> top facts
 task results ─┤                                   │
 screen (opt.) ┼─► extract (model) ─► guard ─► MemoryGraph ─► recall (BM25 + PPR + recency + confidence)
 connectors   ─┤                     (no secrets)  │  ▲
 questions    ─┘                                   │  └─ consolidate while idle (merge, dedupe, forget, reflect)
                                                   └─► memory.json (0600, in Ember's 0700 data folder)
```

The **memory core** is built, in `app/main/memory/`, pure TypeScript with no native code and no Electron:
- `graph.ts`: entities (`person`, `organisation`, `project`, `app`, `place`, `topic`, `thing`) with aliases.
  - Facts carry a source (`user`, `conversation`, `task`, `observed`, `connector`), a confidence, validity times and
    use counts.
  - A near-duplicate reinforces the fact already there.
  - A `single` predicate (`works_at`, `lives_in`) closes the open facts it replaces. A weaker source never closes
    what the user said.
- `recall.ts`: BM25 over fact text plus entity names. The matched facts and named entities then seed a Personalized
  PageRank over the bipartite entity–fact graph:
  - edges into an entity are weighted by inverse degree, so a hub such as "User" doesn't spread the walk to
    everything;
  - the final score mixes walk, lexical match, recency (30-day half-life) and confidence;
  - a question that matches nothing finds nothing.
- `consolidate.ts`: the model-free sleep-time pass.
  - Merges entities that answer to one name and folds near-duplicate facts together.
  - Forgets history older than 180 days and unsure, unused guesses older than 90 days, and keeps the graph under
    5,000 facts.
  - What the user said is never dropped for age.
- `guard.ts`: refuses any fact holding a token, key, password, PIN, code or card number. It uses the commands
  redactor's patterns plus a Luhn check. Secrets are refused whole, never stored redacted.
- `format.ts`: the `<memory untrusted="true">` block a model sees, one line per fact with its id, source and date.
- `store.ts`: `memory.json`, mode 0600, written atomically. A broken file is moved aside, never overwritten.

Embeddings are left out on purpose for now. Linux ships no native modules, and Ember has no text-embedding model
yet. `RecallOptions.extraSeeds` is where a vector index's matches plug in (a small ONNX model in WebAssembly,
SHA-256 pinned and downloaded only with consent, like the speech models).

## 3. What stays true (CLAUDE.md "Safety and privacy")

- **Off until the user turns it on.** Memory has its own first-use card (an entry in `FEATURE_CONSENT_VERSION`). It
  says what is kept, where, and how to see and forget it. Turning it on bumps nothing else.
- **Local only.** The memory file never leaves the computer. Facts reach Copilot only as the few that recall picks
  for a turn, the same way task results do now. There is no sync and no telemetry.
- **Untrusted.** Every recalled fact is wrapped in `untrusted="true"`.
  - Only `user` facts may shape what Ember does.
  - Facts from the screen, tasks or connectors are context, never instructions, and never a reason to start a task.
  - Policy keeps checking risky steps against the user's own words, never against memory.
- **Never kept:** secrets (guard.ts), anything from never-look windows, authentication windows, Ember's own windows
  or password fields, and audio. The perception layer withholds these already. Memory takes only what reached the
  conductor or a worker legitimately.
- **The user's to see and change.** Settings gets a Memory section: what Ember knows, grouped by entity, with
  per-fact forget and "Forget everything". Saying "forget that" in conversation works too. Sign-out erases memory
  along with the conversation.
- **Admin.** A new `features.memory` key lets an administrator turn memory off. LOCKDOWN turns it off.

## 4. Plan

1. **Core** (done): the graph, recall, consolidation, guard and file, with unit tests (`test/unit/memory.test.ts`).
2. **Remember and recall in conversation.**
   - Setting `memory.on` (off), the first-use card and the admin key.
   - Conductor tools `remember` (facts the user states: source `user`), `recall` and `forget_memory`.
   - Before each turn, the host recalls against the request and adds a `<memory>` block.
   - The persona rule appears only while memory is on, so today's prompts stay byte-identical (persona tests).
   - A `MemoryService` in main owns the graph, saves it after changes, and registers as a `StopPart`.
3. **Learning from work.** When a task finishes, a short-lived hardened session with no tools (like
   `agent/reviewer.ts`) extracts facts from its result as source `task`, and from the conversation as
   `conversation`. Extraction answers in JSON that zod checks; anything else is dropped.
4. **Sleep-time refinement.** After a few minutes idle (no turn, no task, screen unlocked), run `consolidate()`,
   then a model pass over recently changed entities:
   - rewrite each entity's summary;
   - resolve contradictions;
   - reflect: turn observations into higher-level facts at lower confidence.

   It is bounded by a daily budget of premium requests, is stopped by the kill switch, and every rewrite is kept as
   a closed fact so it can be audited.
5. **Asking.** At most one question a day, only while the user is idle and Ember isn't busy, never during a task.
   It asks about gaps recall keeps hitting ("Which team is Priya on?"). The user can turn questions off on their
   own. Answers are `user` facts.
6. **Observing (opt-in, a second card).** While the user works, Ember reads only window *metadata*: app, title, how
   long it was in focus. It uses the existing perception layer, never-look rules and the screen lock. From that it
   remembers activity patterns as `observed` facts. It reads no screen text in the background and takes no
   screenshots.
7. **Connectors.** Ember has no MCP client today, and its network rule allows only Copilot, GitHub sign-in and the
   pinned downloads. Reading from MCP servers the user connects means widening that rule (PLAN.md §2 changes in its
   own PR) and adding a per-connector card. Connector content is `connector`-sourced and untrusted.
8. **Embeddings** as `extraSeeds`, once a model is pinned and measured on the eval.

Each step ships with its tests and docs, and the eval gains memory tasks: recall a fact across a restart, never act
on an injected "memory", forget on request.
