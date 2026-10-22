/**
 * The administrator's policy on Windows (D7): JSON in HKLM\SOFTWARE\Policies\Ember, value PolicyJson (REG_SZ, or the
 * REG_MULTI_SZ an ADMX multiText element writes, joined with "\n"). Only administrators and SYSTEM can write under
 * HKLM\SOFTWARE\Policies by its default ACL, so no ACL check is needed; the POSIX owner/mode test is never used here
 * (Node reports uid 0 and mode 0o666 for every Windows file, so it would pass for a file any user planted). Fail
 * closed on everything but "not there": an unreadable value, one of another type, one over 256 KiB, bad JSON, a
 * schema error, a missing advapi32 or a provider.apiKeyFile (which Windows doesn't support) all lock Ember down.
 */

import { AdminPolicySchema, loadAdminPolicy, type AdminPolicy, type LoadedAdminPolicy } from "../../../admin";
import type { AdminPolicySource } from "../../types";
import type { Win32SysApi } from "./ffi";
import { lockedDown, parseAdminPolicy } from "./interim";
import { describeFailure, HKEY, readString, RRF } from "./registry";

export const POLICY_KEY = "SOFTWARE\\Policies\\Ember";
export const POLICY_LOCATION = "HKLM\\SOFTWARE\\Policies\\Ember (PolicyJson)";
/** The largest policy read (a policy is a few kilobytes; anything near this is a mistake or an attack). */
export const MAX_POLICY_BYTES = 256 * 1024;
export const APIKEY_FILE_REFUSED = "provider.apiKeyFile isn't supported on Windows: put the key in the ProviderApiKey value of HKLM\\SOFTWARE\\Policies\\Ember";

/** The Windows admin policy source over the registry API (null: advapi32 couldn't be loaded). */
export function win32AdminPolicy(o: { api: () => Win32SysApi | null; env: NodeJS.ProcessEnv }): AdminPolicySource {
  return {
    location: POLICY_LOCATION,
    load(devOverride?: string): LoadedAdminPolicy {
      // Development only (main passes EMBER_ADMIN_POLICY only when unpackaged): a file, without the root-owner check.
      if (devOverride !== undefined) return loadAdminPolicy(devOverride, { requireRootOwned: false });
      const api = o.api();
      if (!api) return lockedDown(POLICY_LOCATION, "Ember couldn't read the Windows registry, so it can't tell whether a policy applies");
      const r = readString(api, HKEY.LOCAL_MACHINE, POLICY_KEY, "PolicyJson", {
        flags: RRF.RT_REG_SZ | RRF.RT_REG_MULTI_SZ | RRF.SUBKEY_WOW6464KEY, maxBytes: MAX_POLICY_BYTES,
      });
      if (!r.ok) {
        if (r.error === "not-found") return { policy: AdminPolicySchema.parse({}), source: null };
        if (r.error === "too-large") return lockedDown(POLICY_LOCATION, `PolicyJson is larger than ${MAX_POLICY_BYTES / 1024} KiB`);
        if (r.error === "wrong-type") return lockedDown(POLICY_LOCATION, "PolicyJson must be a string (REG_SZ) or a multi-string (REG_MULTI_SZ) value");
        return lockedDown(POLICY_LOCATION, `can't read ${POLICY_LOCATION}: ${describeFailure(r)}`);
      }
      const loaded = parseAdminPolicy(r.value, POLICY_LOCATION);
      if (!loaded.error && loaded.policy.provider?.apiKeyFile !== undefined) return lockedDown(POLICY_LOCATION, APIKEY_FILE_REFUSED);
      return loaded;
    },
    providerApiKey(_p: NonNullable<AdminPolicy["provider"]>): string | undefined {
      // (apiKeyFile never gets here: load() locks a policy with one down.)
      const api = o.api();
      if (!api) throw new Error("Ember couldn't read the Windows registry for the provider's API key");
      const r = readString(api, HKEY.LOCAL_MACHINE, POLICY_KEY, "ProviderApiKey", { flags: RRF.RT_REG_SZ | RRF.SUBKEY_WOW6464KEY, maxBytes: 64 * 1024 });
      if (r.ok) return r.value.trim();
      if (r.error === "not-found") return o.env.EMBER_PROVIDER_API_KEY || undefined;
      throw new Error(`can't read the ProviderApiKey value: ${describeFailure(r)}`);
    },
  };
}
