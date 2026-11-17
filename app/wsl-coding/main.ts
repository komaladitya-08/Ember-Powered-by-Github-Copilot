/** Packaged credential-free WSL helper entry. No controller, provider or GitHub credential is accepted. */
import { serveWslCodingGuest } from "../main/agent/wsl-coding-guest";

void serveWslCodingGuest({ stdin: process.stdin, stdout: process.stdout, nodePath: process.execPath }).then(
  () => { process.stdout.end(() => process.exit(0)); },
  () => { process.stdout.end(() => process.exit(1)); },
);
