/** Fixed fixture routing only; this creates no filesystem, command or grant authority. */
import path from "node:path/win32";

const canonical = (value: string) => typeof value === "string" && value.length <= 32767 && /^[A-Za-z]:\\/.test(value) &&
  !value.endsWith("\\") && !/[\p{Cc}\p{Cf}\p{Cs}<>"|?*]/u.test(value) && !value.slice(2).includes(":") && path.normalize(value) === value &&
  value.split("\\").every(part => !/[. ]$/.test(part));

export function windowsNodeCngInprocessTestRoute(work: string, tools: string, role: "host" | "lpac") {
  const refuse = (): never => { throw new Error("The fixed test route must stay in the known owned fixture tree."); };
  if (!canonical(work) || !canonical(tools) || role !== "host" && role !== "lpac" ||
      path.basename(work) !== "work" || path.basename(tools) !== "tools" || path.dirname(work) !== path.dirname(tools)) refuse();
  const file = path.join(tools, `${role}-cng-inprocess.test.cjs`), pattern = `..\\tools\\${role}-cng-inprocess.test.cjs`;
  if (path.relative(work, file) !== pattern || path.resolve(work, pattern) !== file) refuse();
  return Object.freeze({ file, pattern });
}
