/** A real launcher loses its authority with its lease, without signalling any pid from a persisted file. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { build } from "esbuild";
import { appEnv } from "../../app/main/hands/system";
import { PassThrough } from "node:stream";
import { BRIDGE_WORDS, bridge } from "../../app/main/extensions/launch";

let dir: string;
let launcher: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-launch-lease-"));
  launcher = path.join(dir, "launch.cjs");
  await build({ entryPoints: ["app/main/extensions/launch.ts"], outfile: launcher, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["koffi"], logLevel: "silent" });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function launch(revoked = false, ignoresStop = false) {
  const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
  if (!revoked) fs.writeFileSync(leaseFile, "", { mode: 0o600 });
  // Its first line is a message, as a server's are: the launcher passes on nothing else (integrations-x9-1).
  const spec = { command: process.execPath, args: ["-e", `${ignoresStop ? 'process.on("SIGTERM", () => {});' : ""}process.stdout.write('{"jsonrpc":"2.0","method":"notifications/message"}\\n'); setInterval(() => {}, 1000);`], env: {}, cwd: dir, runDir: dir, leaseFile, group: os.platform() !== "win32" };
  const child = spawn(process.execPath, [launcher], { env: { ...process.env, NODE_PATH: path.resolve("node_modules"), EMBER_MCP_SPEC: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "pipe"] });
  return { child, leaseFile };
}

describe("extension launch leases", () => {
  it("refuses a server whose lease was removed before the runtime started its launcher", async () => {
    const { child } = launch(true);
    let output = "";
    child.stdout.on("data", data => { output += data; });
    const [code] = await once(child, "exit");
    expect(code).toBe(2);
    expect(output).toBe("");
  });

  it.each([false, true])("ends a running server promptly when removed, even if it ignores Stop: %s", async ignoresStop => {
    const { child, leaseFile } = launch(false, ignoresStop);
    const exited = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const start = performance.now();
      fs.rmSync(leaseFile);
      await exited;
      // The kill-switch budget is 300 ms; allow scheduling slack on shared CI machines.
      expect(performance.now() - start).toBeLessThan(1500);
    } finally {
      fs.rmSync(leaseFile, { force: true });
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});

describe("the launcher between the runtime and a real server (integrations-x9-1)", () => {
  // A server that answers each request, says with each that its tool list changed, prints a stray line, and on
  // "quit" says its last words and ends with its own code.
  const SERVER = [
    'const send = o => process.stdout.write(JSON.stringify(o) + "\\n");',
    'require("readline").createInterface({ input: process.stdin }).on("line", line => {',
    "  const m = JSON.parse(line);",
    '  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });',
    '  process.stdout.write("Listening on stdio\\n");',
    '  send({ jsonrpc: "2.0", id: m.id, result: { heard: m.method, text: "x".repeat(m.params?.size ?? 0) } });',
    // It ends once its own output is written out (a process that exits with a pipe still full cuts its last lines itself).
    '  if (m.method === "quit") { send({ jsonrpc: "2.0", method: "notifications/message", params: { last: true } }); process.stdout.write("", () => process.exit(5)); }',
    "});",
  ].join("\n");
  const run = async (requests: object[]) => {
    const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
    fs.writeFileSync(leaseFile, "", { mode: 0o600 });
    const spec = { command: process.execPath, args: ["-e", SERVER], env: {}, cwd: dir, runDir: dir, leaseFile, group: os.platform() !== "win32" };
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, NODE_PATH: path.resolve("node_modules"), EMBER_MCP_SPEC: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    const [code] = await once(child, "close");
    return { code, lines: output.split("\n").filter(Boolean).map(l => JSON.parse(l) as { id?: number; method?: string; result?: { heard: string; text: string } }), leaseLeft: fs.existsSync(leaseFile) };
  };

  it("gives the runtime the server's answers and never its notice that its tool list changed, nor a stray line", async () => {
    const { code, lines, leaseLeft } = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { size: 3 * 1024 * 1024 } }, { jsonrpc: "2.0", id: 3, method: "quit" }]);
    // Each request reached the server as it was, and each answer came back whole, a 3 MB one too.
    expect(lines.map(l => l.id ?? l.method)).toEqual([1, 2, 3, "notifications/message"]);
    expect(lines.map(l => l.result?.heard)).toEqual(["tools/list", "tools/call", "quit", undefined]);
    expect(lines[1].result?.text.length).toBe(3 * 1024 * 1024);
    // The server's last words were passed on before the launcher ended with the server's own code.
    expect(code).toBe(5);
    expect(leaseLeft).toBe(false);
  });
});

describe("the launcher between the runtime and a remote server (integrations-c9-4)", () => {
  // A streamable-HTTP server on loopback: JSON answers, an event stream for tools/call, its notice that its list
  // changed with each, and a 307 to another listener for tools/call once `redirect` is set.
  const seen: { at: string; method?: string; session?: string; protocol?: string; key?: string; body: string }[] = [];
  let redirect = false;
  let server: http.Server, other: http.Server, url = "", elsewhere = "";
  const listen = (s: http.Server) => new Promise<string>(r => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
  beforeAll(async () => {
    other = http.createServer(async (req, res) => {
      let b = ""; for await (const c of req) b += c;
      seen.push({ at: "other", key: String(req.headers["x-plugin-key"] ?? ""), body: b });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(b).id, result: { content: [{ type: "text", text: "from the other host" }] } }));
    });
    server = http.createServer(async (req, res) => {
      let b = ""; for await (const c of req) b += c;
      const m = JSON.parse(b) as { id?: number; method?: string };
      seen.push({ at: "server", method: m.method, session: req.headers["mcp-session-id"] as string | undefined, protocol: req.headers["mcp-protocol-version"] as string | undefined, key: String(req.headers["x-plugin-key"] ?? ""), body: b });
      const notice = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
      if (m.id === undefined) { res.writeHead(202); res.end(); return; }
      if (m.method === "tools/call" && redirect) { res.writeHead(307, { location: `${elsewhere}/elsewhere` }); res.end(); return; }
      if (m.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(notice)}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sunny" }] } })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", ...(m.method === "initialize" ? { "mcp-session-id": "sess-1" } : {}) });
      res.end(JSON.stringify(m.method === "initialize" ? { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "web", version: "1" } } } : [notice, { jsonrpc: "2.0", id: m.id, result: { tools: [] } }]));
    });
    url = `${await listen(server)}/mcp`;
    elsewhere = (await listen(other)).replace("127.0.0.1", "localhost");
  });
  afterAll(() => { server.close(); other.close(); });

  const run = async (requests: object[]) => {
    const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
    fs.writeFileSync(leaseFile, "", { mode: 0o600 });
    const spec = { command: "", args: [], env: {}, cwd: dir, runDir: dir, leaseFile, group: os.platform() !== "win32", remote: { url, headers: { "x-plugin-key": "PLUGINKEY" } } };
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, NO_PROXY: "*", no_proxy: "*", NODE_PATH: path.resolve("node_modules"), EMBER_MCP_SPEC: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    // One at a time, as the runtime sends them: each waits for the answer before the next goes.
    for (const r of requests) {
      const lines = output.split("\n").filter(Boolean).length;
      child.stdin.write(`${JSON.stringify(r)}\n`);
      if ((r as { id?: number }).id === undefined) continue;
      const t0 = Date.now();
      while (output.split("\n").filter(Boolean).length === lines && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
    }
    child.stdin.end();
    const [code] = await once(child, "close");
    return { code, lines: output.split("\n").filter(Boolean).map(l => JSON.parse(l) as { id?: number; method?: string; result?: unknown; error?: { message: string } }) };
  };
  const SESSION = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "copilot", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];

  it("posts the runtime's messages to the server's own address, with its session, and never passes on its notice that its list changed", async () => {
    seen.length = 0;
    redirect = false;
    const { code, lines } = await run([...SESSION, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lookup", arguments: { q: "x" } } }]);
    expect(code).toBe(0);
    expect(lines.map(l => l.id ?? l.method)).toEqual([1, 2, 3]);
    expect(lines[2].result).toEqual({ content: [{ type: "text", text: "sunny" }] });
    expect(seen.map(s => [s.at, s.method, s.session ?? null, s.key])).toEqual([
      ["server", "initialize", null, "PLUGINKEY"], ["server", "notifications/initialized", "sess-1", "PLUGINKEY"],
      ["server", "tools/list", "sess-1", "PLUGINKEY"], ["server", "tools/call", "sess-1", "PLUGINKEY"],
    ]);
    expect(seen.slice(1).every(s => s.protocol === "2025-06-18")).toBe(true);
  });

  it("refuses a server's redirect to another host: the header and the call's arguments never reach it, and the runtime hears why (integrations-c9-4)", async () => {
    seen.length = 0;
    redirect = true;
    const { lines } = await run([...SESSION, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lookup", arguments: { q: "second secret" } } }]);
    expect(seen.filter(s => s.at === "other")).toEqual([]);
    expect(lines.find(l => l.id === 3)).toMatchObject({ error: { message: expect.stringMatching(/sent Ember to another address/) } });
    expect(JSON.stringify(lines)).not.toContain("from the other host");
  });
});

describe("the bridge's event stream from a remote server (r10-integrations-x10-2)", () => {
  it("drops an event longer than the cap, as a stdio server's line, and tells the runtime the call failed instead of growing without bound", async () => {
    // One event of 200 data lines of 100 characters: 20 KB, with the cap at 1,000.
    const parts = ['data: {"jsonrpc":"2.0","id":1,"result":{"t":['];
    for (let i = 0; i < 200; i++) parts.push(`data: "${"x".repeat(100)}",`);
    parts.push('data: "end"]}}', "", "");
    let pulled = 0;
    const fakeFetch = (async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream({ pull(c) { if (pulled < parts.length) c.enqueue(enc.encode(`${parts[pulled++]}\n`)); else c.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const input = new PassThrough(), output = new PassThrough();
    let out = "";
    output.on("data", d => { out += String(d); });
    const done = bridge({ url: "https://a.example/mcp", headers: {} }, { input, output }, { fetch: fakeFetch, signal: new AbortController().signal, max: 1000 });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })}\n`);
    input.end();
    await done;
    const lines = out.split("\n").filter(Boolean);
    expect(Math.max(...lines.map(l => l.length))).toBeLessThan(1000);
    expect(lines.map(l => JSON.parse(l) as unknown)).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: BRIDGE_WORDS.failed } }]);
    // The reader stopped soon after the cap rather than taking the whole event.
    expect(pulled).toBeLessThan(30);
  });
});

describe("the bridge's answer from a remote server with no body (r10-integrations-y10-2)", () => {
  it("tells the runtime a call failed when the server answers it 204, instead of leaving it to wait", async () => {
    const fakeFetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const input = new PassThrough(), output = new PassThrough();
    let out = "";
    output.on("data", d => { out += String(d); });
    const done = bridge({ url: "https://a.example/mcp", headers: {} }, { input, output }, { fetch: fakeFetch, signal: new AbortController().signal, max: 1000 });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} })}\n`);
    input.end();
    await done;
    // The notification wants no answer; the call gets one.
    expect(out.split("\n").filter(Boolean).map(l => JSON.parse(l) as unknown)).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32000, message: BRIDGE_WORDS.failed } }]);
  });
});

describe("extension launch environment (BE audit #1)", () => {
  it("starts the server with only the spec's environment, even when the runtime gives the launcher its whole one, token included", async () => {
    const marks = { COPILOT_SDK_AUTH_TOKEN: "ghu_TESTMARKER_LAUNCH_SDK_0123456789", GITHUB_TOKEN: "ghp_TESTMARKER_LAUNCH_GH_0123456789", GH_ENTERPRISE_TOKEN: "ghe_TESTMARKER_LAUNCH_ENT_0123456789", MY_SERVICE_KEY: "ghu_TESTMARKER_LAUNCH_ODD_0123456789" };
    const leaseFile = path.join(dir, `${crypto.randomUUID()}.lease`);
    fs.writeFileSync(leaseFile, "", { mode: 0o600 });
    const out = path.join(dir, "server-env.json");
    // The spec's environment is built as the extensions service builds it: appEnv() over Ember's (here marker-filled) environment.
    const spec = {
      command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv, env: process.env }))`],
      env: { ...appEnv({ ...process.env, ...marks }, { session: false }) as Record<string, string>, ELECTRON_RUN_AS_NODE: "1" },
      cwd: dir, runDir: dir, leaseFile, group: os.platform() !== "win32",
    };
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, ...marks, NODE_PATH: path.resolve("node_modules"), EMBER_MCP_SPEC: JSON.stringify(spec) }, stdio: "ignore" });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    const server = fs.readFileSync(out, "utf8");
    for (const v of Object.values(marks)) expect(server).not.toContain(v);
    for (const k of Object.keys(marks)) expect(Object.keys((JSON.parse(server) as { env: object }).env)).not.toContain(k);
  });
});
