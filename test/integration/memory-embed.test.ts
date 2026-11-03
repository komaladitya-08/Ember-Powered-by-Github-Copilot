/**
 * Better recall on the real model, in the real memory process (dist/app/memory-embed.cjs, so `npm run build` first):
 * a fact told once is found by a question in other words after Ember restarts, from the vectors kept beside
 * memory.json, and the kill switch ends the process at once. Needs the model from `node scripts/memory/bench.mjs`
 * (in .cache/memory, or EMBER_MEMORY_DIR); skipped without it, and EMBER_MEMORY_TEST=1 requires it.
 */

import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EmbedClient, type EmbedChild } from "../../app/main/memory/embed-client";
import { SemanticMemory } from "../../app/main/memory/embed";
import type { EmbedOut } from "../../app/main/memory/embed-process";
import { MemoryService } from "../../app/main/memory/service";
import { MEMORY_MODEL, memoryModelPaths, memoryModelReady } from "../../app/voice/models";

const models = path.resolve(process.env.EMBER_MEMORY_DIR ?? ".cache/memory");
const script = path.resolve("dist/app/memory-embed.cjs");
const ready = memoryModelReady(models) && fs.existsSync(script);
const quiet = { info: () => undefined, warn: () => undefined };

/** The memory process as main starts it, here as a plain Node child (structured clone, as a utility process's port). */
function spawn(children: ReturnType<typeof fork>[]): () => EmbedChild {
  return () => {
    const p = fork(script, [], { serialization: "advanced", stdio: "ignore" });
    children.push(p);
    return {
      postMessage: m => { p.send(m); },
      onMessage: fn => { p.on("message", m => fn(m as EmbedOut)); },
      onExit: fn => { p.on("exit", code => fn(code)); },
      kill: () => { p.kill(); },
    };
  };
}

function ember(dir: string, children: ReturnType<typeof fork>[]) {
  const client = new EmbedClient({ spawn: spawn(children), paths: () => memoryModelPaths(models), log: quiet });
  const embedded: string[] = [];
  const counted = { embed: (t: readonly string[]) => { embedded.push(...t); return client.embed(t); }, stop: () => client.stop() };
  const semantic = new SemanticMemory({ dir, log: quiet, embedder: counted, model: () => MEMORY_MODEL[0].sha256, indexDelayMs: 10, waitMs: 20_000 });
  const memory = new MemoryService({ dir, log: quiet, semantic });
  return { memory, semantic, client, embedded };
}

describe.skipIf(!ready && process.env.EMBER_MEMORY_TEST !== "1")("Better recall on the real model", { timeout: 60_000 }, () => {
  it("finds a fact asked for in other words after a restart, without embedding it again", async () => {
    expect(ready, "run `npm run build` and `node scripts/memory/bench.mjs` first").toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-recall-"));
    const children: ReturnType<typeof fork>[] = [];
    const first = ember(dir, children);
    first.memory.remember("Priya leads the platform team", [{ name: "Priya", kind: "person" }, { name: "User" }], "Priya leads the platform team");
    first.memory.remember("Uses Firefox for browsing", [{ name: "User" }, { name: "Firefox", kind: "app" }], "I use Firefox for browsing");
    first.memory.remember("The dog is a spaniel named Biscuit", [{ name: "Biscuit" }], "The dog is a spaniel named Biscuit");
    first.memory.index();
    await new Promise(resolve => setTimeout(resolve, 50));
    await first.semantic.catchUp();
    expect(first.semantic.size).toBe(3);
    first.memory.stop();
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "memory-vectors.json")).mode & 0o777).toBe(0o600);

    const second = ember(dir, children);
    const block = await second.memory.context("Who is my manager?");
    expect(block.split("\n")[1]).toMatch(/Priya leads the platform team$/);
    // Only the question was embedded: the facts' vectors came from the file.
    expect(second.embedded).toEqual(["Who is my manager?"]);
    second.memory.stop();
  });

  it("ends the memory process at once on the kill switch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-recall-"));
    const children: ReturnType<typeof fork>[] = [];
    const e = ember(dir, children);
    await e.client.embed(["warm up"]);
    expect(e.client.loaded).toBe(true);
    const exited = new Promise(resolve => children[0].once("exit", resolve));
    const t = Date.now();
    e.semantic.stop();
    await exited;
    expect(Date.now() - t).toBeLessThan(300);
    expect(e.client.loaded).toBe(false);
  });
});
