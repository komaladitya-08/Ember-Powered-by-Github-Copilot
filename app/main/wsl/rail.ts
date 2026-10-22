/**
 * Which of the Windows window system's windows are WSLg's RAIL windows (§4.6): windows of an msrdc.exe that WSL
 * installed (policy/remote-surface.ts isWslgImage), as opposed to a Remote Desktop client's, which stay remote surfaces
 * whatever happens. Reads each msrdc's program image (OpenProcess + QueryFullProcessImageNameW) and a popup's owner
 * (GetWindow GW_OWNER) through its own koffi bindings: kernel32 and user32, bound once, lazily, and only on Windows, so
 * the module imports cleanly everywhere (koffi loads inside openRailProbe's first use, never at import: a macOS remote
 * ships no koffi). Neither call sends a message to another process's window: both only read what the system keeps.
 */

import { createRequire } from "node:module";
import type { OS } from "../../shared/shortcuts";
import { isWslgImage } from "../policy/remote-surface";
import { hwndOf, readUtf16 } from "../platform/win32/layouts";
import type { StackedWindow } from "../platform/types";
import type { RailWindow } from "./match";

/** What the router asks Windows about a window or process (faked in tests). */
export interface RailProbe {
  /** The process's program image path, as QueryFullProcessImageNameW gives it (Win32 form); null when it can't be read. */
  imagePath(pid: number): string | null;
  /** The window's owner (GW_OWNER), 0 for none or when it can't be read. */
  owner(hwnd: number): number;
}

/** msrdc's program, with or without ".exe", any case (as the window system names the app). */
const MSRDC = /^msrdc(?:\.exe)?$/i;

/** Is this stacked window one of an msrdc.exe (WSLg's or a Remote Desktop client's)? */
export function isMsrdcWindow(w: Pick<StackedWindow, "wmClass">): boolean {
  return MSRDC.test(w.wmClass.trim());
}

/**
 * Per msrdc process, whether it is WSLg's (its image under WSL's install folder), remembered while the process lives:
 * an image is read once per pid, and a pid the stack no longer shows is forgotten (Windows reuses pids). A probe that
 * can't read the image (none off Windows, a process that went) says "not WSLg's": its windows stay remote surfaces.
 */
export class WslgPids {
  private known = new Map<number, boolean>();

  constructor(private probe: RailProbe | null) {}

  /** The msrdc pids of `stack` that are WSLg's; pids not in it are forgotten. */
  of(stack: readonly Pick<StackedWindow, "pid" | "wmClass">[]): Set<number> {
    const pids = new Set(stack.filter(w => w.pid != null && isMsrdcWindow(w)).map(w => w.pid!));
    for (const pid of [...this.known.keys()]) if (!pids.has(pid)) this.known.delete(pid);
    const out = new Set<number>();
    for (const pid of pids) {
      let wslg = this.known.get(pid);
      if (wslg === undefined) {
        let image: string | null;
        try {
          image = this.probe?.imagePath(pid) ?? null;
        } catch {
          image = null; // can't be read: not taken for WSLg's (its windows stay remote surfaces)
        }
        wslg = image !== null && isWslgImage(image);
        // A failed read is asked again next time (the process may have been starting); a real answer is kept.
        if (image !== null) this.known.set(pid, wslg);
      }
      if (wslg) out.add(pid);
    }
    return out;
  }
}

/** The RAIL windows of `stack` (bottom to top, as stacked) whose msrdc is in `wslg`, with their owners. */
export function railWindows(stack: readonly StackedWindow[], wslg: ReadonlySet<number>, probe: RailProbe | null): RailWindow[] {
  const out: RailWindow[] = [];
  for (const w of stack) {
    if (w.pid == null || !wslg.has(w.pid) || !isMsrdcWindow(w)) continue;
    let owner = 0;
    if (w.overrideRedirect) {
      try {
        owner = probe?.owner(w.id) ?? 0;
      } catch {
        owner = 0; // unknown: the popup may still be placed by where it lies
      }
    }
    out.push({
      hwnd: w.id, pid: w.pid, title: w.title, inner: w.inner, frame: { x: w.x, y: w.y, width: w.width, height: w.height },
      popup: w.overrideRedirect, owner,
    });
  }
  return out;
}

type Bound = (...args: unknown[]) => unknown;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GW_OWNER = 4;
const requireCjs = createRequire(__filename);

/**
 * The real probe on Windows (null elsewhere, or when koffi or a library can't be loaded). The libraries are bound on
 * the first call, once.
 */
export function openRailProbe(os: OS): RailProbe | null {
  if (os !== "win32") return null;
  let fns: { open: Bound; close: Bound; image: Bound; getWindow: Bound } | null | undefined;
  const bind = () => {
    if (fns !== undefined) return fns;
    fns = null;
    try {
      const koffi = requireCjs("koffi") as typeof import("koffi");
      const kernel32 = koffi.load("kernel32.dll"), user32 = koffi.load("user32.dll");
      fns = {
        open: kernel32.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)") as Bound,
        close: kernel32.func("int __stdcall CloseHandle(void *handle)") as Bound,
        image: kernel32.func("int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *buf, _Inout_ uint32_t *size)") as Bound,
        getWindow: user32.func("void * __stdcall GetWindow(void *hwnd, uint32_t cmd)") as Bound,
      };
    } catch {
      fns = null; // no koffi or no library: no RAIL window is taken for WSLg's
    }
    return fns;
  };
  return {
    imagePath(pid) {
      const f = bind();
      if (!f || !pid) return null;
      const process = f.open(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!process) return null;
      try {
        const units = 4096, buf = Buffer.alloc(units * 2), size = [units];
        return f.image(process, 0, buf, size) ? readUtf16(buf, size[0]) : null;
      } finally {
        f.close(process);
      }
    },
    owner(hwnd) {
      const f = bind();
      return f && hwnd ? hwndOf(f.getWindow(hwnd, GW_OWNER)) : 0;
    },
  };
}
