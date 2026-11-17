/** Separate release gate: Linux helper checks do not qualify Windows/WSL interop isolation. */
export const WSL_CODING_READINESS = Object.freeze({
  ready: false,
  proofCommit: null,
  proofRun: null,
  message: "WSL coding is being prepared. Windows isolation verification must pass before it can run. Use This computer for the available coding tools.",
} as const);
