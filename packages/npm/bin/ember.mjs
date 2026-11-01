#!/usr/bin/env node
// `ember` / `ember-copilot`: see ../lib/launcher.mjs.
import { main } from "../lib/launcher.mjs";

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`ember-copilot: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
