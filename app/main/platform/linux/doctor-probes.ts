/**
 * What `ember doctor` measures on Linux (SystemPlatform.doctorProbes): main.ts's probes moved here unchanged —
 * PulseAudio's microphones, speech-dispatcher, Chromium's sandbox (user namespaces or the setuid helper), inotify
 * watchers and the desk's programs. Every read is injectable so the logic is tested without the machine's state.
 */

import fs from "node:fs";
import path from "node:path";
import type { PlatformDoctorProbes } from "../types";
import { DeskManager } from "../../desk/desk";
import { inotifyUse } from "../../agent/host";
import { execSync, type ExecSync } from "./environment";

export interface LinuxDoctorDeps {
  /** Ember's own binary (chrome-sandbox sits beside it). */
  execPath: string;
  /** SystemPlatform.which on Linux. */
  which: (cmd: string) => string | null;
  exec?: ExecSync;
  readFile?: (file: string) => string;
  stat?: (file: string) => { uid: number; mode: number };
  exists?: (file: string) => boolean;
  fileWatchers?: () => { used: number; max: number } | null;
  desk?: () => { ok: boolean; missing: string[] };
}

/** Where Chromium finds speech-dispatcher's library (spd-say isn't packaged on RHEL 8, so the program alone can't be the test). */
const LIBSPEECHD = ["/usr/lib64/libspeechd.so.2", "/usr/lib/x86_64-linux-gnu/libspeechd.so.2"];

export async function linuxDoctorProbes(d: LinuxDoctorDeps): Promise<PlatformDoctorProbes> {
  const exec = d.exec ?? execSync;
  const readFile = d.readFile ?? (f => fs.readFileSync(f, "utf8"));
  const stat = d.stat ?? (f => fs.statSync(f));
  const exists = d.exists ?? fs.existsSync;
  let microphones: string[] | null;
  try {
    microphones = exec("pactl", ["list", "short", "sources"], { encoding: "utf8", timeout: 3000 })
      .split("\n").map(l => l.split("\t")[1]).filter((n): n is string => !!n && !n.endsWith(".monitor"));
  } catch { microphones = d.which("pactl") !== null ? [] : null; }
  let userNamespaces = false;
  try { userNamespaces = Number(readFile("/proc/sys/user/max_user_namespaces")) > 0; } catch { /* not Linux */ }
  try { if (readFile("/proc/sys/kernel/unprivileged_userns_clone").trim() === "0") userNamespaces = false; } catch { /* not Debian */ }
  let suidHelper = false;
  try { const st = stat(path.join(path.dirname(d.execPath), "chrome-sandbox")); suidHelper = st.uid === 0 && (st.mode & 0o4000) !== 0; } catch { /* none */ }
  return {
    microphones,
    // What Chromium speaks through.
    speechDispatcher: d.which("speech-dispatcher") !== null || LIBSPEECHD.some(f => exists(f)),
    sandbox: { userNamespaces, suidHelper },
    fileWatchers: (d.fileWatchers ?? (() => inotifyUse()))(),
    desk: (d.desk ?? (() => DeskManager.available()))(),
    extra: [],
  };
}
