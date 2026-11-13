/**
 * The one place text leaves main for a model, with the vault's values taken out (owner decision of 2026-11-12,
 * PLAN.md §2 "Approvals", "The vault": nothing Ember reads after a fill holds the value). AgentHost wraps the runtime
 * client it starts in this, so every session made from it (the conductor's, each worker's, the one-shot reviewers',
 * memory's) is covered without any of them asking: the system message, every prompt sent, every tool's result (a
 * tree read, a read result, a command's output, a task's result to the conductor), a tool's error and whatever a hook
 * hands back. Pictures are left as they are (their pixels are masked where they are taken: Perception).
 *
 * Until something has been filled in this run the redactor is idle and everything passes untouched. Plain Node.
 */

/** What this needs of the vault's redactor (app/main/vault/redact.ts). */
export interface ModelRedactor {
  readonly active: boolean;
  holds(text: unknown): boolean;
  text(text: string): string;
  deep<T>(value: T, skip?: (key: string, parent: object) => boolean): T;
}

/** A picture's or a blob's base64 data: pixels and bytes, not text (a short value would otherwise be "found" in it by chance). */
const isBytes = (key: string, parent: object): boolean => key === "data" && typeof (parent as { mimeType?: unknown }).mimeType === "string";

type Fn = (...args: unknown[]) => unknown;

/** `fn` with what it answers (or resolves to) redacted, and an error's words too. */
function answering(fn: Fn, self: unknown, r: ModelRedactor): Fn {
  const clean = (v: unknown) => (r.active ? r.deep(v, isBytes) : v);
  const failed = (err: unknown): never => {
    const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    if (r.active && msg && r.holds(msg)) throw new Error(r.text(msg));
    throw err;
  };
  return (...args: unknown[]) => {
    let out: unknown;
    try { out = fn.apply(self, args); } catch (err) { return failed(err); }
    if (out && typeof (out as { then?: unknown }).then === "function") return (out as Promise<unknown>).then(clean, failed);
    return clean(out);
  };
}

/** A session's config as the runtime is given it: every tool's handler and every hook answers through the redactor. */
function redactedConfig<T>(config: T, r: ModelRedactor): T {
  if (!config || typeof config !== "object") return config;
  const c = config as { tools?: unknown; hooks?: unknown; systemMessage?: unknown; onPermissionRequest?: unknown };
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  if (Array.isArray(c.tools)) {
    out.tools = c.tools.map((t: unknown) => {
      const tool = t as { handler?: unknown };
      return tool && typeof tool.handler === "function" ? { ...tool, handler: answering(tool.handler as Fn, tool, r) } : t;
    });
  }
  if (c.hooks && typeof c.hooks === "object") {
    out.hooks = Object.fromEntries(Object.entries(c.hooks).map(([k, v]) => [k, typeof v === "function" ? answering(v as Fn, c.hooks, r) : v]));
  }
  if (typeof c.onPermissionRequest === "function") out.onPermissionRequest = answering(c.onPermissionRequest as Fn, config, r);
  if (c.systemMessage !== undefined && r.active) out.systemMessage = r.deep(c.systemMessage);
  return out as T;
}

/** A session whose prompts go out through the redactor; everything else is the session's own. */
function redactedSession<S>(session: S, r: ModelRedactor): S {
  if (!session || typeof session !== "object") return session;
  return new Proxy(session as object, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "send" || prop === "sendAndWait") {
        return (options: unknown, ...rest: unknown[]) => (v as Fn).call(target, r.active ? r.deep(options, isBytes) : options, ...rest);
      }
      return (v as Fn).bind(target);
    },
  }) as S;
}

/**
 * `client` with every session it creates or resumes behind the redactor. Its other calls (start, stop, the models
 * list, deleting a session) are the client's own.
 */
export function redactingClient<C extends object>(client: C, r: ModelRedactor): C {
  return new Proxy(client, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      if (prop === "createSession") {
        return (config: unknown, ...rest: unknown[]) => Promise.resolve((v as Fn).call(target, redactedConfig(config, r), ...rest)).then(s => redactedSession(s, r));
      }
      if (prop === "resumeSession") {
        return (id: unknown, config: unknown, ...rest: unknown[]) => Promise.resolve((v as Fn).call(target, id, redactedConfig(config, r), ...rest)).then(s => redactedSession(s, r));
      }
      return (v as Fn).bind(target);
    },
  });
}
