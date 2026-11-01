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
4. **One accent, used sparingly.** Orange marks the one prominent action, status, on-states and focus.
5. **Never colour alone.** State is a symbol plus words, and screen readers get the words.
6. **Quiet at rest.** Motion and glow say that something is happening, then stop.
7. **Ember's own look.**
   - Mark AI with Ember's flame and characters, never a generic sparkle, and never imitate Siri or Apple Intelligence (no rainbow, no screen-edge glow).
   - The characters are original designs with no film assets. All four share one rig (packages/characters/src/rig.ts), so a new emotion or gesture must work for every character.

## What Ember's look never includes

Name these patterns when you design something new. Vague direction such as "make it clean" drifts toward defaults Ember rejects:
- light, cream or off-white backgrounds (Ember is dark only: `color-scheme: dark`, `darkTheme: true` on every window, and main sets `nativeTheme.themeSource = "dark"`)
- serif or display typefaces, or italic accent words
- tracked all-caps, monospace labels, or numbered "01/02/03" section labels
- gradient text, emoji icons, icon fonts, or spinning indicators
- `backdrop-filter` blur, or glass on content windows
- a second filled orange button in one group (or in one view that has no groups, such as a card or the bubble)
- a frosted scroll-edge header or a glass slider (each needs blur or glass on glass), or a light appearance

## Layers and glass

- **Where glass goes.** Glass is for the floating layer only: the bubble, overlay task cards, the status pill, the handle and the Ask box. Home, the command window and the prompt window build on opaque `--surface-*`. The desk view is a black picture area under a `--glass-solid` bar with a `--separator` edge.
- **How it is drawn.** Never use `backdrop-filter`, and never animate a blur: a blur costs about a core, and a transparent window can't sample other apps anyway. A button's `filter: brightness()` hover and press are not blurs; "What may animate" says where those may transition. Ember's glass is an opaque frost: `--glass-fill` is 97–98.5% opaque, so the app's text never shows through. Apply it as `border: 1px solid transparent; background: var(--glass); box-shadow: var(--glass-spec), var(--glass-depth);`, and keep the layer order inside `--glass`.
- **No glass on glass.** Buttons, rows and panels on glass use flat neutral fills with an inset `--control-edge` or `--separator` line.
- **Edges and shadows.**
  - Give floating surfaces the dark 0.5px outer hairline in their shadow: it keeps the edge crisp over white documents. The Ask box's hint capsule (`.meta`) is the one without. Draw hairlines as `box-shadow` spreads, never as 0.5px borders.
  - Don't use `mix-blend-mode`, `text-shadow`, `background-clip: text`, `@property` animations or SVG filters, because each re-rasters on the CPU.
  - Shadows on surfaces that move with Ember are tight, with a negative spread (the bubble's `0 12px 28px -8px`). The larger `--glass-depth` is for surfaces that stay put.
- **Without a compositor.** A transparent window paints black there, so the whole window becomes one opaque panel: `var(--glass-solid)` plus `box-shadow: var(--glass-rim)`, with no outer shadows (`html.opaque` in Ask, `body.fallback` in the handle's corner card). Ember switches between the two on its own when the compositor comes or goes (Linux only: Windows and macOS always composite).
- **Window backgrounds.** Set each BrowserWindow's `backgroundColor` to what its page paints, or it flashes before the first paint:
  - `"#121011"` for Home, the command window and the prompt window;
  - `"#242022"` when opaque or in fallback;
  - `"#000000"` for the desk;
  - `"#00000000"` for glass windows.
- **Contrast and transparency settings.** They work mainly by overriding tokens in ember.css (`@media (prefers-reduced-transparency: reduce)` and `@media (prefers-contrast: more)`). Add a per-element rule in the page's own `prefers-contrast` block only for what no token reaches, as Home does for the current section and the slider, and BUBBLE_CSS for its border.
- **Windows contrast themes** are `@media (forced-colors: active)`. ember.css maps the tokens to system colours and makes focus a 2px Highlight outline; each page's own block (and BUBBLE_CSS's) gives every control and group a real 1px `border` or `outline` in `ButtonText` or `CanvasText`, keeps every symbol and status dot in a system colour, and marks chosen items beyond colour. A rule with `color: HighlightText` also sets `forced-color-adjust: none`.

## Colour

- **The palette.** Use Apple's 2025 dark system palette through its tokens in ember.css `:root`:
  - `--accent` (system orange), `--accent-2` (thinking, showing you) and `--glow` (Ember's light);
  - `--green`, `--red`, `--yellow`, `--purple`, `--blue` and `--gray`.

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
  - Keep it for four jobs:
    - the one prominent action in a view;
    - status (the working symbol, the status-pill dot, the mic badge, the desk frame while you drive);
    - control on-states;
    - links, the caret and the focus ring.
  - Ember's identity also uses it: the Ask glyph, the welcome symbols, "Ember" in Conversation, your chat bubble's tint and the sign-in code.
  - Never fill a second button with it in the same group, or in a view with no groups.
  - Mood colours (`--eb-mood`) mark only the bubble's state dot, streaming caret and step arrow.
- **Text on fills.** Filled buttons (and the checkbox tick) carry `--on-accent` text, never white (white on system orange is 2.2:1). Tags are tints and carry their words in a `-text` colour (below). The white glyphs on Home's sidebar tiles and the switch knob are decorative exceptions.
- **Which colours can be text.**
  - `--accent`, `--green` and `--yellow` pass 4.5:1 as text.
  - `--red`, `--blue`, `--purple` and `--gray` only mark things (3:1). Red or purple words use `--red-text` or `--purple-text`.
  - A tag is its system colour at 14–18% behind a word in its `-text` tint. Yellow has no tint: its word is `--yellow` itself (Home's `--warn`).
- **Outlines.** Outline every unfilled control with `inset 0 0 0 1px var(--control-edge)` (WCAG 1.4.11, 3:1); checkboxes use 1.5px. That covers quiet buttons, the off switch, checkboxes, fields, pop-up buttons and floating capsules.
- **New colour tokens.** Give each one an override in ember.css's `@media (prefers-contrast: more)` block, using the HIG's Increased Contrast value, and keep the default definitions first in `:root`. `--yellow`, `--blue`, `--accent-2`, `--glow` and `--gray` have no override. That gap is known, so leave it unless the task is about Increase Contrast.

## Type

- **Faces.** Use `var(--ember-font)`: "Ember Sans" is the bundled Inter variable font, standing in for SF Pro. `var(--ember-mono)` is only for codes, paths and values, never for labels.
- **Scale.** Set type as `font: var(--type-…)` from these sizes:
  - large-title 28, title-3 22, title-2 17;
  - headline 14, body 14, callout 13;
  - footnote 12, caption 11.

  These are the default text size; every token is `calc(Npx * var(--text-scale))`, and `--text-scale` is 1, 1.15 or 1.3 (Settings › Comfort & access › Text size). Weights and line heights are in ember.css.
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
- **Concentric corners.** The inner radius is the outer radius minus the padding. A ring outside a shape adds its offset, and a pseudo-element on the same edge uses `border-radius: inherit`.
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
  - Remove as a `--red-text` text button.
- **Section links.** From 640px up, Home has a fixed 200px sidebar with coloured symbol tiles, and marks the current section with `aria-current="true"`. Below 640px the links form one capsule row that scrolls sideways and is never sticky, so it never hides the focused element.
- **Folds.** Fold a section with `<details class="fold" id="X-fold" aria-labelledby="X-h">`, with the chevron as a `::before` using `content: "" / ""` so it stays out of the spoken name.
- **Window sizes.** Change CSS sizes and main-process window sizes together. The defaults:
  - Ask is 560×92, plus 24px a row as the text grows;
  - the desk bar is 30px;
  - the handle pill is 200×56, and the hidden-Ember tab 56×56;
  - the no-compositor corner card is 360 wide, 120–360 tall to fit its content;
  - the command window is 760×480, and the prompt window `PROMPT_SIZE` (app/main/remote/prompt-window.ts).

  All but the corner card grow with the text size (`scaledSize` and `forText` in main, kept inside the work area).

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
- **Hidden elements.** A class that sets `display` overrides the `hidden` attribute, so give it a `[hidden] { display: none; }` rule.
- **Questions.**
  - Every decision the floating layer asks for also works from the keyboard (the `allow` and `deny` shortcuts in app/shared/shortcuts.ts, Ctrl+Alt+Y / Ctrl+Alt+N on Linux, while Ember holds them), with the hint from `questionKeyHint()`.
  - "Always in <app>" stays click-only, because a global key could take an app's own shortcut and grant for good.
  - New task-card buttons ignore presses for `TASK_ARM_MS`, because the pointer may already rest where the card appears.
  - Question buttons are armed only by the Confirmer: never add a renderer arm delay to them.
- **Screen readers.**
  - Put words for screen readers only in `.sr` (`.eb-live` in the bubble), and announce changes through `role="status"` or `aria-live="polite"`.
  - Give ambiguous buttons a contextual `aria-label` (`Stop: <task title>`), and mark decorative dots `aria-hidden="true"`.
  - Throttle live regions: a download is announced every 25%, never on every chunk.
- **Shortcut chords.** Show them as `<span class="chord" data-shortcut="allow"><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Y</kbd></span>`: the page rewrites the keys for its OS from app/shared/shortcuts.ts, and `data-key-held`/`data-key-taken` alternatives cover another app holding the key. Never hard-code a chord.

## Symbols and state

- **How symbols are drawn.** Draw them as black data-URI SVG masks through the `--sym-*` tokens, or `--icon` for page icons: `background: <colour>; -webkit-mask: var(--sym) center / Npx no-repeat;`. No icon fonts, emoji or `<img>` icons. The working symbol is static; nothing spins.
- **Task state.** It is `data-status="running|queued|waiting|done|failed|stopped"`, which sets `--sym` and `--sym-tint`. Put the symbol beside the words, and the state word in a `.sr` span ("Working: ", "Waiting its turn: ", "Needs you: " …). Show selection with a ring plus a check.
- **Generative views on cards.** A task's result `view` comes only from app/shared/view.ts's catalog, checked by
  `ViewSchema`, and is drawn by app/renderer/overlay/view.ts with `textContent` alone. It has no links, buttons,
  images or markup. A new block kind needs all of these: the type, the schema, the drawing, `viewText`, the
  forced-colours rule and a test.
- **Failed tasks.** A failed task's card stays longer so it can be read: 60 s (TaskManager's `failureCardMs`), against 15 s (`cardMs`) for done and stopped cards. Then it leaves on its own. Close, Close all or Stop everything removes it sooner.

## Motion and performance

- **Springs.** Ease with the springs, which are SwiftUI springs written as CSS `linear()` curves:
  - `--spring-snappy` (`--t-snappy`) for presses, switches, chevrons and entrances;
  - `--spring-bouncy` only for a selection flourish (the character card's check, the checkbox tick);
  - `--spring-smooth` only for the overlay focus ring.

  Plain `ease` is for opacity and colour fades.
- **Entrances and exits.** Build entrances from transitions plus `@starting-style`. To hide something, fade its opacity, then set `visibility: hidden` or `display: none` (with `allow-discrete`), so it takes no clicks or focus. Animate the separate `translate` and `scale` properties, so they compose with a positioning `transform`.
- **What may animate.**
  - In `@keyframes`, change only `opacity`, `transform`, `translate` or `scale`.
  - Colour and `filter` transitions are fine only on a button's hover, press or checked state, in a window or on the floating layer.
  - Never transition `box-shadow`, `filter`, `background`, size or position on a surface that moves with Ember, or on anything that updates while scrolling or on every data chunk: a box-shadow transition repainted the whole bubble on every frame.
  - The overlay focus ring's left/top/width/height glide and the switch knob's press stretch (`width`) are the only geometry transitions; don't add another.
- **Endless animations.** Use `infinite` only for small opacity pulses on their own element (`.status i`, `.eb-dot`, the streaming caret, `.mic::after`, `.focus::after`), and stop each pulse when its element hides. Large or masked effects run a fixed number of times: the thinking glow is `eb-glow 1.6s ease-in-out 3`, because running endlessly it cost 60% more compositor time.
- **Calm mode** is `html.calm` (`settings.reduceMotion`), alongside `prefers-reduced-motion`.
  - ember.css's `html.calm *` rule stops every transition and animation on every page.
  - Every `infinite` animation in the overlay and handle stylesheets needs its own `html.calm …` rule.
  - Motion driven from script needs Calm too: set `rig.reducedMotion`, scroll with `behavior: calm ? "auto" : "smooth"`, and pass it to the follower.
  - State stays readable when still: the mic halo holds and the glow stays lit.
- **Moving and drawing.**
  - To move anything that follows Ember, write `transform` on an empty, unstyled wrapper (`.eb-mount`, `#stage`), never an inline transform, left or top on the styled glass element: that cost about 25% more overlay CPU.
  - Draw character canvases on demand with `requestDraw()` at the rig's frame gaps, never in a free-running loop.
  - Code that runs every frame sends IPC only when its value changed.

## Scrollbars, icon and the bubble

- **Scrollbars.** Never set `scrollbar-width` or `scrollbar-color`: Chromium then ignores ember.css's `::-webkit-scrollbar` rules (a slim capsule thumb with no arrows) and draws arrows. The one exception is `scrollbar-width: none` on Home's narrow section-link row (`.jump`); the wide sidebar sets it back to `auto`. A scroller drawn over other apps gets a dark track (`.tasks.scroll`).
- **App icon.** Edit `assets/ember.svg` (48px and up) and `assets/ember-small.svg` (32px and below; app-icon.test.ts). The PNG, .ico and iconset are rendered from them (scripts/package/icon.mjs, and build-app.mjs for Linux's window icon). Keep Apple's icon grid (a 104px continuous-corner tile on a 128px canvas), and check that the small one still reads at 16px.
- **The bubble's CSS fallbacks.** `BUBBLE_CSS` also runs without ember.css, in the character lab, so every token it uses is written `var(--token, <value>)`. When you change a token in ember.css, update its fallback in bubble.ts. Some fallbacks are approximations today: `--control-edge`, `--separator`, `--scroll-thumb`, `--spring-snappy` and `--glass`.
- **The bubble's clickable area.** The overlay takes clicks only inside the rectangles `interactiveRects()` reports (the `hot` boxes in bubble.ts). A new clickable part of the bubble must be added there, or it never receives a click.

## Tests, and checking UI changes

- **What the tests check.** `test/unit/design-system.test.ts` checks:
  - contrast;
  - radii;
  - the bundled font and its licence;
  - shared CSS linked first;
  - no `backdrop-filter` on the floating layer;
  - keyframe properties and the finite glow;
  - Calm rules for endless animations;
  - the Ask box fitting its window;
  - the focus ring's gap;
  - forced-colours edges, outlines and symbols.

  `ui-copy.test.ts` pins copy, wrapping, the section links and the placeholder's contrast. page-prefs.test.ts and text-size-windows.test.ts check text-size scaling. `packages/bubble/src/bubble.test.ts` covers placement, the keyboard and Calm.
- **What nothing checks.** Glass on content windows, literal colours, transition properties, the Increase Contrast (`prefers-contrast`) overrides and the BUBBLE_CSS fallbacks. Keep those right yourself.
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
  - in Calm mode;
  - at the Default, Large and Larger text sizes;
  - under forced colours (`emulateMedia({ forcedColors: "active" })`);
  - in the no-compositor fallback (Linux);
  - for Home, below and above 640px.

  Look at every screenshot.
