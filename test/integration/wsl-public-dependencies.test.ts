/** Real helper/engine/npm dependency cache proof; Windows interop qualification remains a separate gate. */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { decodeCodingReviewExport } from "../../app/main/agent/coding-result-export";
import { createWslPublicDependencyFixture as fixture, publicDependencyProject as project } from "../fixtures/coding/wsl-public-dependencies";

const required = process.env.EMBER_WSL_PUBLIC_DEPENDENCIES_TEST === "1";

it.skipIf(!required)("approves exact baseline and changed sets, installs offline, builds/fails/repairs/tests, stops descendants and transfers only source outputs", async ctx => {
  const f = await fixture(ctx);
  try {
    const files = await f.workspace.filesBroker(f.task.signal); let output = "";
    const run = (command: string) => f.workspace.run(command, "/work", bytes => { output += Buffer.from(bytes).toString(); }, f.task.signal, "bash");
    expect(f.fetches).toBe(0);
    expect(await f.workspace.preparePublicDependencies(async request => { expect(request.kind).toBe("baseline"); expect(request.packages).toEqual([{ name: "picocolors", version: "1.1.1" }]); expect(f.fetches).toBe(0); f.events.push("approved:baseline"); return true; }, f.task.signal)).toMatchObject({ prepared: true, packages: 1 });
    expect(f.events.slice(0, 2)).toEqual(["approved:baseline", "fetch:picocolors"]);
    expect(await run("npm ci --offline && test -f hook-ran && npm run build")).toMatchObject({ observed: true, exitCode: 0 });
    expect(await run("env node -e 'require(\"node:assert/strict\").equal(process.env.NPM_CONFIG_CACHE,\"/opt/ember-public-cache\")' && mkdir tool-control && printf ordinary > tool-control/a && cp tool-control/a tool-control/b && mv tool-control/b tool-control/c && touch tool-control/d && chmod 600 tool-control/c && ln -s c tool-control/link && test -f tool-control/link && ls tool-control > /tmp/tool-list && rm -r tool-control")).toMatchObject({ observed: true, exitCode: 0 });
    expect(await run("npm test")).toMatchObject({ observed: true, exitCode: 1 });
    await files.replaceText("src/result.ts", "'wrong'", "'ready'");
    expect(await run("npm run build && npm test")).toMatchObject({ observed: true, exitCode: 0 });
    const changed = project(true); await files.writeText("package.json", changed.pkg); await files.writeText("package-lock.json", changed.lock);
    const fetched = f.fetches;
    await expect(f.workspace.preparePublicDependencies(async request => { expect(request.kind).toBe("changed"); expect(request.packageCount).toBe(2); return false; }, f.task.signal)).rejects.toThrow();
    expect(f.fetches).toBe(fetched);
    expect(await f.workspace.preparePublicDependencies(async request => { expect(request.kind).toBe("changed"); expect(request.packages.map(p => p.name)).toEqual(["picocolors", "yocto-queue"]); f.events.push("approved:changed"); return true; }, f.task.signal)).toMatchObject({ prepared: true, packages: 2 });
    expect(await run("npm ci --offline && npm run build && npm test && node -e 'const Q=require(\"yocto-queue\");const q=new Q();q.enqueue(42);require(\"node:assert/strict\").equal(q.dequeue(),42)'")).toMatchObject({ observed: true, exitCode: 0 });
    expect(output).toContain("public dependency value");
    await files.writeText("writer.cjs", "const f=require('node:fs'),{spawn}=require('node:child_process');if(process.argv[2]==='child'){f.appendFileSync('child-writer','x');process.stdout.write('ready\\n');setInterval(()=>f.appendFileSync('child-writer','x'),10)}else{const c=spawn(process.execPath,[__filename,'child'],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>{process.stdout.write('ready\\n');setInterval(()=>f.appendFileSync('parent-writer','x'),10)})}\n");
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    const running = f.workspace.run("node writer.cjs", "/work", bytes => { if (Buffer.from(bytes).toString().includes("ready")) ready(); }, f.task.signal, "bash"); void running.catch(() => undefined);
    await Promise.race([started, new Promise<never>((_r, reject) => { const timer = setTimeout(() => reject(new Error("Writer did not start.")), 5000); timer.unref(); })]);
    await f.workspace.stop(); expect(await running).toMatchObject({ stopped: true });
    await f.workspace.sealForReview(); const exported = await f.workspace.exportReview(f.reviews); f.workspace.transferReview(exported);
    const artifact = await f.store.claim(exported, () => undefined), bytes = await f.store.read(artifact, "review.json", 64 * 1024 * 1024, () => undefined);
    const review = decodeCodingReviewExport(bytes, f.binding);
    expect(review.scope).toMatchObject({ executionProfile: "wsl-public-lock", dependencies: null, publicDependencies: { access: "verified-offline-cache-input", registry: "https://registry.npmjs.org", packages: 2 } });
    expect(review.scope?.publicDependencies?.compressedBytes).toBeGreaterThan(0);
    expect(review.proposed.entries.some(e => e.path === "dist/result.js")).toBe(true);
    expect(review.proposed.entries.some(e => e.path === "node_modules" || e.path.startsWith("node_modules/"))).toBe(false);
    for (const [file, text] of f.original) expect(fs.readFileSync(path.join(f.sourceDir, file), "utf8")).toBe(text);
    await f.store.discard(exported);
  } finally { await f.close(); }
}, 120_000);

it.skipIf(!required)("holds copied source stable while approval waits and drains the retired cache lease before positive Stop", async ctx => {
  const f = await fixture(ctx);
  try {
    const files = await f.workspace.filesBroker(f.task.signal); let approved!: () => void, sawApproval!: () => void;
    const reached = new Promise<void>(resolve => { sawApproval = resolve; }), held = new Promise<void>(resolve => { approved = resolve; });
    const preparing = f.workspace.preparePublicDependencies(async (_request, signal) => { sawApproval(); await Promise.race([held, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]); return !signal.aborted; }, f.task.signal); void preparing.catch(() => undefined);
    await reached; let wrote = false; const queued = files.writeText("must-not-write.txt", "late").then(() => { wrote = true; }); void queued.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(wrote).toBe(false); expect(f.fetches).toBe(0);
    await f.workspace.stop(); await expect(preparing).rejects.toThrow(); await expect(queued).rejects.toThrow(); expect(wrote).toBe(false); expect(f.fetches).toBe(0); approved();
    await expect(f.workspace.preparePublicDependencies(async () => true, f.task.signal)).rejects.toThrow();
  } finally { await f.close(); }
}, 30_000);

it.skipIf(!required)("drains host acquisition and partial accepted guest chunks before reporting Stop", async ctx => {
  let entered!: () => void; const acquiring = new Promise<void>(resolve => { entered = resolve; }); let loan: Buffer | undefined;
  const f = await fixture(ctx, { async read(_artifact, signal) { entered(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); loan = Buffer.alloc(64, 17); return loan; } });
  try {
    const preparing = f.workspace.preparePublicDependencies(async () => true, f.task.signal); void preparing.catch(() => undefined); await acquiring;
    await f.workspace.stop(); await expect(preparing).rejects.toThrow(); expect(loan?.every(byte => byte === 0)).toBe(true);
    await expect(f.connection.call("publicCommit", { lease: "a".repeat(32) })).rejects.toThrow();
  } finally { await f.close(); }
  const partial = await fixture(ctx);
  try {
    const raw = await partial.connection.call("publicBegin") as { lease: string };
    expect(await partial.connection.call("publicChunk", { lease: raw.lease, index: 0, offset: 0, base64: Buffer.alloc(32, 17).toString("base64") })).toEqual({ accepted: true });
    const files = await partial.workspace.filesBroker(partial.task.signal); const queued = files.writeText("late-cache-writer.txt", "late"); void queued.catch(() => undefined);
    await partial.workspace.stop(); await expect(queued).rejects.toThrow();
    await expect(partial.connection.call("publicCommit", { lease: raw.lease })).rejects.toThrow();
  } finally { await partial.close(); }
}, 60_000);
