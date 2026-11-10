#!/usr/bin/env node
// `ember` / `ember-copilot`: see ../lib/launcher.mjs.
import { main } from "../lib/launcher.mjs";

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`ember-copilot: ${err instanceof Error ? err.message : String(err)}\n`);
  // A stop by Ctrl+C or a closed terminal ends with that signal's usual code (130 for Ctrl+C).
  process.exitCode = typeof err?.exitCode === "number" ? err.exitCode : 1;
});
