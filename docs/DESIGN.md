# Ember — visual design

Ember is a small, expressive companion that rides beside the cursor. The idea comes
from the living fire spirit (the product is named after Ember from Pixar's *Elemental*),
but every character is an **original design** with no film assets or likeness.

The first direction, a particle flame with no face, was retired because it could not
show expressions.

## Characters

All four ship in the app and are chosen in setup, settings, the handle menu, or by voice.
They share one emotion rig, so switching never changes behaviour.

| Character | Look | Signature |
|---|---|---|
| **Cinder** (default) | Coal critter with glowing cracks, ember eyes, flame tuft, two floating mitten hands | Hands act: wave, cup an ear, point at targets, type, thumbs-up |
| **Wisp** | Living flame with a face | Flame height and colour carry the mood |
| **Glassling** | Squishy drop of molten glass with bubbles inside | Jiggles; cools from amber to pale blue when sad |
| **Glint** | Two glowing eyes and a spark | Most legible at cursor size; least distracting |

## The rig (`packages/characters/src/rig.ts`)

- **12 emotions**, each a set of face parameters on springs (eyes, lids, pupils, brows,
  mouth, blush, squash, tilt, energy, heat), plus an emote and a gesture.
- **Always alive:** breathing, blinks (sometimes double), saccades and gaze at the pointer,
  hops with landing squash, a talking mouth flap, idle fidgets (glance, yawn, hop), optional sleep.
- **Emotes** are outlined so they read on any background: `…` thinking, `?` confused,
  `!` surprised, `zzz` sleepy, sparkles proud, sweat drop worried.

| Emotion | Shown when |
|---|---|
| Ready (`neutral`) | Resting beside your cursor |
| Happy | "Hey Ember!" |
| Listening | Wake word heard |
| Thinking | Model is reasoning |
| Focused | Working in an app |
| Curious | Showing you where to click |
| Surprised | Something unexpected popped up |
| Confused | Can't find something |
| Needs you (`worried`) | Asking before a risky step |
| Sorry (`sad`) | A step failed |
| Proud | Task done |
| Sleepy | Nothing to do for a while |

## Bubble and motion

- **Reasoning bubble** (`packages/bubble`): smoked glass, always dark so it reads over any
  app; state chip, one-line intent, streaming thought (last three lines), current step
  with its reason, and buttons when Ember needs a decision.
- **Follow:** spring to cursor + offset. **Flight:** quadratic-bezier arc, 0.6–1.4 s by
  distance, smoothstep easing (`packages/motion`, ported from clicky, MIT).
- **Mini-Embers** mark tasks running in background windows or on Ember's desk.

## Code

`packages/characters` (rig, renderers), `packages/bubble`, `packages/motion`.
The interactive prototype is `demo/character-lab` (`npm run build:lab`).
