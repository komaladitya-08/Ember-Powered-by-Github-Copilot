// Runs the integration suites (test/integration/**, which vitest.config.ts includes when EMBER_INTEGRATION is set)
// with vitest, on any OS: `EMBER_INTEGRATION=1 vitest run` is POSIX shell syntax that cmd.exe, npm's shell on
// Windows, can't run. Arguments go to vitest; the test files named among them must exist, or nothing runs (a renamed
// file would otherwise skip silently). --allow-missing drops the named files that don't exist yet, with a warning,
// and runs nothing if none are left.
// usage: node scripts/run-integration.mjs [--allow-missing] [vitest options] [test files]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const allowMissing = args.includes("--allow-missing");
const isFile = a => !a.startsWith("-") && /\.[cm]?[jt]sx?$/.test(a);
const rest = args.filter(a => a !== "--allow-missing");
const absent = rest.filter(a => isFile(a) && !fs.existsSync(path.resolve(root, a)));
if (absent.length && !allowMissing) {
  console.error(`no such test file: ${absent.join(", ")} (--allow-missing skips files that don't exist yet)`);
  process.exit(2);
}
for (const a of absent) console.warn(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "warning: "}${a} doesn't exist yet: not run`);
// vitest matches file filters against forward-slash paths, also on Windows.
const vitestArgs = rest.filter(a => !absent.includes(a)).map(a => (isFile(a) ? a.split(path.sep).join("/") : a));
if (rest.some(isFile) && !vitestArgs.some(isFile)) {
  console.log("none of the named test files exist yet: nothing to run");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const vitestPkg = require.resolve("vitest/package.json");
const bin = JSON.parse(fs.readFileSync(vitestPkg, "utf8")).bin;
const cli = path.join(path.dirname(vitestPkg), typeof bin === "string" ? bin : bin.vitest);
const child = spawn(process.execPath, [cli, "run", ...vitestArgs], { cwd: root, stdio: "inherit", env: { ...process.env, EMBER_INTEGRATION: "1" } });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
