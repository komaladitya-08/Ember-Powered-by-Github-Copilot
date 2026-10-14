# Ember — research & architecture

> A cursor-companion agent that lives next to your mouse, talks with you, and does
> the work **inside your real applications** — visibly gliding the cursor, clicking,
> and typing — while streaming its reasoning in a bubble under the cursor.
> The agentic loop is powered by the **GitHub Copilot SDK**.

Research date: 2026-10-14. Primary target: **Windows 10/11**; macOS second.

---

## 1. What Ember must do

| # | Capability | What the user sees |
|---|---|---|
| 1 | **Do it for me** | A second "agent cursor" flies to targets, the real cursor follows a human-like path, clicks and types in real apps. Reasoning + current step stream in a bubble below it. |
| 2 | **Guide me** | Ember flies to the element, rings/highlights it with a label ("Click *Insert → Table*"), waits for *you* to click it, then points at the next step. |
| 3 | **Quick, in context** | You're already in an app, hold push-to-talk, say "make this bold and center it". Ember captures the focused window's UI tree + screenshot at that moment and acts immediately. |
| 4 | Talk to it | Push-to-talk voice (offline STT) or a small text box; optional spoken replies. |

Design rule: **no shell/file-edit shortcuts.** Every change goes through the GUI of a
real app (open apps via Start menu, edit via the app's own UI), so what the agent does
is always visible and understandable.

---

## 2. Recommended stack (TL;DR)

| Layer | Choice | Why |
|---|---|---|
| App shell / overlay | **Electron + TypeScript** | `setIgnoreMouseEvents(true, {forward:true})` (click-through but hoverable bubble), per-display overlays, `setContentProtection` (overlay excluded from our own screenshots), `desktopCapturer`, `screen.getCursorScreenPoint`. Tauri v2 lacks forwarded mouse events (tauri#9250). |
| Agent loop | **`@github/copilot-sdk`** (1.0.21, MIT, pin exact) | Sessions, streaming reasoning/intent/tool events, custom tools that can **return images**, image attachments, hooks, abort, MCP. |
| UI perception (Windows) | **`@mediar-ai/terminator`** (Node, napi, MIT) | In-process UIA tree, element bounds, window/monitor capture, OCR/OmniParser fallback. Fallback: **Windows-MCP** as an MCP server. |
| UI perception (macOS) | **Peekaboo** (MIT, MCP/CLI) | AX element map + screenshot (`see`). |
| Real cursor & keyboard | **robotjs 0.9.x** (MIT, revived 2026, N-API prebuilds) | `moveMouse`, `mouseClick`, Unicode `typeString`, multi-monitor fixes. Backup: `@nut-tree-fork/nut-js`. |
| Human-like motion | **ghost-cursor** `path()` (ISC) | Bézier + Fitts's-law timing; feed points to robotjs. |
| Agent-cursor animation | Port of **clicky**'s flight math (MIT) | Arc bezier, smoothstep, scale pulse, tangent rotation. |
| Global hotkey / user-takeover | **uiohook-napi** (MIT) | Key-up for push-to-talk; detect physical mouse/keyboard to pause the agent. |
| Speech-to-text | **sherpa-onnx-node** (Apache-2.0) streaming; or whisper.cpp binding | Offline, live partials in the bubble. Web Speech API does **not** work in Electron. |
| Text-to-speech | `speechSynthesis` (OS voices) → Kokoro via sherpa-onnx later | Free/offline. |

---

## 3. Architecture

```
┌──────────────────────────── Electron main process ────────────────────────────┐
│                                                                                │
│  OverlayManager ── one transparent, click-through, content-protected window    │
│   per display: buddy, agent-cursor, reasoning bubble, highlight rings          │
│                                                                                │
│  InputHub (uiohook-napi) ── push-to-talk, Esc kill-switch, user-takeover detect│
│                                                                                │
│  AgentHost ───────────── CopilotClient / CopilotSession ──────────────────────┐│
│   • streaming events ──► OverlayManager (reasoning, intent, tool status)      ││
│   • custom tools ──────► DesktopDriver                                        ││
│   • hooks (onPreToolUse) ► SafetyGate (confirm risky actions)                 ││
│                                                                               ││
│  DesktopDriver (interface)                                                    ││
│   ├─ perceive(): screenshot + UIA/AX elements + set-of-marks image            ││
│   ├─ act(action): glide (ghost-cursor path → robotjs) → click/type → verify   ││
│   ├─ WindowsBackend: terminator (+ Windows-MCP fallback)                      ││
│   └─ MacBackend: Peekaboo                                                     ││
│                                                                                │
│  utilityProcess: STT (sherpa-onnx) ◄── mic audio from hidden renderer          │
└────────────────────────────────────────────────────────────────────────────────┘
          ▲ stdio JSON-RPC
          │
   Copilot runtime (bundled by the SDK, ~148 MB per platform)
```

### 3.1 The agent loop (Copilot SDK)

Copilot runs the loop: model → tool calls → our handlers → model … until
`session.idle`. Ember only supplies tools, the system prompt, and the UI.

```ts
import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";

const client = new CopilotClient();          // auth: `copilot login` once, or gitHubToken from an OAuth flow
await client.start();

const perceive = defineTool("perceive_screen", {
  description: "Capture the focused window (or all screens): numbered UI elements + marked screenshot.",
  parameters: z.object({ scope: z.enum(["focused_window", "all_screens"]).default("focused_window") }),
  skipPermission: true,
  defer: "never",                            // keep core tools always loaded
  handler: async ({ scope }) => {
    const p = await driver.perceive(scope);
    return {
      textResultForLlm: p.elementsAsText,    // "[12] Button 'Bold' (enabled)" ...
      binaryResultsForLlm: [{ type: "image", data: p.markedPngBase64, mimeType: "image/png", description: "screen with numbered marks" }],
      resultType: "success",
    };
  },
});

const clickElement = defineTool("click_element", {
  description: "Visibly move the real cursor to element N from the last perceive_screen and click it.",
  parameters: z.object({ id: z.number(), button: z.enum(["left", "right"]).default("left"), double: z.boolean().default(false),
                         why: z.string().describe("One short sentence shown to the user") }),
  defer: "never",
  handler: async (a, inv) => driver.clickElement(a, inv.signal),   // glide + click + re-verify
});

const session = await client.createSession({
  model: pickedModelId,                      // from client.listModels(), must support vision
  streaming: true,
  tools: [perceive, clickElement, /* type_text, press_keys, scroll, drag, open_app, focus_window,
                                      point_at, wait_for_user_click, ... */],
  // Ember must not use shell/edit/file tools — whitelist only Ember's tools
  // (verify exact name format for availableTools/excludedTools against SDK types).
  availableTools: EMBER_TOOL_NAMES,
  systemMessage: { mode: "customize", sections: {
    identity:          { action: "replace", content: EMBER_IDENTITY },
    code_change_rules: { action: "remove" },
    tool_instructions: { action: "append",  content: EMBER_TOOL_RULES },
  }},
  onPermissionRequest: (req) => safety.decide(req),   // never omit: missing handler stalls the turn
  hooks: { onPreToolUse: (i) => safety.preToolUse(i) },
});

session.on("assistant.intent",          e => bubble.status(e.data.intent));
session.on("assistant.reasoning_delta", e => bubble.reason(e.data.deltaContent));
session.on("assistant.message_delta",   e => bubble.say(e.data.deltaContent));
session.on("tool.execution_start",      e => bubble.step(e.data.toolName, e.data.arguments));
session.on("tool.execution_complete",   e => bubble.stepDone(e.data.success));
session.on("session.idle",              () => bubble.idle());

// "Quick, in context": attach what's on screen at hotkey time
await session.send({ prompt: transcript, attachments: [
  { type: "blob", data: snap.pngBase64, mimeType: "image/png", displayName: "focused-window.png" },
]});
```

Key SDK facts this design relies on (all from `@github/copilot-sdk` 1.0.21 types/docs):

- **Reasoning is streamable**: `assistant.reasoning_delta`, `assistant.intent`. Content is model-dependent
  (OpenAI → summaries via `reasoningSummary`; some Anthropic thinking may arrive encrypted). Always show
  `intent` + each tool's `why` argument, so the bubble is useful even when raw reasoning isn't exposed.
- **Tools can return images** (`binaryResultsForLlm`) — this is how the model "sees" after each action.
- **`session.abort()`** + `invocation.signal` → Esc kill-switch stops mid-glide.
- **`send({mode:"immediate"})`** lets the user steer mid-task ("no, the other one").
- **Built-in tools are on by default** (shell, edit, view…). Restrict them; otherwise the agent
  will "cheat" by running commands, defeating the visible-GUI goal.
- `sendAndWait` defaults to a 60 s timeout — use events + `session.idle` instead.
- Each prompt uses the user's Copilot quota (BYOK available via `provider`).

### 3.2 Tool set (what the model can do)

All coordinates the model sees are **screenshot pixels**; the driver maps to physical
pixels. Element-id tools are preferred; raw coordinates are the fallback.

| Tool | Purpose |
|---|---|
| `perceive_screen{scope}` | UIA/AX elements (id, role, name, value, enabled, bounds) + set-of-marks PNG. |
| `click_element{id, button, double, why}` | Glide real cursor → click → re-perceive diff. |
| `click_at{x, y, why}` | Coordinate fallback for canvas/poor-a11y apps. |
| `type_text{text, why}` / `press_keys{keys[]}` | Real keyboard input with per-char jitter. |
| `scroll{id?, direction, amount}` / `drag{from, to}` | |
| `open_app{name}` | Visibly: Win key → type name → Enter (macOS: Spotlight). |
| `focus_window{title}` | Bring an existing window forward (via its taskbar/title bar where possible). |
| `point_at{id \| x,y, label}` | **Guide mode**: fly agent cursor + highlight ring + label; does not click. |
| `wait_for_user_click{id, timeout}` | Guide mode: resolves when the user clicks inside the rect (uiohook). |
| `zoom{region}` | High-res crop for small text/icons. |
| `ask_user{question}` | Via SDK `onUserInputRequest` (bubble becomes interactive). |

Modes are just system-prompt + tool subsets: **Do** = all; **Guide** = perceive/point_at/wait_for_user_click
only (no click/type tools exposed); **Quick** = Do with the focused-window snapshot pre-attached.

### 3.3 Making actions visible ("native feel")

1. Overlay shows the **agent cursor** (Ember's own pointer) flying with clicky's arc animation
   to the target, with the `why` text under it.
2. Simultaneously, the **real OS cursor** follows a `ghost-cursor` path, stepped with
   `robotjs.moveMouse` at ~120–240 Hz, slight random point inside the element, then click.
   (Do *not* use terminator's `click()` — it teleports and restores the cursor; `invoke()`
   doesn't move it at all. Keep those only as fallbacks for off-screen/covered elements.)
3. Click ripple + typing caption + keycap chips in the overlay (Peekaboo-visualizer style).
4. After every action: re-read the tree/screenshot and verify (focus, value, new window).
5. A per-user speed setting (calm demo speed ↔ fast).

### 3.4 Overlay recipe (Electron)

One window per display (avoids mixed-DPI bugs):

```ts
new BrowserWindow({ ...display.bounds, transparent: true, frame: false, focusable: false,
  skipTaskbar: true, hasShadow: false, alwaysOnTop: true, type: isMac ? "panel" : "toolbar",
  webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
win.setAlwaysOnTop(true, "screen-saver");
win.setIgnoreMouseEvents(true, { forward: true });   // bubble toggles to interactive on mouseenter
win.setContentProtection(true);                      // WDA_EXCLUDEFROMCAPTURE: model never sees Ember
```

- Follow cursor: poll `screen.getCursorScreenPoint()` every 16 ms, spring-smooth in the renderer,
  buddy at cursor + (35, 25), bubble below; flip near edges using `display.workArea`.
- Re-assert topmost periodically (Start menu/search can cover it).
- Content protection hides Ember in Teams/Zoom screen-shares too — make it a setting.
- Lift-able reference code: UI-TARS-desktop `apps/ui-tars/src/main/window/ScreenMarker.ts` (Apache-2.0),
  free-cluely `electron/WindowHelper.ts` (Apache-2.0).

### 3.5 Coordinate spaces (top source of misclicks — test early)

| Space | Used by |
|---|---|
| DIP (logical) | Electron `screen`, overlay CSS pixels |
| Physical pixels | robotjs/SendInput (process must be per-monitor DPI aware), uiohook on Windows, UIA bounds |
| Screenshot pixels | What the model sees (downscaled to ~1280–1366 px wide) |

Store `{displayId, displayBounds, scaleFactor, imageW, imageH}` with every capture;
convert model→physical with that record, never with globals.

### 3.6 Safety & control

- **Esc / hotkey kill-switch** → `session.abort()` + cancel in-flight glide via `AbortSignal`.
- **User takeover**: physical mouse/keyboard activity during an agent action (uiohook, ignoring
  our own injected events) pauses the agent and asks "continue?" (idea from Windows-MCP).
- **Confirm risky actions** in `onPreToolUse`: sending email/messages, purchases, deleting,
  closing unsaved work, typing into password fields (UIA `IsPassword`).
- Turn off Windows-MCP telemetry if used (`ANONYMIZED_TELEMETRY=false`).

---

## 4. Reusable code — inventory

### Take directly (dependencies)
| Project | License | Use |
|---|---|---|
| [`@github/copilot-sdk`](https://github.com/github/copilot-sdk) | MIT | Agent loop |
| [`@mediar-ai/terminator`](https://github.com/mediar-ai/terminator) | MIT | Windows UIA tree, capture, OCR/OmniParser, highlight. Pin version; pace has slowed. |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | Fallback perception/actions via SDK `mcpServers` (`uvx windows-mcp serve`, Python 3.14) |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | MIT | macOS backend (MCP `npx -y @steipete/peekaboo`) |
| [robotjs](https://github.com/octalmage/robotjs) 0.9.x | MIT | Real mouse/keyboard |
| [ghost-cursor](https://github.com/Xetera/ghost-cursor) | ISC | Human-like path generation |
| [uiohook-napi](https://github.com/SnosMe/uiohook-napi) | MIT | Global key-up/mouse hooks |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | Offline streaming STT, VAD, TTS |

### Port / borrow patterns from
| Project | License | What to borrow |
|---|---|---|
| [farzaa/clicky](https://github.com/farzaa/clicky) | MIT | The closest existing product: buddy-follow spring, `[POINT:x,y:label:screenN]` pointing protocol, flight animation, push-to-talk state machine |
| [clicky-windows](https://github.com/Bitshank-2338/clicky-windows) | MIT | Windows port; grid → zoomed-grid pointing refinement for non-Claude models |
| [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | Apache-2.0 | Electron overlay/marker windows; `Operator { screenshot(); execute() }` interface |
| [free-cluely](https://github.com/Prat011/free-cluely) | Apache-2.0 | Always-on-top stealth window helper |
| [clawdcursor](https://github.com/AmrDab/clawdcursor) | MIT | TS cross-platform desktop MCP (UIA via PowerShell, nut-js input) — design reference |
| [Microsoft UFO²](https://github.com/microsoft/UFO) | MIT | Hybrid UIA + vision control detection; prompt design |
| [Windows-Use](https://github.com/Jeomon/Windows-Use) | MIT | UIA-tree serialization & prompts |
| [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | — | Action vocabulary (click/type/key/scroll/zoom/…) |

### Avoid copying
pluely (proprietary since v1), screenpipe (commercial license), Glass forks (GPL, disputed),
upstream nut.js (no longer on public npm), Bytebot / macOS-use (archived),
OmniParser older detector weights (AGPL — `icon_detect_v3` is MIT).

---

## 5. Build plan

| Milestone | Scope | Done when |
|---|---|---|
| **M0 Spike** | Electron overlay per display; buddy follows cursor; bubble; clicky flight to a clicked point | Smooth on mixed-DPI dual monitor |
| **M1 Brain** | Copilot SDK session, auth check, model picker (vision-capable), stream intent/reasoning/tool steps into bubble; text input box | "What's on my screen?" answered from a screenshot |
| **M2 Hands (Windows)** | `DesktopDriver` w/ terminator perceive + set-of-marks; robotjs + ghost-cursor glide; click/type/keys/scroll/open_app; verify loop; Esc abort | "Open Notepad and write a haiku" done visibly, no shell |
| **M3 Guide** | `point_at`, highlight ring, `wait_for_user_click`, step-by-step tutorials | "Show me how to add a table in Word" |
| **M4 Quick context** | Push-to-talk (uiohook) + sherpa-onnx STT; focused-window snapshot on press; `mode:"immediate"` steering | Voice command in current app executes in < ~5 s to first action |
| **M5 Safety & polish** | Takeover detection, risky-action confirms, settings, TTS, packaging (asarUnpack natives, per-arch SDK runtime) | Installer on clean Win11 |
| **M6 macOS** | Peekaboo backend, permissions onboarding | Same demos on macOS |

## 6. Risks / open questions

- **Packaging the Copilot runtime in Electron**: ~148 MB per platform package; one report of stdio
  breaking when bundled — workaround is running the runtime as a server and connecting via
  `RuntimeConnection.forUri`. Validate in M1.
- **Reasoning visibility varies by model** — design the bubble around `intent` + tool `why`.
- **Latency**: each step = screenshot → model → action. Prefer element-id actions, batch obvious
  steps, downscale images, use a fast model tier for Quick mode.
- **Quota**: every prompt uses Copilot premium requests; long tasks are many turns.
- **Accessibility gaps** (games, canvas, some Electron/Qt apps) → OmniParser/vision fallback via terminator.
- **Terminator maintenance** → keep `DesktopDriver` swappable (Windows-MCP is the drop-in alternative).
