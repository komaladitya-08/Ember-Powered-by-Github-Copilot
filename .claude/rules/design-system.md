---
paths:
  - "app/renderer/**"
  - "packages/bubble/**"
  - "packages/characters/**"
  - "packages/motion/**"
  - "assets/**"
  - "demo/character-lab/**"
  - "docs/DESIGN.md"
  - "app/main/windows.ts"
  - "app/main/overlay.ts"
  - "app/main/handle.ts"
  - "app/main/ask.ts"
  - "app/main/desk/view.ts"
  - "app/main/page-prefs.ts"
  - "app/main/commands/window.ts"
  - "app/main/remote/prompt-window.ts"
  - "app/shared/shortcuts.ts"
  - "scripts/build-app.mjs"
  - "scripts/package/icon.mjs"
  - "test/unit/page-prefs.test.ts"
  - "test/unit/text-size-windows.test.ts"
  - "test/unit/app-icon.test.ts"
  - "test/unit/design-system.test.ts"
  - "test/unit/ui-copy.test.ts"
---

# Design system: Apple's design language, sized for the weakest target

Ember's windows follow Apple's current Human Interface Guidelines (the macOS 26 Liquid Glass generation) on Linux, Windows and macOS. RHEL 8.4 (no GPU, software compositing, GNOME 3.32) sets the performance budget. Where to find each part:
- `app/renderer/shared/ember.css` holds the tokens and shared controls.
- The bubble's CSS is `BUBBLE_CSS` in `packages/bubble/src/bubble.ts`.
- Page styles are in `app/renderer/{home,overlay,handle,ask,desk,command,prompt}/styles.css` (the mic page has none).
- docs/DESIGN.md "Design system" describes the result; update it when the system changes.

When a case isn't covered here, follow the HIG page for that control.

## Principles

1. **Two layers.** Glass is only for the floating controls over other apps. Content windows are opaque.
2. **Software compositing sets the budget.** Blurs, repaints and animated geometry cost real CPU on the target, and the overlay is always visible, so Chromium never throttles it.
3. **Tokens, not literals.** Pages use `var(--…)`, so that Increase Contrast and Reduce Transparency reach every surface. Calm mode and the text size reach them through `html.calm` and `html[data-text-size]`, which main puts on every page (app/main/page-prefs.ts).
4. **One accent, used sparingly.** Orange marks the one prominent action, status, presence, on-states and focus. It is Ember's identity, not a caution colour: a question is told apart by its shape (brackets, the full still ring) and its words.
5. **Never colour alone.** State is a symbol plus words, and screen readers get the words.
6. **Quiet at rest.** Motion and glow say that something is happening, then stop.
7. **Ember's own look.**
   - Mark AI with Ember's flame and characters, never a generic sparkle, and never imitate Siri or Apple Intelligence (no rainbow, no screen-edge glow).
   - The characters are original designs with no film assets. All four share one rig (packages/characters/src/rig.ts), so a new emotion or gesture must work for every character.
   - **The Ember HUD** is Ember's own vocabulary on the floating layer, on top of the glass: the presence ring and its meters, and lock-on brackets. It exists for presence and telemetry (what Ember is doing, at a glance), in Ember's warm light, never cyan or blue, never a film's layout. Home and the content windows stay System Settings, except Home's still status panel. Every HUD part repeats what words say; none is the only carrier of a state.

## What Ember's look never includes

Name these patterns when you design something new. Vague direction such as "make it clean" drifts toward defaults Ember rejects:
- a light floating layer: the bubble, cards, handle and Ask box stay dark over any app. Only the content windows (`html.content`: Home, command, prompt) have a light look, from `settings.appearance` through `nativeTheme.themeSource` and ember.css's light blocks (owner decision of 2026-11-05)
- serif or display typefaces, or italic accent words
- tracked all-caps, monospace labels, or numbered "01/02/03" section labels
- gradient text, emoji icons, icon fonts, or spinning indicators
- `backdrop-filter` blur, or glass on content windows
- a second filled orange button in one group (or in one view that has no groups, such as a card or the bubble)
- a frosted scroll-edge header or a glass slider (each needs blur or glass on glass)
- HUD spectacle: rotating or orbiting rings, parallax, scrolling micro-numbers, hex grids, fake waveforms or a meter that moves on silence, tracked-caps readouts, or HUD chrome (brackets, accent styling) round untrusted text, over background tasks, or on authentication and never-look windows

## Layers and glass

- **Where glass goes.** Glass is for the floating layer only: the bubble, overlay task cards, the status pill, the handle and the Ask box. Home, the command window and the prompt window build on opaque `--surface-*`. The desk view is a black picture area under a `--glass-solid` bar with a `--separator` edge.
- **How it is drawn.** Never use `backdrop-filter`, and never animate a blur: a blur costs about a core, and a transparent window can't sample other apps anyway. A button's `filter: brightness()` hover and press are not blurs; "What may animate" says where those may transition. Nor sample the screen to tint the glass. Ember's glass is Liquid Glass without the blur: the screen shows through a dense tint. Apply it as `border: 1px solid transparent; background: var(--glass); box-shadow: var(--glass-spec), var(--glass-depth);`, and keep the layer order inside `--glass` (sheen, fill in the padding box, the lit edge in the border box, `--glass-under`). Paint the body once: a fill in both the padding box and the border box made 0.88 into 0.99.
- **Two densities, never mixed on one surface.**
  - **Regular** (`--glass-a` 0.88) under anything with sentences: the bubble, cards, the status line, the Ask box. At 0.88 a white page's black text shows through at under 1.5:1.
  - **Clear** (`--glass-clear-a` 0.55, `--glass-clear`) only where nothing is written: the handle's face end. Words beside it sit on the plate (`--glass-plate-a` 0.86 or more), never on the clear part.
  - **The Glass setting** (`settings.glass`: Clear, Regular, Solid; Comfort & access; `html[data-glass]`, which page-prefs.ts puts on the overlay, handle and Ask pages only). Clear is an even smoky tint (0.68), the same everywhere: no plates, halos or `text-shadow` behind words (the owner rejected both). Its secondary labels are near-white (95% and 90%: hierarchy from weight and size), a tag's words take `--label` (its dot and tint keep the colour), so do a view's toned words (view.css; the tone stays in the mark, tint and rule), a risky question's tag is filled with Clear's `--yellow` under `--on-accent` words (inside `@media not (forced-colors: active)`: in a contrast theme both tokens are system colours, and BUBBLE_CSS's forced block restates the tag as CanvasText on Canvas), Ember's accent as words or marks is `--accent-text-on-glass` (#FFE4CC on Clear, the accent itself on Regular), the system colours take light tints so marks keep 3:1, and Stop keeps a deep red fill. Solid shows nothing through. A new coloured word on floating glass uses `--accent-text-on-glass` or `--label`, never a system colour.
  - Reduce Transparency and Calm make every glass solid (`--glass-a: 1`, `--glass-under` solid, no plate); Increase Contrast makes it solid with a 1px light border. Those blocks win over the Glass setting (written `:root:where([data-glass=…])`).
  - `--glass-a` and its kin are read where `:root` resolves `--glass-fill`: a page changes them on `:root` (or `html[…]`) only, never on an element.
- **Labels on glass.** The floating pages and the bubble set `--label-2` and `--label-3` to `--glass-label-2` (74%) and `--glass-label-3` (66%): one step firmer than in windows, so they pass over a white page. Every label, text colour, tag and control edge on glass is tested against white behind the glass (design-system.test.ts), in Regular and in Clear.
- **No glass on glass.** Buttons, rows and panels on glass use flat neutral fills with an inset `--control-edge` or `--separator` line.
- **Edges and shadows.**
  - Give floating surfaces the dark outer hairline in their shadow (`--glass-hairline`, one device pixel: `--dpx`, which each floating page sets through app/renderer/shared/pixels.ts `watchPixels()`): it keeps the edge crisp over white documents. The Ask box's hint capsule (`.meta`) is the one without. Draw hairlines as `box-shadow` spreads, never as 0.5px borders or a literal 0.5px spread (smeared over two pixels at 125% and 150%).
  - Don't use `mix-blend-mode`, `text-shadow`, `background-clip: text`, `@property` animations or SVG filters, because each re-rasters on the CPU.
  - Shadows on surfaces that move with Ember are tight, with a negative spread (the bubble's `0 12px 28px -8px`). The larger `--glass-depth` is for surfaces that stay put.
- **Without a compositor.** A transparent window paints black there, so the whole window becomes one opaque panel: `var(--glass-solid)` plus `box-shadow: var(--glass-rim)`, with no outer shadows (`html.opaque` in Ask, `body.fallback` in the handle's corner card). Ember switches between the two on its own when the compositor comes or goes (Linux only: Windows and macOS always composite).
- **Window backgrounds.** Set each BrowserWindow's `backgroundColor` to what its page paints, or it flashes before the first paint:
  - `contentBackground()` for Home, the command window and the prompt window (`"#121011"`, or `"#f5f3f1"` when light);
  - `"#242022"` when opaque or in fallback;
  - `"#000000"` for the desk;
  - `"#00000000"` for glass windows.
- **Contrast and transparency settings.** They work mainly by overriding tokens in ember.css (`@media (prefers-reduced-transparency: reduce)` and `@media (prefers-contrast: more)`). Add a per-element rule in the page's own `prefers-contrast` block only for what no token reaches, as Home does for the current section and the slider, and BUBBLE_CSS for its border.
- **Windows contrast themes** are `@media (forced-colors: active)`. ember.css maps the tokens to system colours and makes focus a 2px Highlight outline; every glass surface (the bubble, cards, the status line, the handle, the Ask field and its capsules) gets `background: Canvas`, because the system drops its gradients and its words would each sit on a strip of backplate over the app; each page's own block (and BUBBLE_CSS's) gives every control and group a real 1px `border` or `outline` in `ButtonText` or `CanvasText`, keeps every symbol and status dot in a system colour (a `fill` or masked `background` in a `--label*` token needs its own forced rule: the system keeps those tints, invisible on its window colour; a sidebar tile is a literal, which the system resets, never a token, which it keeps), and marks chosen items beyond colour. A rule with `color: HighlightText` also sets `forced-color-adjust: none`.

## Colour

- **The palette.** Use Apple's 2025 dark system palette through its tokens in ember.css `:root`:
  - `--accent` (system orange), `--accent-2` (thinking, showing you) and `--glow` (Ember's light);
  - `--green`, `--red`, `--yellow`, `--purple`, `--blue` and `--gray`;
  - `--hud-line` (the HUD's warm hairline ink: scales, tracks, bracket edges) and `--hud-dim` (a segment not lit). Both are decorative, never text and never the one sign of a state, so the contrast tests don't hold them to 3:1.

  Write the token, never the hex. The literals that exist are deliberate; don't add more:
  - Home's `--bg` and the placeholder `#9a9592` (ui-copy.test.ts parses both);
  - the sidebar fill and its tile colours;
  - the hero tile gradient (it matches the icon);
  - your own chat bubble's text;
  - the ember glow's gradient stops;
  - the desk's black;
  - neutral fills, keylines and shadows.
- **Labels.** Set text in `--label`, `--label-2` (secondary text, commentary) or `--label-3` (timestamps, metadata), and never add a dimmer one. Apple's 30% tertiary label is about 2.5:1; every Ember label reaches 4.5:1 on every surface.
- **Surfaces.** Build opaque surfaces from three tokens:
  - `--surface-0` for the window;
  - `--surface-1` for a grouped section;
  - `--surface-2` for a field, row or callout inside a section.

  Divide with `--separator`, and edge a section with `--group-edge`. Home also defines `--panel`, `--line`, `--fg`, `--muted`, `--ok`, `--warn` and `--fail` as aliases.
- **The accent.**
  - Keep it for five jobs:
    - the one prominent action in a view;
    - status (the working symbol, the status-pill dot, the mic badge, the desk frame while you drive);
    - presence (the ring's lit ticks, the microphone mark, the voice meter, a question's brackets);
    - control on-states;
    - links, the caret and the focus ring.
  - Ember's identity also uses it: the Ask glyph, the welcome symbols, "Ember" in Conversation, your chat bubble's tint and the sign-in code.
  - Never fill a second button with it in the same group, or in a view with no groups.
  - Mood colours (`--eb-mood`) mark only the bubble's state tag (its dot, and its tint behind the word in the colour's `-text` tint), the streaming caret and the step arrow.
  - Severity stays apart from identity: a problem is `--red` (`--red-text` for words, a notch in the ring), a risky question's tag, brackets and Allow edge are `--yellow`, done is `--green`. Needs you is purple in the tag and is otherwise coded by shape (brackets, the full still ring) and words.
- **Text on fills.** Filled buttons (and the checkbox tick) carry `--on-accent` text, never white (white on system orange is 2.2:1). Tags are tints and carry their words in a `-text` colour (below). The white glyphs on Home's sidebar tiles and the switch knob are decorative exceptions.
- **Which colours can be text.**
  - `--accent`, `--green` and `--yellow` pass 4.5:1 as text.
  - `--red`, `--blue`, `--purple` and `--gray` only mark things (3:1). Red or purple words use `--red-text` or `--purple-text`.
  - A tag is its system colour at 14–18% behind a word in its `-text` tint. Yellow has no tint: its word is `--yellow` itself (Home's `--warn`).
- **Outlines.** Outline every unfilled control with `inset 0 0 0 1px var(--control-edge)` (WCAG 1.4.11, 3:1); checkboxes use 1.5px. That covers quiet buttons, the off switch, checkboxes, fields, pop-up buttons and floating capsules.
- **New colour tokens.** Give each one a value in ember.css's light blocks if a content window uses it (light-mode.test.ts measures them), an override in ember.css's `@media (prefers-contrast: more)` block, using the HIG's Increased Contrast value, and a mapping in its `@media (forced-colors: active)` block (`CanvasText`, `GrayText` or `Highlight`), and keep the default definitions first in `:root`. One the bubble uses also needs its `var(--x, fallback)` there. Every system colour and Ember's lights have their override (yellow #FEDF43, blue #5CB8FF, gray #AEAEB2, `--accent-2` #FFC266, `--glow` #FFA056).

## Type

- **Faces.** Use `var(--ember-font)`: "Ember Sans" is the bundled Inter variable font, standing in for SF Pro. `var(--ember-mono)` is only for codes, paths and values, never for labels.
- **Scale.** Set type as `font: var(--type-…)` from these sizes:
  - large-title 28, title-3 22, title-2 17;
  - headline 14, body 14, callout 13;
  - footnote 12, caption 11.

  These are the default text size; every token is `calc(Npx * var(--text-scale))` with its line height rounded to a whole pixel (`round(calc(Npx * var(--text-scale)), 1px)`, so baselines stay crisp at 1.15), and `--text-scale` is 1, 1.15 or 1.3 (Settings › Comfort & access › Text size). Weights and line heights are in ember.css.
- **Text size.** A literal px font size, and the height of a control that holds words, needs an `html[data-text-size] <selector>` twin at `calc(Npx * var(--text-scale))` (page-prefs.test.ts checks every page and the bubble). `--type-title-3` (22, Apple's Title 1 size) is larger than `--type-title-2` (17), so choose a title style by its size, not its number.
- **Hierarchy.** Build it from size, weight (400, 500, 600 or 700 only) and label colour. Nothing goes below 11px except the Ask hint keycaps.
- **Tracking.** Track in em, tighter as text grows, on Inter's own curve (−0.006em at 14px, −0.003em at 13px, +0.01em at 11px); don't copy SF Pro's table.
- **No italics.** Never set italic text (`font-style: italic`, `<em>`): only the upright face ships, and `font-synthesis: none` is set. `<i>` appears only as an empty status-dot element (`.status i`, `.eb-dot`, `.dot`, `.mic`). Emphasise with weight 600.
- **Numbers and wrapping.**
  - Use `tabular-nums` on counters and times.
  - Use `text-wrap: balance` on large titles and `pretty` on paragraphs.
  - Give text containers `min-width: 0` and `overflow-wrap: anywhere`, so a long app name wraps instead of widening a window or card.

## Shape and layout

- **Radii.** Round corners only with `--r-xs` 6, `--r-sm` 8, `--r-md` 10, `--r-lg` 14, `--r-xl` 18, `--r-capsule` and `--r-icon`. The radius test also accepts:
  - `var(--r-x, Npx)`;
  - one token per corner;
  - `calc(var(--r-x) + Npx)` for a ring outside a shape;
  - `50%`, `0`, `inherit` and `1px`.
- **Concentric corners.** The inner radius is `max(outer − padding, 6px)`, rounded to a radius token: the bubble (18, padding 14) and a card (18, padding 11–14) give an inner panel `--r-xs`, never `--r-md`, which flared. A ring outside a shape adds its offset, and a pseudo-element on the same edge uses `border-radius: inherit`.
- **Crisp at every scale** (100%, 125%, 150%, 200%).
  - Place anything that moves on device pixels: `snapToDevice(v, devicePixelRatio)` (@ember/bubble), never `Math.round` to CSS px (half a device pixel at 150%). The bubble's mount, Ember's stage canvas and the presence ring do.
  - Size a canvas's backing store in whole device pixels and derive its CSS size from it (`canvasSize()`, app/renderer/shared/pixels.ts), and draw again when the scale changes: `watchPixels()` listens to a `resolution` media query (moving to another monitor changes the scale without a resize).
  - Don't centre with `translateX(-50%)`: an odd width lands on half a pixel. Centre by layout (`left: 0; right: 0; margin: 0 auto; width: max-content`).
  - Line heights are whole pixels: every `html[data-text-size]` twin rounds as the type tokens do (Type, above), but for the Ask box's, whose window main sizes by the exact scale (ask.ts `askSize`, ui-place.test.ts).
- **Button shapes.**
  - In-window push buttons are rounded rectangles: `.btn` is 28px at `--r-sm`, and `.btn.small` is 24px at `--r-xs` (at the default text size; their heights scale with `--text-scale`).
  - Home's single large Start is its only capsule button.
  - Floating-layer buttons and the desk bar's buttons are capsules at 28px or 24px. Pills, tags, tracks, the status line, the handle and the Ask field are capsules too.
- **Home layout.** Lay Home out like System Settings:
  - an `h2` header (`--type-title-2`) outside each group;
  - the group on `--surface-1` with `--r-lg` and `--group-edge`;
  - rows of at least 48px (44px in lists) with `--separator` hairlines;
  - `.hint` footnotes below the group;
  - words first in a row, with the switch at the trailing edge;
  - Remove as a `--red-text` text button, and a harmless action beside it (Correct…, Edit) in `--fg`, never red.
- **Panes and section links.** Once Ember has started, Home shows one pane at a time (every top-level section carries `data-pane`; main.ts `showPane` takes the others off the page with `.off-pane`), and reopens on the last one. From 640px up, Home has a fixed 200px sidebar with **Search settings** at its top and coloured symbol tiles, and marks the current pane's link with `aria-current="true"`. Below 640px the search field and the links form one capsule row that scrolls sideways and is never sticky, so it never hides the focused element. The sidebar grows with the text size, but only as far as the window leaves a pane 460px (`--sidebar: min(calc(200px * var(--text-scale)), max(200px, calc(100vw - 460px)))`), so nothing scrolls sideways at 640–720px. A section's or stack's one track may shrink (`minmax(0, 1fr)`) and a pop-up's row wraps the pop-up under its words, so no pane scrolls sideways from 304px at Larger text (200% zoom; WCAG 1.4.10, home-panes-renderer.test.ts). Search also matches a pane's other words (`SEARCH_ALIASES` in search-copy.ts, ranked after the settings' own words), reads a setting's words, and names its pane, as shown (`shownText`: never `textContent`, which ran hidden alternatives and a pop-up's options together, and the setup badge's number into "Setup & about"), says "Nothing found" in the sidebar, and lists selectable labelled results in batches of 12. ArrowDown enters results; Tab/Enter selects a particular match, while Escape clears them. Selecting marks the setting's row and focuses its control (a header or footnote stands for its group: a one-row group's row, else the whole group). The sidebar's selection is drawn only while it has a link to sit on (`.jump.has-hl`). A new section goes on a pane; a new pane gets a link, a tile and a place in the order (most used first).
- **Home's status panel** is the one HUD part of a content window: still (its ring never animates), opaque on `--surface-1`, with one prominent button. Its words come from the same data the page shows below it (Task activity's tasks, the setup check's count) and main's word of the conversation's turn (`AgentHost.conversationTurn`, pushed to Home: "Thinking…" for a request from anywhere), so the two never disagree. The composer's line under its buttons follows the same word, never a timer: main sends a turn's lines before its end (`turnChanged` tells "idle" a microtask later), so the lines since the request say how it went, and a Stop that ended it comes with the end (`ConversationTurnChange.ended`).
- **First run** (`#welcome`, welcome.ts): six essential steps (hello, consent, sign-in, checks, try, done); character choice and introduction are optional detours that remain available in settings. Consent and the actual Stop rehearsal acknowledgement are never bypassed. The consent's Agree, and Quit Ember once Not now is pressed, drop a press for `AGREE_ARM_MS` after they appear, and Not now moves focus to its note, so a double click or a held Enter can neither agree nor quit (first-run-c1-1). One decision a step, centred in the window's height in a box of one size (so the title stays put from step to step), the step's buttons after its words (never stuck to the window's foot), a reason beside any button that waits (`aria-describedby="w-why"`), and a still step indicator. Its words are pure functions in welcome-copy.ts (home-welcome.test.ts). While it runs it borrows the hero's canvas and the character cards and gives them back at Start. Its forced-colours rules are in their own block at the end of home/styles.css; design-system.test.ts reads every block.
- **Folds.** Fold a section with `<details class="fold" id="X-fold" aria-labelledby="X-h">`, with the chevron as a `::before` using `content: "" / ""` so it stays out of the spoken name. A disclosure inside a group is `details.disclose` (Projects'), with the same chevron; every `<details>` in Home is a `fold`, `disclose` or first run's `w-more`, never the browser's triangle. A button straight in a section's grid stretches across the pane: put it in `.agent-actions`. An empty `p` in a group takes no row, and an empty footnote no gap. Every `role="status"` or `aria-live` element in a content window (Home, the command window, the prompt window) stays on the page while it says nothing: never `hidden` or `display: none` (it would join the accessibility tree with its words already in, which NVDA and Orca with Chromium don't announce). One rule makes an empty one a box of nothing out of the flow (`:is([role="status"], [aria-live]):empty`: ember.css's, under `:where(html.content)`, and Home's sheet repeats it), and the script clears its words instead of hiding it; a `role="alert"` may hide, as it is announced as it shows (design-system.test.ts, home-panes-renderer.test.ts, approval-ui-live.test.ts: accessibility-visual-c1-1, c2-1).
- **Window sizes.** Change CSS sizes and main-process window sizes together. The defaults:
  - Ask uses a 560×92 base plus measured 24px rows: the initial composer and voice controls occupy 3 rows (140px at Default, 156px at Large, 173px at Larger), with extra rows for wrapping suggestions, text and notes. Clamp to the work area and allow local scrolling when capped;
  - the desk bar is 30px;
  - the handle pill is 200×56, and the hidden-Ember tab 56×56;
  - the no-compositor corner card is 360 wide, 120–360 tall to fit its content, and up to 640 (inside the work area, less 12 above and below) while a question or anything else that needs you shows, so its sentence shows whole at every text size (`cardMax()` in handle.ts);
  - the command window is 760×480, and the prompt window `PROMPT_SIZE` (app/main/remote/prompt-window.ts): an SSH question longer than the small card shows (a two-factor menu) is 18px taller a quoted line, up to the consent card's height (`promptSizeOf`).

  All but the corner card grow with the text size (`scaledSize` and `forText` in main, kept inside the work area); the card grows with what it holds instead.

## Controls, focus and accessibility

- **Shared controls.** Use them instead of restyling:
  - `.btn` is prominent: an accent fill, at most one per view or group;
  - `.btn.quiet` is the bordered secondary button;
  - also `.btn.small`, `.link`, `input[type="checkbox"][role="switch"]`, a plain checkbox and `kbd`.

  On the floating layer, the prominent capsule is `.eb-primary` (bubble) or `.primary` (corner card). Use a switch for a setting that takes effect at once, and a checkbox for agreements and multiple choices.
- **Destructive and leaving actions.** Never give one the prominent style: Sign out, Quit Ember, Not now and Stop are quiet. The preferred choice stands out by style, never by size.
- **Four states.**
  - Hover goes inside `@media (hover: hover)` and changes only paint: the background, `filter: brightness(1.08)`, a colour, or an inset edge (as the handle's accent rim does). Never the layout.
  - Press is `transform: scale(0.97)`.
  - Then `:focus-visible`.
  - Disabled is `opacity: 0.4`.

  Buttons are at least 24px tall (WCAG 2.5.8).
- **Focus.** Show it with `:focus-visible { outline: none; box-shadow: var(--focus-ring); }`, after the control's own edge. When a state adds its own `box-shadow` edge (Increase Contrast's current-section edge), write the focused variant with both shadows, or Tab shows no focus. There are two exceptions:
  - the always-focused Ask field shows a firmer rim and the accent caret;
  - the desk picture uses an inset outline inside a black keyline.

  Where Home focuses a control main asked for (a key, the launcher, voice: `onFocusSection`), it passes `focusVisible: true`: the key never reaches the page, so after a click there Chromium drew no ring (accessibility-visual-r2-1). Focus a click in the page moved keeps the browser's heuristic.
- **Hidden elements.** A class that sets `display` overrides the `hidden` attribute, so give it a `[hidden] { display: none; }` rule.
- **Questions.**
  - A question is unmistakable and still: the bubble's brackets lock on once (a 180 ms `scale`), the ring is full and steady, the state tag says "Needs you", and nothing about it pulses or counts down. Its sentence sets the decision (up to its "?") in weight 600, what the step does after it, and the task under it in the secondary label; its keys show as keycaps, on the bubble and on the no-compositor corner card (`stepParts`, each chord kept on one line with its word on both: `.eb-key` and `.key-hint`; on the bubble a chord breaks under its keycaps only where it alone is wider than the row, and the " · " between two is drawn before the later one in room the list clips at a line's start, so none ends or starts a line, and never before the first chord (`.eb-key + .eb-key`: clipping hides a dot from sight, not from a screen reader): `.eb-keys`, companion-r3-2, companion-v4-3).
  - A risky question (policy's `risky`, `BubbleState.risky`) adds a "Risky step" tag, caution-yellow brackets and an Allow that is bordered, not filled, so nothing invites a reflex yes; the no-compositor corner card shows the tag and the bordered Allow too (`body[data-risky]`, `cardRisky()`). The corner card also shows Ember's own "Without asking" tag (`body[data-autonomous]`, `cardAutonomous()`), and its buttons start under its words, not under Ember's face. It changes how it looks, never how it is answered.
  - In the corner card's narrow column each chord of a question's keys is a line of its own (`.key-hint`), with no " · " between them, which was left alone at the first line's end (accessibility-visual-r2-2).
  - Every decision the floating layer asks for also works from the keyboard (the `allow` and `deny` shortcuts in app/shared/shortcuts.ts, Ctrl+Alt+Y / Ctrl+Alt+N on Linux, while Ember holds them), with the hint from `questionKeyHint()`.
  - "Always in <app>" stays click-only, because a global key could take an app's own shortcut and grant for good.
  - New task-card buttons, and the bubble's Try again and Stop, ignore presses for `TASK_ARM_MS` (app/renderer/handle/arm.ts), because the pointer may already rest where they appear.
  - Question buttons are armed only by the Confirmer: never add a renderer arm delay to them. The one renderer hold is what can't be read: a whole text not yet all in view, and on the corner card every answer but Not now while the question's sentence can't show beside it (`cardClear()`, `waitsForRoom()` in app/renderer/handle/fit.ts), looked at again whenever the card is fitted. Commit pointer activation only on release inside the same connected, unchanged control; pointer cancellation, outside release and changed question identity cancel. Keep click-through routing held through the gesture, then release it. Keyboard/assistive clicks activate once.
- **Screen readers.**
  - Put words for screen readers only in `.sr` (`.eb-live` in the bubble), and announce changes through `role="status"` or `aria-live="polite"`.
  - Give ambiguous buttons a contextual `aria-label` (`Stop: <task title>`), and mark decorative dots `aria-hidden="true"`.
  - Throttle live regions: a download is announced every 25%, never on every chunk.
- **Shortcut chords.** Show them as `<span class="chord" data-shortcut="allow"><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Y</kbd></span>`: the page rewrites the keys for its OS from app/shared/shortcuts.ts, and `data-key-held`/`data-key-taken` alternatives cover another app holding the key. Never hard-code a chord.

## Symbols and state

- **How symbols are drawn.** Draw them as black data-URI SVG masks through the `--sym-*` tokens, or `--icon` for page icons: `background: <colour>; -webkit-mask: var(--sym) center / Npx no-repeat;`. No icon fonts, emoji or `<img>` icons. The working symbol is static; nothing spins. The presence ring's ticks are placed once by a static `rotate()`; segmented rings and arcs fill stepwise and never rotate.
- **Presence** (app/shared/presence.ts, app/renderer/overlay/presence.ts, the handle's `.menu::before`): one ring that says Ember's state, the same mapping on the overlay and the handle.
  - By the cursor: none at rest; listening lights its 24 ticks by the microphone's level, with a separate steady microphone mark that says the microphone hears you whatever the level; thinking is `--accent-2`, breathing three times; acting is dim with one pulsing segment; needs you is the full ring, still; a problem is red with a notch; done completes once and goes (`DONE_RING_MS`). While Ember's own voice plays, a five-bar meter shows its level (the system's voice gives none, so none shows).
  - On the handle: a still ring round the face, `--hud-dim` at rest and the state's colour otherwise. The handle never animates it.
  - HUD parts are decorative: `aria-hidden`, outside `interactiveRects()` and the task rects, and the words say every state for screen readers.
- **Task state.** It is `data-status="running|queued|waiting|done|failed|stopped"`, which sets `--sym` and `--sym-tint`. Put the symbol beside the words, and the state word in a `.sr` span ("Working: ", "Waiting its turn: ", "Waiting for you: " …). Every surface takes its state words from the one table, `STATUS_WORDS` in app/shared/activity.ts: a card's through `cardStateWord()` (overlay/stack.ts) and a row's through `rowWord()`, so a task whose question went unanswered reads "No answer in time", never "Stopped". Show selection with a ring plus a check.
- **Task activity on cards.** A card's live line, telemetry row, summary and Details rows are built from the task's activity (app/shared/activity.ts, app/main/agent/activity.ts) in Ember's own words, never from the model's arguments, reasoning or screen text. The worker's own note is the one model text, in `--label-2`, never styled as Ember's voice. The clock is written as text by one shared one-second tick that runs only while a card under way shows: no re-render and no animation.
- **Task activity in Home.** The same words, a group per task (app/renderer/home/tasks.ts, tasks-copy.ts), opaque and still, from main's in-memory list (`tasks:activity`, pushed at most every `TASKS_PUSH_MS`). It may also show what a question asked, in Ember's words built from the step's kind and app only (`askedWords`: never the typed text or names from the screen), and where it is answered (the bubble, the command window or a consent card), which the cards never show. Home never answers a question: Open approval opens the exact live question in its own focusable card or its existing command/consent panel, with the same main-owned arming, whole-text and freshness gates. Ordinary approvals never open a focusable card without a user request. Its result view goes through the one `resultView` function.
- **Views** (docs/DESIGN.md "Views"). A task's view comes only from app/shared/view.ts's catalog (`ember.view/2`),
  checked whole by app/main/agent/view-schema.ts, and is drawn by app/renderer/shared/view-dom.ts (one module for the
  card and, next, Home) with `textContent` and static SVG alone, styled only by app/renderer/shared/view.css. It has no
  links, buttons, images, markup or inline styles, never takes the accent, glass, a capsule or a status symbol, and
  doesn't move except the one fade of a replaced node. Ember writes its frame ("Found by …") and a quote's caption. A
  new block kind needs all of these: the type, the schema (`VIEW_KINDS`, which also writes the model's instructions),
  the drawing, `nodeLines` (its text form), the forced-colours rule and tests (view-schema, view-dom).
- **Failed tasks.** A failed task's card stays longer so it can be read: 60 s (TaskManager's `failureCardMs`), against 15 s (`cardMs`) for done and stopped cards. More time multiplies that timeout by ten. Reading (expanded Details, hover or focus) renews a 15-second per-renderer lease and pauses expiry; after the final reader leaves there is at least 5 seconds of grace. While the user is away (main's `userAway`: idle 30 s, or Ember hidden) a card kept that long (a failure's, an unanswered question's, a view's) waits, and has its whole time again once they are back (tasks-approvals-4). A crashed renderer loses its lease. Close, Close all or Stop everything removes it sooner. A failed task that did work (not a guide) offers Try again, a click only: the same request starts again as a new task and asks every question again. A task whose question ran out of time (`Task.endedBy` "expired": no refusal) stays as long and offers it too; one the user said "Not now" to, stopped or took the mouse back from never does.

## Motion and performance

- **Springs.** Ease with the springs, Apple's `Spring(duration, bounce)` written as CSS `linear()` curves (a curve is the shape; pair it with a `--t-*` duration):
  - `--spring-smooth-0` (bounce 0) for what glides: setup's step, the sidebar's selection, Ember's arrival;
  - `--spring-brisk` (bounce 0.15) for entrances from their source (the bubble grows out of Ember, the Ask box out of Ember below it, a disclosure's content) and dots filling;
  - `--spring-reward` (bounce 0.3) only for a completion or selection flourish, once: a card's done tick, the checkbox tick, the character card's check, first run's try check (`--spring-bouncy` is its older alias). Never on a question or an error;
  - `--spring-snappy` (`--t-snappy`) for presses, switches and chevrons; `--spring-smooth` for the overlay focus ring.

  Durations: `--t-press` 220, `--t-fast` 300, `--t-move` 420, `--t-glide` 600, `--t-fade-in` 180 (ease-out), `--t-fade-out` 130 (ease-in), `--t-calm-fade` 150 ms; `--stagger` 30 ms an item (six at most) and `--stagger-plan` 40. Exits are faster than entrances, opacity first. Plain `ease` is for opacity and colour fades.
- **Nothing near a pending question moves.** A question comes and goes by its opacity alone (no growth, no slide under the pointer: its translate and scale aren't transitioned, as it arrives on a bubble posed as before; bubble-motion-live.test.ts checks it frame by frame), its dot and the ring hold still, a card waiting for you doesn't fill its plan dot, and Ember holds still but for its blinks whatever emotion the question shows (the overlay calls `rig.setQuestion()`: no pop, hop, fidget or saccade).
- **Frequent things move least.** Streamed text is drawn at most 15 times a second (`STREAM_MS`, in ReasoningBubble: each drawing lays out and re-rasters the bubble); a card's text swaps without motion; numbers never count up.
- **Entrances and exits.** Build entrances from transitions plus `@starting-style`. To hide something, fade its opacity, then set `visibility: hidden` or `display: none` (with `allow-discrete`), so it takes no clicks or focus. Animate the separate `translate` and `scale` properties, so they compose with a positioning `transform`.
- **What may animate.**
  - In `@keyframes`, change only `opacity`, `transform`, `translate` or `scale`.
  - Colour and `filter` transitions are fine only on a button's hover, press or checked state, in a window or on the floating layer.
  - Never transition `box-shadow`, `filter`, `background`, size or position on a surface that moves with Ember, or on anything that updates while scrolling or on every data chunk: a box-shadow transition repainted the whole bubble on every frame.
  - The overlay focus ring's left/top/width/height glide and the switch knob's press stretch (`width`) are the only geometry transitions; don't add another. HUD brackets and leaders are placed without a transition, and a lock-on is a `scale`, which keeps it that way.
- **Endless animations.** Use `infinite` only for small opacity pulses on their own element (`.status i`, `.eb-dot`, the streaming caret, `.focus::after`, the acting ring's `.ring-now`), and stop each pulse when its element hides. The handle's microphone halo holds steady while it hears you (R6): it never pulses, which read as a meter on silence. The finite ones: the plan's `dot-fill` and the done card's `tick-pop`. Large or masked effects run a fixed number of times: the thinking glow is `eb-glow 1.6s ease-in-out 3`, because running endlessly it cost 60% more compositor time; the ring's glow, its done and the bubble's lock-on are finite too. design-system.test.ts lists every `@keyframes` and every endless one, so a new one is a deliberate change there.
- **Meters driven by script** are the one exception: the ring's ticks (opacity) and the voice meter's bars (`scale`), changed at most 20 times a second for the microphone and 10 for Ember's own voice (app/shared/level.ts `LevelMeter`), and only while the microphone hears a request or Ember's own voice plays; a level crosses IPC only when it changed (but Ember's voice level, sent again every `VOICE_KEEP_ALIVE_MS` while it holds: the character's mouth follows the voice for as long as levels keep coming, and lets go of one older than `VOICE_STALE_S`), on its own channel (`overlay:level`), never in the state. The stream's end sends null and the meter stops at once (hud-presence.test.ts), nothing runs while Ember is hidden, and in Calm the ring shows every tick lit and the meter a steady mark. Measured at a level changing on every update: about 4 points of a core in the overlay renderer and 1 in the GPU process while listening, 2 and 1 while speaking (docs/DESIGN.md "Presence"). Don't give the ticks layers of their own: 24 layers cost the GPU process more than repainting the ring.
- **Calm mode** is `html.calm` (`settings.reduceMotion`), alongside `prefers-reduced-motion`.
  - ember.css's `html.calm *` rule stops every transition and animation on every page.
  - Every `infinite` animation in the overlay and handle stylesheets needs its own `html.calm …` rule.
  - The one motion Calm keeps (R1): a surface that comes and goes carries `.calm-fade` (the bubble, a card, the status line, the Ask box) and fades over `--t-calm-fade`, opacity only, with no translate or scale. Nothing else is exempt from `html.calm *`.
  - Calm also makes the glass solid.
  - Motion driven from script needs Calm too: set `rig.reducedMotion`, scroll with `behavior: calm ? "auto" : "smooth"`, and pass it to the follower.
  - State stays readable when still: the mic halo holds, the glow stays lit, and the presence ring holds its state (listening all lit, acting's segment steady).
- **Moving and drawing.**
  - To move anything that follows Ember, write `transform` on an empty, unstyled wrapper (`.eb-mount`, `#stage`), never an inline transform, left or top on the styled glass element: that cost about 25% more overlay CPU.
  - Draw character canvases on demand with `requestDraw()` at the rig's frame gaps, never in a free-running loop. An awake Ready face with nothing passing waits `restingGap()` (packages/characters: about 6 frames a second, never past its next blink or fidget), and its time passes through `frameSeconds()` so blinks and the breath keep their pace. Once Ember has dozed off and its face has settled, draw nothing until something happens.
  - Code that runs every frame sends IPC only when its value changed.

## Scrollbars, icon and the bubble

- **Scrollbars.** Never set `scrollbar-width` or `scrollbar-color`: Chromium then ignores ember.css's `::-webkit-scrollbar` rules (a slim capsule thumb with no arrows) and draws arrows. The one exception is `scrollbar-width: none` on Home's narrow section-link row (`.jump`); the wide sidebar sets it back to `auto`. A scroller drawn over other apps gets a dark track (`.tasks.scroll`).
- **App icon.** Edit `assets/ember.svg` (48px and up) and `assets/ember-small.svg` (32px and below; app-icon.test.ts). The PNG, .ico and iconset are rendered from them (scripts/package/icon.mjs, and build-app.mjs for Linux's window icon). Keep Apple's icon grid (a 104px continuous-corner tile on a 128px canvas), and check that the small one still reads at 16px.
- **The bubble's CSS fallbacks.** `BUBBLE_CSS` also runs without ember.css, in the character lab, so every token it uses is written `var(--token, <value>)`. When you change a token in ember.css, update its fallback in bubble.ts. Some fallbacks are approximations today: `--control-edge`, `--separator`, `--scroll-thumb`, `--spring-snappy`, `--spring-brisk` (ease-out) and `--glass` (Regular, without `--glass-under`).
- **The bubble's clickable area.** The overlay takes clicks only inside the rectangles `interactiveRects()` reports (the `hot` boxes in bubble.ts). A new clickable part of the bubble must be added there, or it never receives a click. Its HUD parts (the brackets, `.eb-lock`) take no pointer and stay out of it.
- **The bubble's hierarchy.** The state is a tag (a capsule, a tint behind its word) and the title the bold line beside it; an answer has neither (its "Ember" title is hidden: the bubble is Ember's). A wait that hears nothing from Copilot for 10 s says "Still waiting for Copilot…" (`stillWaiting()` names the user's own provider or the model service instead when that is the one in use, on the card too) with Stop (`ui:stop`, the conversation's turn only) and a step naming the keyboard's ways to stop (`stalledStep()`: Home's Stop response through the settings key, which lands on it meanwhile whatever pane Home was on (`keysLanding()`, "conversation:stop"), and the stop chord, each only while Ember holds it), said once to screen readers though it still thinks (`BubbleState.stalled`); a problem offers Open settings where settings can fix it, else Try again (`ui:retry`) where asking again is safe (the conversation's own request, whose turn ran no tool); an answer whose turn started a task says its card shows how it's going.

## Tests, and checking UI changes

- **What the tests check.** `test/unit/design-system.test.ts` checks:
  - contrast;
  - radii;
  - the bundled font and its licence;
  - shared CSS linked first;
  - no `backdrop-filter` on the floating layer;
  - keyframe properties and the finite glow, and the list of every keyframe and every endless one;
  - the glass over a white page (Regular and Clear: every label, text colour, tag and control edge; the page's own text under 1.5:1), the glass labels on every floating page, the solid fallbacks and Increase Contrast's palette;
  - one-device-pixel hairlines, the concentric whole-text panel, the motion tokens, Calm's one fade and a question that doesn't move;
  - Calm rules for endless animations;
  - the Ask box fitting its window;
  - the focus ring's gap;
  - forced-colours edges, outlines and symbols;
  - at most one filled `.btn` in each group, form, disclosure or card of Home's page, and every Home disclosure's chevron.

  `ui-copy.test.ts` pins copy, wrapping, the section links and the placeholder's contrast, and finds any U+2019 apostrophe in `app/` and `packages/` outside comments and regex character classes. page-prefs.test.ts and text-size-windows.test.ts check text-size scaling. `packages/bubble/src/bubble.test.ts` covers placement, the keyboard, Calm and the bubble's hierarchy (the question's parts, keycaps, the risky tag, the lock-on). hud-presence.test.ts covers the ring's states, the level stream and the handle's line.
- **What nothing checks.** Glass on content windows, literal colours, transition properties and most BUBBLE_CSS fallbacks. Keep those right yourself.
- **CSS the tests parse.** The tests read CSS with regular expressions:
  - Keep one space after each colon and end every declaration with `;`.
  - Write tested colours as `#rrggbb` or `rgba(r, g, b, a)`.
  - Keep the `animation: name Ns timing infinite` shorthand.
  - Keep the exact rule text the regexes match, such as `.home > .jump { position: fixed; left: 0; top: 0; bottom: 0; width: Npx;` and the glow's `animation: eb-glow 1.6s ease-in-out 3;`.

  Read the regex before you reformat a rule.
- **New pages.** A new page links `../shared/ember.css` before its `styles.css` and is added to `PAGES` in design-system.test.ts.
- **New windows.**
  - Add the page to `pages` in scripts/build-app.mjs, with `app/preload/<p>.ts` and `app/renderer/<p>/` (main.ts, and an index.html with the CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`; allow `'unsafe-inline'` styles only with a comment saying why, as the overlay and command pages do).
  - Create it in windows.ts with `webPreferences(<page>)` (spellcheck off, sandboxed, its own preload) and `show: false`, and show it on `ready-to-show` or from its controller.
  - Anything floating over apps uses `showInactive()` and `focusable: false` (except the Ask box and the prompt window, which take the keyboard), and stays out of screenshots: `setContentProtection(true)` on Windows and macOS, the capture mask on Linux.
  - Title it to match `EMBER_WINDOW` in policy.ts (the fallback when a window's process id is unknown), so no task reads or acts in it.
  - Calm and the text size reach it from main (page-prefs.ts); give it the CSS rules, and Calm for any motion driven from script.
  - In a frameless window with a drag region, give every control `-webkit-app-region: no-drag`.
  - Insert model or app text with `textContent`, never `innerHTML`.
- **Real renders.** Check UI changes in real renders, not only with tests. Run `npm run build`, then:
  - load `dist/app/renderer/<page>/index.html` in Chromium through playwright-core, with the preload API mocked through `addInitScript`;
  - launch the real app with playwright-core `_electron.launch` under `xvfb-run -a`, with a temporary `EMBER_USER_DATA`. test/demo/m1-checks.mjs shows the pattern.

  Screenshot every changed window:
  - over light, dark and photo backdrops;
  - with and without Increase Contrast;
  - for the floating layer, over a white document and a busy screen too, in each Glass setting, and at 125% and 150% scaling (`--force-device-scale-factor`);
  - in Calm mode;
  - at the Default, Large and Larger text sizes;
  - under forced colours (`emulateMedia({ forcedColors: "active" })`);
  - in the no-compositor fallback (Linux);
  - for Home, below and above 640px.

  Look at every screenshot.
