/** Classify one pinned CLI message against the host's exact fixed test filename; never return text or paths. */
import path from "node:path/win32";

/** 0 unknown/empty output; 1 exact Node22 CLI test-file discovery refusal. No execution or cleanup authority. */
export function classifyWindowsNodeCngInprocessOutput(bytes: Buffer, fixedTestFile: string): 0 | 1 {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 64 * 1024 || typeof fixedTestFile !== "string" ||
      fixedTestFile.length < 1 || fixedTestFile.length > 32767 || !/^[A-Za-z]:\\/.test(fixedTestFile) ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(fixedTestFile) || path.normalize(fixedTestFile) !== fixedTestFile) return 0;
  // Pinned runner.js:122 prints this exact known pattern and exits before importing a test file.
  const message = `Could not find '${fixedTestFile}'`;
  return bytes.equals(Buffer.from(message + "\n", "utf8")) || bytes.equals(Buffer.from(message + "\r\n", "utf8")) ? 1 : 0;
}
