/** Closed observations for the synthetic native UIA focus experiment; no input or native authority. */
import { types } from "node:util";

const own = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key); return property && Object.hasOwn(property, "value") ? property.value : undefined;
};
export function sameNativeFocusTarget(value: unknown, target: unknown): boolean {
  const runtime = own(value, "runtimeId"), pid = own(value, "pid");
  return !!runtime && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && runtime === own(target, "runtimeId") && pid === own(target, "pid")
    && own(value, "automationId") === own(target, "automationId") && own(value, "controlType") === own(target, "controlType");
}
export function nativeFocusObservation(value: unknown, target: unknown, hwnd: number): { focus: number; identity: number; matched: boolean } {
  const element = own(value, "element"), runtime = own(element, "runtimeId"), pid = own(element, "pid"), wantedRuntime = own(target, "runtimeId"), wantedPid = own(target, "pid");
  const runtimeValid = typeof runtime === "string" && !!runtime, wantedRuntimeValid = typeof wantedRuntime === "string" && !!wantedRuntime;
  const pidValid = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0, wantedPidValid = typeof wantedPid === "number" && Number.isSafeInteger(wantedPid) && wantedPid > 0;
  // The packaged driver's exact runtime/PID/automation-ID/control-type identity conjuncts, not a looser focus guard.
  const same = sameNativeFocusTarget(element, target);
  const focus = (own(value, "hwnd") === hwnd ? 1 : 0) | (element ? 2 : 0) | (same ? 4 : 0) | (own(element, "hasKeyboardFocus") === true ? 8 : 0);
  const identity = (wantedRuntimeValid ? 1 : 0) | (runtimeValid ? 2 : 0) | (wantedRuntimeValid && runtimeValid && runtime === wantedRuntime ? 4 : 0)
    | (wantedPidValid ? 8 : 0) | (pidValid ? 16 : 0) | (wantedPidValid && pidValid && pid === wantedPid ? 32 : 0)
    | (typeof own(element, "automationId") === "string" && own(element, "automationId") === own(target, "automationId") ? 64 : 0)
    | (typeof own(element, "controlType") === "string" && own(element, "controlType") === own(target, "controlType") ? 128 : 0);
  return { focus, identity, matched: focus === 15 };
}

/** Real OS bootstrap only. No credentials, Electron/Node injection, runtime override or sandbox switch is inherited. */
export function nativeFocusEnvironment(base: NodeJS.ProcessEnv, profile: string, temporary: string): NodeJS.ProcessEnv {
  const allowed = /^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES)$/i;
  return { ...Object.fromEntries(Object.entries(base).filter(([key, value]) => typeof value === "string" && allowed.test(key))),
    EMBER_UIA_FOCUS_PROFILE: profile, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
}
