/**
 * The person's defaults for new coding sessions, a project's own settings (instructions for Copilot, extra folders)
 * and a session's kept options (app/main/code/hub.ts, session-index.ts, session-runtime.ts `setupConfig`), over a fake
 * SDK client: a start that names nothing takes the defaults (the project's over everyone's), the organisation's policy
 * still wins, the instructions and folders reach the session's config on create and on every resume, an extra folder
 * comes only from main's picker and never is Ember's data, the options change through `options.update` and are kept,
 * the companion can't change any of it, and each change is audited without its words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import { CodeHub, type CodeHubDeps } from "../../app/main/code/hub";
import { CODE_REFUSALS } from "../../app/main/code/guards";
import { CODE_ARGS } from "../../app/main/code/ipc";
import { SessionIndex, indexFile } from "../../app/main/code/session-index";
import { setupConfig } from "../../app/main/code/session-runtime";
import type { ChatPolicy } from "../../app/main/agent/chat-policy";
import type { AuditEntry } from "../../app/main/policy/audit";

const OPEN: ChatPolicy = { managedSettings: {}, permissionModes: ["manual", "assisted", "allow-all"], standing: true };

function fakeClient() {
  const configs: SessionConfig[] = [];
  const updates: unknown[] = [];
  const modes: string[] = [];
  let mode = "manual", agent = "interactive";
  const rpc = {
    options: { update: async (p: unknown) => { updates.push(p); return { success: true }; } },
    sandbox: { getEnforcementStatus: async () => ({ blocked: false }) },
    permissions: {
      setMode: async (p: { mode: string }) => { mode = p.mode; modes.push(p.mode); return { success: true, mode }; }, getMode: async () => ({ mode }),
      locations: { resolve: async () => ({ locationKey: "k" }) }, pendingRequests: async () => ({ items: [] }), folderTrust: { isTrusted: async () => ({ trusted: false }) },
    },
    mode: { get: async () => agent, set: async (p: { mode: string }) => { agent = p.mode; return {}; } },
    name: { get: async () => ({ name: "" }) },
    model: { getCurrent: async () => ({ modelId: "m" }) },
    cancelAllBackgroundAgents: async () => ({}),
  };
  const session = (id: string) => ({ sessionId: id, rpc, send: async () => "msg", abort: async () => undefined, disconnect: async () => undefined });
  const client = {
    rpc: { sandbox: { getHostSupport: async () => ({ supported: false, capabilities: [] }) }, sessions: { readPersistedEvents: async () => ({ events: [], hasMore: false }) } },
    createSession: async (c: SessionConfig) => { configs.push(c); mode = "manual"; agent = "interactive"; return session(c.sessionId!); },
    resumeSession: async (id: string, c: SessionConfig) => { configs.push(c); return session(id); },
    listSessions: async () => [], getSessionMetadata: async () => undefined, deleteSession: async () => undefined,
  } as unknown as CopilotClient;
  return { client, configs, updates, modes };
}

let dir = "", userData = "", work = "", extra = "";
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-settings-")));
  userData = path.join(dir, "userdata");
  work = path.join(dir, "work");
  extra = path.join(dir, "extra");
  for (const d of [userData, work, extra]) fs.mkdirSync(d);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function harness(over: Partial<CodeHubDeps> = {}) {
  const fake = fakeClient();
  const audit: AuditEntry[] = [];
  let picked = work;
  const deps: CodeHubDeps = {
    hasConsent: () => true, enabled: () => true, policy: () => OPEN, vaultFilled: () => false,
    access: () => ({ provider: { type: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test" }, model: "mock-model", service: "user" }),
    client: async () => fake.client, userData, runtimeHome: () => path.join(dir, "userdata-code"), protectedPaths: () => [userData], place: () => ({ os: "linux", home: dir }),
    audit: () => ({ write: e => audit.push(e) }), emit: () => undefined, pickFolder: async () => picked, pickFiles: async () => [],
    git: async args => { if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${work}\n`; if (args[1] === "--abbrev-ref") return "main\n"; throw new Error("no"); },
    index: new SessionIndex(indexFile(path.join(userData, "code"))).load(),
    ...over,
  };
  const hub = new CodeHub(deps);
  return { hub, fake, audit, deps, pick: (p: string) => { picked = p; } };
}
async function project(h: ReturnType<typeof harness>): Promise<string> {
  const r = await h.hub.dispatch({ type: "addProject" }, "user");
  if (!r.ok) throw new Error(r.reason);
  return r.value.id;
}

describe("the person's defaults for a new coding session", () => {
  it("starts a session the start flow names nothing for with the defaults, a project's over everyone's (the user's defaults)", async () => {
    const h = harness();
    const p = await project(h);
    expect((await h.hub.dispatch({ type: "setSettings", change: { defaults: { permissionMode: "assisted", agentMode: "plan", model: "gpt-5.5", reasoningEffort: "high" } } }, "user")).ok).toBe(true);
    expect((await h.hub.dispatch({ type: "setSettings", change: { projectId: p, defaults: { model: "claude-sonnet-5" } } }, "user")).ok).toBe(true);
    expect(h.hub.userDefaults(p)).toEqual({ permissionMode: "assisted", agentMode: "plan", model: "claude-sonnet-5", reasoningEffort: "high" });
    const r = await h.hub.dispatch({ type: "create", options: { projectId: p } }, "user");
    expect(r.ok && [r.value.permissionMode, r.value.agentMode]).toEqual(["assisted", "plan"]);
    // Field by field: the project's model, everyone's effort.
    expect(h.fake.configs[0].model).toBe("claude-sonnet-5");
    expect(h.fake.configs[0].reasoningEffort).toBe("high");
    // What the start names wins.
    const named = await h.hub.dispatch({ type: "create", options: { projectId: p, permissionMode: "manual", agentMode: "interactive", model: "x", reasoningEffort: "low" } }, "user");
    expect(named.ok && [named.value.permissionMode, named.value.agentMode]).toEqual(["manual", "interactive"]);
    expect(h.fake.configs[1]).toMatchObject({ model: "x", reasoningEffort: "low" });
  });

  it("drops a default mode the organisation forbids, and refuses to save one", async () => {
    let policy = OPEN;
    const h = harness({ policy: () => policy });
    const p = await project(h);
    await h.hub.dispatch({ type: "setSettings", change: { defaults: { permissionMode: "allow-all" } } }, "user");
    policy = { ...OPEN, permissionModes: ["manual"] };
    expect(h.hub.userDefaults(p).permissionMode).toBeUndefined();
    const r = await h.hub.dispatch({ type: "create", options: { projectId: p } }, "user");
    expect(r.ok && r.value.permissionMode).toBe("manual");
    expect(await h.hub.dispatch({ type: "setSettings", change: { defaults: { permissionMode: "assisted" } } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.modeRefused });
  });

  it("gives the companion's session the person's defaults, and refuses the companion every settings command", async () => {
    const h = harness();
    const p = await project(h);
    await h.hub.dispatch({ type: "setSettings", change: { defaults: { agentMode: "plan" } } }, "user");
    const r = await h.hub.dispatch({ type: "create", options: { projectId: p } }, "companion");
    expect(r.ok && r.value.agentMode).toBe("plan");
    for (const c of [{ type: "settings" }, { type: "setSettings", change: { defaults: {} } }, { type: "projectFolders", projectId: p, change: { add: true } }, { type: "configure", sessionId: "x", options: {} }] as const) {
      expect((await h.hub.dispatch(c, "companion")).ok, c.type).toBe(false);
    }
  });

  it("reads the defaults before the runtime is reachable, but not before consent", async () => {
    let consent = false;
    const h = harness({ hasConsent: () => consent });
    expect(await h.hub.dispatch({ type: "settings" }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.consent });
    consent = true;
    expect(await h.hub.dispatch({ type: "settings" }, "user")).toEqual({ ok: true, value: { defaults: {}, effective: {}, permissionModes: ["manual", "assisted", "allow-all"] } });
  });
});

describe("a project's instructions and extra folders", () => {
  it("appends the instructions to the system message and passes the folders, on create and on every resume", async () => {
    const h = harness();
    const p = await project(h);
    await h.hub.dispatch({ type: "setSettings", change: { projectId: p, instructions: "Use British spelling in comments." } }, "user");
    h.pick(extra);
    expect(await h.hub.dispatch({ type: "projectFolders", projectId: p, change: { add: true } }, "user")).toEqual({ ok: true, value: [extra] });
    const r = await h.hub.dispatch({ type: "create", options: { projectId: p } }, "user");
    if (!r.ok) throw new Error(r.reason);
    expect(h.fake.configs[0]).toMatchObject({ systemMessage: { mode: "append", content: "Use British spelling in comments." }, additionalDirectories: [extra] });
    await h.hub.dispose();
    await h.hub.dispatch({ type: "attach", sessionId: r.value.id }, "user");
    expect(h.fake.configs[1]).toMatchObject({ systemMessage: { mode: "append", content: "Use British spelling in comments." }, additionalDirectories: [extra] });
    // Audited by size, never the words.
    expect(JSON.stringify(h.audit)).not.toContain("British");
    expect(h.audit).toContainEqual(expect.objectContaining({ phase: "settings", scope: "project", instructionsChars: 33 }));
  });

  it("never adds Ember's own data as a folder, and removes only a folder on the list", async () => {
    const h = harness();
    const p = await project(h);
    h.pick(userData);
    expect(await h.hub.dispatch({ type: "projectFolders", projectId: p, change: { add: true } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.emberData });
    expect(await h.hub.dispatch({ type: "projectFolders", projectId: p, change: { remove: "/etc" } }, "user")).toEqual({ ok: false, reason: CODE_REFUSALS.folderPath });
    h.pick(extra);
    await h.hub.dispatch({ type: "projectFolders", projectId: p, change: { add: true } }, "user");
    expect(await h.hub.dispatch({ type: "projectFolders", projectId: p, change: { remove: extra } }, "user")).toEqual({ ok: true, value: [] });
  });

  it("leaves out a folder that has gone since it was added", async () => {
    const h = harness();
    const p = await project(h);
    h.pick(extra);
    await h.hub.dispatch({ type: "projectFolders", projectId: p, change: { add: true } }, "user");
    fs.rmSync(extra, { recursive: true });
    await h.hub.dispatch({ type: "create", options: { projectId: p } }, "user");
    expect(h.fake.configs[0].additionalDirectories).toBeUndefined();
  });
});

describe("a session's options", () => {
  it("change now through options.update, are kept, and are given again when the session opens", async () => {
    const h = harness();
    const p = await project(h);
    const r = await h.hub.dispatch({ type: "create", options: { projectId: p } }, "user");
    if (!r.ok) throw new Error(r.reason);
    const set = await h.hub.dispatch({ type: "configure", sessionId: r.value.id, options: { reasoningSummary: "detailed", contextTier: "long_context", excludedTools: ["web_fetch"], coauthor: false } }, "user");
    expect(set).toEqual({ ok: true, value: { reasoningSummary: "detailed", contextTier: "long_context", excludedTools: ["web_fetch"], coauthor: false } });
    expect(h.fake.updates.at(-1)).toEqual({ reasoningSummary: "detailed", contextTier: "long_context", excludedTools: ["web_fetch"], coauthorEnabled: false });
    expect(await h.hub.dispatch({ type: "sessionOptions", sessionId: r.value.id }, "user")).toEqual(set);
    await h.hub.dispose();
    await h.hub.dispatch({ type: "attach", sessionId: r.value.id }, "user");
    expect(h.fake.configs.at(-1)).toMatchObject({ reasoningSummary: "detailed", contextTier: "long_context", excludedTools: ["web_fetch"], coauthorEnabled: false });
    expect(h.audit).toContainEqual(expect.objectContaining({ phase: "configure", by: "user", keys: ["coauthor", "contextTier", "excludedTools", "reasoningSummary"] }));
  });

  it("takes only the keys it knows from the window: never a sandbox, a mode or a tool allow-list", () => {
    const parse = (o: unknown) => CODE_ARGS.configure.args.safeParse(["s1", o]).success;
    expect(parse({ reasoningSummary: "concise" })).toBe(true);
    expect(parse({ sandboxConfig: { enabled: false } })).toBe(false);
    expect(parse({ availableTools: ["bash"] })).toBe(false);
    expect(parse({ excludedTools: ["rm -rf /"] })).toBe(false);
    expect(CODE_ARGS.setSettings.args.safeParse([{ defaults: { permissionMode: "yolo" } }]).success).toBe(false);
    expect(CODE_ARGS.projectFolders.args.safeParse(["p", { add: "/etc" }]).success).toBe(false);
  });

  it("maps the setup to the SDK's config keys and leaves out what isn't set", () => {
    expect(setupConfig(undefined)).toEqual({});
    expect(setupConfig({ instructions: "  ", folders: [], options: {} })).toEqual({});
    expect(setupConfig({ options: { coauthor: true } })).toEqual({ coauthorEnabled: true });
  });
});
