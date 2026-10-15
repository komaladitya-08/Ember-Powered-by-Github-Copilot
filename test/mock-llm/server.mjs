// A small OpenAI-compatible chat-completions server for offline, deterministic
// agent tests. Point the Copilot SDK at it with a BYOK provider:
//   { type: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test" }
//
// Default behaviour (override with `respond`):
//   - if the last user message contains CALLTOOL:<name>{json} and no tool result
//     has come back yet, the model calls that tool;
//   - otherwise it streams a short reply, preceded by "reasoning" text.
import http from "node:http";

/**
 * @typedef {{ role: string, content: unknown, tool_calls?: unknown[], tool_call_id?: string }} Message
 * @typedef {{ text?: string, reasoning?: string, tool?: { name: string, args?: object } }} Reply
 * @param {{ port?: number, delayMs?: number, respond?: (messages: Message[], tools: string[]) => Reply }} [opts]
 */
export async function startMockLlm(opts = {}) {
  const requests = [];
  const delayMs = opts.delayMs ?? 30;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const defaultRespond = messages => {
    const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
    const tail = messages.slice(lastAssistant + 1);
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const call = /CALLTOOL:([A-Za-z0-9_-]+)(\{[^}]*\})?/.exec(text);
    if (call && tail.every(m => m.role !== "tool")) return { tool: { name: call[1], args: JSON.parse(call[2] ?? "{}") } };
    const after = tail.some(m => m.role === "tool") ? "Done. I used my tool." : `You said: ${text.replace(/<[^>]+>/g, "").slice(-80)}`;
    return { reasoning: "Let me think about that for a moment.", text: after };
  };

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    let json = {};
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    const messages = json.messages ?? [];
    const tools = (json.tools ?? []).map(t => t.function?.name).filter(Boolean);
    requests.push({ messages, tools, model: json.model });
    const reply = (opts.respond ?? defaultRespond)(messages, tools);
    const id = `cmpl-${requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null, usage) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    const usage = { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 };

    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      const message = reply.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${requests.length}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args ?? {}) } }] }
        : { role: "assistant", content: reply.text ?? "" };
      res.end(JSON.stringify({ id, object: "chat.completion", created, model: json.model, choices: [{ index: 0, message, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (reply.reasoning) {
      for (const word of reply.reasoning.split(/(?<= )/)) {
        res.write(chunk({ role: "assistant", reasoning_content: word, reasoning: word }));
        await sleep(delayMs);
      }
    }
    if (reply.tool) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args ?? {}) } }] }));
      res.write(chunk({}, "tool_calls", usage));
    } else {
      for (const word of (reply.text ?? "").split(/(?<= )/)) {
        res.write(chunk({ role: "assistant", content: word }));
        await sleep(delayMs);
      }
      res.write(chunk({}, "stop", usage));
    }
    res.end("data: [DONE]\n\n");
  });

  await new Promise(resolve => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
