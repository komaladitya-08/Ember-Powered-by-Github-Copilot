/**
 * Synthetic input on Windows (Input): SendInput through koffi, with XInput's method set and conventions so
 * CursorBorrow works unchanged. Keys are named by X keysyms and pressed as virtual keys (keys.ts); key codes are VKs;
 * buttons use X's numbers and mask bits, as logical buttons (swap-aware). Moves are absolute virtual-desktop events,
 * so negative coordinates work. Every event carries EMBER_INPUT_TAG.
 *
 * Safety, as on X11: the backend tracks every key and button Ember holds and lets go of them in releaseAll(), on
 * close() and when the process exits (an injected key-down outlives a crash on Windows until the key is pressed);
 * keysDown() reports the keys held by anyone, Ember's own included, minus the aliases Windows adds (generic
 * modifiers, VK_PACKET, the fake left Ctrl of AltGr), so the borrow's takeover check sees exactly the user's keys;
 * blockedReason() refuses windows of elevated programs, whose input UIPI would drop without a word. After close()
 * every member is a harmless no-op. There is no event watch (watchUser/userInput): the borrow polls.
 */

import type { Input } from "../types";
import { loadWin32, SM, type Win32Api } from "./ffi";
import { activateWindow, appName, factsOf, focusedTopLevel, topLevels, virtualScreen, type ProgramMemo } from "./hwnd";
import {
  buttonMask, EXTENDED_VKS, fakeControlPossible, heldKeys, isKeyCode, keysymOfName, textStroke, virtualKeyFor, VK,
} from "./keys";
import { buttonInput, encodeInputs, keyInput, moveInput, unicodeInputs, type InputEvent, type MouseInput } from "./layouts";
import { isFindable, isPopup, pickWindow, pointerLandsOn, type FindCandidate } from "./rules";
import { blockReason, onUsersDesktop, uipiBlock, UNCHECKED_REASON, type TokenFacts } from "./security";

/** What openWin32Input needs: for tests, a fake Win32 API. */
export interface Win32InputDeps {
  /** The Win32 calls (default: the real ones, bound on first use; null where unavailable). */
  api?: Win32Api | null;
  /** The clock, for the AltGr fake-Ctrl grace (tests). */
  now?: () => number;
}

/** How many owners pointerOn follows up from a popup (an owner chain is short; a loop must not hang). */
const OWNER_HOPS = 8;
const FAKE_CONTROL: ReadonlySet<number> = new Set([VK.LCONTROL]);

/** Opens Windows input, or null off Windows, without koffi, or when koffi's INPUT layout isn't the expected one. */
export function openWin32Input(deps: Win32InputDeps = {}): Input | null {
  const api = deps.api !== undefined ? deps.api : loadWin32();
  if (!api || !api.canSendInput) return null;
  const now = deps.now ?? Date.now;
  const ownPid = process.pid;
  let open = true;
  /** Keys Ember holds: VK → whether it went down as an extended key (numpad Enter is VK_RETURN, extended). */
  const keysHeld = new Map<number, boolean>();
  /** UTF-16 code units Ember holds down through KEYEVENTF_UNICODE (textKey). */
  const textHeld = new Set<number>();
  /** X buttons Ember holds, each with the event that lets it go (the swap setting may change while it is down). */
  const buttonsHeld = new Map<number, MouseInput>();
  /** When Ember last let go of right Alt (the fake left Ctrl of AltGr can trail it). */
  let rightAltUpAt = -Infinity;
  /** Ember's own token facts, read once (they don't change while it runs). */
  let ownToken: TokenFacts | null | undefined;

  const send = (events: InputEvent[]): boolean => !events.length || api.sendInput(encodeInputs(events), events.length) === events.length;
  /** The foreground app's keyboard layout: layouts are per thread on Windows, and keys go to that thread. */
  const layout = (): unknown => api.keyboardLayout(api.threadProcess(api.foregroundWindow()).tid);
  const scanner = (): ((ch: number) => number) => {
    const hkl = layout();
    return ch => api.vkKeyScan(ch, hkl);
  };
  const swapped = () => api.systemMetric(SM.SWAPBUTTON) !== 0;
  const noteUp = (vk: number) => {
    keysHeld.delete(vk);
    if (vk === VK.RMENU) rightAltUpAt = now();
  };
  const pressVk = (vk: number, extended: boolean, down: boolean) => {
    send([keyInput(vk, api.scanCode(vk, layout()), extended, down)]);
    if (down) keysHeld.set(vk, extended); else noteUp(vk);
  };
  const keycode = (code: number, down: boolean) => {
    if (!open || !isKeyCode(code)) return;
    // Up the way it went down: numpad Enter shares VK_RETURN with Enter but is extended.
    pressVk(code, down ? EXTENDED_VKS.has(code) : (keysHeld.get(code) ?? EXTENDED_VKS.has(code)), down);
  };
  const releaseAll = () => {
    if (!open) return;
    const hkl = layout();
    const events: InputEvent[] = [];
    for (const [vk, extended] of keysHeld) events.push(keyInput(vk, api.scanCode(vk, hkl), extended, false));
    if (textHeld.size) events.push(...unicodeInputs([...textHeld], false));
    events.push(...buttonsHeld.values());
    if (keysHeld.has(VK.RMENU)) rightAltUpAt = now();
    keysHeld.clear();
    textHeld.clear();
    buttonsHeld.clear();
    send(events);
  };
  const onExit = () => releaseAll();
  process.on("exit", onExit);

  /** The windows findWindow may pick, with the names they can be asked for by (program, window class). */
  const candidates = (): FindCandidate[] => {
    const memo: ProgramMemo = new Map();
    const out: FindCandidate[] = [];
    for (const hwnd of topLevels(api)) {
      if (!api.isVisible(hwnd)) continue;
      const facts = factsOf(api, hwnd, ownPid);
      if (!facts.pid || !isFindable(facts)) continue;
      out.push({ id: hwnd, title: facts.title, pid: facts.pid, names: [appName(api, hwnd, facts.pid, facts.className, facts.title, memo), facts.className] });
    }
    return out;
  };

  return {
    pointer() {
      return open ? api.cursorPos() : null;
    },
    pointerState() {
      if (!open) return null;
      const p = api.cursorPos();
      return p ? { ...p, mask: buttonMask(vk => api.asyncKeyDown(vk), swapped()) } : null;
    },
    move(x, y) {
      if (open) send([moveInput(x, y, virtualScreen(api))]);
    },
    button(button, down) {
      if (!open) return;
      if (down) {
        const press = buttonInput(button, true, swapped());
        if (!press) return;
        // The "up" is chosen now, so it lets go of the physical button that went down.
        const release = buttonInput(button, false, swapped());
        send([press]);
        if (release) buttonsHeld.set(button, release); // a wheel notch has no "up": it is never held
      } else {
        const release = buttonsHeld.get(button) ?? buttonInput(button, false, swapped());
        buttonsHeld.delete(button);
        if (release) send([release]);
      }
    },
    keysym(sym, down) {
      if (!open) return false;
      const key = virtualKeyFor(sym, scanner());
      if (!key) return false;
      pressVk(key.vk, key.extended, down);
      return true;
    },
    keycode,
    keysymOf: name => keysymOfName(name),
    keysDown() {
      if (!open) return [];
      return heldKeys(vk => api.asyncKeyDown(vk), fakeControlPossible(keysHeld, rightAltUpAt, now()) ? FAKE_CONTROL : undefined);
    },
    keycodeOf(sym) {
      return open ? virtualKeyFor(sym, scanner())?.vk ?? 0 : 0;
    },
    needsShift(sym) {
      return open ? virtualKeyFor(sym, scanner())?.shift ?? false : false;
    },
    textKey(ch, down) {
      if (!open) return false;
      const stroke = textStroke(ch);
      if (!stroke) return false;
      if (stroke.kind === "vk") {
        pressVk(stroke.vk, false, down);
        return true;
      }
      for (const unit of stroke.units) if (down) textHeld.add(unit); else textHeld.delete(unit);
      return send(unicodeInputs(stroke.units, down));
    },
    activeWindow() {
      return open ? api.foregroundWindow() : 0;
    },
    focusedWindow() {
      return open ? focusedTopLevel(api) : 0;
    },
    screenSize() {
      if (!open) return { width: 0, height: 0 };
      const s = virtualScreen(api);
      return { width: s.width, height: s.height };
    },
    onScreen(x, y) {
      return open && api.onMonitor(x, y);
    },
    findWindow(title, pid, wmClass) {
      return open ? pickWindow(candidates(), title, pid, wmClass) : 0;
    },
    activate(window) {
      if (open) activateWindow(api, window, ownPid);
    },
    focusInput(window) {
      // Ember's own windows only: they live on this (the main) thread, where SetFocus may set the keyboard focus.
      if (!open || !window || api.threadProcess(window).pid !== ownPid) return;
      if (api.foregroundWindow() !== window) activateWindow(api, window, ownPid);
      api.setFocus(window);
    },
    sync() {
      // SendInput is synchronous: nothing is buffered.
    },
    releaseAll,
    close() {
      if (!open) return;
      releaseAll(); // a borrow still running when Ember quits must not leave a key or button down
      open = false;
      process.off("exit", onExit);
    },
    blockedReason(window) {
      // Fail closed: a window Ember can't check is a window it doesn't touch.
      if (!open || !window) return UNCHECKED_REASON;
      const pid = api.threadProcess(window).pid;
      if (!pid) return UNCHECKED_REASON;
      if (pid === ownPid) return null;
      if (ownToken === undefined) ownToken = api.processToken(null);
      return blockReason(uipiBlock(ownToken, api.processToken(pid)));
    },
    keyboardGrabbed() {
      // The secure desktop (UAC, Ctrl+Alt+Del, the lock screen) has the keyboard. The Start menu and Task View take
      // the foreground instead, which the borrow's focus check already catches.
      return open && !onUsersDesktop(api.inputDesktopName());
    },
    pointerOn(window, elementWindow) {
      if (!open || !window) return false;
      const p = api.cursorPos();
      if (!p) return false;
      const hit = api.windowFromPoint(p.x, p.y);
      const top = hit ? api.root(hit) || hit : 0;
      if (!top) return false;
      const owners: number[] = [];
      for (let o = api.owner(top); o && owners.length < OWNER_HOPS && !owners.includes(o); o = api.owner(o)) owners.push(o);
      const className = api.className(top);
      const facts = { className, style: api.style(top), exStyle: api.exStyle(top), owner: owners[0] ?? 0 };
      return pointerLandsOn(
        { top, className, pid: api.threadProcess(top).pid || null, popup: isPopup(facts), owners },
        elementWindow ? [window, elementWindow] : [window],
        api.threadProcess(window).pid || null,
      );
    },
    screenLocked() {
      return open && !onUsersDesktop(api.inputDesktopName());
    },
  };
}
