/**
 * Ember's memory process ("Ember memory", dist/app/memory-embed.cjs): runs the embedding model (./embed-model.ts) off
 * main's thread, so embedding a fact or a question never holds up Ember. Main starts it when memory first needs a
 * vector and ends it after a few idle minutes (./embed-client.ts): the loaded model holds 300 to 400 MB.
 *
 * Messages in: { type: "init", model, vocab } once, then { type: "embed", id, texts }. Out: { type: "ready", loadMs }
 * or { type: "error", message } for the load, and { id, vectors } or { id, error } for each request. It reads only the
 * two model files it is given and sends nothing anywhere but to its parent. An Electron utility process (its
 * parentPort), or a plain Node child (process.send) in tests.
 */

import { loadEmbedModel, type EmbedModel } from "./embed-model";

export type EmbedIn = { type: "init"; model: string; vocab: string } | { type: "embed"; id: number; texts: string[] };
export type EmbedOut = { type: "ready"; loadMs: number } | { type: "error"; message: string } | { id: number; vectors?: Float32Array[]; error?: string };

const port = process.parentPort;
const send = (m: EmbedOut) => (port ? port.postMessage(m) : process.send?.(m));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

let model: Promise<EmbedModel> | null = null;
/** Requests run one at a time, in order: the model has one thread. */
let queue: Promise<void> = Promise.resolve();

function handle(m: EmbedIn): void {
  if (m.type === "init") {
    if (model) return;
    const started = Date.now();
    model = loadEmbedModel({ model: m.model, vocab: m.vocab });
    model.then(() => send({ type: "ready", loadMs: Date.now() - started }), err => send({ type: "error", message: message(err) }));
    return;
  }
  queue = queue.then(async () => {
    try {
      if (!model) throw new Error("the memory model isn't loaded");
      send({ id: m.id, vectors: await (await model).embed(m.texts) });
    } catch (err) {
      send({ id: m.id, error: message(err) });
    }
  });
}

if (port) port.on("message", e => handle(e.data as EmbedIn));
else process.on("message", m => handle(m as EmbedIn));
