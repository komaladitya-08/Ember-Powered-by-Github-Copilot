# Ember port spec: input injection and keyboard handling

Scope: `app/main/hands/input.ts` (XTest backend, `XInput`), `hands/borrow.ts` (`CursorBorrow`, `Hand`, key vocabulary),
`hands/keymap.ts` (typing plans), `hands/keybuffer.ts` (ask-box keyboard hold), `hands/clipboard-handoff.ts`
(clipboard-manager handoff and PRIMARY read), `hotkey.ts` (`freshAskPress`), `desk/keys.ts` + `desk/agent-process.ts`
(desk input, Linux only), and how `main.ts`, `agent/worker.ts` and `policy/policy.ts` use them. Every claim is from
the source at commit `b67b02e`. Line numbers are `file:line`.

Companion spec: `window-system.md` (same folder). It owns `WindowId`, screen units, `windowId(win)` and the
`activate/focusInput` of Ember's own windows. This spec uses the same definitions.

---

## 0. TL;DR

1. **Keep the `XInput` method set as the portable `Input` interface.** `CursorBorrow` (borrow.ts:147), the worker, the
   eval gates and about ten test fakes (test/unit/borrow.test.ts:13, borrow-keys.test.ts, worker tests) all use that
   exact structural shape. Add new capabilities only as **optional** members.
2. **X keysyms stay the portable key vocabulary.** `parseCombo` returns X keysym *names*. `keysymOf` turns names into X
   keysym numbers, and `keymap.ts` plans in keysyms. Windows and macOS backends implement `keysymOf` from a static
   name→keysym table and map keysyms to VK / CGKeyCode inside. **Keycodes are opaque per backend.** They must never be
   0, because `!code` means "no key" in borrow.ts:266, :282, main.ts:1265 and desk/view.ts:353. macOS `kVK_ANSI_A` *is*
   0, so expose `CGKeyCode + 8`.
3. **Coordinates are "screen units".** That is X root pixels on Linux, physical virtual-desktop pixels on Windows (Electron
   is PMv2), and CoreGraphics global **points** on macOS. They **can be negative** on Windows and macOS.
   `Hand.glideTo` rejects `x<0 || y<0 || x>=w || y>=h` from `screenSize()` (borrow.ts:320-323), so it breaks on a monitor
   left of or above the primary. Add `onScreen?(x,y)` or `screenBounds?()`.
4. **The button mask stays in X layout** (256 = logical left, 512 middle, 1024 right, `0x1f00` = any). Button numbers stay
   X's: 1 L, 2 M, 3 R, 4/5 wheel up/down, 6/7 wheel left/right, 8/9 back/forward. Callers test `& 0x1f00` and `& 256`.
5. **Takeover must stay < 100 ms** (eval/src/gates.ts:183). On macOS, **the default 0.25 s local-event suppression after
   every posted CGEvent would freeze the user's real mouse during a glide.** Set
   `CGEventSourceSetLocalEventsSuppressionInterval(src, 0)` and permit all local events during suppression.
6. **Windows foreground rules.** `SetForegroundWindow` from a background process usually fails. Use the empty-`SendInput`
   trick first, then `AttachThreadInput`. `AllowSetForegroundWindow` does *not* help Ember: only the foreground process
   can grant with it. **UIPI silently drops injected input to elevated windows**, and neither `SendInput`'s return value
   nor `GetLastError` reveals it. Check elevation up front with `blockedReason`.
7. **Shortcut semantics differ on macOS.** The worker hard-codes `ctrl+a`, `ctrl+v`, `ctrl+End`, `ctrl+Home` and
   `ctrl+shift+F5` (worker.ts:1952-1962, 2389, 2555). On macOS these must be Cmd-based. Also, `parseCombo("cmd+s")`
   throws today ("unknown modifier"). And `policy.canonicalKeys` maps cmd→super and `isSystemKey` denies every `super+…`,
   so a model's `press_keys "cmd+s"` is refused on macOS. Introduce a per-platform "primary" modifier.
8. **The keyboard hold buffer, the clipboard-manager handoff and PRIMARY are not needed, or degrade, on Windows and
   macOS.** All three already return `null` / `"unavailable"` / `""` when `koffi.load("libX11.so.6")` throws, and every
   caller already tolerates that. Gate them on `process.platform === "linux"` anyway, so they don't dlopen-fail on every
   call.

---

## 1. Who uses what (call graph)

```
main.ts:1198  openXInput()  ──► xinputRef / xinput (one per Ember process, on the user's display)
  ├─ new CursorBorrow(xinput, {onChange: showBorrowing, mayRefocus})        main.ts:1214-1219
  │     └─ worker.withCursor → c.borrow.borrow(fn(hand), {window, signal, onStart, keysOnly})   worker.ts:2937
  ├─ hands.pointer = () => xinput.pointerState()                             main.ts:1262  (guide mode: mask & 256)
  ├─ hands.activationKey = keycodes of Return/KP_Enter/space ∩ keysDown()    main.ts:1264-1267
  ├─ hands.cursor.findWindow = (t,pid) => xinput.findWindow(t,pid)            main.ts:1279
  ├─ xinputRef.activate(xid)       bringToFront 238, giveFocusBack 433/436, askWindow.takeFocus 624
  ├─ xinputRef.focusInput?.(xid)   showMenu 523, askWindow.takeFocus 624
  └─ will-quit: borrowRef.stop(); xinput.close()                             main.ts:1201
main.ts:172   openXInput() in runDoctor (only `!!xin` → "xtest" check)
x11.ts:231    X11.keysDown() → {control, alt, space}  (hotkey chord; *not* XInput)   main.ts:1127
keybuffer.ts  holdKeyboard()                                                  main.ts:667, 672
clipboard-handoff.ts  readSelection()  main.ts:640;  handClipboardToManager()  main.ts:1031
policy.ts:13  parseCombo (canonicalKeys, policy.ts:538-549)
desk (Linux only): agent-process.ts:183 openXInput(DISPLAY of Xvfb) → facade over IPC (desk/agent.ts:263) →
  DeskPlace.input (place.ts:208) → worker deskBorrowFor(place) = new CursorBorrow(place.input) (worker.ts:705-709),
  DeskView.forward (desk/view.ts:325-365) uses move/button/keycode/keycodeOf/keysymOf directly.
eval/src/gates.ts:144-191, eval/src/runner.ts:366: openXInput + CursorBorrow (Linux eval only).
```

---

## 2. The `XInput` interface today (input.ts:14-84), method by method

General invariants (input.ts:1-9, 147-149, 278-292, 502-509):
- **After `close()` every method is a harmless no-op.** Each starts with `if (!open) return …` and returns null, 0, [],
  false or `{0,0}`. Touching a freed `Display*` would crash the whole Electron process.
- **The backend tracks what it holds.** That means `keysHeld: Set<keycode>` and `buttonsHeld: Set<button>`
  (input.ts:149). `keycode()` and `button()` add on down and delete on up. `releaseAll()` sends an up for each and
  clears both. `close()` calls `releaseAll()` first. Wheel "buttons" 4-7 are added and immediately deleted, because
  the borrow sends down then up.
- Every injection is followed by `XFlush` (one-way). `releaseAll` and `sync` use `XSync`.
- Ember's own input is announced to the XI2 watcher before it is sent: `watch?.sent("keys")` on key down
  (input.ts:280) and `watch?.sent("pointer")` on button down (input.ts:312). This lets `userInput()` discount Ember's
  presses.

| Method | Signature / result | X11 implementation | Units, invariants | Callers |
|---|---|---|---|---|
| `pointer()` | `→ {x,y} \| null` | `XQueryPointer(root)` root_x/root_y (input.ts:295-299) | screen units (root px, ≥0). null if closed or the query fails | borrow: `check()` moved test (242), idle loop (293-297), `glideTo` start (324), `home` (416) |
| `pointerState()` | `→ {x,y,mask} \| null` | same plus `mask` (input.ts:300-304) | mask = X state: Shift 1, Lock 2, Control 4, Mod1 8, Mod4 64, **Button1Mask 256, Button2Mask 512, Button3Mask 1024, Button4/5 2048/4096** | borrow `foreignButtons()` = `mask & 0x1f00 & ~ownButtons` (232). main.ts:1262 → worker guide `mask & 256` (worker.ts:1291, 1299-1301) |
| `move(x,y)` | void | `XTestFakeMotionEvent(dpy, -1, round(x), round(y), 0)` + flush (305-309) | absolute screen units, rounded | borrow `glideTo` steps (331), home jump (443, 449). desk view (331, 336, 341) |
| `button(b, down)` | void | `XTestFakeButtonEvent(dpy, b, down, 0)` + flush. Tracks `buttonsHeld` (310-316) | **X numbering**: 1 L, 2 M, 3 R, 4 wheel up, 5 wheel down, 6 wheel left, 7 wheel right, 8 back, 9 forward. A wheel notch is down+up | borrow `click` (343, 347), `scroll` (407-408). desk view `xButton` (view.ts:63-65: DOM 0..4 → 1,2,3,8,9), `wheelButtons` (view.ts:68-70) |
| `keysym(sym, down)` | `→ boolean` | `XKeysymToKeycode`. 0 → false. Else `keycode(code, down)` (317-323) | false = "the keyboard has no key for it" | borrow `press()` (264-268) |
| `keycode(code, down)` | void | ignores `code<8 \|\| code>255`. `XTestFakeKeyEvent`, flush, track `keysHeld` (278-284) | Keys Ember holds are released **by keycode**, because a layout switch can move a keysym (doc 22-26) | borrow `pressCode` (269-272) and `finally` release (433). desk view (311-320, 354, 360, 292) |
| `keysymOf(name)` | `→ keysym \| 0` | `XStringToKeysym(name)`, no display needed (325-327) | **Case-sensitive X names** ("Return", "Prior", "F4", "s", "exclam"). Also accepts "0x74" and "U0074" (policy.ts:542 refuses those) | borrow `keys` (358, 366). main.ts:1265. desk view (313, 350) |
| `keysDown()` | `→ keycode[]` | `XQueryKeymap` 32-byte bitmap → all codes down **by anyone, XTest included** (338-345) | Same namespace as `keycodeOf`. Ember's own held keys appear, and the borrow filters them with its `held` map | borrow `check()` `foreign` (243), idle loop (297). main.ts:1266 |
| `keycodeOf(sym)` | `→ keycode \| 0` | `XKeysymToKeycode` (328-331) | 0 = none | borrow `press` (265), `planText` fallback (281, 285). main.ts:1265. desk view (313, 352) |
| `needsShift(sym)` | `→ boolean` | true iff level 0 ≠ sym and level 1 = sym in the core map (332-337) | fallback when there is no XKB `layout()` | borrow `keys` (367), `planText` fallback (283) |
| `activeWindow()` | `→ WindowId \| 0` | with a WM: `_NET_ACTIVE_WINDOW`, else `XGetInputFocus` (>1) (346-352) | client window id | borrow `previousWindow` (417) |
| `screenSize()` | `→ {width,height}` | `XDisplayWidth/Height(default screen)` (353-357) | screen units, origin 0,0 | borrow `glideTo` bounds (320-323). desk snapshot (agent-process.ts:201). eval far points (gates.ts:148) |
| `findWindow(title, pid?, wmClass?)` | `→ WindowId \| 0` | clients (`_NET_CLIENT_LIST`, or viewable top-levels' clients). With `pid` and that pid owns windows: exact titles first (exactly one), else unique case-insensitive *contains*. Otherwise exact title (+ WM_CLASS part if given), exactly one (358-374) | **0 when none or several match** ("input sent to a guess could go anywhere") | main.ts:1279 → worker.withCursor (2928). desk worker (2987). eval runner (366) |
| `focusedWindow()` | `→ WindowId \| 0` | `XGetInputFocus`, walk up to the managed client (WM_STATE) (375-389) | comparable with `findWindow` | borrow activation wait (424-426), `keyboardOnTarget` per key/char (251-253) |
| `activate(w)` | void | no WM: `XRaiseWindow` + `XSetInputFocus`. With a WM: `_NET_ACTIVE_WINDOW` ClientMessage, source=2 (pager), time=0 (390-410) | best effort, verified by callers via `focusedWindow()` | borrow (422, restore 439). main.ts 238/433/436/624 |
| `focusInput?(w)` | void | `XSetInputFocus(w, RevertToParent, CurrentTime)` (411-415) | Ember's own windows only | main.ts:523, 624 |
| `sync()` | void | `XSync` (498-500) | | eval (gates.ts:160) |
| `releaseAll()` | void | ups for `keysHeld` and `buttonsHeld`, then XSync (285-292) | idempotent | `close()`. desk facade `close` (agent.ts:245) |
| `close()` | void | `releaseAll`, `open=false`, close the XI2 watch, `XCloseDisplay` (502-509) | idempotent | main.ts:1201, 189 (doctor). place.ts:242 |
| `layout?()` | `→ KeyLayout \| null` | XKB: state group+mods. `XkbGetMap` keysyms per keycode at [mods, mods\|Shift] for the active group. `shortcuts` = without Lock. `others` = other groups without Lock (up to 4). `shift` = Shift_L keycode (416-445) | keycodes as `keycode()` takes them | borrow `planText` (277), `keys` (363) |
| `keyboardGrabbed?(window?)` | `→ boolean` | probes with `XGrabKeyboard(root, time = server time + 60 s)`. `AlreadyGrabbed` or `Frozen` → grabbed, unless a MENU/DROPDOWN/POPUP/COMBO override-redirect popup of `window`'s app is mapped (446-459) | never really grabs (the time is invalid) | borrow `keyboardFree()` in click/keys/type/scroll (256-258) and before start (306) |
| `pointerOn?(window, elementWindow?)` | `→ boolean` | `XQueryPointer` child = top-level under the pointer (input-transparent skipped). Equal to `window`'s (or `elementWindow`'s) top-level → true. Else only an override-redirect menu of the same app, or a transient-for-target popup that isn't TOOLTIP/NOTIFICATION (460-476) | | borrow `pointerOnTarget()` in click/scroll (261-263) |
| `screenLocked?()` | `→ boolean` | XScreenSaver state On, or DPMS not On (477-489) | false when it can't tell | borrow before start (305) |
| `watchUser?(on)` | `→ boolean` | ref-counted XI2 raw-event select on a 2nd connection (490-494, 517-618) | false = no XI2 (poll only) | borrow (292, 236) |
| `userInput?()` | `→ "pointer" \| "keys" \| null` | drains raw events. Ember's XTEST presses are discounted by count. Motion from XTEST can't be told apart, so it is not used for "pointer" from the XTEST device (570-593) | "pointer" wins over "keys" | borrow `check()` (240), idle loop (296) |

Also exported: `xinputError` (input.ts:89, why `openXInput` returned null; logged at main.ts:1199) and
`openXInput(displayName?)` (input.ts:99).

---

## 3. `CursorBorrow` and `Hand` (borrow.ts) — behaviour the port must preserve

### 3.1 Public API
- `class UserTookOver extends Error { afterMs }` (18-22) and `class BorrowStopped extends Error` (25-29). The worker maps
  them to "user took the mouse back" (denied) and STOPPED (worker.ts:2957-2962, 3002-3003).
- `BorrowOptions` (31-51): `idleMs` (default 1500), `idleTimeoutMs` (default 15000), `window`, `elementWindow`,
  `onStart`, `keysOnly`, `signal`, plus `now`/`sleep` for tests.
- `interface Hand` (53-63): `glideTo(x,y)`, `click(button=1)`, `keys(combo)`, `type(text)`, `checkTyping(text)`,
  `scroll(dir, steps)`.
- `CursorBorrowOptions` (137-145): `onChange`, `mayRefocus(window)`.
- `CursorBorrow` (147): getters `active`, `driving`, `pending`, `usesMouse`. `stop()` (198) bumps `epoch` and sets
  `stopping`. `borrow(fn, o)` (203) serialises on `this.turn`, so borrows never overlap. A borrow asked for before a
  `stop()` throws `BorrowStopped` before starting (210).

### 3.2 Lifecycle of one borrow (borrowNow, 218-461)
1. `busy=true`. `o.signal` abort sets `stopping` (222-223).
2. **Idle wait** (289-306): `watchUser(true)`. Every 50 ms: still means the pointer is unchanged, `userInput()` is null,
   `keysDown()` is empty and there are no foreign buttons. It must stay still for `idleMs`, else it throws after
   `idleTimeoutMs` ("You kept using the mouse or keyboard…"). Then `screenLocked()` → throw, and
   `keyboardGrabbed(window)` → throw.
3. **Start** (415-428): `home = pointer()`, `previousWindow = activeWindow()`, `expected = home`, `setDriving(true)`,
   `onStart()`. If `o.window` is set: `activate(window)` (unless already active), then poll `focusedWindow() === window`
   10×100 ms. Failure throws "the window didn't come to the front…". Then `check()`.
4. `await fn(hand)`.
5. **finally** (430-460): release every held key **by keycode** (433). Then:
   - stopped, or took over **by keys** → jump `move(home)` and `restoreFocus()`.
   - normal end → `glideTo(home)` (errors swallowed). If stopped meanwhile → jump home. If nobody took over →
     `restoreFocus()`.
   - took over **by pointer** → nothing; the user is in control.

   `restoreFocus()` activates `previousWindow` only if `previousWindow`, `o.window` and `previousWindow !== o.window` hold
   and `mayRefocus(previousWindow)` is true (435-440). Then `unwatch()`, clear flags, `drivingNow=false` quietly.

### 3.3 Safety checks
- `check()` (238-248) runs before and after every step:
  - stop → `BorrowStopped`;
  - `used = userInput()`;
  - `moved` = pointer more than `TOLERANCE`=2 px from `expected` on either axis;
  - `foreign` = `keysDown()` minus `held`;
  - `foreignButtons()`.

  Any of those → `UserTookOver(now-t0)`. The takeover kind is "pointer" if `used==="pointer" || moved ||
  foreignButtons`, else "keys".
- `keyboardOnTarget()` (251-253): `o.window && focusedWindow() !== o.window` → Error.
- `keyboardFree()` (256-258): `keyboardGrabbed?.(o.window)` → Error (GRABBED text 134).
- `pointerOnTarget()` (261-263): `pointerOn?.(window, elementWindow) === false` → Error (COVERED text 135).

### 3.4 Steps and timings (exact)
| Step | Sequence |
|---|---|
| `glideTo(tx,ty)` (318-336) | `check()`. Bounds vs `screenSize()` (≥0 and < size), else "That spot is off the screen…". `steps = max(1, round(min(600, 180 + dist*0.5)/8))`, ease-in-out. Per step: `move`, `expected=…`, `sleep(8)` (STEP_MS 94), `check()` |
| `click(b=1)` (337-352) | `check, keyboardFree, pointerOnTarget`. `ownButtons |= 0x80<<b` (b 1..5). `button(b,true)`, `sleep(40)`, **finally** `button(b,false)`, clear bit. `sleep(60)`, `check` |
| `keys(combo)` (353-379) | `check, keyboardOnTarget, keyboardFree`. `parseCombo` → `sym = keysymOf(key)` (0 → "unknown key"). With `layout()`: `stroke = shortcutStroke(sym, layout)`; null → throw (no AltGr fallback). Mods = `keysymOf(each)`, + `Shift_L` (0xffe1) if `stroke.shift` / `needsShift(sym)`. Mods down in order, key down, `sleep(30)`, key up, **finally** mods up in reverse. `sleep(40)`, `check` |
| `type(text)` (380-396) | `planText` first (all or nothing). Per stroke: `check, keyboardOnTarget, keyboardFree`. [shift down], key down, key up, [shift up], `sleep(12)`. Final `check` |
| `checkTyping(text)` (397-399) | `planText(text)` only (throws) |
| `scroll(dir, steps)` (400-412) | button `{up:4, down:5, left:6, right:7}`. `check, keyboardFree, pointerOnTarget`. `min(max(1,steps),30)` × (`check`, down, up, `sleep(30)`). `check` |

`planText(text)` (275-286): `typeableText` (`/^[\x20-\x7e\n\t]*$/`, 132), else "Ember can only type plain ASCII…".
With `layout()` it returns `planTyping(text, layout)` (by keycode, `shift = layout.shift`). Without it, per character it
uses `keysymForChar` → `keycodeOf` (0 → throw) and `needsShift`, and Shift = `keycodeOf(Shift_L)`.
`press()` throws "this keyboard layout has no key for that" (266).

### 3.5 Takeover detection latency
- Target: **< 100 ms** from the user's input to the borrow's rejection (eval gate `takeover`, gates.ts:183-185, 5 trials,
  "user" = a second XTest connection moving the pointer by (40,25)). Kill switch gate: < 300 ms (gates.ts:186-188).
- Mid-glide the poll period is 8 ms. During a click, the gap between checks is about 100 ms (40 + 60); during keys,
  about 70 ms. Events in those gaps are not lost: XI2 queues them, and `userInput()` drains them at the next check.
  **A backend without event watching (macOS) only sees what is still true at the next poll.** A quick tap between two
  polls can be missed. It still gets pointer movement, held keys and held buttons.

### 3.6 Key vocabulary (borrow.ts:65-132)
- `MODIFIERS` (65-69): ctrl, control → Control_L; shift → Shift_L; alt → Alt_L; super, meta → Super_L; `*_l`/`*_r`
  variants. **No `cmd`, `command`, `option`, `opt`, `win`.**
- `KEY_ALIASES` (70-77): enter/return → Return; esc → Escape; tab; space; backspace → BackSpace; delete/del → Delete;
  home; end; pageup/page_up/prior → Prior; pagedown/page_down/next → Next; arrows; insert/ins; menu; pause; print;
  kp_enter → KP_Enter; and punctuation names.
- `CHAR_NAMES` (79-85): ASCII punctuation → X keysym names (exclam … asciitilde).
- `parseCombo(combo)` (101-114): "ctrl++" and "+" mean plus. The last part is the key; unknown modifiers throw. Key name:
  alias, else modifier name, else CHAR_NAMES, else `F\d{1,2}` uppercased, else a single char lowercased, else as given.
  **Single characters are always lowercased**: "ctrl+A" is Control_L + "a".
- `canonicalCombo` (121-129): order ctrl, alt, shift, super; lower case.
- `typeableText` (132).
- policy.ts:538-549 `canonicalKeys` re-parses with `parseCombo` after mapping `win|windows|cmd|command|logo|mod4` → super
  (LOGO_KEY, policy.ts:531). `isSystemKey` (policy.ts:562-572) denies **any** `super+…`, `print`, `xf86*`, `ctrl+alt+F*`,
  `alt+F1/F2`, and Ember's own `ctrl+alt+(y|n|a|x|space|e|m|end|…)`.

### 3.7 Typing plans (keymap.ts)
- `KeyLevels = Map<keycode, [symAlone, symWithShift]>` (11). `KeyLayout {typing, shortcuts, shift, others?}` (13-22).
- `keysymForChar(ch)` (37-42): "\n" → Return 0xff0d, "\t" → Tab 0xff09, printable ASCII → its code, else 0.
- `strokeFor(sym, keys)` (45-53): the first key with sym alone wins, else the first with Shift.
- `shortcutStroke(sym, layout)` (60-66): `shortcuts`, then each of `others`. Never AltGr.
- `shiftKey(keys)` (69-71): Shift_L key, else Shift_R, else 0.
- `planTyping(text, layout)` (78-94): throws, listing up to 6 missing characters, if any character is absent or needs
  Shift while `layout.shift` is 0.
- Keysym numbering, which any backend that builds `KeyLevels` must use: Latin-1 printable = the code point
  (0x20-0x7e, 0xa0-0xff); other Unicode = `0x1000000 + cp` (keybuffer.ts:58-63, desk/keys.ts:10-16). Dead keys must
  **not** look like their spacing character: X gives `dead_grave` 0xfe50, so `planTyping` refuses it
  (borrow-keys.test.ts:44-46).

---

## 4. The callers in detail

### 4.1 worker.ts (tier 3 on the user's screen, tier 2 on the desk)
- Deps (worker.ts:67-87):
  - `pointer?: () => {x,y,mask}|null` — screen px. The guide polls it every 15 ms and treats `mask & 256` as a left
    press (1291-1310).
  - `activationKey?: () => boolean` — Return, KP_Enter or space held (1269).
  - `cursor?: { borrow, findWindow(title,pid), setBorrowing(state), activeWindow?() }`.
- `withCursor(kind, element, fn, verifyId?, afterBorrow?, keysOnly = kind==="keys")` (2903-2969):
  1. Denies when `cursor.activeWindow()` is a security window, or `perception.systemDialogOpen()`.
  2. Needs `this.window.name`; `win = c.findWindow(name, pid)`, and 0 is refused.
  3. Takes the lease.
  4. Calls `c.borrow.borrow(hand => fn(guardedHand(hand, check, kind)), {window: win, signal, onStart, keysOnly?})`.
- `guardedHand` (2870-2886) wraps every Hand call with the task's `check()` (stop, auth prompt). `type` calls
  `checkTyping(whole)` and then types in 8-character chunks (2882).
- **press_keys** (tool 1029-1032 → `pressKeys` 2660-2733): policy first, on the canonical keys. Inside the borrow:
  `steadyFocus`, then `hand.keys(keys)` **with the model's raw string** (2717). So the string must parse with
  `parseCombo`, not only with `canonicalKeys`.
- **scroll** (tool 1033-1035 → `scroll` 2740-2867): `hand.glideTo(spot)`, then `hand.scroll(dir, steps)` for direct
  controls, or one notch at a time with reads in between (`hand.scroll(dir,1)`).
- **click / text** (`cursorAct` 1855-1995):
  1. `glideTo(spot)`, `sleep(POINTER_SETTLE_MS)`, read again, `glideTo(aim)` if it moved, `click()`.
  2. For text: `untilFocused`; then `hand.keys("ctrl+a")` + `hand.keys("Delete")` (replace) or `hand.keys("ctrl+End")`
     (append) (1952-1953).
  3. **Paste by default on the user's screen**: `paste = kind==="cursor_text" && !this.place && !!this.clipboard &&
     text!==""` (1859). The text goes on the clipboard and `hand.keys("ctrl+v")` is pressed (1959-1962). The clipboard is
     restored after the paste shows up (1976-1982).
  4. `hand.type(text)` is used only without a clipboard (never in main.ts, which always passes `electronClipboard`) and
     on the desk. Non-ASCII without paste is refused (1860-1862).
- **fill_cells / typeInCell** (2189, 2218, `fillCell` 2367-2415, `clearCell` 2531-2534, `toCellByName` 2554-2569):
  **keyboard typing on the user's screen** with `hand.type(text)`, `checkTyping`, and keys `ctrl+Home`, `Right/Left/Up/
  Down`, `Delete`, `Return`, `Escape`, `BackSpace`, and **`ctrl+shift+F5`** (LibreOffice's Name Box). Cell text is
  limited to ASCII (596).
- Desk: `deskBorrowFor(place)` (705-709) is a `new CursorBorrow(place.input)` per desk. `onDeskInput` (2971-3008) runs
  with `idleMs: 0`. Linux only.

### 4.2 main.ts
- 1198-1201: `openXInput()` only `if x11`. On will-quit: `borrowRef.stop(); xinput.close()`.
- 1204-1213 `showBorrowing`: uses `borrow.driving`, `usesMouse` and `pending` for overlay and handle click-through and the
  status line ("Using your mouse: move it to take over", …).
- 1214-1219: the borrow exists only if `xinput && policy.features.cursor !== false`.
  `mayRefocus: w => !askWindow.isWindow(w) && shownWindows().some(s => s.client === w || s.id === w)`.
  `shownWindows()` is `x11Ref.stack()` (428). **Without X11 it is empty, so focus is never given back.** The port must
  feed it from the WindowSystem, in the same `WindowId` domain as `Input.activeWindow()`.
- 1243: `hands` exists only `if x11`. This gates *everything* on X11, so the port must gate on `ws && input`.
- 1253 `flyTo` divides screen px by the **primary** scaleFactor. That is wrong on macOS (points) and on mixed-DPI Windows
  (see window-system.md §1).
- 1264-1267 `activationKey`: `["Return","KP_Enter","space"].map(n => keycodeOf(keysymOf(n))).filter(c => c > 0)` and
  `keysDown()`. On Windows, Return and KP_Enter share VK_RETURN, which is fine.
- Own-window activation: 238 (`bringToFront`), 433/436 (`giveFocusBack` to user windows), 523 and 624 (`focusInput`).
  All of them get the id from `getNativeWindowHandle().readUInt32LE(0)`. **On macOS that is a truncated `NSView*`, not a
  window number. Never pass it to `activate()`.** Use `ws.windowId(win)`; window-system.md uses `getMediaSourceId()` →
  `"window:<CGWindowID>:0"`.
- 1124-1146 shortcuts:
  - `Control+Alt+E` (settings), `Control+Alt+Space` (ask; chord-checked), `Control+Alt+X` (stop), `Control+Alt+M` (mute),
    plus `Control+Alt+Y/N` while a question is open (571-583).
  - `Control+Alt+Space` → `freshAskPress(x11Ref?.keysDown() ?? null, now, lastAskPress)`.

### 4.3 policy.ts
- Imports `parseCombo` only (13). The canonical vocabulary is **X keysym names in lower case**. `KEY_TWINS`,
  `TYPES_NOTHING`, `SAFE_COMBOS`, `DESTRUCTIVE_KEYS` and `PASTE_KEYS` (policy.ts:511-604) are all written for Linux
  conventions (ctrl-based clipboard, alt+f4).

### 4.4 Desk (Linux only — keep on XInput)
- `agent-process.ts` (helper process run with ELECTRON_RUN_AS_NODE):
  - `openXInput(DISPLAY)` (183); `openKeyboard` (35-93) reads `XGetKeyboardMapping` and lends spare keycodes to
    characters the US desk map lacks (`XChangeKeyboardMapping`, `SpareKeys`).
  - Calls arrive over IPC; `facade()` exposes the helper object's method list, so optional methods exist exactly when
    the helper has them (agent.ts:242-249).
  - All calls are synchronous through Atomics (agent.ts:137-…), about 0.2 ms each, with a 1 s hang timeout.
- `desk/keys.ts`:
  - `charKeysym`, `planKey(key, code, shortcut, lookup)` (53-75): DOM KeyboardEvent → keysym. Shortcuts go by key:
    Latin letters as labelled, digits by position, the rest by US position.
  - `findKey`, `spareKeycodes`, `SpareKeys`.
- `desk/view.ts:325-365` forwards the user's DOM events to the desk: `move`, `button`, `keycode`, `keycodeOf`,
  `keysymOf`, and Ctrl+Alt+End/Esc to hand back.
- **Gate the whole desk on `process.platform === "linux"`.** `DeskManager.available()` (desk.ts:369-372) only checks
  `which("Xvfb"|"xauth"|"dbus-daemon")`, and that can be **true on a Mac with XQuartz and Homebrew dbus**. `which` splits
  PATH on ":" and doesn't add ".exe", so it is false on Windows by accident.

---

## 5. keybuffer, clipboard handoff, PRIMARY, hotkey (today)

### 5.1 `holdKeyboard()` (keybuffer.ts:73-164)
- Opens its own X connection. Spins up to `GRAB_SPIN_MS`=50 ms on `XGrabKeyboard(root, ownerEvents 0, Async, Async,
  CurrentTime)` (94), because the hotkey's own passive grab holds the keyboard until Space is released.
- Then a 1 ms `setInterval` (111) retries the grab and drains KeyPress events. Each key is mapped with `XLookupString` +
  `keysymText` into `Typed {text, submit, cancel}` via `typedKey` (46-55): Esc cancels; Return/KP_Enter submits if the
  text is non-empty; Super combos are ignored; Backspace edits; Ctrl/Alt+Space or non-printables are ignored.
- The safety timeout is `HOLD_MAX_MS`=1500 (16). `stop()` drains, ungrabs, closes and returns `Typed`.
- Returns `null` if koffi/libX11/display is unavailable (78-80).
- Caller (main.ts:667, 672): `held = look ? holdKeyboard({log}) : null`, then
  `if (held) askWindow.hasKeyboard().then(() => askWindow.typed(held.stop()), () => held.stop())`.
  **null is fully tolerated.**

### 5.2 `handClipboardToManager({ourWindow})` (clipboard-handoff.ts:32-103)
- freedesktop CLIPBOARD_MANAGER `SAVE_TARGETS`, deadline 2 s.
- Decides "ours" by comparing the X resource-id base of the CLIPBOARD owner with Ember's window. The Display's
  `resource_mask` is read at offset 48.
- Result: `"saved"|"no-manager"|"not-ours"|"refused"|"timeout"|"unavailable"`.
- Caller (main.ts:1015-1034): only if `emberXid`, which is set only when `process.env.DISPLAY` (1017). The result is only
  logged.

### 5.3 `readSelection({sameClientAs})` (clipboard-handoff.ts:110-160)
- PRIMARY as UTF8_STRING, only if PRIMARY's owner is the same X client as the user's active window. 600 ms default, max
  2000 chars. `""` on anything else.
- Caller (main.ts:640): `captureContext` → `Perception.withSelection(context, sel)`.

### 5.4 `freshAskPress(chord, at, last)` (hotkey.ts:21-25)
- `ASK_DEBOUNCE_MS`=300 (9). `null` chord means "no display to ask", so the press is trusted (still debounced). Otherwise
  it needs `control && alt`.
- Chord type `{control, alt}` (15). Today the chord comes from `X11.keysDown()` (x11.ts:231-241), not XInput.

---

## 6. Proposed platform-neutral `Input` interface

Location: `app/main/platform/input.ts` (types), with backends `platform/linux/input.ts` (today's `input.ts`, moved),
`platform/win32/input.ts` and `platform/darwin/input.ts`, plus `platform/keysyms.ts` (the shared name↔keysym table).
Keep `hands/input.ts` re-exporting `openXInput`, `xinputError` and `type XInput = Input` so the desk, eval and tests
don't churn.

```ts
import type { KeyLayout } from "../hands/keymap";
import type { WindowId } from "./window-system";   // X client XID | HWND value | CGWindowID; 0 = none

/** X keysym numbering on every platform (Latin-1 = code point, other Unicode = 0x1000000 + cp, named keys 0xffXX). */
export type KeySym = number;
/**
 * Backend-opaque key code, ALWAYS >= 1 (callers treat 0 as "no key"):
 *   x11: X keycode 8..255 · win32: virtual-key code 1..254 · darwin: CGKeyCode + 8 (8..135)
 * keysDown(), keycodeOf(), layout() and keycode() share this namespace.
 * win32/darwin may also hand out "text keys" from textKey() (>= 0x10000); keysDown() never reports those.
 */
export type KeyCode = number;

export interface Input {
  readonly kind: "x11" | "win32" | "darwin";

  // ── pointer (screen units: x11 root px · win32 physical virtual-desktop px · darwin global points; may be < 0 off x11) ──
  pointer(): { x: number; y: number } | null;
  /** mask in X layout whatever the platform: 256 logical-left, 512 middle, 1024 logical-right (others optional). */
  pointerState(): { x: number; y: number; mask: number } | null;
  move(x: number, y: number): void;
  /** X numbering: 1 L, 2 M, 3 R, 4/5 wheel up/down, 6/7 wheel left/right, 8/9 back/forward. Wheel = down then up (one notch on the down). */
  button(button: number, down: boolean): void;

  // ── keys ──
  keysym(sym: KeySym, down: boolean): boolean;
  keycode(code: KeyCode, down: boolean): void;
  /** Case-sensitive X keysym name → keysym (0 if unknown). Never accepts "0x…"/"U…" numeric names off x11. */
  keysymOf(name: string): KeySym;
  /** Codes held now by anyone (Ember's own included), in KeyCode space; excludes text keys and generic modifier aliases. */
  keysDown(): KeyCode[];
  keycodeOf(sym: KeySym): KeyCode;
  needsShift(sym: KeySym): boolean;
  layout?(): KeyLayout | null;
  /**
   * NEW, optional. A key code that types exactly `ch` (one printable ASCII char, "\n" or "\t") regardless of the
   * layout, or 0. When present, CursorBorrow.planText uses it instead of layout()/keycodeOf (win32: KEYEVENTF_UNICODE).
   * Never used for shortcuts.
   */
  textKey?(ch: string): KeyCode;

  // ── windows (WindowId domain shared with WindowSystem) ──
  activeWindow(): WindowId;
  focusedWindow(): WindowId;
  findWindow(title: string, pid?: number, appClass?: string): WindowId;
  activate(window: WindowId): void;
  focusInput?(window: WindowId): void;
  pointerOn?(window: WindowId, elementWindow?: WindowId): boolean;
  keyboardGrabbed?(window?: WindowId): boolean;
  /** NEW, optional. Why input can't reach `window` at all (win32: elevated/UIPI; darwin: not trusted for Accessibility), or null. */
  blockedReason?(window: WindowId): string | null;

  // ── screen ──
  /** Kept for the desk/eval/tests: size of the screen (x11) or of the virtual-screen bounding box (win32/darwin). */
  screenSize(): { width: number; height: number };
  /** NEW, optional. Is (x,y) on some monitor? (virtual-screen bounding boxes have dead zones on mixed-size layouts). */
  onScreen?(x: number, y: number): boolean;
  screenLocked?(): boolean;

  // ── the user's own input as events ──
  watchUser?(on: boolean): boolean;
  userInput?(): "pointer" | "keys" | null;

  sync(): void;
  releaseAll(): void;
  close(): void;
}

export function openInput(o: { log: Logger; eventWindow?: () => BrowserWindow | null }): Input | null; // by process.platform
```

### 6.1 Required changes in `CursorBorrow` (small, keep the tests green)
1. **Bounds** (borrow.ts:320-323): `const ok = x.onScreen ? x.onScreen(tx, ty) : (tx >= 0 && ty >= 0 && tx < w && ty < h)`.
2. **Text keys** (`planText`, 275-286): before the layout branch,
   `if (x.textKey) return { strokes: [...text].map(ch => ({ code: x.textKey!(ch) || fail(ch), sym: keysymForChar(ch), shift: false })), shift: 0, byCode: true }`.
   `type()` then calls `pressCode` for each stroke, and `held` tracks the text keys, so `finally` releases them.
3. **Pointer lag tolerance** (macOS posts asynchronously): in `check()`, also accept the pointer within TOLERANCE of the
   *previous* `expected`. Keep `prevExpected`. A pointer that is one step behind is not the user.
4. **Primary modifier**: add `mod`, `primary` and `cmdorctrl` to `MODIFIERS`, resolving to Control_L on linux/win32 and
   Super_L (= Command) on darwin. Add `cmd`/`command` (→ Super_L) and `option`/`opt` (→ Alt_L). Make
   `parseCombo(combo, platform = process.platform)`. Change the worker's hard-coded strings to `mod+a`, `mod+v`,
   `mod+End`→(darwin `cmd+Down`), `mod+Home`→(darwin `cmd+Up`) and `mod+shift+F5`, via a small per-platform table in the
   worker. Policy work (separate spec): on darwin, `isSystemKey` must not deny all `super+…` (Cmd); deny
   cmd+space/tab/q/h/m/option+esc, ctrl+cmd+q, cmd+shift+3/4/5/q, ctrl+up/down. Map `SAFE_COMBOS`, `DESTRUCTIVE_KEYS`
   and `PASTE_KEYS` to cmd. On win32, add ctrl+esc, ctrl+shift+esc, alt+tab and alt+esc to the system keys.
5. Optional: `blockedReason?.(o.window)` before activating, throwing its text, e.g. "That window runs as administrator,
   so Ember can't use the mouse or keyboard there".

### 6.2 Contract checklist every backend must meet
- No-op after `close()`. `close()` and `releaseAll()` are idempotent. Held keys and buttons are tracked in the backend
  and released by `releaseAll()`. Wheel events are never recorded as held.
- `keysDown()` and `keycodeOf()` share one namespace, and Ember's own held keys show up there (the borrow filters them).
  Otherwise the borrow reports **false takeovers on Ember's own keys**.
- `pointerState().mask` uses X bits, with left = **logical** primary (swap-aware).
- `move()` is exact or within ±2 px (TOLERANCE). `pointer()` reflects a `move()` within one 8 ms step (or apply 6.1 #3).
- Ids from `activeWindow`, `focusedWindow` and `findWindow` compare equal to each other, to WindowSystem ids, and to
  `ws.windowId(ownWindow)`.
- `findWindow` returns 0 when the match is ambiguous.
- Every native call that can hang on a hung target (macOS AX) is bounded (messaging timeout ≤ 250 ms). `focusedWindow()`
  is called once per typed character.
- Every koffi call is **synchronous on the main thread**. Never `.async`: TIS/AppKit/HIToolbox must run on the main
  thread, and the borrow's checks are synchronous.
- Install `process.on("exit")` → `input.releaseAll()`. An injected key-down survives a crash on Windows and macOS (a
  stuck Ctrl) until the user presses that key.

---

## 7. Windows backend (`platform/win32/input.ts`)

### 7.1 Libraries and types (koffi 3.2.1 spellings)
```js
const user32 = koffi.load("user32.dll"), kernel32 = koffi.load("kernel32.dll"), advapi32 = koffi.load("advapi32.dll");
const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
const MOUSEINPUT = koffi.struct("MOUSEINPUT", { dx: "int32", dy: "int32", mouseData: "int32" /* DWORD; int32 lets -120 through */,
  dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });                 // 32 bytes on x64
const KEYBDINPUT = koffi.struct("KEYBDINPUT", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" }); // 24
const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", { uMsg: "uint32", wParamL: "uint16", wParamH: "uint16" });
const INPUT = koffi.struct("INPUT", { type: "uint32", u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) }); // sizeof 40 on x64, 28 on ia32
const SendInput = user32.func("uint32_t __stdcall SendInput(uint32_t n, INPUT *inputs, int cbSize)"); // pass a JS array; cbSize = koffi.sizeof(INPUT)
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int x, int y)");
const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ POINT *p)");    // let p = {}; GetCursorPos(p)
const GetAsyncKeyState = user32.func("int16_t __stdcall GetAsyncKeyState(int vk)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int i)");
const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");   // → BigInt or null
const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(void *hwnd)");
const WindowFromPoint = user32.func("void * __stdcall WindowFromPoint(POINT pt)");   // struct BY VALUE: WindowFromPoint({x, y})
const GetAncestor = user32.func("void * __stdcall GetAncestor(void *hwnd, uint32_t flags)");
const GetWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)"); // const pid=[0]
const AttachThreadInput = user32.func("int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)");
const GetCurrentThreadId = kernel32.func("uint32_t __stdcall GetCurrentThreadId()");
const VkKeyScanExW = user32.func("int16_t __stdcall VkKeyScanExW(uint16_t ch, void *hkl)");
const MapVirtualKeyExW = user32.func("uint32_t __stdcall MapVirtualKeyExW(uint32_t code, uint32_t type, void *hkl)");
const GetKeyboardLayout = user32.func("void * __stdcall GetKeyboardLayout(uint32_t thread)");
const EnumWindowsProc = koffi.proto("int __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)");
const EnumWindows = user32.func("int __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)"); // transient JS callback is fine (sync)
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void *hwnd, uint16_t *buf, int max)"); // Buffer.alloc(2*n); buf.toString("utf16le",0,2*len)
```
- **Win32 `BOOL` is 4 bytes.** Declare it as `int` in both returns and callbacks. koffi's `bool` is 1 byte.
- `long` is 4 bytes on Windows (LLP64). Use `intptr_t`/`void *` for HWND, LPARAM and HKL.
- Pointer results are **BigInt or `null`** (util.hh:447-458). JS **numbers are accepted** wherever a pointer is expected
  (util.hh:191-197). Store HWNDs as `Number(hwnd)`; HWND values fit in 32 bits by design. Pass them back as numbers.
- `__stdcall` is ignored on x64/arm64 and needed on ia32. Keep it.
- `GetLastError()` through koffi is **unreliable**: koffi 3.2.1 has no last-error capture and V8 can clobber it. Use it
  for logs only.

### 7.2 Coordinates and DPI
- Electron's main process is per-monitor-v2 DPI aware. `GetCursorPos`, `SetCursorPos` and `GetSystemMetrics(SM_*VIRTUALSCREEN)`
  are physical pixels there. Assert it at open: `GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) === 2`.
  If not, use `GetPhysicalCursorPos`/`SetPhysicalCursorPos` and log a warning.
- The virtual screen is `SM_XVIRTUALSCREEN` 76, `SM_YVIRTUALSCREEN` 77, `SM_CXVIRTUALSCREEN` 78, `SM_CYVIRTUALSCREEN`
  79. **x/y can be negative.**
  - `screenSize()` = `{width: cx, height: cy}`.
  - `onScreen(x,y)` = `MonitorFromPoint({x,y}, MONITOR_DEFAULTTONULL=0) !== null`.
- The UIA sidecar must also be PMv2-aware, so that BoundingRectangle uses the same physical space (perception spec).
  powershell.exe is DPI-*unaware* by default. Call `SetProcessDpiAwarenessContext(-4)` first thing.

### 7.3 Pointer
- **`move(x,y)`: use `SetCursorPos(round(x), round(y))`.** It is exact to the pixel, synchronous (no lag vs `pointer()`),
  and not subject to UIPI. The system sends WM_MOUSEMOVE to the window under the cursor, so hover works.
  - Alternative: `SendInput` with `MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK` (0x0001|0x8000|0x4000) and
    `dx = round((x - vx) * 65535 / (vw - 1))`. That has rounding error (±1 px, inside TOLERANCE). Prefer SetCursorPos.
- `pointer()`: `GetCursorPos`. Returns null if it fails, which happens on the secure desktop or lock screen.
- `pointerState().mask`: `GetAsyncKeyState(VK_LBUTTON 1 / VK_RBUTTON 2 / VK_MBUTTON 4) & 0x8000`. **These are physical
  buttons.** If `GetSystemMetrics(SM_SWAPBUTTON=23)`, swap L/R so 256 stays the *logical* primary.
- `button(b, down)` via `SendInput`, one `INPUT {type: INPUT_MOUSE 0, u:{mi:{dx:0,dy:0,mouseData,dwFlags,time:0,dwExtraInfo:EMBER_TAG}}}`:

  | X button | down flags / mouseData | up |
  |---|---|---|
  | 1 | LEFTDOWN 0x0002 | LEFTUP 0x0004 |
  | 2 | MIDDLEDOWN 0x0020 | MIDDLEUP 0x0040 |
  | 3 | RIGHTDOWN 0x0008 | RIGHTUP 0x0010 |
  | 4 (wheel up) | WHEEL 0x0800, mouseData **+120** | no-op |
  | 5 (wheel down) | WHEEL 0x0800, mouseData **-120** | no-op |
  | 6 (wheel left) | HWHEEL 0x1000, mouseData **-120** | no-op |
  | 7 (wheel right) | HWHEEL 0x1000, mouseData **+120** | no-op |
  | 8 (back) | XDOWN 0x0080, mouseData XBUTTON1 1 | XUP 0x0100 |
  | 9 (forward) | XDOWN 0x0080, mouseData XBUTTON2 2 | XUP 0x0100 |

  Injected buttons are **physical**, so `SwapMouseButton` applies to them. If SM_SWAPBUTTON, send RIGHT for X1 and LEFT
  for X3, so that "button 1" stays the logical primary click.
- `dwExtraInfo = EMBER_TAG` (for example `0x454D4252`) marks Ember's events for any LL hook or `GetMessageExtraInfo`.

### 7.4 Keys
- **KeyCode = VK code.** Static keysym → VK table (from keysyms.ts):

  | keysym name | VK | extended |
  |---|---|---|
  | Return | 0x0D | KP_Enter → same VK, see below |
  | Escape | 0x1B | |
  | Tab | 0x09 | |
  | BackSpace | 0x08 | |
  | space | 0x20 | |
  | Delete | 0x2E | ext |
  | Insert | 0x2D | ext |
  | Home | 0x24 | ext |
  | End | 0x23 | ext |
  | Prior | 0x21 | ext |
  | Next | 0x22 | ext |
  | Left / Up / Right / Down | 0x25 / 0x26 / 0x27 / 0x28 | ext |
  | Menu | 0x5D (VK_APPS) | ext |
  | Pause | 0x13 | |
  | Print | 0x2C | ext |
  | Caps_Lock | 0x14 | |
  | Num_Lock | 0x90 | ext |
  | Scroll_Lock | 0x91 | |
  | F1…F24 | 0x70…0x87 (keysyms 0xffbe…0xffd5) | |
  | Shift_L / Shift_R | 0xA0 / 0xA1 | |
  | Control_L / Control_R | 0xA2 / 0xA3 | R: ext |
  | Alt_L / Alt_R | 0xA4 / 0xA5 | R: ext |
  | Super_L / Super_R, Meta_L | 0x5B / 0x5C | ext |
  | KP_0…KP_9 | 0x60…0x69 | |
  | KP_Multiply / KP_Add / KP_Separator / KP_Subtract / KP_Decimal | 0x6A / 0x6B / 0x6C / 0x6D / 0x6E | |
  | KP_Divide | 0x6F | ext |
  | a…z, A…Z | 0x41…0x5A (layout-independent; uppercase → `needsShift` true) | |
  | 0…9 | 0x30…0x39 | |
  | other ASCII punctuation | `VkKeyScanExW(ch, hkl)`: low byte = VK, high byte bit 1 = Shift. **Refuse** (return 0) if the result is -1 or the high byte has 2 (Ctrl) or 4 (Alt): that is AltGr (Ctrl+Alt) | |
- `hkl` is **the foreground thread's layout**, because Windows layouts are per thread:
  `GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), null))`. Fall back to `GetKeyboardLayout(0)`.
- Letters by VK give Windows the same rule as X's `shortcutStroke` with `others`. VK_C is the key apps treat as Ctrl+C on
  any layout, and AZERTY layouts map VK_A to the key that types "a".
- `keycode(vk, down)`: one `INPUT_KEYBOARD 1` with `{wVk: vk, wScan: MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC=0, hkl),
  dwFlags: (ext ? KEYEVENTF_EXTENDEDKEY 1 : 0) | (down ? 0 : KEYEVENTF_KEYUP 2), dwExtraInfo: EMBER_TAG}`.
  - **Arrows, Home/End and the like without EXTENDEDKEY reach scan-code readers as numpad keys.**
  - KP_Enter: send VK_RETURN with EXTENDEDKEY, but keep the KeyCode `0x0D`. Otherwise `keysDown()` (which can only
    report 0x0D) would make Ember's own numpad Enter look foreign.
- `keysym(sym, down)`: `vk = keycodeOf(sym)`; 0 → false; else `keycode(vk, down)`; true.
- `needsShift(sym)`: uppercase A-Z → true. Punctuation → `(VkKeyScanExW(ch, hkl) >> 8) & 1`. Named keys → false.
- `layout()`: **return null** (use `keycodeOf` + `needsShift` for shortcuts and `textKey` for text). A full `KeyLevels`
  via `ToUnicodeEx(vk, scan, state, buf, 4, flags=4 /* no kernel state change, Win10 1607+ */, hkl)` is possible later.
  Dead keys then need care.
- **`textKey(ch)`** returns `0x10000 + ch.charCodeAt(0)` for printable ASCII, VK_RETURN for "\n" and VK_TAB for "\t".
  `keycode(code ≥ 0x10000, down)` sends `{wVk: 0, wScan: code & 0xffff, dwFlags: KEYEVENTF_UNICODE 4 | (down?0:KEYUP 2)}`.
  - The result does not depend on the layout, Caps Lock or AltGr, and never presses Shift (so no StickyKeys prompt). Apps
    receive VK_PACKET → WM_CHAR.
  - Caveat: some IMEs (Japanese/Chinese composition) may still intercept it. Test.
- `keysDown()`: for `vk` in 0x08…0xFE, skip 0x10/0x11/0x12 (generic SHIFT/CONTROL/MENU: they would duplicate L/R),
  1/2/4/5/6 (mouse buttons) and 0xE7 (VK_PACKET). Report those with `GetAsyncKeyState(vk) & 0x8000`.
  - **Do not use `GetKeyboardState`**: it is the calling thread's synchronous state, stale for other apps.
  - Injected keys do update the async state, so Ember's held VKs appear and are filtered by `held`, as on X.
  - About 240 koffi calls per check (tens of µs) is acceptable. A curated list of about 110 VKs is fine too.
- Pitfall: on AltGr layouts, injecting **VK_RMENU makes Windows synthesize a fake LCtrl down**. With `Alt_R` held,
  `keysDown()` then shows VK_LCONTROL, which Ember didn't press → false takeover. Map `Alt_R` to VK_LMENU on Windows, or
  add 0xA2 to the tolerated set while 0xA5 is held.
- Note: **Ctrl+Alt+<key> is AltGr on Windows.** Injected `ctrl+alt+e` types "€" on a German layout. Ember's own global
  shortcuts `Control+Alt+E/M/N/Y/X/Space` also **steal AltGr characters** (€, µ, ń, …) in every app once registered with
  RegisterHotKey. Choose different default accelerators on Windows (hotkey spec).

### 7.5 Takeover detection on Windows
- Polling (always): `pointer()` vs `expected`, `keysDown()` minus held, the button mask.
- **Event watch (`watchUser`/`userInput`) via Raw Input.** This is the true analogue of XI2 + XTEST filtering.
  1. Register on a hidden Ember BrowserWindow's HWND (supplied via `openInput({eventWindow})`):
     `RegisterRawInputDevices([{usUsagePage:1, usUsage:2 /*mouse*/, dwFlags: RIDEV_INPUTSINK 0x100, hwndTarget},
     {usUsagePage:1, usUsage:6 /*keyboard*/, …}], 2, 16)`. `RAWINPUTDEVICE {uint16, uint16, uint32, void*}` is 16 bytes on
     x64.
  2. Receive with **`win.hookWindowMessage(0x00FF /* WM_INPUT */, (wParam, lParam) => …)`** (Electron, @platform win32,
     electron.d.ts:2923). `h = lParam.readBigUInt64LE(0)` is the HRAWINPUT.
  3. `GetRawInputData(h, RID_HEADER 0x10000005, hdr, size=[24], 24)`, with
     `RAWINPUTHEADER {dwType:"uint32", dwSize:"uint32", hDevice:"void *", wParam:"uintptr_t"}` (24 bytes on x64).
  4. **`hDevice === null` (0) means injected (SendInput, Ember's or anyone's). Skip it.** Otherwise record
     `dwType === 0 (RIM_TYPEMOUSE) ? "pointer" : "keys"`.
  5. `userInput()` returns and clears the record. Remove with `RIDEV_REMOVE 1` when the last watcher leaves.
  - Caveats: registration is per process per usage (it replaces Chromium's, which registers raw mouse only for pointer
    lock, not used by Ember windows). A hidden window still receives WM_INPUT with INPUTSINK.
  - **Do not use `WH_MOUSE_LL`/`WH_KEYBOARD_LL` from JS.** A hook callback blocked by GC or a busy main thread
    lags all system input. After `LowLevelHooksTimeout`, Windows silently removes the hook.
- `GetLastInputInfo` also counts injected input, so it is not usable to tell Ember's input from the user's.

### 7.6 Windows, focus and activation
- `activeWindow()` = `focusedWindow()` = `Number(GetAncestor(GetForegroundWindow(), GA_ROOT=2) ?? 0)`.
  - It is 0 while activation is in flux. The borrow's 10×100 ms wait handles that.
  - A dialog is its own top-level, so it ≠ the target, which matches X ("another window has the keyboard").
- `findWindow(title, pid)`: `EnumWindows` over visible, non-cloaked top-levels
  (`DwmGetWindowAttribute(DWMWA_CLOAKED=14)` hides other virtual desktops and suspended UWP windows), with the same
  pid/exact/contains/unique rules as input.ts:358-374.
  - UWP: the frame belongs to ApplicationFrameHost.exe, so the pid filter finds nothing and it falls back to a unique
    exact title.
  - `GetWindowTextW` reads the cached title and never blocks on a hung app.
- **`activate(hwnd)`** in order, stopping as soon as `GetForegroundWindow()` is the target:
  1. `if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE=9)`.
  2. **Empty-input trick**: `SendInput(1, [{type: INPUT_MOUSE, u:{mi:{dx:0,dy:0,mouseData:0,dwFlags:0,…}}}], 40)`, then
     `SetForegroundWindow(hwnd)`. Ember becomes "the process that sent the last input", which the foreground lock
     allows. PowerToys uses this.
  3. `AttachThreadInput(GetCurrentThreadId(), fgThread, 1)`; `SetForegroundWindow`, `BringWindowToTop`, `SetFocus`;
     `AttachThreadInput(…, 0)`. **Always detach in `finally`.** Never attach to a hung thread: check `IsHungAppWindow(fg)`
     first.
  4. Don't use the Alt-tap trick. It toggles menu mnemonics in the user's app.
  - **`AllowSetForegroundWindow(pid)` only works when called by the current foreground process.** It is useless for
    the borrow, which runs while another app is foreground. It only helps when Ember's own window is foreground and wants
    to hand foreground to a known pid.
  - The foreground lock timeout (`SPI_GETFOREGROUNDLOCKTIMEOUT`, default 200 000 ms) is not reset by the user being
    idle, so the tricks are needed.
- `focusInput(hwnd)` (Ember's own windows only): Electron's `win.focus()` already does this (Chromium has a
  ForegroundHelper hotkey trick). Then `SetFocus(hwnd)`; Ember's HWNDs live on the main thread, so SetFocus is legal.
  Keep it optional.
- `pointerOn(window, elementWindow)`:
  - `top = GetAncestor(WindowFromPoint({x,y}), GA_ROOT)`. WindowFromPoint skips hidden/disabled windows and Ember's own
    click-through windows (`setIgnoreMouseEvents(true)` = WS_EX_TRANSPARENT|LAYERED).
  - true if `top === window || top === elementWindow`.
  - Otherwise, if `top` is a popup of the same pid (class `#32768` = menu, or an owned window, i.e. the
    `GetWindow(top, GW_OWNER=4)` chain reaches the target), and not `tooltips_class32` or a notification → true.
  - Else false.
- `keyboardGrabbed(window)`: true when **the input desktop isn't "Default"** (UAC consent, Ctrl+Alt+Del, lock screen):
  `h = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS=1)`; null → true; else
  `GetUserObjectInformationW(h, UOI_NAME=2, buf, len, needed)` ≠ "Default" → true; `CloseDesktop(h)`.
  - The Start menu and Task View take the foreground, and `keyboardOnTarget` already catches that.
- `screenLocked()`: the same desktop test. Electron's `powerMonitor.getSystemIdleState(1) === "locked"` is a good
  secondary signal on Windows and macOS.
- **`blockedReason(hwnd)`** (UIPI):
  - `pid` via GetWindowThreadProcessId. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION 0x1000, 0, pid)`, then
    `OpenProcessToken(h, TOKEN_QUERY 8, out)` and `GetTokenInformation(TokenElevation=20 → {uint32 TokenIsElevated})`.
  - **ACCESS_DENIED on the token ⇒ treat as elevated.** Elevated while Ember isn't →
    "That window runs as administrator, so Ember can't use the mouse or keyboard there."
  - Reason: `SendInput` "fails when blocked by UIPI. Neither GetLastError nor the return value will indicate the failure".
    Clicks and keys would vanish, and a glide over the elevated window would look like nothing happened.
  - The medium-IL UIA sidecar usually can't read elevated apps either, so perception fails first. Keep the check anyway.
- `sync()`: no-op (SendInput and SetCursorPos are synchronous).

### 7.7 Release and focus restore
- `releaseAll()`: send KEYUP for every held VK (unicode keys: `KEYEVENTF_UNICODE|KEYUP`) and button ups for held
  buttons. Then clear.
- Restore focus is the borrow's `activate(previousWindow)`, which goes through the same tricks. Ember just sent input, so
  trick 2 normally succeeds.

---

## 8. macOS backend (`platform/darwin/input.ts`)

### 8.1 Libraries (koffi 3.2.1)
```js
const FW = n => `/System/Library/Frameworks/${n}.framework/${n}`;   // dlopen works although the files live in the dyld shared cache
const cg = koffi.load(FW("CoreGraphics")), cf = koffi.load(FW("CoreFoundation"));
const ax = koffi.load(FW("ApplicationServices"));                    // HIServices: AX*, _AXUIElementGetWindow
const hit = koffi.load(FW("Carbon"));                                // HIToolbox: TIS*, IsSecureEventInputEnabled, LMGetKbdType
const cs = koffi.load(FW("CoreServices"));                           // UCKeyTranslate
const CGPoint = koffi.struct("CGPoint", { x: "double", y: "double" });
const CGEventCreate = cg.func("void *CGEventCreate(void *source)");
const CGEventGetLocation = cg.func("CGPoint CGEventGetLocation(void *event)");      // struct BY VALUE return (HFA: d0/d1 on arm64)
const CGEventCreateMouseEvent = cg.func("void *CGEventCreateMouseEvent(void *src, uint32_t type, CGPoint pos, uint32_t button)");
const CGEventCreateKeyboardEvent = cg.func("void *CGEventCreateKeyboardEvent(void *src, uint16_t keycode, bool down)");
const CGEventKeyboardSetUnicodeString = cg.func("void CGEventKeyboardSetUnicodeString(void *e, unsigned long n, const char16_t *s)"); // pass a JS string
const CGEventCreateScrollWheelEvent2 = cg.func("void *CGEventCreateScrollWheelEvent2(void *src, uint32_t units, uint32_t count, int32_t w1, int32_t w2, int32_t w3)");
const CGEventSetFlags = cg.func("void CGEventSetFlags(void *e, uint64_t flags)");
const CGEventSetIntegerValueField = cg.func("void CGEventSetIntegerValueField(void *e, uint32_t field, int64_t v)");
const CGEventPost = cg.func("void CGEventPost(uint32_t tap, void *e)");
const CGEventSourceCreate = cg.func("void *CGEventSourceCreate(int32_t state)");
const CGEventSourceSetLocalEventsSuppressionInterval = cg.func("void CGEventSourceSetLocalEventsSuppressionInterval(void *src, double s)");
const CGEventSourceSetLocalEventsFilterDuringSuppressionState = cg.func("void CGEventSourceSetLocalEventsFilterDuringSuppressionState(void *src, uint32_t mask, uint32_t state)");
const CGEventSourceKeyState = cg.func("bool CGEventSourceKeyState(int32_t state, uint16_t key)");
const CGEventSourceButtonState = cg.func("bool CGEventSourceButtonState(int32_t state, uint32_t button)");
const CGEventSourceFlagsState = cg.func("uint64_t CGEventSourceFlagsState(int32_t state)");
const CGEventSourceCounterForEventType = cg.func("uint32_t CGEventSourceCounterForEventType(int32_t state, uint32_t type)");
const CGPreflightPostEventAccess = cg.func("bool CGPreflightPostEventAccess()");      // macOS 10.15+
const CFRelease = cf.func("void CFRelease(void *cf)");                                // never with null: guard
const kCFBooleanTrue = koffi.decode(cf.symbol("kCFBooleanTrue"), "void *");           // read an exported global
```
- **`CGEventCreateScrollWheelEvent2` is NOT variadic.** It takes three fixed `int32_t` wheels (macOS 10.13+). It exists
  precisely because the original `CGEventCreateScrollWheelEvent(src, units, count, wheel1, ...)` *is* variadic. Use
  Scroll2.
  - If the variadic one is ever needed, koffi's spelling is
    `cg.func("void *CGEventCreateScrollWheelEvent(void *src, uint32_t units, uint32_t count, int32_t w1, ...)")`, called
    as `f(src, 1, 2, dy, "int32_t", dx)`. koffi implements Apple arm64's variadic-on-stack rule (abi/arm64.cc:58-63).
- **`objc_msgSend` must never be declared variadic.** Declare one fixed prototype per selector signature, e.g.
  `objc.func("long objc_msgSend(void *self, void *sel)")`. On arm64, variadic arguments go on the stack and
  objc_msgSend reads registers. Prefer `BrowserWindow.getMediaSourceId()` → `window:<CGWindowID>:0` for own-window ids,
  which needs no objc at all (window-system.md §8).
- `kAXFrontmostAttribute`, `kAXRaiseAction`, `kAXMainAttribute`, `kAXFocusedWindowAttribute`, … are **`#define CFSTR(…)`
  macros, not exported symbols**. Build them with
  `CFStringCreateWithCString(null, "AXFrontmost", kCFStringEncodingUTF8 = 0x08000100)` once and keep them.
- These *are* exported globals (`lib.symbol` + `koffi.decode(ptr, "void *")`): `kAXTrustedCheckOptionPrompt` (ax),
  `kCFBooleanTrue` / `kCFBooleanFalse` (cf), `kTISPropertyUnicodeKeyLayoutData` (hit), `kCGWindowNumber`,
  `kCGWindowOwnerPID`, `kCGWindowLayer`, `kCGWindowBounds` (cg).
- Structs like `kCFTypeDictionaryKeyCallBacks` are passed **by address**: pass `cf.symbol("kCFTypeDictionaryKeyCallBacks")`
  itself, not decoded.

### 8.2 Permissions (TCC)
- **Posting events needs Accessibility trust.** Without it, `CGEventPost` drops events **silently**.
  - Preflight with `CGPreflightPostEventAccess()` or Electron's `systemPreferences.isTrustedAccessibilityClient(false)`
    (electron.d.ts:14347). Prompt with `isTrustedAccessibilityClient(true)`.
  - Report it through `blockedReason()` and the doctor ("xtest" check → "input").
- The AX sidecar (an ELECTRON_RUN_AS_NODE child of the bundle executable) inherits the bundle as its "responsible
  process", so one grant to Ember.app covers both.
  - In development (`electron .` from a terminal) the grant belongs to the terminal app.
  - Ad-hoc re-signing invalidates grants.
- Listening event taps (`CGEventTapCreate`, listen-only) need **Input Monitoring**, a second permission. Avoid them.
  Section 8.5 polls instead.

### 8.3 Event source and suppression (critical for takeover)
```js
const src = CGEventSourceCreate(-1 /* kCGEventSourceStatePrivate */);
CGEventSourceSetLocalEventsSuppressionInterval(src, 0.0);
CGEventSourceSetLocalEventsFilterDuringSuppressionState(src, 7 /* kCGEventFilterMaskPermitAllEvents */, 0 /* SuppressionInterval */);
CGEventSourceSetLocalEventsFilterDuringSuppressionState(src, 7, 1 /* RemoteMouseDrag */);
```
By default, the hardware mouse and keyboard are **suppressed for 0.25 s after each posted event**. Ember posts every 8 ms
while gliding, so the user could not move the mouse to take over. A private source also keeps the session's modifier
state out of Ember's events. **Set flags explicitly on every keyboard event.**

### 8.4 Pointer and buttons (coordinates in points)
- `pointer()`: `e = CGEventCreate(null); p = CGEventGetLocation(e); CFRelease(e)` → `{x: round(p.x), y: round(p.y)}`.
  This is global display space: top-left of the main display, y down, may be negative. It is the same space as
  AXPosition and Electron DIP, so `toDip` is the identity on macOS.
- `pointerState().mask`: `CGEventSourceButtonState(1 /* HIDSystemState */, 0 /*Left*/ |1 /*Right*/ |2 /*Center*/)` → 256 / 1024 / 512.
- `move(x,y)`: `CGEventCreateMouseEvent(src, type, {x,y}, btn)` + `CGEventPost(0 /* kCGHIDEventTap */, e)` + `CFRelease`.
  - `type` is `kCGEventMouseMoved 5`, or a **dragged type while a button is held**: LeftMouseDragged 6,
    RightMouseDragged 7, OtherMouseDragged 27.
  - Posting is asynchronous, so `pointer()` may lag a step. Apply §6.1 #3, or a 1-2 ms settle in `move()`.
  - Don't use `CGWarpMouseCursorPosition`. It sends no hover events and adds its own suppression.
- `button(b, down)`:
  - 1 → LeftMouseDown 1 / LeftMouseUp 2, button 0.
  - 3 → RightMouseDown 3 / RightMouseUp 4, button 1.
  - 2 → OtherMouseDown 25 / OtherMouseUp 26, button 2.
  - 8/9 → Other 25/26, buttons 3/4.
  - Set `CGEventSetIntegerValueField(e, 1 /* kCGMouseEventClickState */, 1)`; some apps ignore clicks without it. Post
    at the current `pointer()`.
- Wheel (4-7, on down only):
  `CGEventCreateScrollWheelEvent2(src, 1 /* kCGScrollEventUnitLine */, 2, dy, dx, 0)` with
  `dy = +N` for 4 (up), `−N` for 5; `dx = +N` for 6 (**left is positive** in CG), `−N` for 7.
  - Use N = 3 lines per notch, to match Windows' default (tunable).
  - Posted events are not inverted by "natural scrolling" (verify on hardware). The worker re-reads after every notch
    anyway.

### 8.5 Keys
- **KeyCode = CGKeyCode + 8** (because kVK_ANSI_A = 0). ANSI table (HIToolbox Events.h):

  | Key(s) | CGKeyCode |
  |---|---|
  | A S D F H G Z X C V | 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08 0x09 |
  | B Q W E R Y T | 0x0B 0x0C 0x0D 0x0E 0x0F 0x10 0x11 |
  | 1 2 3 4 6 5 | 0x12 0x13 0x14 0x15 0x16 0x17 |
  | = 9 7 - 8 0 | 0x18 0x19 0x1A 0x1B 0x1C 0x1D |
  | ] O U [ I P | 0x1E 0x1F 0x20 0x21 0x22 0x23 |
  | Return | 0x24 |
  | L J ' K ; \ , / N M . | 0x25 0x26 0x27 0x28 0x29 0x2A 0x2B 0x2C 0x2D 0x2E 0x2F |
  | Tab, Space, ` (grave) | 0x30, 0x31, 0x32 |
  | **BackSpace = kVK_Delete** | 0x33 |
  | Escape | 0x35 |
  | Command R / L | 0x36 / 0x37 |
  | Shift, CapsLock, Option, Control | 0x38, 0x39, 0x3A, 0x3B |
  | RightShift, RightOption, RightControl, Function | 0x3C, 0x3D, 0x3E, 0x3F |
  | KP_Decimal, KP_Multiply, KP_Add | 0x41, 0x43, 0x45 |
  | KP_Divide, **KP_Enter**, KP_Subtract, KP_Equal | 0x4B, 0x4C, 0x4E, 0x51 |
  | KP_0…KP_7 | 0x52…0x59 |
  | KP_8, KP_9 | 0x5B, 0x5C |
  | F1 0x7A, F2 0x78, F3 0x63, F4 0x76, F5 0x60, F6 0x61 | |
  | F7 0x62, F8 0x64, F9 0x65, F10 0x6D, F11 0x67, F12 0x6F | |
  | F13 0x69, F14 0x6B, F15 0x71, F16 0x6A, F17 0x40, F18 0x4F, F19 0x50, F20 0x5A | |
  | Help/"Insert" | 0x72 |
  | Home, Prior, **Delete = kVK_ForwardDelete** | 0x73, 0x74, 0x75 |
  | End, Next | 0x77, 0x79 |
  | Left, Right, Down, Up | 0x7B, 0x7C, 0x7D, 0x7E |

  - X modifier keysyms map as: Control_L → 0x3B, Shift_L → 0x38, Alt_L → 0x3A (Option), Super_L / Meta_L → 0x37
    (Command); the `_R` variants map to the right-hand codes.
  - `keysymOf` returns 0 for Print, Pause, Menu and Insert: there are no such keys, which gives "unknown key".
- `layout()`: **implement it.** Then `planTyping` and `shortcutStroke` are reused unchanged.
  - `src = TISCopyCurrentKeyboardLayoutInputSource()`. This returns the ASCII-capable layout under an IME.
  - `data = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData)` → `CFDataGetBytePtr(data)` is the
    `UCKeyboardLayout*`. It can be NULL for some sources; return null then.
  - For each CGKeyCode 0…127, call `UCKeyTranslate(layout, code, kUCKeyActionDown 0, modState, LMGetKbdType(),
    0 /* dead keys ON */, deadState=[0], 4, len=[0], buf)` with `modState` 0 (alone) and 2 (Shift: (shiftKey 0x200 >> 8)).
    The typing map also adds 4 (alphaLock 0x400 >> 8) when Caps Lock is on (`CGEventSourceFlagsState(1) & 0x10000`).
    - `len == 0 && deadState != 0` → **dead key** → 0, not the accent character.
    - Otherwise the keysym of `buf[0..len)`.
  - Returns `{typing, shortcuts (no caps), shift: 0x38+8, others: [US ANSI table]}`. Cocoa matches Cmd shortcuts through
    the layout's Cmd-key fallback, so kVK_ANSI_C + Cmd is Copy on a Russian layout.
  - TIS and UCKeyTranslate must run **on the main thread**. Electron's main JS thread is the main thread.
  - Release with `CFRelease(src)` (Copy rule). `data` follows the Get rule, so don't release it.
- `keycode(code, down)`:
  1. `e = CGEventCreateKeyboardEvent(src, code-8, down)`.
  2. `CGEventSetFlags(e, flags)`, where `flags` is the OR of the modifiers Ember holds (Shift 0x20000, Control 0x40000,
     Option 0x80000, Command 0x100000), plus `kCGEventFlagMaskNumericPad 0x200000 | kCGEventFlagMaskSecondaryFn 0x800000`
     for arrows, and `SecondaryFn` for F-keys, Home/End/PgUp/PgDn and ForwardDelete, as hardware sends them.
  3. For a character key, **also** `CGEventKeyboardSetUnicodeString(e, ch.length, ch)` with the planned character.
     Apps that read `keyCode` and apps that read `characters` then agree, whatever flags or caps state the window server
     applies.
  4. `CGEventPost(0, e)`, `CFRelease(e)`.
  - Modifier keys are posted as plain keyboard events on their codes (the HID layer turns them into FlagsChanged), and
    the flags of later events carry them.
- Don't implement `textKey` on macOS. Keycode 0 + Unicode string makes keyCode readers see "A". The layout path is
  exact.
- `keysDown()`: codes 0…127 with `CGEventSourceKeyState(1 /* HIDSystemState */, c)` → `c+8`. Same namespace as held.
  Verify whether HIDSystemState includes posted events. Either way the borrow is correct, because held keys are
  filtered.
- `needsShift(sym)`: from `layout()` (`strokeFor(sym, typing).shift`). `keycodeOf(sym)`: the static table for named keys,
  else `strokeFor(sym, layout.typing ?? US)?.code`.

### 8.6 Takeover without Input Monitoring
- Polling: pointer vs expected, `keysDown()` minus held, buttons, as in §3.3.
- `watchUser`/`userInput`, optional: snapshot
  `CGEventSourceCounterForEventType(1 /* HIDSystemState */, 0xFFFFFFFF /* kCGAnyInputEventType */)` at each call.
  - If HIDSystemState counts hardware only, any increase is the user.
  - If it also counts posted events, subtract Ember's own post count since the last call. That is the XI2 `sent`
    pattern, but it includes moves, so it is noisy: only trust deltas larger than Ember's posts.
  - **Verify on macOS 13, 14 and 15 before enabling.** Fall back to polling only (`watchUser` returns false).
  - Quick taps between two 8 ms polls may then be missed (§3.5). The measured gate should still pass, because the eval
    "user" moves the pointer.

### 8.7 Windows, focus and activation
- AX can hang: call `AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)` once. Setting it on the
  system-wide element sets the global default; otherwise it is 6 s. Each AX call returns an `AXError` (int32); 0 is ok.
- `focusedWindow()`:
  1. `sys = AXUIElementCreateSystemWide()`.
  2. `AXUIElementCopyAttributeValue(sys, "AXFocusedApplication", out)`.
  3. `AXUIElementCopyAttributeValue(app, "AXFocusedWindow", out)`.
  4. `_AXUIElementGetWindow(win, wid=[0])`. This is private HIServices API, used by yabai, AltTab and Rectangle:
     `ax.func("int _AXUIElementGetWindow(void *el, _Out_ uint32_t *wid)")`.

  Fallback without AX: the first entry of `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly 1 |
  kCGWindowListExcludeDesktopElements 16, 0)` with `kCGWindowLayer == 0`. The key window of the active app is
  frontmost at layer 0. Called once per typed character, so keep it cheap.
- `activeWindow()` = `focusedWindow()`.
- `findWindow(title, pid)`:
  - Take titles from AX (`AXWindows` of `AXUIElementCreateApplication(pid)` → `AXTitle`), not from `kCGWindowName`.
    **`kCGWindowName` is empty without Screen Recording permission (10.15+).** Map AX windows to CGWindowID with
    `_AXUIElementGetWindow`.
  - Same uniqueness rules as input.ts:358-374.
- `activate(wid)`:
  1. `pid` = `kCGWindowOwnerPID` of `wid`. `app = AXUIElementCreateApplication(pid)`.
  2. `AXUIElementSetAttributeValue(app, "AXFrontmost", kCFBooleanTrue)`.
  3. Find the AX window with that wid: `AXUIElementPerformAction(w, "AXRaise")` and
     `AXUIElementSetAttributeValue(w, "AXMain", kCFBooleanTrue)`.
  - On macOS 14+ (cooperative activation) this may be refused or land on another Space. The borrow's
    `focusedWindow()` poll then fails with "didn't come to the front", which is the correct safe outcome. If it proves
    unreliable, consider SkyLight's private `_SLPSSetFrontProcessWithOptions` (AltTab's approach). Treat that as a
    risk item.
- Ember's own windows: don't use AX. Use `app.focus({ steal: true })` (FocusOptions.steal, @platform darwin) and
  `win.focus()`. `focusInput` = the same.
- `pointerOn(window, elementWindow)`:
  - Walk `CGWindowListCopyWindowInfo(OnScreenOnly|ExcludeDesktopElements, 0)` **front to back**. Skip windows of
    `process.pid`: Ember's overlay, handle and desk view are click-through while driving, but CG still lists them. Also
    skip alpha 0. Take the first window whose `kCGWindowBounds` contains the pointer.
  - Its number ∈ {window, elementWindow} → true.
  - Else same owner pid and `kCGWindowLayer == 101` (kCGPopUpMenuWindowLevel: menus and context menus) → true.
  - Else false.
  - `AXUIElementCopyElementAtPosition` is an accurate alternative but can hang; use it only with the 0.25 s timeout.
- `keyboardGrabbed(window)`:
  - `IsSecureEventInputEnabled()` (Carbon; `bool`). If true, read `CGSessionCopyCurrentDictionary()["kCGSSessionSecureInputPID"]`.
  - Return true only when that pid ≠ the target window's pid.
  - **Secure input left on by another app (Terminal's "Secure Keyboard Entry", some password managers) would otherwise
    block every click and scroll too.** `keyboardFree()` runs in click() and scroll().
- `screenLocked()`: `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]`, or `CGDisplayIsAsleep(CGMainDisplayID())`.
  Electron `powerMonitor.getSystemIdleState(1) === "locked"` as a fallback.
- `blockedReason()`: not trusted for Accessibility → "Ember needs permission to control the computer (System Settings →
  Privacy & Security → Accessibility)".
- `screenSize()`/`onScreen()`: `CGGetActiveDisplayList` + `CGDisplayBounds(id)`, which returns a `CGRect` by value
  (koffi struct `{origin: CGPoint, size: {width,height}}`, HFA of 4 doubles). Or use Electron `screen.getAllDisplays()`
  bounds, which are points.

---

## 9. Keyboard hold buffer, clipboard handoff, PRIMARY, hotkey chord on Windows and macOS

| Feature | Windows | macOS | What callers must tolerate |
|---|---|---|---|
| `holdKeyboard()` (ask box first letters) | **Not provided.** Return `null`. Focus moves almost at once after WM_HOTKEY, which gives foreground rights, and the box is pre-built (main.ts:1054). A `WH_KEYBOARD_LL` swallowing hook is possible but is a global input risk from JS. Don't. | **Not provided.** Return `null`. A swallowing CGEventTap needs Input Monitoring + Accessibility. | Already handled: `held` null → no `typed()` (main.ts:667-672). The user's very first letter may land in the previous app if typed within ~50 ms. |
| `handClipboardToManager()` | **Not needed.** Chromium writes real data with `SetClipboardData`, not delayed rendering, so it survives Ember's exit. Return `"no-manager"` (or a new `"not-needed"`). | **Not needed.** NSPasteboard data written by Chromium lives in pboard after quit. | Already handled: `emberXid` stays 0 off X11 (main.ts:1017), so the call is skipped. Gate explicitly on linux. |
| `readSelection()` (PRIMARY) | **No PRIMARY.** Return `""`. Selected text comes from UIA `TextPattern.GetSelection` in the sidecar if needed. **Never synthesize Ctrl+C**: it changes the clipboard and can trigger app actions. | **No PRIMARY.** Return `""`. Use AX `AXSelectedText` via the sidecar. | Already handled: `Perception.withSelection(c, "")`. |
| Hotkey chord (`freshAskPress` input) | `{control: GetAsyncKeyState(VK_CONTROL 0x11) & 0x8000, alt: GetAsyncKeyState(VK_MENU 0x12) & 0x8000}`. RegisterHotKey fires on press, so the chord is down. Returning `null` (trust + debounce) is acceptable. | `f = CGEventSourceFlagsState(1)`: control `f & 0x40000`, alt `f & 0x80000`. | `Chord` must grow (`{control, alt, shift?, meta?}`) if per-platform accelerators change (Ctrl+Alt+letter = AltGr on Windows; Ctrl+Option+… = VoiceOver keys on macOS). |
| `desk/keys.ts`, `agent-process.ts` | Linux only | Linux only | Gate the desk on linux (§4.4). |
| Clipboard password markers (affects paste via borrow) | Also honour `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`=0 and `Clipboard Viewer Ignore` | `org.nspasteboard.ConcealedType` / `TransientType` | `holdsPassword` (agent/clipboard.ts:59) only knows `x-kde-passwordManagerHint` today. |

---

## 10. koffi 3.2.1 cheat sheet (verified in node_modules/koffi: index.d.ts, doc/*.md, src)

| Need | Exact API |
|---|---|
| Load DLL / dylib / framework | `koffi.load(path, {lazy?, global?, deep?})`. Windows: LoadLibraryW, then LoadLibraryExW(SEARCH_DEFAULT_DIRS) (win32.cc:64-77). POSIX: dlopen(RTLD_NOW\|RTLD_LOCAL). macOS framework paths: `/System/Library/Frameworks/X.framework/X` |
| Declare | `lib.func("int __stdcall Name(int a, _Out_ T *b)")` or `lib.func("__stdcall", "Name", ret, [args])`. `__stdcall` is ignored off x86. `lib.stdcall()`/`lib.cdecl()` are **deprecated** |
| Variadic | declare with `...`, then pass `(type, value)` pairs: `f(fixed, "int32_t", 5, "double", 1.5)`. Cdecl only. No `.async`. Apple arm64 rules handled (abi/arm64.cc:58) |
| Out-params | `_Out_` / `_Inout_` in prototypes (or `koffi.out()`/`koffi.inout()`). Primitive out → one-element array `[0]`. Pointer out → `[null]`. Struct out → `{}`. Win32 `cbSize` structs → `_Inout_` with `{cbSize: koffi.sizeof(T)}` |
| Buffers | a `Buffer` or TypedArray passes as a pointer (in/out, no qualifier needed); read it back yourself |
| Struct by value (arg / return) | `koffi.struct("CGPoint", {x:"double", y:"double"})` → `lib.func("CGPoint CGEventGetLocation(void *e)")` returns `{x,y}`; `WindowFromPoint(POINT pt)` takes `{x,y}`. HFA return supported on arm64 (abi/arm64.cc:333-341) |
| Unions | `koffi.union({...})` inside a struct. Pass an object literal with **exactly one** member: `{u: {ki: {...}}}` (doc/composites.md "Win32 example" = SendInput) |
| Pointers | **BigInt**, or `null` for NULL (util.hh:447-458). Accepted as input: BigInt, Buffer/ArrayBuffer, number, null/undefined (util.hh:169-204) |
| Exported variable | `lib.symbol("name")` → BigInt address (the `type` 2nd argument is deprecated since 3.1). Read: `koffi.decode(addr, "void *")` (or `"int"`, …). Write: `koffi.encode(addr, type, value)` |
| Function pointer / COM vtable slot | `koffi.call(ptr, Proto, ...args)` or `const f = koffi.decode(ptr, Proto)`. Vtable: `vtbl = koffi.decode(obj, "void *")`, `fn = koffi.decode(vtbl, i * 8, "void *")`, then `koffi.call(fn, Proto, obj, ...)`. Protos via `koffi.proto("HRESULT __stdcall Name(void *self, ...)")` |
| Callbacks | `koffi.proto("int __stdcall EnumWindowsProc(void *h, intptr_t l)")`. Transient: pass a JS function to a `Proto *` parameter (valid only during the call). Registered: `const p = koffi.register(fn, koffi.pointer(Proto))` (or `"Proto *"`), then `koffi.unregister(p)`; max 8192. `register(this, fn, type)` is deprecated. Only cdecl/stdcall. Pointer arguments arrive as BigInt/null |
| Wide strings | `str16` / `const char16_t *` (UTF-16, input). Out: pass a `Buffer` and `buf.toString("utf16le", 0, 2*n)`, or `koffi.decode(buf, "char16_t", n)`. `wchar_t` is 2 bytes on Windows and 4 elsewhere |
| Decode helpers | `koffi.decode(ptr, [offset,] type [, len])`, `koffi.decode.uint32(ptr)`, `koffi.decode.string16(ptr, len)` … (3.1+) |
| Sizes | `koffi.sizeof(T)`, `koffi.offsetof(T, "m")`, `koffi.alignof`. INPUT must be 40 on x64 |
| Memory views | `koffi.view()` **throws inside Electron** (external buffers forbidden). Copy with `koffi.decode(ptr, "uint8_t", n)` as input.ts:157-171 does |
| errno | `koffi.errno()` (POSIX). **No GetLastError capture** in 3.2.1 |
| Packaging | koffi 3 ships natives in `@koromix/koffi-<os>-<arch>` optionalDependencies. Only `koffi-linux-x64` is installed here. Windows and mac builds must install `@koromix/koffi-win32-x64` (and arm64), `@koromix/koffi-darwin-arm64` and `-x64` (universal), and unpack them from asar |

---

## 11. Surprises and risks (ranked)

1. **macOS local-event suppression** (0.25 s after each posted event) disables the user's mouse while Ember glides,
   unless it is disabled on the source (§8.3). Without the fix, takeover is impossible.
2. **Zero keycodes on macOS.** `kVK_ANSI_A = 0` reads as "no key" in borrow.ts:266/282, main.ts:1265 and view.ts:353.
   Offset by 8.
3. **Negative coordinates** on Windows and macOS: `glideTo` refuses them (borrow.ts:321). The virtual-screen box also
   has dead zones. Add `onScreen`.
4. **UIPI.** Input to elevated windows vanishes without any error. Check elevation (`blockedReason`).
5. **Windows foreground lock.** `SetForegroundWindow` from the background fails without the empty-SendInput or
   AttachThreadInput tricks. `AllowSetForegroundWindow` is not a fix for this. Restore-focus depends on the same tricks.
6. **macOS Cmd semantics.** `parseCombo("cmd+s")` throws. The policy maps cmd to super and denies it. The worker sends
   `ctrl+a`/`ctrl+v`/`ctrl+End`/`ctrl+Home`/`ctrl+shift+F5`, which do nothing (or, in Terminal, send ^C/^V). Add a
   per-platform primary modifier and translation table.
7. **Ctrl+Alt is AltGr on Windows.** Injected Ctrl+Alt+letter types characters, and Ember's global Ctrl+Alt+E/M/N/Y
   accelerators steal €/µ/ń/… from every app. Ctrl+Option+… collides with VoiceOver on macOS.
8. **Own-window ids.** main.ts, ask.ts:123/224, view.ts:204 and overlay.ts:366 use `getNativeWindowHandle().readUInt32LE(0)`:
   an `NSView*` truncated to 32 bits on macOS. It must never reach `activate()`.
9. **Focus restore silently stops on Windows and macOS.** `mayRefocus` uses `shownWindows()` = `x11Ref.stack()`, which is
   empty without X11.
10. **AX can block the main thread for 6 s** on a hung app, and `focusedWindow()` runs once per typed character. Set the
    global messaging timeout to 0.25 s, with a CGWindowList fallback.
11. **Windows key-state traps.** The generic VK_SHIFT/CONTROL/MENU, VK_PACKET, injected numpad Enter, and VK_RMENU's
    synthetic LCtrl all cause false takeovers unless `keysDown()` is curated (§7.4).
12. **Swapped mouse buttons.** `SendInput` buttons and `GetAsyncKeyState` mouse VKs are physical; Ember's semantics are
    logical (`mask & 256` = primary in guide mode).
13. **macOS posted events are asynchronous.** `pointer()` can lag one 8 ms step, which looks like a takeover. Accept the
    previous `expected` too.
14. **`kCGWindowName` needs Screen Recording**, so `findWindow` must use AX titles. The `kAX…Attribute` names are macros:
    build CFStrings yourself.
15. **Desk and `$DISPLAY` gating.** `DeskManager.available()` can be true on a Mac with XQuartz.
    `process.env.DISPLAY` gating in main.ts (1048, 1017) can be true on macOS (XQuartz sets DISPLAY) and on Windows
    (VcXsrv). Gate on `process.platform`.
16. **Secure input on macOS** left on by another app would block clicks too (`keyboardFree` runs in click and scroll).
    Compare the secure-input pid with the target.
17. `CGEventCreateScrollWheelEvent2` is fixed-arity (the task brief called it variadic). `objc_msgSend` must never be
    declared variadic on arm64.
18. **Stuck keys after a crash** on Windows and macOS. Release everything in `process.on("exit")`.

---

## 12. Test plan
- **Unit:** keep `test/unit/borrow*.test.ts` passing unchanged; new members are optional. Add:
  - `onScreen` with negative coordinates;
  - `textKey` planning (no Shift, all-or-nothing preserved for non-ASCII);
  - the lagging-pointer tolerance;
  - `parseCombo` with `mod`/`cmd`/`option` per platform;
  - the keysym table round trip (every name in KEY_ALIASES, MODIFIERS, CHAR_NAMES and F1-F24 resolves on all three
    platforms, except Print/Pause/Menu/Insert on darwin);
  - a Windows `keysDown` curation test with fake GetAsyncKeyState (generic modifiers, VK_PACKET, RMENU→LCtrl);
  - a macOS layout builder test with a fake UCKeyTranslate (dead key → 0).
- **Integration on real CI runners** (windows-latest, macos-14). Port `eval/src/gates.ts` takeover/kill-switch:
  - "user" = a second process calling `SetCursorPos` (Windows) or posting from a separate CGEventSource (macOS).
  - Targets: takeover < 100 ms, kill switch < 300 ms.
  - Plus a Notepad / TextEdit round trip: click, `mod+a`, paste, `type("Hello, World!\n")`, read back via the sidecar.
  - Plus restore of focus to the previous window.
- **macOS CI needs Accessibility trust** for the test runner. GitHub's macOS images allow `tccutil`/TCC.db edits only
  with SIP considerations, so plan a self-hosted or pre-authorised runner, or skip injection gates there.
