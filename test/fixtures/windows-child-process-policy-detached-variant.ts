/** Fixed root-only run variant: the same C compilation recipe and compiled issuer, with a separate run identity. */
import { LPAC_CREATE_FLAGS } from "../../app/main/agent/experimental-windows-lpac-api";

export const WINDOWS_CHILD_POLICY_DETACHED_VARIANT = Object.freeze({
  schema: 1,
  issuer: "ember-experimental-windows-child-policy-detached-root-fixed-probe",
  compiledIssuer: "ember-experimental-windows-child-process-policy-fixed-probe",
  kind: "detached-roots-only",
  originalRootCreateFlags: 0x08080404,
  rootCreateFlags: 0x0008040c,
  caseIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8] as const),
});
if (LPAC_CREATE_FLAGS !== WINDOWS_CHILD_POLICY_DETACHED_VARIANT.originalRootCreateFlags)
  throw new Error("The detached-root comparison requires the unchanged original root flag contract.");
