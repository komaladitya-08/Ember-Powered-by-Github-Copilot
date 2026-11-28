/**
 * Customise's pure parts (app/renderer/code/customise-read.ts and customise-forms.ts): what each SDK result becomes,
 * total over shapes the experimental methods may change, the numbers and sizes the rows show, and the forms' checks
 * (an MCP server's settings with write-only secrets, a rule in the SDK's syntax, plugin and marketplace sources).
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_MCP_FORM, argsFrom, checkMcpForm, folderError, formFromConfig, isWholePath, marketplaceSourceError, mergedConfig, parseRule, pluginSourceError, ruleText,
  urlError, withRule, withoutRule,
} from "../../app/renderer/code/customise-forms";
import * as read from "../../app/renderer/code/customise-read";

describe("Customise's numbers and sizes", () => {
  it("says token counts, sizes and multipliers as a person reads them", () => {
    expect([950, 12_500, 128_000, 400_000, 1_000_000, 1_500_000].map(read.tokenCount)).toEqual(["950", "12.5K", "128K", "400K", "1M", "1.5M"]);
    expect(read.tokenCount(Number.NaN)).toBe("0");
    expect([1, 512, 1536, 3.2 * 1024 ** 2, 18_600_000_000].map(read.byteSize)).toEqual(["1 byte", "512 bytes", "1.5 KB", "3.2 MB", "17 GB"]);
    expect([0, 1, 0.33, 10].map(read.multiplierWords)).toEqual(["Included", "1×", "0.33×", "10×"]);
    expect(read.percent(48_200, 128_000)).toBe(38);
    expect(read.percent(5, 0)).toBe(0);
    expect(read.percent(300, 100)).toBe(100);
  });
  it("says an interval in words", () => {
    expect([30_000, 60_000, 300_000, 7_200_000, 86_400_000, 90_000].map(read.everyWords)).toEqual(["every 30 seconds", "every minute", "every 5 minutes", "every 2 hours", "every day", "every 90 seconds"]);
    expect(read.everyWords(0)).toBe("");
    expect(read.everyWords(90_500)).toBe("about every 2 minutes");
  });
  it("turns an id into words", () => {
    expect(read.wordsOf("networkAccess")).toBe("Network access");
    expect(read.wordsOf("premium_interactions")).toBe("Premium interactions");
    expect(read.whenWords("not a date")).toBe("");
  });
});

describe("Customise's readers", () => {
  it("reads models with their limits, efforts, billing and policy, and drops a model without an id", () => {
    const rows = read.modelRows({ models: [
      { id: "gpt-5.5", name: "GPT-5.5", vendor: "OpenAI", capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 400_000 } }, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", billing: { multiplier: 1 }, policy: { state: "disabled" } },
      { name: "no id" }, "junk",
    ] });
    expect(rows).toEqual([{ id: "gpt-5.5", name: "GPT-5.5", vendor: "OpenAI", context: 400_000, vision: true, efforts: ["low", "high"], defaultEffort: "low", multiplier: 1, policy: "disabled", notices: [] }]);
    expect(read.modelRows(null)).toEqual([]);
    expect(read.currentModel({ modelId: "gpt-5.5", reasoningEffort: "high" })).toEqual({ modelId: "gpt-5.5", effort: "high" });
    expect(read.switchOutcome({ deferred: true, deprecationWarnings: ["old"] })).toEqual({ deferred: true, warning: "old" });
  });

  it("reads providers, their instances, status and models", () => {
    expect(read.providerRows({ providers: [{ adapterId: "ollama", providerKind: "ollama", displayName: "Ollama", automaticDiscovery: { mode: "automatic", networkScope: "loopbackOnly", requiresInput: false, requiresTrust: true } }] }))
      .toEqual([{ adapterId: "ollama", kind: "ollama", name: "Ollama", discovery: "automatic", network: "loopbackOnly", needsInput: false, needsTrust: true }]);
    const ref = { adapterId: "ollama", providerKind: "ollama", id: "ollama:x", managementEndpoint: "http://127.0.0.1:11434" };
    expect(read.providerInstances({ outcome: { code: "success" }, instances: [{ reference: ref, displayName: "Local" }, { displayName: "no reference" }] }))
      .toEqual({ outcome: "success", instances: [{ reference: ref, id: "ollama:x", name: "Local", endpoint: "http://127.0.0.1:11434" }] });
    expect(read.providerInstances({}).outcome).toBe("failed");
    expect(read.providerStatus({})).toEqual({ status: "unknown" });
    expect(read.providerModels({ models: [{ id: "q", sizeBytes: 10 }] })).toEqual([{ id: "q", name: "q", size: 10 }]);
  });

  it("reads configured MCP servers with the names of their variables and headers, never their values", () => {
    const { rows, raw } = read.mcpConfigured({ servers: {
      b: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer secret" } },
      a: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "secret", HOME_DIR: "/x" } },
      broken: "not an object",
    } });
    expect(rows.map(r => r.name)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ kind: "stdio", command: "npx", args: ["-y", "pkg"], envNames: ["HOME_DIR", "TOKEN"], headerNames: [] });
    expect(rows[1]).toMatchObject({ kind: "http", url: "https://x.example/mcp", headerNames: ["Authorization"] });
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(raw.a.env).toEqual({ TOKEN: "secret", HOME_DIR: "/x" });
  });

  it("reads the session's servers and follows status events, leaving a failure's own text out", () => {
    const live = read.mcpLive({ servers: [{ name: "a", status: "connected" }, { name: "b", status: "failed", error: "ECONNREFUSED 127.0.0.1" }, { name: "c", status: "weird" }] });
    expect(live).toEqual([{ name: "a", status: "connected", failed: false }, { name: "b", status: "failed", failed: true }, { name: "c", status: "unknown", failed: false }]);
    expect(JSON.stringify(live)).not.toContain("ECONNREFUSED");
    const next = read.mcpStatusChanged(live, { serverName: "a", status: "stopped" });
    expect(next[0].status).toBe("stopped");
    expect(live[0].status).toBe("connected");
    expect(read.mcpStatusChanged(live, { serverName: "d", status: "pending" }).map(s => s.name)).toEqual(["a", "b", "c", "d"]);
    expect(read.mcpStatusChanged(live, {})).toEqual(live);
  });

  it("reads a server's tools, resources and prompts, and a sign-in's address only when it is https", () => {
    expect(read.mcpItems({ tools: [{ name: "t", description: "d" }] }, "tools")).toEqual([{ name: "t", description: "d" }]);
    expect(read.mcpItems({ resources: [{ uri: "x://y", name: "y", mimeType: "text/plain" }] }, "resources")).toEqual([{ name: "y", detail: "x://y · text/plain" }]);
    expect(read.mcpItems({ prompts: [{ name: "p", arguments: [{ name: "a" }, { name: "b" }] }] }, "prompts")).toEqual([{ name: "p", detail: "a, b" }]);
    expect(read.oauthLogin({ authorizationUrl: "https://idp.example/authorize?x=1" })).toEqual({ url: "https://idp.example/authorize?x=1", connected: false });
    expect(read.oauthLogin({ authorizationUrl: "javascript:alert(1)" })).toEqual({ connected: false });
    expect(read.oauthLogin({ status: "connected" })).toEqual({ connected: true });
  });

  it("reads skills, plugins, marketplaces, agents, instructions and hooks", () => {
    expect(read.skillRows({ skills: [{ name: "z", description: "Z", source: "project", enabled: false, userInvocable: true }, { name: "a", description: "A", source: "builtin", userInvocable: false }] }).map(s => [s.name, s.enabled]))
      .toEqual([["a", true], ["z", false]]);
    expect(read.loadDiagnostics({ warnings: ["w"], errors: [] })).toEqual({ warnings: 1, errors: 0 });
    expect(read.discoveryPaths({ paths: [{ path: "/p", scope: "project", preferredForCreation: true }, { path: "/f", location: "user", kind: "file" }] }))
      .toEqual([{ path: "/p", scope: "project", preferred: true }, { path: "/f", scope: "user", preferred: false, kind: "file" }]);
    const plugins = read.pluginRows({ plugins: [{ name: "p", marketplace: "m", enabled: true }, { name: "d", marketplace: "", directSourceId: "abc", enabled: true, managed: true }] });
    expect(plugins.map(read.pluginSpec)).toEqual(["p@m", "d"]);
    expect(plugins[1]).toMatchObject({ managed: true, directSourceId: "abc" });
    expect(read.marketplaceRemoved({ removed: false, dependentPlugins: ["x"] })).toEqual({ removed: false, dependents: ["x"] });
    expect(read.refreshFailures({ results: [{ name: "a", success: true }, { name: "b", success: false, error: "boom" }] })).toEqual(["b"]);
    expect(read.pluginInstalled({ plugin: { name: "p" }, skillsInstalled: 2, deprecationWarning: "x" })).toEqual({ name: "p", skills: 2, deprecated: true });
    expect(read.pluginUpdated({ previousVersion: "1", newVersion: "2" })).toEqual({ from: "1", to: "2" });
    const agents = read.agentRows({ agents: [{ name: "r", displayName: "Reviewer", description: "d", tools: [] }, { name: "s", userInvocable: false }] });
    expect(agents[0]).toMatchObject({ id: "r", displayName: "Reviewer", tools: [], selectable: true });
    expect(agents[1]).toMatchObject({ selectable: false });
    expect("tools" in agents[1]).toBe(false);
    expect(read.currentAgent({ agent: null })).toBeNull();
    expect(read.currentAgent({ agent: { name: "r" } })).toBe("r");
    expect(read.instructionRows({ sources: [{ id: "i", label: "L", sourcePath: "AGENTS.md", content: "x", type: "repo", location: "repository", applyTo: ["src/**"], defaultDisabled: true }] }))
      .toEqual([{ id: "i", label: "L", path: "AGENTS.md", type: "repo", location: "repository", applyTo: ["src/**"], startsOff: true, content: "x" }]);
    expect(read.hookRows({ hooks: [{ id: "h", hookType: "preToolUse", origin: "repository", enabled: false }], warnings: [], errors: ["e"] }))
      .toEqual({ hooks: [{ id: "h", event: "preToolUse", origin: "repository", enabled: false }], warnings: 0, errors: 1 });
  });

  it("reads permissions, the organisation's settings and the sandbox", () => {
    expect(read.allowedPaths({ primary: "/a", directories: ["/a", "/b"], sessionApprovedPaths: ["/c/f"] })).toEqual({ primary: "/a", directories: ["/b"], approved: ["/c/f"] });
    expect(read.managedSession({ bypassPermissionsDisabled: true, managedKeys: ["model"], deviceManaged: false, serverManaged: true })).toMatchObject({ approveAllOff: true, keys: ["model"], managed: true });
    expect(read.managedSession({})).toMatchObject({ approveAllOff: false, managed: false });
    expect(read.managedDevice({ settingsJson: { a: 1 } })).toEqual({ present: true, unreadable: false });
    expect(read.managedDevice({ errorMessage: "bad" })).toEqual({ present: false, unreadable: true });
    expect(read.hostSupport({ supported: true, capabilities: [{ name: "network", supported: false, reason: "Install x" }] }))
      .toEqual({ supported: true, capabilities: [{ name: "network", supported: false, reason: "Install x" }] });
    expect(read.enforcement({ required: true })).toEqual({ required: true, blocked: false });
  });

  it("reads schedules, usage, quota, the context window and a compaction", () => {
    expect(read.scheduleRows({ entries: [{ id: 3, prompt: "p", displayPrompt: "/p", recurring: true, intervalMs: 60_000, nextRunAt: "2026-11-27T10:00:00Z" }, { prompt: "no id" }] }))
      .toEqual([{ id: 3, prompt: "/p", recurring: true, selfPaced: false, every: 60_000, next: "2026-11-27T10:00:00Z" }]);
    const u = read.usageView({ totalPremiumRequestCost: 2.5, totalUserRequests: 3, totalApiDurationMs: 1000, codeChanges: { linesAdded: 4, linesRemoved: 1, filesModified: ["a", "b"] },
      modelMetrics: { a: { requests: { count: 1, cost: 1 }, usage: { inputTokens: 10, outputTokens: 2 } }, b: { requests: { count: 5, cost: 0 }, usage: {} }, c: "junk" } });
    expect(u).toMatchObject({ premium: 2.5, requests: 3, files: 2, linesAdded: 4 });
    expect(u.models.map(m => m.id)).toEqual(["b", "a"]);
    const q = read.quotaRows({ snapshots: { chat: { isUnlimitedEntitlement: true }, premium_interactions: { entitlementRequests: 300, usedRequests: 87, remainingPercentage: 171, resetDateEpochMs: 5 } }, planTier: "pro" });
    expect(q.plan).toBe("pro");
    expect(q.rows[1]).toMatchObject({ type: "premium_interactions", used: 87, entitled: 300, remaining: 100, resets: 5 });
    expect(read.quotaRows({ quotaSnapshots: { a: { usedRequests: 1 } }, planTier: "unknown" })).toEqual({ rows: [expect.objectContaining({ type: "a", used: 1 })] });
    expect(read.contextView({ contextInfo: null })).toBeNull();
    expect(read.contextView({ contextInfo: { modelName: "m", totalTokens: 10, limit: 100, systemTokens: 1 } })).toMatchObject({ total: 10, limit: 100, system: 1, conversation: 0 });
    expect(read.heaviest({ totalTokens: 200, messages: [{ label: "tool: bash", role: "tool", tokens: 50 }, { label: "no tokens" }] })).toEqual([{ label: "tool: bash", role: "tool", tokens: 50, share: 25 }]);
    expect(read.compacted({ success: true, tokensRemoved: 9, messagesRemoved: 2 })).toEqual({ ok: true, tokens: 9, messages: 2 });
  });
});

describe("Customise's MCP server form", () => {
  const taken = ["issues"];
  it("builds a program's config, one argument a line, with its variables", () => {
    const out = checkMcpForm({ ...EMPTY_MCP_FORM, name: "files", command: "npx", args: "-y\n\n @acme/files \n", env: [{ name: "TOKEN", value: "s3cret" }, { name: "", value: "" }] }, taken);
    expect(out.errors).toEqual({});
    expect(out.config).toEqual({ type: "stdio", command: "npx", args: ["-y", "@acme/files"], env: { TOKEN: "s3cret" } });
    expect(argsFrom("a\r\nb")).toEqual(["a", "b"]);
  });
  it("puts each error beside its field in plain words", () => {
    const out = checkMcpForm({ ...EMPTY_MCP_FORM, name: "issues", command: "", cwd: "relative/dir", env: [{ name: "1BAD", value: "x" }, { name: "OK", value: "" }, { name: "OK", value: "y" }] }, taken);
    expect(out.config).toBeUndefined();
    expect(out.errors).toEqual({
      name: "There's a server with this name already.", command: "Say which program to run.", cwd: "Give a whole path, such as /home/you/project.",
      "env.0.name": "Use letters, digits and “_”, not starting with a digit.", "env.1.value": "Give it a value.", "env.2.name": "This name is here twice.",
    });
    expect(checkMcpForm({ ...EMPTY_MCP_FORM, name: "bad name!", command: "x" }, taken).errors.name).toBe("Use only letters, digits, “-”, “_” and “.”, up to 64 of them.");
    expect(checkMcpForm({ ...EMPTY_MCP_FORM, name: "", command: "x" }, taken).errors.name).toBe("Give the server a name.");
    expect(checkMcpForm({ ...EMPTY_MCP_FORM, name: "a", command: "x\ny" }, taken).errors.command).toBe("Put this on one line.");
  });
  it("takes a remote address only over https, or http on this computer, with header names a server accepts", () => {
    expect(urlError("https://mcp.example.com/x")).toBeNull();
    expect(urlError("http://127.0.0.1:8080/mcp")).toBeNull();
    expect(urlError("http://localhost/mcp")).toBeNull();
    expect(urlError("http://mcp.example.com")).toBe("Use https://, or http:// only for this computer.");
    expect(urlError("ftp://x")).toBe("Give a whole address, starting https://.");
    expect(urlError("mcp.example.com")).toBe("Give a whole address, starting https://.");
    const out = checkMcpForm({ ...EMPTY_MCP_FORM, name: "docs", kind: "sse", url: " https://x.example/sse ", headers: [{ name: "X-Api-Key", value: "k" }, { name: "Bad Header", value: "v" }] }, taken);
    expect(out.errors).toEqual({ "header.1.name": "Use letters, digits and “-”, with no spaces." });
  });
  it("keeps a secret Copilot already holds when an edit leaves its value empty, and never draws one", () => {
    const old = { type: "stdio", command: "npx", args: ["a"], env: { TOKEN: "held-secret", OTHER: "x" }, timeout: 30_000, tools: ["t"] };
    const form = formFromConfig("issues", old);
    expect(form.env).toEqual([{ name: "OTHER", value: "" }, { name: "TOKEN", value: "" }]);
    expect(JSON.stringify(form)).not.toContain("held-secret");
    const edited = checkMcpForm({ ...form, env: [{ name: "TOKEN", value: "" }, { name: "NEW", value: "n" }] }, taken, "issues", { env: old.env });
    expect(edited.config).toEqual({ type: "stdio", command: "npx", args: ["a"], env: { TOKEN: "held-secret", NEW: "n" } });
    // A value typed replaces the one held; a variable taken out of the form goes.
    expect(checkMcpForm({ ...form, env: [{ name: "TOKEN", value: "new" }] }, taken, "issues", { env: old.env }).config?.env).toEqual({ TOKEN: "new" });
    // What the form doesn't show stays as it was.
    expect(mergedConfig(old, edited.config!)).toEqual({ timeout: 30_000, tools: ["t"], type: "stdio", command: "npx", args: ["a"], env: { TOKEN: "held-secret", NEW: "n" } });
    expect(formFromConfig("docs", { url: "https://x", headers: { A: "b" } })).toMatchObject({ kind: "http", headers: [{ name: "A", value: "" }] });
  });
});

describe("Customise's rules and sources", () => {
  it("reads a rule in the SDK's syntax and writes it back the same way", () => {
    expect(parseRule("Shell(npm test)")).toEqual({ rule: { kind: "Shell", argument: "npm test" } });
    expect(parseRule(" write ")).toEqual({ rule: { kind: "write", argument: null } });
    expect(parseRule("github-mcp(create_issue)")).toEqual({ rule: { kind: "github-mcp", argument: "create_issue" } });
    expect(parseRule("")).toEqual({ error: "Write a rule first." });
    for (const bad of ["Shell()", "Shell(npm test", "(x)", "1abc", "Shell(a)\nwrite", "two words"]) expect("error" in parseRule(bad), bad).toBe(true);
    expect(ruleText({ kind: "Shell", argument: "git status" })).toBe("Shell(git status)");
    expect(ruleText({ kind: "read", argument: null })).toBe("read");
    const one = { kind: "write", argument: null };
    expect(withRule(withRule([], one), one)).toEqual([one]);
    expect(withoutRule([one, { kind: "Shell", argument: "x" }], one)).toEqual([{ kind: "Shell", argument: "x" }]);
  });
  it("takes plugin and marketplace sources in the forms the SDK accepts", () => {
    for (const ok of ["deploy@acme-tools", "acme/tools", "acme/tools:plugins/x", "https://github.com/acme/tools.git", "/home/me/plugin"]) expect(pluginSourceError(ok), ok).toBeNull();
    for (const bad of ["", "just words here", "@x", "acme"]) expect(pluginSourceError(bad), bad).toBe("Give it as name@marketplace, owner/repo or an address.");
    for (const ok of ["acme/tools", "acme/tools#main", "git@github.com:acme/tools.git", "ssh://git@host/x", "C:\\market"]) expect(marketplaceSourceError(ok), ok).toBeNull();
    expect(marketplaceSourceError("tools")).toBe("Give it as owner/repo, or a whole git address.");
  });
  it("takes a whole path on any system for a folder", () => {
    for (const p of ["/home/me/x", "~/x", "C:\\Users\\me", "D:/x", "\\\\server\\share"]) expect(isWholePath(p), p).toBe(true);
    expect(folderError("relative")).toBe("Give a whole path, such as /home/you/project.");
    expect(folderError("/a\nb")).toBe("Give a whole path, such as /home/you/project.");
  });
});
