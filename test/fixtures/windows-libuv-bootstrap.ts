/** Closed numeric bootstrap facts from the fixed C program, never arbitrary exit text or paths. */
export function windowsLibuvBootstrapFacts(exitCode: number) {
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffffffff) return undefined;
  if (exitCode === 0xe1ffffff || exitCode === 0xe2ffffff) return Object.freeze({
    directory: exitCode === 0xe1ffffff ? "work" as const : "state" as const,
    operation: "GetFileAttributesW" as const, error: "out-of-range" as const,
  });
  if ((exitCode >>> 24) !== 0xe1 || (exitCode & 0x00800000) !== 0) return undefined;
  const directory = (exitCode >>> 16) & 3, flags = (exitCode >>> 18) & 31;
  if (directory !== 1 && directory !== 2 || (flags & 2) !== 0 && (flags & 1) === 0 ||
      (flags & (8 | 16)) !== 0 && (flags & 4) === 0) return undefined;
  return Object.freeze({ directory: directory === 1 ? "work" as const : "state" as const,
    operation: "GetFileAttributesW" as const, error: exitCode & 0xffff,
    currentDirectoryRead: (flags & 1) !== 0, currentDirectoryMatches: (flags & 2) !== 0,
    attributesHandleOpened: (flags & 4) !== 0, ordinaryDirectory: (flags & 8) !== 0,
    attributesHandleClosed: (flags & 16) !== 0,
  });
}
