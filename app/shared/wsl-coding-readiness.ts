/** Separate release gate: Linux helper checks do not qualify Windows/WSL interop isolation. */
export const WSL_CODING_READINESS = Object.freeze({
  ready: true,
  proofCommit: "20300c7104003cbb865871821454b7807d0178ab",
  proofRun: 44110658272,
  message: "Supported Node, npm and TypeScript commands are available in your selected WSL2 distribution. That distribution's consent and approval settings still apply.",
} as const);
