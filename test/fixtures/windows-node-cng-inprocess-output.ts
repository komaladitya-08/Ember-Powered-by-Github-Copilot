/** Classify one pinned CLI message against the host's exact fixed test filename; never return text or paths. */
import path from "node:path/win32";

/** 0 unknown/empty output; 1 exact Node22 CLI test-file discovery refusal. No execution or cleanup authority. */
export function classifyWindowsNodeCngInprocessOutput(bytes: Buffer, fixedTestFile: string, selectedPattern = fixedTestFile): 0 | 1 {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024 || typeof fixedTestFile !== "string" ||
      fixedTestFile.length < 1 || fixedTestFile.length > 32767 || !/^[A-Za-z]:\\/.test(fixedTestFile) ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(fixedTestFile) || path.normalize(fixedTestFile) !== fixedTestFile) return 0;
  if (typeof selectedPattern !== "string" || selectedPattern !== fixedTestFile &&
      (path.basename(path.dirname(fixedTestFile)) !== "tools" || !/^(?:host|lpac)-cng-inprocess\.test\.cjs$/.test(path.basename(fixedTestFile)) ||
       selectedPattern !== `..\\tools\\${path.basename(fixedTestFile)}`)) return 0;
  // The host route builder verifies the relative form resolves to this same pinned absolute file.
  // Pinned runner.js:122 prints the exact CLI pattern and exits before importing a test file.
  const message = `Could not find '${selectedPattern}'`;
  return bytes.equals(Buffer.from(message + "\n", "utf8")) || bytes.equals(Buffer.from(message + "\r\n", "utf8")) ? 1 : 0;
}
