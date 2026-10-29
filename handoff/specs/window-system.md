# Ember port spec: the X11 window-system surface and the overlay

Scope: `app/main/x11.ts`, `app/main/xshape.ts`, `app/main/overlay.ts`, `app/main/handle.ts`, `app/main/ask.ts`,
`app/main/follow.ts`, `app/main/windows.ts`, `app/main/desk/view.ts`, `app/main/perception/capture.ts`,
`app/main/perception/index.ts` (its X11 use), and every use of `x11Ref` / `x11` / `openX11` / `getNativeWindowHandle` /
`setInputShape` / `hasCompositor` in `app/main/main.ts`. I also traced the consumers that share the window-id domain
(`hands/input.ts`, `hands/borrow.ts`, `desk/place.ts`, `desk/agent.ts`, `agent/worker.ts`) where it matters.
Electron facts come from `node_modules/electron/electron.d.ts` (Electron 44.5.0). koffi is 3.2.1.

Line references are `file:line` in the repo at commit b67b02e.

---

## 0. TL;DR for the implementer

1. **Units matter more than anything else.** Every rectangle that `X11`, `Perception`, `captureRect` and the sidecar hand
   around is in *screen units*: X root pixels on Linux. Electron windows and the overlay work in *DIP*. Today the code
   converts between them by dividing or multiplying by `screen.getPrimaryDisplay().scaleFactor` (main.ts:1060, 1172-1178,
   1197, 1253). That is valid only because X11 has one global scale factor. On Windows (per-monitor DPI v2, so mixed
   scales give a non-linear DIP layout) it is wrong. On macOS it is wrong too (global points == DIP, so the factor
   must be 1). Put the conversion behind the platform layer.
2. **One window-id domain is shared** by the window system (`activeWindow().id`, `focusWindow().id`, `clientWindows()[].id`,
   `stack()[].client` / `.id`), the input backend (`XInput.activate/focusInput/findWindow/focusedWindow/activeWindow`) and
   Ember's own windows (`getNativeWindowHandle().readUInt32LE(0)`). These ids are compared with `===` in about 12
   places (§3). On Windows the domain is HWND. On macOS it is CGWindowID, **not** `getNativeWindowHandle()`, which is an
   `NSView*` there. Use `getMediaSourceId()` on macOS.
3. **The overlay already has a non-X click-through path.** When `setInputShape()` returns false, `OverlayManager`
   falls back to polling the cursor at 60 Hz with `setIgnoreMouseEvents` hover-to-interact (overlay.ts:209-231, 346-360).
   Windows and macOS start on that path. It has a known gap: a press that starts while the window is still click-through
   goes to the app underneath. Windows and macOS have no XShape-style input region that does not also clip drawing
   (`setShape` is win32/linux only and clips painting).
4. **No compositor problem on Windows or macOS** (DWM and Quartz are always on). The handle-card fallback and the 2 s
   compositor watch stay Linux-only.
5. **`hands` exists only when `x11` exists** (main.ts:1243 `const hands = x11 ? {...} : undefined`). Without a window
   system, Ember can't act at all. Gate it on the platform layer instead.
6. **`windows.ts:isTrustedSender` breaks on Windows** (path.sep is `\`, file URLs use `/`): every guarded settings IPC would
   throw "untrusted IPC sender".
7. **macOS surprises:** without Screen Recording permission, `CGWindowListCopyWindowInfo` omits other apps' window titles
   and `CGWindowListCreateImage` silently returns only the wallpaper and your own windows. Granting that permission
   requires relaunching the app. AX calls run on the Electron main thread and can block for seconds on a hung app.

---

## 1. Coordinate spaces and units

| Name | Linux (today) | Windows | macOS |
|---|---|---|---|
| **Screen units**: X11/Perception/capture/sidecar rects, `Capture.rect`, `X11.pointer()` | X root-window pixels (physical). Origin (0,0) is the root's top-left and is never negative. | Physical virtual-screen pixels as seen by a per-monitor-v2 DPI-aware process. Electron's main process is PMv2-aware, so `GetCursorPos`, `GetWindowRect`, `BitBlt` and `GetSystemMetrics(SM_*VIRTUALSCREEN)` already return these. Origin is the primary monitor's top-left. **Can be negative.** | CoreGraphics global display coordinates in **points**: origin at the top-left of the main (menu-bar) display, y down. Can be negative. Same space as `AXPosition`/`AXSize`, `kCGWindowBounds` and `CGEventGetLocation`. |
| **DIP**: Electron `screen`, `BrowserWindow` bounds, overlay/ask/handle/desk-view placement, `EmberState.focus/avoid`, `OverlayFrame` | physical ÷ `scaleFactor` (one global factor) | Chromium's ScreenWin layout. Each display has its own scale, and DIP origins are laid out so displays touch, which is **non-linear** across mixed-DPI monitors. | Points (identical to screen units) |
| **Window-local DIP**: overlay `interactive` rects | CSS px of the overlay page (renderer `getBoundingClientRect`, overlay/main.ts:380-385) | same | same |
| **Image px**: `Capture.width/height`, marks | (screen units − `rect.x/y`) × `Capture.scale` | same | same (fold the backing scale into `scale`, §8.4) |

Where the code converts today (all must go through the platform layer):

- main.ts:1056-1061 `cursor()`: `x11.pointer()` / primary `scaleFactor` → DIP for the overlay. Fallback `screen.getCursorScreenPoint()`.
- main.ts:1172-1178 `screenBounds()`: union of `display.bounds` (DIP) × primary `scaleFactor` → screen units for `Perception`.
- main.ts:1197, 1253 `flyTo`: screen-unit bounds ÷ `scale()` → DIP `EmberState.focus`.
- overlay.ts:213 + follow.ts:238-248 `shapeRects(rects, display.scaleFactor)`: window-local DIP → window-local physical for XShape.
  This one is per display and stays correct everywhere.

Electron conversion APIs (electron.d.ts:12204-12262):
- `screen.screenToDipPoint(p)` / `screen.dipToScreenPoint(p)`: **@platform win32,linux** ("Not currently supported on Wayland").
- `screen.screenToDipRect(win|null, r)` / `screen.dipToScreenRect(win|null, r)`: **@platform win32** only.
- `screen.getCursorScreenPoint()`: DIP, all platforms ("Not supported on Wayland"). It is stale on X11 after warps (x11.ts:57-61), which is why Ember polls `XQueryPointer`. It is fine on Windows and macOS but gives no button state.
- `Display.nativeOrigin`: "Only available on windowing systems like X11" (electron.d.ts Display).

---

## 2. The `X11` interface today (x11.ts)

`openX11(displayName?: string): X11 | null` (x11.ts:101-382). It loads `libX11.so.6` through koffi and opens **its own**
display connection (separate from Chromium's, from xshape's and from XInput's). It returns null when koffi or libX11
is missing or `XOpenDisplay` fails. Anything that throws during binding also gives null (x11.ts:379-381). It defines a
process-wide koffi struct `EmberXImage` once (x11.ts:106-111). Native memory is always **copied** with `koffi.decode`,
because `koffi.view()` creates an external ArrayBuffer that Electron's V8 memory cage forbids and the process aborts
(x11.ts:138-143). **The same rule applies to the Windows and macOS koffi backends.**

After `close()`: `hasCompositor` → `true` (so the 2 s watch never flips to the card during quit), `pointer`/`keysDown`/
`activeWindow`/`focusWindow`/`capture` → null, `clientWindows`/`stack` → `[]` (x11.ts:221, 226, 232, 244, 255, 277, 311, 347).

### 2.1 Types

```ts
interface X11Window { id: number; pid: number | null; title: string; x; y; width; height }   // x11.ts:9-18
interface Rect { x; y; width; height }                                                        // x11.ts:20
interface StackedWindow {                                                                     // x11.ts:23-42
  id: number;        // top-level: the WM's frame, or the app's own window when unreparented
  client: number;    // the app's window inside (first with WM_STATE, ≤3 levels deep, ≤64 per level); == id for menus/tooltips
  pid: number | null; title: string; wmClass: string;
  x; y; width; height;  // what it visibly covers: frame, or inner minus _GTK_FRAME_EXTENTS (CSD shadows)
  outer: Rect;       // inner + _NET_FRAME_EXTENTS (what GTK reports over AT-SPI); == frame when client == id or no extents
  inner: Rect;       // client window's own rect (what Chromium/Electron/Qt report over AT-SPI); == frame when client == id
  overrideRedirect: boolean;  // menus, tooltips, popups the WM doesn't manage
}
interface X11Image { x; y; width; height; bgra: Buffer }  // requested rect clipped to the screen; BGRA, stride = width*4 (x11.ts:44-52)
```

The `X11Window` doc says "Outer geometry", but `describe()` (x11.ts:168-179) returns **the given window's own** geometry:
`XGetGeometry` width/height plus `XTranslateCoordinates(id → root, 0, 0)`. For a reparented client that is the client
area without the WM frame. All callers use `X11Window` geometry only for identity (pid, title, class). The geometry
used for matching and masking comes from `stack()`.

`wmClass` = `WM_CLASS` with NULs replaced by spaces, trimmed: `"instance Class"`, e.g. `"gnome-terminal-server Gnome-terminal"`.
`wmClassName` (clientWindows only) = the class part (`parts[1] ?? parts[0]`), which may contain spaces (`"VirtualBox Manager"`).
These strings feed `isNeverLook({app, name})` (elements.ts:440-443, case-insensitive substring of `"${app} ${name}"`),
`isSecurityWindow({app,title})` (policy.ts:398-407; `SECURITY_APP` = polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|
^firewall-config$|gnome-shell) and `friendlyApp()` (shared/apps.ts:34-47). **What each platform puts in `wmClass` is
therefore a policy decision** (§9.6, §10.6).

### 2.2 Methods

| Method | Exact semantics | Units | Callers (and why) |
|---|---|---|---|
| `hasCompositor(screen = 0)` | `XGetSelectionOwner(_NET_WM_CM_S<screen>) != 0`. `true` when closed. | – | main.ts:195 (doctor check), 1051 (startup: overlay vs card, ask box opaque), 1100 (watch every 2 s; switches overlay↔card) |
| `pointer()` | `XQueryPointer(root)` → `{x: root_x, y: root_y, mask}`. `mask` = X modifier+button state: Button1Mask=256, Button2Mask=512, Button3Mask=1024, Button4/5=2048/4096. Low bits are modifiers (Shift 1, Lock 2, Control 4, Mod1 8…). | screen units | main.ts:1057-1060 (overlay cursor at 60 Hz: `x/scale`, `buttons = mask & 0x1f00`), main.ts:517 (handle menu waits for `(mask & 0x1f00) === 0` so the release doesn't pick "Ask Ember…") |
| `keysDown()` | `XQueryKeymap` + `XKeysymToKeycode`: `{control: Control_L(0xffe3)\|Control_R(0xffe4), alt: Alt_L(0xffe9)\|Alt_R(0xffea), space: 0x20}`. Either side counts. Keycodes don't shift with layout. | – | main.ts:1127 → `freshAskPress(chord, now, last)` (hotkey.ts:21-25): X re-reports a grabbed shortcut when the grab ends, so a callback counts only if Ctrl and Alt are really down and >300 ms after the last one. `space` is deliberately unused. |
| `activeWindow()` | `_NET_ACTIVE_WINDOW` on root (EWMH: the **client** window) → `describe(id)` + `wmClass`. null if 0 or the window vanished. | geometry: client rect, screen units | perception/index.ts:93 (`focused()`: is it Ember's (`pid === ownPid`)? Then read `{pid,title}`), :418 (fallback for the screenshot security check), main.ts:639 (captureContext: PRIMARY selection only from the same X client), :1255 (`hands.currentWindow`: task target `{pid,title}`, private → pid only), :1281 (`cursor.activeWindow` fallback), desk/agent-process.ts:211 (desk snapshot title) |
| `focusWindow()` | `XGetInputFocus`. None(0) or PointerRoot(1) → null. Otherwise walk up parents (≤20 hops) to the first window with a non-empty `_NET_WM_NAME`/`WM_NAME`, stopping below root → `describe` + `wmClass`. "Where typed keys go", whether or not a WM says so. Usually the client window. In odd trees it can be the top-level child of root (a frame). | as above | main.ts:418 (`focusNow()`: id + is-Ember, remembers `userWindow`), :508 (handle menu opens only once X says the handle has the keyboard), :626 (ask box `hasFocus`), :1281 (`cursor.activeWindow` primary), perception/index.ts:418 (no screenshots while a password prompt has the keyboard) |
| `clientWindows()` | `_NET_CLIENT_LIST` (all managed clients, **including minimized and other-workspace windows**, in mapping order, not stacking order). With no EWMH WM: root children with map_state IsViewable. Skips `_NET_WM_WINDOW_TYPE_DOCK/_DESKTOP`. Adds `wmClass` and `wmClassName`. | client rect | perception/index.ts:312 (`x11WindowLines`: the "Open windows:" list for quickContext and describe, which answers "what apps are open" without a sidecar round trip) |
| `stack()` | `XQueryTree(root)` children = **bottom-to-top** stacking order. Keeps viewable (map_state 2), not InputOnly (class 2), width>1 and height>1 (border included). Computes client, pid (client, else top), title and class (client), frame, inner, outer and seen as in §2.1. | screen units | perception/index.ts:248 (`stackNow`: HiDPI scale via `matchFrame`, `locate`, `coveringRects`, never-look pids by class, popup check in `atPoint`), :600 (`privateWindows`), main.ts:428 (`shownWindows()`: focus-back targets, `mayRefocus`, deskView `userFocus`), agent/worker.ts:3018 (desk only: `deskWindowAt`) |
| `capture(x, y, w, h)` | Clips to `[0, rootW) × [0, rootH)` after flooring, because XGetImage BadMatch would make Xlib's default error handler **exit the process**. Then `XSync`, `XGetImage(root, AllPlanes, ZPixmap)`. Requires 32 bpp, else null. Repacks rows to stride `w*4`. Returns `{x: x0, y: y0, width, height, bgra}`. Includes composited windows. null if `w<=0`, `h<=0` or nothing is on screen. | screen units in and out; 1 image px == 1 screen unit | perception/capture.ts:72 (every screenshot), desk/agent-process.ts:202 (desk snapshot, Linux-only) |
| `close()` | `XCloseDisplay` once. | – | main.ts:204 (doctor), :1062 (will-quit) |

`openX11` is called at main.ts:169 (doctor, only `if (process.env.DISPLAY)`), main.ts:1048 (whenReady, same guard), and
desk/agent-process.ts:182 (desk helper, on the Xvfb display). **The `process.env.DISPLAY` guard is not a platform test.**
XQuartz sets `DISPLAY` on macOS, and VcXsrv/WSLg users may have it set on Windows. Choose the backend with
`process.platform`.

### 2.3 The desk reuses the X11 interface remotely

`desk/agent.ts:252-260` `deskX11(agent)` is a **synchronous facade** of `X11` whose calls go to a helper process through
a worker relay (`Atomics.wait`, about 0.2 ms per call). `desk/place.ts:208-213` hands it to a second
`new Perception({ sidecar, x11, … })` (no `ownPid`, no `hideOverlay`). So **Perception must keep accepting an X11-shaped
object** (or the Linux backend must wrap any `X11` into the new interface). The desk stays Linux-only, but this Linux
code path has to survive the refactor unchanged.

---

## 3. How window ids flow (the invariants)

**Today's id domain is the X *client* window** (the window with WM_STATE, the one EWMH lists and activates):
- `activeWindow().id` = `_NET_ACTIVE_WINDOW` = a client window.
- `clientWindows()[].id` = `_NET_CLIENT_LIST` = client windows.
- `stack()[].client` = client, `stack()[].id` = frame (top-level).
- `focusWindow().id` = first titled ancestor of the focus window, which in practice is the client window.
- `XInput.findWindow/focusedWindow/activeWindow` (hands/input.ts:34-48, 346-389) return client windows.
  `XInput.activate(w)` sends `_NET_ACTIVE_WINDOW` (source "pager") for a client window. `focusInput(w)` = `XSetInputFocus`.
- Ember's own windows: `win.getNativeWindowHandle().readUInt32LE(0)`. Electron documents the native handle type as
  "`Window` (unsigned long) on Linux, `HWND` on Windows, `NSView*` on macOS" (electron.d.ts:5632-5637). On X11 this is
  Chromium's top-level X window. Chromium sets WM_NAME on it and the WM reparents it, so it is the client window of
  Ember's frame.

Where ids from different sources are compared (these must be the same domain on every platform):

| Site | Comparison |
|---|---|
| main.ts:417-422 `focusNow()` | `focusWindow().pid !== process.pid` → `userWindow = f.id`. Returns `{id, ember: pid === process.pid}` |
| main.ts:428-436 `giveFocusBack(back)` | `askWindow.isWindow(back)`. `shownWindows().some(w => w.client === back)` → `xinput.activate(back)`. Else apps (`pid !== process.pid`): `w.client === userWindow` or topmost app's `.client` |
| main.ts:500-508 `showMenu` | `xid = handle.win.getNativeWindowHandle().readUInt32LE(0)`. `hasKeyboard = focusSeen && win.isFocused() && (!x11Ref \|\| x11Ref.focusWindow()?.id === xid)`. `xinputRef.focusInput(xid)` (:523). `askWindow.isWindow(had.id)` (:476). `deskViewRef.isWindow(had.id)` (:479) |
| main.ts:234-239 `bringToFront` | `xinputRef.activate(getNativeWindowHandle().readUInt32LE(0))` |
| main.ts:622-627 AskWindow opts | `takeFocus(xid)` → `xinput.activate(xid)` + `focusInput(xid)`. `hasFocus = !x11Ref \|\| (askXid !== 0 && focusWindow()?.id === askXid)` |
| ask.ts:123, 223-225 | `reveal()` reads its own XID. `isWindow(xid)`: `getNativeWindowHandle().readUInt32LE(0) === xid` |
| desk/view.ts:202-205 | `isWindow(xid)` the same way |
| main.ts:639-640 | `readSelection({sameClientAs: activeWindow().id})`: X resource-id high bits identify the X client (clipboard-handoff.ts:106-127) |
| main.ts:1014-1018, 1029-1030 | `emberXid` from the first BrowserWindow, for `handClipboardToManager({ourWindow})` (Linux-only protocol) |
| main.ts:1215-1218 `mayRefocus` | `!askWindow.isWindow(w) && shownWindows().some(s => s.client === w \|\| s.id === w)`, where `w` = XInput's `previousWindow = x.activeWindow()` (borrow.ts:417, 439) |
| main.ts:1231-1235 deskView `userFocus` | `had.ember ? shownWindows().filter(w => w.pid !== process.pid).at(-1)?.client : had.id` |
| perception/index.ts:256-267 `locate` | `stack.findIndex(s => s.client === w.id \|\| s.id === w.id)` with `w = seen.x11Window` (= `activeWindow()`) |
| perception/index.ts:309-330 | `w.id === activeId` (clientWindows id vs `seen.x11Window?.id`) |
| borrow.ts:252, 422-425 | `x.focusedWindow() !== o.window`, `x.activate(o.window)` where `o.window` = `findWindow(...)` (worker.ts:2928) |

**pid comparisons with `process.pid`**: main.ts:420-421, 434, 640, 1233, 1257. `Perception.ownPid` (default `process.pid`,
index.ts:101-103) is used at :94 (focused → `ember: true`), :127 and :183 (sidecar `ownPid`), :318 (x11WindowLines filter),
:431 and :438 (`coveringRects(..., own)`), :573 and :607 (`listWindows({ownPid})`). Ember's windows are owned by the
Electron **browser (main) process** on every platform: `_NET_WM_PID` on X11, `GetWindowThreadProcessId` on Windows,
`kCGWindowOwnerPID` on macOS. So `process.pid` in main stays correct.

**Invariants the port must keep**
1. One `WindowId` domain (a JS number, 0 = none) across `activeWindow/focusWindow/clientWindows/stack().client`,
   the input backend's `activate/focusInput/findWindow/focusedWindow/activeWindow`, and `windowId(ownBrowserWindow)`.
2. `activeWindow().id ∈ {stack[i].client, stack[i].id}` for some `i` when the window is on screen (perception `locate`).
3. `clientWindows()[].id` is comparable with `activeWindow().id` (focused marker).
4. `focusWindow().id === windowId(win)` when Ember's `win` has the keyboard (handle menu, ask box gating).
5. `stack()[].pid` equals the pid the accessibility sidecar reports for the same window (`matchFrame` samePid,
   windows.ts:36-38). Otherwise only the exact title can match.

---

## 4. The overlay (overlay.ts)

### 4.1 Windows and lifecycle
- One `BrowserWindow` per display (`overlays: Map<displayId, Overlay>`, overlay.ts:22-34). Created in `create(display)`
  (overlay.ts:254-307) with `...display.bounds` (DIP), `transparent`, `frame:false`, `backgroundColor:#00000000`,
  `hasShadow:false`, not resizable, movable, minimizable, maximizable or fullscreenable, `focusable:false`,
  `skipTaskbar:true`, `alwaysOnTop:true`, `show:false`, **`type:"toolbar"`**, `title:"Ember overlay"` (the title is
  load-bearing: `OVERLAY_TITLE`, perception/windows.ts:93, makes `coveringRects` skip the overlay), and preload
  `overlay.cjs` with `sandbox`, `contextIsolation` and `backgroundThrottling:false`.
- Then `setAlwaysOnTop(true, "screen-saver")` (:282), `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})` (:283),
  `setIgnoreMouseEvents(true)` (:284).
- `did-finish-load` (:288-295): send `OVERLAY.init` + `OVERLAY.state`, then `showInactive()`, then `setBounds(display.bounds)`
  again ("some WMs adjust on first show").
- `revive(win, …)` (:298-304): a crashed renderer → `interactive=[]`, `clickThrough=true`, `shaped=false`,
  `setIgnoreMouseEvents(true)`, so an invisible window never swallows clicks. Reload uses backoff (revive.ts).
- `start()` (:64-72): create per display, listen for `display-added/removed/metrics-changed`. `tick()` every 16 ms.
  `raise()` every 2 s (`setAlwaysOnTop(true,"screen-saver")` + `moveTop()`, :315-321, because "shell surfaces can rise above us").
- `stop()` (:74-83): clear timers, unlisten, destroy windows, `closeInputShape()`.
- `onMetrics` (:56-62): `setBounds(d.bounds)` + re-send `OVERLAY.init`.
- `initFor(o)` (:238-243): `{displayId, bounds, settings, fallback:false, handle: avoid() if it intersects this display}`.

### 4.2 Click-through with hover-to-click
The renderer reports clickable rects in **window-local DIP** through `OVERLAY.interactive` (overlay/main.ts:380-385:
bubble buttons, task-card buttons or the whole scrolling stack, and Ember's body while it holds still and asks or works
beside a control). main.ts:931-934 validates them (≤32 rects, finite numbers) and calls `setInteractive(sender, rects)`
(:197-203) → `applyHits(o)`.

`applyHits(o)` (:209-231), the state machine:
```
rects = borrowing ? [] : o.interactive;  hit = rects.length > 0;  scale = display.scaleFactor || 1;  xid = xidOf(win)
if (hit && xid && setInputShape(xid, rects, scale)):        // X11 ShapeInput = exactly the rects (physical, window-local)
    if (o.clickThrough):
        win.setIgnoreMouseEvents(false); o.clickThrough = false
        setInputShape(xid, rects, scale)   // Electron's setIgnoreMouseEvents(false) resets the input region to the full window: re-apply
    o.shaped = true; return
o.shaped = false
if (!hit && !o.clickThrough): o.clickThrough = true; win.setIgnoreMouseEvents(true)
```
- Electron 44 implements `setIgnoreMouseEvents` on X11 with the input shape itself ("On X11 the X server has applied the
  window's new input shape when the call returns", electron.d.ts:6219-6227). That is why the re-apply order matters,
  and the unit test pins it: test/unit/overlay-shape.test.ts:123-140 expects `["open null","shape …","ignore false","shape …"]`.
- **xshape.ts `setInputShape(xid, rects, scale=1, display?)`** (xshape.ts:24-67): binds libX11 + libXext once (`lib`
  `undefined → bind() | null`). It keeps **one display connection open per display name** (`open` map, `""` = $DISPLAY),
  because per-call bind/open cost about 1 ms of main thread per frame. `shapeRects(rects, scale)` (follow.ts:238-248) rounds
  `x*scale`, `y*scale`, `w*scale`, `h*scale` and drops empty rects. `XShapeCombineRectangles(dpy, xid, ShapeInput=2, 0, 0,
  rects(int16 x,y; uint16 w,h), n, ShapeSet=0, Unsorted=0)`. n=0 gives an empty region (all clicks pass). Then
  **`XSync`** (a round trip, so a press right after lands on the new region, about 20 µs). It returns false with no xid,
  no lib, no display or on an exception. `closeInputShape()` (:70-73) closes the kept displays (OverlayManager.stop).
- With a shape, X itself routes presses: only the rects take clicks, everything else falls through, **at mousedown time**,
  with no polling race. Reports come every frame while Ember flies, so one shape request per report (test pins 45 reports
  → 45 shape requests, 0 opens and 0 ignores).
- **Hover fallback** (no shape: `o.shaped === false`; tick, :346-360):
  ```
  local = cursor − display.bounds.origin   (DIP)
  over  = !borrowing && takesPointer(!o.clickThrough, contains(display.bounds, cursor) ? local : null, o.interactive, cursor.buttons ?? 0)
  if (over === o.clickThrough) { o.clickThrough = !over; win.setIgnoreMouseEvents(!over) }
  ```
  `takesPointer(now, at, rects, buttons=0, pad=6)` (follow.ts:227-232): while **any button is held, nothing changes**, so a
  press that began on a button is released on it, and one that began on the app below is released there. Off-display →
  false. Once taking the pointer, rects grow by 6 px (hysteresis for buttons that shift). The known failure is stated in
  xshape.ts:1-5 and overlay.ts:349-351: a press that starts while still click-through goes through to the app below.
- **Borrowing** (`setBorrowing(on)`, :162-165): while Ember drives the user's mouse, rects are treated as `[]` → click-through,
  so Ember's own borrowed clicks never land on Ember. main.ts:1203-1213 also calls `handle.setClickThrough(driving)`
  (handle.ts:96-98 `setIgnoreMouseEvents(on)`) and `deskView.setDriving(driving)` (view.ts:120-124).
- `xidOf(win)` (:364-370) = `getNativeWindowHandle().readUInt32LE(0)`, or 0 on throw. On Windows that is the low 32 bits of
  the HWND (correct, because HWNDs are 32-bit significant). On macOS it is the low 32 bits of an `NSView*` (garbage, but harmless,
  since `setInputShape` fails at `koffi.load("libX11.so.6")` and returns false).

**Consequence:** unported, Windows and macOS already degrade to the hover fallback. The work is to make that fallback
good (§11.2), not to invent a new mechanism.

### 4.3 Frames, cursor, keep-off
- `tick()` (:323-361): `dt`. Every 1 s `checkHandle()` (re-send init when the handle moved). `cursor = this.cursor()` (DIP +
  `buttons`). `display = getDisplayNearestPoint(cursor)`. Reduced motion = `settings.reduceMotion || systemReducedMotion`.
  Ember steps aside from the settings window (`aside`) via `besideRect`, else `followTarget(cursor, size, workArea, keepOff())`.
  `frame = {ember, cursor, visible}` is sent only when something moved (≥0.25 px), or at least once per second.
- `this.cursor` is injected (constructor :48). The default is `screen.getCursorScreenPoint()` without buttons. main.ts injects
  `cursor()` (main.ts:1056-1061).
- `systemReducedMotion` comes from `gsettings get org.gnome.desktop.interface enable-animations` (main.ts:1077).
  **Cross-platform replacement:** `systemPreferences.getAnimationSettings().prefersReducedMotion` (electron.d.ts:14262-14272,
  no platform tag).
- `hideForCapture()` (:155-160): `setOpacity(0)` on every overlay, wait **60 ms** for the compositor, return a restore
  (`setOpacity(1)`).
- `keepOff()` (:184-194): handle bounds ∪ task-card rects (`OVERLAY.cards`, global DIP).

---

## 5. Handle, compositor fallback, ask box, desk view, home window

### 5.1 Handle (handle.ts) and the compositor fallback
- `new HandleWindow(settings, fallback)` (handle.ts:26-69). Pill 200×56 (`transparent`), or **card** 360×150 (opaque
  `#242022`) when `fallback`. Bottom-right of the primary `workArea` with a 12 px margin (`corner`, :104-107). Same flags as
  the overlay (`focusable:false`, `type:"toolbar"`, `alwaysOnTop`), then `setAlwaysOnTop(true,"screen-saver")` and
  `setVisibleOnAllWorkspaces(true)` (no options). On `did-finish-load` it sends init (`fallback` flag) and the last state,
  then `showInactive()`. `revive`. It repositions on `display-metrics-changed` and `display-removed`.
- `fit(height)` (:82-88): card only, clamped to 120..360, grows upward. Driven by `OVERLAY.handleFit` IPC (main.ts:958-960).
- `bounds` (:91-93) → `avoid` for overlay/ask box/desk view.
- main.ts:1086-1092 `makeHandle()`: `new HandleWindow(settings, !overlay)`, i.e. **card exactly when there is no overlay**.
- main.ts:1051-1053, 1093-1094: `compositing = x11 ? x11.hasCompositor() : false`. **Note: without X11 today this is
  `false`, so a non-X platform gets the card and no overlay.** That must change to `true` on Windows and macOS.
  `askWindow.setOpaque(!compositing)`. Overlay only when compositing, else log `overlay.fallback`.
- main.ts:1096-1117: `if (x11)` watch every 2 s. On change: `askWindow.setOpaque`, carry `keptHidden`, create or stop the
  overlay, `makeHandle()`, `askWindow.keepClear()`, `stepAside()`, `showBorrowing()`, `presenceChanged()`.
- Doctor (doctor.ts:55-59): `compositor: boolean | null`. Null means "No X display to check".

### 5.2 Ask box (ask.ts)
- `askBounds(near, workArea, keepOff)` (ask.ts:28-41), pure DIP math. Above Ember, or below it near the top, clear of the
  handle.
- `build()` (:87-116): `transparent: !opaque` (the opacity flag is fixed per window, so a compositor change rebuilds it,
  :147). `alwaysOnTop`, then `setAlwaysOnTop(true,"screen-saver")`, then `setIgnoreMouseEvents(true)` while hidden (:101).
  `blur` → `hide()` (:102). Rebuilt after a crash.
- `reveal()` (:118-125): `setIgnoreMouseEvents(false)`, `show()`, `focus()`, then
  **`takeFocus(getNativeWindowHandle().readUInt32LE(0))`** (main: XInput `activate` + `focusInput`, because a WM that
  prevents focus stealing would leave the keys with the user's app).
- `hide()` (:175-182): `hide()` + `setIgnoreMouseEvents(true)`. On X11 a hidden always-on-top box can stay mapped and
  steal a click.
- `hasKeyboard(ms=1200)` (:188-200): polls every **10 ms**:
  `visible && isFocused() && loaded && (o.hasFocus?.() ?? true)`, where `hasFocus` = `focusWindow().id === askXid`
  (main.ts:626). This means `focusWindow()` is called up to 120 times per open. Keep it cheap and non-blocking.
- `isWindow(xid)` (:223-225).

### 5.3 Desk view (desk/view.ts)
Linux-only feature (Xvfb desk). Its only window-system touchpoints: `isWindow(xid)` via `getNativeWindowHandle()`
(view.ts:202-205, called from main showMenu :479 on every platform, so it must return false cleanly), `setAlwaysOnTop(
true,"screen-saver")` (:146), `showInactive` (:151), `setIgnoreMouseEvents(on)` while driving (:120-124). It is constructed
unconditionally in main.ts:1225-1238 (registers ipcMain listeners), and that is fine on every platform. `DeskManager.available()`
(desk.ts:369) must report `ok:false` on Windows and macOS so `hands.desk` stays undefined (main.ts:1270).

### 5.4 Home window (windows.ts)
- `createHomeWindow()` has no X11 dependency.
- **Bug on Windows:** `isTrustedSender(url)` (windows.ts:31-33) =
  `url.startsWith("file://") && decodeURIComponent(url).includes(\`${path.sep}renderer${path.sep}\`)`. File URLs always use
  `/`. On Windows `path.sep === "\\"`, so this is always false, and `guard()` (main.ts:293-299) throws for every settings
  IPC. Fix: `new URL(url).pathname.includes("/renderer/")`, or `fileURLToPath(url)` and then compare segments with `path.sep`.

---

## 6. Capture flow and Perception's use of X11

### 6.1 `captureRect(x11, rect, opts)` (perception/capture.ts:68-96)
1. `show = await opts.hideOverlay?.()`. Perception shares one hide across concurrent captures (index.ts:548-569, ref-counted).
   main's `hideOverlay` (main.ts:1180-1185) sets the handle's opacity to 0, then `overlay.hideForCapture()` (all overlays'
   opacity 0 + 60 ms), or just waits 60 ms when there is no overlay. **The ask box and desk view are not hidden.**
2. `img = x11.capture(round(rect.x), round(rect.y), round(rect.w), round(rect.h))` inside `try`. **`finally show()`**:
   Ember reappears as soon as the pixels are taken, before masking and encoding.
3. `!img` → null.
4. `after = await opts.maskAfter?.()`. `null` → return null (**fail closed**: windows can move while the pixels are taken).
5. `origin = {img.x, img.y, img.width, img.height}` (clipped).
6. `rgba = bgraToRgba(img.bgra)` (swap B and R, **alpha forced to 255**, capture.ts:50-59).
7. For each mask (screen units) `maskRect(rgba, w, h, m − origin)` (floor/ceil, clamped, black + alpha 255, :61-66).
8. `scale = min(1, (maxSide ?? 1280) / max(img.w, img.h))`. `width/height = max(1, round(img.* × scale))`.
   `sharp(rgba, {raw:{w,h,channels:4}}).resize(width,height)`.
9. `svg = overlaySvg(scale, width, height, origin)` (set-of-marks). If present: PNG round trip, then `composite`.
10. Encode JPEG q78 (default) or PNG. Return `{rect: origin, data, mimeType, width, height, scale}` with the contract
    `image px = (screen px − rect.x|y) × scale`. `imageToScreen(c, p)` (:99-101) is the inverse.

sharp loads lazily (`requireCjs("sharp")`, :43-48). It needs a prebuilt for win32-x64 (and arm64) and darwin-x64/arm64 (packaging).

### 6.2 `perceive({image, scope, target})` (index.ts:403-493): the X11 calls in order
1. `stack = image ? stackNow() : undefined` (:405). One stack serves the scale, the covers and the private windows.
2. `seen = target ? read(target, null, stack) : focused(stack)` (:406).
3. `!this.o.x11` → no screenshot ("screenshots aren't available on this display") (:415-416).
4. `active = x11.focusWindow() ?? x11.activeWindow()`. If `isSecurityWindow({app: wmClass, title})` → no screenshot (:418-419).
5. `shellOverlays()` from the sidecar (GNOME Shell's own dialogs/notifications). `unchecked`, `dialog` or `overview` →
   no screenshot (:421-424). **Windows and macOS need equivalents** (§10.10, §11.9).
6. `rect = screenBounds()` (all displays, screen units). Window scope: `locate(seen, stack)` → `rect = at.rect`
   (`stack[i].{x,y,w,h}`, the visible frame). `covers = coveringRects(stack, at.index, rect, [pids], ownPid)` (:425-440).
   If ≤1% stays uncovered → no shot.
7. `mask = privateWindows(stack)` (:441, :593-619): never-look windows from the stack (by `wmClass`/title, whole `x,y,w,h`)
   ∪ the sidecar's `listWindows` matched back to the stack (else their own bounds scaled by the remembered k). Both
   failing → null → no shot.
8. Secret fields: the read's own (`n.secret`) + `unreadSecrets` (sidecar `secretFields`), padded 3 px (:447-458).
9. `captureRect(x11, rect, {mask, maskAfter, hideOverlay, overlaySvg})` (:461-489). `maskAfter` re-reads `stackNow()`,
   `privateWindows(now)`, `whereNow(secrets)`, re-scans secrets (fail closed), and in window scope `covering(now)`
   (null when the window left the stack → no picture).

`coveringRects(stack, index, rect, same, own)` (perception/windows.ts:103-112): every window above `index` hides what it
intersects, except (a) Ember's own overlay (`pid === own && title === "Ember overlay"`), and (b) override-redirect popups
of the target's own pids (its menus and tooltips are part of what the worker sees). Ember's other windows (handle,
desk view, ask box) **do** cover.

`matchFrame(axWindow, stack)` (windows.ts:29-53): skips `overrideRedirect`. Needs the same pid or the exact same title.
Tries `outer`, `inner` and `{x,y,w,h}`. Scale `k = o.width / b.width` must be ≈ the height ratio (5%), snapped to 1 within
5% or to a quarter step within 1%. The offset must be ≤ `8 + 4k` px. Cost prefers the same title. **Every window-scope
screenshot depends on this match** (`locate`, index.ts:258-260).

### 6.3 Other X11 uses in perception/index.ts
- `focused(stack?)` (:92-98): `activeWindow()`. `pid === ownPid` → `{ember:true}` with nothing read. Else `read({pid, title}, x11Window, stack)`.
- `read(...)` (:116-165): with a never-look list it uses `stackNow()` for `skipPids` (stack pids whose `wmClass` is on the
  list, :125-126). `matchFrame` → `isPrivate(match.window.wmClass, match.window.title)`, `isPrivate(x11Window.wmClass, x11Window.title)`
  (:137-141). `frameScale` (:225-242) caches k per pid for 30 s (5 s unmatched).
- `atPoint` (:174-186): `stackNow()` for skipPids, and to decide `menus` (an override-redirect popup of the target pid
  covers `p`).
- `quickContext` (:274-303) and `describe` (:349-371) → `x11WindowLines(activeId)` (:309-330) / `openWindows(activeId)`
  (:379-396). These use the X11 list when `this.o.x11` is set, else the sidecar's `listWindows`. The list filters `pid !== ownPid`,
  never-look by `wmClass + title`, `isSecurityWindow` on `wmClass`, on each word of it and on `wmClassName`. Lines read
  `- ${friendlyApp(wmClassName ?? last word of wmClass)}: ${title}`.
- `windows()` (:572-584): sidecar list + `stackNow()` to match, scale and drop private windows.
- `withSelection` (:337-346) is the X PRIMARY selection (main.ts:639-641 via `readSelection`). It is Linux-only. On Windows and macOS
  the UIA/AX `selection` field on the focused node already covers it.

---

## 7. main.ts inventory

| main.ts | What | Port action |
|---|---|---|
| 21 | `import { openX11 }` | import `openWindowSystem()` |
| 153, 169-170, 1048-1049 | `x11Reachable = DISPLAY ? !!x11 : undefined` → environment report | per-platform `ws.kind`/availability |
| 167-205 runDoctor | `openX11()` if DISPLAY, `compositor: x11 ? x11.hasCompositor() : null`, `xtest: x11 ? !!xin : null`, `x11?.close()` | ws + input backend. Win/mac compositor = true |
| 234-239 `bringToFront` | `show(); focus();` + `xinputRef.activate(xid)` | `ws.activate(ws.windowId(win))` (Win: foreground rules; mac: `app.focus({steal:true})`) |
| 405-422 `userWindow`, `askOver`, `deskTakenFrom`, `focusNow()` | `focusWindow()` id/pid | `ws.focusWindow()` |
| 428 `shownWindows()` | `stack().filter(title && w>1 && h>1)` | `ws.stack()` |
| 429-436 `giveFocusBack` | `.client` comparisons, `xinput.activate` | `ws.activate` |
| 438-524 `showMenu` | `setFocusable(true)`, own xid, `hasKeyboard` = Electron focus + `focusWindow().id === xid`, `released()` = `(pointer().mask & 0x1f00) === 0`, 10 ms poll × 2 steady, 250 ms then ≤1 s fallback, `xinput.focusInput(xid)`, `setFocusable(false)` in callback | `setFocusable` is **@platform darwin,win32** (electron.d.ts:6181-6187; a no-op on Linux in typings). `ws.focusWindow`, `ws.pointer().buttons`, `ws.focusInput?` |
| 620-627 AskWindow opts | `takeFocus` → `activate`+`focusInput`. `hasFocus` → `focusWindow().id === askXid` | `ws` |
| 636-641 `captureContext` | `activeWindow()`, `pid !== process.pid` → `readSelection({sameClientAs: id})` | Linux only. Win/mac skip |
| 658-679 `openAsk` | `askOver = focusNow().id` | – |
| 1014-1018, 1029-1030 | `emberXid` (if DISPLAY) for clipboard handoff | Linux only |
| 1051-1053 | `compositing = x11 ? hasCompositor() : false`, `askWindow.setOpaque(!compositing)` | `ws.hasCompositor()` |
| 1056-1061 `cursor()` | `pointer()` / primary scale, `buttons = mask & 0x1f00` | `ws.toDip(ws.pointer())` + buttons |
| 1062 | will-quit `x11.close()` | `ws.close()` |
| 1074-1084 `makeOverlay` | gsettings `enable-animations` → `systemReducedMotion` | `systemPreferences.getAnimationSettings().prefersReducedMotion` |
| 1093-1094 | overlay iff compositing | – |
| 1098-1117 | `if (x11)` 2 s compositor watch | `if (ws.compositorMayChange)` |
| 1124-1131 | Ctrl+Alt+Space → `x11Ref?.keysDown()` → `freshAskPress` | `ws.keysDown()` |
| 1169-1187 | `new Perception({x11, screenBounds, hideOverlay})` | `windows: ws`, `screenBounds: () => ws.screenBounds()` |
| 1197 | `scale()` = primary factor (used by flyTo) | `ws.rectToDip` |
| 1198-1199 | `xinput = x11 ? openXInput() : null` | input backend |
| 1215-1218 | borrow `mayRefocus` | – |
| 1229-1236 | deskView `userFocus` | – |
| 1243-1287 | **`hands = x11 ? {...} : undefined`**: `flyTo`, `currentWindow` (`activeWindow`), `cursor.activeWindow` (`focusWindow ?? activeWindow`) | `ws ? …` |

---

## 8. Proposed platform-neutral interface

Location: `app/main/platform/window-system.ts` (types), with `linux-x11.ts`, `win32.ts` and `darwin.ts` backends and
`openWindowSystem()` choosing by `process.platform`. Field names are **kept** (`wmClass`, `client`, `overrideRedirect`,
`X11Window` → `WindowInfo` alias) so `perception/windows.ts`, `desk/place.ts` and tests don't churn in the refactor
step. Their cross-platform meaning is documented instead.

```ts
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/** A window in the platform's own terms: X11 client XID | HWND value | CGWindowID. 0 = none. Same domain as the input backend's ids. */
export type WindowId = number;

/**
 * "Screen units" (see §1): X root pixels (linux-x11) | physical virtual-screen pixels, PMv2 (win32) |
 * CoreGraphics global points, top-left origin, y down (darwin). May be negative on win32/darwin.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** A window as one of the "who is this" queries reports it. Geometry is identity-only (§2.1). */
export interface WindowInfo extends Rect {
  id: WindowId;
  /** Owning process (Ember's own windows: process.pid of the main process). null only on X11 without _NET_WM_PID. */
  pid: number | null;
  title: string;
  /** What never-look, isSecurityWindow and friendlyApp see. X11: WM_CLASS "instance Class"; win32: "<exe base> <window class>"; darwin: "<bundle id> <app name>". */
  wmClass: string;
  /** clientWindows() only: the friendly part. X11: WM_CLASS class; win32: exe base name (or FileDescription); darwin: kCGWindowOwnerName. */
  wmClassName?: string;
}

export interface StackedWindow extends Rect {          // x/y/width/height: what it visibly covers
  id: WindowId;                                        // top-level (X11 frame); == client on win32/darwin
  client: WindowId;                                    // the id activate()/activeWindow() use
  pid: number | null;
  title: string;
  wmClass: string;
  /** Rect the toolkit's accessibility frame most likely reports. X11: client + _NET_FRAME_EXTENTS; win32: GetWindowRect (invisible resize borders included); darwin: kCGWindowBounds. */
  outer: Rect;
  /** The app's own area. X11: client window; win32: client area (GetClientRect + ClientToScreen); darwin: kCGWindowBounds. */
  inner: Rect;
  /** A popup the app opened (menu, dropdown list, tooltip): not a frame to match, and covers nothing of its own app. */
  overrideRedirect: boolean;
}

export interface ScreenImage {
  /** The requested rectangle clipped to the screen, in screen units. */
  x: number; y: number; width: number; height: number;
  /** Buffer size when it differs from width/height (darwin Retina at native resolution). Default: width/height. */
  pixelWidth?: number; pixelHeight?: number;
  /** BGRA, stride = (pixelWidth ?? width) * 4; alpha ignored. */
  bgra: Buffer;
}

export interface PointerState extends Point {
  /** Buttons held, in X's mask bits whatever the platform: 256 primary (logical left), 512 middle, 1024 secondary. Callers test `& 256` and `& 0x1f00` only. */
  mask: number;
}

/** What Perception needs (also satisfied by an adapter over the desk's remote X11 facade). */
export interface PerceptionWindows {
  activeWindow(): WindowInfo | null;
  focusWindow(): WindowInfo | null;
  clientWindows(): WindowInfo[];
  stack(): StackedWindow[];
  /** May be sync (X11, GDI, CG) or async (desktopCapturer): captureRect awaits it. */
  capture(x: number, y: number, width: number, height: number): ScreenImage | null | Promise<ScreenImage | null>;
  /** Optional: a system authentication surface is up or may be (GNOME Shell via sidecar today; win32 secure desktop; darwin SecurityAgent / secure input). true → no screenshot. */
  systemDialogOpen?(): boolean;
}

export interface WindowSystem extends PerceptionWindows {
  readonly kind: "x11" | "win32" | "darwin";
  /** Transparent windows render correctly. X11: _NET_WM_CM_S0 owned; win32/darwin: true. */
  hasCompositor(): boolean;
  /** Whether hasCompositor() can change at runtime (X11 only): main polls every 2 s only then. */
  readonly compositorMayChange: boolean;
  /** Pointer in screen units with X-compatible button mask; null when it can't be read (closed, secure desktop). */
  pointer(): PointerState | null;
  /** Modifier chord held now (X11 XQueryKeymap; win32 GetAsyncKeyState; darwin CGEventSourceFlagsState). null: can't tell. */
  keysDown(): { control: boolean; alt: boolean; space: boolean } | null;
  close(): void;

  // ── Ember's own windows ──
  /** Ember's BrowserWindow → WindowId (X11: native handle uint32; win32: HWND; darwin: CGWindowID from getMediaSourceId()). 0 if destroyed. */
  windowId(win: BrowserWindow): WindowId;
  /** Bring a window to the front with the keyboard (today XInput.activate: _NET_ACTIVE_WINDOW "pager"). Best effort. */
  activate(id: WindowId): void;
  /** Give one of Ember's own windows the keyboard directly where activate isn't enough (X11 XSetInputFocus). Optional. */
  focusInput?(id: WindowId): void;

  // ── Units ──
  toDip(p: Point): Point;            // screen units → DIP
  fromDip(p: Point): Point;          // DIP → screen units
  rectToDip(r: Rect): Rect;
  rectFromDip(r: Rect): Rect;
  /** All displays' union in screen units (Perception.screenBounds). */
  screenBounds(): Rect;

  // ── Overlay click-through ──
  /**
   * Restrict `win`'s input to `rects` (window-local DIP; `scale` = its display's scaleFactor). true only when the
   * platform has a real input region (X11 XShape). false → OverlayManager uses hover-to-interact.
   */
  setInputRegion(win: BrowserWindow, rects: readonly Rect[], scale: number): boolean;
  /** Release whatever setInputRegion keeps open (OverlayManager.stop). */
  releaseInputRegions(): void;
  /** Extra constructor options + post-create calls for Ember's floating windows. */
  floating(kind: "overlay" | "handle" | "ask" | "desk-view"): {
    options: Partial<BrowserWindowConstructorOptions>;
    /** setAlwaysOnTop level, setVisibleOnAllWorkspaces options, setIgnoreMouseEvents forward flag, etc. */
    after(win: BrowserWindow): void;
    /** setIgnoreMouseEvents(true, { forward }) for this kind. */
    forward: boolean;
  };
}

export function openWindowSystem(o: { log: Logger }): WindowSystem | null;   // by process.platform; never by $DISPLAY
```

### 8.1 Changes to callers (minimal)
- `PerceptionOptions.x11: X11 | null` → `windows: PerceptionWindows | null`. Rename `x11Window` → `window2`/`platformWindow`
  only if desired. `Seen.x11Window` is consumed only inside index.ts, so keep the name in the first pass.
- `captureRect(x11, …)` → `captureRect(windows, …)`. `img = await windows.capture(...)` **inside the try**, so `show()`
  still runs after the pixels are in. Tests pass sync fakes, and `await` keeps them working.
- `captureRect` with `pixelWidth`: let `kx = pixelWidth / width` (and `ky`). Mask rects become `(m − origin) × k` in
  buffer pixels. `scale = min(1, maxSide / max(pixelW, pixelH)) × k` (image px per screen unit). Output size =
  `round(pixelW × scale / k)`. Keep `rect: origin` in screen units. `imageToScreen` stays as is.
- `OverlayManager`: inject `ws` (or the three overlay methods). Replace `setInputShape(xidOf(win), …)` with
  `ws.setInputRegion(win, rects, scale)`, `closeInputShape()` with `ws.releaseInputRegions()`, and every
  `setIgnoreMouseEvents(true)` with `setIgnoreMouseEvents(true, { forward })` (the `forward` option is
  **@platform darwin,win32**, electron.d.ts:22243-22253, and ignored on Linux. Test logs stay identical).
- `AskWindow`/`DeskView`: replace `getNativeWindowHandle().readUInt32LE(0)` with an injected `windowId(win)`.
  (ask-window.test.ts:36 and desk-view tests stub `getNativeWindowHandle`, so keep that as the Linux implementation.)
- `HandleWindow`, `OverlayManager.create`, `AskWindow.build`: spread `ws.floating(kind).options` and call `after(win)`.
- main.ts: `hands = ws && input ? {...} : undefined`. `flyTo` → `ws.rectToDip(b)`. `screenBounds` → `ws.screenBounds()`.
  `cursor` → `{...ws.toDip(p), buttons: p.mask & 0x1f00}`.
- `perception/windows.ts`: `coveringRects` should also skip by **id** (pass the overlay ids `overlay.windowIds()` as a
  set), not only by `title === "Ember overlay"`. On macOS without Screen Recording permission even titles can be empty
  (own windows usually keep theirs, but don't depend on it).

### 8.2 Linux backend (adapter, no behaviour change)
`x11WindowSystem(x11: X11, xinput: () => XInput | null)` wraps today's objects one-to-one:
`pointer()` → `x11.pointer()`, `windowId(win)` → `getNativeWindowHandle().readUInt32LE(0)`, `activate/focusInput` → XInput,
`setInputRegion(win, rects, scale)` → `setInputShape(windowId(win), rects, scale)`, `releaseInputRegions` →
`closeInputShape`, `toDip(p)` = `p / primary.scaleFactor` (main.ts:1060), `screenBounds` = main.ts:1172-1178,
`floating()` = today's options (`type:"toolbar"`, `"screen-saver"`, `{visibleOnFullScreen:true}`), `forward:false`,
`compositorMayChange: true`. The desk's `Perception` gets `x11WindowSystem(deskX11(agent), …)`, or keep
`PerceptionWindows` satisfied directly by the `X11` facade, which already has the right method shapes.

---

## 9. Windows backend (koffi + user32/dwmapi/gdi32/kernel32)

General koffi notes:
- `koffi.load("user32.dll")`, `"gdi32.dll"`, `"dwmapi.dll"`, `"kernel32.dll"`. On x64/arm64 there is one calling convention
  (`__stdcall` is accepted and ignored. `lib.stdcall` is deprecated in koffi 3).
- Declare `HWND`/`HDC`/`HANDLE` parameters as **`intptr_t`** (or `uintptr_t`) so plain JS numbers pass. Koffi doesn't turn
  a Number into `void *`. Wrap results with `Number(...)`, since 64-bit integers can come back as BigInt.
  HWNDs are 32-bit significant (shared with WOW64), so `Number` is exact.
- Use `-W` (UTF-16) entry points. Decode with `Buffer.from(koffi.decode(buf, "uint16_t", n)).toString("utf16le")` or pass
  a `Buffer` and read `buf.toString("utf16le", 0, n*2)`.
- **Never** `SendMessage` to other processes' windows on the main thread (`WM_GETTEXT` hangs on a hung app). `GetWindowTextW` on
  another process's window reads the system-stored caption without sending a message, so it is safe.
- For `EnumWindows`, a *transient* koffi callback (`koffi.proto("bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lp)")`)
  is valid for the duration of the call (koffi/doc/callbacks.md "Transient callbacks").
- Electron's main process is per-monitor-v2 DPI aware, so every coordinate below is physical. **The UIA sidecar must call
  `SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4)` on every UIA thread before its first call
  (or `SetProcessDpiAwarenessContext`).** Otherwise UIA virtualizes BoundingRectangle and `matchFrame` sees k ≠ 1 (and
  wrong k on mixed DPI).

### 9.1 hasCompositor / compositorMayChange
`DwmIsCompositionEnabled(_Out_ BOOL*)` is always TRUE on Windows 8+ (RDP included). Return `true`. `compositorMayChange = false`.

### 9.2 pointer()
`GetCursorPos(_Out_ POINT*)` (`POINT {int32 x, y}`) gives physical screen units. A FALSE return (secure desktop, locked) → null.
Buttons: `GetAsyncKeyState(vk) & 0x8000` for `VK_LBUTTON 0x01`, `VK_RBUTTON 0x02` and `VK_MBUTTON 0x04`. These are **physical** buttons
(per MS docs). If `GetSystemMetrics(SM_SWAPBUTTON = 23)` is set, swap left and right so 256 = logical primary, which is what
worker.ts:1291-1300 (guide mode "user clicked") and borrow.ts:232 expect. XBUTTON1/2 have no X mask bit, so leave them out.
`screen.getCursorScreenPoint()` is accurate on Windows. It could serve as the DIP fallback, but it has no buttons.

### 9.3 keysDown()
`GetAsyncKeyState`: control = `VK_LCONTROL 0xA2 | VK_RCONTROL 0xA3`, alt = `VK_LMENU 0xA4 | VK_RMENU 0xA5`,
space = `VK_SPACE 0x20` (high bit). AltGr generates LCtrl+RAlt, so it reads as Ctrl+Alt. Electron's `globalShortcut` on
Windows is `RegisterHotKey` (fires once on press, with no grab-end re-report), so the debounce is harmless.
*Hotkey owner note:* Ctrl+Alt+<letter> is AltGr+<letter> on many European layouts (e.g. Polish AltGr+X = ź), and
`RegisterHotKey` steals it.

### 9.4 describe(hwnd) (shared helper)
- `GetWindowThreadProcessId(hwnd, _Out_ uint32*)` → pid.
- Title: `GetWindowTextLengthW` + `GetWindowTextW(hwnd, buf, n+1)`.
- Visible frame: `DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS = 9, _Out_ RECT*, 16)`. Fall back to `GetWindowRect`.
  `RECT {int32 left, top, right, bottom}`.
- Class: `GetClassNameW(hwnd, buf, 256)`.
- Exe: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, 0, pid)` → `QueryFullProcessImageNameW(h, 0, buf, _Inout_ uint32* size)`
  → `CloseHandle`. Basename without `.exe`. Cache by pid (short TTL. Optionally key on `GetProcessTimes` creation time
  against pid reuse). This works for elevated processes except protected ones (then exe = "").
- `wmClass = \`${exeBase} ${className}\``, e.g. `"notepad Notepad"`, `"chrome Chrome_WidgetWin_1"`, `"Code Chrome_WidgetWin_1"`.
  `wmClassName = exeBase`, or `GetFileVersionInfoW` FileDescription for nicer names ("Visual Studio Code"). Note that
  `friendlyApp("notepad.exe")` would not be capitalised, so strip `.exe`.
- **UWP:** top-level class `ApplicationFrameWindow` belongs to `ApplicationFrameHost.exe`. The real app is the child
  `Windows.UI.Core.CoreWindow` (`FindWindowExW(hwnd, 0, "Windows.UI.Core.CoreWindow", null)`, owned by e.g. `CalculatorApp.exe`).
  Keep `pid` = the **top-level's** pid (so it equals UIA's top-level ProcessId; the sidecar must use the same). Add the
  hosted exe to `wmClass` (`"ApplicationFrameHost CalculatorApp ApplicationFrameWindow"`) so never-look by app name works.

### 9.5 activeWindow() / focusWindow()
- activeWindow: `GetForegroundWindow()` (top-level HWND, the EWMH-active analogue). 0 → null. Else `describe`.
- focusWindow ("where typed keys go"): `fg = GetForegroundWindow()`, `tid = GetWindowThreadProcessId(fg, null)`,
  `GetGUIThreadInfo(tid, _Inout_ GUITHREADINFO*)`. Set `cbSize = 72` on 64-bit: `DWORD cbSize, flags; HWND hwndActive,
  hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; RECT rcCaret`, so `hwndFocus` is at offset 16.
  Then `GetAncestor(hwndFocus || hwndActive || fg, GA_ROOT = 2)` → `describe`. For Ember's own focused BrowserWindow this
  returns its top-level HWND, which equals `windowId(win)` (Chromium's focus is on a child `Chrome_RenderWidgetHostHWND`;
  GA_ROOT climbs out).
- Neither call sends messages or can hang.

### 9.6 clientWindows() ("what apps are open")
`EnumWindows` (Z order, top first). Keep the Alt+Tab set:
- `IsWindowVisible`.
- Not cloaked: `DwmGetWindowAttribute(DWMWA_CLOAKED = 14, _Out_ uint32*, 4) == 0`. This drops other virtual desktops'
  windows and suspended or hidden UWP frames. Otherwise "ghost" Settings and Calculator windows get listed.
- `GetWindow(hwnd, GW_OWNER = 4) == 0 || exStyle & WS_EX_APPWINDOW (0x40000)`.
- `!(exStyle & WS_EX_TOOLWINDOW (0x80))` unless WS_EX_APPWINDOW. Ember's own tool windows drop out here, and they are also
  filtered by pid upstream.
- Class not in `{Progman, WorkerW, Shell_TrayWnd, Shell_SecondaryTrayWnd}` (the DESKTOP/DOCK analogues).

Minimized (`IsIconic`) windows **are** listed, like `_NET_CLIENT_LIST`. Their geometry is the off-screen `-32000` position.
Use `GetWindowPlacement().rcNormalPosition` if geometry matters (it doesn't for the "Open windows" lines). Differences
from X11: windows on other virtual desktops aren't listed.

### 9.7 stack() (bottom → top)
`EnumWindows` → reverse. Keep `IsWindowVisible && !IsIconic && !cloaked`, with visible-frame width > 1 and height > 1.
**Also drop click-through windows** (`exStyle & WS_EX_TRANSPARENT (0x20)`). This is the analogue of X11's "InputOnly
covers nothing" and the overlay-title rule. Without it, invisible full-screen layered overlays (GPU vendor overlays,
recorders, menu `SysShadow` windows) count as covering the target, and every window-scope screenshot is refused as
"covered". Optionally also drop layered windows whose `GetLayeredWindowAttributes` alpha is 0.
Fields:
- `id = client = hwnd`. `pid`, `title` and `wmClass` from `describe`.
- `x/y/w/h` = `DWMWA_EXTENDED_FRAME_BOUNDS` (what it visibly covers).
- `outer` = `GetWindowRect`. Windows 10/11 include ~7 px (at 100%) invisible resize borders, and UIA's top-level
  BoundingRectangle is this rect. Small dialogs fail `matchFrame`'s 5% shape test without it.
- `inner` = `GetClientRect` + `ClientToScreen(hwnd, POINT{0,0})`.
- `overrideRedirect` (popup heuristic): class `#32768` (menus), `tooltips_class32`, `SysShadow`, or
  `(style & WS_POPUP (0x80000000)) && !(style & WS_CAPTION (0x00C00000)) && (owner != 0 || exStyle & WS_EX_TOOLWINDOW || exStyle & WS_EX_NOACTIVATE)`.
  Chromium/Electron menus and dropdowns are owned `WS_POPUP` tool windows, so they qualify.
- Includes Ember's own windows (coveringRects needs them) and the taskbar (topmost; it covers what it covers).

### 9.8 capture(x, y, w, h): GDI, synchronous, same contract as X11
1. Clip to the virtual screen: `GetSystemMetrics(SM_XVIRTUALSCREEN 76, SM_YVIRTUALSCREEN 77, SM_CXVIRTUALSCREEN 78,
   SM_CYVIRTUALSCREEN 79)`. **The origin can be negative. Do not copy X11's `Math.max(0, …)`.**
2. `hdcScreen = GetDC(0)`, `hdcMem = CreateCompatibleDC(hdcScreen)`.
3. `BITMAPINFOHEADER {biSize 40, biWidth w, biHeight -h (top-down), biPlanes 1, biBitCount 32, biCompression BI_RGB 0}`.
   `hbm = CreateDIBSection(hdcScreen, &bmi, DIB_RGB_COLORS 0, _Out_ void** bits, 0, 0)`.
4. `old = SelectObject(hdcMem, hbm)`. `BitBlt(hdcMem, 0, 0, w, h, hdcScreen, x0, y0, SRCCOPY 0x00CC0020)`. With DWM the
   screen DC is the composed desktop, layered windows included. `CAPTUREBLT (0x40000000)` is not needed and is known to
   make the cursor flicker. `GdiFlush()`.
5. Copy `w*h*4` bytes from `bits` with `koffi.decode` (BGRA, stride = w*4 at 32 bpp; the alpha byte is undefined, and
   `bgraToRgba` forces 255).
6. `SelectObject(old)`, `DeleteObject(hbm)`, `DeleteDC(hdcMem)`, `ReleaseDC(0, hdcScreen)`.
7. A `BitBlt` that returns 0 (secure desktop, locked workstation) → null. That fails closed.

Notes: HDR monitors give washed-out SDR-mapped pixels. DRM video shows as black. Windows with
`WDA_EXCLUDEFROMCAPTURE` are absent. Cost is about 10–40 ms for 4K on the main thread. A full-screen capture holds up the
60 Hz tick, which is acceptable for rare screenshots but matters with `forward` (§11.2). The alternative is
`desktopCapturer.getSources({types:["screen"], thumbnailSize})`: async, per display, slower, and the image size is "not
guaranteed". Treat it as a fallback only.

### 9.9 windowId / activate / focusInput
- `windowId(win)`: `const b = win.getNativeWindowHandle(); return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)`.
  (`readUInt32LE(0)` also works on Windows, but say what you mean.) `getMediaSourceId()` = `"window:<HWND>:0"`
  (electron.d.ts:5618-5626) is an equivalent alternative.
- `activate(id)`: `if (IsIconic(id)) ShowWindow(id, SW_RESTORE 9)`, then `SetForegroundWindow(id)`. Foreground-lock rules allow it
  when Ember's process received the last input: the hotkey (`RegisterHotKey` grants it), a click on the handle or overlay,
  or the menu. From a timer it fails and the taskbar flashes. Fallbacks, in order: `AllowSetForegroundWindow` doesn't help
  your own process. The documented-effective trick is a synthetic Alt tap (`SendInput` VK_MENU down/up) right before
  `SetForegroundWindow`, but it can toggle a menu bar in the target. `AttachThreadInput(fgTid, ownTid, TRUE)` +
  `SetForegroundWindow` + detach works but **hangs Ember's UI thread if the foreground thread is hung**, so avoid it on the
  main thread. Check the result with `GetForegroundWindow() === id`.
- `focusInput`: not needed (`win.focus()` sets focus within Ember's own thread once it is foreground). Leave it undefined.
- `BrowserWindow.setFocusable(true|false)` works on win32 (it toggles `WS_EX_NOACTIVATE`). *Verify* its side effects in
  Electron 44: it also toggles skip-taskbar. `type:"toolbar"` (`WS_EX_TOOLWINDOW`) keeps the handle out of the taskbar anyway.

### 9.10 Units
`toDip = screen.screenToDipPoint`, `fromDip = screen.dipToScreenPoint` (win32,linux). `rectToDip(r) = screen.screenToDipRect(null, r)`,
`rectFromDip(r) = screen.dipToScreenRect(null, r)` (win32 only). `screenBounds()` = the virtual screen metrics (§9.8), or the union
of `dipToScreenRect(null, d.bounds)`.

### 9.11 System dialogs (replacing GNOME `shellOverlays` for screenshots)
UAC (`consent.exe`) runs on the **secure desktop**. Ember can't see or capture it: BitBlt fails or returns black, and
`GetForegroundWindow` is 0. Fail closed: before capture, `OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS 0x0001)` +
`GetUserObjectInformationW(UOI_NAME 2)`. A name other than `"Default"` (`Winlogon`, `Screen-saver`), or failure to open →
`systemDialogOpen() = true`. Credential prompts on the normal desktop are `CredentialUIBroker.exe` windows (and Windows
Hello is `CredentialUIBroker`/`LogonUI`). Add those exe names to `SECURITY_APP` (policy owner) so `isSecurityWindow`
catches them via `wmClass`.

---

## 10. macOS backend (koffi + CoreGraphics/ApplicationServices/CoreFoundation)

Libraries: `/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics`,
`/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices` (AX* lives in HIServices, re-exported),
`/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation`, `libproc` (in `/usr/lib/libSystem.B.dylib`). koffi
supports struct-by-value returns (`CGPoint {double x,y}` from `CGEventGetLocation`, and `CGRect` arguments) on x64 and arm64.
**Screen units = points**, so every Win/Linux "physical" quantity is points here. `toDip` and `fromDip` are identity.

CF plumbing: create dictionary keys by value with `CFStringCreateWithCString(NULL, "kCGWindowNumber", kCFStringEncodingUTF8 = 0x08000100)`.
The exported `kCGWindow*` constants are CFSTRs with exactly those values, and CFDictionary compares with CFEqual.
`koffi`'s `lib.symbol(name)` can also reach exported constants such as `kCFBooleanTrue`. Use `CFArrayGetCount/GetValueAtIndex`,
`CFDictionaryGetValue`, `CFNumberGetValue(n, kCFNumberSInt64Type 4, _Out_ int64*)`, `CFStringGetCString` (UTF-8, 1024 buf) or
`CFStringGetLength` + `CFStringGetCharacters`, `CGRectMakeWithDictionaryRepresentation(dict, _Out_ CGRect*)`, and `CFRelease`
everything you Copy/Create.

**Threading hazard:** every `AXUIElementCopyAttributeValue` is a synchronous IPC to the target app on Electron's **main
thread**. The default messaging timeout is about 6 s for a hung app. Call `AXUIElementSetMessagingTimeout(systemWide, 0.25)` once,
which sets the global default, and keep AX out of hot paths. `focusWindow()` is polled every 10 ms by `showMenu` and
`AskWindow.hasKeyboard`, so short-circuit it with `BrowserWindow.getFocusedWindow()`: if one of Ember's windows is key,
return it without AX.

### 10.1 Permissions (TCC)
- **Accessibility**: `systemPreferences.isTrustedAccessibilityClient(prompt)` (electron.d.ts:14341-14347, darwin). Needed for
  AX focused window, `activate` of other apps' windows, and the AX sidecar. A child process spawned by Ember.app is attributed
  to the app ("responsible process"), so the `ELECTRON_RUN_AS_NODE` sidecar inherits the grant.
- **Screen Recording**: `systemPreferences.getMediaAccessStatus("screen")` (darwin and win32; on Windows always "granted",
  electron.d.ts:14295-14308). There is **no `askForMediaAccess("screen")`** (that is microphone/camera only, :14248). Use
  `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()` via koffi. **The grant takes effect only after the app
  relaunches.** Without it: `CGWindowListCopyWindowInfo` **omits `kCGWindowName` for other apps' windows** (owner name and pid
  stay), and `CGWindowListCreateImage` **succeeds** but contains only the wallpaper, the menu bar and your own windows. That is
  a silently wrong screenshot. So `capture()` must return null unless preflight is true. macOS 15 additionally re-prompts
  periodically ("…is requesting to bypass the system private window picker") for legacy-API and non-picker capture.

### 10.2 hasCompositor
Always `true`. `compositorMayChange = false`.

### 10.3 pointer()
`ev = CGEventCreate(NULL)`, `p = CGEventGetLocation(ev)` (global points, top-left origin; **not** NSEvent.mouseLocation, which
is bottom-left y-up), `CFRelease(ev)`. Buttons: `CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState 0,
kCGMouseButtonLeft 0 | Right 1 | Center 2)` → 256 / 1024 / 512 (logical). `screen.getCursorScreenPoint()` is equally good for
the position.

### 10.4 keysDown()
`flags = CGEventSourceFlagsState(0)`: control = `flags & kCGEventFlagMaskControl (0x40000)`, alt = `flags & kCGEventFlagMaskAlternate (0x80000)`.
space = `CGEventSourceKeyState(0, kVK_Space 0x31)`. *Verify* that key state reads work without Input Monitoring permission
(modifier flags do). *Hotkey owner note:* **Ctrl+Option is VoiceOver's VO modifier, and Ctrl+Option+Space is VoiceOver's
"activate"**, so Ember's Ctrl+Alt chords collide with VoiceOver on macOS.

### 10.5 activeWindow() / focusWindow()
1. If `BrowserWindow.getFocusedWindow()` is Ember's → `{id: windowId(win), pid: process.pid, title, wmClass: "<Ember bundle id> Ember", bounds}`.
   This is required for invariant 4 when the ask box or handle is a non-activating panel (§11.3): AX's frontmost app is then
   still the user's app.
2. AX (if trusted): `sys = AXUIElementCreateSystemWide()`, `AXUIElementCopyAttributeValue(sys, "AXFocusedApplication")` →
   `AXUIElementGetPid`, then `AXUIElementCopyAttributeValue(app, "AXFocusedWindow")` → `AXTitle`, `AXPosition`
   (`AXValueGetValue(v, kAXValueCGPointType 1, _Out_ CGPoint*)`) and `AXSize` (`kAXValueCGSizeType 2`). The id comes from
   **`_AXUIElementGetWindow(axWindow, _Out_ uint32*)`** (private HIServices SPI, stable for years and used by yabai,
   Hammerspoon and Rectangle). If the symbol is missing, match pid + bounds against `stack()`.
3. Fallback without AX: the first entry of `CGWindowListCopyWindowInfo(OnScreenOnly|ExcludeDesktopElements)` (the list is
   **front-to-back**) with `kCGWindowLayer == 0` and an owner other than Ember. Knowing the frontmost pid needs NSWorkspace
   (objc via `objc_msgSend` and koffi is possible but ugly).
`activeWindow` and `focusWindow` are the same on macOS (the key window of the active app), apart from step 1.

### 10.6 clientWindows()
`CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly 1 | kCGWindowListExcludeDesktopElements 16, kCGNullWindowID 0)`. Keep
`kCGWindowLayer == 0`, `kCGWindowAlpha > 0`, bounds ≥ 2×2, and owner not in {"Window Server", "Dock", "SystemUIServer",
"Control Center", "Notification Center", "WindowManager" (Stage Manager)}. Using `kCGWindowListOptionAll` to include minimized
and other-Space windows (`_NET_CLIENT_LIST` parity) brings in many invisible helper windows. If wanted, list those only
when they have a title. Titles need Screen Recording (§10.1). Without it the lines read `- Safari: (untitled)`. AX
`AXWindows` per app can fill titles if trusted, but that is costly (once per app).
`wmClass = \`${bundleId} ${kCGWindowOwnerName}\`` (e.g. `"com.apple.Safari Safari"`). `friendlyApp("com.apple.Safari")` → "Safari"
via its desktop-id rule. `wmClassName = kCGWindowOwnerName`. The bundle id comes from `proc_pidpath(pid, buf, 4096)` → path up
to `*.app` → `CFURLCreateFromFileSystemRepresentation` → `CFBundleCreate` → `CFBundleGetIdentifier`, cached per pid.
Security apps for `SECURITY_APP` (policy owner): `SecurityAgent`, `coreautha`, `UserNotificationCenter` (authorization dialogs).

### 10.7 stack()
Same `CGWindowListCopyWindowInfo(OnScreenOnly | ExcludeDesktopElements)` (front-to-back) → **reverse** to bottom-to-top.
On-screen-only excludes minimized and other-Space windows, which matches X11's "mapped". Skip `kCGWindowAlpha == 0` and
tiny windows. *Verify on a real Mac* that no transparent full-screen system window (Window Server, Control Center,
screenshot UI) survives the filter, because it would "cover" everything (the §9.7 problem).
- `id = client = kCGWindowNumber`. `pid = kCGWindowOwnerPID`. `title = kCGWindowName ?? ""`.
- `x/y/w/h = outer = inner = kCGWindowBounds` (points; includes the title bar, and equals AX `AXPosition`/`AXSize` of the
  AXWindow, so `matchFrame` gets k = 1).
- `overrideRedirect = kCGWindowLayer !== 0` (menus are 101 = kCGPopUpMenuWindowLevel, plus tooltips and popovers. An app's
  floating palettes at layer 3 also count, which is acceptable).
- Menu bar (layer 24/25) and Dock (layer 20) are real covering windows here. On X11/GNOME the top bar was not an X window.

### 10.8 capture()
Option A (synchronous, closest to X11): `CGWindowListCreateImage(CGRect rect, kCGWindowListOptionOnScreenOnly 1,
kCGNullWindowID 0, kCGWindowImageDefault 0)`. Pass `kCGWindowImageNominalResolution (1<<4)` to get 1 px per point. Then
`CGImageGetWidth/Height/BytesPerRow/BitsPerPixel` (expect 32 and `kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little`
= BGRA). `data = CGDataProviderCopyData(CGImageGetDataProvider(img))`, `CFDataGetBytePtr/Length` → copy with `koffi.decode`,
repack the stride (`bytesPerRow` is often padded, so reuse x11.ts:363-368), `CFRelease(data, img)`. Return `pixelWidth/Height`
when not nominal (Retina gives 2× points, and a capture spanning displays renders at the highest backing scale).
Clip to the union of display bounds (points; the origin may be negative). Bonus: `CGWindowListCreateImageFromArray(rect,
CFArray(all on-screen ids except Ember's))` excludes Ember's windows **without hiding the overlay**.
**Risk:** `CGWindowListCreateImage` and `CGDisplayCreateImage` are deprecated in macOS 14 and obsoleted in the macOS 15 SDK.
They are still exported at runtime (koffi resolves them dynamically) and work in 15, but Apple wants ScreenCaptureKit, so
plan for removal.
Option B (supported, async): `desktopCapturer.getSources({types:["screen"], thumbnailSize: {display.size × scaleFactor}})`
per display. Match `source.display_id` to `Display.id`, crop the rect from `thumbnail` (`toBitmap()` is BGRA on desktop
platforms: *verify*), and stitch across displays. It is slower (100–500 ms) and still needs Screen Recording. Recommendation:
A behind the interface with a preflight, and B as the fallback when the symbol lookup fails.
`setContentProtection(true)` (NSWindowSharingNone) hides a window from CG captures but **not** from ScreenCaptureKit on newer
macOS (electron.d.ts:6150-6161), so keep the opacity hide.

### 10.9 windowId / activate / focusInput
- `windowId(win)`: **`Number(win.getMediaSourceId().split(":")[1])`**. The format is `window:<CGWindowID>:<other>`
  (electron.d.ts:5618-5626). `getNativeWindowHandle()` is an `NSView*` (5632-5637) and must not be used as an id.
- `activate(id)`: for Ember's own windows, `win.focus()` + `app.focus({steal:true})` (Ember is an accessory app, so plain focus
  may not activate it). For another app's window: get its pid from `stack()`, `AXUIElementCreateApplication(pid)`,
  `AXUIElementSetAttributeValue(app, "AXFrontmost", kCFBooleanTrue)`, find its AX window whose `_AXUIElementGetWindow` equals
  `id`, then `AXUIElementPerformAction(w, "AXRaise")` (needs Accessibility). If the app is already frontmost and the window
  already key (the common case after a non-activating panel), do nothing.
- `focusInput`: undefined.

### 10.10 System dialogs
`SecurityAgent` authorization windows show up in `CGWindowList` with their owner name even without Screen Recording, so
treat any on-screen `SecurityAgent`/`coreautha` window as `systemDialogOpen() = true`. Also `IsSecureEventInputEnabled()`
(Carbon, HIToolbox) is true while any app has a secure text field focused (or Terminal's "Secure Keyboard Entry"). That is a
strong "password being typed" signal, so refuse screenshots while it is set.

---

## 11. Overlay, handle and ask box per platform

### 11.1 Electron 44 API availability (from electron.d.ts)

| API | Platforms | Notes |
|---|---|---|
| `setIgnoreMouseEvents(ignore, {forward})` | all; `forward` **darwin,win32** (22243-22253) | Linux: input shape. Windows: `WS_EX_TRANSPARENT|WS_EX_LAYERED`, and `forward` installs a process-wide `WH_MOUSE_LL` hook. macOS: `ignoresMouseEvents`, and `forward` uses an NSEvent mouse-moved monitor |
| `setShape(rects)` | **win32,linux**, @experimental (6320-6333) | Clips **drawing** and input together, so it is unusable for the full-screen overlay |
| `getMediaSourceId()` | all (5618-5626) | `window:<HWND|CGWindowID|XID>:<n>` |
| `getNativeWindowHandle()` | all (5632-5637) | HWND / **NSView*** / X Window |
| `setContentProtection(on)` | **darwin,win32** (6138-6161) | Win: `WDA_EXCLUDEFROMCAPTURE` (2004+; older → black), effective from the next composition. Mac: sharingType none, **not honoured by ScreenCaptureKit** |
| `setVisibleOnAllWorkspaces(v, {visibleOnFullScreen, skipTransformProcessType})` | **darwin,linux**, "does nothing on Windows" (6463-6470, 24467-24484) | Mac: each call transforms the process type (Dock icon hides and flickers) unless `skipTransformProcessType:true` |
| `setAlwaysOnTop(flag, level, relativeLevel)` | all except Wayland (6010-6016) | Levels are NSWindow levels on mac (`screen-saver` = 1000, above the menu bar and Dock). On Windows every level is `HWND_TOPMOST`; per Electron's implementation, `floating`…`status` sit behind the taskbar and `screen-saver` sits above it |
| `showInactive()`, `moveTop()` | all except Wayland | *Verify* that `moveTop()` on Windows mixed-DPI doesn't shift the window. If it does, use `SetWindowPos(HWND_TOPMOST, …, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)` via koffi |
| `setFocusable(f)` | **darwin,win32** (6181-6187) | "On macOS it does not remove the focus." On Linux the typings say unsupported, yet main.ts:495,500 calls it |
| `setOpacity(o)` | all (6273-6277) | Used by `hideForCapture`. *Verify* on Windows with `transparent:true` (Electron makes the window layered for alpha). Fallback: content protection or a brief `hide()` |
| `setHiddenInMissionControl(h)` / option `hiddenInMissionControl` | darwin (6205-6211) | overlay, handle |
| options `type` | Linux `toolbar`→`_NET_WM_WINDOW_TYPE_TOOLBAR`; Windows `toolbar`→`WS_EX_TOOLWINDOW`; macOS supports only `desktop`/`textured`/`panel` (`toolbar` ignored) | `panel` = non-activating NSPanel on all Spaces, above full-screen apps |
| option `acceptFirstMouse` | darwin, default false | **Must be true** for overlay and handle, or the first click on Allow only "activates" |
| option `focusable:false` | all | Win: also implies `skipTaskbar` (`WS_EX_NOACTIVATE`). Linux: "stops interacting with wm" |
| option `thickFrame` | win32, default true | Set **false** on overlay, handle and ask box (no resize border, snap or animations) |
| option `roundedCorners` | Win11 22000+, mac, Linux CSD; default **true** | Set **false** on the overlay (Win11 would round the full-screen window's corners and clip Ember there) and the handle |
| `transparent` | all; Windows "does not work unless the window is frameless" | OK (all are frameless) |
| `screen.screenToDipPoint/dipToScreenPoint` | win32,linux | §1 |
| `screen.screenToDipRect/dipToScreenRect` | **win32** | §1 |
| `desktopCapturer.getSources` | all (7714-7790) | macOS needs Screen Recording; thumbnails are not exactly the requested size |
| `systemPreferences.isTrustedAccessibilityClient(prompt)` | darwin (14341-14347) | |
| `systemPreferences.getMediaAccessStatus(type)` | darwin,win32 (14295-14308) | `'screen'` on Windows: always granted |
| `systemPreferences.askForMediaAccess(type)` | darwin, **microphone/camera only** (14248) | no screen |
| `systemPreferences.getAnimationSettings().prefersReducedMotion` | all (14262-14272) | replaces gsettings `enable-animations` |
| `app.setLoginItemSettings / getLoginItemSettings` | darwin,win32 (1779-1792, 1256-1283) | macOS `status` may be `requires-approval` (SMAppService) |

### 11.2 Click-through on Windows and macOS: hover-to-interact done well
There is no input region that doesn't also clip drawing: no XShape analogue. Chromium's transparent windows on Windows are
DirectComposition (`WS_EX_NOREDIRECTIONBITMAP`), so there is no per-pixel-alpha hit testing as with `UpdateLayeredWindow`.
On macOS, `ignoresMouseEvents` is all-or-nothing. `WM_NCHITTEST → HTTRANSPARENT` passes only to windows of the same thread,
and Chromium owns the WndProc anyway. So keep `setInputRegion → false` and make the existing fallback robust:
1. Keep main's 60 Hz `tick()` decision (`takesPointer` with real `buttons` from `ws.pointer()`, so "nothing changes while a
   button is held" works).
2. Always set `setIgnoreMouseEvents(true, { forward })`. On macOS `forward:true` is cheap and lets the renderer see hover. On
   **Windows, `forward:true` installs a `WH_MOUSE_LL` hook on Electron's UI thread**, so every mouse event system-wide then
   waits for Ember's main thread. Synchronous work there (GDI capture, the desk relay's `Atomics.wait`, sharp sync paths, koffi
   calls) adds mouse lag for **all** apps, and Windows silently removes hooks that exceed `LowLevelHooksTimeout`.
   Recommendation: `forward:false` on Windows (main polls anyway), and `forward:true` on macOS.
3. **Optional safety improvement**: the race (a press within ≤16 ms of arriving over a button goes to the app below) is a
   real safety issue when the app below has a button under Ember's "Allow". Mitigations: (a) a larger *entry* pad (e.g.
   12–16 px) when not yet taking the pointer, so the flip happens before the pointer reaches the button; (b) an extra
   renderer-driven fast path on macOS (forwarded `mousemove` → IPC "hover" → immediate flip); (c) Windows only, a dedicated
   low-level hook in a **separate thread or process** that swallows a primary-button press landing on an interactive rect
   while click-through, flips, and re-injects it. That is complex and should be the last resort.
4. Wheel over the task stack works only while the overlay takes the pointer, which the hover rects already cover
   (overlay/main.ts:185).
5. The revive path (overlay.ts:298-304) must also use `{ forward }`.

### 11.3 Window options per platform (`ws.floating(kind)`)

| | Linux (today) | Windows | macOS |
|---|---|---|---|
| overlay | `type:"toolbar"`, `focusable:false`, `alwaysOnTop` + `"screen-saver"`, `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})` | `type:"toolbar"`, `focusable:false`, `thickFrame:false`, `roundedCorners:false`, `"screen-saver"` (above the taskbar). `setVisibleOnAllWorkspaces` is a no-op. *Verify* virtual desktops: `WS_EX_TOOLWINDOW` windows are expected to show on every desktop. If not, re-show when `IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop` says no | `type:"panel"`, `acceptFirstMouse:true`, `hiddenInMissionControl:true`, `roundedCorners:false`, `focusable:false`, `"screen-saver"`, `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true, skipTransformProcessType:true})` and ship as `LSUIElement` (or call `app.dock.hide()`). *Verify* the window covers the menu-bar strip (else use `enableLargerThanScreen`) |
| handle | same as overlay but `transparent: !fallback` | as overlay. The menu flow (`setFocusable(true)` + `focus()` + wait for `focusWindow()===handle`) maps directly, and `TrackPopupMenu` needs the owner in the foreground | `panel` + `acceptFirstMouse`. A non-activating panel can pop an NSMenu with keyboard navigation without activating Ember. `hasKeyboard` is satisfied through §10.5 step 1. `giveFocusBack` is mostly a no-op |
| ask box | `alwaysOnTop` + `"screen-saver"`, focusable | `thickFrame:false`, `roundedCorners:false`. Focus from the hotkey or a click works (foreground rights) | `type:"panel"` (focusable) so it becomes key **without** activating Ember (Spotlight-like: the user's app stays active, so `blur` → hide still works). Otherwise `app.focus({steal:true})` |
| desk view | Linux-only | – | – |

Full-screen-overlay risk on Windows: a topmost borderless window exactly covering a monitor can make the shell think a
full-screen app is running (notifications suppressed by Focus Assist, auto-hide taskbar not revealing). *Verify*. If it
happens, size the overlay to `bounds` minus 1 px, or exclude it via `WS_EX_TOOLWINDOW`/no-activate (already set).

### 11.4 Hide for capture
Keep `setOpacity(0)` + 60 ms on all platforms (DWM and Quartz repaint well within 60 ms). On Windows, *verify* `setOpacity` on a
`transparent:true` window. Alternatives: `setContentProtection(true)` on the overlay and handle (Windows 10 2004+ removes
them from GDI/DXGI/WGC captures with no flicker, **but also from the user's own screen shares and screenshots**, which is a
product decision), or on macOS `CGWindowListCreateImageFromArray` without Ember's ids.

---

## 12. Risks and surprises (ranked)

1. **Window-scope screenshots hinge on `matchFrame` + `locate` + `coveringRects`.** Windows: invisible resize borders
   (put `GetWindowRect` in `outer`), PMv2 in the sidecar, UWP's ApplicationFrameHost pid, and click-through or cloaked
   full-screen windows that "cover" everything (§9.7). macOS: Dock and menu bar now cover, transparent system windows
   (verify), and titles missing without Screen Recording (pid matching still works).
2. **DIP math with the primary scale factor** (main.ts:1060, 1172-1178, 1197, 1253) is wrong on Windows mixed-DPI and on
   macOS. Route it through `ws.toDip`/`rectToDip`/`screenBounds`.
3. **macOS Screen Recording:** silent wallpaper-only captures, no window titles, relaunch needed after the grant. Preflight
   before every capture, otherwise fail closed.
4. **macOS AX on the main thread** can block for seconds. Set a messaging timeout and use the
   `BrowserWindow.getFocusedWindow()` shortcut in the 10 ms polls.
5. **Windows `forward:true` = global `WH_MOUSE_LL` hook on the UI thread** → system-wide mouse lag during sync work.
6. **Hover-to-interact race** (a press while click-through goes to the app below): a behaviour regression from X11's
   input shape, with safety implications for buttons under the bubble.
7. **`hands` undefined without x11** (main.ts:1243), and **`compositing` false without x11** (main.ts:1051) → card, no
   overlay. Both default to "nothing works" on a non-X platform.
8. **`getNativeWindowHandle()` is an NSView* on macOS.** `isWindow`/`windowId` must use `getMediaSourceId()`.
9. **`isTrustedSender` on Windows** (windows.ts:31-33) rejects every settings IPC.
10. **`$DISPLAY` used as a platform switch** (main.ts:169, 1017, 1048). XQuartz and VcXsrv set it.
11. **Capture origin can be negative** on Windows and macOS. Don't copy X11's clip-at-0. `maskRect` is buffer-relative and fine.
12. macOS `type:"toolbar"` is ignored. Without `panel` + `acceptFirstMouse`, clicking Allow activates Ember (focus leaves the
    user's app before Ember types into it) and the first click may only activate.
13. macOS `setVisibleOnAllWorkspaces` transforms the process type on every call (Dock flicker), and is called per overlay plus
    for the handle.
14. Windows foreground-lock: `activate()` from a timer fails. `AttachThreadInput` can hang the UI thread.
15. `CGWindowListCreateImage` is obsoleted in the macOS 15 SDK. It still works at runtime today, but plan the
    desktopCapturer/SCK fallback.
16. Linux-only pieces that must stay gated: XShape, the compositor watch, the PRIMARY selection (`readSelection`), clipboard
    handoff (`emberXid`), the desk (`deskX11` facade into `Perception`), the gsettings calls.
17. Hotkeys: Ctrl+Option+Space is VoiceOver's "activate" on macOS, and Ctrl+Alt+letter is AltGr+letter on Windows.

## 13. Tests to touch
- test/unit/overlay-shape.test.ts mocks koffi/libX11 and pins the shape → ignore → shape order. Keep it as the Linux backend
  test, and add a backend-agnostic test for the hover path (`setInputRegion` → false) asserting `ignore true` comes with
  `{forward}` per platform.
- test/unit/ask-window.test.ts:36 and desk-view tests stub `getNativeWindowHandle()`. Inject `windowId` instead, or keep
  the stub for Linux.
- test/unit/perception-capture.test.ts, perception-windows.test.ts:172 and private-windows pass sync fake `X11` objects as
  `x11:`. Keep `PerceptionWindows` structurally compatible (sync capture allowed) so they pass after a rename.
- test/unit/perception-x11.test.ts and test/integration/overlay-shape-live.test.ts are `DISPLAY`-gated (Linux CI only).
- New: Windows/macOS backend unit tests with fake koffi libraries (the overlay-shape test's `require.cache` trick works
  for any library name), plus smoke tests on real Windows/macOS CI runners for `stack()` ↔ sidecar `matchFrame`.
