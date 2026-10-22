/**
 * The link worker thread (§5.1.12; owned by package SA): owns one link's ssh child, mux, pings and escalation, off
 * Electron's main thread. Built to dist/app/remote-link.cjs. STUB from Step 0a: it reports the link closed at once.
 */

import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ state: "closed" });
