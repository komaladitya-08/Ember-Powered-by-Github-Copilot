# Ember — research & architecture

> A cursor-companion agent that lives next to your mouse, talks with you, and does
> the work **inside your real applications** — visibly gliding the cursor, clicking,
> typing — while streaming its reasoning in a bubble under the cursor. The agentic loop is the **GitHub Copilot SDK**.

Research date: 2026-10-14.
**Platform order: Linux (RHEL 8 / 9 / 10, GNOME) → macOS → Windows.**

Facts marked *(verify)* were inferred from source code or binaries, not tested on real hardware.

**Dev machine: RHEL 8.4** (GNOME 3.32, glibc 2.28, system Python 3.6). Implications:
- Develop M0–M3 in the **"GNOME on Xorg"** session (gear icon on the login screen); check with
  `echo $XDG_SESSION_TYPE`. The default Wayland session is handled later in M4.
- The AT-SPI sidecar must run on the system `/usr/libexec/platform-python` / `python3` **3.6**
  (no 3.8+ syntax such as walrus or `dict | dict`).
- Package versions in §2 come from the latest RHEL 8 (8.10) sources; 8.4 may ship older
  xdg-desktop-portal / at-spi2 builds. This affects M4 only.
- CI images (Alma/Rocky 8) track 8.10, so run the smoke test on the real 8.4 box too.

---

## 1. What Ember must do

| # | Capability | What the user sees |
|---|---|---|
| 1 | **Do it for me** | Ember's agent cursor flies to targets; the real cursor follows a human-like path, clicks and types in real apps. Reasoning + current step stream in a bubble below it. |
| 2 | **Guide me** | Ember flies to the element, rings/highlights it with a label ("Click *Activities → Settings*"), waits for *you* to click, then points at the next step. |
| 3 | **Quick, in context** | You're already in an app; hold push-to-talk, say "make this a table". Ember grabs the focused window's accessibility tree + screenshot and acts immediately. |
| 4 | Talk to it | Push-to-talk voice (offline STT) or a small text box; optional spoken replies. |

Design rule: **no hidden shortcuts.** Every change goes through a real app the user can see
(the Copilot SDK's built-in shell/edit tools are disabled).

---

## 2. Linux platform reality (drives every decision)

| | RHEL 8 | RHEL 9 | RHEL 10 |
|---|---|---|---|
| GNOME | 3.32 (8.1+) | 40 | 47 (10.0–10.1), **49 (10.2)** |
| Default session | Wayland | Wayland | **Wayland only** |
| Xorg session | Supported | Deprecated | **Removed** (Xwayland only) |
| Falls back to Xorg | Yes on Matrox/Aspeed BMC (most rack servers), Hyper-V, vendor NVIDIA, `nomodeset` | NVIDIA < 470, hybrid laptops | Never |
| xdg-desktop-portal(-gnome) | 1.12 / gtk 1.12 | 1.12 / 41.2 | 1.20 / 47.3 |
| at-spi2-core / libei | 2.28 / — | 2.40 / — | 2.56 / 1.5 |
| Default terminal | gnome-terminal (VTE GTK3) | gnome-terminal | **Ptyxis** (VTE GTK4) |

What X11 gives us vs. what GNOME Wayland takes away:

| Capability | X11 (Xorg session) | GNOME Wayland |
|---|---|---|
| Global cursor position | `screen.getCursorScreenPoint()` | ✗ in Electron → Shell extension `global.get_pointer()` |
| Inject mouse/keys | XTest (robotjs) | Mutter private `RemoteDesktop` D-Bus (no prompt, all RHEL), Shell-extension Clutter virtual device, or portal RemoteDesktop (prompt; restore token only on RHEL 10) |
| Screenshot | XShm (`node-screenshots`) | Mutter `ScreenCast`/PipeWire, portal ScreenCast (prompt), `org.gnome.Shell.Screenshot` (caller-restricted on 9/10) |
| Always-on-top overlay | ✓ `_NET_WM_STATE_ABOVE` | ✗ native Wayland (no z-order, no layer-shell on GNOME) → Shell extension, or Electron under XWayland *(verify)* |
| Click-through overlay | ✓ XShape input region | Electron ≥ 43 sets `wl_surface` input region |
| Hold-to-talk key | `uiohook-napi` (XRecord) | ✗ (GlobalShortcuts portal needs xdp-gnome ≥ 48; not in any RHEL) → Shell extension |
| Accessibility tree | AT-SPI2, screen coords valid | AT-SPI2, **window-relative coords only** → add window frame rect from Shell extension |

Electron-on-Linux caveats (all versions): `setIgnoreMouseEvents({forward:true})` and
`setContentProtection` are **macOS/Windows only**. So the overlay toggles its own input
region from cursor polling, and hides itself (or is masked) during screenshots.

**Conclusion:** ship an **X11 backend first** (RHEL 8/9 Xorg sessions, servers, NVIDIA, VDI),
then a **GNOME Wayland backend built around a small GNOME Shell extension** (RHEL 8/9 Wayland,
and mandatory for RHEL 10).

### Runtime compatibility with RHEL 8 (glibc 2.28)

| Component | Requirement | RHEL 8? |
|---|---|---|
| `@github/copilot-sdk` 1.0.21 runtime (`linux-x64`) | max `GLIBC_2.28`, no libstdc++ (checked with `objdump`) | ✓ *(verify on 8.10)* |
| Electron 44.7.2 (latest stable) | max `GLIBC_2.25`, bundled libc++, GTK 3 | ✓ *(verify on 8.10)* |
| Node 22 / 24 | glibc ≥ 2.28 (built on RHEL 8) | ✓ (the next Node major after 26 needs glibc 2.34 → ✗) |
| Native addons (robotjs, uiohook-napi, node-screenshots) | must be built ≤ glibc 2.28 | Build in an Alma/Rocky 8 container; check with `objdump -T` |

Electron flags: Electron ≥ 38 runs native Wayland by default; pass `--ozone-platform=x11`
(on the command line) to force XWayland for the overlay. Electron ≥ 36 prefers GTK 4 on
GNOME; RHEL 8 has none, so it falls back to GTK 3 (or pass `--gtk-version=3`).

---

## 3. Recommended stack (Linux)

| Layer | X11 backend (v1) | GNOME Wayland backend (v2/v3) |
|---|---|---|
| App shell & overlay | **Electron 44 + TypeScript**: transparent, frameless, `alwaysOnTop('screen-saver')`, `setIgnoreMouseEvents(true)` + input-region toggling | **Ember GNOME Shell extension** draws the buddy, bubble and highlights in the compositor; Electron runs the brain and settings window. Fallback: Electron with `--ozone-platform=x11` |
| Agent loop | **`@github/copilot-sdk`** (pinned) | same |
| Accessibility tree | **AT-SPI2 via a Python sidecar** (`python3-gobject` + pyatspi, on every RHEL), JSON-RPC over stdio | same + window frame rects from the extension |
| Screenshot | `node-screenshots` (xcap, Apache-2.0) | Mutter ScreenCast → PipeWire; portal ScreenCast + restore token on RHEL 10 |
| Real cursor & keys | **robotjs 0.9.1** (XTest, MIT) + **ghost-cursor** `path()` | Mutter `RemoteDesktop` (`NotifyPointerMotionAbsolute`…) or the extension's Clutter virtual device; portal RemoteDesktop + libei on RHEL 10 |
| Cursor position | `screen.getCursorScreenPoint()` | extension `global.get_pointer()` |
| Push-to-talk | **uiohook-napi** (XRecord, key-up) | extension keybinding + modifier-mask polling |
| STT / TTS | **sherpa-onnx-node** (offline, streaming) / `speechSynthesis` | same |

Why Electron (not Tauri) still holds on Linux: a mature transparent overlay, `desktopCapturer`,
a native-addon ecosystem in TypeScript, and the same code base for the macOS/Windows ports.
On GNOME Wayland neither framework can draw a reliable overlay, so that part moves into the
Shell extension anyway.

---

## 4. Architecture

```
┌──────────────────────────────── Electron main process ─────────────────────────────────┐
│ AgentHost ── CopilotClient / CopilotSession (Copilot runtime child, stdio JSON-RPC)    │
│   • streaming events ──► Presenter (bubble: intent, reasoning, step "why")             │
│   • custom tools ──────► DesktopBackend                                                │
│   • onPreToolUse hook ─► SafetyGate (policy, confirmations, audit log)                 │
│                                                                                        │
│ DesktopBackend (chosen from XDG_SESSION_TYPE + GNOME version)                          │
│   ├─ X11Backend:      robotjs · node-screenshots · uiohook-napi · Electron overlay      │
│   ├─ GnomeWaylandBackend: Ember Shell extension (D-Bus) · Mutter RemoteDesktop/ScreenCast│
│   └─ (later) MacBackend · WindowsBackend                                               │
│                                                                                        │
│ A11ySidecar (python3 + pyatspi) ── JSON-RPC: tree, find, bounds, actions, text          │
│ VoiceProcess (utilityProcess): sherpa-onnx STT                                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
                 ▲ D-Bus (Wayland only)
┌────────────────┴──────────────────────────────┐
│ Ember GNOME Shell extension                    │  legacy imports.* build (GNOME 3.32/40)
│  overlay actors · get_pointer · keybindings    │  ESM build (GNOME 45+ / RHEL 10)
│  window frame rects · virtual input device     │  sender allow-list + on-screen indicator
└────────────────────────────────────────────────┘
```

### 4.1 Agent loop (Copilot SDK)

Copilot runs the loop: model → tool calls → our handlers → model … until `session.idle`.
Ember supplies the tools, the system prompt and the UI.

```ts
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";

const client = new CopilotClient();   // auth: `copilot login` once, or gitHubToken via an OAuth flow
await client.start();

const perceive = defineTool("perceive_screen", {
  description: "Numbered UI elements of the focused window (or all screens) plus a marked screenshot.",
  parameters: z.object({ scope: z.enum(["focused_window", "all_screens"]).default("focused_window") }),
  skipPermission: true,
  defer: "never",                     // keep core tools always loaded
  handler: async ({ scope }) => {
    const p = await desktop.perceive(scope);       // AT-SPI tree + screenshot (overlay hidden) + set-of-marks
    return {
      textResultForLlm: p.elementsAsText,          // "[12] push button 'Bold' (enabled)" ...
      binaryResultsForLlm: [{ type: "image", data: p.markedPngBase64, mimeType: "image/png", description: "screen with numbered marks" }],
      resultType: "success",
    };
  },
});

const session = await client.createSession({
  model: pickedModelId,               // from client.listModels(); must support vision
  streaming: true,
  tools: [perceive, clickElement, typeText, pressKeys, scroll, drag, openApp, focusWindow,
          pointAt, waitForUserClick, zoom],
  availableTools: EMBER_TOOL_NAMES,   // disable built-in shell/edit/view (verify name format vs SDK types)
  systemMessage: { mode: "customize", sections: {
    identity:          { action: "replace", content: EMBER_IDENTITY },
    code_change_rules: { action: "remove" },
    tool_instructions: { action: "append",  content: EMBER_TOOL_RULES },
  }},
  onPermissionRequest: (req) => safety.decide(req),   // never omit: a missing handler stalls the turn
  hooks: { onPreToolUse: (i) => safety.preToolUse(i) },
});

session.on("assistant.intent",          e => bubble.status(e.data.intent));
session.on("assistant.reasoning_delta", e => bubble.reason(e.data.deltaContent));
session.on("assistant.message_delta",   e => bubble.say(e.data.deltaContent));
session.on("tool.execution_start",      e => bubble.step(e.data.toolName, e.data.arguments));
session.on("tool.execution_complete",   e => bubble.stepDone(e.data.success));
session.on("session.idle",              () => bubble.idle());

// Quick mode: attach the focused window at hotkey time
await session.send({ prompt: transcript, attachments: [
  { type: "blob", data: snap.pngBase64, mimeType: "image/png", displayName: "focused-window.png" } ] });
```

SDK facts this relies on (`@github/copilot-sdk` 1.0.21):

- **Reasoning is streamable** (`assistant.reasoning_delta`, `assistant.intent`), but what you get
  depends on the model (OpenAI models give summaries; some Anthropic thinking arrives encrypted).
  The bubble always shows `intent` + each tool call's `why` argument, so it's useful either way.
- **Tools can return images** (`binaryResultsForLlm`). That's how the model sees the result of each action.
- **Stop & steer:** `session.abort()` + `invocation.signal` power the Esc kill switch;
  `send({mode:"immediate"})` steers mid-task.
- **Built-in tools are on by default** → restrict them, or the agent will quietly run shell commands.
- `sendAndWait` times out after 60 s by default → use events + `session.idle`.
- Every prompt uses the user's Copilot quota (BYOK is possible via `provider`).
- Packaging: ~148 MB per-platform runtime package plus the `koffi` native module (`asarUnpack`).
  If stdio breaks when bundled, run the runtime as a server and connect with `RuntimeConnection.forUri`.

### 4.2 Tool set

The model sees **screenshot pixels**; backends map them to physical/compositor coordinates.
Element-id tools are preferred; raw coordinates are the fallback.

| Tool | Purpose |
|---|---|
| `perceive_screen{scope}` | AT-SPI elements (id, role, name, value, states, bounds) + set-of-marks PNG |
| `click_element{id, button, double, why}` | Glide the real cursor → click → re-perceive and verify |
| `click_at{x, y, why}` | Coordinate fallback (canvas, poor a11y, remote-desktop viewers) |
| `type_text{text, why}` / `press_keys{keys[]}` | Real keyboard input with per-character jitter |
| `scroll` / `drag` / `zoom{region}` | |
| `open_app{name}` | Visibly: Super → type name → Enter (GNOME Activities search) |
| `focus_window{title}` | Bring a window forward |
| `point_at{id \| x,y, label}` | **Guide mode**: fly + highlight ring + label; no click |
| `wait_for_user_click{id, timeout}` | Guide mode: resolves when the user clicks inside the rectangle |
| `ask_user{question}` | Via the SDK's `onUserInputRequest`; the bubble becomes interactive |

Modes are system prompt + tool subsets: **Do** = all; **Guide** = perceive / point_at /
wait_for_user_click only; **Quick** = Do with the focused-window snapshot pre-attached.

### 4.3 Making actions visible

1. The overlay's **agent cursor** flies to the target with clicky's arc animation
   (bezier arc, smoothstep, scale pulse, tangent rotation), with the `why` text under it.
2. The **real cursor** follows a `ghost-cursor` path, stepped at ~120–240 Hz (robotjs on X11;
   Mutter `NotifyPointerMotionAbsolute` or a Clutter virtual device on Wayland), lands on a slightly
   random point inside the element, then clicks.
3. Click ripple, typing caption and keycap chips in the overlay.
4. After every action, re-read the tree/screenshot and verify (focus, value, new window).
5. Speed setting: calm demo ↔ fast.
6. **Overlay vs. screenshots on Linux:** no content protection exists, so the overlay draws
   nothing for one frame around each capture (as computer-use-linux does), or Ember paints out
   its known rectangle before sending the image.

### 4.4 Coordinate spaces (the top source of misclicks — test early)

| Space | Used by |
|---|---|
| Logical (DIP) | Electron `screen`, overlay CSS pixels, GNOME logical layout |
| Physical / compositor | XTest, Mutter RemoteDesktop stream coordinates, X11 AT-SPI screen extents |
| Window-relative | AT-SPI on Wayland (+ frame rect from the extension → global) |
| Screenshot pixels | What the model sees (downscaled to ~1280–1366 px wide) |

Store `{monitor, bounds, scale, imageW, imageH}` with every capture and convert from that record.
Test with fractional scaling and mixed-DPI dual monitors early.

### 4.5 Accessibility setup

- Enable `org.gnome.desktop.interface toolkit-accessibility true` (or set `org.a11y.Status IsEnabled`).
- Chromium/Electron apps: `--force-renderer-accessibility` for full web trees.
- Qt apps: `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`.
- Good trees: GTK3/GTK4, Firefox, LibreOffice. gnome-terminal exposes visible text through
  ATK; Ptyxis (RHEL 10) only does behind its `enable-a11y` toggle. Terminal text is otherwise read from screenshots.
- Poor trees (canvas, games, VNC viewers) → screenshot-only grounding (`click_at`, `zoom`).

---

## 5. Safety & control

- **Esc / hotkey kill switch** → `session.abort()` + cancel in-flight motion via `AbortSignal`.
- **User takeover:** physical mouse/keyboard activity during an agent action pauses the agent and
  asks "continue?". Ember ignores its own injected events (uiohook on X11; extension on Wayland).
- **Confirm risky actions** in `onPreToolUse`: sending messages, deleting, closing unsaved work,
  password fields (AT-SPI `password text` role).
- **Wayland control surfaces** (Mutter private API, the extension's D-Bus interface) are callable by
  any process in the session → sender allow-list in the extension plus a visible "Ember is in
  control" indicator.
- Avoid ydotool (AGPL, root-level uinput).

---

## 6. Reusable code — inventory

### Linux (now)

| Project | License | Use |
|---|---|---|
| [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) 1.0.21 | MIT | Agent loop |
| [**agent-sh/computer-use-linux**](https://www.npmjs.com/package/@agent-sh/computer-use-linux) 0.7.16 (Rust + npm, very active) | MIT | **Closest match to Ember on Linux.** AT-SPI selectors; portal RemoteDesktop / uinput / xdotool input; Shell-screenshot → portal → X11 capture; Shell extension for windows; `doctor` readiness check; overlay that hides during capture. Vendor it or copy its tactics |
| [robotjs](https://github.com/octalmage/robotjs) 0.9.1 | MIT | XTest mouse/keyboard (X11) |
| [ghost-cursor](https://github.com/Xetera/ghost-cursor) | ISC | Human-like path generation |
| [uiohook-napi](https://github.com/SnosMe/uiohook-napi) 1.5.5 | MIT | Hold-to-talk, takeover detection (X11) |
| [node-screenshots](https://github.com/nashaofu/node-screenshots) 0.2.8 | Apache-2.0 | X11 capture |
| pyatspi / python3-gobject (RHEL packages) | LGPL | AT-SPI sidecar |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | Offline STT/VAD/TTS |

### Borrow patterns from

| Project | License | What to borrow |
|---|---|---|
| [farzaa/clicky](https://github.com/farzaa/clicky) | MIT | Buddy-follow spring, `[POINT:x,y:label:screenN]` pointing protocol, flight animation, push-to-talk state machine |
| [dogtail](https://github.com/vhumpa/dogtail) + gnome-ponytail-daemon | GPL-2.0 (reference only) | AT-SPI + Mutter RemoteDesktop/ScreenCast on GNOME Wayland; window-relative → global coordinates |
| [sbuysse/gnome-desktop-mcp](https://github.com/sbuysse/gnome-desktop-mcp) | GPL-3.0 (reference only) | Shell extension doing screenshots, windows and virtual input (GNOME 45–49) |
| [AmrDab/clawdcursor](https://github.com/AmrDab/clawdcursor) | MIT | TypeScript + python3-gi AT-SPI sidecar; same stack shape as Ember |
| [xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) `desktop_env` | Apache-2.0 | AT-SPI tree serialization for LLMs |
| [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | Apache-2.0 | Electron overlay/marker windows; `Operator { screenshot(); execute() }` interface |
| [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | — | Action vocabulary |

### Later ports

| Platform | Perception | Input | Other |
|---|---|---|---|
| macOS | [Peekaboo](https://github.com/openclaw/Peekaboo) (MIT, AX map + screenshot) | robotjs + ghost-cursor | `setContentProtection`, `forward:true` work; Screen Recording + Accessibility permissions |
| Windows | [`@mediar-ai/terminator`](https://github.com/mediar-ai/terminator) (MIT, UIA) or [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) (MIT) | robotjs + ghost-cursor | Port clicky-windows ideas |

### Avoid copying

pluely (proprietary since v1), screenpipe (commercial license), Glass forks (GPL, disputed),
upstream nut.js (not on public npm), ydotool (AGPL), GPL projects above (reference only).

---

## 7. Build plan

| Milestone | Scope | Done when |
|---|---|---|
| **M0 Spike (X11)** | Electron overlay on RHEL 8/9 "GNOME on Xorg"; buddy follows cursor; bubble; clicky flight; overlay hides during capture | Smooth on a dual-monitor Xorg box; Electron 44 + Copilot runtime start on RHEL 8.10 |
| **M1 Brain** | Copilot session, auth check, vision-capable model picker, stream intent/reasoning/steps into the bubble; text box | "What's on my screen?" answered from a screenshot |
| **M2 Hands (X11)** | pyatspi sidecar + set-of-marks; robotjs + ghost-cursor glide; click/type/keys/scroll/open_app; verify loop; Esc abort | "Open gedit and write a haiku" done visibly, with no shell |
| **M3 Guide + Quick** | `point_at`, highlight, `wait_for_user_click`; uiohook push-to-talk + sherpa-onnx; focused-window snapshot | "Show me how to change the wallpaper"; voice command acts in < ~5 s |
| **M4 GNOME Wayland (RHEL 8/9)** | Legacy-format Shell extension (overlay, pointer, keybinding, frame rects) + Mutter RemoteDesktop/ScreenCast | M2–M4 demos pass in the default Wayland session |
| **M5 RHEL 10** | ESM extension build; portal RemoteDesktop v2 + libei with restore token; Ptyxis | Same demos on RHEL 10.2 (GNOME 49) |
| **M6 Packaging** | RPM (+ AppImage), system-wide extension with dconf lock, native addons built on Alma 8, `doctor` check | Clean install on RHEL 8, 9, 10 |
| **M7 macOS, M8 Windows** | Backends from §6 "Later ports" | Same demo suite |

CI: build and smoke-test on Alma/Rocky 8, 9, 10 containers (Xvfb for X11 tests).

## 8. Risks / open questions

- **GNOME Wayland is the hard part.** The Mutter RemoteDesktop/ScreenCast API is private and can
  change across RHEL minor rebases (10.2 jumped 47 → 49). The Shell extension needs two builds
  (legacy and ESM). Prototype M4 early, not last.
- **XWayland overlay** (`--ozone-platform=x11`) stacking and fractional scaling on GNOME 49 *(verify)*.
- **Copilot runtime packaging** in Electron (~148 MB, stdio issues reported) — validate in M0/M1.
- **Reasoning visibility varies by model** — the bubble design doesn't depend on it.
- **Latency & quota:** each step = screenshot → model → action. Prefer element-id actions, batch
  obvious steps, downscale images, use a faster model tier for Quick mode.
- **Enterprise policy:** an always-on screen-reading/input agent will raise security review questions
  → local-only processing except model calls, audit log, a clear indicator.

## 9. Deferred: SSH to remote machines

Out of scope for now. If it comes back, the researched approach was: Ember opens the user's real
terminal running tmux on its own socket (`tmux -L ember`), visibly types `ssh <allowlisted alias>`,
types with `send-keys`, reads exact output with `capture-pane`, and detects command completion and
exit codes by parsing OSC 133 markers from `pipe-pane` (RHEL's tmux 2.7/3.2a/3.3a predates native
support). Secrets go through ssh-agent / `SSH_ASKPASS` (OpenSSH ≥ 8.4) or an overlay prompt, never
the model; commands are classified and destructive/privileged ones confirmed. Policy references:
[tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) (MIT), [classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server) (ISC).
macOS/Windows would use an `ember-bridge` built on `node-pty` + `@xterm/headless`.
