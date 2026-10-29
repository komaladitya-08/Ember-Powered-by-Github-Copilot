# Ember — visual design

Ember is a small, expressive companion that rides beside the cursor. The idea comes
from the living fire spirit (the product is named after Ember from Pixar's *Elemental*),
but every character is an **original design** with no film assets or likeness.

The first direction, a particle flame with no face, was retired because it could not
show expressions.

## Characters

All four ship in the app and are chosen in setup, settings, or by asking Ember (aloud or typed).
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

- **Reasoning bubble** (`packages/bubble`): dark glass, always dark so it reads over any
  app; state (a dot and a word), one-line intent, streaming thought (last three lines),
  current step with its reason, and buttons when Ember needs a decision. Ember speaks in
  the first person there ("I'm on build-01"), and a number's unit never wraps away from it
  ("15 seconds" in a sentence). While Ember thinks or listens, an ember-coloured glow
  breathes round its edge. The state says
  "Needs you" only when a button needs a decision (a question, an offer, signing in);
  a notice that asks nothing (a stop on another computer, "I'm on build-01") has no
  state word, connecting to a computer is "Working", and a failure is "Problem". With
  **More time to read and answer** (Settings › Comfort & access) every bubble stays ten
  times as long and a question waits 20 minutes instead of 2. The bubble never takes the
  keyboard, so under buttons only the mouse reaches it says where the keyboard finds the same
  thing: an answer cut short (by the lines it takes at the text size) offers **Read all**, and
  under it "Or press Ctrl+Alt+E and go to Conversation." (the settings window keeps the whole
  answer; there is no shortcut of its own for the last answer). A shortcut another app holds is
  never named: the route is then "Or open Ember's settings and go to Conversation.", and an
  announced command names no stop chord, only its **Stop**.
- **Follow:** spring to cursor + offset. **Flight:** quadratic-bezier arc, 0.6–1.4 s by
  distance, smoothstep easing (`packages/motion`, ported from clicky, MIT).
- **Mini-Embers** mark tasks running in background windows or on Ember's desk.

## Design system (`app/renderer/shared/ember.css`)

Every window loads one stylesheet of tokens and controls, following Apple's Human Interface
Guidelines and its current design language (Liquid Glass, macOS 26/27), adapted to a Linux desktop.
Pages use the tokens rather than literals, so Increase Contrast and Reduce Transparency reach every surface.

- **Type:** Inter (bundled, SIL OFL 1.1) stands in for SF Pro, with optical sizes and Inter's own
  tracking. Apple's text styles at a Linux desktop's size (body 14 px) on a 4 px line grid; hierarchy
  comes from size, weight and label colour, never italics. Sentence case; no tracked capitals or
  monospace labels. The text size (Settings > Comfort & access: Default, Large 115 %, Larger 130 %)
  scales the type tokens and each page's own px sizes (`html[data-text-size]`, set by main's
  `page-prefs.ts`) in Settings, the bubble, task cards, the handle and the command and prompt
  windows. The handle's pill and the command and prompt windows grow by the same scale (the pill
  wider; the windows as they open, and at once when they are already open; inside the work area);
  the Ask box, the desk's bar and the terminal's type keep their size (their windows or cells can't
  grow with it).
- **Colour:** Apple's dark system palette (2025) with its increased-contrast variants. The accent is
  system orange (#FF9230), kept for the one prominent action and for status; text on filled buttons
  is dark (white on orange fails contrast). Labels are a warm white at 100 / 66 / 52 %. Ember is
  dark only, whatever the system's appearance: title bars are dark on Windows, macOS and GNOME,
  native menus and dialogs on macOS, and menus on Windows. On Linux, menus and dialogs follow the
  GTK theme, and Windows' message boxes (the quit question) stay light.
  `test/unit/design-system.test.ts` checks the token pairs: labels and system colours on every
  surface, dark text on filled buttons, control edges.
- **Contrast themes** (Windows' forced colours, where the system paints with its own few colours and
  drops shadows and gradients): the tokens become system colours, the accent the system's highlight
  (the prominent button, on-switches, the chosen character, the selected tab). Control edges become
  real borders and outlines, focus is a 2 px highlight outline set 2 px off the control, and every
  symbol and status dot keeps its shape in a system colour. Each page's `@media (forced-colors:
  active)` block adds what only it draws; `BUBBLE_CSS` has its own.
- **Layers:** the settings window and the desk are the content layer: opaque grouped sections, a
  sidebar with coloured symbol tiles (as System Settings), rounded-rectangle buttons, switches, pop-up
  menus, headers above each group and footnotes below it. What floats over other apps (bubble, task
  cards, handle, Ask box, status line) is glass: an opaque frost (no backdrop blur: with software
  compositing it would cost a core, and it can't see other apps) with a sheen, a rim lit from the top
  left and layered shadows, and capsule buttons in two sizes (28 and 24 px).
- **State:** one symbol family (working, waiting its turn, waiting for you, done, failed, stopped)
  beside the words on every surface, with the state in words for screen readers; never colour alone.
- **Shape:** radii 6 / 8 / 10 / 14 / 18 and capsules; nested corners are concentric.
- **Motion:** springs as CSS `linear()` curves. Endless animations (pulses, the thinking glow, the
  focus ring's glow) change only opacity, each on a layer of its own, so they never repaint. Calm mode
  and the desktop's reduced motion stop all of them, in every window: main puts `html.calm` on each of
  Ember's pages as it loads and when the setting changes (`app/main/page-prefs.ts`).
- **Icon** (`assets/ember.svg`): Apple's icon grid (a 104 px continuous-corner tile on a 128 px
  canvas, with its shadow) in the app's warm graphite, lit from above, Cinder silhouetted against its
  own glow. At 32 px and below (`assets/ember-small.svg`) the tile fills the canvas (on Apple's grid in
  the macOS icon), with a lighter graphite and rim that hold on a dark taskbar, and Cinder keeps only
  the flame tufts, the coal's lit rim and the eyes. On Linux every window carries the icon too.

## Code

`packages/characters` (rig, renderers), `packages/bubble`, `packages/motion`.
The interactive prototype is `demo/character-lab` (`npm run build:lab`).
