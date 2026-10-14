# Ember — visual design

Ember is a small living flame that rides beside the cursor. The look takes its
inspiration from the fire spirit idea (the product is named after Ember from
Pixar's *Elemental*), but it is an **original design**: no face, no character
likeness and no film assets, so the product never imitates the film's character.

## Principles

- **The flame is the status light.** Colour, height, flicker and sparks say what
  the agent is doing before you read anything.
- **Its thinking is always written down.** The bubble under the flame shows the state, a
  one-line intent, the streaming thought (last three lines) and the current step with its "why".
- **Readable over any app.** A faint dark halo sits under the flame and the bubble
  is smoked glass, so both read over white and dark windows alike.
- **Cheap to draw.** Canvas 2D with additive blending; no WebGL, so it runs on
  RHEL VMs and remote sessions without a GPU. Honours `prefers-reduced-motion`.

## Moods

| Mood | Look | Driven by |
|---|---|---|
| Ready (`idle`) | Warm orange flame, gentle flicker | no turn running |
| Listening | Brighter and taller; rings pulse with the voice level | push-to-talk key down |
| Thinking | Golden-white; sparks orbit the core | `assistant.reasoning_delta` |
| Working (`acting`) | Intense; leaves an ember trail while flying; spark burst on each click | `tool.execution_start` |
| Showing you (`guiding`) | Parks beside the target and rings it with small flames | `point_at` tool |
| Needs you (`attention`) | Violet, fast flicker; bubble shows buttons | `onPreToolUse` → ask, `permission.requested` |
| Stuck (`error`) | Dim deep red, guttering, smoke | `tool.execution_complete` with `success: false` |
| Done | White-gold flare and spark shower, then back to Ready | `session.idle` after a successful turn |

## Motion

- **Follow:** spring (stiffness 190, damping 24) to cursor + (30, 34) px.
- **Flight:** quadratic-bezier arc, 0.6–1.4 s by distance, up to 80 px lift,
  smoothstep easing (ported from clicky, MIT). Ember leads; the real cursor follows
  ~10% behind on a human-like path (ghost-cursor in the app).
- **Click:** spark burst + ring at the click point; the cursor dips to 84 %.

## Code

`src/overlay/ember/`: `flame.ts` (renderer), `bubble.ts` (reasoning bubble),
`motion.ts` (follow spring, flight), `moods.ts` (palettes and parameters).
`demo/playground/` drives them over a simulated GNOME desktop:
`npm install && npm run build:playground` → `dist/ember-playground.html`.
